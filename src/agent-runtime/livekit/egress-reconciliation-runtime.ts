import { EgressClient } from 'livekit-server-sdk';

import type { PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { isLiveKitConfigured, readLiveKitConfig, type LiveKitConfig } from './config.js';
import {
  LiveKitEgressReconciliationWorker,
  PostgresLiveKitEgressReconciliationStore,
  type LiveKitEgressProviderInfo,
  type LiveKitEgressReconciliationJob,
  type LiveKitEgressReconciliationProvider,
  type LiveKitEgressReconciliationRunResult
} from './egress-reconciliation-worker.js';

export interface LiveKitEgressReconciliationConfig {
  enabled: boolean;
  interval_ms: number;
  batch_size: number;
  tenant_limit: number;
  lease_ms: number;
  stale_ms: number;
  retry_base_ms: number;
  retry_max_ms: number;
  max_missing_observations: number;
}

export interface LiveKitEgressReconciliationBatchSummary extends LiveKitEgressReconciliationRunResult {
  tenants: number;
}

export class ConfiguredLiveKitEgressReconciliationProvider implements LiveKitEgressReconciliationProvider {
  constructor(private readonly input: {
    config?: LiveKitConfig;
    resolveConfig?: (
      job: LiveKitEgressReconciliationJob,
      base: LiveKitConfig
    ) => LiveKitConfig | Promise<LiveKitConfig>;
    createClient?: (config: LiveKitConfig) => Pick<EgressClient, 'listEgress'>;
  } = {}) {}

  async listEgress(job: LiveKitEgressReconciliationJob): Promise<LiveKitEgressProviderInfo[]> {
    const base = this.input.config || readLiveKitConfig();
    const config = await this.input.resolveConfig?.(job, base) || base;
    if (!isLiveKitConfigured(config)) throw new Error('LiveKit Egress reconciliation is not configured');
    const client = this.input.createClient?.(config) || new EgressClient(
      toHttpUrl(config.url!),
      config.apiKey!,
      config.apiSecret!
    );
    const items = await client.listEgress({ egressId: job.egress_id });
    return items.map((info) => ({
      egressId: info.egressId,
      status: info.status,
      error: info.error,
      errorCode: info.errorCode,
      fileResults: info.fileResults.map((file) => ({
        location: file.location,
        duration: file.duration,
        size: file.size
      }))
    }));
  }
}

export async function runLiveKitEgressReconciliationBatch(input: {
  pg: PgQueryable;
  worker_id: string;
  config: LiveKitEgressReconciliationConfig;
  provider?: LiveKitEgressReconciliationProvider;
  now?: Date;
}): Promise<LiveKitEgressReconciliationBatchSummary> {
  const now = input.now || new Date();
  const staleBefore = new Date(now.getTime() - input.config.stale_ms);
  const tenants = await input.pg.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM opc_livekit_egress_reconciliation_tenant_ids($1, $2, $3)',
    [now.toISOString(), staleBefore.toISOString(), input.config.tenant_limit]
  );
  const summary: LiveKitEgressReconciliationBatchSummary = {
    tenants: tenants.rows.length,
    claimed: 0,
    completed: 0,
    failed: 0,
    active: 0,
    missing: 0,
    provider_errors: 0,
    stale: 0
  };
  const provider = input.provider || new ConfiguredLiveKitEgressReconciliationProvider();
  for (const row of tenants.rows) {
    const tenantId = String(row.tenant_id || '').trim();
    if (!tenantId) continue;
    const result = await withPgTenant(input.pg, tenantId, async (tenantPg) => {
      const worker = new LiveKitEgressReconciliationWorker({
        store: new PostgresLiveKitEgressReconciliationStore(tenantPg),
        provider,
        worker_id: input.worker_id,
        batch_size: input.config.batch_size,
        lease_ms: input.config.lease_ms,
        stale_ms: input.config.stale_ms,
        retry_base_ms: input.config.retry_base_ms,
        retry_max_ms: input.config.retry_max_ms,
        max_missing_observations: input.config.max_missing_observations,
        now: () => now
      });
      return worker.runOnce(tenantId);
    });
    addSummary(summary, result);
  }
  return summary;
}

export class LiveKitEgressReconciliationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<LiveKitEgressReconciliationBatchSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: LiveKitEgressReconciliationConfig;
    runBatch: () => Promise<LiveKitEgressReconciliationBatchSummary>;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<LiveKitEgressReconciliationBatchSummary> {
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
    await this.active?.catch(() => undefined);
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

export function liveKitEgressReconciliationConfig(
  env: NodeJS.ProcessEnv = process.env
): LiveKitEgressReconciliationConfig {
  const enabled = booleanFlag(env.OPC_LIVEKIT_EGRESS_RECONCILIATION_ENABLED, false,
    'OPC_LIVEKIT_EGRESS_RECONCILIATION_ENABLED');
  const retryBaseMs = boundedEnv(env.OPC_LIVEKIT_EGRESS_RECONCILIATION_RETRY_BASE_MS,
    5_000, 100, 60 * 60_000, 'OPC_LIVEKIT_EGRESS_RECONCILIATION_RETRY_BASE_MS');
  return {
    enabled,
    interval_ms: boundedEnv(env.OPC_LIVEKIT_EGRESS_RECONCILIATION_INTERVAL_MS,
      10_000, 1_000, 60 * 60_000, 'OPC_LIVEKIT_EGRESS_RECONCILIATION_INTERVAL_MS'),
    batch_size: boundedEnv(env.OPC_LIVEKIT_EGRESS_RECONCILIATION_BATCH_SIZE,
      25, 1, 200, 'OPC_LIVEKIT_EGRESS_RECONCILIATION_BATCH_SIZE'),
    tenant_limit: boundedEnv(env.OPC_LIVEKIT_EGRESS_RECONCILIATION_TENANT_LIMIT,
      100, 1, 1_000, 'OPC_LIVEKIT_EGRESS_RECONCILIATION_TENANT_LIMIT'),
    lease_ms: boundedEnv(env.OPC_LIVEKIT_EGRESS_RECONCILIATION_LEASE_MS,
      30_000, 1_000, 15 * 60_000, 'OPC_LIVEKIT_EGRESS_RECONCILIATION_LEASE_MS'),
    stale_ms: boundedEnv(env.OPC_LIVEKIT_EGRESS_RECONCILIATION_STALE_MS,
      30_000, 1_000, 24 * 60 * 60_000, 'OPC_LIVEKIT_EGRESS_RECONCILIATION_STALE_MS'),
    retry_base_ms: retryBaseMs,
    retry_max_ms: boundedEnv(env.OPC_LIVEKIT_EGRESS_RECONCILIATION_RETRY_MAX_MS,
      5 * 60_000, retryBaseMs, 24 * 60 * 60_000, 'OPC_LIVEKIT_EGRESS_RECONCILIATION_RETRY_MAX_MS'),
    max_missing_observations: boundedEnv(env.OPC_LIVEKIT_EGRESS_RECONCILIATION_MAX_MISSING,
      2, 2, 10, 'OPC_LIVEKIT_EGRESS_RECONCILIATION_MAX_MISSING')
  };
}

export function startLiveKitEgressReconciliationWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  worker_id?: string;
  provider?: LiveKitEgressReconciliationProvider;
}): LiveKitEgressReconciliationScheduler {
  const env = input.env || process.env;
  const config = liveKitEgressReconciliationConfig(env);
  const workerId = String(input.worker_id || env.OPC_IVEKIT_INSTANCE_ID || env.HOSTNAME || `ivekit-${process.pid}`);
  const scheduler = new LiveKitEgressReconciliationScheduler({
    config,
    runBatch: () => runLiveKitEgressReconciliationBatch({
      pg: input.pg,
      worker_id: workerId,
      config,
      provider: input.provider
    }),
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[livekit-egress-reconciliation] worker failed:', message.slice(0, 500));
    }
  });
  scheduler.start();
  return scheduler;
}

function addSummary(
  target: LiveKitEgressReconciliationBatchSummary,
  source: LiveKitEgressReconciliationRunResult
): void {
  target.claimed += source.claimed;
  target.completed += source.completed;
  target.failed += source.failed;
  target.active += source.active;
  target.missing += source.missing;
  target.provider_errors += source.provider_errors;
  target.stale += source.stale;
}

function toHttpUrl(url: string): string {
  if (url.startsWith('wss://')) return `https://${url.slice(6)}`;
  if (url.startsWith('ws://')) return `http://${url.slice(5)}`;
  return url;
}

function booleanFlag(value: string | undefined, fallback: boolean, field: string): boolean {
  if (!String(value || '').trim()) return fallback;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${field} must be 0 or 1`);
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
