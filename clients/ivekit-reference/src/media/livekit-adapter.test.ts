import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { IveKitMediaJoinPlan } from '@opc/ivekit-sdk';
import {
  LiveKitClientAdapter,
  type LiveKitParticipantLike,
  type LiveKitRoomLike,
  type LiveKitTrackLike,
  type LiveKitTrackPublicationLike
} from './livekit-adapter.js';
import type { MediaAdapterEvent } from './types.js';

const plan = (room: string, token = `token-${room}`): IveKitMediaJoinPlan => ({
  mode: 'webrtc',
  channel: 'webrtc',
  roomName: room,
  role: 'host',
  token: {
    token,
    livekit_url: 'wss://livekit.example.test',
    room_name: room,
    configured: true
  }
});

test('LiveKit adapter coalesces connect and exposes bounded local media controls', async () => {
  const room = new FakeRoom();
  const events: MediaAdapterEvent[] = [];
  const adapter = new LiveKitClientAdapter({ roomFactory: () => room, onEvent: (event) => events.push(event) });
  const first = adapter.connect(plan('room-a'));
  const second = adapter.connect(plan('room-a'));
  assert.equal(first, second);
  assert.equal(room.connectCalls.length, 1);
  room.resolveConnect();
  await first;
  assert.equal(events.some((event) => event.type === 'state' && event.state === 'connected'), true);

  await adapter.setMicrophone(true);
  await adapter.setCamera(true);
  await adapter.setScreenShare(true, { audio: true });
  await adapter.switchDevice('audioinput', 'mic-1');
  await adapter.startAudio();
  assert.deepEqual(room.localCalls, [
    'microphone:true',
    'camera:true',
    'screen:true:true',
    'device:audioinput:mic-1',
    'startAudio'
  ]);
});

test('LiveKit adapter cancels an in-flight connect and ignores stale room callbacks', async () => {
  const room = new FakeRoom();
  const events: MediaAdapterEvent[] = [];
  const adapter = new LiveKitClientAdapter({ roomFactory: () => room, onEvent: (event) => events.push(event) });
  const connecting = adapter.connect(plan('room-cancel'));
  await adapter.disconnect();
  room.resolveConnect();
  await assert.rejects(connecting, /cancelled/);
  const count = events.length;
  room.emit('reconnected');
  room.emit('participantConnected', participant('stale-user'));
  assert.equal(events.length, count);
  const lastEvent = events.at(-1);
  assert.equal(lastEvent?.type, 'state');
  assert.equal(lastEvent?.type === 'state' && lastEvent.state, 'disconnected');
});

test('LiveKit adapter normalizes tracks speakers quality reconnect and autoplay events', async () => {
  const room = new FakeRoom(true);
  const events: MediaAdapterEvent[] = [];
  const adapter = new LiveKitClientAdapter({ roomFactory: () => room, onEvent: (event) => events.push(event) });
  await adapter.connect(plan('room-events'));
  const remote = participant('customer-1');
  const track = new FakeTrack('video');
  const publication: LiveKitTrackPublicationLike = {
    trackSid: 'TR_SCREEN',
    source: 'screen_share',
    isMuted: false
  };
  room.emit('participantConnected', remote);
  room.emit('trackSubscribed', track, publication, remote);
  room.emit('trackSubscribed', track, publication, remote);
  room.emit('activeSpeakersChanged', [participant('customer-1'), participant('agent-1')]);
  room.emit('connectionQualityChanged', 'poor', remote);
  room.emit('reconnecting');
  room.emit('reconnected');
  room.canPlaybackAudio = false;
  room.emit('audioPlaybackChanged');
  room.emit('localTrackPublished', { source: 'screen_share' });
  room.emit('localTrackUnpublished', { source: 'screen_share' });

  const subscribed = events.find((event) => event.type === 'track_subscribed');
  assert.ok(subscribed && subscribed.type === 'track_subscribed');
  assert.equal(events.filter((event) => event.type === 'track_subscribed').length, 1);
  assert.equal(Object.isFrozen(subscribed), true);
  assert.equal(subscribed.track.source, 'screen_share');
  const element = {} as HTMLMediaElement;
  subscribed.track.attach(element);
  subscribed.track.detach(element);
  assert.deepEqual(track.calls, ['attach', 'detach']);
  assert.deepEqual(
    events.find((event) => event.type === 'active_speakers'),
    { type: 'active_speakers', generation: 1, identities: ['customer-1', 'agent-1'] }
  );
  assert.equal(events.some((event) => event.type === 'network_quality' && event.quality === 'poor'), true);
  assert.equal(events.some((event) => event.type === 'state' && event.state === 'reconnecting'), true);
  assert.equal(events.some((event) => event.type === 'autoplay_blocked'), true);
  assert.equal(events.some((event) => event.type === 'local_track_changed' && event.source === 'screen_share' && event.enabled), true);
  assert.equal(events.some((event) => event.type === 'local_track_changed' && event.source === 'screen_share' && !event.enabled), true);

  room.emit('trackUnsubscribed', track, publication, remote);
  assert.equal(events.some((event) => event.type === 'track_unsubscribed' && event.track_id === 'TR_SCREEN'), true);
  assert.throws(() => subscribed.track.attach(element), /no longer active/);
});

test('LiveKit adapter suppresses the old room generation after a call switch', async () => {
  const firstRoom = new FakeRoom(true);
  const secondRoom = new FakeRoom(true);
  const rooms = [firstRoom, secondRoom];
  const events: MediaAdapterEvent[] = [];
  const adapter = new LiveKitClientAdapter({
    roomFactory: () => rooms.shift()!,
    onEvent: (event) => events.push(event)
  });
  await adapter.connect(plan('room-old'));
  await adapter.connect(plan('room-new'));
  const count = events.length;
  firstRoom.emit('participantConnected', participant('old-user'));
  assert.equal(events.length, count);
  secondRoom.emit('participantConnected', participant('new-user'));
  assert.equal(events.some((event) => event.type === 'participant_joined' && event.identity === 'new-user'), true);
  assert.equal(firstRoom.disconnectCalls, 1);
});

test('a late old connection cannot orphan the new room listeners', async () => {
  const firstRoom = new FakeRoom();
  const secondRoom = new FakeRoom(true);
  const rooms = [firstRoom, secondRoom];
  const adapter = new LiveKitClientAdapter({ roomFactory: () => rooms.shift()! });
  const firstConnect = adapter.connect(plan('room-racing-old'));
  await adapter.connect(plan('room-racing-new'));
  firstRoom.resolveConnect();
  await assert.rejects(firstConnect, /cancelled/);
  assert.equal(secondRoom.listenerCount(), 12);
  await adapter.disconnect();
  assert.equal(secondRoom.listenerCount(), 0);
});

test('LiveKit adapter reports fatal disconnect and autoplay failure and disposes once', async () => {
  const room = new FakeRoom(true);
  const events: MediaAdapterEvent[] = [];
  room.startAudioError = new Error('gesture required');
  const adapter = new LiveKitClientAdapter({ roomFactory: () => room, onEvent: (event) => events.push(event) });
  await adapter.connect(plan('room-fatal'));
  await assert.rejects(adapter.startAudio(), /gesture required/);
  assert.equal(events.some((event) => event.type === 'autoplay_blocked'), true);
  room.emit('disconnected', 'server_shutdown');
  assert.equal(events.some((event) => event.type === 'fatal'), true);
  await adapter.dispose();
  await adapter.dispose();
  await assert.rejects(adapter.connect(plan('room-after-dispose')), /disposed/);
});

class FakeRoom implements LiveKitRoomLike {
  readonly localCalls: string[] = [];
  readonly connectCalls: Array<[string, string]> = [];
  disconnectCalls = 0;
  canPlaybackAudio = true;
  startAudioError?: Error;
  private connectResolver?: () => void;
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  readonly localParticipant = {
    setMicrophoneEnabled: async (enabled: boolean) => { this.localCalls.push(`microphone:${enabled}`); },
    setCameraEnabled: async (enabled: boolean) => { this.localCalls.push(`camera:${enabled}`); },
    setScreenShareEnabled: async (enabled: boolean, options?: { audio?: boolean }) => {
      this.localCalls.push(`screen:${enabled}:${Boolean(options?.audio)}`);
    }
  };

  constructor(private readonly connectImmediately = false) {}

  on(event: string, listener: (...args: unknown[]) => void) {
    let listeners = this.listeners.get(event);
    if (!listeners) this.listeners.set(event, listeners = new Set());
    listeners.add(listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  connect(url: string, token: string) {
    this.connectCalls.push([url, token]);
    if (this.connectImmediately) return Promise.resolve();
    return new Promise<void>((resolve) => { this.connectResolver = resolve; });
  }

  resolveConnect() { this.connectResolver?.(); }
  async disconnect() { this.disconnectCalls += 1; }
  async switchActiveDevice(kind: MediaDeviceKind, deviceId: string) {
    this.localCalls.push(`device:${kind}:${deviceId}`);
    return true;
  }
  async startAudio() {
    this.localCalls.push('startAudio');
    if (this.startAudioError) throw this.startAudioError;
  }
  emit(event: string, ...args: unknown[]) { for (const listener of this.listeners.get(event) || []) listener(...args); }
  listenerCount() {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

class FakeTrack implements LiveKitTrackLike {
  readonly calls: string[] = [];
  constructor(readonly kind: 'audio' | 'video') {}
  attach(element: HTMLMediaElement) { this.calls.push('attach'); return element; }
  detach(_element?: HTMLMediaElement) { this.calls.push('detach'); return []; }
}

function participant(identity: string): LiveKitParticipantLike {
  return { identity, name: identity.toUpperCase() };
}
