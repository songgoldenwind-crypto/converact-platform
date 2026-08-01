import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

import {
  ChatMutationOutcomeUnknownError,
  LocalChatGateway,
  TinodeChatGateway,
  configuredChatGateway,
  legacyTinodeBasicUsernameForIdentity,
  tinodeTopicNameForSession
} from '../src/agent-runtime/collaboration/chat-gateway.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';

function result(rows: Record<string, unknown>[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

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

test('chat binding creation resolves a concurrent insert winner', async () => {
  let bindingReads = 0;
  let insertSql = '';
  const winner = {
    id: 'cbind_winner', tenant_id: 'tenant_race', session_id: 'collab_race',
    provider: 'tinode', provider_topic_id: 'grpWinner', provider_status: 'bound',
    metadata: '{}', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  const pg = {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT * FROM collaboration_sessions')) {
        return result([{ id: 'collab_race', tenant_id: 'tenant_race', business_ref_type: 'service_order', business_ref_id: 'SO-RACE', title: '', status: 'active', metadata: '{}', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
      }
      if (normalized.startsWith('SELECT * FROM collaboration_chat_bindings WHERE tenant_id')) {
        bindingReads += 1;
        return result(bindingReads === 1 ? [] : [winner]);
      }
      if (normalized.startsWith('INSERT INTO collaboration_chat_bindings')) {
        insertSql = normalized;
        return result([]);
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    }
  } as PgQueryable;

  const binding = await new CollaborationStore(pg).ensureChatBinding({
    tenant_id: 'tenant_race', session_id: 'collab_race', provider: 'tinode',
    provider_topic_id: 'grpLoser'
  });

  assert.equal(binding.id, 'cbind_winner');
  assert.match(insertSql, /ON CONFLICT \(tenant_id, session_id, provider\) DO NOTHING/);
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
    TINODE_ROOT_API_KEY: 'tinode-root-api-key',
    TINODE_AUTH_TOKEN: 'tinode-auth-token'
  } as NodeJS.ProcessEnv);
  assert.equal(gateway.provider, 'tinode');
});

test('configured chat gateway rejects a browser key without a server root key', () => {
  assert.throws(() => configuredChatGateway({
    TINODE_WS_URL: 'ws://tinode.local/v0/channels',
    TINODE_API_KEY: 'public-browser-key',
    TINODE_AUTH_TOKEN: 'tinode-auth-token'
  } as NodeJS.ProcessEnv), /TINODE_ROOT_API_KEY is required/);
});

test('configured chat gateway rejects identical browser and root API keys', () => {
  assert.throws(() => configuredChatGateway({
    TINODE_WS_URL: 'ws://tinode.local/v0/channels',
    TINODE_API_KEY: 'shared-api-key',
    TINODE_ROOT_API_KEY: ' shared-api-key ',
    TINODE_AUTH_TOKEN: 'tinode-auth-token'
  } as NodeJS.ProcessEnv), /must be different/);
});

test('configured chat gateway uses the server root API key without reusing the browser key', async () => {
  const { url, apiKeys, close } = await startFakeTinodeServer();
  try {
    const gateway = configuredChatGateway({
      TINODE_WS_URL: url,
      TINODE_API_KEY: 'public-browser-key',
      TINODE_ROOT_API_KEY: 'tinode-api-key',
      TINODE_AUTH_TOKEN: 'tinode-auth-token'
    } as NodeJS.ProcessEnv);

    await gateway.ensureTopic({
      tenant_id: 'tenant_root_key',
      session_id: 'session_root_key',
      trusted: {
        ivekit_placement: {
          owner_node_id: 'tinode-a'
        }
      }
    });

    assert.deepEqual(apiKeys, ['tinode-api-key']);
    assert.equal(apiKeys.includes('public-browser-key'), false);
  } finally {
    await close();
  }
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
      title: 'Tinode chat',
      provider_endpoint: url.replace(/^ws:/, 'http:').replace('/v0/channels', ''),
      trusted: {
        ivekit_placement: {
          interaction_id: 'collab_tinode',
          reservation_id: 'reservation_tinode',
          owner_node_id: 'tinode-a',
          owner_epoch: '12884901889'
        }
      }
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
    assert.equal(
      packets.some((packet) =>
        packet.sub?.set?.desc?.trusted?.ivekit_placement?.reservation_id ===
          'reservation_tinode'
      ),
      true
    );
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

test('Tinode chat gateway edits a message with native replacement semantics', async () => {
  const { url, packets, close } = await startFakeTinodeServer();
  try {
    const gateway = new TinodeChatGateway({
      base_url: url,
      ws_url: url,
      api_key: 'tinode-api-key',
      auth_token: 'tinode-auth-token',
      timeout_ms: 1_000
    });
    const result = await gateway.mutateMessage({
      tenant_id: 'tenant_tinode',
      session_id: 'session_tinode',
      provider_topic_id: 'grpTinodeTopic',
      target_provider_message_id: '12',
      message_id: 'cmsg_edit_1',
      mutation_id: 'cmut_edit_1',
      action: 'edit',
      body: 'edited body'
    });

    assert.equal(result.provider_sync_status, 'published');
    assert.equal(result.provider_operation_id, '42');
    const pub = packets.find((packet) => packet.pub?.head?.replace === 'msg:12');
    assert.equal(pub?.pub.content, 'edited body');
    assert.equal(pub?.pub.noecho, false);
    assert.equal(pub?.pub.head['x-opc-mutation-id'], 'cmut_edit_1');
    assert.equal(pub?.pub.head['x-opc-message-id'], 'cmsg_edit_1');
  } finally {
    await close();
  }
});

test('Tinode chat gateway reports an unknown edit outcome when the publish acknowledgement is lost', async () => {
  const { url, close } = await startFakeTinodeServer({ dropPublishAck: true });
  try {
    const gateway = new TinodeChatGateway({
      base_url: url,
      ws_url: url,
      api_key: 'tinode-api-key',
      auth_token: 'tinode-auth-token',
      timeout_ms: 250
    });

    await assert.rejects(
      gateway.mutateMessage({
        tenant_id: 'tenant_tinode',
        session_id: 'session_tinode',
        provider_topic_id: 'grpTinodeTopic',
        target_provider_message_id: '12',
        message_id: 'cmsg_edit_unknown',
        mutation_id: 'cmut_edit_unknown',
        action: 'edit',
        body: 'edited body'
      }),
      ChatMutationOutcomeUnknownError
    );
  } finally {
    await close();
  }
});

test('Tinode chat gateway keeps a pre-publish rejection distinguishable from an unknown edit outcome', async () => {
  const { url, close } = await startFakeTinodeServer({ rejectSubscription: true });
  try {
    const gateway = new TinodeChatGateway({
      base_url: url,
      ws_url: url,
      api_key: 'tinode-api-key',
      auth_token: 'tinode-auth-token',
      timeout_ms: 1_000
    });

    await assert.rejects(
      gateway.mutateMessage({
        tenant_id: 'tenant_tinode',
        session_id: 'session_tinode',
        provider_topic_id: 'grpTinodeTopic',
        target_provider_message_id: '12',
        message_id: 'cmsg_edit_rejected',
        mutation_id: 'cmut_edit_rejected',
        action: 'edit',
        body: 'edited body'
      }),
      (error: unknown) => {
        assert.equal(error instanceof ChatMutationOutcomeUnknownError, false);
        assert.match(String(error), /403 subscription rejected/);
        return true;
      }
    );
  } finally {
    await close();
  }
});

test('Tinode chat gateway deletes exactly the target native sequence', async () => {
  const { url, packets, close } = await startFakeTinodeServer();
  try {
    const gateway = new TinodeChatGateway({
      base_url: url,
      ws_url: url,
      api_key: 'tinode-api-key',
      auth_token: 'tinode-auth-token',
      timeout_ms: 1_000
    });
    const result = await gateway.mutateMessage({
      tenant_id: 'tenant_tinode',
      session_id: 'session_tinode',
      provider_topic_id: 'grpTinodeTopic',
      target_provider_message_id: '12',
      message_id: 'cmsg_delete_1',
      mutation_id: 'cmut_delete_1',
      action: 'delete',
      body: ''
    });

    assert.equal(result.provider_sync_status, 'published');
    assert.equal(result.provider_operation_id, '77');
    const packet = packets.find((candidate) => candidate.del);
    assert.equal(packet?.del.what, 'msg');
    assert.deepEqual(packet?.del.delseq, [{ low: 12, hi: 13 }]);
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

test('Tinode chat gateway treats unchanged participant access as an idempotent success', async () => {
  const { url, close } = await startFakeTinodeServer({ accessAlreadySet: true });
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
      provider_user_id: 'usrCustomerTinode'
    });
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

test('Tinode chat gateway creates basic accounts for Converact identities', async () => {
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

test('Tinode chat gateway reuses a legacy basic account before creating a hashed username', async () => {
  const { url, packets, close } = await startFakeTinodeServer({ legacyAccountExists: true });
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
    });

    assert.equal(user.provider_user_id, 'usrLegacyCustomer');
    assert.equal(
      user.metadata.username,
      legacyTinodeBasicUsernameForIdentity('tenant_tinode', 'customer_1')
    );
    assert.equal(packets.some((packet) => packet.acc), false);
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

test('Tinode chat gateway logs in when an unchanged existing account returns 304', async () => {
  const { url, packets, close } = await startFakeTinodeServer({ accountAlreadyExists: true, accountExistingCode: 304 });
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
      identity: 'customer_1'
    });

    assert.equal(user.provider_user_id, 'usrExistingCustomer');
    assert.equal(packets.some((packet) => packet.login?.scheme === 'basic'), true);
  } finally {
    await close();
  }
});

async function startFakeTinodeServer(options: {
  accountAlreadyExists?: boolean;
  accountExistingCode?: number;
  accessAlreadySet?: boolean;
  dropPublishAck?: boolean;
  legacyAccountExists?: boolean;
  rejectSubscription?: boolean;
} = {}): Promise<{
  url: string;
  packets: Array<Record<string, any>>;
  apiKeys: string[];
  close: () => Promise<void>;
}> {
  const packets: Array<Record<string, any>> = [];
  const apiKeys: string[] = [];
  let accountAttempted = false;
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/v0/channels' });
  wss.on('connection', (ws, req) => {
    apiKeys.push(new URL(req.url || '/', 'ws://localhost').searchParams.get('apikey') || '');
    ws.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      packets.push(packet);
      if (packet.hi) {
        ws.send(JSON.stringify({ ctrl: { id: packet.hi.id, code: 200, text: 'ok', params: { ver: '0.22' } } }));
      } else if (packet.login) {
        if (packet.login.scheme === 'basic' && !accountAttempted) {
          ws.send(JSON.stringify({
            ctrl: options.legacyAccountExists
              ? { id: packet.login.id, code: 200, text: 'ok', params: { user: 'usrLegacyCustomer', token: 'token-legacy-customer' } }
              : { id: packet.login.id, code: 401, text: 'auth failed' }
          }));
          return;
        }
        const params = packet.login.scheme === 'basic'
          ? { user: 'usrExistingCustomer', token: 'token-existing-customer' }
          : { user: 'usrRoot' };
        ws.send(JSON.stringify({ ctrl: { id: packet.login.id, code: 200, text: 'ok', params } }));
      } else if (packet.acc) {
        accountAttempted = true;
        if (options.accountAlreadyExists) {
          ws.send(JSON.stringify({
            ctrl: {
              id: packet.acc.id,
              code: options.accountExistingCode || 409,
              text: options.accountExistingCode === 304 ? 'not modified' : 'account exists'
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
        ws.send(JSON.stringify({
          ctrl: {
            id: packet.sub.id,
            topic: packet.sub.topic,
            code: options.rejectSubscription ? 403 : 200,
            text: options.rejectSubscription ? 'subscription rejected' : 'ok'
          }
        }));
      } else if (packet.set) {
        ws.send(JSON.stringify({
          ctrl: {
            id: packet.set.id,
            topic: packet.set.topic,
            code: options.accessAlreadySet ? 304 : 200,
            text: options.accessAlreadySet ? 'not modified' : 'ok'
          }
        }));
      } else if (packet.pub) {
        if (options.dropPublishAck) return;
        ws.send(JSON.stringify({
          ctrl: {
            id: packet.pub.id,
            topic: packet.pub.topic,
            code: 200,
            text: 'ok',
            params: { seq: 42 }
          }
        }));
      } else if (packet.del) {
        ws.send(JSON.stringify({
          ctrl: {
            id: packet.del.id,
            topic: packet.del.topic,
            code: 200,
            text: 'ok',
            params: { del: 77 }
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
    apiKeys,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
