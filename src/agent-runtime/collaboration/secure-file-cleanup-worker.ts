import { resolveBrandEnv } from '../../config/converact-env.js';
import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { createObjectStorage, type ObjectStorage } from '../../storage/object-storage.js';
import {
  SecureFileCleanupService,
  type SecureFileCleanupResult,
  type SecureFileCleanupServiceInput
} from './secure-file-cleanup-service.js';
import { SecureFileDerivativeStore } from './secure-file-derivative-store.js';
import { SecureFileStore } from './secure-file-store.js';

export interface SecureFileCleanupWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  uploadStaleMs: number;
  claimLeaseMs: number;
  retryDelayMs: number;
  workerId: string;
}

export interface SecureFileCleanupWorkerInput {
  config: SecureFileCleanupWorkerConfig;
  runBatch: () => Promise<SecureFileCleanupResult>;
  onResult?: (result: SecureFileCleanupResult) => void;
  onError?: (error: unknown) => void;
}

export class SecureFileCleanupWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<SecureFileCleanupResult> | null = null;
  private stopped = true;

  constructor(private readonly input: SecureFileCleanupWorkerInput) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<SecureFileCleanupResult> {
    if (this.active) return this.active;
    let running: Promise<SecureFileCleanupResult>;
    try {
      running = Promise.resolve(this.input.runBatch());
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

export function secureFileCleanupWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): SecureFileCleanupWorkerConfig {
  const enabledValue = String(resolveBrandEnv(env, 'FILE_CLEANUP_WORKER_ENABLED') || '0').trim();
  const confirmValue = String(resolveBrandEnv(env, 'FILE_CLEANUP_CONFIRM') || '0').trim();
  if (enabledValue !== '0' && enabledValue !== '1') {
    throw new Error('CONVERACT_FILE_CLEANUP_WORKER_ENABLED must be 0 or 1');
  }
  if (confirmValue !== '0' && confirmValue !== '1') {
    throw new Error('CONVERACT_FILE_CLEANUP_CONFIRM must be 0 or 1');
  }
  if (enabledValue === '1' && confirmValue !== '1') {
    throw new Error('enabled file cleanup worker requires CONVERACT_FILE_CLEANUP_CONFIRM=1');
  }
  return {
    enabled: enabledValue === '1',
    intervalMs: envInteger(
      resolveBrandEnv(env, 'FILE_CLEANUP_INTERVAL_MS'),
      60 * 60_000,
      60_000,
      24 * 60 * 60_000,
      'cleanup interval'
    ),
    batchSize: envInteger(resolveBrandEnv(env, 'FILE_CLEANUP_BATCH_SIZE'), 25, 1, 100, 'cleanup batch size'),
    uploadStaleMs: envInteger(
      resolveBrandEnv(env, 'FILE_CLEANUP_UPLOAD_STALE_MS'),
      24 * 60 * 60_000,
      60_000,
      30 * 24 * 60 * 60_000,
      'cleanup upload stale age'
    ),
    claimLeaseMs: envInteger(
      resolveBrandEnv(env, 'FILE_CLEANUP_LEASE_MS'),
      120_000,
      5_000,
      30 * 60_000,
      'cleanup lease'
    ),
    retryDelayMs: envInteger(
      resolveBrandEnv(env, 'FILE_CLEANUP_RETRY_DELAY_MS'),
      60_000,
      1_000,
      24 * 60 * 60_000,
      'cleanup retry delay'
    ),
    workerId: safeWorkerId(resolveBrandEnv(env, 'FILE_CLEANUP_WORKER_ID')) ||
      `secure-file-cleanup-${process.pid}-${randomUUID().slice(0, 8)}`
  };
}

export function startSecureFileCleanupWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  objectStorage?: ObjectStorage;
  onProcessed?: SecureFileCleanupServiceInput['onProcessed'];
}): SecureFileCleanupWorker {
  const env = input.env || process.env;
  const config = secureFileCleanupWorkerConfig(env);
  const service = new SecureFileCleanupService({
    store: new SecureFileStore(input.pg),
    derivativeStore: new SecureFileDerivativeStore(input.pg),
    objectStorage: input.objectStorage || createObjectStorage(env),
    workerId: config.workerId,
    uploadStaleMs: config.uploadStaleMs,
    claimLeaseMs: config.claimLeaseMs,
    retryDelayMs: config.retryDelayMs,
    onProcessed: input.onProcessed
  });
  const worker = new SecureFileCleanupWorker({
    config,
    runBatch: () => service.run({
      dry_run: false,
      confirm: true,
      limit: config.batchSize
    }),
    onResult: (result) => {
      if (result.claimed > 0) console.log('[secure-file-cleanup] batch', JSON.stringify(result));
    },
    onError: (error) => {
      console.error('[secure-file-cleanup] worker failed:', redactError(error));
    }
  });
  worker.start();
  return worker;
}

function envInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return parsed;
}

function safeWorkerId(value: string | undefined): string {
  return String(value || '').trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function redactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}
