import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IveKitVoiceCallbackAdapter,
  type ContactCenterCallbackRecord
} from '../src/agent-runtime/ivekit/contact-center/index.js';
import {
  type VoiceAddressProtector,
  type VoiceCall,
  type VoiceCallRepository,
  VoiceCallService
} from '../src/agent-runtime/ivekit/voice/index.js';

test('Contact Center Voice adapter reuses inbound DID and durable Voice outbound service', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const call = voiceCall();
  const calls = {
    async get(_tenantId: string, callId: string) {
      if (callId === 'call-a') return call;
      if (callId === 'outbound-a') return { ...call, id: 'outbound-a', state: 'active' };
      return null;
    },
    async getProtectedAddress(_tenantId: string, _callId: string, side: 'from' | 'to') {
      observed.push({ operation: 'getProtectedAddress', side });
      return side === 'to' ? {
        kind: 'e164' as const, ciphertext: 'encrypted-did', hmac: 'a'.repeat(64),
        redacted: '+86******8000'
      } : null;
    }
  } as unknown as VoiceCallRepository;
  const protector = {
    async protect() { throw new Error('not used'); },
    async reveal(_tenantId: string, ciphertext: string) {
      observed.push({ operation: 'reveal', ciphertext });
      return '+8613800138000';
    }
  } as VoiceAddressProtector;
  const service = {
    async createOutbound(input: Record<string, unknown>) {
      observed.push({ operation: 'createOutbound', ...input });
      return { call: { id: 'outbound-a' }, command: {} };
    }
  } as unknown as VoiceCallService;
  const adapter = new IveKitVoiceCallbackAdapter({ calls, service, address_protector: protector });

  const source = await adapter.getSourceCall('tenant-a', 'call-a');
  assert.deepEqual(source?.business_ref, { type: 'ticket', id: 'ticket-a' });
  assert.deepEqual(await adapter.createOutbound({
    callback: callbackRecord(), clear_target: '+8613900139000', attempt: 2
  }), { call_id: 'outbound-a' });
  assert.deepEqual(await adapter.getCallState('tenant-a', 'outbound-a'), {
    state: 'active', termination_reason: ''
  });
  assert.deepEqual(observed[0], { operation: 'getProtectedAddress', side: 'to' });
  assert.deepEqual(observed[1], { operation: 'reveal', ciphertext: 'encrypted-did' });
  const outbound = observed[2]!;
  assert.equal(outbound.profile_id, 'profile-a');
  assert.deepEqual(outbound.from, { kind: 'e164', value: '+8613800138000' });
  assert.deepEqual(outbound.to, { kind: 'e164', value: '+8613900139000' });
  assert.equal(outbound.idempotency_key, 'cc-callback:callback-a:attempt:2');
  assert.deepEqual(outbound.business_ref, { type: 'ticket', id: 'ticket-a' });
});

function voiceCall(): VoiceCall {
  return {
    id: 'call-a', tenant_id: 'tenant-a', business_ref: { type: 'ticket', id: 'ticket-a' },
    provider_profile_id: 'profile-a', provider_call_id: 'provider-a', provider_dialog_id: '',
    media_call_id: null, direction: 'inbound', state: 'active',
    from: { kind: 'e164', redacted: '+86******9000' },
    to: { kind: 'e164', redacted: '+86******8000' },
    idempotency_key: 'source-call-key', initiated_by: 'rustpbx', metadata: {},
    ringing_at: null, answered_at: '2026-07-13T00:00:00.000Z', ended_at: null,
    termination_reason: '', revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function callbackRecord(): ContactCenterCallbackRecord {
  return {
    id: 'callback-a', tenant_id: 'tenant-a', queue_id: 'queue-a',
    queue_entry_id: 'entry-a', source_call_id: 'call-a', outbound_call_id: null,
    business_ref_type: 'ticket', business_ref_id: 'ticket-a', address_kind: 'e164',
    address_ciphertext: 'encrypted-target', address_hmac: 'b'.repeat(64),
    address_redacted: '+86******9000', state: 'scheduled',
    scheduled_for: '2026-07-13T00:05:00.000Z', attempt_count: 1, max_attempts: 3,
    idempotency_key: 'callback-key-a', requested_by: 'agent-a', cancelled_by: '',
    failure_code: '', revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z',
    completed_at: null
  };
}
