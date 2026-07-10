import type { PgQueryable } from '../../db-pg.js';
import {
  configuredChatGateway,
  tinodeMinimumDeliveryLeaseMs,
  tinodeRequestTimeoutMs
} from './chat-gateway.js';
import {
  TinodeMessageDeliveryService,
  type TinodeDeliveryRunSummary
} from './tinode-message-delivery.js';
import type { CollaborationMessage } from './types.js';

export type TinodeSyncWorkerRunResult = TinodeDeliveryRunSummary;

export interface TinodeSyncWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  maxAttempts: number;
  claimLeaseMs: number;
  retryDelaysMs: number[];
}

export interface TinodeSyncWorkerInput {
  config: TinodeSyncWorkerConfig;
  runDeliveryBatch: () => Promise<TinodeSyncWorkerRunResult>;
  onError?: (error: unknown) => void;
  onResult?: (result: TinodeSyncWorkerRunResult) => void;
}

export class TinodeSyncWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<TinodeSyncWorkerRunResult> | null = null;
  private stopped = true;

  constructor(private readonly input: TinodeSyncWorkerInput) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<TinodeSyncWorkerRunResult> {
    if (this.active) return this.active;
    let running: Promise<TinodeSyncWorkerRunResult>;
    try {
      running = Promise.resolve(this.input.runDeliveryBatch());
    } catch (error) {
      running = Promise.reject(error);
    }
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
        .finally(() => this.schedule(this.input.config.intervalMs));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function tinodeSyncWorkerConfig(env: NodeJS.ProcessEnv = process.env): TinodeSyncWorkerConfig {
  const providerConfigured = hasValue(env.TINODE_BASE_URL) || hasValue(env.TINODE_WS_URL);
  const enabledFlag = String(env.OPC_TINODE_DELIVERY_WORKER_ENABLED || '').trim();
  if (enabledFlag && enabledFlag !== '0' && enabledFlag !== '1') {
    throw new Error('OPC_TINODE_DELIVERY_WORKER_ENABLED must be 0 or 1');
  }
  const requestTimeoutMs = tinodeRequestTimeoutMs(env);
  const minimumLeaseMs = tinodeMinimumDeliveryLeaseMs(requestTimeoutMs);
  const configuredLease = optionalInteger(env.OPC_TINODE_DELIVERY_CLAIM_LEASE_MS, 'OPC_TINODE_DELIVERY_CLAIM_LEASE_MS');
  const claimLeaseMs = configuredLease ?? Math.max(30_000, minimumLeaseMs);
  if (claimLeaseMs < minimumLeaseMs || claimLeaseMs > 300_000) {
    throw new Error(`OPC_TINODE_DELIVERY_CLAIM_LEASE_MS must be between ${minimumLeaseMs} and 300000`);
  }
  return {
    enabled: providerConfigured && enabledFlag !== '0',
    intervalMs: boundedInteger(env.OPC_TINODE_DELIVERY_INTERVAL_MS, 5_000, 1_000, 300_000, 'OPC_TINODE_DELIVERY_INTERVAL_MS'),
    batchSize: boundedInteger(env.OPC_TINODE_DELIVERY_BATCH_SIZE, 50, 1, 200, 'OPC_TINODE_DELIVERY_BATCH_SIZE'),
    maxAttempts: boundedInteger(env.OPC_TINODE_DELIVERY_MAX_ATTEMPTS, 3, 1, 10, 'OPC_TINODE_DELIVERY_MAX_ATTEMPTS'),
    claimLeaseMs,
    retryDelaysMs: retryDelays(env.OPC_TINODE_DELIVERY_RETRY_DELAYS_MS)
  };
}

export function startTinodeSyncWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  onDeliveryUpdated?: (message: CollaborationMessage) => void | Promise<void>;
}): TinodeSyncWorker {
  const env = input.env || process.env;
  const config = tinodeSyncWorkerConfig(env);
  const gateway = configuredChatGateway(env);
  const service = new TinodeMessageDeliveryService({
    pg: input.pg,
    gateway,
    maxAttempts: config.maxAttempts,
    claimLeaseMs: config.claimLeaseMs,
    retryDelaysMs: config.retryDelaysMs,
    onDeliveryUpdated: input.onDeliveryUpdated
  });
  const worker = new TinodeSyncWorker({
    config,
    runDeliveryBatch: () => service.runDue({ limit: config.batchSize }),
    onResult: (result) => {
      if (result.claimed > 0) console.log('[tinode-delivery] batch', JSON.stringify(result));
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[tinode-delivery] worker failed:', redactWorkerError(message));
    }
  });
  worker.start();
  return worker;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function optionalInteger(value: string | undefined, field: string): number | null {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

function retryDelays(value: string | undefined): number[] {
  if (!hasValue(value)) return [2_000, 10_000];
  const parsed = String(value).split(',').map((item) => Number(item.trim()));
  if (!parsed.length || parsed.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 3_600_000)) {
    throw new Error('OPC_TINODE_DELIVERY_RETRY_DELAYS_MS must be comma-separated integers between 0 and 3600000');
  }
  return parsed;
}

function hasValue(value: string | undefined): boolean {
  return Boolean(String(value || '').trim());
}

function redactWorkerError(value: string): string {
  return String(value)
    .replace(/([?&](?:apikey|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}
