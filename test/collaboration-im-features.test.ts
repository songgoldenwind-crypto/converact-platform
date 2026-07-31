import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { CollaborationMessageStateStore } from '../src/agent-runtime/collaboration/message-state-store.js';
import { routeIveKitChatApi } from '../src/agent-runtime/ivekit/chat-http.js';
import { MemoryPg } from '../src/db-pg.js';

const API_KEY = 'test-im-features-key';

function headers(tenantId: string, userId = 'agent-rich'): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

async function route(
  pg: MemoryPg,
  method: string,
  path: string,
  tenantId: string,
  body: unknown = null,
  userId = 'agent-rich'
) {
  return routeIveKitChatApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers(tenantId, userId)
  );
}

test('IM feature migration adds relation columns and forced tenant RLS', () => {
  const path = 'src/migrations/033_collaboration_im_features.sql';
  assert.equal(existsSync(path), true);
  const migration = readFileSync(path, 'utf8');
  for (const marker of [
    'reply_to_message_id',
    'forwarded_from_message_id',
    'mentions',
    'collaboration_message_reactions',
    'collaboration_message_pins',
    'FORCE ROW LEVEL SECURITY',
    'opc_current_tenant()'
  ]) assert.match(migration, new RegExp(marker));
});

test('iveKit chat supports replies, forwards, mentions, reactions, and pins', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_rich_im';
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'RICH-1' },
    title: 'Rich IM'
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'agent-rich',
    role: 'agent'
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'customer-rich',
    role: 'customer'
  });
  const original = await store.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer-rich',
    message_type: 'text',
    body: 'Original message'
  });

  const replied = await route(
    pg,
    'POST',
    `/api/ivekit/chat/sessions/${session.id}/messages`,
    tenantId,
    {
      sender_identity: 'agent-rich',
      body: 'Reply message',
      reply_to_message_id: original.id,
      forwarded_from_message_id: original.id,
      mentions: ['customer-rich', 'customer-rich']
    }
  ) as {
    data: {
      message: {
        id: string;
        reply_to_message_id: string | null;
        forwarded_from_message_id: string | null;
        mentions: string[];
      };
    };
  };
  assert.equal(replied.data.message.reply_to_message_id, original.id);
  assert.equal(replied.data.message.forwarded_from_message_id, original.id);
  assert.deepEqual(replied.data.message.mentions, ['customer-rich']);

  const emoji = encodeURIComponent('thumbs-up');
  const reacted = await route(
    pg,
    'PUT',
    `/api/ivekit/chat/sessions/${session.id}/messages/${original.id}/reactions/${emoji}`,
    tenantId
  ) as { data: { reactions: Array<{ identity: string; emoji: string }>; counts: Record<string, number> } };
  assert.equal(reacted.data.reactions.length, 1);
  assert.equal(reacted.data.counts['thumbs-up'], 1);
  const replayed = await route(
    pg,
    'PUT',
    `/api/ivekit/chat/sessions/${session.id}/messages/${original.id}/reactions/${emoji}`,
    tenantId
  ) as { data: { reactions: unknown[] } };
  assert.equal(replayed.data.reactions.length, 1);

  const pinned = await route(
    pg,
    'PUT',
    `/api/ivekit/chat/sessions/${session.id}/pins/${original.id}`,
    tenantId
  ) as { data: { pins: Array<{ message_id: string; pinned_by: string }> } };
  assert.deepEqual(pinned.data.pins.map((pin) => pin.message_id), [original.id]);
  assert.equal(pinned.data.pins[0].pinned_by, 'agent-rich');

  const listed = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions/${session.id}/pins`,
    tenantId
  ) as { data: { pins: Array<{ message_id: string }> } };
  assert.deepEqual(listed.data.pins.map((pin) => pin.message_id), [original.id]);

  const unreacted = await route(
    pg,
    'DELETE',
    `/api/ivekit/chat/sessions/${session.id}/messages/${original.id}/reactions/${emoji}`,
    tenantId
  ) as { data: { reactions: unknown[] } };
  assert.equal(unreacted.data.reactions.length, 0);
  const unpinned = await route(
    pg,
    'DELETE',
    `/api/ivekit/chat/sessions/${session.id}/pins/${original.id}`,
    tenantId
  ) as { data: { pins: unknown[] } };
  assert.equal(unpinned.data.pins.length, 0);
});

test('rich IM relations reject foreign sessions, inactive mentions, and foreign tenants', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const store = new CollaborationStore(pg);
  const tenantId = 'tenant_rich_guards';
  const first = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'GUARD-1' }
  });
  const second = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'GUARD-2' }
  });
  for (const sessionId of [first.id, second.id]) {
    await store.addParticipant({
      tenant_id: tenantId,
      session_id: sessionId,
      identity: 'agent-rich',
      role: 'agent'
    });
  }
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: first.id,
    identity: 'left-user',
    role: 'customer'
  });
  await store.leaveParticipant({ tenant_id: tenantId, session_id: first.id, identity: 'left-user' });
  const foreignMessage = await store.postMessage({
    tenant_id: tenantId,
    session_id: second.id,
    sender_identity: 'agent-rich',
    message_type: 'text',
    body: 'Different session'
  });
  const deletedMessage = await store.postMessage({
    tenant_id: tenantId,
    session_id: first.id,
    sender_identity: 'agent-rich',
    message_type: 'text',
    body: 'Deleted target'
  });
  await new CollaborationMessageStateStore(pg).deleteMessage({
    tenant_id: tenantId,
    session_id: first.id,
    message_id: deletedMessage.id,
    actor_identity: 'agent-rich'
  });

  await assert.rejects(
    () => route(pg, 'POST', `/api/ivekit/chat/sessions/${first.id}/messages`, tenantId, {
      sender_identity: 'agent-rich',
      body: 'bad reply',
      reply_to_message_id: foreignMessage.id
    }),
    (error: unknown) => (error as { status?: number }).status === 400
  );
  await assert.rejects(
    () => route(
      pg,
      'PUT',
      `/api/ivekit/chat/sessions/${first.id}/messages/${deletedMessage.id}/reactions/like`,
      tenantId
    ),
    (error: unknown) => (error as { status?: number }).status === 404
  );
  await assert.rejects(
    () => route(pg, 'PUT', `/api/ivekit/chat/sessions/${first.id}/pins/${deletedMessage.id}`, tenantId),
    (error: unknown) => (error as { status?: number }).status === 404
  );
  await assert.rejects(
    () => route(pg, 'POST', `/api/ivekit/chat/sessions/${first.id}/messages`, tenantId, {
      sender_identity: 'agent-rich',
      body: 'bad mention',
      mentions: ['left-user']
    }),
    (error: unknown) => (error as { status?: number }).status === 400
  );

  const crossTenant = await route(
    pg,
    'GET',
    `/api/ivekit/chat/sessions/${first.id}/pins`,
    'tenant_rich_foreign'
  ) as { status: number };
  assert.equal(crossTenant.status, 404);
});
