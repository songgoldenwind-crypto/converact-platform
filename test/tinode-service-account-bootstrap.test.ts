import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import type { PgQueryable } from '../src/db-pg.js';
import {
  bootstrapTinodeServiceAccount,
  promoteTinodeBasicAccountToRoot,
  tinodeServiceAccountBootstrapConfigFromEnv
} from '../scripts/bootstrap-tinode-service-account.js';

test('Tinode bootstrap creates, promotes, and verifies the root service account', async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  assert.notEqual(typeof address, 'string');
  const packets: Array<Record<string, any>> = [];
  const promotions: string[] = [];
  let authLevel = 'auth';
  server.on('connection', (socket, request) => {
    assert.equal(new URL(request.url || '/', 'ws://localhost').searchParams.get('apikey'), 'root-api-key');
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      packets.push(packet);
      const requestBody = packet.hi || packet.acc || packet.login;
      socket.send(JSON.stringify({
        ctrl: {
          id: requestBody.id,
          code: 200,
          text: 'ok',
          params: packet.hi ? undefined : { user: 'usr-service', authlvl: authLevel }
        }
      }));
    });
  });

  try {
    const result = await bootstrapTinodeServiceAccount({
      wsUrl: `ws://127.0.0.1:${(address as { port: number }).port}/v0/channels`,
      apiKey: 'root-api-key',
      username: 'opc_service',
      password: 'strong-service-password',
      timeoutMs: 2_000
    }, WebSocket, async (username) => {
      promotions.push(username);
      authLevel = 'root';
    });

    assert.equal(result.status, 'created');
    assert.equal(result.authLevel, 'root');
    assert.deepEqual(promotions, ['opc_service']);
    assert.equal(packets.length, 4);
    assert.equal(packets[1].acc.scheme, 'basic');
    assert.equal(Buffer.from(packets[1].acc.secret, 'base64').toString(), 'opc_service:strong-service-password');
    assert.equal(JSON.stringify(packets).includes('root-api-key'), false);
    assert.ok(packets[3].login);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tinode bootstrap promotes and verifies existing service account credentials', async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address() as { port: number };
  const kinds: string[] = [];
  let authLevel = 'auth';
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
          text: kind === 'acc' ? 'duplicate credential' : 'ok',
          params: kind === 'login' ? { user: 'usr-service', authlvl: authLevel } : undefined
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
    }, WebSocket, async () => {
      authLevel = 'root';
    });

    assert.equal(result.status, 'existing');
    assert.equal(result.authLevel, 'root');
    assert.deepEqual(kinds, ['hi', 'acc', 'login', 'hi', 'login']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tinode bootstrap treats an unchanged-account 304 as existing and verifies login', async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address() as { port: number };
  const kinds: string[] = [];
  let authLevel = 'auth';
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const kind = packet.hi ? 'hi' : packet.acc ? 'acc' : 'login';
      kinds.push(kind);
      const body = packet[kind];
      socket.send(JSON.stringify({
        ctrl: {
          id: body.id,
          code: kind === 'acc' ? 304 : 200,
          text: kind === 'acc' ? 'not modified' : 'ok',
          params: kind === 'login' ? { user: 'usr-service', authlvl: authLevel } : undefined
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
    }, WebSocket, async () => {
      authLevel = 'root';
    });

    assert.equal(result.status, 'existing');
    assert.equal(result.authLevel, 'root');
    assert.deepEqual(kinds, ['hi', 'acc', 'login', 'hi', 'login']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tinode bootstrap rejects a promotion which does not produce a root login', async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address() as { port: number };
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const body = packet.hi || packet.acc || packet.login;
      socket.send(JSON.stringify({
        ctrl: {
          id: body.id,
          code: 200,
          text: 'ok',
          params: packet.hi ? undefined : { user: 'usr-service', authlvl: 'auth' }
        }
      }));
    });
  });

  try {
    await assert.rejects(() => bootstrapTinodeServiceAccount({
      wsUrl: `ws://127.0.0.1:${address.port}/v0/channels`,
      apiKey: 'root-api-key',
      username: 'opc_service',
      password: 'strong-service-password',
      timeoutMs: 2_000
    }, WebSocket, async () => undefined), /must authenticate at root level/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tinode root promotion is parameterized and verifies exactly one basic credential', async () => {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const pg = {
    async query(text: string, params?: unknown[]) {
      queries.push({ text, params });
      return {
        rows: [{ authlvl: 30 }],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: []
      };
    }
  } as unknown as PgQueryable;
  await promoteTinodeBasicAccountToRoot(pg, 'CONVERACT_Service');

  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /UPDATE auth/);
  assert.match(queries[0].text, /RETURNING authlvl/);
  assert.deepEqual(queries[0].params, [30, 'basic:converact_service', 'basic']);
});

test('Tinode root promotion fails closed when no credential is updated', async () => {
  const pg = {
    async query() {
      return {
        rows: [],
        rowCount: 0,
        command: 'UPDATE',
        oid: 0,
        fields: []
      };
    }
  } as unknown as PgQueryable;
  await assert.rejects(
    () => promoteTinodeBasicAccountToRoot(pg, 'opc_service'),
    /expected exactly one basic credential/
  );
});

test('Tinode bootstrap env parser rejects missing or weak service credentials', () => {
  assert.throws(() => tinodeServiceAccountBootstrapConfigFromEnv({}), /TINODE_WS_URL is required/);
  assert.throws(() => tinodeServiceAccountBootstrapConfigFromEnv({
    TINODE_WS_URL: 'ws://tinode:6060/v0/channels',
    TINODE_API_KEY: 'api-key',
    TINODE_ROOT_API_KEY: 'root-api-key',
    TINODE_BASIC_USER: 'opc_service',
    TINODE_BASIC_PASSWORD: 'password',
    TINODE_POSTGRES_DSN: 'postgresql://tinode@postgres:5432/tinode'
  }), /TINODE_BASIC_PASSWORD must not use a weak value/);
  assert.throws(() => tinodeServiceAccountBootstrapConfigFromEnv({
    TINODE_WS_URL: 'ws://tinode:6060/v0/channels',
    TINODE_API_KEY: 'public-browser-key',
    TINODE_BASIC_USER: 'opc_service',
    TINODE_BASIC_PASSWORD: 'strong-service-password',
    TINODE_POSTGRES_DSN: 'postgresql://tinode@postgres:5432/tinode'
  }), /TINODE_ROOT_API_KEY is required/);
  assert.throws(() => tinodeServiceAccountBootstrapConfigFromEnv({
    TINODE_WS_URL: 'ws://tinode:6060/v0/channels',
    TINODE_ROOT_API_KEY: 'root-api-key',
    TINODE_BASIC_USER: 'opc_service',
    TINODE_BASIC_PASSWORD: 'strong-service-password'
  }), /TINODE_POSTGRES_DSN is required/);
});

test('Tinode bootstrap env parser prefers the server root API key over the browser key', () => {
  const config = tinodeServiceAccountBootstrapConfigFromEnv({
    TINODE_WS_URL: 'ws://tinode:6060/v0/channels',
    TINODE_API_KEY: 'public-browser-key',
    TINODE_ROOT_API_KEY: 'root-server-key',
    TINODE_BASIC_USER: 'opc_service',
    TINODE_BASIC_PASSWORD: 'strong-service-password',
    TINODE_POSTGRES_DSN: 'postgresql://tinode@postgres:5432/tinode'
  });

  assert.equal(config.apiKey, 'root-server-key');
  assert.equal(config.postgresDsn, 'postgresql://tinode@postgres:5432/tinode');
});
