import { resolveFabricEnv } from '../../../config/converact-env.js';
import { Gauge } from 'prom-client';

import type { PgQueryable } from '../../../db-pg.js';
import { metricsRegistry } from '../../../metrics.js';

const POOLS = [
  'notification',
  'event-webhook',
  'attachment',
  'quality',
  'translation',
  'file-security'
] as const;

type WorkerPool = typeof POOLS[number];

const backlogDepth = new Gauge({
  name: 'opc_ivekit_worker_backlog_depth',
  help: 'Claimable asynchronous work by fixed iveKit worker pool',
  labelNames: ['pool'],
  registers: [metricsRegistry]
});

const backlogOldestAge = new Gauge({
  name: 'opc_ivekit_worker_backlog_oldest_age_seconds',
  help: 'Age of the oldest claimable item by fixed iveKit worker pool',
  labelNames: ['pool'],
  registers: [metricsRegistry]
});

const observerUp = new Gauge({
  name: 'opc_ivekit_worker_backlog_observer_up',
  help: 'Whether the latest iveKit worker backlog observation succeeded',
  registers: [metricsRegistry]
});

export interface WorkerBacklogMetricsConfig {
  enabled: boolean;
  interval_ms: number;
}

export class WorkerBacklogMetricsObserver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: WorkerBacklogMetricsConfig;
    observe: () => Promise<void>;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<void> {
    if (this.active) return this.active;
    const running = Promise.resolve().then(this.input.observe);
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
        .catch((error) => this.input.onError?.(error))
        .finally(() => this.schedule(this.input.config.interval_ms));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function workerBacklogMetricsConfig(
  env: NodeJS.ProcessEnv = process.env
): WorkerBacklogMetricsConfig {
  const flag = String(resolveFabricEnv(env, 'WORKER_BACKLOG_METRICS_ENABLED') || '0').trim();
  if (flag !== '0' && flag !== '1') {
    throw new Error('CONVERACT_FABRIC_WORKER_BACKLOG_METRICS_ENABLED must be 0 or 1');
  }
  return {
    enabled: flag === '1',
    interval_ms: boundedInteger(
      resolveFabricEnv(env, 'WORKER_BACKLOG_METRICS_INTERVAL_MS'),
      5_000,
      1_000,
      300_000,
      'CONVERACT_FABRIC_WORKER_BACKLOG_METRICS_INTERVAL_MS'
    )
  };
}

export function startIveKitWorkerBacklogMetrics(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
}): WorkerBacklogMetricsObserver {
  const config = workerBacklogMetricsConfig(input.env);
  const observer = new WorkerBacklogMetricsObserver({
    config,
    observe: async () => {
      const result = await input.pg.query<{
        pool: string;
        depth: string | number;
        oldest_age_seconds: string | number;
      }>('SELECT pool, depth, oldest_age_seconds FROM opc_ivekit_worker_backlog_metrics($1)', [
        new Date().toISOString()
      ]);
      const rows = new Map<WorkerPool, { depth: number; oldest_age_seconds: number }>();
      for (const row of result.rows) {
        if (!isWorkerPool(row.pool)) throw new Error('unexpected worker backlog pool');
        rows.set(row.pool, {
          depth: nonNegative(row.depth),
          oldest_age_seconds: nonNegative(row.oldest_age_seconds)
        });
      }
      for (const pool of POOLS) {
        const row = rows.get(pool);
        backlogDepth.labels(pool).set(row?.depth || 0);
        backlogOldestAge.labels(pool).set(row?.oldest_age_seconds || 0);
      }
      observerUp.set(1);
    },
    onError: (error) => {
      observerUp.set(0);
      const message = error instanceof Error ? error.message : String(error);
      console.error('[worker-backlog-metrics] observation failed:', message.slice(0, 500));
    }
  });
  observer.start();
  return observer;
}

function isWorkerPool(value: string): value is WorkerPool {
  return (POOLS as readonly string[]).includes(value);
}

function nonNegative(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function boundedInteger(
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
