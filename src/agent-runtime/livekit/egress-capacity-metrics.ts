import { resolveBrandEnv } from '../../config/converact-env.js';
import { Counter, Gauge } from 'prom-client';

import type { PgQueryable } from '../../db-pg.js';
import { metricsRegistry } from '../../metrics.js';

export interface LiveKitEgressCapacityMetricsConfig {
  enabled: boolean;
  interval_ms: number;
}

interface CapacityMetricRow {
  pool: string;
  pending_jobs: string | number;
  active_jobs: string | number;
  stopping_jobs: string | number;
  oldest_pending_age_seconds: string | number;
}

const pendingJobs = new Gauge({
  name: 'ivekit_livekit_egress_pending_jobs',
  help: 'LiveKit Egress jobs waiting for provider assignment by execution pool.',
  labelNames: ['pool'] as const,
  registers: [metricsRegistry]
});

const activeJobs = new Gauge({
  name: 'ivekit_livekit_egress_active_jobs',
  help: 'LiveKit Egress provider jobs currently recording by execution pool.',
  labelNames: ['pool'] as const,
  registers: [metricsRegistry]
});

const stoppingJobs = new Gauge({
  name: 'ivekit_livekit_egress_stopping_jobs',
  help: 'LiveKit Egress provider jobs waiting for terminal confirmation by execution pool.',
  labelNames: ['pool'] as const,
  registers: [metricsRegistry]
});

const oldestPendingAge = new Gauge({
  name: 'ivekit_livekit_egress_oldest_pending_age_seconds',
  help: 'Age of the oldest pending LiveKit Egress job by execution pool.',
  labelNames: ['pool'] as const,
  registers: [metricsRegistry]
});

const lastRefresh = new Gauge({
  name: 'ivekit_livekit_egress_capacity_metrics_last_refresh_timestamp_seconds',
  help: 'Unix timestamp of the last successful LiveKit Egress capacity metrics refresh.',
  registers: [metricsRegistry]
});

const refreshFailures = new Counter({
  name: 'ivekit_livekit_egress_capacity_metrics_refresh_failures_total',
  help: 'Total failed LiveKit Egress capacity metrics refreshes.',
  registers: [metricsRegistry]
});

export async function refreshLiveKitEgressCapacityMetrics(
  pg: PgQueryable,
  now = new Date()
): Promise<void> {
  const result = await pg.query<CapacityMetricRow>(
    'SELECT * FROM opc_livekit_egress_capacity_metrics($1)',
    [now.toISOString()]
  );
  const rows = new Map(result.rows.map((row) => [checkedPool(row.pool), row]));
  for (const pool of ['track', 'composite'] as const) {
    const row = rows.get(pool);
    pendingJobs.set({ pool }, metricValue(row?.pending_jobs));
    activeJobs.set({ pool }, metricValue(row?.active_jobs));
    stoppingJobs.set({ pool }, metricValue(row?.stopping_jobs));
    oldestPendingAge.set({ pool }, metricValue(row?.oldest_pending_age_seconds));
  }
  lastRefresh.set(now.getTime() / 1000);
}

export class LiveKitEgressCapacityMetricsScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: LiveKitEgressCapacityMetricsConfig;
    refresh: () => Promise<void>;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<void> {
    if (this.active) return this.active;
    const running = Promise.resolve().then(() => this.input.refresh());
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
    await this.active?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.input.config.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .catch((error) => {
          refreshFailures.inc();
          this.input.onError?.(error);
        })
        .finally(() => this.schedule(this.input.config.interval_ms));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function liveKitEgressCapacityMetricsConfig(
  env: NodeJS.ProcessEnv = process.env
): LiveKitEgressCapacityMetricsConfig {
  return {
    enabled: booleanFlag(
      resolveBrandEnv(env, 'LIVEKIT_EGRESS_CAPACITY_METRICS_ENABLED'),
      false,
      'CONVERACT_LIVEKIT_EGRESS_CAPACITY_METRICS_ENABLED'
    ),
    interval_ms: boundedInteger(
      resolveBrandEnv(env, 'LIVEKIT_EGRESS_CAPACITY_METRICS_INTERVAL_MS'),
      5_000,
      1_000,
      60_000,
      'CONVERACT_LIVEKIT_EGRESS_CAPACITY_METRICS_INTERVAL_MS'
    )
  };
}

export function startLiveKitEgressCapacityMetricsWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
}): LiveKitEgressCapacityMetricsScheduler {
  const config = liveKitEgressCapacityMetricsConfig(input.env || process.env);
  const scheduler = new LiveKitEgressCapacityMetricsScheduler({
    config,
    refresh: () => refreshLiveKitEgressCapacityMetrics(input.pg),
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[livekit-egress-capacity-metrics] refresh failed:', message.slice(0, 500));
    }
  });
  scheduler.start();
  return scheduler;
}

function checkedPool(value: string): 'track' | 'composite' {
  if (value === 'track' || value === 'composite') return value;
  throw new Error(`unsupported LiveKit Egress capacity metrics pool: ${value}`);
}

function metricValue(value: string | number | undefined): number {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('invalid LiveKit Egress capacity metric value');
  }
  return parsed;
}

function booleanFlag(value: string | undefined, fallback: boolean, field: string): boolean {
  if (!String(value || '').trim()) return fallback;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${field} must be 0 or 1`);
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
