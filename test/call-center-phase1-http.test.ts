import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { createServer } from '../src/http.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { listenOnRandomPort } from './test-helpers.js';

const db = createDatabase(':memory:');
const voiceStore = new VoiceStore(db);
const server = createServer(db);
let baseUrl = '';
let tenantId = '';
const apiKey = 'dev-converact-key';

before(async () => {
  process.env.CONVERACT_API_KEY = apiKey;
  const tenant = createTenant(db, { name: 'Phase 1 HTTP' });
  tenantId = tenant.id;
  const session = voiceStore.createCallSession({
    tenant_id: tenantId,
    provider: 'rustpbx',
    direction: 'outbound',
    status: 'active',
    phone: '+81312345678'
  });
  (globalThis as any).__phase1SessionId = session.id;
  const port = await listenOnRandomPort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

test('POST turns + GET turns', async () => {
  const sessionId = (globalThis as any).__phase1SessionId;
  const created = await post(
    `/api/call-center/calls/${sessionId}/turns`,
    { role: 'ai', content: 'こんにちは' },
    { 'X-API-Key': apiKey }
  );
  assert.equal(created.status, 201);
  assert.equal((created.data as { turn_index: number }).turn_index, 1);

  const listed = await fetch(`${baseUrl}/api/call-center/calls/${sessionId}/turns`);
  const turns = (await listed.json()) as unknown[];
  assert.equal(turns.length, 1);
});

test('POST intent updates session metadata', async () => {
  const sessionId = (globalThis as any).__phase1SessionId;
  const res = await post(
    `/api/call-center/calls/${sessionId}/intent`,
    { intent_score: 0.8, signals: ['予約'] },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 200);
  assert.equal((res.data as { intent_score: number }).intent_score, 0.8);
});

test('POST agent-dispatch transfer returns no_seats_available', async () => {
  const sessionId = (globalThis as any).__phase1SessionId;
  const roomName = `phase1-transfer-${sessionId}`;
  const roomRes = await post('/api/livekit/rooms', {
    tenant_id: tenantId,
    purpose: 'pstn_bridge',
    call_session_id: sessionId,
    room_name: roomName
  }, { 'X-API-Key': apiKey });
  assert.equal(roomRes.status, 201);

  const res = await post(
    '/api/livekit/agent-dispatch',
    {
      tenant_id: tenantId,
      room_name: roomName,
      action: 'transfer_to_human',
      reason: 'high intent',
      customer_summary: 'wants viewing',
      intent_score: 0.9,
      language: 'ja'
    },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 200);
  assert.equal((res.data as { action_taken: string }).action_taken, 'no_seats_available');
});

test('POST agent-dispatch end_call completes session', async () => {
  const sessionId = (globalThis as any).__phase1SessionId;
  const roomRes = await post('/api/livekit/rooms', {
    tenant_id: tenantId,
    purpose: 'pstn_bridge',
    call_session_id: sessionId,
    room_name: `phase1-end-${sessionId}`
  }, { 'X-API-Key': apiKey });
  assert.equal(roomRes.status, 201);

  const res = await post(
    '/api/livekit/agent-dispatch',
    {
      tenant_id: tenantId,
      room_name: `phase1-end-${sessionId}`,
      action: 'end_call',
      reason: 'conversation complete',
      customer_summary: 'not interested'
    },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 200);
  assert.equal((res.data as { action_taken: string }).action_taken, 'call_ended');

  const session = voiceStore.getCallSession(tenantId, sessionId);
  assert.equal(session?.status, 'completed');
});

test('POST agent-dispatch schedule_callback creates outbound task', async () => {
  const sessionId = (globalThis as any).__phase1SessionId;
  const roomName = `phase1-cb-${sessionId}`;
  const roomRes = await post('/api/livekit/rooms', {
    tenant_id: tenantId,
    purpose: 'ai_outbound',
    call_session_id: sessionId,
    room_name: roomName
  }, { 'X-API-Key': apiKey });
  assert.equal(roomRes.status, 201);

  const res = await post(
    '/api/livekit/agent-dispatch',
    {
      tenant_id: tenantId,
      room_name: roomName,
      action: 'schedule_callback',
      reason: 'customer busy',
      customer_summary: 'call back tomorrow',
      callback_phone: '+81312349999',
      callback_time: '2026-06-16T10:00:00Z',
      language: 'ja'
    },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 200);
  const body = res.data as { action_taken: string; scheduled_task_id?: string };
  assert.equal(body.action_taken, 'callback_scheduled');
  assert.ok(body.scheduled_task_id);
});

test('POST /api/livekit/rooms rejects missing tenant_id with 400', async () => {
  const res = await post(
    '/api/livekit/rooms',
    { purpose: 'video_service' },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 400);
});

test('POST /api/livekit/rooms rejects missing purpose with 400', async () => {
  const res = await post(
    '/api/livekit/rooms',
    { tenant_id: tenantId },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 400);
});

test('POST /api/livekit/rooms rejects camelCase roomName (no tenant_id/purpose) with 400, not 500', async () => {
  const res = await post(
    '/api/livekit/rooms',
    { roomName: 'test', identity: 'test' },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 400);
});
