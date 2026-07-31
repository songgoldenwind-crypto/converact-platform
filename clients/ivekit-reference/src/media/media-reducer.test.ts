import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  IveKitMediaCall,
  IveKitMediaCallParticipant,
  IveKitMediaCallSnapshot,
  IveKitMediaCallStatus
} from '@opc/ivekit-sdk';
import { initialMediaCallState, mediaCallReducer } from './media-reducer.js';
import type { MediaTrackHandle } from './types.js';

test('HTTP lifecycle snapshots cover ring, accept, reject, cancel, timeout, active, and end', () => {
  for (const status of ['ringing', 'accepted', 'rejected', 'cancelled', 'timed_out', 'active', 'ended'] as IveKitMediaCallStatus[]) {
    let state = mediaCallReducer(initialMediaCallState(), { type: 'call_selected', requestId: 1, callId: 'call-1' });
    state = mediaCallReducer(state, { type: 'snapshot_loaded', requestId: 1, snapshot: snapshot(status) });
    assert.equal(state.call?.status, status);
    assert.equal(state.connection, terminal(status) ? 'ended' : status === 'active' ? 'online' : 'idle');
  }
});

test('stale HTTP responses and mismatched call updates are ignored', () => {
  let state = mediaCallReducer(initialMediaCallState(), { type: 'call_selected', requestId: 2, callId: 'call-new' });
  state = mediaCallReducer(state, { type: 'snapshot_loaded', requestId: 1, snapshot: snapshot('active', 'call-old') });
  assert.equal(state.call, null);
  state = mediaCallReducer(state, { type: 'snapshot_loaded', requestId: 2, snapshot: snapshot('ringing', 'call-new') });
  state = mediaCallReducer(state, { type: 'call_updated', requestId: 2, call: call('ended', 'call-other') });
  assert.equal(state.call?.status, 'ringing');
});

test('call switch clears provider projection, local media, and command errors', () => {
  let state = mediaCallReducer(initialMediaCallState(), { type: 'call_selected', requestId: 1, callId: 'call-old' });
  state = mediaCallReducer(state, { type: 'snapshot_loaded', requestId: 1, snapshot: snapshot('active', 'call-old') });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 1, event: { type: 'track_subscribed', generation: 1, track: track('TR_1') } });
  state = mediaCallReducer(state, { type: 'local_changed', local: { microphone: true } });
  state = mediaCallReducer(state, { type: 'command_failed', command: 'camera', error: 'blocked' });
  state = mediaCallReducer(state, { type: 'call_selected', requestId: 2, callId: 'call-new' });
  assert.equal(Object.keys(state.tracks).length, 0);
  assert.deepEqual(state.local, { microphone: false, camera: false, screen: false, screenAudio: false });
  assert.deepEqual(state.commands, {});
  assert.equal(state.selectedCallId, 'call-new');
});

test('adapter generations normalize connection, tracks, presence, speakers, and quality', () => {
  let state = mediaCallReducer(initialMediaCallState(), { type: 'call_selected', requestId: 1, callId: 'call-1' });
  state = mediaCallReducer(state, { type: 'snapshot_loaded', requestId: 1, snapshot: snapshot('accepted') });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 2, event: { type: 'state', generation: 2, state: 'connected' } });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 2, event: { type: 'participant_joined', generation: 2, identity: 'customer-1', display_name: 'Customer' } });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 2, event: { type: 'track_subscribed', generation: 2, track: track('TR_2') } });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 2, event: { type: 'active_speakers', generation: 2, identities: ['customer-1'] } });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 2, event: { type: 'network_quality', generation: 2, identity: 'customer-1', quality: 'poor' } });
  assert.equal(state.connection, 'online');
  assert.deepEqual(state.presentIdentities, ['customer-1']);
  assert.equal(state.tracks.TR_2.id, 'TR_2');
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 2, event: { type: 'track_mute_changed', generation: 2, track_id: 'TR_2', muted: true } });
  assert.equal(state.tracks.TR_2.muted, true);
  assert.deepEqual(state.activeSpeakerIdentities, ['customer-1']);
  assert.deepEqual(state.networkQuality, { 'customer-1': 'poor' });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 2, event: { type: 'network_quality', generation: 2, identity: 'customer-1', quality: 'raw-provider-secret' } });
  assert.deepEqual(state.networkQuality, { 'customer-1': 'unknown' });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 2, event: { type: 'local_track_changed', generation: 2, source: 'screen_share', enabled: true } });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 2, event: { type: 'local_track_changed', generation: 2, source: 'screen_share_audio', enabled: true } });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 2, event: { type: 'local_track_changed', generation: 2, source: 'screen_share', enabled: false } });
  assert.equal(state.local.screen, false);
  assert.equal(state.local.screenAudio, false);

  const stale = mediaCallReducer(state, { type: 'adapter_event', generation: 1, event: { type: 'fatal', generation: 1, reason: 'old room' } });
  assert.equal(stale, state);
  const next = mediaCallReducer(state, { type: 'adapter_event', generation: 3, event: { type: 'state', generation: 3, state: 'reconnecting' } });
  assert.equal(next.connection, 'reconnecting');
  assert.deepEqual(next.tracks, {});
});

test('terminal snapshot and revoke synchronously clear media and are idempotent', () => {
  let state = mediaCallReducer(initialMediaCallState(), { type: 'call_selected', requestId: 1, callId: 'call-1' });
  state = mediaCallReducer(state, { type: 'snapshot_loaded', requestId: 1, snapshot: snapshot('active') });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 1, event: { type: 'track_subscribed', generation: 1, track: track('TR_END') } });
  state = mediaCallReducer(state, { type: 'snapshot_loaded', requestId: 1, snapshot: snapshot('ended') });
  assert.equal(state.connection, 'ended');
  assert.deepEqual(state.tracks, {});
  const endedAgain = mediaCallReducer(state, { type: 'snapshot_loaded', requestId: 1, snapshot: snapshot('ended') });
  assert.deepEqual(endedAgain.tracks, {});
  const revoked = mediaCallReducer(state, { type: 'revoked', reason: 'membership removed' });
  assert.equal(revoked.revokedReason, 'membership removed');
  assert.equal(revoked.connection, 'ended');
});

test('terminal provider disconnect preserves desired devices but requires explicit screen-share recovery', () => {
  let state = mediaCallReducer(initialMediaCallState(), { type: 'call_selected', requestId: 1, callId: 'call-1' });
  state = mediaCallReducer(state, { type: 'snapshot_loaded', requestId: 1, snapshot: snapshot('active') });
  state = mediaCallReducer(state, { type: 'local_changed', local: { microphone: true, camera: true, screen: true, screenAudio: true } });
  state = mediaCallReducer(state, {
    type: 'adapter_event',
    generation: 1,
    event: { type: 'terminal_disconnect', generation: 1, reason_code: 'signal_close' }
  });
  assert.equal(state.connection, 'reconnecting');
  assert.deepEqual(state.local, { microphone: true, camera: true, screen: false, screenAudio: false });
  assert.equal(state.screenShareRecoveryRequired, true);
  assert.equal(state.screenShareRecoveryAudio, true);
  state = mediaCallReducer(state, { type: 'screen_share_recovery_cleared' });
  assert.equal(state.screenShareRecoveryRequired, false);
  assert.equal(state.screenShareRecoveryAudio, false);
});

test('command pending, failure, retry, and success states stay isolated by command', () => {
  let state = initialMediaCallState();
  state = mediaCallReducer(state, { type: 'command_started', command: 'accept' });
  assert.deepEqual(state.commands.accept, { pending: true, error: '' });
  state = mediaCallReducer(state, { type: 'command_failed', command: 'accept', error: 'retry later' });
  assert.deepEqual(state.commands.accept, { pending: false, error: 'retry later' });
  state = mediaCallReducer(state, { type: 'command_started', command: 'accept' });
  state = mediaCallReducer(state, { type: 'command_succeeded', command: 'accept' });
  assert.deepEqual(state.commands.accept, { pending: false, error: '' });
  state = mediaCallReducer(state, { type: 'adapter_event', generation: 1, event: { type: 'autoplay_blocked', generation: 1, message: 'gesture' } });
  assert.equal(state.autoplayBlocked, true);
  state = mediaCallReducer(state, { type: 'audio_started' });
  assert.equal(state.autoplayBlocked, false);
});

function snapshot(status: IveKitMediaCallStatus, id = 'call-1'): IveKitMediaCallSnapshot {
  return { call: call(status, id), participants: [participant(id, 'agent-1', 'host'), participant(id, 'customer-1', 'participant')] };
}

function call(status: IveKitMediaCallStatus, id: string): IveKitMediaCall {
  return {
    id,
    tenant_id: 'tenant-1',
    room_name: `room-${id}`,
    media: 'video',
    status,
    initiated_by: 'agent-1',
    business_ref: { type: 'order', id: 'order-1', metadata: {} },
    title: 'Support call',
    metadata: {},
    ring_timeout_seconds: 30,
    ring_expires_at: status === 'ringing' ? '2026-07-11T10:00:30.000Z' : null,
    accepted_at: ['accepted', 'active', 'ended'].includes(status) ? '2026-07-11T10:00:05.000Z' : null,
    started_at: ['active', 'ended'].includes(status) ? '2026-07-11T10:00:06.000Z' : null,
    ended_at: terminal(status) ? '2026-07-11T10:01:00.000Z' : null,
    end_reason: terminal(status) ? status : '',
    created_at: '2026-07-11T10:00:00.000Z',
    updated_at: '2026-07-11T10:00:06.000Z'
  };
}

function participant(callId: string, identity: string, role: 'host' | 'participant'): IveKitMediaCallParticipant {
  return {
    id: `${callId}-${identity}`,
    tenant_id: 'tenant-1',
    call_id: callId,
    identity,
    role,
    status: role === 'host' ? 'joined' : 'accepted',
    display_name: identity,
    metadata: {},
    invited_at: '2026-07-11T10:00:00.000Z',
    accepted_at: '2026-07-11T10:00:05.000Z',
    joined_at: role === 'host' ? '2026-07-11T10:00:00.000Z' : null,
    left_at: null,
    updated_at: '2026-07-11T10:00:05.000Z'
  };
}

function track(id: string): MediaTrackHandle {
  return Object.freeze({
    id,
    participantIdentity: 'customer-1',
    kind: 'video',
    source: 'camera',
    muted: false,
    attach: (element: HTMLMediaElement) => element,
    detach: () => undefined
  });
}

function terminal(status: IveKitMediaCallStatus): boolean {
  return ['rejected', 'cancelled', 'timed_out', 'ended', 'failed'].includes(status);
}
