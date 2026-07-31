import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';

import { IveKitTenantEventStore } from '../src/agent-runtime/converact/tenant-event-store.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { resetRedisPubSubForTests } from '../src/redis-pubsub.js';
import {
  _resetWsState,
  initWebSocket,
  runWithWsBroadcastBuffer,
  shutdownWebSocket,
  wsBroadcast,
  wsBroadcastToUsers
} from '../src/ws.js';

const tenantId = 'tenant_event_ws';
const userId = 'event-ws-user';
const pg = new MemoryPg();
const events = new IveKitTenantEventStore(pg, { cursor_secret: 'event-ws-secret' });
const server = createServer((_request, response) => response.end('ok'));
let port = 0;
let token = '';

before(async () => {
  process.env.CONVERACT_JWT_SECRET = 'event-ws-secret';
  process.env.CONVERACT_USE_MEMORY_REDIS = '1';
  resetRedisPubSubForTests(null);
  _resetWsState();
  initWebSocket(server, { eventStore: events });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  port = address.port;
  token = signAccessToken({ sub: userId, tid: tenantId, role: 'operator' });
});

after(async () => {
  await shutdownWebSocket();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetRedisPubSubForTests(null);
});

test('WebSocket resumes durable tenant events once after an offline gap', async () => {
  const initial = await connectAndCollect();
  const connected = initial.find((message) => message.type === 'connected');
  assert.ok(connected?.data.head_cursor);

  await wsBroadcast(tenantId, 'ivekit.notice.updated', { notice_id: 'notice-offline' });

  const replayed = await connectAndCollect(String(connected.data.head_cursor), 'ivekit.notice.updated');
  assert.equal(replayed[0]?.type, 'connected');
  assert.equal(replayed[0]?.data.snapshot_required, false);
  const notices = replayed.filter((message) => message.type === 'ivekit.notice.updated');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.data.notice_id, 'notice-offline');
  assert.match(String(notices[0]?.event_id), /^\d+$/);
  assert.ok(notices[0]?.cursor);
  assert.ok(notices[0]?.timestamp);

  const afterReplay = await connectAndCollect(String(notices[0]?.cursor));
  assert.equal(afterReplay.some((message) => message.type === 'ivekit.notice.updated'), false);
});

test('WebSocket returns snapshot_required for an invalid resume cursor', async () => {
  const messages = await connectAndCollect('invalid.cursor');
  assert.equal(messages[0]?.type, 'connected');
  assert.equal(messages[0]?.data.snapshot_required, true);
  assert.equal(messages[0]?.data.reason, 'invalid_cursor');
});

test('request event buffering persists only after a successful flush', async () => {
  const before = await events.headCursor(tenantId);
  const buffered = await runWithWsBroadcastBuffer(async () => {
    await wsBroadcast(tenantId, 'ivekit.buffered.updated', { buffered_id: 'buffered-1' });
    return 'committed';
  });
  assert.equal(buffered.result, 'committed');
  const pending = await events.list({
    tenant_id: tenantId,
    user_id: userId,
    role: 'operator',
    cursor: before,
    limit: 10
  });
  assert.deepEqual(pending.items, []);

  await buffered.flush();
  const committed = await events.list({
    tenant_id: tenantId,
    user_id: userId,
    role: 'operator',
    cursor: before,
    limit: 10
  });
  assert.deepEqual(committed.items.map((event) => event.type), ['ivekit.buffered.updated']);
});

test('durable iveKit replay does not absorb unrelated call-center broadcasts', async () => {
  const before = await events.headCursor(tenantId);
  await wsBroadcast(tenantId, 'call.completed', { call_id: 'legacy-call-1' });
  const replay = await events.list({
    tenant_id: tenantId,
    user_id: userId,
    role: 'operator',
    cursor: before,
    limit: 10
  });
  assert.deepEqual(replay.items, []);
});

test('targeted notification broadcasts are durable and idempotent', async () => {
  const before = await events.headCursor(tenantId);
  const data = {
    notification_id: 'notification-ws-a',
    delivery_id: 'delivery-ws-a',
    state: 'delivered'
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await wsBroadcastToUsers(
      tenantId,
      [userId],
      'notification.delivery.updated',
      data,
      { idempotency_key: 'notification:delivery:ws-stable-key' }
    );
  }
  const replay = await events.list({
    tenant_id: tenantId,
    user_id: userId,
    role: 'operator',
    cursor: before,
    limit: 10
  });
  assert.equal(replay.items.length, 1);
  assert.equal(replay.items[0]?.type, 'notification.delivery.updated');
  assert.deepEqual(replay.items[0]?.audience_user_ids, [userId]);
});

async function connectAndCollect(cursor = '', waitForType = ''): Promise<any[]> {
  const url = new URL(`ws://127.0.0.1:${port}/ws`);
  url.searchParams.set('token', token);
  if (cursor) url.searchParams.set('cursor', cursor);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages: any[] = [];
    const timer = setTimeout(() => {
      socket.close();
      if (waitForType) reject(new Error(`timed out waiting for ${waitForType}`));
      else resolve(messages);
    }, waitForType ? 5_000 : 100);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      if ((!waitForType && message.type === 'connected') || message.type === waitForType) {
        setTimeout(() => {
          clearTimeout(timer);
          socket.close();
          resolve(messages);
        }, 30);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
