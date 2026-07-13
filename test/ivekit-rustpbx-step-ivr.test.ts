import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RustPbxStepIvrAdapter
} from '../src/agent-runtime/ivekit/ivr/index.js';
import { VoiceError } from '../src/agent-runtime/ivekit/voice/index.js';

test('RustPBX Step IVR validates identity, sequence, revision, and safe metadata', () => {
  const adapter = new RustPbxStepIvrAdapter({ profile_id: 'profile-a' });
  const normalized = adapter.normalizeRequest({
    profile_id: 'profile-a', provider_session_id: 'provider-session-a',
    event_sequence: 5, action_revision: 3,
    event: { type: 'dtmf', digit: '5' },
    metadata: { request_id: 'request-a', phone: '+8613800138000', sdp: 'private-sdp' }
  }, { last_event_sequence: 4, last_action_revision: 2 });
  assert.equal(normalized.disposition, 'advance');
  assert.equal(normalized.event.digit, '5');
  assert.equal(JSON.stringify(normalized.safe_metadata).includes('+8613800138000'), false);
  assert.equal(JSON.stringify(normalized.safe_metadata).includes('private-sdp'), false);

  assert.equal(adapter.normalizeRequest({
    profile_id: 'profile-a', provider_session_id: 'provider-session-a',
    event_sequence: 4, action_revision: 2,
    event: { type: 'audio_complete' }
  }, { last_event_sequence: 4, last_action_revision: 2 }).disposition, 'replay');

  for (const request of [
    {
      profile_id: 'wrong-profile', provider_session_id: 'provider-session-a',
      event_sequence: 5, action_revision: 3, event: { type: 'dtmf', digit: '5' }
    },
    {
      profile_id: 'profile-a', provider_session_id: 'provider-session-a',
      event_sequence: 3, action_revision: 2, event: { type: 'audio_complete' }
    },
    {
      profile_id: 'profile-a', provider_session_id: 'provider-session-a',
      event_sequence: 4, action_revision: 3, event: { type: 'audio_complete' }
    }
  ]) {
    assert.throws(
      () => adapter.normalizeRequest(request, { last_event_sequence: 4, last_action_revision: 2 }),
      (error: unknown) => error instanceof VoiceError
        && ['validation_failed', 'event_sequence_conflict'].includes(error.code)
    );
  }
});

test('RustPBX Step IVR maps supported portable actions exactly', () => {
  const adapter = new RustPbxStepIvrAdapter({ profile_id: 'profile-a' });
  assert.deepEqual(adapter.mapAction({
    kind: 'play', node_id: 'play-a', payload: { text: 'Welcome', interruptible: true }
  }), { type: 'prompt', tts_text: 'Welcome', interruptible: true });
  assert.deepEqual(adapter.mapAction({
    kind: 'collect', node_id: 'menu-a',
    payload: { mode: 'menu', prompt: 'Press one', timeout_ms: 5_000, max_retries: 2 }
  }), { type: 'dtmf_menu', tts_text: 'Press one', timeout_ms: 5_000, max_retries: 2 });
  assert.deepEqual(adapter.mapAction({
    kind: 'collect', node_id: 'collect-a',
    payload: { prompt: 'Account', max_digits: 8, timeout_ms: 8_000, end_key: '#', variable: 'account' }
  }), {
    type: 'collect_dtmf', tts_text: 'Account', num_digits: 8,
    timeout_ms: 8_000, end_key: '#', variable: 'account'
  });
  assert.deepEqual(adapter.mapAction({
    kind: 'queue', node_id: 'queue-a', payload: { queue_id: 'support' }
  }), { type: 'queue', queue: 'support' });
  assert.deepEqual(adapter.mapAction({
    kind: 'transfer', node_id: 'transfer-a', payload: { target: 'sip:1001@pbx.internal' }
  }), { type: 'transfer', target: 'sip:1001@pbx.internal' });
  assert.deepEqual(adapter.mapAction({
    kind: 'record', node_id: 'record-a', payload: { max_duration_ms: 60_000, beep: true }
  }), { type: 'record', max_duration_ms: 60_000, beep: true });
  assert.deepEqual(adapter.mapAction({
    kind: 'hangup', node_id: 'hangup-a', payload: { prompt: 'Goodbye' }
  }), { type: 'play_and_hangup', tts_text: 'Goodbye' });
  assert.deepEqual(adapter.mapAction({
    kind: 'wait', node_id: 'wait-a', payload: { duration_ms: 2_000 }
  }), { type: 'wait', duration_ms: 2_000 });
});

test('RustPBX Step IVR rejects executor-owned actions and malformed DTMF', () => {
  const adapter = new RustPbxStepIvrAdapter({ profile_id: 'profile-a' });
  for (const kind of ['webhook', 'media'] as const) {
    assert.throws(
      () => adapter.mapAction({ kind, node_id: `${kind}-a`, payload: {} }),
      hasVoiceCode('capability_unavailable')
    );
  }
  assert.throws(() => adapter.normalizeRequest({
    profile_id: 'profile-a', provider_session_id: 'provider-session-a',
    event_sequence: 1, action_revision: 1,
    event: { type: 'dtmf', digit: '12' }
  }, { last_event_sequence: 0, last_action_revision: 0 }), hasVoiceCode('validation_failed'));
});

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
