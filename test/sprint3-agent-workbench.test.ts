import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createDatabase, one } from '../src/db.js';
import { MemoryPg, initPostgres, resetPostgresForTests } from '../src/db-pg.js';
import { createServer } from '../src/http.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { LiveKitRoomStore } from '../src/agent-runtime/livekit/room-store.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { handleAgentDispatchCommand } from '../src/agent-runtime/call-center/application.js';
import { onboardCallCenterTenant } from '../src/tenant-onboarding.js';
import { initWebSocket, shutdownWebSocket, _resetWsState, wsBroadcast } from '../src/ws.js';
import { resetRedisPubSubForTests } from '../src/redis-pubsub.js';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';

async function httpJson(
  server: ReturnType<typeof createServer>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const r = request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...headers
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : {} });
          });
        }
      );
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

let server: ReturnType<typeof createServer>;
let db: ReturnType<typeof createDatabase>;
let token = '';
let tenantId = '';
let userId = '';
let seatId = '';

before(async () => {
  process.env.OPC_USE_MEMORY_PG = '1';
  process.env.OPC_USE_MEMORY_REDIS = '1';
  process.env.OPC_JWT_SECRET = 'test-sprint3';
  process.env.OPC_API_KEY = 'test-api-key';
  process.env.OPC_AUTH_DISABLED = '0';
  resetPostgresForTests(null);
  resetRedisPubSubForTests(null);
  _resetWsState();
  useMemoryRedisForTests();

  const pg = await initPostgres();
  db = createDatabase(':memory:');
  server = createServer(db, pg);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  initWebSocket(server);

  const reg = await httpJson(server, 'POST', '/api/auth/register', {
    email: 'agent@example.com',
    password: 'password123',
    name: 'Agent',
    tenantName: 'Sprint3 Corp'
  });
  token = reg.body.token;
  tenantId = reg.body.tenant.id;
  userId = reg.body.user.id;
  seatId = reg.body.onboarding.seat_id;

  const seatStore = new AgentSeatStore(db);
  seatStore.updateStatus(tenantId, seatId, 'idle');
});

after(async () => {
  await shutdownWebSocket();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('transfer dispatches call.incoming via WebSocket', async () => {
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenantId,
    direction: 'outbound',
    status: 'active',
    phone: '+8613800138000',
    metadata: { intent_score: 0.91, customer_summary: '客户询问价格' }
  });

  const roomStore = new LiveKitRoomStore(db);
  const room = await roomStore.createRoom({
    tenant_id: tenantId,
    purpose: 'pstn_bridge',
    call_session_id: session.id,
    room_name: `room-sprint3-${session.id.slice(-6)}`
  });

  await new Promise<void>((resolve, reject) => {
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error('ws timeout')), 5000);

    ws.on('open', () => {
      handleAgentDispatchCommand(db, {}, {
        tenant_id: tenantId,
        room_name: room.room_name,
        action: 'transfer_to_human',
        reason: 'high intent',
        customer_summary: '客户询问价格',
        intent_score: 0.91,
        language: 'zh'
      });
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'call.incoming') {
        clearTimeout(timer);
        assert.equal(msg.data.call_session_id, session.id);
        assert.equal(msg.data.target_user_id, userId);
        assert.equal(msg.data.seat_id, seatId);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
});

test('accept transfer issues livekit token and starts recording record', async () => {
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenantId,
    direction: 'outbound',
    status: 'active',
    phone: '+8613900139002'
  });

  const roomStore = new LiveKitRoomStore(db);
  const room = await roomStore.createRoom({
    tenant_id: tenantId,
    purpose: 'pstn_bridge',
    call_session_id: session.id,
    room_name: `room-accept-${session.id.slice(-6)}`
  });

  const accept = await httpJson(
    server,
    'POST',
    `/api/call-center/transfers/${session.id}/accept`,
    { seat_id: seatId },
    { Authorization: `Bearer ${token}` }
  );

  assert.equal(accept.status, 200);
  assert.ok(accept.body.livekit?.token);
  assert.equal(accept.body.room_name, room.room_name);
  assert.equal(accept.body.recording, null);
  assert.equal(accept.body.recording_failure, null);
  assert.equal(accept.body.recording_status, 'scheduled');
  assert.equal(accept.body.call_status, 'active');
  await waitFor(() => Boolean(one(
    db,
    'SELECT id FROM call_recordings WHERE tenant_id = ? AND call_session_id = ?',
    [tenantId, session.id]
  )));
});

test('accept transfer keeps media available when recording storage path fails', async () => {
  const failedEgress = createHttpServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'object storage unavailable' }));
    }, 800);
  });
  await new Promise<void>((resolve) => failedEgress.listen(0, '127.0.0.1', resolve));
  const address = failedEgress.address();
  assert.ok(address && typeof address !== 'string');

  const previous = {
    url: process.env.LIVEKIT_URL,
    key: process.env.LIVEKIT_API_KEY,
    secret: process.env.LIVEKIT_API_SECRET
  };

  try {
    const voiceStore = new VoiceStore(db);
    const session = voiceStore.createCallSession({
      tenant_id: tenantId,
      direction: 'outbound',
      status: 'active',
      phone: '+8613900139003'
    });
    const roomStore = new LiveKitRoomStore(db);
    const room = await roomStore.createRoom({
      tenant_id: tenantId,
      purpose: 'pstn_bridge',
      call_session_id: session.id,
      room_name: `room-recording-failure-${session.id.slice(-6)}`
    });
    new AgentSeatStore(db).updateStatus(tenantId, seatId, 'idle');
    process.env.LIVEKIT_URL = `ws://127.0.0.1:${address.port}`;
    process.env.LIVEKIT_API_KEY = 'recording-failure-test-key';
    process.env.LIVEKIT_API_SECRET = 'recording-failure-test-secret';

    const startedAt = Date.now();
    const accept = await httpJson(
      server,
      'POST',
      `/api/call-center/transfers/${session.id}/accept`,
      { seat_id: seatId },
      { Authorization: `Bearer ${token}` }
    );
    const acceptElapsedMs = Date.now() - startedAt;

    assert.equal(accept.status, 200);
    assert.ok(acceptElapsedMs < 300, `accept took ${acceptElapsedMs}ms`);
    assert.ok(accept.body.livekit?.token);
    assert.equal(accept.body.room_name, room.room_name);
    assert.equal(accept.body.recording, null);
    assert.equal(accept.body.recording_failure, null);
    assert.equal(accept.body.recording_status, 'scheduled');
    assert.equal(accept.body.call_status, 'active');
    assert.equal(voiceStore.getCallSession(tenantId, session.id)?.status, 'active');
    await waitFor(() => {
      const recording = one(
        db,
        'SELECT status, failure_code FROM call_recordings WHERE tenant_id = ? AND call_session_id = ?',
        [tenantId, session.id]
      );
      return recording?.status === 'failed'
        && recording?.failure_code === 'livekit_egress_start_failed';
    });
  } finally {
    if (previous.url == null) delete process.env.LIVEKIT_URL;
    else process.env.LIVEKIT_URL = previous.url;
    if (previous.key == null) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = previous.key;
    if (previous.secret == null) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = previous.secret;
    failedEgress.closeAllConnections();
    await new Promise<void>((resolve) => failedEgress.close(() => resolve()));
  }
});

test('seat status change broadcasts seat.status_changed', async () => {
  await new Promise<void>((resolve, reject) => {
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error('status ws timeout')), 5000);

    ws.on('open', async () => {
      await httpJson(
        server,
        'PUT',
        `/api/call-center/seats/${seatId}/status?tenant_id=${tenantId}`,
        { status: 'training' },
        { Authorization: `Bearer ${token}` }
      );
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'seat.status_changed' && msg.data.new_status === 'training') {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
});
