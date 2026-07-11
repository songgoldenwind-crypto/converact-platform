import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ReceiveOnlyTinodeAdapter, type TinodeClientLike, type TinodeTopicLike } from './tinode-adapter.js';

const plan = {
  provider: 'tinode',
  provider_topic_id: 'grp-led',
  provider_user_id: 'usr-led',
  auth_token: 'token-1',
  ws_url: 'wss://chat.example.test/v0/channels',
  api_key: 'public-key',
  participant: {} as never
};

test('receive-only adapter coalesces connect, refreshes token, subscribes, and exposes notes only', async () => {
  const calls: string[] = [];
  const topic = fakeTopic(calls);
  const client = fakeClient(calls, topic);
  let planReads = 0;
  const states: string[] = [];
  const invalidations: string[] = [];
  const adapter = new ReceiveOnlyTinodeAdapter({
    getPlan: async () => ({ ...plan, auth_token: `token-${++planReads}` }),
    clientFactory: () => client,
    onStateChange: (state) => states.push(state),
    onInvalidate: (trigger) => invalidations.push(trigger)
  });
  const first = adapter.connect();
  const second = adapter.connect();
  assert.equal(first, second);
  await first;
  assert.deepEqual(calls.slice(0, 4), ['connect', 'login:token-1', 'topic:grp-led', 'subscribe']);
  topic.onData?.({ seq: 8 });
  adapter.noteReceived(8);
  adapter.noteRead(8);
  adapter.noteTyping();
  assert.deepEqual(invalidations, ['tinode_data']);
  assert.equal(states.at(-1), 'online');
  assert.equal('publish' in adapter, false);
  assert.equal('send' in adapter, false);
  assert.equal('createMessage' in adapter, false);
  await adapter.disconnect();
  await adapter.connect();
  assert.equal(calls.includes('login:token-2'), true);
  await adapter.dispose();
  assert.equal(states.at(-1), 'closed');
});

test('adapter suppresses stale login and reconnects with bounded injected backoff', async () => {
  const scheduler = new FakeScheduler();
  const calls: string[] = [];
  let resolveLogin: (() => void) | undefined;
  const topic = fakeTopic(calls);
  const firstClient = fakeClient(calls, topic, async () => new Promise<void>((resolve) => { resolveLogin = resolve; }));
  const secondClient = fakeClient(calls, topic);
  let factoryCalls = 0;
  const adapter = new ReceiveOnlyTinodeAdapter({
    getPlan: async () => plan,
    clientFactory: () => ++factoryCalls === 1 ? firstClient : secondClient,
    scheduler,
    random: () => 0,
    backoffMs: [100, 200, 400]
  });
  const connecting = adapter.connect();
  await Promise.resolve();
  await adapter.disconnect();
  resolveLogin?.();
  await assert.rejects(connecting, /cancelled/);
  assert.equal(calls.includes('subscribe'), false);

  await adapter.connect();
  secondClient.onDisconnect?.(new Error('network'));
  assert.equal(scheduler.delays.includes(100), true);
  scheduler.runDelay(100);
  await flushMicrotasks();
  assert.equal(factoryCalls, 3);
  secondClient.onDisconnect?.(new Error('network again'));
  assert.equal(scheduler.delays.includes(200), true);
  await adapter.dispose();
  assert.equal(scheduler.pending, 0);
});

test('receive-only adapter source has no business-message write surface', () => {
  const source = readFileSync('src/chat/tinode-adapter.ts', 'utf8');
  const publicClass = source.match(/export class ReceiveOnlyTinodeAdapter \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(publicClass, /\b(?:publish|send|createMessage)\s*\(/);
  assert.doesNotMatch(source, /publishMessage|sendMessage/);
  assert.match(source, /import \* as TinodeSdk from 'tinode-sdk'/);
  assert.doesNotMatch(source, /import TinodeSdk from 'tinode-sdk'/);
});

test('adapter rejects unbounded retry schedules', () => {
  assert.throws(() => new ReceiveOnlyTinodeAdapter({
    getPlan: async () => plan,
    backoffMs: [10, 120_000]
  }), /backoff/);
});

test('adapter pauses offline, resumes online, and stops on auth failure', async () => {
  const scheduler = new FakeScheduler();
  let attempts = 0;
  const states: string[] = [];
  const adapter = new ReceiveOnlyTinodeAdapter({
    getPlan: async () => {
      attempts += 1;
      if (attempts === 2) throw Object.assign(new Error('expired'), { status: 401 });
      return plan;
    },
    clientFactory: () => fakeClient([], fakeTopic([])),
    scheduler,
    onStateChange: (state) => states.push(state)
  });
  adapter.setNetworkOnline(false);
  await assert.rejects(adapter.connect(), /offline/);
  adapter.setNetworkOnline(true);
  await adapter.connect();
  assert.equal(states.includes('online'), true);
  adapter.forceReconnect();
  scheduler.runDelay(0);
  await flushMicrotasks();
  assert.equal(states.at(-1), 'fatal');
  assert.equal(scheduler.pending, 0);
});

test('adapter gives browser connection events a useful error message', async () => {
  let reported = '';
  const adapter = new ReceiveOnlyTinodeAdapter({
    getPlan: async () => plan,
    clientFactory: () => ({
      ...fakeClient([], fakeTopic([])),
      connect: async () => { throw new Event('error'); }
    }),
    scheduler: new FakeScheduler(),
    onError: (error) => { reported = error.message; }
  });
  await assert.rejects(adapter.connect(), /Tinode connection failed/);
  assert.equal(reported, 'Tinode connection failed');
  await adapter.dispose();
});

function fakeTopic(calls: string[]): TinodeTopicLike {
  return {
    subscribe: async () => { calls.push('subscribe'); },
    leave: async () => { calls.push('leave'); },
    noteRecv: (seq) => calls.push(`recv:${seq}`),
    noteRead: (seq) => calls.push(`read:${seq}`),
    noteKeyPress: () => calls.push('typing')
  };
}

function fakeClient(
  calls: string[],
  topic: TinodeTopicLike,
  login: () => Promise<void> = async () => undefined
): TinodeClientLike {
  return {
    connect: async () => { calls.push('connect'); },
    loginToken: async (token) => { calls.push(`login:${token}`); await login(); },
    getTopic: (name) => { calls.push(`topic:${name}`); return topic; },
    disconnect: () => { calls.push('disconnect'); }
  };
}

class FakeScheduler {
  readonly delays: number[] = [];
  private queue: Array<{ callback: () => void; delay: number }> = [];
  get pending() { return this.queue.length; }
  setTimeout(callback: () => void, delay: number) { const item = { callback, delay }; this.delays.push(delay); this.queue.push(item); return item; }
  clearTimeout(handle: unknown) { this.queue = this.queue.filter((item) => item !== handle); }
  runNext() { this.queue.shift()?.callback(); }
  runDelay(delay: number) { const index = this.queue.findIndex((item) => item.delay === delay); if (index >= 0) this.queue.splice(index, 1)[0].callback(); }
  async flush() { while (this.queue.length) { this.runNext(); await flushMicrotasks(); } }
}

async function flushMicrotasks() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }
