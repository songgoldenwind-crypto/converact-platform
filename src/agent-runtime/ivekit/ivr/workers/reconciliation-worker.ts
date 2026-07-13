import { IvrError } from '../errors.js';
import type {
  IvrPendingActionCompletionPort,
  IvrPendingActionReconciler,
  IvrPendingActionRepository
} from '../ports.js';

export interface IvrPendingActionReconciliationWorkerOptions {
  actions: IvrPendingActionRepository;
  reconciler: IvrPendingActionReconciler;
  worker_id: string;
  now?: () => Date;
  limit?: number;
  lease_ms?: number;
  retry_ms?: number;
  completion?: IvrPendingActionCompletionPort;
}

export interface IvrPendingActionReconciliationRunResult {
  claimed: number;
  succeeded: number;
  failed: number;
  uncertain: number;
}

export class IvrPendingActionReconciliationWorker {
  readonly #actions: IvrPendingActionRepository;
  readonly #reconciler: IvrPendingActionReconciler;
  readonly #workerId: string;
  readonly #now: () => Date;
  readonly #limit: number;
  readonly #leaseMs: number;
  readonly #retryMs: number;
  readonly #completion: IvrPendingActionCompletionPort | null;

  constructor(options: IvrPendingActionReconciliationWorkerOptions) {
    this.#actions = options.actions;
    this.#reconciler = options.reconciler;
    this.#workerId = identifier(options.worker_id);
    this.#now = options.now ?? (() => new Date());
    this.#limit = boundedInteger(options.limit, 50, 1, 200);
    this.#leaseMs = boundedInteger(options.lease_ms, 30_000, 1_000, 300_000);
    this.#retryMs = boundedInteger(options.retry_ms, 10_000, 1_000, 3_600_000);
    this.#completion = options.completion ?? null;
  }

  async runTenant(tenantIdValue: string): Promise<IvrPendingActionReconciliationRunResult> {
    const tenantId = identifier(tenantIdValue);
    const actions = await this.#actions.claimUncertain({
      tenant_id: tenantId,
      worker_id: this.#workerId,
      now: this.#timestamp(),
      limit: this.#limit,
      lease_ms: this.#leaseMs
    });
    const summary: IvrPendingActionReconciliationRunResult = {
      claimed: actions.length, succeeded: 0, failed: 0, uncertain: 0
    };
    for (const action of actions) {
      try {
        const result = await this.#reconciler.reconcile(action);
        if (result.disposition === 'succeeded') {
          if (this.#completion) {
            await this.#completion.complete({ action, worker_id: this.#workerId, result: result.result });
          } else {
            await this.#actions.settle({
              tenant_id: action.tenant_id,
              action_id: action.id,
              worker_id: this.#workerId,
              state: 'succeeded',
              result: result.result,
              error_code: '',
              completed_at: this.#timestamp()
            });
          }
          summary.succeeded += 1;
        } else if (result.disposition === 'failed') {
          await this.#release(action.id, action.tenant_id, 'failed', boundedErrorCode(result.error_code), null);
          summary.failed += 1;
        } else {
          await this.#release(
            action.id, action.tenant_id, 'uncertain', boundedErrorCode(result.error_code), this.#nextAttempt()
          );
          summary.uncertain += 1;
        }
      } catch {
        await this.#release(action.id, action.tenant_id, 'uncertain', 'provider_result_unknown', this.#nextAttempt());
        summary.uncertain += 1;
      }
    }
    return summary;
  }

  #release(
    actionId: string,
    tenantId: string,
    state: 'uncertain' | 'failed',
    errorCode: string,
    nextAttemptAt: string | null
  ) {
    return this.#actions.release({
      tenant_id: tenantId,
      action_id: actionId,
      worker_id: this.#workerId,
      state,
      next_attempt_at: nextAttemptAt,
      error_code: errorCode,
      error_message: errorCode,
      now: this.#timestamp()
    });
  }

  #nextAttempt(): string {
    return new Date(this.#now().getTime() + this.#retryMs).toISOString();
  }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new IvrError({ code: 'internal_error', status: 500 });
    }
    return value.toISOString();
  }
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return value;
}

function boundedErrorCode(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : 'provider_result_unknown';
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}
