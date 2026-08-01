import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import type { ConveractFabricEventWebhookSubscriptionRepository } from './subscription-service.js';
import type {
  ConveractFabricEventWebhookSubscription,
  ConveractFabricEventWebhookSubscriptionCreateResult,
  ConveractFabricEventWebhookSubscriptionPage,
  ConveractFabricStoredIntegrationEvent
} from './types.js';

type Row = Record<string, unknown>;

export interface ConveractFabricEventWebhookClaimInput {
  tenant_id: string;
  worker_id: string;
  lease_token_hash: string;
  now: Date;
  lease_ms: number;
  limit: number;
}

export interface ConveractFabricEventWebhookCompleteInput {
  tenant_id: string;
  subscription_id: string;
  worker_id: string;
  lease_token_hash: string;
  last_event_id: string;
  now: Date;
}

export interface ConveractFabricEventWebhookFailInput extends Omit<ConveractFabricEventWebhookCompleteInput, 'last_event_id'> {
  error_code: string;
  retry_at: Date;
}

export class PostgresConveractFabricEventWebhookStore implements ConveractFabricEventWebhookSubscriptionRepository {
  constructor(private readonly pg: PgQueryable) {}

  async insert(
    subscription: ConveractFabricEventWebhookSubscription
  ): Promise<ConveractFabricEventWebhookSubscriptionCreateResult> {
    return withPgTenant(this.pg, subscription.tenant_id, async (pg) => {
      const result = await pg.query<Row>(
        `INSERT INTO ivekit_event_webhook_subscriptions
          (id, tenant_id, endpoint_id, name, event_patterns, status, last_event_id,
           next_attempt_at, attempt_count, error_code, lease_token_hash, lease_until,
           worker_id, revision, idempotency_key, payload_hash, created_by, updated_by,
           created_at, updated_at)
         VALUES
          ($1, $2, $3, $4, $5::text[], $6, $7::bigint, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        subscriptionParams(subscription)
      );
      if (result.rows[0]) return { subscription: decodeSubscription(result.rows[0]), created: true };
      const replay = await pg.query<Row>(
        `SELECT subscription.* FROM ivekit_event_webhook_subscriptions subscription
         WHERE subscription.tenant_id = $1 AND subscription.idempotency_key = $2`,
        [subscription.tenant_id, subscription.idempotency_key]
      );
      const existing = replay.rows[0] ? decodeSubscription(replay.rows[0]) : null;
      if (!existing) throw httpError(409, 'event webhook idempotency conflict');
      if (existing.payload_hash !== subscription.payload_hash) {
        throw httpError(409, 'event webhook idempotency conflict');
      }
      return { subscription: existing, created: false };
    });
  }

  get(tenantId: string, subscriptionId: string): Promise<ConveractFabricEventWebhookSubscription | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<Row>(
        `SELECT subscription.* FROM ivekit_event_webhook_subscriptions subscription
         WHERE subscription.tenant_id = $1 AND subscription.id = $2`,
        [tenantId, subscriptionId]
      );
      return result.rows[0] ? decodeSubscription(result.rows[0]) : null;
    });
  }

  list(input: {
    tenant_id: string;
    status?: ConveractFabricEventWebhookSubscription['status'];
    limit?: number;
    cursor?: string;
  }): Promise<ConveractFabricEventWebhookSubscriptionPage> {
    const limit = bounded(input.limit, 50, 1, 200);
    const cursor = decodeCursor(input.cursor);
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<Row>(
        `SELECT subscription.* FROM ivekit_event_webhook_subscriptions subscription
         WHERE subscription.tenant_id = $1
           AND ($2::text IS NULL OR subscription.status = $2)
           AND ($3::timestamptz IS NULL OR (subscription.created_at, subscription.id) < ($3, $4))
         ORDER BY subscription.created_at DESC, subscription.id DESC
         LIMIT $5`,
        [input.tenant_id, input.status || null, cursor?.created_at || null, cursor?.id || '', limit + 1]
      );
      const items = result.rows.slice(0, limit).map(decodeSubscription);
      const last = items.at(-1);
      return {
        items,
        next_cursor: result.rows.length > limit && last
          ? encodeCursor({ created_at: last.created_at, id: last.id })
          : null
      };
    });
  }

  update(
    subscription: ConveractFabricEventWebhookSubscription,
    expectedRevision: number
  ): Promise<ConveractFabricEventWebhookSubscription> {
    return withPgTenant(this.pg, subscription.tenant_id, async (pg) => {
      const result = await pg.query<Row>(
        `UPDATE ivekit_event_webhook_subscriptions
         SET name = $3, event_patterns = $4::text[], status = $5,
             revision = revision + 1, payload_hash = $6, updated_by = $7, updated_at = $8,
             next_attempt_at = CASE WHEN $5 = 'active' THEN LEAST(next_attempt_at, $8) ELSE next_attempt_at END,
             lease_token_hash = '', lease_until = NULL, worker_id = ''
         WHERE tenant_id = $1 AND id = $2 AND revision = $9
         RETURNING *`,
        [subscription.tenant_id, subscription.id, subscription.name, subscription.event_patterns,
          subscription.status, subscription.payload_hash, subscription.updated_by,
          subscription.updated_at, expectedRevision]
      );
      if (!result.rows[0]) throw httpError(409, 'event webhook subscription revision conflict');
      return decodeSubscription(result.rows[0]);
    });
  }

  async listWorkerTenants(now: Date, limit: number): Promise<string[]> {
    const result = await this.pg.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM opc_event_webhook_worker_tenant_ids($1, $2)',
      [now.toISOString(), bounded(limit, 100, 1, 1000)]
    );
    return result.rows.map((row) => String(row.tenant_id));
  }

  claimDue(input: ConveractFabricEventWebhookClaimInput): Promise<ConveractFabricEventWebhookSubscription[]> {
    validateClaim(input);
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<Row>(
        `WITH candidate AS (
           SELECT subscription.id
           FROM ivekit_event_webhook_subscriptions subscription
           WHERE subscription.tenant_id = $1 AND subscription.status = 'active'
             AND subscription.next_attempt_at <= $2
             AND (subscription.lease_until IS NULL OR subscription.lease_until <= $2)
           ORDER BY subscription.next_attempt_at, subscription.last_event_id, subscription.id
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE ivekit_event_webhook_subscriptions subscription
         SET worker_id = $4, lease_token_hash = $5,
             lease_until = $2::timestamptz + ($6 * INTERVAL '1 millisecond'),
             attempt_count = subscription.attempt_count + 1, updated_at = $2
         FROM candidate
         WHERE subscription.tenant_id = $1 AND subscription.id = candidate.id
         RETURNING subscription.*`,
        [input.tenant_id, input.now.toISOString(), bounded(input.limit, 25, 1, 200),
          input.worker_id, input.lease_token_hash, input.lease_ms]
      );
      return result.rows.map(decodeSubscription);
    });
  }

  listEvents(
    tenantId: string,
    afterEventId: string,
    now: Date,
    limit: number
  ): Promise<ConveractFabricStoredIntegrationEvent[]> {
    if (!/^\d+$/.test(afterEventId)) throw httpError(422, 'event cursor is invalid');
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<Row>(
        `SELECT event.id, event.tenant_id, event.event_type, event.visibility_scope,
                event.visibility_ref_id, event.audience_user_ids, event.payload,
                event.occurred_at, event.expires_at
         FROM ivekit_tenant_events event
         WHERE event.tenant_id = $1 AND event.id > $2::bigint AND event.expires_at > $3
         ORDER BY event.id
         LIMIT $4`,
        [tenantId, afterEventId, now.toISOString(), bounded(limit, 100, 1, 500)]
      );
      return result.rows.map(decodeEvent);
    });
  }

  completeClaim(input: ConveractFabricEventWebhookCompleteInput): Promise<ConveractFabricEventWebhookSubscription> {
    validateFence(input);
    if (!/^\d+$/.test(input.last_event_id)) throw httpError(422, 'event cursor is invalid');
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<Row>(
        `UPDATE ivekit_event_webhook_subscriptions subscription
         SET last_event_id = GREATEST(subscription.last_event_id, $5::bigint),
             next_attempt_at = $6, attempt_count = 0, error_code = '',
             worker_id = '', lease_token_hash = '', lease_until = NULL, updated_at = $6
         WHERE subscription.tenant_id = $1 AND subscription.id = $2
           AND subscription.worker_id = $3 AND subscription.lease_token_hash = $4
         RETURNING subscription.*`,
        [input.tenant_id, input.subscription_id, input.worker_id, input.lease_token_hash,
          input.last_event_id, input.now.toISOString()]
      );
      if (!result.rows[0]) throw httpError(409, 'event webhook subscription lease lost');
      return decodeSubscription(result.rows[0]);
    });
  }

  failClaim(input: ConveractFabricEventWebhookFailInput): Promise<ConveractFabricEventWebhookSubscription> {
    validateFence(input);
    const errorCode = /^[a-z0-9_]{1,100}$/.test(input.error_code) ? input.error_code : 'worker_failed';
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<Row>(
        `UPDATE ivekit_event_webhook_subscriptions subscription
         SET next_attempt_at = $5, error_code = $6, worker_id = '',
             lease_token_hash = '', lease_until = NULL, updated_at = $7
         WHERE subscription.tenant_id = $1 AND subscription.id = $2
           AND subscription.worker_id = $3 AND subscription.lease_token_hash = $4
         RETURNING subscription.*`,
        [input.tenant_id, input.subscription_id, input.worker_id, input.lease_token_hash,
          input.retry_at.toISOString(), errorCode, input.now.toISOString()]
      );
      if (!result.rows[0]) throw httpError(409, 'event webhook subscription lease lost');
      return decodeSubscription(result.rows[0]);
    });
  }
}

function subscriptionParams(value: ConveractFabricEventWebhookSubscription): unknown[] {
  return [
    value.id, value.tenant_id, value.endpoint_id, value.name, value.event_patterns, value.status,
    value.last_event_id, value.next_attempt_at, value.attempt_count, value.error_code,
    value.lease_token_hash, value.lease_until, value.worker_id, value.revision,
    value.idempotency_key, value.payload_hash, value.created_by, value.updated_by,
    value.created_at, value.updated_at
  ];
}

function decodeSubscription(row: Row): ConveractFabricEventWebhookSubscription {
  return {
    id: text(row.id), tenant_id: text(row.tenant_id), endpoint_id: text(row.endpoint_id),
    name: text(row.name), event_patterns: strings(row.event_patterns),
    status: text(row.status) as ConveractFabricEventWebhookSubscription['status'],
    last_event_id: text(row.last_event_id), next_attempt_at: timestamp(row.next_attempt_at),
    attempt_count: number(row.attempt_count), error_code: text(row.error_code),
    lease_token_hash: text(row.lease_token_hash),
    lease_until: row.lease_until == null ? null : timestamp(row.lease_until),
    worker_id: text(row.worker_id), revision: number(row.revision),
    idempotency_key: text(row.idempotency_key), payload_hash: text(row.payload_hash),
    created_by: text(row.created_by), updated_by: text(row.updated_by),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeEvent(row: Row): ConveractFabricStoredIntegrationEvent {
  return {
    id: text(row.id), tenant_id: text(row.tenant_id), event_type: text(row.event_type),
    visibility_scope: text(row.visibility_scope) as ConveractFabricStoredIntegrationEvent['visibility_scope'],
    visibility_ref_id: text(row.visibility_ref_id), audience_user_ids: strings(row.audience_user_ids),
    payload: row.payload, occurred_at: timestamp(row.occurred_at), expires_at: timestamp(row.expires_at)
  };
}

function validateClaim(input: ConveractFabricEventWebhookClaimInput): void {
  validateFence(input);
  if (!Number.isInteger(input.lease_ms) || input.lease_ms < 5_000 || input.lease_ms > 900_000) {
    throw httpError(422, 'event webhook lease is invalid');
  }
}

function validateFence(input: {
  tenant_id: string;
  subscription_id?: string;
  worker_id: string;
  lease_token_hash: string;
}): void {
  if (!input.tenant_id || !input.worker_id || !/^[a-f0-9]{64}$/.test(input.lease_token_hash)
    || (input.subscription_id !== undefined && !input.subscription_id)) {
    throw httpError(422, 'event webhook worker fence is invalid');
  }
}

function encodeCursor(value: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value?: string): { created_at: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const createdAt = String(parsed.created_at || '');
    const id = String(parsed.id || '');
    if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || !id) throw new Error();
    return { created_at: new Date(createdAt).toISOString(), id };
  } catch {
    throw httpError(422, 'event webhook cursor is invalid');
  }
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < min || result > max) throw httpError(422, 'limit is invalid');
  return result;
}

function text(value: unknown): string { return String(value ?? ''); }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.map(text) : []; }
function number(value: unknown): number { return Number(value || 0); }
function timestamp(value: unknown): string { return new Date(String(value)).toISOString(); }
function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
