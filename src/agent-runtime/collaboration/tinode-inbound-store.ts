import { createHash, randomBytes } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { pgId } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import type {
  TinodeInboundNormalizedEvent,
  TinodeInboundRejectedEvent
} from './tinode-inbound-protocol.js';

export interface TinodeInboundCursorSnapshot {
  id: string;
  last_data_seq: number;
  last_del_id: number;
}

export interface TinodeInboundClaim {
  tenant_id: string;
  session_id: string;
  binding_id: string;
  provider_topic_id: string;
  claim_token: string;
  lease_until: string;
  cursor: TinodeInboundCursorSnapshot;
}

export interface TinodeInboundProjectionResult {
  status: 'projected' | 'ignored';
  message_id?: string;
  provider_mutation?: TinodeInboundProviderMutationProjection;
}

export interface TinodeInboundProviderMutationProjection {
  mutation_id: string;
  mutation_version: number;
  action: 'edit' | 'delete';
  message_id: string;
  status: 'delivered';
  previous_status: 'pending' | 'processing' | 'retry_wait' | 'delivered' | 'dead_letter';
}

export interface TinodeInboundProcessResult {
  event_id: string;
  status: 'projected' | 'ignored' | 'dead_letter';
  message_id: string;
  replayed: boolean;
  provider_mutation?: TinodeInboundProviderMutationProjection;
}

export interface TinodeInboundRetryResult {
  event: TinodeInboundNormalizedEvent;
  result: TinodeInboundProcessResult;
}

export class TinodeInboundProjectionError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

export class TinodeInboundStore {
  private readonly now: () => Date;
  private readonly deadLetterRetryDelayMs: number;

  constructor(private readonly input: {
    pg: PgQueryable;
    now?: () => Date;
    deadLetterRetryDelayMs?: number;
  }) {
    this.now = input.now || (() => new Date());
    this.deadLetterRetryDelayMs = boundedRetryDelay(input.deadLetterRetryDelayMs ?? 30_000);
  }

  async discoverTenantIds(input: { limit: number }): Promise<string[]> {
    const limit = boundedLimit(input.limit, 1000);
    const result = await this.input.pg.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM opc_tinode_inbound_tenant_ids($1, $2)',
      [this.now().toISOString(), limit]
    );
    return result.rows.map((row) => String(row.tenant_id)).filter(Boolean);
  }

  async pauseBinding(input: { tenant_id: string; binding_id: string }): Promise<void> {
    await withPgTenant(this.input.pg, input.tenant_id, (pg) => pg.query(
      `INSERT INTO tinode_inbound_cursors
         (id, tenant_id, binding_id, provider_topic_id, status)
       SELECT $2, binding.tenant_id, binding.id, binding.provider_topic_id, 'paused'
       FROM collaboration_chat_bindings AS binding
       WHERE binding.tenant_id = $1
         AND binding.id = $3
         AND binding.provider = 'tinode'
       ON CONFLICT (tenant_id, binding_id) DO UPDATE
       SET status = 'paused',
           lease_token_hash = '',
           lease_until = NULL,
           next_retry_at = NULL,
           last_error_code = '',
           last_error_message = '',
           updated_at = CURRENT_TIMESTAMP`,
      [input.tenant_id, pgId('ticursor'), input.binding_id]
    ).then(() => undefined));
  }

  async claimNext(input: { tenant_id: string; lease_ms: number }): Promise<TinodeInboundClaim | null> {
    const leaseMs = boundedLease(input.lease_ms);
    const claimToken = randomBytes(32).toString('base64url');
    const claimHash = sha256(claimToken);
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      await pg.query(
        `INSERT INTO tinode_inbound_cursors
          (id, tenant_id, binding_id, provider_topic_id)
         SELECT $2 || '_' || binding.id, binding.tenant_id, binding.id, binding.provider_topic_id
         FROM collaboration_chat_bindings AS binding
         JOIN collaboration_sessions AS session
           ON session.tenant_id = binding.tenant_id
          AND session.id = binding.session_id
          AND session.status = 'open'
         WHERE binding.tenant_id = $1
           AND binding.provider = 'tinode'
           AND binding.provider_status = 'bound'
         ON CONFLICT (tenant_id, binding_id) DO NOTHING`,
        [input.tenant_id, pgId('ticursor')]
      );
      const result = await pg.query(
        `WITH candidate AS (
           SELECT cursor.id
           FROM tinode_inbound_cursors AS cursor
           JOIN collaboration_chat_bindings AS binding
             ON binding.id = cursor.binding_id
            AND binding.tenant_id = cursor.tenant_id
           JOIN collaboration_sessions AS session
             ON session.tenant_id = binding.tenant_id
            AND session.id = binding.session_id
            AND session.status = 'open'
           WHERE cursor.tenant_id = $1
             AND binding.provider = 'tinode'
             AND binding.provider_status = 'bound'
             AND cursor.status IN ('active', 'error')
             AND (cursor.next_retry_at IS NULL OR cursor.next_retry_at <= $2)
             AND (cursor.lease_until IS NULL OR cursor.lease_until <= $2)
           ORDER BY cursor.updated_at ASC, cursor.id ASC
           FOR UPDATE OF cursor SKIP LOCKED
           LIMIT 1
         )
         UPDATE tinode_inbound_cursors AS cursor
         SET lease_token_hash = $3,
             lease_until = $4,
             updated_at = $2
         FROM candidate, collaboration_chat_bindings AS binding
         WHERE cursor.id = candidate.id
           AND binding.id = cursor.binding_id
           AND binding.tenant_id = cursor.tenant_id
         RETURNING cursor.*, binding.session_id`,
        [input.tenant_id, now.toISOString(), claimHash, leaseUntil]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        tenant_id: String(row.tenant_id),
        session_id: String(row.session_id),
        binding_id: String(row.binding_id),
        provider_topic_id: String(row.provider_topic_id),
        claim_token: claimToken,
        lease_until: leaseUntil,
        cursor: {
          id: String(row.id),
          last_data_seq: Number(row.last_data_seq || 0),
          last_del_id: Number(row.last_del_id || 0)
        }
      };
    });
  }

  async processEvent(
    claim: TinodeInboundClaim,
    event: TinodeInboundNormalizedEvent,
    project: (pg: PgQueryable, eventId: string) => Promise<TinodeInboundProjectionResult>
  ): Promise<TinodeInboundProcessResult> {
    return withPgTenant(this.input.pg, claim.tenant_id, async (pg) => {
      await this.assertClaim(pg, claim);
      const inserted = await pg.query(
        `INSERT INTO tinode_inbound_events
          (id, tenant_id, binding_id, provider_topic_id, event_kind,
           provider_sequence, provider_delete_id, dedupe_key, payload_hash, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, binding_id, dedupe_key) DO NOTHING
         RETURNING *`,
        [
          pgId('tievent'),
          claim.tenant_id,
          claim.binding_id,
          claim.provider_topic_id,
          event.kind,
          event.provider_sequence,
          event.provider_delete_id,
          event.dedupe_key,
          event.payload_hash,
          JSON.stringify(event.payload)
        ]
      );
      const row = inserted.rows[0] || (await pg.query(
        `SELECT * FROM tinode_inbound_events
         WHERE tenant_id = $1 AND binding_id = $2 AND dedupe_key = $3
         FOR UPDATE`,
        [claim.tenant_id, claim.binding_id, event.dedupe_key]
      )).rows[0];
      if (!row) throw new Error('Tinode inbound event was not persisted');
      if (String(row.payload_hash) !== event.payload_hash) {
        throw new Error(`Tinode inbound payload drift for ${event.dedupe_key}`);
      }
      const currentStatus = String(row.status);
      if (['projected', 'ignored', 'dead_letter'].includes(currentStatus)) {
        await advanceCursor(pg, claim, event);
        return {
          event_id: String(row.id),
          status: currentStatus as TinodeInboundProcessResult['status'],
          message_id: String(row.message_id || ''),
          replayed: true
        };
      }
      if (currentStatus === 'processing') {
        throw new Error(`Tinode inbound event is already processing: ${event.dedupe_key}`);
      }
      await pg.query(
        `UPDATE tinode_inbound_events
         SET status = 'processing', attempt_count = attempt_count + 1,
             claim_token_hash = $4, lease_until = $5,
             error_code = '', error_message = ''
         WHERE id = $1 AND tenant_id = $2 AND binding_id = $3`,
        [String(row.id), claim.tenant_id, claim.binding_id, sha256(claim.claim_token), claim.lease_until]
      );

      try {
        const projection = await project(pg, String(row.id));
        const completedAt = this.now().toISOString();
        await pg.query(
          `UPDATE tinode_inbound_events
           SET status = $4, message_id = NULLIF($5, ''), processed_at = $6,
               claim_token_hash = '', lease_until = NULL
           WHERE id = $1 AND tenant_id = $2 AND binding_id = $3`,
          [String(row.id), claim.tenant_id, claim.binding_id, projection.status, projection.message_id || '', completedAt]
        );
        await advanceCursor(pg, claim, event);
        return {
          event_id: String(row.id),
          status: projection.status,
          message_id: projection.message_id || '',
          replayed: false,
          ...(projection.provider_mutation
            ? { provider_mutation: projection.provider_mutation }
            : {})
        };
      } catch (error) {
        if (!(error instanceof TinodeInboundProjectionError)) throw error;
        const now = this.now();
        const errorCode = safeErrorCode(error.code);
        const errorMessage = safeErrorMessage(error.message);
        await pg.query(
          `UPDATE tinode_inbound_events
           SET status = 'dead_letter', error_code = $4, error_message = $5,
               processed_at = $6, claim_token_hash = '', lease_until = NULL
           WHERE id = $1 AND tenant_id = $2 AND binding_id = $3`,
          [String(row.id), claim.tenant_id, claim.binding_id, errorCode, errorMessage, now.toISOString()]
        );
        await pg.query(
          `INSERT INTO tinode_inbound_dead_letters
            (id, tenant_id, binding_id, event_id, error_code, error_message,
             payload_hash, retryable, next_retry_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id, event_id)
           DO UPDATE SET error_code = EXCLUDED.error_code,
                         error_message = EXCLUDED.error_message,
                         retryable = EXCLUDED.retryable,
                         next_retry_at = EXCLUDED.next_retry_at,
                         updated_at = CURRENT_TIMESTAMP`,
          [
            pgId('tidead'),
            claim.tenant_id,
            claim.binding_id,
            String(row.id),
            errorCode,
            errorMessage,
            event.payload_hash,
            error.retryable ? 1 : 0,
            error.retryable ? new Date(now.getTime() + this.deadLetterRetryDelayMs).toISOString() : null
          ]
        );
        await advanceCursor(pg, claim, event);
        return {
          event_id: String(row.id),
          status: 'dead_letter',
          message_id: '',
          replayed: false
        };
      }
    });
  }

  async rejectEvent(
    claim: TinodeInboundClaim,
    event: TinodeInboundRejectedEvent
  ): Promise<TinodeInboundProcessResult> {
    return withPgTenant(this.input.pg, claim.tenant_id, async (pg) => {
      await this.assertClaim(pg, claim);
      const now = this.now().toISOString();
      const inserted = await pg.query(
        `INSERT INTO tinode_inbound_events
          (id, tenant_id, binding_id, provider_topic_id, event_kind,
           provider_sequence, provider_delete_id, dedupe_key, payload_hash, payload,
           status, attempt_count, error_code, error_message, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 'dead_letter', 1, $11, $12, $13)
         ON CONFLICT (tenant_id, binding_id, dedupe_key) DO NOTHING
         RETURNING *`,
        [
          pgId('tievent'),
          claim.tenant_id,
          claim.binding_id,
          claim.provider_topic_id,
          event.kind,
          event.provider_sequence,
          event.provider_delete_id,
          event.dedupe_key,
          event.payload_hash,
          JSON.stringify(event.payload),
          safeErrorCode(event.error_code),
          safeErrorMessage(event.error_message),
          now
        ]
      );
      const row = inserted.rows[0] || (await pg.query(
        `SELECT * FROM tinode_inbound_events
         WHERE tenant_id = $1 AND binding_id = $2 AND dedupe_key = $3
         FOR UPDATE`,
        [claim.tenant_id, claim.binding_id, event.dedupe_key]
      )).rows[0];
      if (!row) throw new Error('Rejected Tinode inbound event was not persisted');
      if (String(row.payload_hash) !== event.payload_hash) {
        throw new Error(`Tinode inbound payload drift for ${event.dedupe_key}`);
      }
      const status = String(row.status);
      if (!['projected', 'ignored', 'dead_letter'].includes(status)) {
        throw new Error(`Tinode inbound rejected event has non-terminal status: ${event.dedupe_key}`);
      }
      await pg.query(
        `INSERT INTO tinode_inbound_dead_letters
          (id, tenant_id, binding_id, event_id, error_code, error_message,
           payload_hash, retryable, next_retry_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
         ON CONFLICT (tenant_id, event_id) DO NOTHING`,
        [
          pgId('tidead'),
          claim.tenant_id,
          claim.binding_id,
          String(row.id),
          safeErrorCode(event.error_code),
          safeErrorMessage(event.error_message),
          event.payload_hash,
          event.retryable ? 1 : 0
        ]
      );
      await advanceCursor(pg, claim, event);
      return {
        event_id: String(row.id),
        status: status as TinodeInboundProcessResult['status'],
        message_id: String(row.message_id || ''),
        replayed: !inserted.rows[0]
      };
    });
  }

  async retryDueDeadLetters(
    claim: TinodeInboundClaim,
    input: { limit: number; maxAttempts: number; retryDelayMs: number },
    project: (
      pg: PgQueryable,
      event: TinodeInboundNormalizedEvent,
      eventId: string
    ) => Promise<TinodeInboundProjectionResult>
  ): Promise<TinodeInboundRetryResult[]> {
    const limit = boundedLimit(input.limit, 200);
    const maxAttempts = boundedRetryAttempts(input.maxAttempts);
    const retryDelayMs = boundedRetryDelay(input.retryDelayMs);
    return withPgTenant(this.input.pg, claim.tenant_id, async (pg) => {
      await this.assertClaim(pg, claim);
      const now = this.now();
      const due = await pg.query(
        `SELECT dead.id AS dead_letter_id, dead.retry_count,
                event.id, event.event_kind, event.provider_sequence,
                event.provider_delete_id, event.dedupe_key,
                event.payload_hash, event.payload
         FROM tinode_inbound_dead_letters AS dead
         JOIN tinode_inbound_events AS event
           ON event.id = dead.event_id
          AND event.tenant_id = dead.tenant_id
          AND event.binding_id = dead.binding_id
         WHERE dead.tenant_id = $1 AND dead.binding_id = $2
           AND dead.retryable = 1 AND dead.resolved_at IS NULL
           AND dead.next_retry_at IS NOT NULL AND dead.next_retry_at <= $3
         ORDER BY dead.next_retry_at ASC, dead.created_at ASC, dead.id ASC
         FOR UPDATE OF dead, event SKIP LOCKED
         LIMIT $4`,
        [claim.tenant_id, claim.binding_id, now.toISOString(), limit]
      );
      const output: TinodeInboundRetryResult[] = [];
      for (const row of due.rows) {
        const event = storedNormalizedEvent(row);
        const eventId = String(row.id);
        await pg.query(
          `UPDATE tinode_inbound_events
           SET status = 'processing', attempt_count = attempt_count + 1,
               claim_token_hash = $4, lease_until = $5,
               error_code = '', error_message = ''
           WHERE id = $1 AND tenant_id = $2 AND binding_id = $3`,
          [eventId, claim.tenant_id, claim.binding_id, sha256(claim.claim_token), claim.lease_until]
        );
        try {
          const projection = await project(pg, event, eventId);
          const completedAt = this.now().toISOString();
          await pg.query(
            `UPDATE tinode_inbound_events
             SET status = $4, message_id = NULLIF($5, ''), processed_at = $6,
                 claim_token_hash = '', lease_until = NULL,
                 error_code = '', error_message = ''
             WHERE id = $1 AND tenant_id = $2 AND binding_id = $3`,
            [eventId, claim.tenant_id, claim.binding_id, projection.status, projection.message_id || '', completedAt]
          );
          await pg.query(
            `UPDATE tinode_inbound_dead_letters
             SET retry_count = retry_count + 1, resolved_at = $4,
                 next_retry_at = NULL, updated_at = $4
             WHERE id = $1 AND tenant_id = $2 AND binding_id = $3`,
            [String(row.dead_letter_id), claim.tenant_id, claim.binding_id, completedAt]
          );
          output.push({
            event,
            result: {
              event_id: eventId,
              status: projection.status,
              message_id: projection.message_id || '',
              replayed: true,
              ...(projection.provider_mutation
                ? { provider_mutation: projection.provider_mutation }
                : {})
            }
          });
        } catch (error) {
          if (!(error instanceof TinodeInboundProjectionError)) throw error;
          const retryCount = Number(row.retry_count || 0) + 1;
          const canRetry = error.retryable && retryCount < maxAttempts;
          const failedAt = this.now();
          const errorCode = safeErrorCode(error.code);
          const errorMessage = safeErrorMessage(error.message);
          const nextRetryAt = canRetry
            ? new Date(failedAt.getTime() + retryBackoff(retryDelayMs, retryCount)).toISOString()
            : null;
          await pg.query(
            `UPDATE tinode_inbound_events
             SET status = 'dead_letter', error_code = $4, error_message = $5,
                 processed_at = $6, claim_token_hash = '', lease_until = NULL
             WHERE id = $1 AND tenant_id = $2 AND binding_id = $3`,
            [eventId, claim.tenant_id, claim.binding_id, errorCode, errorMessage, failedAt.toISOString()]
          );
          await pg.query(
            `UPDATE tinode_inbound_dead_letters
             SET retry_count = $4, retryable = $5, next_retry_at = $6,
                 error_code = $7, error_message = $8, updated_at = $9
             WHERE id = $1 AND tenant_id = $2 AND binding_id = $3`,
            [
              String(row.dead_letter_id),
              claim.tenant_id,
              claim.binding_id,
              retryCount,
              canRetry ? 1 : 0,
              nextRetryAt,
              errorCode,
              errorMessage,
              failedAt.toISOString()
            ]
          );
          output.push({
            event,
            result: {
              event_id: eventId,
              status: 'dead_letter',
              message_id: '',
              replayed: true
            }
          });
        }
      }
      return output;
    });
  }

  async releaseClaim(claim: TinodeInboundClaim): Promise<void> {
    await withPgTenant(this.input.pg, claim.tenant_id, async (pg) => {
      await pg.query(
        `UPDATE tinode_inbound_cursors
         SET lease_token_hash = '', lease_until = NULL, status = 'active',
             consecutive_failures = 0, next_retry_at = NULL,
             last_error_code = '', last_error_message = '',
             last_success_at = $4, updated_at = $4
         WHERE id = $1 AND tenant_id = $2 AND lease_token_hash = $3`,
        [claim.cursor.id, claim.tenant_id, sha256(claim.claim_token), this.now().toISOString()]
      );
    });
  }

  async recordFailure(claim: TinodeInboundClaim, error: unknown, retryDelayMs: number): Promise<void> {
    const now = this.now();
    const delay = Math.max(1_000, Math.min(300_000, retryDelayMs));
    await withPgTenant(this.input.pg, claim.tenant_id, async (pg) => {
      await pg.query(
        `UPDATE tinode_inbound_cursors
         SET lease_token_hash = '', lease_until = NULL, status = 'error',
             consecutive_failures = consecutive_failures + 1,
             next_retry_at = $4, last_error_code = $5, last_error_message = $6,
             updated_at = $7
         WHERE id = $1 AND tenant_id = $2 AND lease_token_hash = $3`,
        [
          claim.cursor.id,
          claim.tenant_id,
          sha256(claim.claim_token),
          new Date(now.getTime() + delay).toISOString(),
          'provider_unavailable',
          safeErrorMessage(error instanceof Error ? error.message : String(error)),
          now.toISOString()
        ]
      );
    });
  }

  private async assertClaim(pg: PgQueryable, claim: TinodeInboundClaim): Promise<void> {
    const result = await pg.query(
      `SELECT id FROM tinode_inbound_cursors
       WHERE id = $1 AND tenant_id = $2 AND binding_id = $3
         AND lease_token_hash = $4 AND lease_until > $5
       FOR UPDATE`,
      [claim.cursor.id, claim.tenant_id, claim.binding_id, sha256(claim.claim_token), this.now().toISOString()]
    );
    if (!result.rows[0]) {
      throw Object.assign(new Error('Tinode inbound claim is stale or expired'), { status: 409 });
    }
  }
}

async function advanceCursor(
  pg: PgQueryable,
  claim: TinodeInboundClaim,
  event: Pick<TinodeInboundNormalizedEvent, 'provider_sequence' | 'provider_delete_id'>
): Promise<void> {
  await pg.query(
    `UPDATE tinode_inbound_cursors
     SET last_data_seq = GREATEST(last_data_seq, $4),
         last_del_id = GREATEST(last_del_id, $5),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2 AND binding_id = $3`,
    [claim.cursor.id, claim.tenant_id, claim.binding_id, event.provider_sequence, event.provider_delete_id]
  );
}

function boundedLimit(value: number, max: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error('limit must be a positive integer');
  return Math.min(value, max);
}

function boundedLease(value: number): number {
  if (!Number.isInteger(value) || value < 5_000 || value > 300_000) {
    throw new Error('lease_ms must be an integer between 5000 and 300000');
  }
  return value;
}

function boundedRetryAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error('maxAttempts must be an integer between 1 and 10');
  }
  return value;
}

function boundedRetryDelay(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error('retryDelayMs must be an integer between 1000 and 300000');
  }
  return value;
}

function retryBackoff(baseDelayMs: number, retryCount: number): number {
  return Math.min(300_000, baseDelayMs * (2 ** Math.max(0, retryCount - 1)));
}

function storedNormalizedEvent(row: Record<string, any>): TinodeInboundNormalizedEvent {
  const kind = String(row.event_kind);
  if (kind !== 'data' && kind !== 'delete') throw new Error('Stored Tinode inbound event kind is invalid');
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Stored Tinode inbound event payload is invalid');
  }
  return {
    kind,
    provider_sequence: Number(row.provider_sequence || 0),
    provider_delete_id: Number(row.provider_delete_id || 0),
    dedupe_key: String(row.dedupe_key),
    payload_hash: String(row.payload_hash),
    payload
  } as TinodeInboundNormalizedEvent;
}

function safeErrorCode(value: string): string {
  return String(value || 'projection_failed').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 64);
}

function safeErrorMessage(value: string): string {
  return String(value || 'Tinode inbound projection failed')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/((?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]')
    .trim()
    .slice(0, 500);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
