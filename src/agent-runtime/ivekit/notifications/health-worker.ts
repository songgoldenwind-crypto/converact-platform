import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { PgQueryable } from '../../../db-pg.js';
import { NotificationError } from './errors.js';
import type {
  NotificationEndpointHealthRepository,
  NotificationEndpointProbeResult
} from './health-types.js';
import { probeNotificationEndpoint } from './health-probe.js';
import { observeNotificationHealthProbe } from './metrics.js';
import type { NotificationEndpoint } from './types.js';
import type { NotificationSecretResolver } from './ports.js';
import { configuredNotificationSecretResolver } from './secret-resolver.js';
import { PostgresNotificationStore } from './postgres/store.js';

export interface NotificationHealthWorkerConfig {
  enabled: boolean;
  interval_ms: number;
  stale_ms: number;
  lease_ms: number;
  tenant_limit: number;
  batch_size: number;
  concurrency: number;
}

export interface NotificationHealthBatchSummary {
  tenants: number;
  claimed: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  lease_lost: number;
}

export type NotificationEndpointProbe = (
  endpoint: NotificationEndpoint
) => Promise<NotificationEndpointProbeResult>;

export async function runNotificationHealthBatch(input: {
  repository: NotificationEndpointHealthRepository;
  config: NotificationHealthWorkerConfig;
  worker_id: string;
  probe: NotificationEndpointProbe;
  now?: Date;
}): Promise<NotificationHealthBatchSummary> {
  const now = input.now || new Date();
  const staleBefore = new Date(now.getTime() - input.config.stale_ms);
  const tenants = await input.repository.listHealthTenants(
    now, staleBefore, input.config.tenant_limit
  );
  const summary: NotificationHealthBatchSummary = {
    tenants: tenants.length, claimed: 0, healthy: 0, degraded: 0, unhealthy: 0, lease_lost: 0
  };
  for (const tenantId of tenants) {
    const leaseToken = randomBytes(32).toString('base64url');
    const leaseTokenHash = createHash('sha256').update(leaseToken).digest('hex');
    const endpoints = await input.repository.claimHealthEndpoints({
      tenant_id: tenantId,
      worker_id: input.worker_id,
      lease_token_hash: leaseTokenHash,
      now,
      stale_before: staleBefore,
      lease_ms: input.config.lease_ms,
      limit: input.config.batch_size
    });
    summary.claimed += endpoints.length;
    await parallelMap(endpoints, input.config.concurrency, async (endpoint) => {
      const result = await input.probe(endpoint).catch(() => ({
        outcome: 'degraded' as const, code: 'health_probe_failed', latency_ms: 0
      }));
      try {
        await input.repository.finishHealthProbe({
          endpoint,
          worker_id: input.worker_id,
          lease_token_hash: leaseTokenHash,
          result,
          now: new Date()
        });
        summary[result.outcome] += 1;
        observeNotificationHealthProbe({
          channel: endpoint.channel,
          provider: endpoint.provider_kind,
          outcome: result.outcome,
          code: result.code,
          latency_ms: result.latency_ms
        });
      } catch (error) {
        if (error instanceof NotificationError && error.code === 'lease_lost') {
          summary.lease_lost += 1;
          return;
        }
        throw error;
      }
    });
  }
  return summary;
}

export class NotificationHealthWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<NotificationHealthBatchSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: NotificationHealthWorkerConfig;
    runBatch: () => Promise<NotificationHealthBatchSummary>;
    onResult?: (result: NotificationHealthBatchSummary) => void;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<NotificationHealthBatchSummary> {
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

  private schedule(delay: number): void {
    if (this.stopped || !this.input.config.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .then((result) => this.input.onResult?.(result))
        .catch((error) => this.input.onError?.(error))
        .finally(() => this.schedule(this.input.config.interval_ms));
    }, delay);
    this.timer.unref?.();
  }
}

export function notificationHealthWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): NotificationHealthWorkerConfig {
  return {
    enabled: booleanEnv(env.OPC_IVEKIT_NOTIFICATION_HEALTH_WORKER_ENABLED, false),
    interval_ms: integer(env.OPC_IVEKIT_NOTIFICATION_HEALTH_INTERVAL_MS, 60_000, 5_000, 3_600_000),
    stale_ms: integer(env.OPC_IVEKIT_NOTIFICATION_HEALTH_STALE_MS, 300_000, 30_000, 86_400_000),
    lease_ms: integer(env.OPC_IVEKIT_NOTIFICATION_HEALTH_LEASE_MS, 120_000, 30_000, 300_000),
    tenant_limit: integer(env.OPC_IVEKIT_NOTIFICATION_HEALTH_TENANT_LIMIT, 100, 1, 1_000),
    batch_size: integer(env.OPC_IVEKIT_NOTIFICATION_HEALTH_BATCH_SIZE, 25, 1, 200),
    concurrency: integer(env.OPC_IVEKIT_NOTIFICATION_HEALTH_CONCURRENCY, 5, 1, 20)
  };
}

export function startNotificationHealthWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  secrets?: NotificationSecretResolver;
  probe?: NotificationEndpointProbe;
}): NotificationHealthWorker {
  const env = input.env || process.env;
  const config = notificationHealthWorkerConfig(env);
  const repository = new PostgresNotificationStore(input.pg);
  const secrets = input.secrets || configuredNotificationSecretResolver(env);
  const probe = input.probe || ((endpoint) => probeNotificationEndpoint(endpoint, {
    secrets,
    allowControlled: env.OPC_IVEKIT_NOTIFICATION_ALLOW_CONTROLLED === '1'
  }));
  const worker = new NotificationHealthWorker({
    config,
    runBatch: () => runNotificationHealthBatch({
      repository,
      config,
      worker_id: `${hostname()}:${process.pid}:notification-health:${randomUUID()}`,
      probe
    }),
    onResult: (result) => {
      if (result.claimed) console.log('[notification-health] batch', JSON.stringify(result));
    },
    onError: (error) => {
      console.error('[notification-health] worker failed:', safeError(error));
    }
  });
  worker.start();
  return worker;
}

async function parallelMap<T>(
  values: T[],
  concurrency: number,
  action: (value: T) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await action(values[index]);
    }
  }));
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!String(value || '').trim()) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error('notification health worker configuration is invalid');
  }
  return number;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value !== '0' && value !== '1') throw new Error('notification health worker flag is invalid');
  return value === '1';
}

function safeError(error: unknown): string {
  const code = String((error as { code?: unknown }).code || 'worker_failed');
  return /^[a-z0-9_]{1,100}$/.test(code) ? code : 'worker_failed';
}
