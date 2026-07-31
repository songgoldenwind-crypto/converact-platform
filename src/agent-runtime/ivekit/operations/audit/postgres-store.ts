import { createHash, randomUUID } from 'node:crypto';

import { withPgTenant } from '../../../../db-pg-tenant.js';
import type { PgQueryable } from '../../../../db-pg.js';
import { canonicalNotificationJson } from '../../notifications/canonical.js';
import { IveKitOperationsError } from './errors.js';
import type { IveKitAuditRepository } from './ports.js';
import type {
  IveKitAuditAppendInput,
  IveKitAuditAppendResult,
  IveKitAuditEvent,
  IveKitAuditListInput,
  IveKitAuditPage
} from './types.js';

type AuditRow = Record<string, unknown>;

export class PostgresIveKitAuditStore implements IveKitAuditRepository {
  readonly #pg: PgQueryable;
  readonly #id: () => string;

  constructor(pg: PgQueryable, options: { id?: () => string } = {}) {
    this.#pg = pg;
    this.#id = options.id || randomUUID;
  }

  append(input: IveKitAuditAppendInput): Promise<IveKitAuditAppendResult> {
    return withPgTenant(this.#pg, input.tenant_id, async (pg) => {
      await pg.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 947113))',
        [input.tenant_id]
      );

      const replay = await pg.query<AuditRow>(
        `SELECT * FROM ivekit_audit_events
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenant_id, input.idempotency_key]
      );
      if (replay.rows[0]) return replayResult(replay.rows[0], input);

      const tail = await pg.query<Pick<AuditRow, 'event_hash'>>(
        `SELECT event_hash FROM ivekit_audit_events
         WHERE tenant_id = $1
         ORDER BY occurred_at DESC, id DESC
         LIMIT 1 FOR UPDATE`,
        [input.tenant_id]
      );
      const previousHash = String(tail.rows[0]?.event_hash || ZERO_HASH);
      const eventHash = hashEvent(input, previousHash);
      const result = await pg.query<AuditRow>(
        `INSERT INTO ivekit_audit_events
          (id, tenant_id, actor_id, actor_role, action, resource_type, resource_id,
           business_ref_type, business_ref_id, request_id, idempotency_key, result,
           policy_decision, source_ip_hmac, metadata, occurred_at, previous_hash,
           event_hash, retention_until, legal_hold)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15::jsonb, $16::timestamptz, $17, $18, $19::timestamptz, $20)
         RETURNING *`,
        [
          this.#id(), input.tenant_id, input.actor_id, input.actor_role, input.action,
          input.resource_type, input.resource_id, input.business_ref_type,
          input.business_ref_id, input.request_id, input.idempotency_key, input.result,
          input.policy_decision, input.source_ip_hmac,
          canonicalNotificationJson(input.metadata), input.occurred_at,
          previousHash, eventHash, input.retention_until, input.legal_hold
        ]
      );
      return { event: decodeAuditEvent(requiredRow(result.rows[0])), created: true };
    });
  }

  list(input: IveKitAuditListInput): Promise<IveKitAuditPage> {
    const limit = boundedLimit(input.limit);
    const scope = cursorScope(input);
    const cursor = decodeCursor(input.cursor, scope);
    return withPgTenant(this.#pg, input.tenant_id, async (pg) => {
      const result = await pg.query<AuditRow>(
        `SELECT event.* FROM ivekit_audit_events event
         WHERE event.tenant_id = $1
           AND ($2 = '' OR event.action = $2)
           AND ($3 = '' OR event.resource_type = $3)
           AND ($4 = '' OR event.resource_id = $4)
           AND (event.occurred_at, event.id) < ($5::timestamptz, $6::text)
         ORDER BY event.occurred_at DESC, event.id DESC
         LIMIT $7`,
        [
          input.tenant_id, input.action || '', input.resource_type || '',
          input.resource_id || '', cursor.occurred_at, cursor.id, limit + 1
        ]
      );
      return page(result.rows.map(decodeAuditEvent), limit, scope);
    });
  }
}

const ZERO_HASH = '0'.repeat(64);

function replayResult(row: AuditRow, input: IveKitAuditAppendInput): IveKitAuditAppendResult {
  const event = decodeAuditEvent(row);
  const candidate = hashEvent({ ...input, occurred_at: event.occurred_at }, event.previous_hash);
  if (candidate !== event.event_hash) {
    throw new IveKitOperationsError('idempotency_conflict', 409);
  }
  return { event, created: false };
}

function hashEvent(input: IveKitAuditAppendInput, previousHash: string): string {
  return createHash('sha256').update(canonicalNotificationJson({
    tenant_id: input.tenant_id,
    actor_id: input.actor_id,
    actor_role: input.actor_role,
    action: input.action,
    resource_type: input.resource_type,
    resource_id: input.resource_id,
    business_ref_type: input.business_ref_type,
    business_ref_id: input.business_ref_id,
    request_id: input.request_id,
    idempotency_key: input.idempotency_key,
    result: input.result,
    policy_decision: input.policy_decision,
    source_ip_hmac: input.source_ip_hmac,
    metadata: input.metadata,
    occurred_at: input.occurred_at,
    retention_until: input.retention_until,
    legal_hold: input.legal_hold,
    previous_hash: previousHash
  })).digest('hex');
}

function decodeAuditEvent(row: AuditRow): IveKitAuditEvent {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    actor_id: String(row.actor_id),
    actor_role: row.actor_role as IveKitAuditEvent['actor_role'],
    action: String(row.action),
    resource_type: String(row.resource_type),
    resource_id: String(row.resource_id),
    business_ref_type: String(row.business_ref_type),
    business_ref_id: String(row.business_ref_id),
    request_id: String(row.request_id),
    idempotency_key: String(row.idempotency_key),
    result: row.result as IveKitAuditEvent['result'],
    policy_decision: row.policy_decision as IveKitAuditEvent['policy_decision'],
    source_ip_hmac: String(row.source_ip_hmac || ''),
    metadata: jsonRecord(row.metadata),
    occurred_at: timestamp(row.occurred_at),
    retention_until: row.retention_until == null ? null : timestamp(row.retention_until),
    legal_hold: row.legal_hold === true || row.legal_hold === 'true',
    previous_hash: String(row.previous_hash),
    event_hash: String(row.event_hash),
    created_at: timestamp(row.created_at)
  };
}

function cursorScope(input: IveKitAuditListInput): string {
  return createHash('sha256').update(canonicalNotificationJson({
    tenant_id: input.tenant_id,
    action: input.action || '',
    resource_type: input.resource_type || '',
    resource_id: input.resource_id || ''
  })).digest('hex');
}

function decodeCursor(
  value: string | undefined,
  scope: string
): { occurred_at: string; id: string } {
  if (!value) return { occurred_at: '9999-12-31T23:59:59.999Z', id: '\uffff' };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.scope !== scope || typeof parsed.occurred_at !== 'string'
      || typeof parsed.id !== 'string') throw new Error('invalid cursor');
    return { occurred_at: timestamp(parsed.occurred_at), id: parsed.id };
  } catch {
    throw new IveKitOperationsError('validation_failed', 400);
  }
}

function page(rows: IveKitAuditEvent[], limit: number, scope: string): IveKitAuditPage {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    next_cursor: hasMore && last ? Buffer.from(JSON.stringify({
      v: 1, scope, occurred_at: last.occurred_at, id: last.id
    }), 'utf8').toString('base64url') : null
  };
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new IveKitOperationsError('validation_failed', 422);
  }
  return value;
}

function timestamp(value: unknown): string {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new IveKitOperationsError('invalid_stored_event', 500);
  return date.toISOString();
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid database rows are reported consistently below.
    }
  }
  throw new IveKitOperationsError('invalid_stored_event', 500);
}

function requiredRow(row: AuditRow | undefined): AuditRow {
  if (!row) throw new IveKitOperationsError('audit_append_failed', 500);
  return row;
}
