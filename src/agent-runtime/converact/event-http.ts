import { createHash, randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { resolveAuthContext } from '../../middleware/auth.js';
import { IveKitTenantEventStore, iveKitEventReplayEnabled } from './tenant-event-store.js';
import { IVEKIT_INTEGRATION_EVENT_CATALOG } from './integration-events/catalog.js';
import type {
  CreateIveKitEventWebhookSubscriptionInput,
  IveKitEventWebhookSubscription,
  IveKitEventWebhookSubscriptionCreateResult,
  IveKitEventWebhookSubscriptionPage,
  UpdateIveKitEventWebhookSubscriptionInput
} from './integration-events/types.js';
import { PostgresIveKitEventWebhookStore } from './integration-events/postgres-store.js';
import { IveKitEventWebhookSubscriptionService } from './integration-events/subscription-service.js';
import { PostgresNotificationStore } from './notifications/postgres/store.js';
import { iveKitCapabilityAllowed } from './authorization.js';
import {
  createPostgresIveKitAuditService,
  type IveKitAuditService
} from './operations/audit/index.js';
import {
  configuredIveKitRateLimiter,
  iveKitRateLimitConfiguration,
  type IveKitRateLimiter
} from './operations/rate-limit/index.js';

export interface IveKitEventHttpModule {
  createSubscription(
    input: CreateIveKitEventWebhookSubscriptionInput
  ): Promise<IveKitEventWebhookSubscriptionCreateResult>;
  getSubscription(tenantId: string, subscriptionId: string): Promise<IveKitEventWebhookSubscription | null>;
  listSubscriptions(input: {
    tenant_id: string;
    status?: IveKitEventWebhookSubscription['status'];
    limit?: number;
    cursor?: string;
  }): Promise<IveKitEventWebhookSubscriptionPage>;
  updateSubscription(input: UpdateIveKitEventWebhookSubscriptionInput): Promise<IveKitEventWebhookSubscription>;
  archiveSubscription(input: {
    tenant_id: string;
    actor: string;
    subscription_id: string;
    expected_revision: number;
  }): Promise<IveKitEventWebhookSubscription>;
}

export interface RouteIveKitEventApiOptions {
  module?: IveKitEventHttpModule;
  env?: NodeJS.ProcessEnv;
  audit?: Pick<IveKitAuditService, 'append'> | null;
  rateLimiter?: Pick<IveKitRateLimiter, 'check'> | null;
}

export async function routeIveKitEventApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  url: URL,
  headers: Record<string, string | string[] | undefined> = {},
  body?: unknown,
  options: RouteIveKitEventApiOptions = {}
): Promise<unknown | undefined> {
  if (path !== '/api/ivekit/events' && !path.startsWith('/api/ivekit/events/')) return undefined;

  const auth = resolveAuthContext(headers);
  if (!auth.authenticated || !auth.tenantId || !auth.userId
    || (auth.role === 'system' && auth.tenantId === 'system')) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }

  if (path === '/api/ivekit/events/catalog' && method === 'GET') {
    return { data: IVEKIT_INTEGRATION_EVENT_CATALOG };
  }

  const root = '/api/ivekit/events/webhook-subscriptions';
  if (path === root || path.startsWith(`${root}/`)) {
    if (!iveKitCapabilityAllowed(auth, 'events.manage')) {
      throw Object.assign(new Error('event subscription administration is forbidden'), { status: 403 });
    }
    const module = options.module || createPostgresIveKitEventHttpModule(requiredPg(pg));
    if (path === root && method === 'GET') {
      const page = await module.listSubscriptions({
        tenant_id: auth.tenantId,
        status: subscriptionStatus(url.searchParams.get('status')),
        limit: queryLimit(url.searchParams.get('limit')),
        cursor: url.searchParams.get('cursor') || undefined
      });
      return { data: { ...page, items: page.items.map(projectSubscription) } };
    }
    if (path === root && method === 'POST') {
      const input = record(body);
      await checkSubscriptionMutationRateLimit(pg, headers, options, auth.tenantId, auth.userId);
      const result = await module.createSubscription({
        tenant_id: auth.tenantId,
        actor: auth.userId,
        endpoint_id: requiredString(input.endpoint_id, 255),
        name: requiredString(input.name, 255),
        event_patterns: stringArray(input.event_patterns),
        idempotency_key: requireIdempotencyKey(headers)
      });
      await appendSubscriptionAudit(pg, headers, options, {
        tenant_id: auth.tenantId,
        actor_id: auth.userId,
        actor_role: auth.role,
        action: 'event.webhook_subscription.create',
        subscription: result.subscription,
        metadata: { created: result.created }
      });
      return {
        status: result.created ? 201 : 200,
        data: { created: result.created, subscription: projectSubscription(result.subscription) }
      };
    }
    const archiveMatch = path.match(/^\/api\/ivekit\/events\/webhook-subscriptions\/([^/]+)\/archive$/);
    if (archiveMatch && method === 'POST') {
      requireIdempotencyKey(headers);
      const input = record(body);
      await checkSubscriptionMutationRateLimit(pg, headers, options, auth.tenantId, auth.userId);
      const result = await module.archiveSubscription({
        tenant_id: auth.tenantId,
        actor: auth.userId,
        subscription_id: decodeSegment(archiveMatch[1]),
        expected_revision: requiredInteger(input.expected_revision)
      });
      await appendSubscriptionAudit(pg, headers, options, {
        tenant_id: auth.tenantId,
        actor_id: auth.userId,
        actor_role: auth.role,
        action: 'event.webhook_subscription.archive',
        subscription: result
      });
      return { data: { subscription: projectSubscription(result) } };
    }
    const itemMatch = path.match(/^\/api\/ivekit\/events\/webhook-subscriptions\/([^/]+)$/);
    if (itemMatch && method === 'GET') {
      const result = await module.getSubscription(auth.tenantId, decodeSegment(itemMatch[1]));
      if (!result) throw Object.assign(new Error('event webhook subscription not found'), { status: 404 });
      return { data: { subscription: projectSubscription(result) } };
    }
    if (itemMatch && method === 'PUT') {
      requireIdempotencyKey(headers);
      const input = record(body);
      await checkSubscriptionMutationRateLimit(pg, headers, options, auth.tenantId, auth.userId);
      const result = await module.updateSubscription({
        tenant_id: auth.tenantId,
        actor: auth.userId,
        subscription_id: decodeSegment(itemMatch[1]),
        expected_revision: requiredInteger(input.expected_revision),
        patch: {
          ...(input.name === undefined ? {} : { name: requiredString(input.name, 255) }),
          ...(input.event_patterns === undefined ? {} : { event_patterns: stringArray(input.event_patterns) }),
          ...(input.status === undefined ? {} : { status: mutableSubscriptionStatus(input.status) })
        }
      });
      await appendSubscriptionAudit(pg, headers, options, {
        tenant_id: auth.tenantId,
        actor_id: auth.userId,
        actor_role: auth.role,
        action: 'event.webhook_subscription.update',
        subscription: result
      });
      return { data: { subscription: projectSubscription(result) } };
    }
    return undefined;
  }

  if (path !== '/api/ivekit/events' || method !== 'GET') return undefined;
  if (!iveKitEventReplayEnabled()) {
    throw Object.assign(new Error('durable event replay is disabled'), { status: 503 });
  }
  if (!pg) throw Object.assign(new Error('PostgreSQL is required'), { status: 503 });

  const store = new IveKitTenantEventStore(pg);
  const cursor = String(url.searchParams.get('cursor') || '').trim();
  if (!cursor) {
    return {
      data: {
        items: [],
        next_cursor: await store.headCursor(auth.tenantId),
        has_more: false,
        snapshot_required: false
      }
    };
  }

  const page = await store.list({
    tenant_id: auth.tenantId,
    user_id: auth.userId,
    role: auth.role,
    cursor,
    limit: queryLimit(url.searchParams.get('limit'))
  });
  return page.snapshot_required ? { status: 409, data: page } : { data: page };
}

export function createPostgresIveKitEventHttpModule(pg: PgQueryable): IveKitEventHttpModule {
  const repository = new PostgresIveKitEventWebhookStore(pg);
  const service = new IveKitEventWebhookSubscriptionService({
    repository,
    endpoints: new PostgresNotificationStore(pg)
  });
  return {
    createSubscription: (input) => service.create(input),
    getSubscription: (tenantId, subscriptionId) => service.get(tenantId, subscriptionId),
    listSubscriptions: (input) => service.list(input),
    updateSubscription: (input) => service.update(input),
    archiveSubscription: (input) => service.archive(input)
  };
}

function queryLimit(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw Object.assign(new Error('limit must be between 1 and 200'), { status: 400 });
  }
  return parsed;
}

function projectSubscription(value: IveKitEventWebhookSubscription): Record<string, unknown> {
  return {
    id: value.id,
    endpoint_id: value.endpoint_id,
    name: value.name,
    event_patterns: value.event_patterns,
    status: value.status,
    last_event_id: value.last_event_id,
    next_attempt_at: value.next_attempt_at,
    attempt_count: value.attempt_count,
    error_code: value.error_code,
    revision: value.revision,
    created_by: value.created_by,
    updated_by: value.updated_by,
    created_at: value.created_at,
    updated_at: value.updated_at
  };
}

function requiredPg(pg: PgQueryable | null): PgQueryable {
  if (!pg) throw Object.assign(new Error('PostgreSQL is required'), { status: 503 });
  return pg;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('JSON object body is required'), { status: 400 });
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, max: number): string {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw Object.assign(new Error('request value is invalid'), { status: 422 });
  return text;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw Object.assign(new Error('event_patterns must be a string array'), { status: 422 });
  }
  return value.map(String);
}

function requiredInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw Object.assign(new Error('request integer is invalid'), { status: 422 });
  }
  return parsed;
}

function subscriptionStatus(value: string | null): IveKitEventWebhookSubscription['status'] | undefined {
  if (!value) return undefined;
  if (!['active', 'paused', 'archived'].includes(value)) {
    throw Object.assign(new Error('subscription status is invalid'), { status: 422 });
  }
  return value as IveKitEventWebhookSubscription['status'];
}

function mutableSubscriptionStatus(value: unknown): 'active' | 'paused' {
  if (value !== 'active' && value !== 'paused') {
    throw Object.assign(new Error('subscription status is invalid'), { status: 422 });
  }
  return value;
}

function requireIdempotencyKey(headers: Record<string, string | string[] | undefined>): string {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === 'idempotency-key');
  const value = Array.isArray(found?.[1]) ? found?.[1][0] : found?.[1];
  return requiredString(value, 128);
}

function decodeSegment(value: string): string {
  try {
    return requiredString(decodeURIComponent(value), 255);
  } catch {
    throw Object.assign(new Error('path segment is invalid'), { status: 400 });
  }
}

async function checkSubscriptionMutationRateLimit(
  pg: PgQueryable | null,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitEventApiOptions,
  tenantId: string,
  actorId: string
): Promise<void> {
  const config = iveKitRateLimitConfiguration(options.env);
  if (!config.enabled || options.rateLimiter === null) return;
  const limiter = options.rateLimiter || (pg ? configuredIveKitRateLimiter(pg, options.env) : null);
  if (!limiter) return;
  await limiter.check({
    tenant_id: tenantId,
    route_group: 'event.webhook_subscription.mutate',
    dimensions: [
      {
        scope_type: 'tenant', key: tenantId,
        limit: config.event_webhook_mutation.tenant_per_minute, window_seconds: 60
      },
      {
        scope_type: 'actor', key: actorId,
        limit: config.event_webhook_mutation.actor_per_minute, window_seconds: 60
      },
      {
        scope_type: 'source_ip', key: headerValue(headers, 'x-opc-source-ip') || 'unknown',
        limit: config.event_webhook_mutation.source_ip_per_minute, window_seconds: 60
      }
    ]
  });
}

async function appendSubscriptionAudit(
  pg: PgQueryable | null,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitEventApiOptions,
  input: {
    tenant_id: string;
    actor_id: string;
    actor_role: 'owner' | 'admin' | 'operator' | 'viewer' | 'system';
    action: string;
    subscription: IveKitEventWebhookSubscription;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const audit = options.audit === undefined
    ? (pg ? createPostgresIveKitAuditService(pg, options.env) : null)
    : options.audit;
  if (!audit) return;
  const requestId = safeRequestId(headers);
  await audit.append({
    tenant_id: input.tenant_id,
    actor_id: input.actor_id,
    actor_role: input.actor_role,
    action: input.action,
    resource_type: 'ivekit_event_webhook_subscription',
    resource_id: input.subscription.id,
    business_ref: { type: 'ivekit_event_webhook_subscription', id: input.subscription.id },
    request_id: requestId,
    idempotency_key: createHash('sha256').update([
      input.tenant_id, requestId, input.action, input.subscription.id
    ].join('\n')).digest('hex'),
    result: 'succeeded',
    policy_decision: 'allow',
    source_ip: headerValue(headers, 'x-opc-source-ip') || undefined,
    metadata: {
      endpoint_id: input.subscription.endpoint_id,
      event_patterns: input.subscription.event_patterns,
      status: input.subscription.status,
      revision: input.subscription.revision,
      ...input.metadata
    }
  });
}

function safeRequestId(headers: Record<string, string | string[] | undefined>): string {
  const value = headerValue(headers, 'x-opc-request-id') || headerValue(headers, 'x-request-id');
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : randomUUID();
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string {
  const found = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return String(Array.isArray(found?.[1]) ? found?.[1][0] : found?.[1] || '');
}
