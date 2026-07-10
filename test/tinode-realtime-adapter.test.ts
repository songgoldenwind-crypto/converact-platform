import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TinodeRealtimeAdapter,
  type TinodeClientLike,
  type TinodeTopicLike
} from '../frontend/src/pages/tinode-realtime.js';

test('Tinode realtime adapter connects with client plan and exposes receive-only events plus notes', async () => {
  const calls: string[] = [];
  const topic: TinodeTopicLike = {
    subscribe: async () => { calls.push('subscribe'); },
    leave: async () => { calls.push('leave'); },
    noteRecv: (seq) => calls.push(`recv:${seq}`),
    noteRead: (seq) => calls.push(`read:${seq}`),
    noteKeyPress: () => calls.push('typing')
  };
  let capturedConfig: Record<string, unknown> = {};
  const client: TinodeClientLike = {
    connect: async () => { calls.push('connect'); },
    loginToken: async (token) => { calls.push(`login:${token}`); },
    getTopic: (name) => {
      calls.push(`topic:${name}`);
      return topic;
    },
    disconnect: () => { calls.push('disconnect'); }
  };
  const messages: unknown[] = [];
  const infos: unknown[] = [];
  const presences: unknown[] = [];
  const connections: string[] = [];
  const adapter = new TinodeRealtimeAdapter({
    plan: {
      provider: 'tinode',
      provider_topic_id: 'grp-led-order',
      provider_user_id: 'usr-led-agent',
      auth_token: 'user-token',
      ws_url: 'wss://chat.example.test/v0/channels?apikey=ignored-query-key',
      api_key: 'public-api-key'
    },
    clientFactory: (config) => {
      capturedConfig = config;
      return client;
    },
    onMessage: (message) => messages.push(message),
    onInfo: (info) => infos.push(info),
    onPresence: (presence) => presences.push(presence),
    onConnectionChange: (state) => connections.push(state)
  });

  await adapter.connect();
  assert.deepEqual(calls, ['connect', 'login:user-token', 'topic:grp-led-order', 'subscribe']);
  assert.deepEqual(capturedConfig, {
    host: 'chat.example.test',
    secure: true,
    appName: 'OPC iveKit Chat',
    apiKey: 'public-api-key',
    transport: 'ws',
    persist: false
  });
  assert.equal(connections.at(-1), 'connected');

  topic.onData?.({
    topic: 'grp-led-order',
    seq: 42,
    from: 'usr-customer',
    ts: '2026-07-10T15:00:00.000Z',
    head: { 'x-opc-message-id': 'cmsg-42' },
    content: 'hello'
  });
  topic.onInfo?.({ what: 'read', seq: 42, from: 'usr-customer' });
  topic.onPres?.({ what: 'on', src: 'usr-customer' });
  assert.deepEqual(messages, [{
    topic: 'grp-led-order',
    sequence: 42,
    from: 'usr-customer',
    timestamp: '2026-07-10T15:00:00.000Z',
    opc_message_id: 'cmsg-42',
    content: 'hello'
  }]);
  assert.deepEqual(infos, [{ what: 'read', sequence: 42, from: 'usr-customer' }]);
  assert.deepEqual(presences, [{ what: 'on', source: 'usr-customer' }]);

  adapter.noteReceived(42);
  adapter.noteRead(42);
  adapter.noteTyping();
  assert.equal('publish' in adapter, false);
  assert.equal('sendMessage' in adapter, false);
  await adapter.disconnect();
  assert.deepEqual(calls.slice(-5), ['recv:42', 'read:42', 'typing', 'leave', 'disconnect']);
  assert.equal(connections.at(-1), 'disconnected');
});

test('Tinode realtime adapter rejects incomplete or non-Tinode client plans', async () => {
  const base = {
    provider_topic_id: 'grp-topic',
    provider_user_id: 'usr-agent',
    auth_token: 'token',
    ws_url: 'wss://chat.example.test/v0/channels',
    api_key: 'api-key'
  };
  await assert.rejects(
    new TinodeRealtimeAdapter({
      plan: { ...base, provider: 'local' },
      clientFactory: () => { throw new Error('must not instantiate'); }
    }).connect(),
    /Tinode client plan is required/
  );
  await assert.rejects(
    new TinodeRealtimeAdapter({
      plan: { ...base, provider: 'tinode', auth_token: '' },
      clientFactory: () => { throw new Error('must not instantiate'); }
    }).connect(),
    /Tinode auth token is required/
  );
});

test('Tinode realtime adapter does not revive a connection after disconnect during login', async () => {
  let resolveLogin: (() => void) | null = null;
  const calls: string[] = [];
  const topic: TinodeTopicLike = {
    subscribe: async () => { calls.push('subscribe'); },
    noteRecv: () => undefined,
    noteRead: () => undefined,
    noteKeyPress: () => undefined
  };
  const client: TinodeClientLike = {
    connect: async () => { calls.push('connect'); },
    loginToken: async () => new Promise<void>((resolve) => { resolveLogin = resolve; }),
    getTopic: () => topic,
    disconnect: () => { calls.push('disconnect'); }
  };
  const adapter = new TinodeRealtimeAdapter({
    plan: {
      provider: 'tinode',
      provider_topic_id: 'grp-race',
      provider_user_id: 'usr-race',
      auth_token: 'token',
      ws_url: 'wss://chat.example.test/v0/channels',
      api_key: 'api-key'
    },
    clientFactory: () => client
  });

  const connecting = adapter.connect();
  await Promise.resolve();
  await adapter.disconnect();
  resolveLogin?.();
  await assert.rejects(connecting, /Tinode connection cancelled/);
  assert.equal(calls.includes('subscribe'), false);
  assert.throws(() => adapter.noteRead(1), /not connected/);
});
