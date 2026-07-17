import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { createObjectStorage, type ObjectStorage } from '../../storage/object-storage.js';
import {
  ControlledFileThreatScanner,
  createClamdFileThreatScanner,
  createHttpFileThreatScanner,
  type FileThreatScanner
} from './file-threat-scanner.js';
import {
  SecureFileScanService,
  type SecureFileScanRunSummary,
  type SecureFileScanServiceInput
} from './secure-file-scan-service.js';
import { SecureFileStore } from './secure-file-store.js';

export interface SecureFileScanWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  maxAttempts: number;
  claimLeaseMs: number;
  retryDelaysMs: number[];
  maxScanBytes: number;
  mimeConflictAction: 'reject' | 'quarantine';
  workerId: string;
}

export interface SecureFileScanWorkerInput {
  config: SecureFileScanWorkerConfig;
  runBatch: () => Promise<SecureFileScanRunSummary>;
  onResult?: (result: SecureFileScanRunSummary) => void;
  onError?: (error: unknown) => void;
}

export class SecureFileScanWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<SecureFileScanRunSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: SecureFileScanWorkerInput) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<SecureFileScanRunSummary> {
    if (this.active) return this.active;
    let running: Promise<SecureFileScanRunSummary>;
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

export function secureFileScanWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): SecureFileScanWorkerConfig {
  const mode = scannerMode(env);
  const enabledFlag = String(env.OPC_FILE_SECURITY_SCAN_WORKER_ENABLED || '').trim();
  if (enabledFlag && enabledFlag !== '0' && enabledFlag !== '1') {
    throw new Error('OPC_FILE_SECURITY_SCAN_WORKER_ENABLED must be 0 or 1');
  }
  if (
    mode === 'controlled' && env.NODE_ENV === 'production' &&
    env.OPC_FILE_SECURITY_ALLOW_CONTROLLED !== '1'
  ) {
    throw new Error('controlled file scanner is forbidden in production');
  }
  return {
    enabled: mode !== 'disabled' && enabledFlag !== '0',
    intervalMs: envInteger(env.OPC_FILE_SECURITY_SCAN_INTERVAL_MS, 5_000, 1_000, 300_000, 'scan interval'),
    batchSize: envInteger(env.OPC_FILE_SECURITY_SCAN_BATCH_SIZE, 25, 1, 100, 'scan batch size'),
    maxAttempts: envInteger(env.OPC_FILE_SECURITY_SCAN_MAX_ATTEMPTS, 3, 1, 10, 'scan max attempts'),
    claimLeaseMs: envInteger(env.OPC_FILE_SECURITY_SCAN_LEASE_MS, 60_000, 5_000, 600_000, 'scan lease'),
    retryDelaysMs: retryDelays(env.OPC_FILE_SECURITY_SCAN_RETRY_DELAYS_MS),
    maxScanBytes: envInteger(
      env.OPC_FILE_SECURITY_SCAN_MAX_BYTES,
      100 * 1024 * 1024,
      1,
      10 * 1024 * 1024 * 1024,
      'scan max bytes'
    ),
    mimeConflictAction: mimeConflictAction(env.OPC_FILE_SECURITY_MIME_CONFLICT_ACTION),
    workerId: safeWorkerId(env.OPC_FILE_SECURITY_SCAN_WORKER_ID) ||
      `secure-file-scan-${process.pid}-${randomUUID().slice(0, 8)}`
  };
}

export function configuredFileThreatScanner(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch?: typeof fetch } = {}
): FileThreatScanner | null {
  const mode = scannerMode(env);
  if (mode === 'disabled') return null;
  if (mode === 'controlled') return new ControlledFileThreatScanner();
  if (mode === 'clamd') {
    return createClamdFileThreatScanner({
      host: env.OPC_FILE_SECURITY_CLAMD_HOST,
      port: optionalNumber(env.OPC_FILE_SECURITY_CLAMD_PORT),
      timeoutMs: optionalNumber(env.OPC_FILE_SECURITY_SCANNER_TIMEOUT_MS),
      maxBytes: optionalNumber(env.OPC_FILE_SECURITY_SCAN_MAX_BYTES),
      chunkBytes: optionalNumber(env.OPC_FILE_SECURITY_CLAMD_CHUNK_BYTES)
    });
  }
  const baseUrl = String(env.OPC_FILE_SECURITY_SCANNER_URL || '').trim();
  if (!baseUrl) throw new Error('OPC_FILE_SECURITY_SCANNER_URL is required for HTTP scanner mode');
  return createHttpFileThreatScanner({
    mode: mode === 'http_self_hosted' ? 'self_hosted' : 'third_party',
    baseUrl,
    endpoint: env.OPC_FILE_SECURITY_SCANNER_ENDPOINT,
    token: env.OPC_FILE_SECURITY_SCANNER_TOKEN,
    timeoutMs: optionalNumber(env.OPC_FILE_SECURITY_SCANNER_TIMEOUT_MS),
    maxBytes: optionalNumber(env.OPC_FILE_SECURITY_SCAN_MAX_BYTES),
    fetch: deps.fetch
  });
}

export function startSecureFileScanWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  scanner?: FileThreatScanner;
  objectStorage?: ObjectStorage;
  onProcessed?: SecureFileScanServiceInput['onProcessed'];
}): SecureFileScanWorker {
  const env = input.env || process.env;
  const config = secureFileScanWorkerConfig(env);
  const scanner = input.scanner || configuredFileThreatScanner(env);
  const service = scanner
    ? new SecureFileScanService({
        store: new SecureFileStore(input.pg),
        objectStorage: input.objectStorage || createObjectStorage(env),
        scanner,
        workerId: config.workerId,
        maxAttempts: config.maxAttempts,
        claimLeaseMs: config.claimLeaseMs,
        retryDelaysMs: config.retryDelaysMs,
        maxScanBytes: config.maxScanBytes,
        mimeConflictAction: config.mimeConflictAction,
        onProcessed: input.onProcessed
      })
    : null;
  if (config.enabled && !service) {
    throw new Error('enabled file security scan worker requires a scanner');
  }
  const worker = new SecureFileScanWorker({
    config,
    runBatch: () => service
      ? service.runDue({ limit: config.batchSize })
      : Promise.resolve(emptySummary()),
    onResult: (result) => {
      if (result.claimed > 0) console.log('[secure-file-scan] batch', JSON.stringify(result));
    },
    onError: (error) => {
      console.error('[secure-file-scan] worker failed:', redactError(error));
    }
  });
  worker.start();
  return worker;
}

function scannerMode(
  env: NodeJS.ProcessEnv
): 'disabled' | 'controlled' | 'clamd' | 'http_self_hosted' | 'http_third_party' {
  const value = String(env.OPC_FILE_SECURITY_SCANNER_MODE || 'disabled').trim();
  if (
    value === 'disabled' || value === 'controlled' || value === 'clamd' ||
    value === 'http_self_hosted' || value === 'http_third_party'
  ) return value;
  throw new Error('OPC_FILE_SECURITY_SCANNER_MODE is invalid');
}

function mimeConflictAction(value: string | undefined): 'reject' | 'quarantine' {
  const action = String(value || 'quarantine').trim();
  if (action === 'reject' || action === 'quarantine') return action;
  throw new Error('OPC_FILE_SECURITY_MIME_CONFLICT_ACTION must be reject or quarantine');
}

function retryDelays(value: string | undefined): number[] {
  if (!String(value || '').trim()) return [2_000, 10_000];
  const parsed = String(value).split(',').map((item) => Number(item.trim()));
  if (
    !parsed.length || parsed.length > 10 ||
    parsed.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 3_600_000)
  ) throw new Error('OPC_FILE_SECURITY_SCAN_RETRY_DELAYS_MS is invalid');
  return parsed;
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

function optionalNumber(value: string | undefined): number | undefined {
  return String(value || '').trim() ? Number(value) : undefined;
}

function safeWorkerId(value: string | undefined): string {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._:-]+/g, '_').slice(0, 100);
}

function emptySummary(): SecureFileScanRunSummary {
  return { candidates: 0, claimed: 0, clean: 0, quarantined: 0, retry_wait: 0, failed: 0 };
}

function redactError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}
