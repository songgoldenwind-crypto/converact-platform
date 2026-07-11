import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import type {
  IveKitClient,
  IveKitMediaCallAction,
  IveKitMediaCallSnapshot,
  IveKitMediaCallStatus,
  IveKitMediaJoinPlan
} from '@opc/ivekit-sdk';
import { installTestDom } from '../test-dom.js';
import type { LiveKitRoomAdapter, MediaAdapterEvent } from './types.js';
import { useMediaCall, type MediaAdapterFactory } from './use-media-call.js';

let closeDom: () => void;

before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('accepted call obtains a participant plan, connects, and activates after provider join', async () => {
  const sequence: string[] = [];
  const adapter = new FakeAdapter(sequence, true);
  const accepted = snapshot('accepted');
  accepted.participants[0].role = 'host';
  const client = fakeClient({
    getCall: async () => { sequence.push('http:get'); return accepted; },
    createCallJoinPlan: async () => { sequence.push('http:join-plan'); return joinPlan(); },
    transitionCall: async (_id, input) => {
      sequence.push(`http:${input.action}`);
      return snapshot('active');
    }
  });
  const view = renderHook(() => useMediaCall(input(client, () => adapter)));

  await waitFor(() => assert.equal(view.result.current.state.call?.status, 'active'));
  assert.deepEqual(sequence.slice(0, 5), ['http:get', 'http:join-plan', 'adapter:connect', 'http:activate']);
  assert.equal(view.result.current.state.connection, 'online');
});

test('accepted participant connects without attempting the host-only activate transition', async () => {
  const sequence: string[] = [];
  const adapter = new FakeAdapter(sequence, true);
  const client = fakeClient({
    getCall: async () => { sequence.push('http:get'); return snapshot('accepted'); },
    createCallJoinPlan: async () => { sequence.push('http:join-plan'); return joinPlan(); },
    transitionCall: async (_id, input) => {
      sequence.push(`http:${input.action}`);
      throw new Error('participant must not activate');
    }
  });
  const view = renderHook(() => useMediaCall(input(client, () => adapter)));

  await waitFor(() => assert.equal(view.result.current.state.connection, 'online'));
  assert.deepEqual(sequence, ['http:get', 'http:join-plan', 'adapter:connect']);
  assert.equal(view.result.current.state.call?.status, 'accepted');
  assert.equal(view.result.current.state.revokedReason, '');
});

test('failed lifecycle retry reuses the original idempotency key and payload', async () => {
  const keys: string[] = [];
  const payloads: unknown[] = [];
  let attempts = 0;
  const client = fakeClient({
    getCall: async () => snapshot('ringing'),
    transitionCall: async (_id, payload, options) => {
      attempts += 1;
      keys.push(options.idempotencyKey);
      payloads.push(payload);
      if (attempts === 1) throw httpError(409, 'command in progress');
      return snapshot('accepted');
    },
    createCallJoinPlan: async () => joinPlan()
  });
  const adapter = new FakeAdapter([], false);
  const view = renderHook(() => useMediaCall(input(client, () => adapter, { randomId: () => 'stable-key' })));
  await waitFor(() => assert.equal(view.result.current.state.call?.status, 'ringing'));

  await act(async () => {
    await assert.rejects(view.result.current.transition('accept', 'customer accepted'), /in progress/);
  });
  assert.equal(view.result.current.state.commands.accept.error, 'command in progress');
  await act(async () => { await view.result.current.retry('accept'); });
  assert.deepEqual(keys, ['stable-key', 'stable-key']);
  assert.deepEqual(payloads, [
    { action: 'accept', reason: 'customer accepted' },
    { action: 'accept', reason: 'customer accepted' }
  ]);
});

test('terminal transition disposes media before publishing the terminal snapshot', async () => {
  const sequence: string[] = [];
  const adapter = new FakeAdapter(sequence, false);
  const client = fakeClient({
    getCall: async () => snapshot('active'),
    createCallJoinPlan: async () => joinPlan(),
    transitionCall: async (_id, input) => {
      sequence.push(`http:${input.action}`);
      return snapshot('ended');
    }
  });
  const view = renderHook(() => useMediaCall(input(client, () => adapter)));
  await waitFor(() => assert.equal(view.result.current.state.call?.status, 'active'));
  sequence.length = 0;
  await act(async () => { await view.result.current.transition('end', 'user hangup'); });
  assert.deepEqual(sequence, ['http:end', 'adapter:dispose']);
  assert.equal(view.result.current.state.connection, 'ended');
});

test('switching call disposes the old adapter and suppresses its late HTTP response', async () => {
  const old = deferred<IveKitMediaCallSnapshot>();
  const adapters: FakeAdapter[] = [];
  const client = fakeClient({
    getCall: async (id) => id === 'call-old' ? old.promise : snapshot('ringing', 'call-new')
  });
  const adapterFactory: MediaAdapterFactory = (onEvent) => {
    const adapter = new FakeAdapter([], false, onEvent);
    adapters.push(adapter);
    return adapter;
  };
  const { result, rerender } = renderHook(
    ({ callId }) => useMediaCall(input(client, adapterFactory, { callId })),
    { initialProps: { callId: 'call-old' } }
  );
  rerender({ callId: 'call-new' });
  await waitFor(() => assert.equal(result.current.state.call?.id, 'call-new'));
  old.resolve(snapshot('active', 'call-old'));
  await Promise.resolve();
  assert.equal(result.current.state.call?.id, 'call-new');
  assert.equal(adapters[0].disposeCalls, 1);
});

test('authorization loss while joining revokes and disposes the local call', async () => {
  const adapter = new FakeAdapter([], false);
  const client = fakeClient({
    getCall: async () => snapshot('accepted'),
    createCallJoinPlan: async () => { throw httpError(403, 'membership removed'); }
  });
  const view = renderHook(() => useMediaCall(input(client, () => adapter)));
  await waitFor(() => assert.equal(view.result.current.state.revokedReason, 'membership removed'));
  assert.equal(adapter.disposeCalls, 1);
  assert.equal(view.result.current.state.connection, 'ended');
});

test('local media state changes only after adapter success and refresh does not reconnect', async () => {
  const sequence: string[] = [];
  const adapter = new FakeAdapter(sequence, false);
  adapter.cameraError = new Error('camera busy');
  adapter.screenError = new Error('screen picker cancelled');
  let joinPlans = 0;
  const client = fakeClient({
    getCall: async () => snapshot('active'),
    createCallJoinPlan: async () => { joinPlans += 1; return joinPlan(); }
  });
  const view = renderHook(() => useMediaCall(input(client, () => adapter)));
  await waitFor(() => assert.equal(sequence.includes('adapter:connect'), true));
  await act(async () => { await view.result.current.setMicrophone(true); });
  assert.equal(view.result.current.state.local.microphone, true);
  await act(async () => {
    await assert.rejects(view.result.current.setCamera(true), /camera busy/);
  });
  assert.equal(view.result.current.state.local.camera, false);
  assert.equal(view.result.current.state.commands.camera.error, 'camera busy');
  await act(async () => {
    await assert.rejects(view.result.current.setScreenShare(true, { audio: true }), /picker cancelled/);
  });
  assert.equal(view.result.current.state.local.screen, false);
  assert.equal(view.result.current.state.local.screenAudio, false);
  await act(async () => { await view.result.current.refresh(); });
  assert.equal(joinPlans, 1);
  assert.equal(sequence.filter((item) => item === 'adapter:connect').length, 1);
});

test('host moderation retries 502 with the same key while 403 stays a command error', async () => {
  const keys: string[] = [];
  let muteAttempts = 0;
  const active = snapshot('active');
  active.participants[0].role = 'host';
  const client = fakeClient({
    getCall: async () => active,
    createCallJoinPlan: async () => joinPlan(),
    muteParticipant: async (_room, identity, value, options) => {
      keys.push(options.idempotencyKey);
      muteAttempts += 1;
      if (muteAttempts === 1) throw httpError(502, 'provider unavailable');
      return { room_name: 'room-call-1', participant_identity: identity, action: 'mute', status: 'applied', actor_identity: 'customer-1', track_sid: value.track_sid, source: value.source, muted: true };
    },
    removeParticipant: async () => { throw httpError(403, 'host permission denied'); }
  });
  const view = renderHook(() => useMediaCall(input(client, () => new FakeAdapter([], false), { randomId: () => 'moderation-key' })));
  await waitFor(() => assert.equal(view.result.current.state.call?.status, 'active'));
  const track = { id: 'TR_MIC', participantIdentity: 'agent-2', source: 'microphone', kind: 'audio', muted: false } as never;
  await act(async () => { await assert.rejects(view.result.current.muteParticipant('agent-2', track), /provider unavailable/); });
  await act(async () => { await view.result.current.muteParticipant('agent-2', track); });
  assert.deepEqual(keys, ['moderation-key', 'moderation-key']);
  await act(async () => { await assert.rejects(view.result.current.removeParticipant('agent-2'), /permission denied/); });
  assert.equal(view.result.current.state.revokedReason, '');
  assert.equal(view.result.current.state.commands['remove:agent-2:'].error, 'host permission denied');
});

test('browser offline and online transitions wait for provider reconnect', async () => {
  let loads = 0;
  const adapter = new FakeAdapter([], false);
  const client = fakeClient({
    getCall: async () => { loads += 1; return snapshot('active'); },
    createCallJoinPlan: async () => joinPlan()
  });
  const view = renderHook(() => useMediaCall(input(client, () => adapter)));
  await waitFor(() => assert.equal(view.result.current.state.call?.status, 'active'));
  act(() => window.dispatchEvent(new Event('offline')));
  assert.equal(view.result.current.state.connection, 'offline');
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => assert.equal(loads, 2));
  assert.equal(view.result.current.state.connection, 'reconnecting');
  act(() => adapter.emit({ type: 'state', generation: 1, state: 'connected' }));
  assert.equal(view.result.current.state.connection, 'online');
});

test('stale moderation 403 cannot revoke or poison a newly selected call', async () => {
  const removal = deferred<never>();
  const client = fakeClient({
    getCall: async (id) => {
      const value = snapshot('active', id);
      value.participants[0].role = 'host';
      return value;
    },
    createCallJoinPlan: async () => joinPlan(),
    removeParticipant: async () => removal.promise
  });
  const view = renderHook(
    ({ callId }) => useMediaCall(input(client, () => new FakeAdapter([], false), { callId })),
    { initialProps: { callId: 'call-old' } }
  );
  await waitFor(() => assert.equal(view.result.current.state.call?.id, 'call-old'));
  let operation!: Promise<unknown>;
  act(() => { operation = view.result.current.removeParticipant('agent-2'); });
  view.rerender({ callId: 'call-new' });
  await waitFor(() => assert.equal(view.result.current.state.call?.id, 'call-new'));
  removal.reject(httpError(403, 'old permission denied'));
  await act(async () => { await assert.rejects(operation, /old permission denied/); });
  assert.equal(view.result.current.state.revokedReason, '');
  assert.equal(Object.values(view.result.current.state.commands).some((command) => command.error), false);
});

test('targeted media websocket invalidates recordings and converges call events', async () => {
  let loads = 0;
  const sockets: FakeWebSocket[] = [];
  const previous = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: class extends FakeWebSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } } });
  try {
    const client = fakeClient({ getCall: async () => { loads += 1; return snapshot('ringing'); } });
    const view = renderHook(() => useMediaCall(input(client, () => new FakeAdapter([], false), {
      websocketUrl: 'wss://events.test/ws', accessToken: 'short-token'
    })));
    await waitFor(() => assert.equal(view.result.current.state.call?.status, 'ringing'));
    assert.equal(new URL(sockets[0].url).searchParams.get('token'), null);
    assert.deepEqual(sockets[0].protocols, ['ivekit.v1', 'ivekit.jwt.short-token']);
    act(() => sockets[0].emit({ type: 'ivekit.media.recording.updated', data: { call_id: 'call-1' } }));
    assert.equal(view.result.current.state.recordingRevision, 1);
    act(() => sockets[0].emit({ type: 'ivekit.media.call.updated', data: { call_id: 'call-1' } }));
    await waitFor(() => assert.equal(loads, 2));
    view.unmount();
    assert.equal(sockets[0].closed, true);
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: previous });
  }
});

class FakeAdapter implements LiveKitRoomAdapter {
  disposeCalls = 0;
  cameraError?: Error;
  screenError?: Error;
  constructor(
    private readonly sequence: string[],
    private readonly emitConnected: boolean,
    private onEvent?: (event: MediaAdapterEvent) => void
  ) {}
  setEventHandler(handler: (event: MediaAdapterEvent) => void) { this.onEvent = handler; }
  emit(event: MediaAdapterEvent) { this.onEvent?.(event); }
  async connect(_plan: IveKitMediaJoinPlan) {
    this.sequence.push('adapter:connect');
    if (this.emitConnected) this.onEvent?.({ type: 'state', generation: 1, state: 'connected' });
  }
  async disconnect() { this.sequence.push('adapter:disconnect'); }
  async setMicrophone(enabled: boolean) { this.sequence.push(`adapter:microphone:${enabled}`); }
  async setCamera(enabled: boolean) {
    this.sequence.push(`adapter:camera:${enabled}`);
    if (this.cameraError) throw this.cameraError;
  }
  async setScreenShare(enabled: boolean) {
    this.sequence.push(`adapter:screen:${enabled}`);
    if (this.screenError) throw this.screenError;
  }
  async switchDevice(kind: 'audioinput' | 'videoinput' | 'audiooutput', deviceId: string) { this.sequence.push(`adapter:device:${kind}:${deviceId}`); }
  async startAudio() { this.sequence.push('adapter:start-audio'); }
  async dispose() { this.disposeCalls += 1; this.sequence.push('adapter:dispose'); }
}

class FakeWebSocket {
  onmessage: ((message: { data: string }) => void) | null = null;
  closed = false;
  readonly url: string;
  readonly protocols: string[];
  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    this.protocols = typeof protocols === 'string' ? [protocols] : protocols || [];
  }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.closed = true; }
}

function input(
  client: IveKitClient,
  adapterFactory: MediaAdapterFactory,
  overrides: Partial<Parameters<typeof useMediaCall>[0]> = {}
): Parameters<typeof useMediaCall>[0] {
  return {
    client,
    callId: 'call-1',
    identity: 'customer-1',
    adapterFactory: (onEvent) => {
      const adapter = adapterFactory(onEvent);
      if (adapter instanceof FakeAdapter) adapter.setEventHandler(onEvent);
      return adapter;
    },
    randomId: () => 'key-1',
    ...overrides
  };
}

function fakeClient(overrides: Partial<IveKitClient['media']>): IveKitClient {
  const unexpected = async (name: string): Promise<never> => { throw new Error(`unexpected ${name}`); };
  return {
    media: {
      getCall: () => unexpected('getCall'),
      createCallJoinPlan: () => unexpected('createCallJoinPlan'),
      transitionCall: () => unexpected('transitionCall'),
      ...overrides
    } as IveKitClient['media']
  } as IveKitClient;
}

function snapshot(status: IveKitMediaCallStatus, id = 'call-1'): IveKitMediaCallSnapshot {
  return {
    call: {
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
      ring_expires_at: null,
      accepted_at: ['accepted', 'active', 'ended'].includes(status) ? '2026-07-11T10:00:05.000Z' : null,
      started_at: ['active', 'ended'].includes(status) ? '2026-07-11T10:00:06.000Z' : null,
      ended_at: status === 'ended' ? '2026-07-11T10:01:00.000Z' : null,
      end_reason: status === 'ended' ? 'user hangup' : '',
      created_at: '2026-07-11T10:00:00.000Z',
      updated_at: '2026-07-11T10:00:06.000Z'
    },
    participants: [{
      id: `${id}-customer-1`, tenant_id: 'tenant-1', call_id: id, identity: 'customer-1', role: 'participant',
      status: status === 'ringing' ? 'ringing' : 'accepted', display_name: 'Customer', metadata: {},
      invited_at: '2026-07-11T10:00:00.000Z', accepted_at: status === 'ringing' ? null : '2026-07-11T10:00:05.000Z',
      joined_at: null, left_at: null, updated_at: '2026-07-11T10:00:05.000Z'
    }]
  };
}

function joinPlan(): IveKitMediaJoinPlan {
  return {
    mode: 'webrtc', channel: 'webrtc', roomName: 'room-call-1', role: 'participant',
    token: { token: 'short-token', livekit_url: 'wss://livekit.test', room_name: 'room-call-1', configured: true }
  };
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
