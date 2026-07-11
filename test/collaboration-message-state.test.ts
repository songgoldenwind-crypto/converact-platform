import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { CollaborationMessageStateStore } from '../src/agent-runtime/collaboration/message-state-store.js';
import { routeIveKitChatApi } from '../src/agent-runtime/ivekit/chat-http.js';
import { PolicyFindingStore } from '../src/agent-runtime/collaboration/policy-finding-store.js';
import type { QualityReviewProvider } from '../src/agent-runtime/collaboration/quality-review.js';

const API_KEY = 'message-state-api-key';

test('read-through receipts advance monotonically and drive participant unread count', async () => {
  const fixture = await messageFixture();
  const states = new CollaborationMessageStateStore(fixture.pg);

  assert.equal(await states.unreadCount({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    identity: 'agent-state'
  }), 3);

  const first = await states.markReceiptThrough({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    message_id: fixture.messages[1]!.id,
    identity: 'agent-state',
    status: 'read',
    source: 'ivekit'
  });
  assert.equal(first.length, 2);
  assert.equal(first.every((receipt) => receipt.delivered_at && receipt.read_at), true);
  assert.equal(await states.unreadCount({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    identity: 'agent-state'
  }), 1);

  await states.markReceiptThrough({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    message_id: fixture.messages[2]!.id,
    identity: 'agent-state',
    status: 'delivered',
    source: 'tinode',
    provider_sequence: 30
  });
  assert.equal(await states.unreadCount({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    identity: 'agent-state'
  }), 1);

  await states.markReceiptThrough({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    message_id: fixture.messages[2]!.id,
    identity: 'agent-state',
    status: 'read',
    source: 'tinode',
    provider_sequence: 31
  });
  const repeated = await states.markReceiptThrough({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    message_id: fixture.messages[2]!.id,
    identity: 'agent-state',
    status: 'delivered',
    source: 'ivekit'
  });
  assert.equal(repeated.at(-1)?.read_at != null, true);
  assert.equal(repeated.at(-1)?.provider_sequence, 31);
  assert.equal(await states.unreadCount({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    identity: 'agent-state'
  }), 0);
});

test('receipt updates require an active tenant-scoped participant and target message', async () => {
  const fixture = await messageFixture();
  const states = new CollaborationMessageStateStore(fixture.pg);
  await assert.rejects(
    states.markReceiptThrough({
      tenant_id: fixture.tenantId,
      session_id: fixture.sessionId,
      message_id: fixture.messages[0]!.id,
      identity: 'not-a-participant',
      status: 'read'
    }),
    /active collaboration participant not found/
  );
  await assert.rejects(
    states.markReceiptThrough({
      tenant_id: 'tenant-other',
      session_id: fixture.sessionId,
      message_id: fixture.messages[0]!.id,
      identity: 'agent-state',
      status: 'read'
    }),
    /collaboration session not found/
  );
});

test('receipt metadata is recursively redacted before audit persistence', async () => {
  const fixture = await messageFixture();
  const states = new CollaborationMessageStateStore(fixture.pg);
  await states.markReceiptThrough({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    message_id: fixture.messages[0]!.id,
    identity: 'agent-state',
    status: 'read',
    metadata: {
      contact: 'call 13800138000',
      nested: { email: 'private@example.com' }
    }
  });

  const receipts = await states.listReceipts({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    identity: 'agent-state'
  });
  const serialized = JSON.stringify(receipts[0]?.metadata || {});
  assert.equal(serialized.includes('13800138000'), false);
  assert.equal(serialized.includes('private@example.com'), false);
  assert.match(serialized, /\[phone\]/);
  assert.match(serialized, /\[email\]/);
});

test('soft-deleted messages do not contribute to unread count', async () => {
  const fixture = await messageFixture();
  const states = new CollaborationMessageStateStore(fixture.pg);
  await states.deleteMessage({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    message_id: fixture.messages[0]!.id,
    actor_identity: 'customer-state'
  });

  assert.equal(await states.unreadCount({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    identity: 'agent-state'
  }), 2);
});

test('typing and presence states expire deterministically without a cleanup worker', async () => {
  const fixture = await messageFixture();
  let now = new Date('2026-07-10T14:00:00.000Z');
  const states = new CollaborationMessageStateStore(fixture.pg, () => now);
  await states.updatePresence({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    identity: 'agent-state',
    status: 'online',
    ttl_ms: 60_000
  });
  await states.updateTyping({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    identity: 'agent-state',
    typing: true,
    ttl_ms: 8_000
  });

  let state = (await states.listRealtimeStates({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId
  })).find((item) => item.identity === 'agent-state');
  assert.equal(state?.presence_status, 'online');
  assert.equal(state?.typing, true);

  now = new Date('2026-07-10T14:00:09.000Z');
  state = (await states.listRealtimeStates({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId
  })).find((item) => item.identity === 'agent-state');
  assert.equal(state?.presence_status, 'online');
  assert.equal(state?.typing, false);

  now = new Date('2026-07-10T14:01:01.000Z');
  state = (await states.listRealtimeStates({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId
  })).find((item) => item.identity === 'agent-state');
  assert.equal(state?.presence_status, 'offline');
  assert.equal(state?.typing, false);
  assert.equal(state?.last_seen_at, '2026-07-10T14:00:00.000Z');
});

test('sender edits rescan policy and soft deletes preserve original body with mutation audit', async () => {
  const fixture = await messageFixture();
  const states = new CollaborationMessageStateStore(fixture.pg);
  const target = fixture.messages[0]!;

  const edited = await states.editMessage({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    message_id: target.id,
    actor_identity: 'customer-state',
    body: '后来改成联系电话 13800138000',
    reason: 'customer correction'
  });
  assert.equal(edited.body, '后来改成联系电话 13800138000');
  assert.equal(edited.edit_version, 1);
  assert.ok(edited.edited_at);
  const findings = await new PolicyFindingStore(fixture.pg).listFindings({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    message_id: target.id
  });
  assert.equal(findings.some((finding) => finding.policy_type === 'phone_number'), true);

  await assert.rejects(
    states.editMessage({
      tenant_id: fixture.tenantId,
      session_id: fixture.sessionId,
      message_id: target.id,
      actor_identity: 'agent-state',
      body: 'unauthorized edit'
    }),
    /only the message sender can mutate a message/
  );

  const deleted = await states.deleteMessage({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    message_id: target.id,
    actor_identity: 'customer-state',
    reason: 'sent by mistake'
  });
  assert.equal(deleted.body, '');
  assert.equal(deleted.deleted_by, 'customer-state');
  assert.ok(deleted.deleted_at);

  const raw = await fixture.pg.query(
    'SELECT * FROM collaboration_messages WHERE id = $1 AND tenant_id = $2',
    [target.id, fixture.tenantId]
  );
  assert.equal(raw.rows[0]?.body, 'one');
  assert.equal(raw.rows[0]?.current_body, '后来改成联系电话 13800138000');
  const mutations = await states.listMutations({
    tenant_id: fixture.tenantId,
    session_id: fixture.sessionId,
    message_id: target.id
  });
  assert.deepEqual(mutations.map((mutation) => mutation.action), ['edit', 'delete']);
  assert.equal(mutations.every((mutation) => mutation.before_body_hash.length === 64), true);
  assert.equal(JSON.stringify(mutations).includes('13800138000'), false);
});

test('message mutation window is enforced from the original creation time', async () => {
  const fixture = await messageFixture();
  const createdAt = new Date(fixture.messages[0]!.created_at).getTime();
  const states = new CollaborationMessageStateStore(
    fixture.pg,
    () => new Date(createdAt + 15 * 60_000 + 1)
  );
  await assert.rejects(
    states.editMessage({
      tenant_id: fixture.tenantId,
      session_id: fixture.sessionId,
      message_id: fixture.messages[0]!.id,
      actor_identity: 'customer-state',
      body: 'too late'
    }),
    /message mutation window expired/
  );
});

test('mutation history rejects a message outside the requested session', async () => {
  const fixture = await messageFixture();
  const states = new CollaborationMessageStateStore(fixture.pg);
  await assert.rejects(
    states.listMutations({
      tenant_id: fixture.tenantId,
      session_id: fixture.sessionId,
      message_id: 'cmsg_missing'
    }),
    /collaboration message not found/
  );
});

test('message state avoids capped chat snapshots and uses stable message ordering', () => {
  const stateSource = readFileSync('src/agent-runtime/collaboration/message-state-store.ts', 'utf8');
  const collaborationSource = readFileSync('src/agent-runtime/collaboration/collaboration-store.ts', 'utf8');
  assert.doesNotMatch(stateSource, /limit:\s*10_000/);
  assert.match(stateSource, /SELECT id, sender_identity, deleted_at FROM collaboration_messages/);
  assert.match(collaborationSource, /ORDER BY created_at ASC, id ASC/);
  assert.match(collaborationSource, /provider_delivery_status, current_body,/);
  assert.match(collaborationSource, /\$13, \$14, \$15, \$6, \$16, \$17, \$18\)/);
});

test('message state migration defines receipt uniqueness and forced tenant RLS', () => {
  const migration = readFileSync('src/migrations/030_collaboration_message_state.sql', 'utf8');
  assert.match(migration, /collaboration_message_receipts/);
  assert.match(migration, /UNIQUE \(tenant_id, message_id, identity\)/);
  assert.match(migration, /delivered_at/);
  assert.match(migration, /read_at/);
  assert.match(migration, /collaboration_participant_realtime_state/);
  assert.match(migration, /presence_expires_at/);
  assert.match(migration, /typing_expires_at/);
  assert.match(migration, /current_body/);
  assert.match(migration, /collaboration_message_mutations/);
  assert.match(migration, /before_body_hash/);
  assert.match(migration, /tenant_id, session_id, created_at, id/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
});

test('message mutation window is exposed across deployment surfaces', () => {
  const sources = [
    readFileSync('.env.example', 'utf8'),
    readFileSync('infra/env.example', 'utf8'),
    readFileSync('docker-compose.callcenter.yml', 'utf8'),
    readFileSync('infra/docker-compose.production.yml', 'utf8'),
    readFileSync('infra/k8s/values.yaml', 'utf8'),
    readFileSync('infra/k8s/templates/opc-deployment.yaml', 'utf8')
  ];
  for (const source of sources) {
    assert.match(source, /OPC_CHAT_MESSAGE_MUTATION_WINDOW_MS|messageMutationWindowMs/);
  }
});

test('iveKit receipt API marks the authenticated participant read and returns unread state', async () => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantId = 'tenant_message_state_http';
  const customerHeaders = authHeaders(tenantId, 'customer-http');
  const agentHeaders = authHeaders(tenantId, 'agent-http');
  const qualityProvider: QualityReviewProvider = {
    name: 'message-state-quality',
    mode: 'self_hosted',
    review: async () => ({ findings: [] })
  };
  const route = (
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>
  ) => routeIveKitChatApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers,
    { qualityReview: { provider: qualityProvider } }
  );
  try {
    const opened = await route('POST', '/api/ivekit/chat/sessions', {
      business_ref: { type: 'service_order', id: 'order-message-state-http' }
    }, agentHeaders) as { data: { id: string } };
    for (const [identity, role] of [['agent-http', 'agent'], ['customer-http', 'customer']]) {
      await route('POST', `/api/ivekit/chat/sessions/${opened.data.id}/participants`, {
        identity,
        role
      }, agentHeaders);
    }
    const first = await route('POST', `/api/ivekit/chat/sessions/${opened.data.id}/messages`, {
      sender_identity: 'customer-http',
      body: 'first unread'
    }, customerHeaders) as { data: { message: { id: string } } };
    const second = await route('POST', `/api/ivekit/chat/sessions/${opened.data.id}/messages`, {
      sender_identity: 'customer-http',
      body: 'second unread'
    }, customerHeaders) as { data: { message: { id: string } } };

    const before = await route(
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/message-state`,
      null,
      agentHeaders
    ) as { data: { identity: string; unread_count: number } };
    assert.equal(before.data.identity, 'agent-http');
    assert.equal(before.data.unread_count, 2);

    const marked = await route(
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages/${second.data.message.id}/receipts`,
      { status: 'read', identity: 'agent-http' },
      agentHeaders
    ) as { status: number; data: { receipts: Array<{ message_id: string; read_at: string | null }> } };
    assert.equal(marked.status, 201);
    assert.equal(marked.data.receipts.length, 2);
    assert.equal(marked.data.receipts.every((receipt) => receipt.read_at), true);

    const receipts = await route(
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages/${first.data.message.id}/receipts`,
      null,
      customerHeaders
    ) as { data: { receipts: Array<{ identity: string }> } };
    assert.equal(receipts.data.receipts[0]?.identity, 'agent-http');

    const after = await route(
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/message-state`,
      null,
      agentHeaders
    ) as { data: { unread_count: number } };
    assert.equal(after.data.unread_count, 0);

    const presence = await route(
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/presence`,
      { identity: 'agent-http', status: 'online', ttl_ms: 60_000 },
      agentHeaders
    ) as { status: number; data: { state: { presence_status: string } } };
    assert.equal(presence.status, 201);
    assert.equal(presence.data.state.presence_status, 'online');

    const typing = await route(
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/typing`,
      { identity: 'agent-http', typing: true },
      agentHeaders
    ) as { status: number; data: { state: { typing: boolean } } };
    assert.equal(typing.status, 201);
    assert.equal(typing.data.state.typing, true);

    const realtime = await route(
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/realtime-state`,
      null,
      customerHeaders
    ) as { data: { states: Array<{ identity: string; presence_status: string; typing: boolean }> } };
    const agentState = realtime.data.states.find((state) => state.identity === 'agent-http');
    assert.equal(agentState?.presence_status, 'online');
    assert.equal(agentState?.typing, true);

    const impersonation = await route(
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages/${second.data.message.id}/receipts`,
      { status: 'read', identity: 'customer-http' },
      agentHeaders
    );
    assert.deepEqual(impersonation, { status: 403, data: { error: 'receipt identity must match authenticated user' } });

    const presenceImpersonation = await route(
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/presence`,
      { identity: 'customer-http', status: 'online' },
      agentHeaders
    );
    assert.deepEqual(presenceImpersonation, {
      status: 403,
      data: { error: 'realtime identity must match authenticated user' }
    });

    const edited = await route(
      'PATCH',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages/${first.data.message.id}`,
      { body: 'edited contact 13900139000', reason: 'correction' },
      customerHeaders
    ) as {
      status: number;
      data: { message: { body: string; edit_version: number }; quality_review_job: { status: string } };
    };
    assert.equal(edited.status, 200);
    assert.equal(edited.data.message.body, 'edited contact 13900139000');
    assert.equal(edited.data.message.edit_version, 1);
    assert.equal(edited.data.quality_review_job.status, 'pending');

    const deleted = await route(
      'DELETE',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages/${first.data.message.id}`,
      { reason: 'sent by mistake' },
      customerHeaders
    ) as { status: number; data: { message: { body: string; deleted_at: string } } };
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.message.body, '');
    assert.ok(deleted.data.message.deleted_at);

    const mutations = await route(
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages/${first.data.message.id}/mutations`,
      null,
      customerHeaders
    ) as { data: { mutations: Array<{ action: string }> } };
    assert.deepEqual(mutations.data.mutations.map((mutation) => mutation.action), ['edit', 'delete']);

    const qualityStatus = await route(
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages/${first.data.message.id}/quality-review`,
      null,
      customerHeaders
    ) as { data: { job: { status: string } } };
    assert.equal(qualityStatus.data.job.status, 'cancelled');
  } finally {
    if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousApiKey;
  }
});

test('JWT chat users cannot request credentials or post messages as another identity', async () => {
  const previous = {
    apiKey: process.env.OPC_API_KEY,
    jwtSecret: process.env.OPC_JWT_SECRET
  };
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_JWT_SECRET = 'message-state-jwt-secret';
  const pg = new MemoryPg();
  const tenantId = 'tenant_message_identity';
  const token = signAccessToken({ sub: 'agent-jwt', tid: tenantId, role: 'operator' });
  const jwtHeaders = { authorization: `Bearer ${token}` };
  const route = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    routeIveKitChatApi(
      pg,
      method,
      path,
      new URL(`http://localhost${path}`),
      body,
      '',
      headers
    );
  try {
    const opened = await route('POST', '/api/ivekit/chat/sessions', {
      business_ref: { type: 'service_order', id: 'identity-boundary' }
    }, authHeaders(tenantId, 'system-setup')) as { data: { id: string } };
    await new CollaborationStore(pg).addParticipant({
      tenant_id: tenantId,
      session_id: opened.data.id,
      identity: 'agent-jwt',
      role: 'agent'
    });

    const plan = await route(
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/client-plan`,
      { identity: 'victim-user' },
      jwtHeaders
    );
    assert.deepEqual(plan, {
      status: 403,
      data: { error: 'chat identity must match authenticated user' }
    });

    const message = await route(
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages`,
      { sender_identity: 'victim-user', body: 'spoofed message' },
      jwtHeaders
    );
    assert.deepEqual(message, {
      status: 403,
      data: { error: 'chat identity must match authenticated user' }
    });
  } finally {
    restoreEnvValue('OPC_API_KEY', previous.apiKey);
    restoreEnvValue('OPC_JWT_SECRET', previous.jwtSecret);
  }
});

async function messageFixture() {
  const pg = new MemoryPg();
  const tenantId = 'tenant_message_state';
  const store = new CollaborationStore(pg);
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-message-state' }
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'agent-state',
    role: 'agent'
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'customer-state',
    role: 'customer'
  });
  const messages = [];
  for (const body of ['one', 'two', 'three']) {
    messages.push(await store.postMessage({
      tenant_id: tenantId,
      session_id: session.id,
      sender_identity: 'customer-state',
      message_type: 'text',
      body
    }));
  }
  return { pg, tenantId, sessionId: session.id, messages };
}

function authHeaders(tenantId: string, userId: string): Record<string, string> {
  return {
    'x-api-key': API_KEY,
    'x-tenant-id': tenantId,
    'x-user-id': userId
  };
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
