import { VoiceCallService } from '../voice/call-service.js';
import type { VoiceAddressProtector, VoiceCallRepository } from '../voice/ports.js';
import type { ContactCenterCallbackVoicePort } from './ports.js';

export class ConveractFabricVoiceCallbackAdapter implements ContactCenterCallbackVoicePort {
  constructor(private readonly options: {
    calls: VoiceCallRepository;
    service: VoiceCallService;
    address_protector: VoiceAddressProtector;
  }) {}

  async getSourceCall(tenantId: string, callId: string) {
    const call = await this.options.calls.get(tenantId, callId);
    return call ? {
      id: call.id,
      tenant_id: call.tenant_id,
      profile_id: call.provider_profile_id,
      direction: call.direction,
      business_ref: { type: call.business_ref.type, id: call.business_ref.id }
    } : null;
  }

  async createOutbound(input: Parameters<ContactCenterCallbackVoicePort['createOutbound']>[0]) {
    const callback = input.callback;
    const source = await this.options.calls.get(callback.tenant_id, callback.source_call_id);
    if (!source) throw new Error('callback source call not found');
    const sourceSide = source.direction === 'inbound' ? 'to' : 'from';
    const protectedFrom = await this.options.calls.getProtectedAddress(
      callback.tenant_id,
      source.id,
      sourceSide
    );
    if (!protectedFrom) throw new Error('callback source address not found');
    const clearFrom = await this.options.address_protector.reveal(
      callback.tenant_id,
      protectedFrom.ciphertext,
      protectedFrom.kind
    );
    const created = await this.options.service.createOutbound({
      tenant_id: callback.tenant_id,
      profile_id: source.provider_profile_id,
      from: { kind: protectedFrom.kind, value: clearFrom },
      to: { kind: callback.address_kind, value: input.clear_target },
      business_ref: { type: callback.business_ref_type, id: callback.business_ref_id },
      actor: 'converact-contact-center-callback',
      idempotency_key: `cc-callback:${callback.id}:attempt:${input.attempt}`,
      metadata: {
        callback_id: callback.id,
        queue_id: callback.queue_id,
        source_call_id: callback.source_call_id
      }
    });
    return { call_id: created.call.id };
  }

  async getCallState(tenantId: string, callId: string) {
    const call = await this.options.calls.get(tenantId, callId);
    return call ? { state: call.state, termination_reason: call.termination_reason } : null;
  }
}
