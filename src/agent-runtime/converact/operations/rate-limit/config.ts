import { resolveFabricEnv } from '../../../../config/converact-env.js';
import type { PgQueryable } from '../../../../db-pg.js';
import { PostgresIveKitRateLimitStore } from './postgres-store.js';
import { IveKitRateLimiter, requiredRateLimitHmacKey } from './service.js';

export interface IveKitRateLimitConfiguration {
  enabled: boolean;
  notification_create: {
    tenant_per_minute: number;
    actor_per_minute: number;
    source_ip_per_minute: number;
    recipient_per_minute: number;
  };
  notification_provider_receipt: {
    tenant_per_minute: number;
    provider_per_minute: number;
    source_ip_per_minute: number;
  };
  event_webhook_mutation: {
    tenant_per_minute: number;
    actor_per_minute: number;
    source_ip_per_minute: number;
  };
}

export function configuredIveKitRateLimiter(
  pg: PgQueryable,
  env: NodeJS.ProcessEnv = process.env
): IveKitRateLimiter {
  return new IveKitRateLimiter({
    repository: new PostgresIveKitRateLimitStore(pg),
    hmac_key: requiredRateLimitHmacKey(env)
  });
}

export function iveKitRateLimitConfiguration(
  env: NodeJS.ProcessEnv = process.env
): IveKitRateLimitConfiguration {
  return {
    enabled: booleanEnv(resolveFabricEnv(env, 'RATE_LIMIT_ENABLED'), true),
    notification_create: {
      tenant_per_minute: positiveInteger(resolveFabricEnv(env, 'RATE_LIMIT_NOTIFICATION_TENANT_PER_MINUTE'), 1_000),
      actor_per_minute: positiveInteger(resolveFabricEnv(env, 'RATE_LIMIT_NOTIFICATION_ACTOR_PER_MINUTE'), 60),
      source_ip_per_minute: positiveInteger(resolveFabricEnv(env, 'RATE_LIMIT_NOTIFICATION_SOURCE_IP_PER_MINUTE'), 120),
      recipient_per_minute: positiveInteger(resolveFabricEnv(env, 'RATE_LIMIT_NOTIFICATION_RECIPIENT_PER_MINUTE'), 10)
    },
    notification_provider_receipt: {
      tenant_per_minute: positiveInteger(resolveFabricEnv(env, 'RATE_LIMIT_RECEIPT_TENANT_PER_MINUTE'), 5_000),
      provider_per_minute: positiveInteger(resolveFabricEnv(env, 'RATE_LIMIT_RECEIPT_PROVIDER_PER_MINUTE'), 600),
      source_ip_per_minute: positiveInteger(resolveFabricEnv(env, 'RATE_LIMIT_RECEIPT_SOURCE_IP_PER_MINUTE'), 1_200)
    },
    event_webhook_mutation: {
      tenant_per_minute: positiveInteger(resolveFabricEnv(env, 'RATE_LIMIT_EVENT_WEBHOOK_TENANT_PER_MINUTE'), 120),
      actor_per_minute: positiveInteger(resolveFabricEnv(env, 'RATE_LIMIT_EVENT_WEBHOOK_ACTOR_PER_MINUTE'), 30),
      source_ip_per_minute: positiveInteger(resolveFabricEnv(env, 'RATE_LIMIT_EVENT_WEBHOOK_SOURCE_IP_PER_MINUTE'), 60)
    }
  };
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw Object.assign(new Error('validation_failed'), { code: 'validation_failed', status: 500 });
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 1_000_000_000) {
    throw Object.assign(new Error('validation_failed'), { code: 'validation_failed', status: 500 });
  }
  return number;
}
