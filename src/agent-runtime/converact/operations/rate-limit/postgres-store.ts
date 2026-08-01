import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import type { ConveractFabricRateLimitRepository } from './ports.js';
import type {
  ConveractFabricRateLimitDecision,
  ConveractFabricRateLimitReservationDimension,
  ConveractFabricRateLimitReservationInput
} from './types.js';

interface BucketRow {
  window_started_at: unknown;
  used_count: unknown;
  limit_count: unknown;
}

class ReservationDenied extends Error {
  constructor(readonly decision: ConveractFabricRateLimitDecision) {
    super('reservation_denied');
  }
}

export class PostgresConveractFabricRateLimitStore implements ConveractFabricRateLimitRepository {
  constructor(private readonly pg: PgQueryable) {}

  async reserve(input: ConveractFabricRateLimitReservationInput): Promise<ConveractFabricRateLimitDecision> {
    try {
      return await withPgTenant(this.pg, input.tenant_id, async (pg) => {
        const now = timestamp(input.now);
        for (const dimension of input.dimensions) {
          const decision = await reserveDimension(pg, input, dimension, now);
          if (!decision.allowed) throw new ReservationDenied(decision);
        }
        return { allowed: true, retry_after_seconds: 0, denied_scope: null };
      });
    } catch (error) {
      if (error instanceof ReservationDenied) return error.decision;
      throw error;
    }
  }
}

async function reserveDimension(
  pg: PgQueryable,
  input: ConveractFabricRateLimitReservationInput,
  dimension: ConveractFabricRateLimitReservationDimension,
  now: Date
): Promise<ConveractFabricRateLimitDecision> {
  const windowStartedAt = floorWindow(now, dimension.window_seconds);
  const windowEndsAt = new Date(windowStartedAt.getTime() + dimension.window_seconds * 1_000);
  const expiresAt = new Date(windowEndsAt.getTime() + dimension.window_seconds * 1_000);
  const result = await pg.query<BucketRow>(
    `INSERT INTO ivekit_rate_limit_buckets
      (tenant_id, scope_type, scope_key_hmac, route_group, window_seconds,
       window_started_at, used_count, limit_count, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::timestamptz, $10::timestamptz)
     ON CONFLICT (tenant_id, scope_type, scope_key_hmac, route_group, window_seconds)
     DO UPDATE SET
       window_started_at = EXCLUDED.window_started_at,
       used_count = CASE
         WHEN ivekit_rate_limit_buckets.window_started_at < EXCLUDED.window_started_at
           THEN EXCLUDED.used_count
         ELSE ivekit_rate_limit_buckets.used_count + EXCLUDED.used_count
       END,
       limit_count = EXCLUDED.limit_count,
       expires_at = EXCLUDED.expires_at,
       updated_at = EXCLUDED.updated_at
     WHERE CASE
       WHEN ivekit_rate_limit_buckets.window_started_at < EXCLUDED.window_started_at
         THEN EXCLUDED.used_count
       ELSE ivekit_rate_limit_buckets.used_count + EXCLUDED.used_count
     END <= EXCLUDED.limit_count
     RETURNING window_started_at, used_count, limit_count`,
    [
      input.tenant_id, dimension.scope_type, dimension.scope_key_hmac, input.route_group,
      dimension.window_seconds, windowStartedAt.toISOString(), dimension.cost, dimension.limit,
      expiresAt.toISOString(), now.toISOString()
    ]
  );
  if (result.rows[0]) {
    return { allowed: true, retry_after_seconds: 0, denied_scope: null };
  }

  const current = await pg.query<BucketRow>(
    `SELECT window_started_at, used_count, limit_count
     FROM ivekit_rate_limit_buckets
     WHERE tenant_id = $1 AND scope_type = $2 AND scope_key_hmac = $3
       AND route_group = $4 AND window_seconds = $5`,
    [
      input.tenant_id, dimension.scope_type, dimension.scope_key_hmac,
      input.route_group, dimension.window_seconds
    ]
  );
  const retryAfter = retryAfterSeconds(
    current.rows[0]?.window_started_at,
    now,
    dimension.window_seconds
  );
  return {
    allowed: false,
    retry_after_seconds: retryAfter,
    denied_scope: dimension.scope_type
  };
}

function floorWindow(now: Date, seconds: number): Date {
  const size = seconds * 1_000;
  return new Date(Math.floor(now.getTime() / size) * size);
}

function retryAfterSeconds(value: unknown, now: Date, windowSeconds: number): number {
  if (value === undefined || value === null) return windowSeconds;
  const start = timestamp(value);
  const remaining = Math.ceil((start.getTime() + windowSeconds * 1_000 - now.getTime()) / 1_000);
  return Math.max(1, Math.min(windowSeconds, remaining));
}

function timestamp(value: unknown): Date {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw Object.assign(new Error('validation_failed'), { code: 'validation_failed', status: 500 });
  }
  return date;
}
