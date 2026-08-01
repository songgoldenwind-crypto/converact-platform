import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { ConveractFabricRetentionError } from './errors.js';
import type {
  ConveractFabricRetentionPolicyRepository,
  ConveractFabricRetentionRepository
} from './ports.js';
import type {
  ConveractFabricLegalHold,
  ConveractFabricLegalHoldCreateInput,
  ConveractFabricRetentionClaim,
  ConveractFabricRetentionDeletionSummary,
  ConveractFabricRetentionPolicy,
  ConveractFabricRetentionPolicyWrite
} from './types.js';

type RetentionRow = Record<string, unknown>;

export class PostgresConveractFabricRetentionStore implements
  ConveractFabricRetentionRepository, ConveractFabricRetentionPolicyRepository {
  readonly #pg: PgQueryable;
  readonly #id: () => string;

  constructor(pg: PgQueryable, options: { id?: () => string } = {}) {
    this.#pg = pg;
    this.#id = options.id || randomUUID;
  }

  async listDueTenantIds(limit: number): Promise<string[]> {
    const result = await this.#pg.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM opc_ivekit_retention_tenant_ids($1)',
      [boundedInteger(limit, 1, 1000)]
    );
    return result.rows.map((row) => String(row.tenant_id));
  }

  listPolicies(tenantId: string): Promise<ConveractFabricRetentionPolicy[]> {
    return withPgTenant(this.#pg, tenantId, async (pg) => {
      const result = await pg.query<RetentionRow>(
        `SELECT * FROM ivekit_retention_policies
         WHERE tenant_id = $1 ORDER BY category`,
        [tenantId]
      );
      return result.rows.map(decodePolicy);
    });
  }

  putPolicy(input: ConveractFabricRetentionPolicyWrite): Promise<ConveractFabricRetentionPolicy> {
    return withPgTenant(this.#pg, input.tenant_id, async (pg) => {
      const result = input.expected_revision === 0
        ? await pg.query<RetentionRow>(
            `INSERT INTO ivekit_retention_policies
              (tenant_id, category, enabled, retention_days, batch_size, interval_seconds,
               next_run_at, revision, created_by, updated_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $8::timestamptz, 1, $7, $7,
               $8::timestamptz, $8::timestamptz)
             ON CONFLICT (tenant_id, category) DO NOTHING
             RETURNING *`,
            [
              input.tenant_id, input.category, input.enabled, input.retention_days,
              input.batch_size, input.interval_seconds, input.actor, input.now
            ]
          )
        : await pg.query<RetentionRow>(
            `UPDATE ivekit_retention_policies
             SET enabled = $4, retention_days = $5, batch_size = $6,
                 interval_seconds = $7, next_run_at = LEAST(next_run_at, $9::timestamptz),
                 revision = revision + 1, updated_by = $8, updated_at = $9::timestamptz
             WHERE tenant_id = $1 AND category = $2 AND revision = $3
               AND lease_owner IS NULL
             RETURNING *`,
            [
              input.tenant_id, input.category, input.expected_revision, input.enabled,
              input.retention_days, input.batch_size, input.interval_seconds,
              input.actor, input.now
            ]
          );
      if (!result.rows[0]) throw revisionConflict();
      return decodePolicy(result.rows[0]);
    });
  }

  listLegalHolds(input: {
    tenant_id: string;
    category?: string;
    status?: 'active' | 'released';
  }): Promise<ConveractFabricLegalHold[]> {
    return withPgTenant(this.#pg, input.tenant_id, async (pg) => {
      const result = await pg.query<RetentionRow>(
        `SELECT * FROM ivekit_legal_holds
         WHERE tenant_id = $1 AND ($2 = '' OR category = $2)
           AND ($3 = '' OR status = $3)
         ORDER BY placed_at DESC, id DESC LIMIT 1000`,
        [input.tenant_id, input.category || '', input.status || '']
      );
      return result.rows.map(decodeLegalHold);
    });
  }

  placeLegalHold(
    input: ConveractFabricLegalHoldCreateInput
  ): Promise<{ hold: ConveractFabricLegalHold; created: boolean }> {
    return withPgTenant(this.#pg, input.tenant_id, async (pg) => {
      const replay = await pg.query<RetentionRow>(
        `SELECT * FROM ivekit_legal_holds
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenant_id, input.idempotency_key]
      );
      if (replay.rows[0]) {
        const hold = decodeLegalHold(replay.rows[0]);
        if (hold.category !== input.category || hold.resource_type !== input.resource_type
          || hold.resource_id !== input.resource_id || hold.reason_code !== input.reason_code) {
          throw idempotencyConflict();
        }
        return { hold, created: false };
      }
      const existing = await pg.query<RetentionRow>(
        `SELECT * FROM ivekit_legal_holds
         WHERE tenant_id = $1 AND category = $2 AND resource_type = $3
           AND resource_id = $4 AND status = 'active'`,
        [input.tenant_id, input.category, input.resource_type, input.resource_id]
      );
      if (existing.rows[0]) throw conflict();
      const result = await pg.query<RetentionRow>(
        `INSERT INTO ivekit_legal_holds
          (id, tenant_id, category, resource_type, resource_id, reason_code,
           idempotency_key, status, placed_by, placed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9::timestamptz)
         RETURNING *`,
        [
          this.#id(), input.tenant_id, input.category, input.resource_type,
          input.resource_id, input.reason_code, input.idempotency_key, input.actor, input.now
        ]
      );
      if (!result.rows[0]) throw conflict();
      return { hold: decodeLegalHold(result.rows[0]), created: true };
    });
  }

  releaseLegalHold(input: {
    tenant_id: string;
    hold_id: string;
    actor: string;
    now: string;
  }): Promise<ConveractFabricLegalHold> {
    return withPgTenant(this.#pg, input.tenant_id, async (pg) => {
      const result = await pg.query<RetentionRow>(
        `UPDATE ivekit_legal_holds
         SET status = 'released', released_by = $3, released_at = $4::timestamptz
         WHERE id = $1 AND tenant_id = $2 AND status = 'active'
         RETURNING *`,
        [input.hold_id, input.tenant_id, input.actor, input.now]
      );
      if (!result.rows[0]) throw notFound();
      return decodeLegalHold(result.rows[0]);
    });
  }

  claimDue(input: {
    tenant_id: string;
    worker_id: string;
    lease_ms: number;
    limit: number;
    now: string;
  }): Promise<ConveractFabricRetentionClaim[]> {
    return withPgTenant(this.#pg, input.tenant_id, async (pg) => {
      const now = timestamp(input.now);
      const leaseExpiresAt = new Date(now.getTime() + boundedInteger(
        input.lease_ms, 5_000, 3_600_000
      )).toISOString();
      const due = await pg.query<RetentionRow>(
        `SELECT * FROM ivekit_retention_policies
         WHERE tenant_id = $1 AND enabled = TRUE AND next_run_at <= $2::timestamptz
           AND (lease_expires_at IS NULL OR lease_expires_at <= $2::timestamptz)
         ORDER BY next_run_at, category
         LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [input.tenant_id, now.toISOString(), boundedInteger(input.limit, 1, 100)]
      );
      const claims: ConveractFabricRetentionClaim[] = [];
      for (const row of due.rows) {
        const policy = decodePolicy(row);
        const leased = await pg.query<RetentionRow>(
          `UPDATE ivekit_retention_policies
           SET lease_owner = $3, lease_expires_at = $4::timestamptz, updated_at = $2::timestamptz
           WHERE tenant_id = $1 AND category = $5 AND revision = $6
             AND (lease_expires_at IS NULL OR lease_expires_at <= $2::timestamptz)
           RETURNING *`,
          [
            input.tenant_id, now.toISOString(), input.worker_id, leaseExpiresAt,
            policy.category, policy.revision
          ]
        );
        if (!leased.rows[0]) continue;
        const claimedPolicy = decodePolicy(leased.rows[0]);
        const runId = this.#id();
        const cutoffAt = new Date(
          now.getTime() - claimedPolicy.retention_days * 86_400_000
        ).toISOString();
        await pg.query(
          `INSERT INTO ivekit_retention_runs
            (id, tenant_id, category, policy_revision, worker_id, state,
             cutoff_at, started_at, created_at)
           VALUES ($1, $2, $3, $4, $5, 'processing', $6::timestamptz,
             $7::timestamptz, $7::timestamptz)`,
          [
            runId, input.tenant_id, claimedPolicy.category, claimedPolicy.revision,
            input.worker_id, cutoffAt, now.toISOString()
          ]
        );
        claims.push({
          run_id: runId,
          policy: claimedPolicy,
          worker_id: input.worker_id,
          cutoff_at: cutoffAt,
          started_at: now.toISOString()
        });
      }
      return claims;
    });
  }

  deleteExpired(claim: ConveractFabricRetentionClaim): Promise<ConveractFabricRetentionDeletionSummary> {
    return withPgTenant(this.#pg, claim.policy.tenant_id, async (pg) => {
      switch (claim.policy.category) {
        case 'notifications': return deleteNotifications(pg, claim);
        case 'audit': return deleteAuditEvents(pg, claim);
        case 'rate_limit_buckets': return deleteRateLimitBuckets(pg, claim);
        case 'tenant_events': return deleteTenantEvents(pg, claim);
        default: throw Object.assign(new Error('retention_handler_unavailable'), {
          code: 'retention_handler_unavailable', status: 501
        });
      }
    });
  }

  completeRun(input: {
    claim: ConveractFabricRetentionClaim;
    outcome: 'completed' | 'failed';
    summary: ConveractFabricRetentionDeletionSummary;
    error_code: string;
    now: string;
  }): Promise<void> {
    return withPgTenant(this.#pg, input.claim.policy.tenant_id, async (pg) => {
      const completed = await pg.query(
        `UPDATE ivekit_retention_runs
         SET state = $4, scanned_count = $5, deleted_count = $6, held_count = $7,
             error_code = $8, completed_at = $9::timestamptz
         WHERE id = $1 AND tenant_id = $2 AND worker_id = $3 AND state = 'processing'
         RETURNING id`,
        [
          input.claim.run_id, input.claim.policy.tenant_id, input.claim.worker_id,
          input.outcome, input.summary.scanned_count, input.summary.deleted_count,
          input.summary.held_count, safeCode(input.error_code), timestamp(input.now).toISOString()
        ]
      );
      if (!completed.rows[0]) throw leaseLost();
      const released = await pg.query(
        `UPDATE ivekit_retention_policies
         SET lease_owner = NULL, lease_expires_at = NULL,
             next_run_at = $4::timestamptz + make_interval(secs => interval_seconds),
             updated_at = $4::timestamptz
         WHERE tenant_id = $1 AND category = $2 AND lease_owner = $3
         RETURNING category`,
        [
          input.claim.policy.tenant_id, input.claim.policy.category,
          input.claim.worker_id, timestamp(input.now).toISOString()
        ]
      );
      if (!released.rows[0]) throw leaseLost();
    });
  }
}

async function deleteNotifications(
  pg: PgQueryable,
  claim: ConveractFabricRetentionClaim
): Promise<ConveractFabricRetentionDeletionSummary> {
  const result = await pg.query<RetentionRow>(
    `WITH candidates AS MATERIALIZED (
       SELECT notification.id,
         EXISTS (
           SELECT 1 FROM ivekit_legal_holds hold
           WHERE hold.tenant_id = notification.tenant_id
             AND hold.category = 'notifications'
             AND hold.resource_type = 'notification'
             AND hold.resource_id = notification.id
             AND hold.status = 'active'
         ) AS held
       FROM ivekit_notifications notification
       WHERE notification.tenant_id = $1
         AND notification.state IN ('completed', 'partial_failed', 'failed', 'cancelled')
         AND (
           notification.retention_until <= $3::timestamptz
           OR (
             notification.retention_until IS NULL
             AND notification.created_at <= $2::timestamptz
           )
         )
       ORDER BY held ASC, COALESCE(notification.retention_until, notification.created_at), notification.id
       LIMIT $4 FOR UPDATE SKIP LOCKED
     ), deleted AS (
       DELETE FROM ivekit_notifications notification
       USING candidates
       WHERE notification.tenant_id = $1 AND notification.id = candidates.id
         AND candidates.held = FALSE
       RETURNING notification.id
     )
     SELECT
       (SELECT COUNT(*) FROM candidates) AS scanned_count,
       (SELECT COUNT(*) FROM candidates WHERE held = TRUE) AS held_count,
       (SELECT COUNT(*) FROM deleted) AS deleted_count`,
    [claim.policy.tenant_id, claim.cutoff_at, claim.started_at, claim.policy.batch_size]
  );
  return decodeSummary(result.rows[0]);
}

async function deleteAuditEvents(
  pg: PgQueryable,
  claim: ConveractFabricRetentionClaim
): Promise<ConveractFabricRetentionDeletionSummary> {
  const candidates = await pg.query<RetentionRow>(
    `SELECT COUNT(*) AS scanned_count,
       COUNT(*) FILTER (WHERE held = TRUE) AS held_count
     FROM (
       SELECT EXISTS (
         SELECT 1 FROM ivekit_legal_holds hold
         WHERE hold.tenant_id = event.tenant_id AND hold.category = 'audit'
           AND hold.resource_type = 'audit_event' AND hold.resource_id = event.id
           AND hold.status = 'active'
       ) AS held
       FROM ivekit_audit_events event
       WHERE event.tenant_id = $1 AND event.legal_hold = FALSE
         AND (
           event.retention_until <= $3::timestamptz
           OR (event.retention_until IS NULL AND event.occurred_at <= $2::timestamptz)
         )
       ORDER BY held ASC, event.occurred_at, event.id
       LIMIT $4 FOR UPDATE SKIP LOCKED
     ) candidate`,
    [claim.policy.tenant_id, claim.cutoff_at, claim.started_at, claim.policy.batch_size]
  );
  const deleted = await pg.query<{ deleted_count: unknown }>(
    `SELECT opc_ivekit_delete_expired_audit_events(
       $1, $2, $3::timestamptz, $4::timestamptz, $5
     )
       AS deleted_count`,
    [
      claim.policy.tenant_id,
      claim.run_id,
      claim.cutoff_at,
      claim.started_at,
      claim.policy.batch_size
    ]
  );
  return {
    scanned_count: rowInteger(candidates.rows[0]?.scanned_count),
    held_count: rowInteger(candidates.rows[0]?.held_count),
    deleted_count: rowInteger(deleted.rows[0]?.deleted_count)
  };
}

async function deleteRateLimitBuckets(
  pg: PgQueryable,
  claim: ConveractFabricRetentionClaim
): Promise<ConveractFabricRetentionDeletionSummary> {
  const result = await pg.query<RetentionRow>(
    `WITH candidates AS (
       SELECT tenant_id, scope_type, scope_key_hmac, route_group, window_seconds
       FROM ivekit_rate_limit_buckets
       WHERE tenant_id = $1 AND expires_at <= CURRENT_TIMESTAMP
       ORDER BY expires_at
       LIMIT $2 FOR UPDATE SKIP LOCKED
     ), deleted AS (
       DELETE FROM ivekit_rate_limit_buckets bucket
       USING candidates
       WHERE bucket.tenant_id = candidates.tenant_id
         AND bucket.scope_type = candidates.scope_type
         AND bucket.scope_key_hmac = candidates.scope_key_hmac
         AND bucket.route_group = candidates.route_group
         AND bucket.window_seconds = candidates.window_seconds
       RETURNING bucket.tenant_id
     )
     SELECT COUNT(*) AS deleted_count FROM deleted`,
    [claim.policy.tenant_id, claim.policy.batch_size]
  );
  const deleted = rowInteger(result.rows[0]?.deleted_count);
  return { scanned_count: deleted, deleted_count: deleted, held_count: 0 };
}

async function deleteTenantEvents(
  pg: PgQueryable,
  claim: ConveractFabricRetentionClaim
): Promise<ConveractFabricRetentionDeletionSummary> {
  const result = await pg.query<RetentionRow>(
    `WITH candidates AS MATERIALIZED (
       SELECT event.id,
         EXISTS (
           SELECT 1 FROM ivekit_legal_holds hold
           WHERE hold.tenant_id = event.tenant_id AND hold.category = 'tenant_events'
             AND hold.resource_type = 'tenant_event' AND hold.resource_id = event.id::text
             AND hold.status = 'active'
         ) AS held
       FROM ivekit_tenant_events event
       WHERE event.tenant_id = $1
         AND event.expires_at <= $3::timestamptz
         AND NOT EXISTS (
           SELECT 1 FROM ivekit_voice_cdr_calls cdr_call
           WHERE cdr_call.tenant_id = event.tenant_id
             AND cdr_call.billing_event_id = event.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM ivekit_voice_cdr_receipts cdr_receipt
           WHERE cdr_receipt.tenant_id = event.tenant_id
             AND cdr_receipt.billing_event_id = event.id
         )
       ORDER BY held ASC, event.expires_at, event.id
       LIMIT $4 FOR UPDATE SKIP LOCKED
     ), deleted AS (
       DELETE FROM ivekit_tenant_events event
       USING candidates
       WHERE event.tenant_id = $1 AND event.id = candidates.id AND candidates.held = FALSE
       RETURNING event.id
     )
     SELECT
       (SELECT COUNT(*) FROM candidates) AS scanned_count,
       (SELECT COUNT(*) FROM candidates WHERE held = TRUE) AS held_count,
       (SELECT COUNT(*) FROM deleted) AS deleted_count`,
    [claim.policy.tenant_id, claim.cutoff_at, claim.started_at, claim.policy.batch_size]
  );
  return decodeSummary(result.rows[0]);
}

function decodePolicy(row: RetentionRow): ConveractFabricRetentionPolicy {
  return {
    tenant_id: String(row.tenant_id),
    category: row.category as ConveractFabricRetentionPolicy['category'],
    enabled: row.enabled === true || row.enabled === 'true',
    retention_days: rowInteger(row.retention_days),
    batch_size: rowInteger(row.batch_size),
    interval_seconds: rowInteger(row.interval_seconds),
    next_run_at: timestamp(row.next_run_at).toISOString(),
    lease_owner: row.lease_owner == null ? null : String(row.lease_owner),
    lease_expires_at: row.lease_expires_at == null ? null : timestamp(row.lease_expires_at).toISOString(),
    revision: rowInteger(row.revision),
    created_by: String(row.created_by),
    updated_by: String(row.updated_by),
    created_at: timestamp(row.created_at).toISOString(),
    updated_at: timestamp(row.updated_at).toISOString()
  };
}

function decodeLegalHold(row: RetentionRow): ConveractFabricLegalHold {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    category: row.category as ConveractFabricLegalHold['category'],
    resource_type: String(row.resource_type),
    resource_id: String(row.resource_id),
    reason_code: String(row.reason_code),
    idempotency_key: String(row.idempotency_key),
    status: row.status as ConveractFabricLegalHold['status'],
    placed_by: String(row.placed_by),
    released_by: row.released_by == null ? null : String(row.released_by),
    placed_at: timestamp(row.placed_at).toISOString(),
    released_at: row.released_at == null ? null : timestamp(row.released_at).toISOString()
  };
}

function decodeSummary(row: RetentionRow | undefined): ConveractFabricRetentionDeletionSummary {
  return {
    scanned_count: rowInteger(row?.scanned_count),
    deleted_count: rowInteger(row?.deleted_count),
    held_count: rowInteger(row?.held_count)
  };
}

function rowInteger(value: unknown): number {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ConveractFabricRetentionError('invalid_retention_result', 500);
  }
  return number;
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConveractFabricRetentionError('validation_failed', 422);
  }
  return value;
}

function timestamp(value: unknown): Date {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new ConveractFabricRetentionError('validation_failed', 422);
  }
  return date;
}

function safeCode(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 100);
}

function leaseLost(): Error {
  return new ConveractFabricRetentionError('retention_lease_lost', 409);
}

function revisionConflict(): Error {
  return new ConveractFabricRetentionError('revision_conflict', 409);
}

function idempotencyConflict(): Error {
  return new ConveractFabricRetentionError('idempotency_conflict', 409);
}

function conflict(): Error {
  return new ConveractFabricRetentionError('conflict', 409);
}

function notFound(): Error {
  return new ConveractFabricRetentionError('not_found', 404);
}
