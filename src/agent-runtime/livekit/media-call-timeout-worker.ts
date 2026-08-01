import { resolveBrandEnv } from '../../config/converact-env.js';
import type { PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { MediaCallService } from './media-call-service.js';
import type { MediaCallPlacementPort } from './media-call-service.js';
import { MediaCallStore } from './media-call-store.js';
import type { ConveractFabricMediaCallSnapshot } from './types.js';

export interface MediaCallTimeoutWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  tenantLimit: number;
}

export interface MediaCallTimeoutRunSummary {
  tenants: number;
  scanned: number;
  timed_out: number;
  skipped: number;
}

export class MediaCallTimeoutWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<MediaCallTimeoutRunSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: MediaCallTimeoutWorkerConfig;
    runBatch: () => Promise<MediaCallTimeoutRunSummary>;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<MediaCallTimeoutRunSummary> {
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
        .catch((error) => this.input.onError?.(error))
        .finally(() => this.schedule(this.input.config.intervalMs));
    }, delayMs);
    this.timer.unref?.();
  }
}

export async function runMediaCallTimeoutBatch(input: {
  pg: PgQueryable;
  now?: Date;
  tenantLimit: number;
  batchSize: number;
  onTimedOut?: (snapshot: ConveractFabricMediaCallSnapshot) => void | Promise<void>;
  placement?: MediaCallPlacementPort;
  placementWorkerId?: string;
}): Promise<MediaCallTimeoutRunSummary> {
  const now = input.now || new Date();
  const tenants = await input.pg.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM opc_worker_tenant_ids($1, $2, $3)',
    ['media_call_timeout', now.toISOString(), input.tenantLimit]
  );
  const summary: MediaCallTimeoutRunSummary = {
    tenants: tenants.rows.length,
    scanned: 0,
    timed_out: 0,
    skipped: 0
  };
  for (const row of tenants.rows) {
    const tenantId = String(row.tenant_id || '');
    if (!tenantId) continue;
    const result = await withPgTenant(input.pg, tenantId, (tenantPg) =>
      new MediaCallService(new MediaCallStore(tenantPg), {
        now: () => now,
        onTimedOut: input.onTimedOut,
        placement: input.placement,
        placementWorkerId: input.placementWorkerId
      }).timeoutExpired(tenantId, input.batchSize)
    );
    summary.scanned += result.scanned;
    summary.timed_out += result.timed_out;
    summary.skipped += result.skipped;
  }
  return summary;
}

export function mediaCallTimeoutWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): MediaCallTimeoutWorkerConfig {
  const enabledValue = String(resolveBrandEnv(env, 'MEDIA_CALL_TIMEOUT_WORKER_ENABLED') || '').trim();
  if (enabledValue && enabledValue !== '0' && enabledValue !== '1') {
    throw new Error('CONVERACT_MEDIA_CALL_TIMEOUT_WORKER_ENABLED must be 0 or 1');
  }
  return {
    enabled: enabledValue !== '0',
    intervalMs: boundedInteger(resolveBrandEnv(env, 'MEDIA_CALL_TIMEOUT_INTERVAL_MS'), 1_000, 250, 60_000, 'CONVERACT_MEDIA_CALL_TIMEOUT_INTERVAL_MS'),
    batchSize: boundedInteger(resolveBrandEnv(env, 'MEDIA_CALL_TIMEOUT_BATCH_SIZE'), 50, 1, 100, 'CONVERACT_MEDIA_CALL_TIMEOUT_BATCH_SIZE'),
    tenantLimit: boundedInteger(resolveBrandEnv(env, 'MEDIA_CALL_TIMEOUT_TENANT_LIMIT'), 100, 1, 1_000, 'CONVERACT_MEDIA_CALL_TIMEOUT_TENANT_LIMIT')
  };
}

export function startMediaCallTimeoutWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  onTimedOut?: (snapshot: ConveractFabricMediaCallSnapshot) => void | Promise<void>;
  placement?: MediaCallPlacementPort;
  placementWorkerId?: string;
}): MediaCallTimeoutWorker {
  const config = mediaCallTimeoutWorkerConfig(input.env || process.env);
  const worker = new MediaCallTimeoutWorker({
    config,
    runBatch: () => runMediaCallTimeoutBatch({
      pg: input.pg,
      tenantLimit: config.tenantLimit,
      batchSize: config.batchSize,
      onTimedOut: input.onTimedOut,
      placement: input.placement,
      placementWorkerId: input.placementWorkerId
    }),
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[media-call-timeout] worker failed:', message.slice(0, 500));
    }
  });
  worker.start();
  return worker;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, field: string): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
