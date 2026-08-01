import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createControlledVoiceProviderState,
  startControlledVoiceProvider
} from '../scripts/converact-controlled-voice-provider.js';
import {
  findRustPbxReconciliationDialog,
  isTerminalRustPbxHangupState,
  runRustPbxRwiAcceptance
} from '../scripts/converact-rustpbx-rwi-acceptance.js';

test('RWI acceptance requires all deterministic active-call registry identifiers', () => {
  const callId = 'converact-rwi-run-a';
  assert.deepEqual(findRustPbxReconciliationDialog([{
    id: callId,
    call_id: callId,
    provider_call_id: callId,
    state: 'Talking',
    source: 'active_call_registry'
  }], callId), {
    id: callId,
    call_id: callId,
    provider_call_id: callId,
    state: 'Talking',
    source: 'active_call_registry'
  });

  for (const invalid of [
    null,
    {},
    [{ id: callId, call_id: callId, state: 'Talking', source: 'active_call_registry' }],
    [{ id: callId, call_id: callId, provider_call_id: callId, state: 'Talking', source: 'sip_dialog_layer' }],
    [{ id: callId, call_id: 'different', provider_call_id: callId, state: 'Talking', source: 'active_call_registry' }]
  ]) {
    assert.equal(findRustPbxReconciliationDialog(invalid, callId), null);
  }
});

test('RWI acceptance recognizes bounded RustPBX terminated dialog display states', () => {
  assert.equal(isTerminalRustPbxHangupState('not_found'), true);
  assert.equal(isTerminalRustPbxHangupState('completed'), true);
  assert.equal(
    isTerminalRustPbxHangupState('converact-call-local-remote(Terminated UacBye)'),
    true
  );
  assert.equal(isTerminalRustPbxHangupState('converact-call-local-remote(Confirmed)'), false);
  assert.equal(isTerminalRustPbxHangupState('talking'), false);
});

test('RWI acceptance runs preflight, deterministic originate, AMI reconciliation, and hangup', async () => {
  const token = 'controlled-rwi-acceptance-token';
  const running = await startControlledVoiceProvider({
    port: 0,
    state: createControlledVoiceProviderState({ token })
  });
  try {
    const report = await runRustPbxRwiAcceptance({
      CONVERACT_FABRIC_ACCEPTANCE_RUN_ID: 'controlled-a',
      RUSTPBX_BASE_URL: running.base_url,
      RUSTPBX_RWI_URL: running.rwi_url,
      RUSTPBX_ACCEPTANCE_DESTINATION: 'sip:uas@127.0.0.1:5060',
      RUSTPBX_MANAGEMENT_TOKEN: token,
      RUSTPBX_RWI_TOKEN: token
    });

    assert.equal(report.rwi.ready, true);
    assert.equal(report.rwi.deterministic_call_id, true);
    assert.equal(report.rwi.hangup_state, 'succeeded');
    assert.deepEqual(report.hangup_verification, {
      control_plane_state: 'completed',
      control_plane_terminal: true,
      sip_signaling_evidence: 'external_sipp_required'
    });
    assert.equal(report.ami_reconciliation.state, 'succeeded');
    assert.equal(report.rwi.protocol_actions.includes('call.send_dtmf'), true);
    assert.equal(report.rwi.protocol_actions.includes('call.bridge'), true);
    assert.equal(report.rwi.protocol_actions.includes('supervisor.listen'), true);
    assert.equal(report.rwi.effective_capabilities.dtmf_send, true);
    assert.deepEqual(report.rwi.effective_capabilities.conference, {
      create: true, add: true, remove: true, destroy: true
    });
    assert.equal(report.rwi.effective_capabilities.park, false);
    assert.equal(report.rwi.effective_capabilities.pickup, false);
    assert.deepEqual(report.rwi.ivekit_composed_capabilities, {
      park: true,
      pickup: true,
      park_primitives: ['call.hold'],
      pickup_primitives: ['call.unhold', 'call.bridge']
    });
    assert.deepEqual(report.rwi.effective_capabilities.supervisor, {
      listen: false, whisper: false, barge: false, takeover: false
    });
    assert.equal(report.rwi.limitations.includes('supervisor_audio_mixing_unavailable'), true);
    assert.equal(report.ami_reconciliation.provider_call_id, 'converact-rwi-controlled-a');
    assert.equal(report.ami_reconciliation.source, 'active_call_registry');
    assert.equal(running.state.action_counts.get('originate-controlled-a'), 1);
    assert.equal(running.state.action_counts.get('hangup-controlled-a'), 1);
  } finally {
    await running.close();
  }
});
