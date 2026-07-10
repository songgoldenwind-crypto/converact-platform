import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

import {
  createTinodeChatSmokeConfigFromEnv,
  runTinodeChatSmoke
} from '../scripts/tinode-chat-smoke.js';

test('Tinode chat smoke config requires base URL api key and auth', () => {
  assert.throws(
    () => createTinodeChatSmokeConfigFromEnv({ TINODE_API_KEY: 'key', TINODE_AUTH_TOKEN: 'token' }),
    /TINODE_BASE_URL or TINODE_WS_URL is required/
  );
  assert.throws(
    () => createTinodeChatSmokeConfigFromEnv({ TINODE_BASE_URL: 'http://tinode.local', TINODE_AUTH_TOKEN: 'token' }),
    /TINODE_API_KEY is required/
  );
  assert.throws(
    () => createTinodeChatSmokeConfigFromEnv({ TINODE_BASE_URL: 'http://tinode.local', TINODE_API_KEY: 'key' }),
    /TINODE_AUTH_TOKEN or TINODE_BASIC_USER is required/
  );
});

test('Tinode chat smoke is wired into package scripts and env example', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['smoke:chat:tinode'], 'tsx scripts/tinode-chat-smoke.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const key of [
    'TINODE_BASE_URL=',
    'TINODE_WS_URL=',
    'TINODE_API_KEY=',
    'TINODE_AUTH_TOKEN=',
    'TINODE_USER_PASSWORD_SECRET=',
    'TINODE_CHAT_SMOKE_TENANT_ID=',
    'TINODE_CHAT_SMOKE_SESSION_ID=',
    'TINODE_CHAT_SMOKE_PARTICIPANT_IDENTITY=',
    'TINODE_CHAT_SMOKE_PARTICIPANT_USER_ID='
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, 'm'));
  }
});

test('Tinode chat smoke creates a topic and publishes one message', async () => {
  const fake = await startFakeTinodeServer();
  try {
    const result = await runTinodeChatSmoke({
      baseUrl: fake.url.replace(/^ws:/, 'http:').replace('/v0/channels', ''),
      wsUrl: fake.url,
      apiKey: 'tinode-smoke-key',
      authToken: 'tinode-smoke-token',
      tenantId: 'tenant_smoke',
      sessionId: 'collab_smoke',
      title: 'Tinode smoke',
      senderIdentity: 'agent_smoke',
      participantIdentity: 'customer_smoke',
      userPasswordSecret: 'tinode-user-secret',
      body: 'hello from smoke',
      timeoutMs: 1_000
    });

    assert.equal(result.provider, 'tinode');
    assert.equal(result.topicId, 'grpSmokeTopic');
    assert.equal(result.messageId, '314');
    assert.equal(result.participantGranted, true);
    assert.equal(result.participantUserId, 'usrSmokeCustomer');
    assert.equal(result.participantAuthToken, 'token-smoke-customer');
    assert.equal(fake.packets.some((packet) => packet.sub?.topic === 'new'), true);
    assert.equal(fake.packets.some((packet) => packet.acc?.scheme === 'basic' && packet.acc?.login === true), true);
    assert.equal(
      fake.packets.some((packet) =>
        packet.set?.topic === 'grpSmokeTopic' &&
        packet.set?.sub?.user === 'usrSmokeCustomer' &&
        packet.set?.sub?.mode === 'JRP'
      ),
      true
    );
    assert.equal(fake.packets.some((packet) => packet.pub?.topic === 'grpSmokeTopic'), true);
  } finally {
    await fake.close();
  }
});

async function startFakeTinodeServer(): Promise<{
  url: string;
  packets: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const packets: Array<Record<string, any>> = [];
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/v0/channels' });
  wss.on('connection', (ws, req) => {
    assert.equal(req.url?.includes('apikey=tinode-smoke-key'), true);
    ws.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      packets.push(packet);
      if (packet.hi) {
        ws.send(JSON.stringify({ ctrl: { id: packet.hi.id, code: 200, text: 'ok', params: { ver: '0.22' } } }));
      } else if (packet.login) {
        ws.send(JSON.stringify({ ctrl: { id: packet.login.id, code: 200, text: 'ok', params: { user: 'usrSmoke' } } }));
      } else if (packet.acc) {
        ws.send(JSON.stringify({
          ctrl: {
            id: packet.acc.id,
            code: 200,
            text: 'ok',
            params: { user: 'usrSmokeCustomer', token: 'token-smoke-customer' }
          }
        }));
      } else if (packet.sub?.topic === 'new') {
        ws.send(JSON.stringify({ ctrl: { id: packet.sub.id, topic: 'grpSmokeTopic', code: 200, text: 'ok' } }));
      } else if (packet.sub) {
        ws.send(JSON.stringify({ ctrl: { id: packet.sub.id, topic: packet.sub.topic, code: 200, text: 'ok' } }));
      } else if (packet.set) {
        ws.send(JSON.stringify({ ctrl: { id: packet.set.id, topic: packet.set.topic, code: 200, text: 'ok' } }));
      } else if (packet.pub) {
        ws.send(JSON.stringify({
          ctrl: {
            id: packet.pub.id,
            topic: packet.pub.topic,
            code: 200,
            text: 'ok',
            params: { seq: 314 }
          }
        }));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `ws://127.0.0.1:${address.port}/v0/channels`,
    packets,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
