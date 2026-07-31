import { IvrError } from '../errors.js';
import { observeIvrReconciliation } from '../metrics.js';
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
  max_reconciliations?: number;
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
  readonly #maxReconciliations: number;
  readonly #completion: IvrPendingActionCompletionPort | null;

  constructor(options: IvrPendingActionReconciliationWorkerOptions) {
    this.#actions = options.actions;
    this.#reconciler = options.reconciler;
    this.#workerId = identifier(options.worker_id);
    this.#now = options.now ?? (() => new Date());
    this.#limit = boundedInteger(options.limit, 50, 1, 200);
    this.#leaseMs = boundedInteger(options.lease_ms, 30_000, 1_000, 300_000);
    this.#retryMs = boundedInteger(options.retry_ms, 10_000, 1_000, 3_600_000);
    this.#maxReconciliations = boundedInteger(options.max_reconciliations, 20, 1, 1_000);
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
      let result: Awaited<ReturnType<IvrPendingActionReconciler['reconcile']>>;
      try {
        result = await this.#reconciler.reconcile(action);
      } catch {
        await this.#settleUnknown(action, 'provider_result_unknown', summary);
        continue;
      }
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
        observe(action.action_kind, 'succeeded');
      } else if (result.disposition === 'failed') {
        const errorCode = boundedErrorCode(result.error_code);
        if (this.#completion?.fail) {
          await this.#completion.fail({
            action, worker_id: this.#workerId, error_code: errorCode,
            result: result.result
          });
        } else {
          await this.#release(action.id, action.tenant_id, 'failed', errorCode, null);
        }
        summary.failed += 1;
        observe(action.action_kind, 'failed');
      } else {
        await this.#settleUnknown(action, boundedErrorCode(result.error_code), summary);
      }
    }
    return summary;
  }

  async #settleUnknown(
    action: import('../types.js').IvrPendingAction,
    errorCode: string,
    summary: IvrPendingActionReconciliationRunResult
  ): Promise<void> {
    if (action.reconciliation_count >= this.#maxReconciliations) {
      if (this.#completion?.fail) {
        await this.#completion.fail({
          action, worker_id: this.#workerId, error_code: errorCode
        });
      } else {
        await this.#release(action.id, action.tenant_id, 'failed', errorCode, null);
      }
      summary.failed += 1;
      observe(action.action_kind, 'failed');
      return;
    }
    await this.#release(
      action.id, action.tenant_id, 'uncertain', errorCode, this.#nextAttempt()
    );
    summary.uncertain += 1;
    observe(action.action_kind, 'uncertain');
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

function observe(kind: string, result: string): void {
  try {
    observeIvrReconciliation({ kind, result });
  } catch {
    // Metrics must never change durable reconciliation state.
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
