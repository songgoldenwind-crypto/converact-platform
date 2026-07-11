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
  const client = fakeClient({
    getCall: async () => { sequence.push('http:get'); return snapshot('accepted'); },
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
  await act(async () => { await view.result.current.refresh(); });
  assert.equal(joinPlans, 1);
  assert.equal(sequence.filter((item) => item === 'adapter:connect').length, 1);
});

class FakeAdapter implements LiveKitRoomAdapter {
  disposeCalls = 0;
  cameraError?: Error;
  constructor(
    private readonly sequence: string[],
    private readonly emitConnected: boolean,
    private onEvent?: (event: MediaAdapterEvent) => void
  ) {}
  setEventHandler(handler: (event: MediaAdapterEvent) => void) { this.onEvent = handler; }
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
  async setScreenShare(enabled: boolean) { this.sequence.push(`adapter:screen:${enabled}`); }
  async switchDevice(kind: 'audioinput' | 'videoinput' | 'audiooutput', deviceId: string) { this.sequence.push(`adapter:device:${kind}:${deviceId}`); }
  async startAudio() { this.sequence.push('adapter:start-audio'); }
  async dispose() { this.disposeCalls += 1; this.sequence.push('adapter:dispose'); }
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
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
