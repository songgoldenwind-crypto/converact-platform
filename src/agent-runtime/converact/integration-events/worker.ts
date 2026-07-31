import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { PgQueryable } from '../../../db-pg.js';
import { matchesIveKitEventPattern } from './catalog.js';
import { PostgresIveKitEventWebhookStore } from './postgres-store.js';
import type {
  IveKitEventWebhookSubscription,
  IveKitIntegrationEventEnvelope,
  IveKitStoredIntegrationEvent
} from './types.js';
import { notificationDeliveryWorkerConfig } from '../notifications/runtime.js';
import { PostgresNotificationStore } from '../notifications/postgres/store.js';
import { configuredNotificationProtector } from '../notifications/protector.js';
import { NotificationService } from '../notifications/service.js';
import {
  observeIveKitEventWebhookBatch,
  observeIveKitEventWebhookWorkerError
} from './metrics.js';

export interface IveKitEventWebhookWorkerConfig {
  enabled: boolean;
  interval_ms: number;
  tenant_limit: number;
  subscription_limit: number;
  event_batch_size: number;
  lease_ms: number;
  retry_delays_ms: number[];
}

export interface IveKitEventWebhookBatchSummary {
  tenants: number;
  claimed: number;
  scanned: number;
  projected: number;
  filtered: number;
  failed: number;
  lease_lost: number;
  oldest_event_age_seconds: number;
}

export interface IveKitEventWebhookWorkerRepository {
  listWorkerTenants(now: Date, limit: number): Promise<string[]>;
  claimDue(input: {
    tenant_id: string;
    worker_id: string;
    lease_token_hash: string;
    now: Date;
    lease_ms: number;
    limit: number;
  }): Promise<IveKitEventWebhookSubscription[]>;
  listEvents(
    tenantId: string,
    afterEventId: string,
    now: Date,
    limit: number
  ): Promise<IveKitStoredIntegrationEvent[]>;
  completeClaim(input: {
    tenant_id: string;
    subscription_id: string;
    worker_id: string;
    lease_token_hash: string;
    last_event_id: string;
    now: Date;
  }): Promise<IveKitEventWebhookSubscription>;
  failClaim(input: {
    tenant_id: string;
    subscription_id: string;
    worker_id: string;
    lease_token_hash: string;
    error_code: string;
    retry_at: Date;
    now: Date;
  }): Promise<IveKitEventWebhookSubscription>;
}

export async function runIveKitEventWebhookBatch(input: {
  repository: IveKitEventWebhookWorkerRepository;
  config: IveKitEventWebhookWorkerConfig;
  worker_id: string;
  project: (
    subscription: IveKitEventWebhookSubscription,
    event: IveKitStoredIntegrationEvent
  ) => Promise<void>;
  now?: Date;
}): Promise<IveKitEventWebhookBatchSummary> {
  const now = input.now || new Date();
  const tenants = await input.repository.listWorkerTenants(now, input.config.tenant_limit);
  const summary: IveKitEventWebhookBatchSummary = {
    tenants: tenants.length, claimed: 0, scanned: 0, projected: 0,
    filtered: 0, failed: 0, lease_lost: 0, oldest_event_age_seconds: 0
  };
  for (const tenantId of tenants) {
    const leaseTokenHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    const claims = await input.repository.claimDue({
      tenant_id: tenantId,
      worker_id: input.worker_id,
      lease_token_hash: leaseTokenHash,
      now,
      lease_ms: input.config.lease_ms,
      limit: input.config.subscription_limit
    });
    summary.claimed += claims.length;
    for (const claim of claims) {
      try {
        const events = await input.repository.listEvents(
          tenantId, claim.last_event_id, now, input.config.event_batch_size
        );
        let lastEventId = claim.last_event_id;
        for (const event of events) {
          summary.scanned += 1;
          summary.oldest_event_age_seconds = Math.max(
            summary.oldest_event_age_seconds,
            eventAgeSeconds(event.occurred_at, now)
          );
          lastEventId = event.id;
          if (!matchesIveKitEventPattern(event.event_type, claim.event_patterns)) {
            summary.filtered += 1;
            continue;
          }
          await input.project(claim, event);
          summary.projected += 1;
        }
        await input.repository.completeClaim({
          tenant_id: tenantId,
          subscription_id: claim.id,
          worker_id: input.worker_id,
          lease_token_hash: leaseTokenHash,
          last_event_id: lastEventId,
          now: new Date(now.getTime())
        });
      } catch (error) {
        if (isLeaseLost(error)) {
          summary.lease_lost += 1;
          continue;
        }
        summary.failed += 1;
        const delay = input.config.retry_delays_ms[Math.min(
          Math.max(claim.attempt_count - 1, 0), input.config.retry_delays_ms.length - 1
        )];
        try {
          await input.repository.failClaim({
            tenant_id: tenantId,
            subscription_id: claim.id,
            worker_id: input.worker_id,
            lease_token_hash: leaseTokenHash,
            error_code: safeErrorCode(error),
            retry_at: new Date(now.getTime() + delay),
            now: new Date(now.getTime())
          });
        } catch (failure) {
          if (isLeaseLost(failure)) summary.lease_lost += 1;
          else throw failure;
        }
      }
    }
  }
  return summary;
}

export function projectIveKitIntegrationEvent(
  event: IveKitStoredIntegrationEvent
): IveKitIntegrationEventEnvelope {
  return {
    schema_version: 1,
    event_id: event.id,
    event_type: event.event_type,
    tenant_id: event.tenant_id,
    occurred_at: event.occurred_at,
    business_ref: businessRef(event.payload),
    visibility: {
      scope: event.visibility_scope,
      ref_id: event.visibility_ref_id,
      audience_user_ids: [...event.audience_user_ids]
    },
    data: event.payload
  };
}

export function integrationEventWebhookWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): IveKitEventWebhookWorkerConfig {
  const flag = booleanEnv(env.OPC_IVEKIT_EVENT_WEBHOOK_WORKER_ENABLED, false);
  if (flag && !notificationDeliveryWorkerConfig(env).enabled) {
    throw new Error('event webhook worker requires the notification delivery runtime');
  }
  return {
    enabled: flag,
    interval_ms: integer(env.OPC_IVEKIT_EVENT_WEBHOOK_INTERVAL_MS, 5_000, 1_000, 300_000),
    tenant_limit: integer(env.OPC_IVEKIT_EVENT_WEBHOOK_TENANT_LIMIT, 100, 1, 1_000),
    subscription_limit: integer(env.OPC_IVEKIT_EVENT_WEBHOOK_SUBSCRIPTION_LIMIT, 25, 1, 200),
    event_batch_size: integer(env.OPC_IVEKIT_EVENT_WEBHOOK_EVENT_BATCH_SIZE, 100, 1, 500),
    lease_ms: integer(env.OPC_IVEKIT_EVENT_WEBHOOK_LEASE_MS, 120_000, 5_000, 900_000),
    retry_delays_ms: delays(env.OPC_IVEKIT_EVENT_WEBHOOK_RETRY_DELAYS_MS)
  };
}

export class IveKitEventWebhookWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<IveKitEventWebhookBatchSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: IveKitEventWebhookWorkerConfig;
    runBatch: () => Promise<IveKitEventWebhookBatchSummary>;
    onResult?: (result: IveKitEventWebhookBatchSummary) => void;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<IveKitEventWebhookBatchSummary> {
    if (this.active) return this.active;
    const running = Promise.resolve().then(this.input.runBatch);
    const wrapped = running.finally(() => {
      if (this.active === wrapped) this.active = null;
    });
    this.active = wrapped;
    return wrapped;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) await this.active.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.input.config.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .then((result) => this.input.onResult?.(result))
        .catch((error) => this.input.onError?.(error))
        .finally(() => this.schedule(this.input.config.interval_ms));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function startIveKitEventWebhookWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
}): IveKitEventWebhookWorker {
  const env = input.env || process.env;
  const config = integrationEventWebhookWorkerConfig(env);
  const subscriptions = new PostgresIveKitEventWebhookStore(input.pg);
  const notifications = new PostgresNotificationStore(input.pg);
  const service = new NotificationService({
    repository: notifications,
    protector: configuredNotificationProtector(env)
  });
  const workerId = `${hostname()}:${process.pid}:event-webhook:${randomUUID()}`;
  const worker = new IveKitEventWebhookWorker({
    config,
    runBatch: () => runIveKitEventWebhookBatch({
      repository: subscriptions,
      config,
      worker_id: workerId,
      project: async (subscription, event) => {
        const endpoint = await notifications.getEndpoint(event.tenant_id, subscription.endpoint_id);
        if (!endpoint || endpoint.status !== 'active' || endpoint.channel !== 'webhook'
          || endpoint.provider_kind !== 'webhook') {
          throw Object.assign(new Error('event webhook endpoint unavailable'), {
            code: 'endpoint_unavailable'
          });
        }
        const envelope = projectIveKitIntegrationEvent(event);
        await service.create({
          tenant_id: event.tenant_id,
          event_type: event.event_type,
          recipient: { kind: 'endpoint', ref: endpoint.id },
          targets: [{ channel: 'webhook', recipient: endpoint.endpoint_url, endpoint_id: endpoint.id }],
          content: envelope,
          content_projection: {
            schema_version: 1,
            event_id: event.id,
            event_type: event.event_type,
            subscription_id: subscription.id
          },
          business_ref: envelope.business_ref || { type: 'ivekit_event', id: event.id },
          requested_by: 'ivekit:event-webhook-worker',
          correlation_id: `tenant-event:${event.id}`,
          idempotency_key: eventWebhookIdempotencyKey(subscription.id, event.id),
          policy: { integration_event_webhook: true, subscription_id: subscription.id },
          retention_until: event.expires_at
        });
      }
    }),
    onResult: (result) => {
      observeIveKitEventWebhookBatch(result);
      if (result.claimed) console.log('[event-webhook] batch', JSON.stringify(result));
    },
    onError: (error) => {
      observeIveKitEventWebhookWorkerError();
      console.error('[event-webhook] worker failed:', safeErrorCode(error));
    }
  });
  worker.start();
  return worker;
}

function eventWebhookIdempotencyKey(subscriptionId: string, eventId: string): string {
  return `event_hook_${createHash('sha256').update(`${subscriptionId}\0${eventId}`).digest('hex')}`;
}

function businessRef(value: unknown): { type: string; id: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).business_ref;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = String((raw as Record<string, unknown>).type || '').trim();
  const id = String((raw as Record<string, unknown>).id || '').trim();
  if (!type || type.length > 100 || !id || id.length > 255) return null;
  return { type, id };
}

function safeErrorCode(error: unknown): string {
  const code = String((error as { code?: unknown }).code || 'worker_failed');
  return /^[a-z0-9_]{1,100}$/.test(code) ? code : 'worker_failed';
}

function isLeaseLost(error: unknown): boolean {
  return Number((error as { status?: unknown }).status) === 409
    && /lease lost/i.test(String((error as Error)?.message || ''));
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value !== '0' && value !== '1') throw new Error('event webhook worker flag is invalid');
  return value === '1';
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error('event webhook worker configuration is invalid');
  }
  return parsed;
}

function delays(value: string | undefined): number[] {
  if (!String(value || '').trim()) return [5_000, 30_000, 120_000, 600_000];
  const parsed = String(value).split(',').map(Number);
  if (!parsed.length || parsed.length > 10
    || parsed.some((delay) => !Number.isInteger(delay) || delay < 1_000 || delay > 86_400_000)) {
    throw new Error('event webhook retry delays are invalid');
  }
  return parsed;
}

function eventAgeSeconds(occurredAt: string, now: Date): number {
  const occurred = Date.parse(occurredAt);
  return Number.isFinite(occurred) ? Math.max(0, (now.getTime() - occurred) / 1_000) : 0;
}
