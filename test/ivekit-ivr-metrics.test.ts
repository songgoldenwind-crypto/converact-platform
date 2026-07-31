import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ivrMetricDefinitions,
  observeIvrPendingAction,
  observeIvrReconciliation,
  observeIvrSessionEvent
} from '../src/agent-runtime/ivekit/ivr/metrics.js';
import { metricsRegistry } from '../src/metrics.js';

test('IVR metrics expose only bounded labels without tenant or resource identities', () => {
  const forbidden = new Set([
    'tenant_id', 'session_id', 'call_id', 'business_ref', 'profile_id', 'flow_id',
    'node_id', 'action_id', 'trace_id'
  ]);
  for (const definition of ivrMetricDefinitions) {
    assert.equal(definition.name.startsWith('opc_ivekit_ivr_'), true);
    assert.equal(definition.labels.some((label) => forbidden.has(label)), false);
  }
});

test('IVR metrics collapse attacker-controlled kinds, results, and errors', async () => {
  observeIvrPendingAction({
    kind: 'attacker-action', result: 'attacker-result',
    error_code: 'attacker-error', duration_seconds: 0.25
  });
  observeIvrReconciliation({ kind: 'webhook', result: 'attacker-result' });
  observeIvrSessionEvent({ type: 'attacker-event', state: 'attacker-state' });

  const output = await metricsRegistry.metrics();
  assert.match(output, /opc_ivekit_ivr_pending_actions_total\{kind="other",result="other",error_code="other"\}/);
  assert.match(output, /opc_ivekit_ivr_reconciliations_total\{kind="webhook",result="other"\}/);
  assert.match(output, /opc_ivekit_ivr_session_events_total\{event_type="other",state="other"\}/);
  assert.doesNotMatch(output, /attacker-action|attacker-result|attacker-error/);
});
