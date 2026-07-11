import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import {
  bootstrapTinodeServiceAccount,
  tinodeServiceAccountBootstrapConfigFromEnv
} from '../scripts/bootstrap-tinode-service-account.js';

test('Tinode bootstrap creates the service account with the configured API key', async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  assert.notEqual(typeof address, 'string');
  const packets: Array<Record<string, any>> = [];
  server.on('connection', (socket, request) => {
    assert.equal(new URL(request.url || '/', 'ws://localhost').searchParams.get('apikey'), 'root-api-key');
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      packets.push(packet);
      const requestBody = packet.hi || packet.acc;
      socket.send(JSON.stringify({ ctrl: { id: requestBody.id, code: 200, text: 'ok', params: { user: 'usr-service' } } }));
    });
  });

  try {
    const result = await bootstrapTinodeServiceAccount({
      wsUrl: `ws://127.0.0.1:${(address as { port: number }).port}/v0/channels`,
      apiKey: 'root-api-key',
      username: 'opc_service',
      password: 'strong-service-password',
      timeoutMs: 2_000
    }, WebSocket);

    assert.equal(result.status, 'created');
    assert.equal(packets.length, 2);
    assert.equal(packets[1].acc.scheme, 'basic');
    assert.equal(Buffer.from(packets[1].acc.secret, 'base64').toString(), 'opc_service:strong-service-password');
    assert.equal(JSON.stringify(packets).includes('root-api-key'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tinode bootstrap verifies existing service account credentials', async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address() as { port: number };
  const kinds: string[] = [];
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const kind = packet.hi ? 'hi' : packet.acc ? 'acc' : 'login';
      kinds.push(kind);
      const body = packet[kind];
      socket.send(JSON.stringify({
        ctrl: {
          id: body.id,
          code: kind === 'acc' ? 409 : 200,
          text: kind === 'acc' ? 'duplicate credential' : 'ok'
        }
      }));
    });
  });

  try {
    const result = await bootstrapTinodeServiceAccount({
      wsUrl: `ws://127.0.0.1:${address.port}/v0/channels`,
      apiKey: 'root-api-key',
      username: 'opc_service',
      password: 'strong-service-password',
      timeoutMs: 2_000
    }, WebSocket);

    assert.equal(result.status, 'existing');
    assert.deepEqual(kinds, ['hi', 'acc', 'login']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tinode bootstrap env parser rejects missing or weak service credentials', () => {
  assert.throws(() => tinodeServiceAccountBootstrapConfigFromEnv({}), /TINODE_WS_URL is required/);
  assert.throws(() => tinodeServiceAccountBootstrapConfigFromEnv({
    TINODE_WS_URL: 'ws://tinode:6060/v0/channels',
    TINODE_API_KEY: 'api-key',
    TINODE_BASIC_USER: 'opc_service',
    TINODE_BASIC_PASSWORD: 'password'
  }), /TINODE_BASIC_PASSWORD must not use a weak value/);
});
