import type { IvrPendingActionCompletionPort } from './ports.js';
import type { IvrSessionService } from './session-service.js';
import type { IvrSessionResult } from './session-service.js';

export interface IvrSessionActionCompletionOptions {
  on_transition?: (result: IvrSessionResult) => void | Promise<void>;
}

export class IvrSessionActionCompletion implements IvrPendingActionCompletionPort {
  constructor(
    private readonly sessions: IvrSessionService,
    private readonly options: IvrSessionActionCompletionOptions = {}
  ) {}

  async complete(input: Parameters<IvrPendingActionCompletionPort['complete']>[0]): Promise<void> {
    const result = await this.sessions.completeWorkerAction({
      tenant_id: input.action.tenant_id,
      action_id: input.action.id,
      worker_id: input.worker_id,
      result: input.result
    });
    await this.#notify(result);
  }

  async fail(input: Parameters<NonNullable<IvrPendingActionCompletionPort['fail']>>[0]): Promise<void> {
    const result = await this.sessions.failWorkerAction({
      tenant_id: input.action.tenant_id,
      action_id: input.action.id,
      worker_id: input.worker_id,
      error_code: input.error_code
    });
    await this.#notify(result);
  }

  async #notify(result: IvrSessionResult): Promise<void> {
    try {
      await this.options.on_transition?.(result);
    } catch {
      console.error('[ivr-session-event] post-commit publish failed');
    }
  }
}
