import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  EnvVoiceSecretResolver,
  RustPbxRwiClient,
  VoiceError,
  mapRustPbxRwiCommand,
  type RustPbxRwiSafeEvent
} from '../src/agent-runtime/ivekit/voice/index.js';

test('RustPBX RWI authenticates by header and correlates durable action ids once', async () => {
  const fixture = await rwiFixture((socket, message) => {
    socket.send(JSON.stringify({ type: 'command_completed', action_id: message.action_id, data: { accepted: true } }));
    if (message.action === 'call.originate') {
      socket.send(JSON.stringify({ type: 'command_completed', action_id: message.action_id, data: { duplicate: true } }));
    }
  });
  const client = rwiClient(fixture.url);
  const events: RustPbxRwiSafeEvent[] = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.connect();
    const preflight = await client.preflight();
    assert.equal(preflight.ready, true);
    assert.equal(fixture.messages.some((message) => message.action === 'session.list_calls'), true);
    const result = await client.execute({
      command_id: 'durable-command-a', kind: 'originate', call_id: 'call-a',
      payload: { to: 'sip:1001@pbx.internal' }
    });
    assert.deepEqual(result, {
      state: 'succeeded', action_id: 'durable-command-a', result: { accepted: true }
    });
    const originate = fixture.messages.find((message) => message.action === 'call.originate');
    assert.deepEqual(originate, {
      action: 'call.originate', action_id: 'durable-command-a',
      params: { call_id: 'call-a', to: 'sip:1001@pbx.internal' }
    });
    assert.equal(fixture.requests[0]?.url, '/rwi/v1');
    assert.equal(fixture.requests[0]?.authorization, 'Bearer rwi-secret-value');
    await waitFor(() => events.some((event) => event.event_type === 'orphan_completion'));
  } finally {
    await client.close();
    await fixture.close();
  }
});

test('RustPBX RWI timeout is uncertain and never retries originate', async () => {
  const fixture = await rwiFixture((socket, message) => {
    if (message.action === 'call.answer') {
      socket.send(JSON.stringify({ event: 'command_completed', action_id: message.action_id, result: { answered: true } }));
    }
  });
  const client = rwiClient(fixture.url, { command_timeout_ms: 25 });
  try {
    await client.connect();
    const slow = client.execute({
      command_id: 'durable-timeout', kind: 'originate', call_id: 'call-timeout',
      payload: { to: 'sip:1002@pbx.internal' }
    });
    const answer = client.execute({
      command_id: 'durable-answer', kind: 'answer', call_id: 'call-answer', payload: {}
    });
    assert.equal((await answer).state, 'succeeded');
    assert.deepEqual(await slow, { state: 'uncertain', action_id: 'durable-timeout', error_code: 'provider_timeout' });
    assert.equal(fixture.messages.filter((message) => message.action_id === 'durable-timeout').length, 1);
  } finally {
    await client.close();
    await fixture.close();
  }
});

test('RustPBX RWI reconnects with subscriptions but stays closed after shutdown', async () => {
  let subscriptions = 0;
  const fixture = await rwiFixture((socket, message) => {
    if (message.action !== 'session.subscribe') return;
    subscriptions += 1;
    if (subscriptions === 1) socket.close();
  });
  const client = rwiClient(fixture.url, {
    reconnect_initial_ms: 10,
    reconnect_max_ms: 20
  });
  try {
    await client.connect();
    await waitFor(() => subscriptions >= 2, 500);
    await client.close();
    const afterClose = subscriptions;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(subscriptions, afterClose);
  } finally {
    await client.close();
    await fixture.close();
  }
});

test('RustPBX RWI enforces bounded object messages and exact command mapping', async () => {
  for (const [kind, action] of [
    ['originate', 'call.originate'],
    ['answer', 'call.answer'],
    ['hangup', 'call.hangup'],
    ['hold', 'call.hold'],
    ['resume', 'call.unhold'],
    ['conference', 'conference.add'],
    ['recording_start', 'record.start'],
    ['recording_pause', 'record.pause'],
    ['recording_resume', 'record.resume'],
    ['recording_stop', 'record.stop']
  ] as const) {
    assert.deepEqual(mapRustPbxRwiCommand({
      command_id: `command-${kind}`, kind, call_id: 'call-a', payload: {}
    }), { action, action_id: `command-${kind}`, params: { call_id: 'call-a' } });
  }
  assert.deepEqual(mapRustPbxRwiCommand({
    command_id: 'b', kind: 'blind_transfer', call_id: 'call-b', payload: { target: 'sip:1003@pbx.internal' }
  }), {
    action: 'call.transfer', action_id: 'b',
    params: { call_id: 'call-b', target: 'sip:1003@pbx.internal' }
  });
  assert.deepEqual(mapRustPbxRwiCommand({
    command_id: 'c', kind: 'recording_start', call_id: 'call-c', payload: {}
  }), { action: 'record.start', action_id: 'c', params: { call_id: 'call-c' } });
  assert.deepEqual(mapRustPbxRwiCommand({
    command_id: 'w', kind: 'warm_transfer', call_id: 'call-w',
    payload: { target: 'sip:1004@pbx.internal' }
  }), {
    action: 'call.transfer.attended', action_id: 'w',
    params: { call_id: 'call-w', target: 'sip:1004@pbx.internal' }
  });
  for (const kind of ['dtmf', 'park', 'pickup'] as const) {
    assert.throws(
      () => mapRustPbxRwiCommand({ command_id: `unsupported-${kind}`, kind, call_id: 'call-a', payload: {} }),
      hasVoiceCode('capability_unavailable')
    );
  }

  const fixture = await rwiFixture(() => undefined, (socket) => {
    socket.send(JSON.stringify({ event: 'provider_event', value: 'x'.repeat(1024) }));
  });
  const client = rwiClient(fixture.url, {
    max_message_bytes: 128,
    reconnect_initial_ms: 1_000,
    reconnect_max_ms: 1_000
  });
  const events: RustPbxRwiSafeEvent[] = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.connect();
    await waitFor(() => events.some((event) => event.event_type === 'protocol_violation'));
    assert.equal(events.some((event) => JSON.stringify(event).includes('x'.repeat(1024))), false);
  } finally {
    await client.close();
    await fixture.close();
  }
});

function rwiClient(url: string, overrides: Record<string, unknown> = {}): RustPbxRwiClient {
  return new RustPbxRwiClient({
    url,
    token_ref: 'env://RUSTPBX_RWI_TOKEN',
    secret_resolver: new EnvVoiceSecretResolver({
      env: { RUSTPBX_RWI_TOKEN: 'rwi-secret-value' },
      allowlist: { rwi: ['RUSTPBX_RWI_TOKEN'] }
    }),
    contexts: ['ivr', 'contact-center'],
    connect_timeout_ms: 250,
    command_timeout_ms: 100,
    heartbeat_timeout_ms: 500,
    reconnect_initial_ms: 25,
    reconnect_max_ms: 50,
    reconnect_jitter_ratio: 0,
    ...overrides
  });
}

async function rwiFixture(
  onMessage: (socket: WebSocket, message: Record<string, unknown>) => void,
  onConnection?: (socket: WebSocket) => void
): Promise<{
  url: string;
  messages: Record<string, unknown>[];
  requests: Array<{ url: string; authorization: string }>;
  close(): Promise<void>;
}> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/rwi/v1' });
  const messages: Record<string, unknown>[] = [];
  const requests: Array<{ url: string; authorization: string }> = [];
  wss.on('connection', (socket, request) => {
    requests.push({ url: request.url || '', authorization: String(request.headers.authorization || '') });
    onConnection?.(socket);
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      messages.push(message);
      onMessage(socket, message);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `ws://127.0.0.1:${address.port}/rwi/v1`,
    messages,
    requests,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
