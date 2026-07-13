import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { VoiceError } from '../errors.js';
import type { VoiceProviderEventRepository, VoiceQueueClaimInput } from '../ports.js';
import type { VoiceListInput, VoicePage, VoiceProviderEvent } from '../types.js';
import {
  boundedLimit,
  cursorTuple,
  jsonRecord,
  nullableTimestamp,
  numberValue,
  pageFromRows,
  requiredRow,
  timestamp,
  type VoicePgRow
} from './row-utils.js';

export class PostgresVoiceProviderEventStore implements VoiceProviderEventRepository {
  constructor(private readonly pg: PgQueryable) {}

  insert(event: VoiceProviderEvent): Promise<{ event: VoiceProviderEvent; replayed: boolean }> {
    return withPgTenant(this.pg, event.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_provider_events
          (id, tenant_id, profile_id, call_id, external_event_id, canonical_hash,
           event_type, provider_state, safe_payload, processing_state, attempt_count,
           next_attempt_at, lease_until, worker_id, error_code, occurred_at,
           received_at, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          event.id, event.tenant_id, event.profile_id, event.call_id,
          event.external_event_id, event.canonical_hash, event.event_type,
          event.provider_state, JSON.stringify(event.safe_payload), event.processing_state,
          event.attempt_count, event.next_attempt_at, event.lease_until, event.worker_id,
          event.error_code, event.occurred_at, event.received_at, event.processed_at
        ]
      );
      if (result.rows[0]) return { event: decodeEvent(result.rows[0]), replayed: false };

      const replay = await pg.query<VoicePgRow>(
        `SELECT event.* FROM ivekit_voice_provider_events event
         WHERE event.tenant_id = $1 AND event.profile_id = $2
           AND (event.canonical_hash = $3
             OR ($4::text <> '' AND event.external_event_id = $4))
         ORDER BY event.received_at DESC, event.id DESC LIMIT 1`,
        [event.tenant_id, event.profile_id, event.canonical_hash, event.external_event_id]
      );
      const found = requiredRow(replay.rows[0], 'idempotency_conflict');
      if (String(found.canonical_hash) !== event.canonical_hash) {
        throw new VoiceError({ code: 'idempotency_conflict', status: 409 });
      }
      return { event: decodeEvent(found), replayed: true };
    });
  }

  claimDue(input: VoiceQueueClaimInput): Promise<VoiceProviderEvent[]> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = boundedLimit(input.limit);
      const now = input.now.toISOString();
      const leaseUntil = new Date(input.now.getTime() + boundedLease(input.lease_ms)).toISOString();
      const result = await pg.query<VoicePgRow>(
        `WITH candidate AS (
           SELECT event.id
           FROM ivekit_voice_provider_events event
           WHERE event.tenant_id = $1 AND (
             event.processing_state = 'pending'
             OR (event.processing_state = 'retry_wait'
               AND (event.next_attempt_at IS NULL OR event.next_attempt_at <= $2))
             OR (event.processing_state = 'processing' AND event.lease_until <= $2)
           )
           ORDER BY COALESCE(event.next_attempt_at, event.received_at), event.id
           FOR UPDATE SKIP LOCKED
           LIMIT $5
         )
         UPDATE ivekit_voice_provider_events event
         SET processing_state = 'processing', worker_id = $3, lease_until = $4,
             attempt_count = attempt_count + 1
         FROM candidate
         WHERE event.tenant_id = $1 AND event.id = candidate.id
         RETURNING event.*`,
        [input.tenant_id, now, input.worker_id, leaseUntil, limit]
      );
      return result.rows.map(decodeEvent);
    });
  }

  complete(input: { tenant_id: string; event_id: string; worker_id: string }): Promise<VoiceProviderEvent> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_provider_events
         SET processing_state = 'processed', processed_at = CURRENT_TIMESTAMP,
             worker_id = '', lease_until = NULL, next_attempt_at = NULL, error_code = ''
         WHERE tenant_id = $1 AND id = $2 AND worker_id = $3
         RETURNING *`,
        [input.tenant_id, input.event_id, input.worker_id]
      );
      if (!result.rows[0]) throw new VoiceError({ code: 'lease_lost', status: 409 });
      return decodeEvent(result.rows[0]);
    });
  }

  release(input: {
    tenant_id: string;
    event_id: string;
    worker_id: string;
    state: 'retry_wait' | 'failed';
    next_attempt_at?: Date | null;
    error_code: string;
  }): Promise<VoiceProviderEvent> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_provider_events
         SET processing_state = $4, next_attempt_at = $5, error_code = $6,
             worker_id = '', lease_until = NULL,
             processed_at = CASE WHEN $4 = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE tenant_id = $1 AND id = $2 AND worker_id = $3
         RETURNING *`,
        [
          input.tenant_id, input.event_id, input.worker_id, input.state,
          input.next_attempt_at?.toISOString() ?? null, input.error_code
        ]
      );
      if (!result.rows[0]) throw new VoiceError({ code: 'lease_lost', status: 409 });
      return decodeEvent(result.rows[0]);
    });
  }

  listForCall(input: VoiceListInput & { call_id: string }): Promise<VoicePage<VoiceProviderEvent>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = boundedLimit(input.limit);
      const [cursorAt, cursorId] = cursorTuple(input.cursor);
      const result = await pg.query<VoicePgRow>(
        `SELECT event.* FROM ivekit_voice_provider_events event
         WHERE event.tenant_id = $1 AND event.call_id = $2
           AND (event.received_at, event.id) < ($3::timestamptz, $4)
         ORDER BY event.received_at DESC, event.id DESC LIMIT $5`,
        [input.tenant_id, input.call_id, cursorAt, cursorId, limit + 1]
      );
      const events = result.rows.map(decodeEvent).map((event) => ({
        ...event,
        created_at: event.received_at
      }));
      const page = pageFromRows(events, limit);
      return {
        items: page.items.map(({ created_at: _createdAt, ...event }) => event),
        next_cursor: page.next_cursor
      };
    });
  }
}

function decodeEvent(row: VoicePgRow): VoiceProviderEvent {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), profile_id: String(row.profile_id),
    call_id: row.call_id == null ? null : String(row.call_id), external_event_id: String(row.external_event_id ?? ''),
    canonical_hash: String(row.canonical_hash), event_type: String(row.event_type), provider_state: String(row.provider_state ?? ''),
    safe_payload: jsonRecord(row.safe_payload), processing_state: row.processing_state as VoiceProviderEvent['processing_state'],
    attempt_count: numberValue(row.attempt_count), next_attempt_at: nullableTimestamp(row.next_attempt_at),
    lease_until: nullableTimestamp(row.lease_until), worker_id: String(row.worker_id ?? ''), error_code: String(row.error_code ?? ''),
    occurred_at: nullableTimestamp(row.occurred_at), received_at: timestamp(row.received_at), processed_at: nullableTimestamp(row.processed_at)
  };
}

function boundedLease(value: number): number {
  return Number.isInteger(value) ? Math.min(15 * 60_000, Math.max(1_000, value)) : 30_000;
}
