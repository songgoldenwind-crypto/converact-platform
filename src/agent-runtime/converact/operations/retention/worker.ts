import { resolveFabricEnv } from '../../../../config/converact-env.js';
import { randomUUID } from 'node:crypto';

import { observeIveKitRetentionRun } from './metrics.js';
import type {
  IveKitRetentionCategoryHandler,
  IveKitRetentionRepository
} from './ports.js';
import type {
  IveKitRetentionBatchSummary,
  IveKitRetentionClaim,
  IveKitRetentionDeletionSummary
} from './types.js';

export interface IveKitRetentionWorkerConfig {
  enabled: boolean;
  interval_ms: number;
  tenant_limit: number;
  policy_limit: number;
  lease_ms: number;
}

export class IveKitRetentionWorker {
  readonly #repository: IveKitRetentionRepository;
  readonly #workerId: string;
  readonly #config: IveKitRetentionWorkerConfig;
  readonly #handlers: Readonly<Record<string, IveKitRetentionCategoryHandler>>;
  readonly #now: () => Date;
  #active: Promise<IveKitRetentionBatchSummary> | null = null;

  constructor(input: {
    repository: IveKitRetentionRepository;
    worker_id?: string;
    config: IveKitRetentionWorkerConfig;
    handlers?: Readonly<Record<string, IveKitRetentionCategoryHandler>>;
    now?: () => Date;
  }) {
    this.#repository = input.repository;
    this.#workerId = input.worker_id || `retention-${randomUUID()}`;
    this.#config = input.config;
    this.#handlers = input.handlers || {};
    this.#now = input.now || (() => new Date());
  }

  runOnce(): Promise<IveKitRetentionBatchSummary> {
    if (this.#active) return this.#active;
    this.#active = this.#run().finally(() => { this.#active = null; });
    return this.#active;
  }

  async #run(): Promise<IveKitRetentionBatchSummary> {
    const summary = emptySummary();
    const tenants = await this.#repository.listDueTenantIds(this.#config.tenant_limit);
    summary.tenants = tenants.length;
    for (const tenantId of tenants) {
      for (let claimed = 0; claimed < this.#config.policy_limit; claimed += 1) {
        const claims = await this.#repository.claimDue({
          tenant_id: tenantId,
          worker_id: this.#workerId,
          lease_ms: this.#config.lease_ms,
          limit: 1,
          now: this.#now().toISOString()
        });
        const claim = claims[0];
        if (!claim) break;
        summary.claimed += 1;
        await this.#process(claim, summary);
      }
    }
    return summary;
  }

  async #process(claim: IveKitRetentionClaim, batch: IveKitRetentionBatchSummary): Promise<void> {
    let outcome: 'completed' | 'failed' = 'completed';
    let result: IveKitRetentionDeletionSummary = { scanned_count: 0, deleted_count: 0, held_count: 0 };
    let errorCode = '';
    try {
      const handler = this.#handlers[claim.policy.category];
      result = handler
        ? await handler.deleteExpired(claim)
        : await this.#repository.deleteExpired(claim);
      batch.completed += 1;
      batch.scanned += result.scanned_count;
      batch.deleted += result.deleted_count;
      batch.held += result.held_count;
    } catch (error) {
      outcome = 'failed';
      errorCode = safeCode((error as { code?: unknown }).code || 'retention_handler_failed');
      batch.failed += 1;
    }
    await this.#repository.completeRun({
      claim,
      outcome,
      summary: result,
      error_code: errorCode,
      now: this.#now().toISOString()
    });
    observeIveKitRetentionRun({ category: claim.policy.category, outcome, summary: result });
  }
}

export function iveKitRetentionWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): IveKitRetentionWorkerConfig {
  return {
    enabled: booleanEnv(resolveFabricEnv(env, 'RETENTION_WORKER_ENABLED'), false),
    interval_ms: integerEnv(resolveFabricEnv(env, 'RETENTION_INTERVAL_MS'), 60_000, 1_000, 86_400_000),
    tenant_limit: integerEnv(resolveFabricEnv(env, 'RETENTION_TENANT_LIMIT'), 100, 1, 1000),
    policy_limit: integerEnv(resolveFabricEnv(env, 'RETENTION_POLICY_LIMIT'), 20, 1, 100),
    lease_ms: integerEnv(resolveFabricEnv(env, 'RETENTION_LEASE_MS'), 120_000, 5_000, 3_600_000)
  };
}

export function startIveKitRetentionWorker(input: {
  repository: IveKitRetentionRepository;
  env?: NodeJS.ProcessEnv;
  handlers?: Readonly<Record<string, IveKitRetentionCategoryHandler>>;
}): { stop(): void; runOnce(): Promise<IveKitRetentionBatchSummary> } | null {
  const config = iveKitRetentionWorkerConfig(input.env);
  if (!config.enabled) return null;
  const worker = new IveKitRetentionWorker({
    repository: input.repository,
    config,
    handlers: input.handlers
  });
  const run = () => worker.runOnce().catch((error) => {
    console.error('[ivekit-retention] worker failed', safeCode((error as Error).message));
  });
  void run();
  const timer = setInterval(run, config.interval_ms);
  timer.unref?.();
  return { stop: () => clearInterval(timer), runOnce: () => worker.runOnce() };
}

function emptySummary(): IveKitRetentionBatchSummary {
  return { tenants: 0, claimed: 0, completed: 0, failed: 0, scanned: 0, deleted: 0, held: 0 };
}

function safeCode(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 100)
    || 'retention_handler_failed';
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error('invalid retention worker configuration');
}

function integerEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error('invalid retention worker configuration');
  }
  return number;
}
