import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';

import { signAccessToken } from '../src/middleware/auth.js';
import {
  _resetWsState,
  initWebSocket,
  shutdownWebSocket,
  wsBroadcastToUsers
} from '../src/ws.js';

const server = createServer();
const previous = {
  jwtSecret: process.env.OPC_JWT_SECRET,
  memoryRedis: process.env.OPC_USE_MEMORY_REDIS
};

before(async () => {
  process.env.OPC_JWT_SECRET = 'targeted-ws-broadcast-secret';
  process.env.OPC_USE_MEMORY_REDIS = '1';
  _resetWsState();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  initWebSocket(server);
});

after(async () => {
  await shutdownWebSocket();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restoreEnv('OPC_JWT_SECRET', previous.jwtSecret);
  restoreEnv('OPC_USE_MEMORY_REDIS', previous.memoryRedis);
});

test('targeted WebSocket broadcast does not leak to another tenant member', async () => {
  const target = await connect('tenant-targeted', 'call-member');
  const outsider = await connect('tenant-targeted', 'tenant-outsider');
  const targetEvents: string[] = [];
  const outsiderEvents: string[] = [];
  target.on('message', (raw) => targetEvents.push(JSON.parse(String(raw)).type));
  outsider.on('message', (raw) => outsiderEvents.push(JSON.parse(String(raw)).type));

  wsBroadcastToUsers(
    'tenant-targeted',
    ['call-member'],
    'ivekit.media.call.updated',
    { call_id: 'mcall-targeted', status: 'active' }
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(targetEvents.includes('ivekit.media.call.updated'), true);
  assert.equal(outsiderEvents.includes('ivekit.media.call.updated'), false);
  target.close();
  outsider.close();
});

async function connect(tenantId: string, identity: string): Promise<WebSocket> {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const token = signAccessToken({ sub: identity, tid: tenantId, role: 'operator' });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
