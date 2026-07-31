import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createDatabase } from '../src/db.js';
import { MemoryPg, initPostgres, resetPostgresForTests } from '../src/db-pg.js';
import { createServer } from '../src/http.js';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { OutboundTaskStore } from '../src/agent-runtime/call-center/outbound-task-store.js';
import { VoiceAgentSpecStore } from '../src/agent-runtime/call-center/voice-agent-spec-store.js';
import {
  getCallSessionCache,
  initCallSessionCache,
  patchCallSessionCache
} from '../src/redis-session-cache.js';
import { wsBroadcast, initWebSocket, shutdownWebSocket, _resetWsState } from '../src/ws.js';
import { resetRedisPubSubForTests } from '../src/redis-pubsub.js';

async function httpJson(
  server: ReturnType<typeof createServer>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
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
          resolve({
            status: res.statusCode || 0,
            body: text ? JSON.parse(text) : {}
          });
        });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let pg: MemoryPg;
let db: ReturnType<typeof createDatabase>;
let server: ReturnType<typeof createServer>;

before(async () => {
  process.env.OPC_USE_MEMORY_PG = '1';
  process.env.OPC_USE_MEMORY_REDIS = '1';
  process.env.OPC_JWT_SECRET = 'test-jwt-secret-e2e';
  process.env.OPC_COMPLIANCE_NOW = '2026-06-21T10:00:00Z';
  process.env.OPC_AUTH_DISABLED = '0';
  process.env.OPC_DISABLE_DIALER = '1';
  delete process.env.OPC_AUTH_ISSUER;

  resetPostgresForTests(null);
  resetRedisPubSubForTests(null);
  _resetWsState();
  useMemoryRedisForTests();

  pg = (await initPostgres()) as MemoryPg;
  db = createDatabase(':memory:');
  server = createServer(db, pg);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  initWebSocket(server);
});

after(async () => {
  await shutdownWebSocket();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetPostgresForTests(null);
});

test('E2E: register → onboarding seed → create spec task → session cache → WS event', async () => {
  const reg = await httpJson(server, 'POST', '/api/auth/register', {
    email: 'demo@example.com',
    password: 'password123',
    name: 'Demo Owner',
    tenantName: 'Demo Call Center'
  });
  assert.equal(reg.status, 201);
  assert.ok(reg.body.token);
  assert.ok(reg.body.onboarding?.default_spec_id);
  const tenantId = reg.body.tenant.id;
  const specId = reg.body.onboarding.default_spec_id;
  const token = reg.body.token as string;

  const specStore = new VoiceAgentSpecStore(db);
  const spec = specStore.getSpec(specId, tenantId);
  assert.ok(spec);
  assert.equal(spec?.status, 'published');

  const taskRes = await httpJson(
    server,
    'POST',
    '/api/call-center/outbound-tasks',
    {
      tenant_id: tenantId,
      phone_number: '+8613900139001',
      channel: 'pstn_voice',
      strategy: { agent_spec_id: specId, language: 'zh' }
    },
    { Authorization: `Bearer ${token}` }
  );
  assert.equal(taskRes.status, 201);
  const taskId = taskRes.body.id;
  assert.ok(taskId);

  const callSessionId = 'call_session_e2e_demo';
  await initCallSessionCache(callSessionId, tenantId, { state: 'active', turn_count: 0 });
  await patchCallSessionCache(callSessionId, { state: 'completed', turn_count: '2' });
  const cache = await getCallSessionCache(callSessionId);
  assert.equal(cache?.state, 'completed');
  assert.equal(cache?.turn_count, 2);

  const store = new OutboundTaskStore(db);
  const completed = store.updateTask(taskId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    result: { intent_score: 0.82, answered: true }
  });
  assert.ok(completed);

  await new Promise<void>((resolve, reject) => {
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error('ws timeout')), 5000);
    ws.on('open', () => {
      wsBroadcast(tenantId, 'call.completed', {
        call_session_id: callSessionId,
        task_id: taskId,
        status: 'completed',
        phone_number: '+8613900139001'
      });
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'call.completed') {
        clearTimeout(timer);
        assert.equal(msg.data.task_id, taskId);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
});

test('E2E: compliance check allows outbound in frozen test window', async () => {
  const reg = await httpJson(server, 'POST', '/api/auth/register', {
    email: 'compliance-demo@example.com',
    password: 'password123',
    name: 'C',
    tenantName: 'Compliance Demo'
  });
  const token = reg.body.token as string;
  const check = await httpJson(
    server,
    'POST',
    '/api/compliance/check',
    { phone_number: '+8613700137001', timezone: 'Asia/Shanghai' },
    { Authorization: `Bearer ${token}` }
  );
  assert.equal(check.status, 200);
  assert.equal(check.body.allowed, true);
});
