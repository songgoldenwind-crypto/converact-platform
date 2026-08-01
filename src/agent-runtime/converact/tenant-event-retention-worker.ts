import { resolveFabricEnv } from '../../config/converact-env.js';
import type { PgQueryable } from '../../db-pg.js';
import {
  ConveractFabricTenantEventStore,
  converactFabricEventReplayEnabled,
  type ConveractFabricTenantEventRetentionSummary
} from './tenant-event-store.js';

export interface ConveractFabricTenantEventRetentionWorkerConfig {
  enabled: boolean;
  interval_ms: number;
  tenant_limit: number;
  batch_size: number;
}

export class ConveractFabricTenantEventRetentionWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<ConveractFabricTenantEventRetentionSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: ConveractFabricTenantEventRetentionWorkerConfig;
    runBatch: () => Promise<ConveractFabricTenantEventRetentionSummary>;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<ConveractFabricTenantEventRetentionSummary> {
    if (this.active) return this.active;
    const running = Promise.resolve().then(() => this.input.runBatch());
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
        .then((summary) => {
          if (summary.deleted > 0) console.log('[converact-event-retention] batch', JSON.stringify(summary));
        })
        .catch((error) => this.input.onError?.(error))
        .finally(() => this.schedule(this.input.config.interval_ms));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function converactFabricTenantEventRetentionWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): ConveractFabricTenantEventRetentionWorkerConfig {
  const enabledValue = String(resolveFabricEnv(env, 'EVENT_RETENTION_WORKER_ENABLED') || '1').trim();
  if (enabledValue !== '0' && enabledValue !== '1') {
    throw new Error('CONVERACT_FABRIC_EVENT_RETENTION_WORKER_ENABLED must be 0 or 1');
  }
  return {
    enabled: converactFabricEventReplayEnabled(env) && enabledValue === '1',
    interval_ms: boundedEnv(resolveFabricEnv(env, 'EVENT_RETENTION_INTERVAL_MS'), 60_000, 10_000, 86_400_000, 'CONVERACT_FABRIC_EVENT_RETENTION_INTERVAL_MS'),
    tenant_limit: boundedEnv(resolveFabricEnv(env, 'EVENT_RETENTION_TENANT_LIMIT'), 100, 1, 1_000, 'CONVERACT_FABRIC_EVENT_RETENTION_TENANT_LIMIT'),
    batch_size: boundedEnv(resolveFabricEnv(env, 'EVENT_RETENTION_BATCH_SIZE'), 1_000, 1, 10_000, 'CONVERACT_FABRIC_EVENT_RETENTION_BATCH_SIZE')
  };
}

export function startConveractFabricTenantEventRetentionWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
}): ConveractFabricTenantEventRetentionWorker {
  const env = input.env || process.env;
  const config = converactFabricTenantEventRetentionWorkerConfig(env);
  const store = config.enabled ? new ConveractFabricTenantEventStore(input.pg, { env }) : null;
  const worker = new ConveractFabricTenantEventRetentionWorker({
    config,
    runBatch: () => store
      ? store.pruneExpired({
        tenant_limit: config.tenant_limit,
        batch_size: config.batch_size
      })
      : Promise.resolve({ tenants: 0, deleted: 0 }),
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[converact-event-retention] worker failed:', message.slice(0, 500));
    }
  });
  worker.start();
  return worker;
}

function boundedEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
