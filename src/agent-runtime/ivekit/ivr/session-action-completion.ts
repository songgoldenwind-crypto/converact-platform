import type { IvrPendingActionCompletionPort } from './ports.js';
import type { IvrSessionService } from './session-service.js';

export class IvrSessionActionCompletion implements IvrPendingActionCompletionPort {
  constructor(private readonly sessions: IvrSessionService) {}

  async complete(input: Parameters<IvrPendingActionCompletionPort['complete']>[0]): Promise<void> {
    await this.sessions.completeWorkerAction({
      tenant_id: input.action.tenant_id,
      action_id: input.action.id,
      worker_id: input.worker_id,
      result: input.result
    });
  }
}
