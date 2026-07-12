import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';

const API_KEY = 'ivekit-context-api-key';
const JWT_SECRET = 'ivekit-context-jwt-secret-with-enough-length';
const TENANT_ID = 'tenant_context';
const BUSINESS_REF = { tenant_id: TENANT_ID, type: 'service_order', id: 'SO-CONTEXT-1' };

function apiHeaders(tenantId = TENANT_ID): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'X-Tenant-Id': tenantId, 'X-User-Id': 'led-backend' };
}

function jwtHeaders(identity: string, tenantId = TENANT_ID): Record<string, string> {
  return {
    Authorization: `Bearer ${signAccessToken({ sub: identity, tid: tenantId, role: 'operator' })}`
  };
}

async function getContext(pg: MemoryPg, headers: Record<string, string>) {
  const path = '/api/ivekit/context/by-ref?business_ref_type=service_order&business_ref_id=SO-CONTEXT-1';
  return routeCollaborationApi(pg, 'GET', path, new URL(`http://localhost${path}`), null, '', headers) as Promise<{
    status?: number;
    data: Record<string, any>;
    headers?: Record<string, string>;
  }>;
}

async function getTimeline(
  pg: MemoryPg,
  headers: Record<string, string>,
  input: { cursor?: string; limit?: number; businessId?: string } = {}
) {
  const query = new URLSearchParams({
    business_ref_type: 'service_order',
    business_ref_id: input.businessId || 'SO-CONTEXT-1'
  });
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  const path = `/api/ivekit/context/timeline?${query}`;
  return routeCollaborationApi(pg, 'GET', path, new URL(`http://localhost${path}`), null, '', headers) as Promise<{
    status?: number;
    data: { items?: Array<Record<string, any>>; has_more?: boolean; next_cursor?: string | null; error?: string };
  }>;
}

async function seedContext(pg: MemoryPg) {
  const module = createCollaborationModule({ pg });
  const chat = await module.sessions.openSession({
    tenant_id: TENANT_ID,
    business_ref: { ...BUSINESS_REF, metadata: { private_customer_phone: '13800000000' } },
    title: 'LED support',
    metadata: { private_chat_token: 'chat-secret' }
  });
  await module.sessions.addParticipant({
    tenant_id: TENANT_ID,
    session_id: chat.id,
    identity: 'active-agent',
    role: 'agent'
  });
  await module.sessions.addParticipant({
    tenant_id: TENANT_ID,
    session_id: chat.id,
    identity: 'former-agent',
    role: 'agent'
  });
  await module.sessions.leaveParticipant({
    tenant_id: TENANT_ID,
    session_id: chat.id,
    identity: 'former-agent'
  });
  const remote = await module.remote.createSession({
    tenant_id: TENANT_ID,
    collaboration_session_id: chat.id,
    business_ref: BUSINESS_REF,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'rustdesk',
    started_by: 'active-agent',
    metadata: { launch_url: 'https://secret.example/launch' }
  });
  await module.remote.grantConsent({
    tenant_id: TENANT_ID,
    remote_session_id: remote.id,
    actor_identity: 'customer-1',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const device = await module.rustdeskDevices.registerDevice({
    tenant_id: TENANT_ID,
    business_ref: BUSINESS_REF,
    rustdesk_id: '123456789',
    display_name: 'LED controller',
    metadata: { password: 'device-secret' }
  });
  const media = new MediaCallStore(pg);
  const call = await media.insertCall({
    tenant_id: TENANT_ID,
    media: 'video',
    initiated_by: 'active-agent',
    business_ref: BUSINESS_REF,
    title: 'Video diagnosis',
    metadata: { livekit_token: 'media-secret' },
    ring_timeout_seconds: 30
  });
  await media.insertParticipant({
    tenant_id: TENANT_ID,
    call_id: call.id,
    identity: 'active-agent',
    role: 'host',
    status: 'joined'
  });
  await media.insertParticipant({
    tenant_id: TENANT_ID,
    call_id: call.id,
    identity: 'media-only',
    role: 'participant',
    status: 'accepted'
  });
  const message = await module.sessions.postMessage({
    tenant_id: TENANT_ID,
    session_id: chat.id,
    sender_identity: 'active-agent',
    message_type: 'text',
    body: 'timeline body must stay private',
    metadata: { private_message_secret: 'message-secret' }
  });
  await media.insertAction({
    tenant_id: TENANT_ID,
    call_id: call.id,
    idempotency_key: 'timeline-media-action',
    payload_hash: 'a'.repeat(64),
    action: 'ring',
    actor_identity: 'active-agent',
    reason: 'private media reason',
    metadata: { private_media_secret: 'media-action-secret' },
    from_status: 'created',
    to_status: 'ringing',
    result_snapshot: { call: { ...call, status: 'ringing' }, participants: [] }
  });
  return { chat, remote, device, call, message };
}

test('iveKit context returns a projected system view without provider secrets', async () => {
  const previous = { apiKey: process.env.OPC_API_KEY, jwtSecret: process.env.OPC_JWT_SECRET };
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_JWT_SECRET = JWT_SECRET;
  try {
    const pg = new MemoryPg();
    const seeded = await seedContext(pg);
    await createCollaborationModule({ pg }).sessions.closeSession(seeded.chat.id);
    const result = await getContext(pg, apiHeaders());

    assert.deepEqual(result.data.business_ref, { type: 'service_order', id: 'SO-CONTEXT-1' });
    assert.deepEqual(result.data.viewer, { identity: 'led-backend', system: true });
    assert.equal(result.data.chat.count, 1);
    assert.equal(result.data.media.count, 1);
    assert.equal(result.data.remote_assistance.count, 1);
    assert.equal(result.data.remote_assistance.devices.length, 1);
    assert.equal(result.data.chat.sessions[0].id, seeded.chat.id);
    assert.equal(result.data.chat.sessions[0].status, 'closed');
    assert.equal(result.data.media.calls[0].id, seeded.call.id);
    assert.equal(result.data.remote_assistance.sessions[0].id, seeded.remote.id);
    assert.equal(result.data.remote_assistance.devices[0].id, seeded.device.id);
    assert.equal(result.data.authorization.chat[0].viewer_role, null);
    assert.deepEqual(result.data.authorization.chat[0].participants.map((participant: { status: string }) => participant.status), ['active', 'left']);
    assert.equal(result.data.authorization.media[0].participants.length, 2);
    assert.deepEqual(result.data.authorization.remote_assistance[0].consent, {
      active: true,
      scopes: ['view_screen', 'control_mouse_keyboard'],
      expires_at: '2099-01-01T00:00:00.000Z'
    });
    assert.equal(result.data.authorization.remote_assistance[0].gateway, null);
    assert.equal(result.headers?.['cache-control'], 'private, no-store');
    assert.doesNotMatch(JSON.stringify(result.data), /13800000000|chat-secret|media-secret|device-secret|123456789|secret\.example/);
  } finally {
    restore('OPC_API_KEY', previous.apiKey);
    restore('OPC_JWT_SECRET', previous.jwtSecret);
  }
});

test('iveKit context scopes chat and remote assistance to active membership', async () => {
  const previous = { apiKey: process.env.OPC_API_KEY, jwtSecret: process.env.OPC_JWT_SECRET };
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_JWT_SECRET = JWT_SECRET;
  try {
    const pg = new MemoryPg();
    await seedContext(pg);

    const active = await getContext(pg, jwtHeaders('active-agent'));
    assert.equal(active.data.chat.count, 1);
    assert.equal(active.data.media.count, 1);
    assert.equal(active.data.remote_assistance.count, 1);
    assert.equal(active.data.remote_assistance.devices.length, 1);
    assert.equal(active.data.authorization.chat[0].viewer_role, 'agent');
    assert.equal(active.data.authorization.media[0].viewer_role, 'host');
    assert.equal(active.data.authorization.media[0].viewer_status, 'joined');
    assert.equal(active.data.authorization.remote_assistance[0].viewer_role, 'agent');

    const mediaOnly = await getContext(pg, jwtHeaders('media-only'));
    assert.equal(mediaOnly.data.chat.count, 0);
    assert.equal(mediaOnly.data.media.count, 1);
    assert.equal(mediaOnly.data.remote_assistance.count, 0);
    assert.equal(mediaOnly.data.remote_assistance.devices.length, 0);
    assert.equal(mediaOnly.data.capabilities.remote_assistance, false);
    assert.equal(mediaOnly.data.authorization.chat.length, 0);
    assert.equal(mediaOnly.data.authorization.media[0].viewer_role, 'participant');
    assert.equal(mediaOnly.data.authorization.remote_assistance.length, 0);

    const outsider = await getContext(pg, jwtHeaders('outsider'));
    assert.equal(outsider.status, 404);
    assert.equal(outsider.data.error, 'business context not found');

    const former = await getContext(pg, jwtHeaders('former-agent'));
    assert.equal(former.status, 404);

    const crossTenant = await getContext(pg, jwtHeaders('active-agent', 'tenant_other'));
    assert.equal(crossTenant.status, 404);
  } finally {
    restore('OPC_API_KEY', previous.apiKey);
    restore('OPC_JWT_SECRET', previous.jwtSecret);
  }
});

test('iveKit context validates query and rejects mutations', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const missingPath = '/api/ivekit/context/by-ref';
  await assert.rejects(
    () => routeCollaborationApi(pg, 'GET', missingPath, new URL(`http://localhost${missingPath}`), null, '', apiHeaders()),
    /business_ref_type and business_ref_id are required/
  );
  const mutation = await routeCollaborationApi(
    pg,
    'POST',
    missingPath,
    new URL(`http://localhost${missingPath}`),
    {},
    '',
    apiHeaders()
  ) as { status: number };
  assert.equal(mutation.status, 405);
});

test('iveKit unified timeline is stable, paged, redacted, and viewer scoped', async () => {
  const previous = { apiKey: process.env.OPC_API_KEY, jwtSecret: process.env.OPC_JWT_SECRET };
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_JWT_SECRET = JWT_SECRET;
  try {
    const pg = new MemoryPg();
    await seedContext(pg);

    const first = await getTimeline(pg, apiHeaders(), { limit: 2 });
    assert.equal(first.data.items?.length, 2);
    assert.equal(first.data.has_more, true);
    assert.ok(first.data.next_cursor);
    const second = await getTimeline(pg, apiHeaders(), { limit: 100, cursor: first.data.next_cursor! });
    assert.ok((second.data.items?.length || 0) > 1);
    const ids = [...(first.data.items || []), ...(second.data.items || [])].map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.some((id) => id.startsWith('chat_message:')));
    assert.ok(ids.some((id) => id.startsWith('media_action:')));
    assert.ok(ids.some((id) => id.startsWith('remote_consent:')));
    assert.ok(ids.some((id) => id.startsWith('evidence:')));
    assert.doesNotMatch(JSON.stringify([...first.data.items || [], ...second.data.items || []]),
      /timeline body|message-secret|private media reason|media-action-secret|launch_url|rustdesk_id/);

    const active = await getTimeline(pg, jwtHeaders('active-agent'), { limit: 100 });
    assert.ok(active.data.items?.some((item) => item.source === 'chat'));
    assert.ok(active.data.items?.some((item) => item.source === 'remote'));
    assert.ok(active.data.items?.some((item) => item.source === 'evidence'));

    const mediaOnly = await getTimeline(pg, jwtHeaders('media-only'), { limit: 100 });
    assert.deepEqual([...new Set((mediaOnly.data.items || []).map((item) => item.source))], ['media']);

    const outsider = await getTimeline(pg, jwtHeaders('outsider'));
    assert.equal(outsider.status, 404);
    assert.equal(outsider.data.error, 'business timeline not found');

    await assert.rejects(
      () => getTimeline(pg, apiHeaders(), { businessId: 'SO-OTHER', cursor: first.data.next_cursor! }),
      /invalid or incompatible timeline cursor/
    );
  } finally {
    restore('OPC_API_KEY', previous.apiKey);
    restore('OPC_JWT_SECRET', previous.jwtSecret);
  }
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
