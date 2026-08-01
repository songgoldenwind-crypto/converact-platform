import { resolveFabricEnv } from '../../../../config/converact-env.js';
import { randomUUID } from 'node:crypto';

import { observeConveractFabricRetentionRun } from './metrics.js';
import type {
  ConveractFabricRetentionCategoryHandler,
  ConveractFabricRetentionRepository
} from './ports.js';
import type {
  ConveractFabricRetentionBatchSummary,
  ConveractFabricRetentionClaim,
  ConveractFabricRetentionDeletionSummary
} from './types.js';

export interface ConveractFabricRetentionWorkerConfig {
  enabled: boolean;
  interval_ms: number;
  tenant_limit: number;
  policy_limit: number;
  lease_ms: number;
}

export class ConveractFabricRetentionWorker {
  readonly #repository: ConveractFabricRetentionRepository;
  readonly #workerId: string;
  readonly #config: ConveractFabricRetentionWorkerConfig;
  readonly #handlers: Readonly<Record<string, ConveractFabricRetentionCategoryHandler>>;
  readonly #now: () => Date;
  #active: Promise<ConveractFabricRetentionBatchSummary> | null = null;

  constructor(input: {
    repository: ConveractFabricRetentionRepository;
    worker_id?: string;
    config: ConveractFabricRetentionWorkerConfig;
    handlers?: Readonly<Record<string, ConveractFabricRetentionCategoryHandler>>;
    now?: () => Date;
  }) {
    this.#repository = input.repository;
    this.#workerId = input.worker_id || `retention-${randomUUID()}`;
    this.#config = input.config;
    this.#handlers = input.handlers || {};
    this.#now = input.now || (() => new Date());
  }

  runOnce(): Promise<ConveractFabricRetentionBatchSummary> {
    if (this.#active) return this.#active;
    this.#active = this.#run().finally(() => { this.#active = null; });
    return this.#active;
  }

  async #run(): Promise<ConveractFabricRetentionBatchSummary> {
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

  async #process(claim: ConveractFabricRetentionClaim, batch: ConveractFabricRetentionBatchSummary): Promise<void> {
    let outcome: 'completed' | 'failed' = 'completed';
    let result: ConveractFabricRetentionDeletionSummary = { scanned_count: 0, deleted_count: 0, held_count: 0 };
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
    observeConveractFabricRetentionRun({ category: claim.policy.category, outcome, summary: result });
  }
}

export function converactFabricRetentionWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): ConveractFabricRetentionWorkerConfig {
  return {
    enabled: booleanEnv(resolveFabricEnv(env, 'RETENTION_WORKER_ENABLED'), false),
    interval_ms: integerEnv(resolveFabricEnv(env, 'RETENTION_INTERVAL_MS'), 60_000, 1_000, 86_400_000),
    tenant_limit: integerEnv(resolveFabricEnv(env, 'RETENTION_TENANT_LIMIT'), 100, 1, 1000),
    policy_limit: integerEnv(resolveFabricEnv(env, 'RETENTION_POLICY_LIMIT'), 20, 1, 100),
    lease_ms: integerEnv(resolveFabricEnv(env, 'RETENTION_LEASE_MS'), 120_000, 5_000, 3_600_000)
  };
}

export function startConveractFabricRetentionWorker(input: {
  repository: ConveractFabricRetentionRepository;
  env?: NodeJS.ProcessEnv;
  handlers?: Readonly<Record<string, ConveractFabricRetentionCategoryHandler>>;
}): { stop(): void; runOnce(): Promise<ConveractFabricRetentionBatchSummary> } | null {
  const config = converactFabricRetentionWorkerConfig(input.env);
  if (!config.enabled) return null;
  const worker = new ConveractFabricRetentionWorker({
    repository: input.repository,
    config,
    handlers: input.handlers
  });
  const run = () => worker.runOnce().catch((error) => {
    console.error('[converact-retention] worker failed', safeCode((error as Error).message));
  });
  void run();
  const timer = setInterval(run, config.interval_ms);
  timer.unref?.();
  return { stop: () => clearInterval(timer), runOnce: () => worker.runOnce() };
}

function emptySummary(): ConveractFabricRetentionBatchSummary {
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
