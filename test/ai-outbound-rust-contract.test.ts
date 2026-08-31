import assert from 'node:assert/strict';
import test from 'node:test';

import { mapLegacyOutboundTask } from
  '../src/agent-runtime/converact/contact-center/ai-outbound-compat.js';

const legacy = {
  tenant_id: 'tenant-a',
  agent_spec_id: 'agent-a',
  campaign_id: 'campaign-a',
  campaign_contact_id: 'contact-a',
  language: 'zh-CN',
  max_attempts: 3,
  status: 'pending' as const,
};

test('legacy retry maps to a new physical attempt identity', () => {
  const first = mapLegacyOutboundTask(legacy, {
    attempt_id: 'attempt-001',
    attempt_number: 1,
    previous_attempt_id: null,
  });
  const retry = mapLegacyOutboundTask(legacy, {
    attempt_id: 'attempt-002',
    attempt_number: 2,
    previous_attempt_id: first.call_attempt_id,
  });

  assert.equal(first.tenant_id, legacy.tenant_id);
  assert.equal(first.agent_definition_id, legacy.agent_spec_id);
  assert.equal(first.language, legacy.language);
  assert.equal(first.max_attempts, legacy.max_attempts);
  assert.equal(first.state, 'planned');
  assert.notEqual(retry.call_attempt_id, first.call_attempt_id);
  assert.equal(retry.previous_attempt_id, first.call_attempt_id);
});

test('legacy mapper rejects reused or missing retry lineage', () => {
  assert.throws(
    () => mapLegacyOutboundTask(legacy, {
      attempt_id: 'attempt-001',
      attempt_number: 2,
      previous_attempt_id: 'attempt-001',
    }),
    /legacy_outbound_attempt_lineage_invalid/,
  );
  assert.throws(
    () => mapLegacyOutboundTask(legacy, {
      attempt_id: 'attempt-002',
      attempt_number: 2,
      previous_attempt_id: null,
    }),
    /legacy_outbound_attempt_lineage_invalid/,
  );
});

test('legacy mapper accepts only the frozen pending compatibility state', () => {
  assert.throws(
    () => mapLegacyOutboundTask({ ...legacy, status: 'claimed' as never }, {
      attempt_id: 'attempt-001',
      attempt_number: 1,
      previous_attempt_id: null,
    }),
    /legacy_outbound_mapping_invalid/,
  );
});
