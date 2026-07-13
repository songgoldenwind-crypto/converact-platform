import { IvrError } from '../errors.js';
import type {
  IvrPendingActionCompletionPort,
  IvrPendingActionExecutor,
  IvrPendingActionRepository
} from '../ports.js';

export interface IvrPendingActionWorkerOptions {
  actions: IvrPendingActionRepository;
  executor: IvrPendingActionExecutor;
  worker_id: string;
  now?: () => Date;
  limit?: number;
  lease_ms?: number;
  retry_base_ms?: number;
  retry_max_ms?: number;
  completion?: IvrPendingActionCompletionPort;
}

export interface IvrPendingActionRunResult {
  claimed: number;
  succeeded: number;
  retry_wait: number;
  uncertain: number;
  failed: number;
}

export class IvrPendingActionWorker {
  readonly #actions: IvrPendingActionRepository;
  readonly #executor: IvrPendingActionExecutor;
  readonly #workerId: string;
  readonly #now: () => Date;
  readonly #limit: number;
  readonly #leaseMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #completion: IvrPendingActionCompletionPort | null;

  constructor(options: IvrPendingActionWorkerOptions) {
    this.#actions = options.actions;
    this.#executor = options.executor;
    this.#workerId = identifier(options.worker_id);
    this.#now = options.now ?? (() => new Date());
    this.#limit = boundedInteger(options.limit, 50, 1, 200);
    this.#leaseMs = boundedInteger(options.lease_ms, 30_000, 1_000, 300_000);
    this.#retryBaseMs = boundedInteger(options.retry_base_ms, 1_000, 100, 300_000);
    this.#retryMaxMs = boundedInteger(options.retry_max_ms, 60_000, this.#retryBaseMs, 3_600_000);
    this.#completion = options.completion ?? null;
  }

  async runTenant(tenantIdValue: string): Promise<IvrPendingActionRunResult> {
    const tenantId = identifier(tenantIdValue);
    const now = this.#timestamp();
    const claimed = await this.#actions.claimDue({
      tenant_id: tenantId,
      worker_id: this.#workerId,
      now,
      limit: this.#limit,
      lease_ms: this.#leaseMs
    });
    const result: IvrPendingActionRunResult = {
      claimed: claimed.length, succeeded: 0, retry_wait: 0, uncertain: 0, failed: 0
    };
    for (const action of claimed) {
      let output: Record<string, unknown>;
      try {
        output = await this.#executor.execute(action);
      } catch (error) {
        const classified = classifyError(error);
        if (classified.uncertain) {
          await this.#release(action, 'uncertain', classified.code, this.#backoff(action.attempt_count));
          result.uncertain += 1;
        } else if (classified.retryable && action.attempt_count < action.max_attempts) {
          await this.#release(action, 'retry_wait', classified.code, this.#backoff(action.attempt_count));
          result.retry_wait += 1;
        } else {
          if (this.#completion?.fail) {
            await this.#completion.fail({
              action, worker_id: this.#workerId, error_code: classified.code
            });
          } else {
            await this.#release(action, 'failed', classified.code, null);
          }
          result.failed += 1;
        }
        continue;
      }
      try {
        if (this.#completion) {
          await this.#completion.complete({ action, worker_id: this.#workerId, result: output });
        } else {
          await this.#actions.settle({
            tenant_id: action.tenant_id,
            action_id: action.id,
            worker_id: this.#workerId,
            state: 'succeeded',
            result: output,
            error_code: '',
            completed_at: this.#timestamp()
          });
        }
        result.succeeded += 1;
      } catch {
        await this.#release(action, 'uncertain', 'provider_result_unknown', this.#backoff(action.attempt_count));
        result.uncertain += 1;
      }
    }
    return result;
  }

  #release(
    action: import('../types.js').IvrPendingAction,
    state: 'retry_wait' | 'uncertain' | 'failed',
    code: string,
    nextAttemptAt: string | null
  ): Promise<import('../types.js').IvrPendingAction> {
    return this.#actions.release({
      tenant_id: action.tenant_id,
      action_id: action.id,
      worker_id: this.#workerId,
      state,
      next_attempt_at: nextAttemptAt,
      error_code: code,
      error_message: code,
      now: this.#timestamp()
    });
  }

  #backoff(attempt: number): string {
    const exponent = Math.max(0, Math.min(20, attempt - 1));
    const delay = Math.min(this.#retryMaxMs, this.#retryBaseMs * (2 ** exponent));
    return new Date(this.#now().getTime() + delay).toISOString();
  }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new IvrError({ code: 'internal_error', status: 500 });
    }
    return value.toISOString();
  }
}

function classifyError(error: unknown): { code: string; retryable: boolean; uncertain: boolean } {
  if (error instanceof IvrError) {
    return {
      code: error.code,
      retryable: error.retryable,
      uncertain: error.code === 'provider_timeout' || error.code === 'provider_result_unknown'
    };
  }
  return { code: 'internal_error', retryable: false, uncertain: false };
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}
