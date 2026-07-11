import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { CollaborationMessageStateStore } from '../src/agent-runtime/collaboration/message-state-store.js';
import { routeIveKitChatApi } from '../src/agent-runtime/ivekit/chat-http.js';
import { MemoryPg } from '../src/db-pg.js';

const API_KEY = 'test-chat-pagination-key';

function headers(tenantId: string, userId = 'agent-page'): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

async function route(pg: MemoryPg, method: string, path: string, tenantId: string) {
  return routeIveKitChatApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    null,
    '',
    headers(tenantId)
  );
}

test('iveKit chat lists tenant sessions with filters and opaque stable cursors', async () => {
  process.env.OPC_API_KEY = API_KEY;
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

test('iveKit chat pages message history in both directions and searches before limiting', async () => {
  process.env.OPC_API_KEY = API_KEY;
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
  assert.match(source, /\$6::timestamptz IS NULL/);
  assert.match(source, /\$4::timestamptz IS NULL/);
  assert.doesNotMatch(source, /\$[46] = '' OR \(created_at, id\)/);
  assert.match(source, /ORDER BY created_at DESC, id DESC/);
  assert.match(source, /ORDER BY created_at \$\{order\}, id \$\{order\}/);
});

test('iveKit chat rejects malformed, wrong-direction, and cross-tenant pagination', async () => {
  process.env.OPC_API_KEY = API_KEY;
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
