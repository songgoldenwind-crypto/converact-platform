import { resolveFabricEnv } from '../../../../config/converact-env.js';
import { createHmac } from 'node:crypto';

import { IveKitRateLimitError } from './errors.js';
import { observeIveKitRateLimit } from './metrics.js';
import type { IveKitRateLimitRepository } from './ports.js';
import type {
  IveKitRateLimitCheckInput,
  IveKitRateLimitDecision,
  IveKitRateLimitReservationDimension
} from './types.js';

export class IveKitRateLimiter {
  readonly #repository: IveKitRateLimitRepository;
  readonly #hmacKey: Buffer;
  readonly #now: () => Date;

  constructor(input: {
    repository: IveKitRateLimitRepository;
    hmac_key: string;
    now?: () => Date;
  }) {
    this.#repository = input.repository;
    this.#hmacKey = decodeKey(input.hmac_key);
    this.#now = input.now || (() => new Date());
  }

  async check(input: IveKitRateLimitCheckInput): Promise<IveKitRateLimitDecision> {
    const tenantId = requiredText(input.tenant_id, 255);
    const routeGroup = route(input.route_group);
    if (!Array.isArray(input.dimensions) || input.dimensions.length < 1
      || input.dimensions.length > 20) throw validationError();
    const seen = new Set<string>();
    const dimensions: IveKitRateLimitReservationDimension[] = input.dimensions.map((dimension) => {
      const scope = scopeType(dimension.scope_type);
      const key = requiredText(dimension.key, 2_048);
      const limit = integer(dimension.limit, 1, 1_000_000_000);
      const windowSeconds = integer(dimension.window_seconds, 1, 86_400);
      const cost = integer(dimension.cost ?? 1, 1, limit);
      const scopeKeyHmac = createHmac('sha256', this.#hmacKey)
        .update(`${tenantId}\n${routeGroup}\n${scope}\n${key}`)
        .digest('hex');
      const identity = `${scope}:${scopeKeyHmac}:${windowSeconds}`;
      if (seen.has(identity)) throw validationError();
      seen.add(identity);
      return {
        scope_type: scope,
        scope_key_hmac: scopeKeyHmac,
        limit,
        window_seconds: windowSeconds,
        cost
      };
    });
    const decision = await this.#repository.reserve({
      tenant_id: tenantId,
      route_group: routeGroup,
      dimensions,
      now: this.#now().toISOString()
    });
    observeIveKitRateLimit({
      route_group: routeGroup,
      allowed: decision.allowed,
      denied_scope: decision.denied_scope
    });
    if (!decision.allowed) {
      throw new IveKitRateLimitError(
        integer(decision.retry_after_seconds, 1, 86_400),
        scopeType(decision.denied_scope)
      );
    }
    return decision;
  }
}

export function requiredRateLimitHmacKey(env: NodeJS.ProcessEnv = process.env): string {
  const value = String(resolveFabricEnv(env, 'RATE_LIMIT_HMAC_KEY') || '');
  decodeKey(value);
  return value;
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '')
    !== String(value || '').replace(/=+$/, '')) throw validationError();
  return key;
}

function scopeType(value: unknown) {
  if (!['tenant', 'actor', 'source_ip', 'recipient', 'provider'].includes(String(value))) {
    throw validationError();
  }
  return value as IveKitRateLimitReservationDimension['scope_type'];
}

function route(value: unknown): string {
  const result = requiredText(value, 100);
  if (!/^[a-z0-9_.-]+$/.test(result)) throw validationError();
  return result;
}

function requiredText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw validationError();
  return value.trim();
}

function integer(value: unknown, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw validationError();
  return number;
}

function validationError(): Error {
  return Object.assign(new Error('validation_failed'), { code: 'validation_failed', status: 422 });
}
