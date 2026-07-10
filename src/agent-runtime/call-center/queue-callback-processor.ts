import type { OutboundTaskStore } from './outbound-task-store.js';
import { QueueCallbackService } from './inbound/queue-callback.js';

export class QueueCallbackProcessor {
  constructor(
    private readonly db: unknown,
    private readonly outboundTaskStore: OutboundTaskStore
  ) {}

  processPending(limit = 5): number {
    const service = new QueueCallbackService(this.db);
    const pending = service.pickPending(limit);
    let created = 0;

    for (const callback of pending) {
      const marked = service.markDialing(callback.id);
      if (!marked) continue;

      const task = this.outboundTaskStore.createTask({
        tenant_id: callback.tenant_id,
        phone_number: callback.phone_number,
        channel: 'pstn_voice',
        priority: 8,
        max_attempts: 2,
        strategy: {
          source: 'queue_callback',
          queue_callback_id: callback.id,
          queue_id: callback.queue_id,
          original_call_session_id: callback.call_session_id
        }
      });

      void task.id;
      created += 1;
    }

    return created;
  }
}
