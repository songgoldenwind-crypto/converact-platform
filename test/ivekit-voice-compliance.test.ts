import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  VoicePolicyComplianceService,
  type VoiceCallUnitOfWork,
  type VoiceCallUnitOfWorkContext,
  type VoiceConsent,
  type VoicePolicy
} from '../src/agent-runtime/converact/voice/index.js';

const NOW = '2026-07-13T09:00:00.000Z';

test('Voice compliance requires a matching current outbound consent when policy demands it', async () => {
  const fixture = complianceFixture({
    policy: policy({ require_outbound_consent: true }),
    consents: [consent({
      subject_ref_type: 'order', subject_ref_id: 'order-a',
      business_ref_type: 'order', business_ref_id: 'order-a',
      consent_type: 'outbound_call', evidence_ref: 'evidence-outbound-a'
    })]
  });
  const service = new VoicePolicyComplianceService({
    unit_of_work: fixture.unitOfWork, now: () => new Date(NOW)
  });

  assert.deepEqual(await service.authorize({
    tenant_id: 'tenant-a', call_id: 'call-a', command: 'originate',
    actor_identity: 'agent-a', business_ref: { type: 'order', id: 'order-a' }
  }), { allowed: true, reason: 'consent', evidence_ref: 'evidence-outbound-a' });
  assert.equal(fixture.listInputs[0]?.tenant_id, 'tenant-a');
  assert.equal(fixture.listInputs[0]?.subject_ref_type, 'order');
  assert.equal(fixture.listInputs[0]?.subject_ref_id, 'order-a');

  assert.deepEqual(await service.authorize({
    tenant_id: 'tenant-a', call_id: 'call-b', command: 'originate',
    actor_identity: 'agent-a', business_ref: { type: 'order', id: 'order-b' }
  }), { allowed: false, reason: 'consent_required', evidence_ref: '' });
});

test('Voice compliance accepts policy evidence when explicit outbound consent is disabled', async () => {
  const fixture = complianceFixture({ policy: policy({ require_outbound_consent: false }) });
  const service = new VoicePolicyComplianceService({ unit_of_work: fixture.unitOfWork });
  assert.deepEqual(await service.authorize({
    tenant_id: 'tenant-a', call_id: 'call-a', command: 'originate',
    actor_identity: 'agent-a', business_ref: { type: 'order', id: 'order-a' }
  }), { allowed: true, reason: 'policy', evidence_ref: 'voice-policy:policy-a:3' });
});

test('Voice compliance enforces recording disabled consent-required and always modes', async () => {
  const granted = consent({
    subject_ref_type: 'call', subject_ref_id: 'call-a', consent_type: 'recording',
    evidence_ref: 'evidence-recording-a'
  });
  const fixture = complianceFixture({
    policy: policy({ recording_mode: 'consent_required' }), consents: [granted]
  });
  const service = new VoicePolicyComplianceService({
    unit_of_work: fixture.unitOfWork, now: () => new Date(NOW)
  });
  assert.deepEqual(await service.authorize({
    tenant_id: 'tenant-a', call_id: 'call-a', command: 'recording_start', actor_identity: 'agent-a'
  }), { allowed: true, reason: 'consent', evidence_ref: 'evidence-recording-a' });

  fixture.policy.recording_mode = 'disabled';
  assert.deepEqual(await service.authorize({
    tenant_id: 'tenant-a', call_id: 'call-a', command: 'recording_start', actor_identity: 'agent-a'
  }), { allowed: false, reason: 'recording_disabled', evidence_ref: '' });

  fixture.policy.recording_mode = 'always';
  assert.deepEqual(await service.authorize({
    tenant_id: 'tenant-a', call_id: 'call-a', command: 'recording_start', actor_identity: 'agent-a'
  }), { allowed: true, reason: 'policy', evidence_ref: 'voice-policy:policy-a:3' });
});

test('Voice compliance rejects inactive policy and expired or revoked consent', async () => {
  const expired = consent({
    subject_ref_type: 'order', subject_ref_id: 'order-a', consent_type: 'outbound_call',
    status: 'granted', expires_at: '2026-07-13T08:59:59.000Z'
  });
  const revoked = consent({
    id: 'consent-revoked', subject_ref_type: 'order', subject_ref_id: 'order-a',
    consent_type: 'outbound_call', status: 'revoked'
  });
  const fixture = complianceFixture({
    policy: policy({ require_outbound_consent: true }), consents: [expired, revoked]
  });
  const service = new VoicePolicyComplianceService({
    unit_of_work: fixture.unitOfWork, now: () => new Date(NOW)
  });
  assert.equal((await service.authorize({
    tenant_id: 'tenant-a', call_id: 'call-a', command: 'originate', actor_identity: 'agent-a',
    business_ref: { type: 'order', id: 'order-a' }
  })).allowed, false);

  fixture.policy.status = 'disabled';
  assert.deepEqual(await service.authorize({
    tenant_id: 'tenant-a', call_id: 'call-a', command: 'hangup', actor_identity: 'agent-a'
  }), { allowed: false, reason: 'policy_inactive', evidence_ref: '' });
});

function complianceFixture(input: { policy: VoicePolicy; consents?: VoiceConsent[] }) {
  const listInputs: Array<Record<string, unknown>> = [];
  const configuration = {
    async getPolicy() { return input.policy; },
    async listConsents(request: Record<string, unknown>) {
      listInputs.push(request);
      return {
        items: (input.consents || []).filter((item) =>
          (!request.subject_ref_type || item.subject_ref_type === request.subject_ref_type)
          && (!request.subject_ref_id || item.subject_ref_id === request.subject_ref_id)),
        next_cursor: null
      };
    }
  };
  const context = { configuration } as unknown as VoiceCallUnitOfWorkContext;
  const unitOfWork: VoiceCallUnitOfWork = {
    async run<T>(_tenantId: string, operation: (context: VoiceCallUnitOfWorkContext) => Promise<T>): Promise<T> {
      return operation(context);
    }
  };
  return { unitOfWork, policy: input.policy, listInputs };
}

function policy(patch: Partial<VoicePolicy> = {}): VoicePolicy {
  return {
    id: 'policy-a', tenant_id: 'tenant-a', require_outbound_consent: true,
    recording_mode: 'consent_required', recording_retention_days: 30,
    require_ai_disclosure: true, allowed_calling_windows: [], masking_policy: {},
    status: 'active', revision: 3, created_by: 'admin', updated_by: 'admin',
    created_at: NOW, updated_at: NOW, ...patch
  };
}

function consent(patch: Partial<VoiceConsent> = {}): VoiceConsent {
  return {
    id: 'consent-a', tenant_id: 'tenant-a', subject_ref_type: 'call', subject_ref_id: 'call-a',
    business_ref_type: 'order', business_ref_id: 'order-a', consent_type: 'recording',
    status: 'granted', evidence_ref: 'evidence-a', granted_by: 'customer-a', expires_at: null,
    created_at: NOW, updated_at: NOW, ...patch
  };
}
