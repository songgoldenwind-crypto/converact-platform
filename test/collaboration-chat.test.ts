import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

import {
  LocalChatGateway,
  TinodeChatGateway,
  configuredChatGateway,
  tinodeTopicNameForSession
} from '../src/agent-runtime/collaboration/chat-gateway.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { MemoryPg } from '../src/db-pg.js';

test('local chat gateway creates deterministic session topic bindings', async () => {
  const gateway = new LocalChatGateway();
  const binding = await gateway.ensureTopic({
    tenant_id: 'tenant_led',
    session_id: 'collab_123',
    title: 'LED order chat'
  });

  assert.equal(binding.provider, 'local');
  assert.equal(binding.provider_topic_id, 'local:tenant_led:collab_123');
  assert.equal(binding.provider_status, 'bound');
});

test('tinode topic names are stable and tenant scoped', () => {
  assert.equal(tinodeTopicNameForSession('tenant led', 'collab.123'), 'grp_tenant_led_collab_123');
});

test('configured chat gateway falls back to local when Tinode is not configured', () => {
  const gateway = configuredChatGateway({} as NodeJS.ProcessEnv);
  assert.equal(gateway.provider, 'local');
});

test('configured chat gateway uses Tinode when websocket URL is configured', () => {
  const gateway = configuredChatGateway({
    TINODE_WS_URL: 'ws://tinode.local/v0/channels',
    TINODE_API_KEY: 'tinode-api-key',
    TINODE_AUTH_TOKEN: 'tinode-auth-token'
  } as NodeJS.ProcessEnv);
  assert.equal(gateway.provider, 'tinode');
});

test('Tinode chat gateway removes URL credentials from persisted binding metadata', async () => {
  const gateway = new TinodeChatGateway({
    base_url: 'https://root:password@tinode.example.com/api?apikey=secret-key'
  });
  const binding = await gateway.ensureTopic({
    tenant_id: 'tenant_metadata',
    session_id: 'session_metadata'
  });
  assert.equal(binding.metadata.base_url, 'https://tinode.example.com/api');
  assert.equal(JSON.stringify(binding).includes('password'), false);
  assert.equal(JSON.stringify(binding).includes('secret-key'), false);
});

test('collaboration store binds chat topic and lists messages', async () => {
  const pg = new MemoryPg();
  const module = createCollaborationModule({ pg });
  const session = await module.sessions.openSession({
    tenant_id: 'tenant_chat',
    business_ref: { tenant_id: 'tenant_chat', type: 'service_order', id: 'order_chat_1' }
  });

  const binding = await module.sessions.ensureChatBinding({
    tenant_id: 'tenant_chat',
    session_id: session.id,
    provider: 'local',
    provider_topic_id: 'local:tenant_chat:topic_1',
    metadata: { source: 'test' }
  });
  await module.sessions.postMessage({
    tenant_id: 'tenant_chat',
    session_id: session.id,
    sender_identity: 'customer_1',
    message_type: 'text',
    body: 'hello'
  });

  assert.equal(binding.provider_topic_id, 'local:tenant_chat:topic_1');
  const messages = await module.sessions.listMessages({ tenant_id: 'tenant_chat', session_id: session.id });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, 'hello');
});

test('collaboration store marks participants left without deleting history', async () => {
  const pg = new MemoryPg();
  const module = createCollaborationModule({ pg });
  const session = await module.sessions.openSession({
    tenant_id: 'tenant_chat_leave',
    business_ref: { tenant_id: 'tenant_chat_leave', type: 'service_order', id: 'order_chat_leave' }
  });
  await module.sessions.addParticipant({
    tenant_id: 'tenant_chat_leave',
    session_id: session.id,
    identity: 'customer_leave',
    role: 'customer'
  });

  const left = await module.sessions.leaveParticipant({
    tenant_id: 'tenant_chat_leave',
    session_id: session.id,
    identity: 'customer_leave'
  });

  assert.equal(left?.identity, 'customer_leave');
  assert.ok(left?.left_at);
  const participants = await module.sessions.listParticipants({
    tenant_id: 'tenant_chat_leave',
    session_id: session.id
  });
  assert.equal(participants.length, 1);
  assert.ok(participants[0].left_at);
});

test('Tinode chat gateway creates topic and publishes text over websocket protocol', async () => {
  const { url, packets, close } = await startFakeTinodeServer();
  try {
    const gateway = new TinodeChatGateway({
      base_url: url.replace(/^ws:/, 'http:').replace('/v0/channels', ''),
      ws_url: url,
      api_key: 'tinode-api-key',
      auth_token: 'tinode-auth-token',
      timeout_ms: 1_000
    });

    const binding = await gateway.ensureTopic({
      tenant_id: 'tenant_tinode',
      session_id: 'collab_tinode',
      title: 'Tinode chat'
    });
    assert.equal(binding.provider_topic_id, 'grpTinodeTopic');

    const published = await gateway.publishMessage({
      tenant_id: 'tenant_tinode',
      session_id: 'collab_tinode',
      provider_topic_id: binding.provider_topic_id,
      sender_identity: 'customer_1',
      body: 'hello tinode',
      metadata: {
        opc_message_id: 'cmsg_tinode_1',
        idempotency_key: 'client-message-1'
      }
    });

    assert.equal(published.provider_sync_status, 'published');
    assert.equal(published.provider_message_id, '42');
    assert.equal(packets.some((packet) => packet.hi), true);
    assert.equal(packets.some((packet) => packet.login?.scheme === 'token'), true);
    assert.equal(packets.some((packet) => packet.sub?.topic === 'new'), true);
    assert.equal(packets.some((packet) => packet.sub?.topic === 'grpTinodeTopic'), true);
    assert.equal(packets.some((packet) => packet.pub?.topic === 'grpTinodeTopic' && packet.pub?.content === 'hello tinode'), true);
    assert.equal(
      packets.some((packet) =>
        packet.pub?.head?.['x-opc-message-id'] === 'cmsg_tinode_1' &&
        packet.pub?.head?.['x-opc-idempotency-key'] === 'client-message-1'
      ),
      true
    );
  } finally {
    await close();
  }
});

test('Tinode chat gateway grants topic access when adding participants', async () => {
  const { url, packets, close } = await startFakeTinodeServer();
  try {
    const gateway = new TinodeChatGateway({
      base_url: url.replace(/^ws:/, 'http:').replace('/v0/channels', ''),
      ws_url: url,
      api_key: 'tinode-api-key',
      auth_token: 'tinode-auth-token',
      timeout_ms: 1_000
    });

    await gateway.addParticipant({
      tenant_id: 'tenant_tinode',
      session_id: 'collab_tinode',
      provider_topic_id: 'grpTinodeTopic',
      identity: 'customer_1',
      provider_user_id: 'usrCustomerTinode',
      display_name: 'Customer'
    });

    assert.equal(packets.some((packet) => packet.sub?.topic === 'grpTinodeTopic'), true);
    assert.equal(
      packets.some((packet) =>
        packet.set?.topic === 'grpTinodeTopic' &&
        packet.set?.sub?.user === 'usrCustomerTinode' &&
        packet.set?.sub?.mode === 'JRP'
      ),
      true
    );
  } finally {
    await close();
  }
});

test('Tinode chat gateway revokes topic access when removing participants', async () => {
  const { url, packets, close } = await startFakeTinodeServer();
  try {
    const gateway = new TinodeChatGateway({
      base_url: url.replace(/^ws:/, 'http:').replace('/v0/channels', ''),
      ws_url: url,
      api_key: 'tinode-api-key',
      auth_token: 'tinode-auth-token',
      timeout_ms: 1_000
    });

    await gateway.removeParticipant({
      tenant_id: 'tenant_tinode',
      session_id: 'collab_tinode',
      provider_topic_id: 'grpTinodeTopic',
      identity: 'customer_1',
      provider_user_id: 'usrCustomerTinode',
      display_name: 'Customer'
    });

    assert.equal(
      packets.some((packet) =>
        packet.set?.topic === 'grpTinodeTopic' &&
        packet.set?.sub?.user === 'usrCustomerTinode' &&
        packet.set?.sub?.mode === 'N'
      ),
      true
    );
  } finally {
    await close();
  }
});

test('Tinode chat gateway creates basic accounts for OPC identities', async () => {
  const { url, packets, close } = await startFakeTinodeServer();
  try {
    const gateway = new TinodeChatGateway({
      base_url: url.replace(/^ws:/, 'http:').replace('/v0/channels', ''),
      ws_url: url,
      api_key: 'tinode-api-key',
      auth_token: 'tinode-auth-token',
      user_password_secret: 'tinode-user-secret',
      timeout_ms: 1_000
    });

    const user = await gateway.ensureUser({
      tenant_id: 'tenant_tinode',
      identity: 'customer_1',
      display_name: 'Customer One'
    }) as { provider_user_id: string; provider_auth_token?: string; metadata: Record<string, unknown> };

    assert.equal(user.provider_user_id, 'usrCreatedCustomer');
    assert.equal(user.provider_auth_token, 'token-created-customer');
    const accPacket = packets.find((packet) => packet.acc);
    assert.ok(accPacket);
    assert.equal(accPacket.acc.scheme, 'basic');
    assert.equal(accPacket.acc.login, true);
    assert.match(String(accPacket.acc.user), /^new/);
    assert.equal(accPacket.acc.desc.public.fn, 'Customer One');
    assert.equal(accPacket.acc.desc.public['x-opc-tenant'], 'tenant_tinode');
    assert.equal(accPacket.acc.desc.public['x-opc-identity'], 'customer_1');
  } finally {
    await close();
  }
});

test('Tinode chat gateway logs in existing basic accounts when account creation conflicts', async () => {
  const { url, packets, close } = await startFakeTinodeServer({ accountAlreadyExists: true });
  try {
    const gateway = new TinodeChatGateway({
      base_url: url.replace(/^ws:/, 'http:').replace('/v0/channels', ''),
      ws_url: url,
      api_key: 'tinode-api-key',
      auth_token: 'tinode-auth-token',
      user_password_secret: 'tinode-user-secret',
      timeout_ms: 1_000
    });

    const user = await gateway.ensureUser({
      tenant_id: 'tenant_tinode',
      identity: 'customer_1',
      display_name: 'Customer One'
    }) as { provider_user_id: string; provider_auth_token?: string };

    assert.equal(user.provider_user_id, 'usrExistingCustomer');
    assert.equal(user.provider_auth_token, 'token-existing-customer');
    assert.equal(packets.some((packet) => packet.acc), true);
    assert.equal(packets.some((packet) => packet.login?.scheme === 'basic'), true);
  } finally {
    await close();
  }
});

async function startFakeTinodeServer(options: { accountAlreadyExists?: boolean } = {}): Promise<{
  url: string;
  packets: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const packets: Array<Record<string, any>> = [];
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/v0/channels' });
  wss.on('connection', (ws, req) => {
    assert.equal(req.url?.includes('apikey=tinode-api-key'), true);
    ws.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      packets.push(packet);
      if (packet.hi) {
        ws.send(JSON.stringify({ ctrl: { id: packet.hi.id, code: 200, text: 'ok', params: { ver: '0.22' } } }));
      } else if (packet.login) {
        const params = packet.login.scheme === 'basic'
          ? { user: 'usrExistingCustomer', token: 'token-existing-customer' }
          : { user: 'usrRoot' };
        ws.send(JSON.stringify({ ctrl: { id: packet.login.id, code: 200, text: 'ok', params } }));
      } else if (packet.acc) {
        if (options.accountAlreadyExists) {
          ws.send(JSON.stringify({
            ctrl: {
              id: packet.acc.id,
              code: 409,
              text: 'account exists'
            }
          }));
          return;
        }
        ws.send(JSON.stringify({
          ctrl: {
            id: packet.acc.id,
            code: 200,
            text: 'ok',
            params: { user: 'usrCreatedCustomer', token: 'token-created-customer' }
          }
        }));
      } else if (packet.sub?.topic === 'new') {
        ws.send(JSON.stringify({ ctrl: { id: packet.sub.id, topic: 'grpTinodeTopic', code: 200, text: 'ok' } }));
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
            params: { seq: 42 }
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
