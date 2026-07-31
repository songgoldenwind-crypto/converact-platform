import { resolveBrandEnv } from '../../config/converact-env.js';
import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { createObjectStorage, type ObjectStorage } from '../../storage/object-storage.js';
import {
  createHttpFileDerivativeProvider,
  createLocalFfmpegDerivativeProvider,
  type FileDerivativeProvider
} from './file-derivative-provider.js';
import {
  SecureFileDerivativeService,
  type SecureFileDerivativeRunSummary,
  type SecureFileDerivativeServiceInput
} from './secure-file-derivative-service.js';
import { SecureFileDerivativeStore } from './secure-file-derivative-store.js';

type DerivativeProviderMode =
  | 'disabled'
  | 'local_ffmpeg'
  | 'http_self_hosted'
  | 'http_third_party';

export interface SecureFileDerivativeWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  maxAttempts: number;
  claimLeaseMs: number;
  retryDelaysMs: number[];
  maxSourceBytes: number;
  maxOutputBytes: number;
  workerId: string;
  providerProfileId: string;
}

export interface SecureFileDerivativeWorkerInput {
  config: SecureFileDerivativeWorkerConfig;
  runBatch: () => Promise<SecureFileDerivativeRunSummary>;
  onResult?: (result: SecureFileDerivativeRunSummary) => void;
  onError?: (error: unknown) => void;
}

export class SecureFileDerivativeWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<SecureFileDerivativeRunSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: SecureFileDerivativeWorkerInput) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<SecureFileDerivativeRunSummary> {
    if (this.active) return this.active;
    let running: Promise<SecureFileDerivativeRunSummary>;
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

export function secureFileDerivativeWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): SecureFileDerivativeWorkerConfig {
  const mode = derivativeProviderMode(env);
  const enabledFlag = String(resolveBrandEnv(env, 'FILE_DERIVATIVE_WORKER_ENABLED') || '').trim();
  if (enabledFlag && enabledFlag !== '0' && enabledFlag !== '1') {
    throw new Error('CONVERACT_FILE_DERIVATIVE_WORKER_ENABLED must be 0 or 1');
  }
  if (enabledFlag === '1' && mode === 'disabled') {
    throw new Error('enabled file derivative worker requires a provider mode');
  }
  return {
    enabled: mode !== 'disabled' && enabledFlag !== '0',
    intervalMs: envInteger(
      resolveBrandEnv(env, 'FILE_DERIVATIVE_INTERVAL_MS'), 5_000, 1_000, 300_000, 'derivative interval'
    ),
    batchSize: envInteger(
      resolveBrandEnv(env, 'FILE_DERIVATIVE_BATCH_SIZE'), 10, 1, 100, 'derivative batch size'
    ),
    maxAttempts: envInteger(
      resolveBrandEnv(env, 'FILE_DERIVATIVE_MAX_ATTEMPTS'), 3, 1, 10, 'derivative max attempts'
    ),
    claimLeaseMs: envInteger(
      resolveBrandEnv(env, 'FILE_DERIVATIVE_LEASE_MS'), 120_000, 5_000, 30 * 60_000, 'derivative lease'
    ),
    retryDelaysMs: retryDelays(resolveBrandEnv(env, 'FILE_DERIVATIVE_RETRY_DELAYS_MS')),
    maxSourceBytes: envInteger(
      resolveBrandEnv(env, 'FILE_DERIVATIVE_MAX_SOURCE_BYTES'),
      500 * 1024 * 1024,
      1,
      10 * 1024 * 1024 * 1024,
      'derivative source limit'
    ),
    maxOutputBytes: envInteger(
      resolveBrandEnv(env, 'FILE_DERIVATIVE_MAX_OUTPUT_BYTES'),
      500 * 1024 * 1024,
      1,
      10 * 1024 * 1024 * 1024,
      'derivative output limit'
    ),
    workerId: safeIdentifier(resolveBrandEnv(env, 'FILE_DERIVATIVE_WORKER_ID'), 100) ||
      `secure-file-derivative-${process.pid}-${randomUUID().slice(0, 8)}`,
    providerProfileId: safeIdentifier(
      resolveBrandEnv(env, 'FILE_DERIVATIVE_PROVIDER_PROFILE_ID'),
      255
    ) || defaultProviderProfileId(mode)
  };
}

export function configuredFileDerivativeProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch?: typeof fetch } = {}
): FileDerivativeProvider | null {
  const mode = derivativeProviderMode(env);
  if (mode === 'disabled') return null;
  const name = safeIdentifier(resolveBrandEnv(env, 'FILE_DERIVATIVE_PROVIDER_NAME'), 100) || undefined;
  if (mode === 'local_ffmpeg') {
    return createLocalFfmpegDerivativeProvider({
      executable: resolveBrandEnv(env, 'FILE_DERIVATIVE_FFMPEG_EXECUTABLE'),
      timeoutMs: optionalNumber(resolveBrandEnv(env, 'FILE_DERIVATIVE_PROVIDER_TIMEOUT_MS')),
      maxInputBytes: optionalNumber(resolveBrandEnv(env, 'FILE_DERIVATIVE_MAX_SOURCE_BYTES')),
      maxOutputBytes: optionalNumber(resolveBrandEnv(env, 'FILE_DERIVATIVE_MAX_OUTPUT_BYTES')),
      maxStderrBytes: optionalNumber(resolveBrandEnv(env, 'FILE_DERIVATIVE_FFMPEG_MAX_STDERR_BYTES')),
      name
    });
  }
  const baseUrl = String(resolveBrandEnv(env, 'FILE_DERIVATIVE_PROVIDER_URL') || '').trim();
  if (!baseUrl) throw new Error('CONVERACT_FILE_DERIVATIVE_PROVIDER_URL is required for HTTP mode');
  return createHttpFileDerivativeProvider({
    mode: mode === 'http_self_hosted' ? 'self_hosted' : 'third_party',
    baseUrl,
    endpoint: resolveBrandEnv(env, 'FILE_DERIVATIVE_PROVIDER_ENDPOINT'),
    token: resolveBrandEnv(env, 'FILE_DERIVATIVE_PROVIDER_TOKEN'),
    timeoutMs: optionalNumber(resolveBrandEnv(env, 'FILE_DERIVATIVE_PROVIDER_TIMEOUT_MS')),
    maxInputBytes: optionalNumber(resolveBrandEnv(env, 'FILE_DERIVATIVE_MAX_SOURCE_BYTES')),
    maxOutputBytes: optionalNumber(resolveBrandEnv(env, 'FILE_DERIVATIVE_MAX_OUTPUT_BYTES')),
    fetch: deps.fetch,
    name
  });
}

export function startSecureFileDerivativeWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  provider?: FileDerivativeProvider;
  objectStorage?: ObjectStorage;
  onProcessed?: SecureFileDerivativeServiceInput['onProcessed'];
  onFileConverged?: SecureFileDerivativeServiceInput['onFileConverged'];
  afterBatch?: (result: SecureFileDerivativeRunSummary) => void | Promise<void>;
}): SecureFileDerivativeWorker {
  const env = input.env || process.env;
  const config = secureFileDerivativeWorkerConfig(env);
  const provider = input.provider || configuredFileDerivativeProvider(env);
  const service = provider
    ? new SecureFileDerivativeService({
        store: new SecureFileDerivativeStore(input.pg),
        objectStorage: input.objectStorage || createObjectStorage(env),
        provider,
        workerId: config.workerId,
        maxAttempts: config.maxAttempts,
        claimLeaseMs: config.claimLeaseMs,
        retryDelaysMs: config.retryDelaysMs,
        maxSourceBytes: config.maxSourceBytes,
        maxOutputBytes: config.maxOutputBytes,
        providerProfileId: config.providerProfileId,
        onProcessed: input.onProcessed,
        onFileConverged: input.onFileConverged
      })
    : null;
  if (config.enabled && !service) {
    throw new Error('enabled file derivative worker requires a provider');
  }
  const worker = new SecureFileDerivativeWorker({
    config,
    runBatch: async () => {
      const result = service
        ? await service.runDue({ limit: config.batchSize })
        : emptySummary();
      if (config.enabled) await input.afterBatch?.(result);
      return result;
    },
    onResult: (result) => {
      if (result.claimed > 0 || result.files_ready > 0 || result.files_failed > 0) {
        console.log('[secure-file-derivative] batch', JSON.stringify(result));
      }
    },
    onError: (error) => {
      console.error('[secure-file-derivative] worker failed:', redactError(error));
    }
  });
  worker.start();
  return worker;
}

function derivativeProviderMode(env: NodeJS.ProcessEnv): DerivativeProviderMode {
  const value = String(resolveBrandEnv(env, 'FILE_DERIVATIVE_PROVIDER_MODE') || 'disabled').trim();
  if (
    value === 'disabled' || value === 'local_ffmpeg' ||
    value === 'http_self_hosted' || value === 'http_third_party'
  ) return value;
  throw new Error('CONVERACT_FILE_DERIVATIVE_PROVIDER_MODE is invalid');
}

function defaultProviderProfileId(mode: DerivativeProviderMode): string {
  if (mode === 'local_ffmpeg') return 'ffmpeg-local';
  if (mode === 'http_self_hosted') return 'derivative-self-hosted';
  if (mode === 'http_third_party') return 'derivative-third-party';
  return 'derivative-disabled';
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

function retryDelays(value: string | undefined): number[] {
  if (!String(value || '').trim()) return [5_000, 30_000];
  const parsed = String(value).split(',').map((item) => Number(item.trim()));
  if (
    !parsed.length || parsed.length > 10 ||
    parsed.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 3_600_000)
  ) throw new Error('CONVERACT_FILE_DERIVATIVE_RETRY_DELAYS_MS is invalid');
  return parsed;
}

function safeIdentifier(value: string | undefined, max: number): string {
  return String(value || '').trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
}

function emptySummary(): SecureFileDerivativeRunSummary {
  return {
    tenants: 0, files_planned: 0, claimed: 0, ready: 0,
    retry_wait: 0, failed: 0, files_ready: 0, files_failed: 0
  };
}

function redactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}
