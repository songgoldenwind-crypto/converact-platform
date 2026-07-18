import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import { IvrSessionStore } from '../src/agent-runtime/ivr/ivr-session-store.js';
import {
  IvrRwiSerialQueue,
  handleIncomingIvrCall,
  readIvrRwiMediaEvent,
  type RwiV1ControlPort,
} from '../src/agent-runtime/ivr/ivr-rwi-runtime.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { RwiV1Client } from '../src/agent-runtime/call-center/rwi-v1-client.js';

const graph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'menu',
  variables: [],
  nodes: [{
    id: 'menu',
    type: 'menu',
    name: 'Main',
    position: { x: 0, y: 0 },
    data: {
      prompt: [{ playType: 'tts', text: 'press one' }],
      options: [{ digit: '1', label: 'one', routeType: 'node', routeTarget: 'end' }],
      timeoutSec: 5,
      maxRetries: 1,
    },
  }, {
    id: 'end',
    type: 'disconnect',
    name: 'End',
    position: { x: 200, y: 0 },
    data: {},
  }],
  edges: [
    { id: 'digit', source: 'menu', target: 'end', sourceHandle: 'digit_1' },
    { id: 'timeout', source: 'menu', target: 'end', sourceHandle: 'timeout' },
    { id: 'invalid', source: 'menu', target: 'end', sourceHandle: 'invalid' },
  ],
};

class FakeRwiClient implements RwiV1ControlPort {
  readonly calls: string[] = [];
  isConnected(): boolean { return true; }
  answer(callId: string): string { this.calls.push(`answer:${callId}`); return 'answer'; }
  hangup(callId: string, reason?: string): string {
    this.calls.push(`hangup:${callId}:${reason || ''}`);
    return 'hangup';
  }
  sendLegacyCommand(command: string, params: Record<string, unknown>): string {
    this.calls.push(`command:${command}:${String(params.call_id || '')}`);
    return 'command';
  }
}

test('incoming RWI call answers only after finding and replays the persisted first action', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'RWI initial action' });
  const voice = new VoiceStore(db);
  const session = voice.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    status: 'ringing',
    rustpbx_call_id: 'rustpbx-incoming-a',
  });
  const store = new IvrSessionStore(db);
  store.upsert({
    callSessionId: session.id,
    tenantId: tenant.id,
    flowId: 'flow-a',
    context: {
      ...createRuntimeContext(graph),
      interaction: { kind: 'menu', nodeId: 'menu', awaiting: true },
    },
    stepCount: 1,
    terminated: false,
    lastAction: {
      kind: 'menu',
      prompt: 'press one',
      options: [{ digit: '1', label: 'one' }],
      node: 'menu',
      promptQueue: [{ text: 'press one', promptType: 'tts' }],
    },
  });

  const rwi = new FakeRwiClient();
  const result = await handleIncomingIvrCall(db, 'rustpbx-incoming-a', rwi);

  assert.equal(result, 'dispatched');
  assert.equal(rwi.calls[0], 'answer:rustpbx-incoming-a');
  assert.match(rwi.calls[1], /^command:/);
  assert.equal(store.get(session.id, tenant.id)?.revision, 0, 'replay must not advance or rewrite IVR state');
});

test('incoming RWI call without executable persisted state fails closed before answer', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'RWI missing action' });
  const voice = new VoiceStore(db);
  voice.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    status: 'ringing',
    rustpbx_call_id: 'rustpbx-incoming-missing',
  });
  const rwi = new FakeRwiClient();

  const result = await handleIncomingIvrCall(db, 'rustpbx-incoming-missing', rwi);

  assert.equal(result, 'ivr_unavailable');
  assert.deepEqual(rwi.calls, ['hangup:rustpbx-incoming-missing:ivr_unavailable']);
});

test('IvrRwiSerialQueue serializes one call while allowing another call to progress', async () => {
  const queue = new IvrRwiSerialQueue({ maxPending: 8, maxPendingPerCall: 4 });
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  assert.equal(queue.enqueue('call-a', async () => {
    order.push('a1:start');
    await firstGate;
    order.push('a1:end');
  }), true);
  assert.equal(queue.enqueue('call-a', async () => { order.push('a2'); }), true);
  assert.equal(queue.enqueue('call-b', async () => { order.push('b1'); }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['a1:start', 'b1']);
  releaseFirst();
  await queue.drain();
  assert.deepEqual(order, ['a1:start', 'b1', 'a1:end', 'a2']);
});

test('IvrRwiSerialQueue rejects overload instead of growing without bound', async () => {
  const queue = new IvrRwiSerialQueue({ maxPending: 2, maxPendingPerCall: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  assert.equal(queue.enqueue('call-a', () => gate), true);
  assert.equal(queue.enqueue('call-a', async () => {}), false);
  assert.equal(queue.enqueue('call-b', async () => {}), true);
  assert.equal(queue.enqueue('call-c', async () => {}), false);

  release();
  await queue.drain();
});

test('IvrRwiSerialQueue contains task failures and permits the provider event to retry', async () => {
  const errors: string[] = [];
  const queue = new IvrRwiSerialQueue({
    onError: (error, callId) => {
      errors.push(`${callId}:${error instanceof Error ? error.message : 'unknown'}`);
    }
  });

  assert.equal(queue.enqueueWithResult(
    'call-a',
    async () => { throw new Error('provider failed'); },
    'event-1'
  ), 'accepted');
  await queue.drain();
  assert.deepEqual(errors, ['call-a:provider failed']);

  assert.equal(queue.enqueueWithResult('call-a', async () => {}, 'event-1'), 'accepted');
  await queue.drain();
});

test('RWI media events are deduplicated only when the provider supplies an identity', () => {
  const first = readIvrRwiMediaEvent({
    dtmf_collected: { call_id: 'call-a', digits: '1' },
  });
  const repeated = readIvrRwiMediaEvent({
    dtmf_collected: { call_id: 'call-a', digits: '1' },
  });
  const identified = readIvrRwiMediaEvent({
    dtmf_collected: { call_id: 'call-a', digits: '1', action_id: 'action-7' },
  });

  assert.equal(first?.eventId, undefined);
  assert.equal(repeated?.eventId, undefined);
  assert.equal(identified?.eventId, 'dtmf_collected:action-7');
});

test('RwiV1Client keeps the bearer token out of the URL and explicit disconnect stays stopped', async () => {
  const requests: Array<{ url: string; authorization: string }> = [];
  const server = new WebSocketServer({ port: 0 });
  server.on('connection', (_socket, request) => {
    requests.push({
      url: request.url || '',
      authorization: String(request.headers.authorization || ''),
    });
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const client = new RwiV1Client({
    url: `ws://127.0.0.1:${address.port}/rwi/v1`,
    authToken: 'rwi-secret-token',
    reconnectInterval: 10,
  });
  try {
    await client.connect();
    client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(requests.length, 1, 'explicit disconnect must not create a new connection');
    assert.equal(requests[0].url, '/rwi/v1');
    assert.equal(requests[0].authorization, 'Bearer rwi-secret-token');
  } finally {
    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
