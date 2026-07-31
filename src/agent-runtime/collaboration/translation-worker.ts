import type { PgQueryable } from '../../db-pg.js';
import { createIntelligenceProviderRegistry } from './intelligence-provider-registry.js';
import { createPolicyTranslationProviderResolver } from './intelligence-provider-routing.js';
import type { IntelligenceProviderRouteEventHandler } from './intelligence-provider-route.js';
import {
  TranslationService,
  type TranslationRunSummary,
  type TranslationServiceInput
} from './translation-service.js';

export interface TranslationWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  maxAttempts: number;
  claimLeaseMs: number;
  retryDelaysMs: number[];
}

export class TranslationWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<TranslationRunSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: TranslationWorkerConfig;
    runBatch: () => Promise<TranslationRunSummary>;
    onResult?: (result: TranslationRunSummary) => void;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<TranslationRunSummary> {
    if (this.active) return this.active;
    const running = Promise.resolve().then(this.input.runBatch);
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

export function translationWorkerConfig(env: NodeJS.ProcessEnv = process.env): TranslationWorkerConfig {
  const profiles = createIntelligenceProviderRegistry(env).list()
    .filter((profile) => profile.capability === 'translation');
  const configured = profiles.length > 0;
  const flag = String(env.OPC_TRANSLATION_WORKER_ENABLED || '').trim();
  if (flag && flag !== '0' && flag !== '1') throw new Error('OPC_TRANSLATION_WORKER_ENABLED must be 0 or 1');
  return {
    enabled: configured && flag !== '0',
    intervalMs: integer(env.OPC_TRANSLATION_INTERVAL_MS, 5_000, 1_000, 300_000, 'OPC_TRANSLATION_INTERVAL_MS'),
    batchSize: integer(env.OPC_TRANSLATION_BATCH_SIZE, 25, 1, 100, 'OPC_TRANSLATION_BATCH_SIZE'),
    maxAttempts: integer(env.OPC_TRANSLATION_MAX_ATTEMPTS, 3, 1, 10, 'OPC_TRANSLATION_MAX_ATTEMPTS'),
    claimLeaseMs: Math.max(
      integer(env.OPC_TRANSLATION_CLAIM_LEASE_MS, 120_000, 5_000, 600_000, 'OPC_TRANSLATION_CLAIM_LEASE_MS'),
      requiredClaimLeaseMs(profiles)
    ),
    retryDelaysMs: delays(env.OPC_TRANSLATION_RETRY_DELAYS_MS)
  };
}

function requiredClaimLeaseMs(profiles: Array<{ reservation_ttl_ms: number }>): number {
  return profiles.reduce(
    (maximum, profile) => Math.max(maximum, profile.reservation_ttl_ms + 5_000),
    5_000
  );
}

export function startTranslationWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  onCompleted?: TranslationServiceInput['onCompleted'];
  onFailed?: TranslationServiceInput['onFailed'];
  onProviderEvent?: IntelligenceProviderRouteEventHandler;
}): TranslationWorker {
  const env = input.env || process.env;
  const config = translationWorkerConfig(env);
  const registry = createIntelligenceProviderRegistry(env);
  const service = new TranslationService({
    pg: input.pg,
    resolveProvider: createPolicyTranslationProviderResolver({
      pg: input.pg, registry, onEvent: input.onProviderEvent
    }),
    maxAttempts: config.maxAttempts,
    retryDelaysMs: config.retryDelaysMs,
    claimLeaseMs: config.claimLeaseMs,
    onCompleted: input.onCompleted,
    onFailed: input.onFailed
  });
  const worker = new TranslationWorker({
    config,
    runBatch: () => service.runDue({ limit: config.batchSize }),
    onResult: (result) => {
      if (result.claimed) console.log('[translation] batch', JSON.stringify(result));
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[translation] worker failed:', message.slice(0, 500));
    }
  });
  worker.start();
  return worker;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, field: string): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function delays(value: string | undefined): number[] {
  if (!String(value || '').trim()) return [5_000, 30_000];
  const parsed = String(value).split(',').map((item) => Number(item.trim()));
  if (!parsed.length || parsed.some((item) => !Number.isInteger(item) || item < 0 || item > 3_600_000)) {
    throw new Error('OPC_TRANSLATION_RETRY_DELAYS_MS is invalid');
  }
  return parsed;
}
