import type { IvrQueuePort } from '../ivr/ports.js';
import type { ContactCenterQueueService } from './queue-service.js';

export function createContactCenterIvrQueuePort(service: ContactCenterQueueService): IvrQueuePort {
  return {
    async enqueue(input) {
      const result = await service.enqueue(input);
      return { queue_entry_id: result.entry.id, position: result.position };
    }
  };
}
