import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { CollaborationMessageStateStore } from '../src/agent-runtime/collaboration/message-state-store.js';
import {
  LocalChatGateway,
  TinodeChatGateway,
  type ChatParticipantInput
} from '../src/agent-runtime/collaboration/chat-gateway.js';
import { TinodeProviderUserStore } from '../src/agent-runtime/collaboration/tinode-provider-user-store.js';
import { withCollaborationSessionLock } from '../src/agent-runtime/collaboration/collaboration-lock.js';
import { routeIveKitChatApi } from '../src/agent-runtime/converact/chat-http.js';
import { MemoryPg } from '../src/db-pg.js';

const API_KEY = 'test-chat-pagination-key';

class RecordingMemoryPg extends MemoryPg {
  readonly statements: string[] = [];

  override async query<R extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<import('pg').QueryResult<R>> {
    this.statements.push(text.replace(/\s+/g, ' ').trim());
    return super.query<R>(text, params);
  }
}

function headers(tenantId: string, userId = 'agent-page'): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

async function route(pg: MemoryPg, method: string, path: string, tenantId: string, userId = 'agent-page') {
  return routeIveKitChatApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    null,
    '',
    headers(tenantId, userId)
  );
}

test('iveKit chat lists tenant sessions with filters and opaque stable cursors', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_session_page';

  const opened = [];
  for (const [index, title] of ['LED Alpha one', 'LED Alpha two', 'LED Alpha three'].entries()) {
    opened.push(await store.openSession({
      tenant_id: tenantId,
      business_ref: { tenant_id: tenantId, type: 'service_order', id: `LED-${index + 1}` },
      title
    }));
  }
  const closed = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'support_ticket', id: 'CLOSED-1' },
    title: 'Closed Alpha'
  });
  await store.closeSession(closed.id);
  await store.openSession({
    tenant_id: 'tenant_session_other',
    business_ref: { tenant_id: 'tenant_session_other', type: 'service_order', id: 'LED-OTHER' },
    title: 'LED Alpha foreign tenant'
  });

  const first = await route(
    pg,
    'GET',
    '/api/ivekit/chat/sessions?status=open&query=alpha&business_ref_type=service_order&limit=2',
    tenantId
  ) as { data: { items: Array<{ id: string }>; next_cursor: string | null; has_more: boolean } };
  assert.deepEqual(first.data.items.map((item) => item.id), [opened[2].id, opened[1].id]);
  assert.equal(first.data.has_more, true);
  assert.ok(first.data.next_cursor);
  assert.doesNotMatch(first.data.next_cursor, /collab|LED|Alpha/);

  const second = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions?status=open&query=alpha&business_ref_type=service_order&limit=2&cursor=${encodeURIComponent(first.data.next_cursor!)}`,
    tenantId
  ) as { data: { items: Array<{ id: string }>; next_cursor: string | null; has_more: boolean } };
  assert.deepEqual(second.data.items.map((item) => item.id), [opened[0].id]);
  assert.equal(second.data.has_more, false);
  assert.equal(new Set([...first.data.items, ...second.data.items].map((item) => item.id)).size, 3);

  const closedPage = await route(
    pg,
    'GET',
    '/api/ivekit/chat/sessions?status=closed&business_ref_type=support_ticket&business_ref_id=CLOSED-1&limit=10',
    tenantId
  ) as { data: { items: Array<{ id: string }> } };
  assert.deepEqual(closedPage.data.items.map((item) => item.id), [closed.id]);
});

test('iveKit session list includes viewer unread, latest message, and online participant summary', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_session_summary';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'SUMMARY-1' },
    title: 'Summary session'
  });
  for (const [identity, role] of [['agent-page', 'agent'], ['customer-1', 'customer']] as const) {
    await store.addParticipant({ tenant_id: tenantId, session_id: session.id, identity, role });
  }
  await store.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'customer-1', message_type: 'text', body: 'first unread'
  });
  await store.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'customer-1', message_type: 'text', body: 'second unread'
  });
  const latest = await store.postMessage({
    tenant_id: tenantId, session_id: session.id, sender_identity: 'agent-page', message_type: 'text', body: 'latest reply'
  });
  await new CollaborationMessageStateStore(pg).updatePresence({
    tenant_id: tenantId, session_id: session.id, identity: 'customer-1', status: 'online', ttl_ms: 90_000
  });

  const response = await route(pg, 'GET', '/api/ivekit/chat/sessions?limit=10', tenantId) as {
    data: { items: Array<{ summary: {
      unread_count: number;
      online_participant_count: number;
      last_message: { id: string; body: string; sender_identity: string } | null;
    } }> };
  };
  const summary = response.data.items[0].summary;
  assert.equal(summary.unread_count, 2);
  assert.equal(summary.online_participant_count, 1);
  assert.deepEqual(summary.last_message, {
    id: latest.id,
    body: 'latest reply',
    sender_identity: 'agent-page',
    message_type: 'text',
    created_at: latest.created_at,
    deleted: false
  });

  const outsiderResponse = await route(
    pg,
    'GET',
    '/api/ivekit/chat/sessions?limit=10',
    tenantId,
    'tenant-outsider'
  ) as { data: { items: Array<{ summary: {
    unread_count: number;
    online_participant_count: number;
    last_message: unknown;
  } }> } };
  assert.deepEqual(outsiderResponse.data.items[0].summary, {
    unread_count: 0,
    online_participant_count: 0,
    last_message: null
  });
});

test('iveKit closes a session only after revoking every active provider participant', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_session_close';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'CLOSE-1' }
  });
  for (const [identity, role] of [['agent-page', 'agent'], ['customer-1', 'customer']] as const) {
    await store.addParticipant({ tenant_id: tenantId, session_id: session.id, identity, role });
  }
  await store.ensureChatBinding({
    tenant_id: tenantId,
    session_id: session.id,
    provider: 'local',
    provider_topic_id: 'local-topic'
  });
  const gateway = new TrackingLocalGateway();
  const response = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/close`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/close`),
    {},
    '',
    headers(tenantId),
    { chatGateway: gateway }
  ) as { status: number; data: { status: string } };

  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'closed');
  assert.deepEqual(gateway.removed.sort(), ['agent-page', 'customer-1']);
  assert.equal((await store.getSession(session.id))?.status, 'closed');
});

test('iveKit close fails fast while a shared session operation is in flight', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_session_close_lock';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'CLOSE-LOCK-1' }
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'agent-page',
    role: 'agent'
  });
  await store.ensureChatBinding({
    tenant_id: tenantId,
    session_id: session.id,
    provider: 'local',
    provider_topic_id: 'local-lock-topic'
  });

  let releaseShared!: () => void;
  let sharedEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    sharedEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseShared = resolve;
  });
  const holder = withCollaborationSessionLock(pg, {
    tenantId,
    sessionId: session.id,
    mode: 'shared'
  }, async () => {
    sharedEntered();
    await gate;
  });
  await entered;

  await assert.rejects(
    () => routeIveKitChatApi(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${session.id}/close`,
      new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/close`),
      {},
      '',
      headers(tenantId),
      { chatGateway: new TrackingLocalGateway() }
    ),
    (error: unknown) =>
      (error as { status?: number }).status === 409 &&
      (error as { code?: string }).code === 'collaboration_session_busy'
  );

  releaseShared();
  await holder;
  const response = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/close`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/close`),
    {},
    '',
    headers(tenantId),
    { chatGateway: new TrackingLocalGateway() }
  ) as { status: number; data: { status: string } };
  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'closed');
});

test('direct CollaborationStore message writes cannot bypass an exclusive session close lock', async () => {
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_direct_message_lock';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'DIRECT-LOCK-1' }
  });
  let releaseExclusive!: () => void;
  let exclusiveEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    exclusiveEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseExclusive = resolve;
  });
  const holder = withCollaborationSessionLock(pg, {
    tenantId,
    sessionId: session.id,
    mode: 'exclusive'
  }, async () => {
    exclusiveEntered();
    await gate;
  });
  await entered;

  await assert.rejects(
    () => store.postMessage({
      tenant_id: tenantId,
      session_id: session.id,
      sender_identity: 'agent-direct',
      message_type: 'text',
      body: 'must wait for close'
    }),
    (error: unknown) =>
      (error as { code?: string }).code === 'collaboration_session_busy'
  );

  releaseExclusive();
  await holder;
  assert.deepEqual(await store.listMessages({
    tenant_id: tenantId,
    session_id: session.id
  }), []);
});

test('iveKit closes a Tinode session with mapped provider user ids and revokes the mappings', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_tinode_session_close';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'TINODE-CLOSE-1' }
  });
  for (const [identity, role] of [['agent-page', 'agent'], ['customer-1', 'customer']] as const) {
    await store.addParticipant({ tenant_id: tenantId, session_id: session.id, identity, role });
  }
  const binding = await store.ensureChatBinding({
    tenant_id: tenantId,
    session_id: session.id,
    provider: 'tinode',
    provider_topic_id: 'grp-tinode-close'
  });
  const providerUsers = new TinodeProviderUserStore(pg);
  await providerUsers.upsert({
    tenant_id: tenantId,
    session_id: session.id,
    binding_id: binding.id,
    provider_user_id: 'usr-agent-provider',
    identity: 'agent-page'
  });
  await providerUsers.upsert({
    tenant_id: tenantId,
    session_id: session.id,
    binding_id: binding.id,
    provider_user_id: 'usr-customer-provider',
    identity: 'customer-1'
  });

  const gateway = new TrackingTinodeGateway();
  const response = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/close`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/close`),
    {},
    '',
    headers(tenantId),
    { chatGateway: gateway }
  ) as { status: number; data: { status: string } };

  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'closed');
  assert.deepEqual(gateway.removed.sort(), [
    'agent-page:usr-agent-provider',
    'customer-1:usr-customer-provider'
  ]);
  assert.equal((await providerUsers.getByIdentity({
    tenant_id: tenantId,
    session_id: session.id,
    provider: 'tinode',
    identity: 'agent-page'
  }))?.status, 'revoked');
  assert.equal((await providerUsers.getByIdentity({
    tenant_id: tenantId,
    session_id: session.id,
    provider: 'tinode',
    identity: 'customer-1'
  }))?.status, 'revoked');
});

test('iveKit reconciles active Tinode mappings left by a legacy closed session', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_legacy_tinode_close';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'LEGACY-CLOSE-1' }
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'agent-page',
    role: 'agent'
  });
  const binding = await store.ensureChatBinding({
    tenant_id: tenantId,
    session_id: session.id,
    provider: 'tinode',
    provider_topic_id: 'grp-legacy-tinode-close'
  });
  const providerUsers = new TinodeProviderUserStore(pg);
  await providerUsers.upsert({
    tenant_id: tenantId,
    session_id: session.id,
    binding_id: binding.id,
    provider_user_id: 'usr-legacy-agent',
    identity: 'agent-page'
  });
  await store.closeSession(session.id);

  const gateway = new TrackingTinodeGateway();
  const response = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/close`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/close`),
    {},
    '',
    headers(tenantId),
    { chatGateway: gateway }
  ) as { status: number; data: { status: string } };

  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'closed');
  assert.deepEqual(gateway.removed, ['agent-page:usr-legacy-agent']);
  assert.equal((await providerUsers.getByIdentity({
    tenant_id: tenantId,
    session_id: session.id,
    provider: 'tinode',
    identity: 'agent-page'
  }))?.status, 'revoked');
});

test('iveKit rejects adding a participant after the session is closed', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_closed_participant_add';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'CLOSED-ADD-1' }
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'agent-page',
    role: 'agent'
  });
  await store.closeSession(session.id);

  const response = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/participants`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/participants`),
    { identity: 'customer-late', role: 'customer' },
    '',
    headers(tenantId),
    { chatGateway: new TrackingTinodeGateway() }
  ) as { status: number; data: { error?: string } };

  assert.equal(response.status, 409);
  assert.match(String(response.data.error), /session is closed/);
  assert.equal((await store.listParticipants({
    tenant_id: tenantId,
    session_id: session.id
  })).some((participant) => participant.identity === 'customer-late'), false);
});

test('iveKit rejects binding Tinode after the session is closed', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_closed_chat_bind';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'CLOSED-BIND-1' }
  });
  await store.closeSession(session.id);

  const gateway = new TrackingTinodeGateway();
  const response = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/bind`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/bind`),
    {},
    '',
    headers(tenantId),
    { chatGateway: gateway }
  ) as { status: number; data: { error?: string } };

  assert.equal(response.status, 409);
  assert.match(String(response.data.error), /session is closed/);
  assert.equal(await store.getChatBinding({
    tenant_id: tenantId,
    session_id: session.id
  }), null);
});

test('iveKit rejects creating a message after the session is closed', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_closed_message_create';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'CLOSED-MESSAGE-1' }
  });
  await store.closeSession(session.id);

  const response = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/messages`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/messages`),
    { sender_identity: 'agent-page', body: 'too late' },
    '',
    headers(tenantId),
    { chatGateway: new TrackingLocalGateway() }
  ) as { status: number; data: { error?: string } };

  assert.equal(response.status, 409);
  assert.match(String(response.data.error), /session is closed/);
  assert.deepEqual(await store.listMessages({
    tenant_id: tenantId,
    session_id: session.id
  }), []);
});

test('iveKit closes an unbound session even when Tinode is the configured provider', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_unbound_tinode_close';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'UNBOUND-CLOSE-1' }
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'agent-page',
    role: 'agent'
  });

  const response = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/close`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/close`),
    {},
    '',
    headers(tenantId),
    { chatGateway: new TrackingTinodeGateway() }
  ) as { status: number; data: { status?: string; error?: string } };

  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'closed');
  assert.equal((await store.getSession(session.id))?.status, 'closed');
});

test('iveKit leaves inbound active when Tinode close is missing a provider user mapping', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new RecordingMemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_tinode_close_missing_mapping';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'MISSING-MAPPING-1' }
  });
  for (const [identity, role] of [['agent-page', 'agent'], ['customer-1', 'customer']] as const) {
    await store.addParticipant({ tenant_id: tenantId, session_id: session.id, identity, role });
  }
  const binding = await store.ensureChatBinding({
    tenant_id: tenantId,
    session_id: session.id,
    provider: 'tinode',
    provider_topic_id: 'grp-tinode-missing-mapping'
  });
  await new TinodeProviderUserStore(pg).upsert({
    tenant_id: tenantId,
    session_id: session.id,
    binding_id: binding.id,
    provider_user_id: 'usr-agent-provider',
    identity: 'agent-page'
  });
  pg.statements.length = 0;

  const response = await routeIveKitChatApi(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/close`,
    new URL(`http://localhost/api/ivekit/chat/sessions/${session.id}/close`),
    {},
    '',
    headers(tenantId),
    { chatGateway: new TrackingTinodeGateway() }
  ) as { status: number; data: { error?: string } };

  assert.equal(response.status, 409);
  assert.match(String(response.data.error), /missing its provider user mapping/);
  assert.equal(
    pg.statements.some((statement) => statement.startsWith('INSERT INTO tinode_inbound_cursors')),
    false
  );
  assert.equal((await store.getSession(session.id))?.status, 'open');
});

test('iveKit chat pages message history in both directions and searches before limiting', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_message_page';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'LED-MESSAGES' },
    title: 'Message history'
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'agent-page',
    role: 'agent'
  });

  const messages = [];
  for (const body of ['first ordinary', 'needle older', 'third ordinary', 'needle newer', 'fifth ordinary']) {
    messages.push(await store.postMessage({
      tenant_id: tenantId,
      session_id: session.id,
      sender_identity: 'agent-page',
      message_type: 'text',
      body
    }));
  }

  const latest = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions/${session.id}/messages?direction=before&limit=2`,
    tenantId
  ) as { data: { items: Array<{ id: string }>; next_cursor: string | null; has_more: boolean } };
  assert.deepEqual(latest.data.items.map((item) => item.id), [messages[3].id, messages[4].id]);
  assert.equal(latest.data.has_more, true);

  const older = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions/${session.id}/messages?direction=before&limit=2&cursor=${encodeURIComponent(latest.data.next_cursor!)}`,
    tenantId
  ) as { data: { items: Array<{ id: string }>; next_cursor: string | null; has_more: boolean } };
  assert.deepEqual(older.data.items.map((item) => item.id), [messages[1].id, messages[2].id]);
  assert.equal(new Set([...latest.data.items, ...older.data.items].map((item) => item.id)).size, 4);

  const afterFirst = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions/${session.id}/messages?direction=after&limit=2`,
    tenantId
  ) as { data: { items: Array<{ id: string }>; next_cursor: string } };
  assert.deepEqual(afterFirst.data.items.map((item) => item.id), [messages[0].id, messages[1].id]);
  const afterNext = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions/${session.id}/messages?direction=after&cursor=${encodeURIComponent(afterFirst.data.next_cursor)}&limit=2`,
    tenantId
  ) as { data: { items: Array<{ id: string }>; next_cursor: string | null; has_more: boolean } };
  assert.deepEqual(afterNext.data.items.map((item) => item.id), [messages[2].id, messages[3].id]);
  assert.equal(afterNext.data.has_more, true);
  assert.ok(afterNext.data.next_cursor);

  const search = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions/${session.id}/messages?direction=before&query=needle&limit=1`,
    tenantId
  ) as { data: { items: Array<{ id: string }>; has_more: boolean } };
  assert.deepEqual(search.data.items.map((item) => item.id), [messages[3].id]);
  assert.equal(search.data.has_more, true);

  await new CollaborationMessageStateStore(pg).deleteMessage({
    tenant_id: tenantId,
    session_id: session.id,
    message_id: messages[3].id,
    actor_identity: 'agent-page'
  });
  const afterDelete = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions/${session.id}/messages?direction=before&query=needle&limit=10`,
    tenantId
  ) as { data: { items: Array<{ id: string }> } };
  assert.deepEqual(afterDelete.data.items.map((item) => item.id), [messages[1].id]);
});

test('pagination uses nullable PostgreSQL cursor parameters', () => {
  const source = readFileSync('src/agent-runtime/collaboration/collaboration-store.ts', 'utf8');
  assert.match(source, /\$7::timestamptz IS NULL/);
  assert.match(source, /\$4::timestamptz IS NULL/);
  assert.doesNotMatch(source, /\$[47] = '' OR \(created_at, id\)/);
  assert.match(source, /ORDER BY created_at DESC, id DESC/);
  assert.match(source, /ORDER BY created_at \$\{order\}, id \$\{order\}/);
});

class TrackingLocalGateway extends LocalChatGateway {
  readonly removed: string[] = [];

  override async removeParticipant(input: ChatParticipantInput): Promise<void> {
    this.removed.push(input.identity);
  }
}

class TrackingTinodeGateway extends TinodeChatGateway {
  readonly removed: string[] = [];

  constructor() {
    super({ base_url: 'http://tinode:6060' });
  }

  override async removeParticipant(input: ChatParticipantInput): Promise<void> {
    this.removed.push(`${input.identity}:${input.provider_user_id || ''}`);
  }
}

test('iveKit chat rejects malformed, wrong-direction, and cross-tenant pagination', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_cursor_guard';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'CURSOR-GUARD' }
  });
  await store.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'agent-page',
    message_type: 'text',
    body: 'guarded'
  });
  await store.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'agent-page',
    message_type: 'text',
    body: 'guarded again'
  });

  await assert.rejects(
    () => route(pg, 'GET', `/api/ivekit/chat/sessions/${session.id}/messages?direction=before&cursor=not-a-cursor`, tenantId),
    (error: unknown) => (error as { status?: number }).status === 400
  );

  const page = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions/${session.id}/messages?direction=before&limit=1`,
    tenantId
  ) as { data: { next_cursor: string } };
  await assert.rejects(
    () => route(
      pg,
      'GET',
      `/api/ivekit/chat/sessions/${session.id}/messages?direction=after&cursor=${encodeURIComponent(page.data.next_cursor)}`,
      tenantId
    ),
    (error: unknown) => (error as { status?: number }).status === 400
  );

  const crossTenant = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions/${session.id}/messages?direction=before&limit=10`,
    'tenant_cursor_foreign'
  ) as { status: number };
  assert.equal(crossTenant.status, 404);
});
