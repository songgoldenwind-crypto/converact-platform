import type { VoiceCallService } from '../voice/call-service.js';
import type { ContactCenterOverflowVoicePort } from './ports.js';

export class IveKitVoiceOverflowAdapter implements ContactCenterOverflowVoicePort {
  readonly #calls: Pick<VoiceCallService, 'enqueueAction'>;

  constructor(input: { calls: Pick<VoiceCallService, 'enqueueAction'> }) {
    this.#calls = input.calls;
  }

  async enqueue(input: Parameters<ContactCenterOverflowVoicePort['enqueue']>[0]): Promise<{
    command_id: string;
  }> {
    const command = await this.#calls.enqueueAction({
      tenant_id: input.tenant_id,
      call_id: input.call_id,
      kind: input.action === 'hangup' ? 'hangup' : 'blind_transfer',
      payload: input.action === 'hangup'
        ? { reason: 'contact_center_overflow' }
        : { target: input.target, overflow_action: input.action },
      actor: 'system:contact-center',
      idempotency_key: input.idempotency_key
    });
    return { command_id: command.id };
  }
}
