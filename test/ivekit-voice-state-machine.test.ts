import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  VoiceError,
  isVoiceTerminalState,
  mergeProviderCallState,
  transitionVoiceCall,
  type VoiceCallState,
  type VoiceCallTransition
} from '../src/agent-runtime/ivekit/voice/index.js';

const ALLOWED_TRANSITIONS: ReadonlyArray<{
  from: VoiceCallState;
  transition: VoiceCallTransition;
  to: VoiceCallState;
}> = [
  { from: 'planned', transition: 'queue', to: 'queued' },
  { from: 'planned', transition: 'cancel', to: 'cancelled' },
  { from: 'planned', transition: 'miss', to: 'missed' },
  { from: 'planned', transition: 'reject', to: 'rejected' },
  { from: 'planned', transition: 'fail', to: 'failed' },
  { from: 'planned', transition: 'timeout', to: 'timed_out' },
  { from: 'queued', transition: 'dial', to: 'dialing' },
  { from: 'queued', transition: 'cancel', to: 'cancelled' },
  { from: 'queued', transition: 'miss', to: 'missed' },
  { from: 'queued', transition: 'reject', to: 'rejected' },
  { from: 'queued', transition: 'fail', to: 'failed' },
  { from: 'queued', transition: 'timeout', to: 'timed_out' },
  { from: 'dialing', transition: 'ring', to: 'ringing' },
  { from: 'dialing', transition: 'answer', to: 'active' },
  { from: 'dialing', transition: 'cancel', to: 'cancelled' },
  { from: 'dialing', transition: 'miss', to: 'missed' },
  { from: 'dialing', transition: 'reject', to: 'rejected' },
  { from: 'dialing', transition: 'fail', to: 'failed' },
  { from: 'dialing', transition: 'timeout', to: 'timed_out' },
  { from: 'ringing', transition: 'answer', to: 'active' },
  { from: 'ringing', transition: 'cancel', to: 'cancelled' },
  { from: 'ringing', transition: 'miss', to: 'missed' },
  { from: 'ringing', transition: 'reject', to: 'rejected' },
  { from: 'ringing', transition: 'fail', to: 'failed' },
  { from: 'ringing', transition: 'timeout', to: 'timed_out' },
  { from: 'active', transition: 'hold', to: 'held' },
  { from: 'active', transition: 'transfer', to: 'transferring' },
  { from: 'active', transition: 'complete', to: 'completed' },
  { from: 'active', transition: 'fail', to: 'failed' },
  { from: 'held', transition: 'resume', to: 'active' },
  { from: 'held', transition: 'transfer', to: 'transferring' },
  { from: 'held', transition: 'complete', to: 'completed' },
  { from: 'held', transition: 'fail', to: 'failed' },
  { from: 'transferring', transition: 'resume', to: 'active' },
  { from: 'transferring', transition: 'complete', to: 'completed' },
  { from: 'transferring', transition: 'fail', to: 'failed' }
];

const TERMINAL_STATES: VoiceCallState[] = [
  'completed',
  'cancelled',
  'missed',
  'rejected',
  'failed',
  'timed_out'
];

test('Voice call reducer implements the complete allowed transition table', () => {
  for (const item of ALLOWED_TRANSITIONS) {
    const result = transitionVoiceCall(item.from, item.transition);
    assert.equal(result.state, item.to, `${item.from} --${item.transition}--> ${item.to}`);
    assert.equal(result.changed, true);
  }
});

test('Voice call reducer rejects invalid and terminal transitions with stable codes', () => {
  assert.throws(
    () => transitionVoiceCall('planned', 'hold'),
    (error: unknown) => error instanceof VoiceError
      && error.code === 'invalid_call_transition'
      && error.retryable === false
  );

  for (const state of TERMINAL_STATES) {
    assert.equal(isVoiceTerminalState(state), true);
    assert.throws(
      () => transitionVoiceCall(state, 'answer'),
      (error: unknown) => error instanceof VoiceError
        && error.code === 'terminal_call_state'
        && error.retryable === false
    );
  }
  assert.equal(isVoiceTerminalState('active'), false);
});

test('Voice call reducer sets lifecycle timestamps once and remains deterministic', () => {
  const ringing = transitionVoiceCall('dialing', 'ring', {
    occurred_at: '2026-07-13T01:00:00.000Z'
  });
  assert.deepEqual(ringing, {
    state: 'ringing',
    ringing_at: '2026-07-13T01:00:00.000Z',
    answered_at: null,
    ended_at: null,
    changed: true
  });

  const answered = transitionVoiceCall(ringing.state, 'answer', {
    ...ringing,
    occurred_at: '2026-07-13T01:00:05.000Z'
  });
  assert.equal(answered.ringing_at, '2026-07-13T01:00:00.000Z');
  assert.equal(answered.answered_at, '2026-07-13T01:00:05.000Z');

  const completed = transitionVoiceCall(answered.state, 'complete', {
    ...answered,
    occurred_at: '2026-07-13T01:05:00.000Z'
  });
  assert.equal(completed.answered_at, '2026-07-13T01:00:05.000Z');
  assert.equal(completed.ended_at, '2026-07-13T01:05:00.000Z');
});

test('Provider state merge advances over missing events and ignores duplicates or regressions', () => {
  const ringing = mergeProviderCallState('planned', 'ringing', {
    occurred_at: '2026-07-13T02:00:00.000Z'
  });
  assert.equal(ringing.state, 'ringing');
  assert.equal(ringing.ringing_at, '2026-07-13T02:00:00.000Z');

  const duplicate = mergeProviderCallState(ringing.state, 'ringing', ringing);
  assert.deepEqual(duplicate, { ...ringing, changed: false });

  const answered = mergeProviderCallState(ringing.state, 'connected', {
    ...ringing,
    occurred_at: '2026-07-13T02:00:02.000Z'
  });
  assert.equal(answered.state, 'active');
  assert.equal(answered.answered_at, '2026-07-13T02:00:02.000Z');
  assert.equal(mergeProviderCallState(ringing.state, 'talking', ringing).state, 'active');

  const lateRinging = mergeProviderCallState(answered.state, 'ringing', answered);
  assert.deepEqual(lateRinging, { ...answered, changed: false });
});

test('Provider state merge never revives terminal calls but permits CDR timestamp enrichment', () => {
  const enriched = mergeProviderCallState('completed', 'completed', {
    ringing_at: '2026-07-13T03:00:00.000Z',
    answered_at: '2026-07-13T03:00:02.000Z',
    ended_at: null,
    occurred_at: '2026-07-13T03:10:00.000Z'
  });
  assert.deepEqual(enriched, {
    state: 'completed',
    ringing_at: '2026-07-13T03:00:00.000Z',
    answered_at: '2026-07-13T03:00:02.000Z',
    ended_at: '2026-07-13T03:10:00.000Z',
    changed: true
  });

  const lateActive = mergeProviderCallState(enriched.state, 'active', enriched);
  assert.deepEqual(lateActive, { ...enriched, changed: false });
});

test('Provider state merge normalizes hangup outcomes and rejects unknown states', () => {
  assert.equal(mergeProviderCallState('active', 'hangup').state, 'completed');
  assert.equal(mergeProviderCallState('ringing', 'hangup').state, 'cancelled');
  assert.equal(mergeProviderCallState('ringing', 'no_answer').state, 'missed');
  assert.equal(mergeProviderCallState('ringing', 'busy').state, 'rejected');
  assert.equal(mergeProviderCallState('dialing', 'provider_error').state, 'failed');

  assert.throws(
    () => mergeProviderCallState('planned', 'mystery-state'),
    (error: unknown) => error instanceof VoiceError
      && error.code === 'unsupported_provider_call_state'
  );
});
