import type { PgQueryable } from '../../db-pg.js';
import { createIntelligenceProviderRegistry } from './intelligence-provider-registry.js';
import { createPolicyQualityReviewProviderResolver } from './intelligence-provider-routing.js';
import {
  QualityReviewService,
  type QualityReviewRunSummary,
  type QualityReviewServiceInput
} from './quality-review.js';

export interface QualityReviewWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  maxAttempts: number;
  claimLeaseMs: number;
  retryDelaysMs: number[];
}

export interface QualityReviewWorkerInput {
  config: QualityReviewWorkerConfig;
  runBatch: () => Promise<QualityReviewRunSummary>;
  onResult?: (result: QualityReviewRunSummary) => void;
  onError?: (error: unknown) => void;
}

export class QualityReviewWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<QualityReviewRunSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: QualityReviewWorkerInput) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<QualityReviewRunSummary> {
    if (this.active) return this.active;
    let running: Promise<QualityReviewRunSummary>;
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

export function qualityReviewWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): QualityReviewWorkerConfig {
  const configured = createIntelligenceProviderRegistry(env).list()
    .some((profile) => profile.capability === 'quality_review');
  const enabledFlag = String(env.OPC_QUALITY_REVIEW_WORKER_ENABLED || '').trim();
  if (enabledFlag && enabledFlag !== '0' && enabledFlag !== '1') {
    throw new Error('OPC_QUALITY_REVIEW_WORKER_ENABLED must be 0 or 1');
  }
  return {
    enabled: configured && enabledFlag !== '0',
    intervalMs: boundedInteger(
      env.OPC_QUALITY_REVIEW_INTERVAL_MS,
      5_000,
      1_000,
      300_000,
      'OPC_QUALITY_REVIEW_INTERVAL_MS'
    ),
    batchSize: boundedInteger(
      env.OPC_QUALITY_REVIEW_BATCH_SIZE,
      25,
      1,
      100,
      'OPC_QUALITY_REVIEW_BATCH_SIZE'
    ),
    maxAttempts: boundedInteger(
      env.OPC_QUALITY_REVIEW_MAX_ATTEMPTS,
      3,
      1,
      10,
      'OPC_QUALITY_REVIEW_MAX_ATTEMPTS'
    ),
    claimLeaseMs: boundedInteger(
      env.OPC_QUALITY_REVIEW_CLAIM_LEASE_MS,
      120_000,
      5_000,
      600_000,
      'OPC_QUALITY_REVIEW_CLAIM_LEASE_MS'
    ),
    retryDelaysMs: retryDelays(env.OPC_QUALITY_REVIEW_RETRY_DELAYS_MS)
  };
}

export function startQualityReviewWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  onCompleted?: QualityReviewServiceInput['onCompleted'];
}): QualityReviewWorker {
  const env = input.env || process.env;
  const config = qualityReviewWorkerConfig(env);
  const registry = createIntelligenceProviderRegistry(env);
  const service = new QualityReviewService({
    pg: input.pg,
    resolveProvider: createPolicyQualityReviewProviderResolver({ pg: input.pg, registry }),
    maxAttempts: config.maxAttempts,
    claimLeaseMs: config.claimLeaseMs,
    retryDelaysMs: config.retryDelaysMs,
    onCompleted: input.onCompleted
  });
  const worker = new QualityReviewWorker({
    config,
    runBatch: () => service.runDue({ limit: config.batchSize }),
    onResult: (result) => {
      if (result.claimed > 0) console.log('[quality-review] batch', JSON.stringify(result));
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[quality-review] worker failed:', redactError(message));
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
  if (value == null || !String(value).trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function retryDelays(value: string | undefined): number[] {
  if (!hasValue(value)) return [5_000, 30_000];
  const parsed = String(value).split(',').map((item) => Number(item.trim()));
  if (!parsed.length || parsed.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 3_600_000)) {
    throw new Error('OPC_QUALITY_REVIEW_RETRY_DELAYS_MS must be comma-separated integers between 0 and 3600000');
  }
  return parsed;
}

function hasValue(value: string | undefined): boolean {
  return Boolean(String(value || '').trim());
}

function redactError(value: string): string {
  return String(value)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}
