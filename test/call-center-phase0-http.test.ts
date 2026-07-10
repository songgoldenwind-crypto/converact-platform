import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDatabase, one } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { createServer } from '../src/http.js';
import { AutoAttendantService } from '../src/agent-runtime/call-center/inbound/auto-attendant.js';
import { listenOnRandomPort } from './test-helpers.js';

const db = createDatabase(':memory:');
const server = createServer(db);
let baseUrl = '';
let tenantId = '';
const pbxKey = 'dev-pbx-key';

before(async () => {
  process.env.RUSTPBX_WEBHOOK_KEY = pbxKey;
  const tenant = createTenant(db, { name: 'Phase 0 HTTP' });
  tenantId = tenant.id;
  // Force always-within-business-hours so the call-router test is deterministic
  // regardless of when it runs (routeInboundCall otherwise branches on
  // isWithinBusinessHours using the real current time in Asia/Shanghai).
  new AutoAttendantService(db).upsertConfig(tenantId, {
    business_hours: { sun: [0, 24], mon: [0, 24], tue: [0, 24], wed: [0, 24], thu: [0, 24], fri: [0, 24], sat: [0, 24] }
  });
  const port = await listenOnRandomPort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function request(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {}
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

test('POST /api/call-router returns routing action', async () => {
  const res = await request('POST', '/api/call-router', {
    headers: { 'X-PBX-Key': pbxKey },
    body: {
      call_id: 'test-http-001',
      from_uri: 'sip:+81311112222@trunk',
      to_uri: 'sip:+81333334444@pbx',
      direction: 'inbound',
      headers: { 'X-Tenant-Id': tenantId }
    }
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.action, 'forward');
  assert.ok(res.data.targets?.[0]?.includes('livekit'));
});

test('POST /api/webhooks/rustpbx-cdr ingests CDR', async () => {
  const res = await request('POST', '/api/webhooks/rustpbx-cdr', {
    headers: { 'X-PBX-Key': pbxKey },
    body: {
      call_id: 'test-http-cdr-001',
      direction: 'inbound',
      start_time: '2026-06-15T10:00:00Z',
      answer_time: '2026-06-15T10:00:05Z',
      end_time: '2026-06-15T10:03:00Z',
      duration_sec: 175,
      recording_url: 's3://recordings/rustpbx/test-http-cdr-001.wav',
      hangup_cause: 'normal_clearing',
      metadata: { tenant_id: tenantId }
    }
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.ok(res.data.call_session_id);
  const recording = one(
    db,
    'SELECT * FROM call_recordings WHERE call_session_id = ?',
    [res.data.call_session_id]
  );
  assert.equal(recording?.status, 'completed');
  assert.equal(recording?.business_ref_type, 'call_session');
  assert.equal(recording?.business_ref_id, res.data.call_session_id);
  assert.equal(recording?.retention_until, '2026-09-13T10:03:00.000Z');
});

test('POST /api/webhooks/livekit accepts room_started without signature in dev', async () => {
  const roomName = `${tenantId}-pstn_bridge-http01`;
  const res = await request('POST', '/api/webhooks/livekit', {
    body: {
      event: 'room_started',
      room: { name: roomName, sid: 'RM_test' }
    }
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
});

test('POST + GET /api/call-center/seats', async () => {
  const created = await request('POST', '/api/call-center/seats', {
    body: {
      tenant_id: tenantId,
      user_id: 'agent-http-1',
      display_name: 'Agent HTTP',
      skills: ['japanese']
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.display_name, 'Agent HTTP');

  const listed = await request('GET', `/api/call-center/seats?tenant_id=${tenantId}`);
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.data));
  assert.ok(listed.data.some((seat: { user_id: string }) => seat.user_id === 'agent-http-1'));
});

test('POST + GET /api/call-center/outbound-tasks', async () => {
  const created = await request('POST', '/api/call-center/outbound-tasks', {
    body: {
      tenant_id: tenantId,
      phone_number: '+81312345678',
      channel: 'pstn_voice',
      strategy: { script_id: 'demo', language: 'ja' }
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'pending');

  const listed = await request(
    'GET',
    `/api/call-center/outbound-tasks?tenant_id=${tenantId}&status=pending`
  );
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.data));
  assert.ok(listed.data.some((task: { id: string }) => task.id === created.data.id));
});

test('GET /api/livekit/token issues dev token when LiveKit is not configured', async () => {
  const room = await request('POST', '/api/livekit/rooms', {
    body: {
      tenant_id: tenantId,
      purpose: 'video_service',
      room_name: 'test-room'
    }
  });
  assert.equal(room.status, 201);

  const res = await request(
    'GET',
    `/api/livekit/token?room_name=test-room&identity=agent1&role=agent&tenant_id=${tenantId}`
  );
  assert.equal(res.status, 200);
  assert.match(res.data.token, /^dev-token:/);
  assert.equal(res.data.configured, false);
});
