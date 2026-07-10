import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import WebSocket from 'ws';
import { createDatabase } from '../src/db.js';
import { MemoryPg, initPostgres, resetPostgresForTests } from '../src/db-pg.js';
import { createServer } from '../src/http.js';
import { signAccessToken, verifyAccessToken, _clearJwksCache } from '../src/middleware/auth.js';
import { ComplianceGate } from '../src/agent-runtime/call-center/compliance/compliance-gate.js';
import {
  beginDisclosure,
  completeDisclosure,
  _resetDisclosureState
} from '../src/agent-runtime/call-center/compliance/disclosure-enforcer.js';
import { ConsentTracker } from '../src/agent-runtime/call-center/compliance/consent-tracker.js';
import { initWebSocket, wsBroadcast, shutdownWebSocket, _resetWsState } from '../src/ws.js';
import { resetRedisPubSubForTests } from '../src/redis-pubsub.js';

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const snapshot: Record<string, string | undefined> = {};
    for (const key of Object.keys(overrides)) {
      snapshot[key] = process.env[key];
      const value = overrides[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

async function httpJson(
  server: ReturnType<typeof createServer>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      reject(new Error('server not listening'));
      return;
    }
    const port = addr.port;
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    };
    const r = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const data = text ? JSON.parse(text) : {};
        resolve({ status: res.statusCode || 0, data });
      });
    });
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
  process.env.OPC_JWT_SECRET = 'test-jwt-secret-sprint1';
  process.env.OPC_COMPLIANCE_NOW = '2026-06-21T10:00:00Z';
  delete process.env.OPC_AUTH_ISSUER;
  process.env.OPC_AUTH_DISABLED = '0';
  _clearJwksCache();
  resetPostgresForTests(null);
  resetRedisPubSubForTests(null);
  _resetWsState();
  _resetDisclosureState();

  const pool = await initPostgres();
  assert.ok(pool instanceof MemoryPg);
  pg = pool;
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

beforeEach(() => {
  _resetDisclosureState();
});

test('register returns JWT and creates tenant', async () => {
  const res = await httpJson(server, 'POST', '/api/auth/register', {
    email: 'owner@example.com',
    password: 'password123',
    name: 'Owner',
    tenantName: 'Acme Call Center'
  });
  assert.equal(res.status, 201);
  assert.ok(res.data.token);
  assert.equal(res.data.user.email, 'owner@example.com');
  assert.equal(res.data.user.role, 'owner');
  assert.equal(res.data.tenant.name, 'Acme Call Center');
  assert.equal(res.data.tenant.plan, 'free');
});

test('login with valid credentials', async () => {
  await httpJson(server, 'POST', '/api/auth/register', {
    email: 'login@example.com',
    password: 'password123',
    name: 'User',
    tenantName: 'Login Corp'
  });
  const res = await httpJson(server, 'POST', '/api/auth/login', {
    email: 'login@example.com',
    password: 'password123'
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.token);
});

test('GET /api/auth/me requires bearer token', async () => {
  const reg = await httpJson(server, 'POST', '/api/auth/register', {
    email: 'me@example.com',
    password: 'password123',
    name: 'Me',
    tenantName: 'Me Corp'
  });
  const res = await httpJson(server, 'GET', '/api/auth/me', undefined, {
    Authorization: `Bearer ${reg.data.token}`
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.email, 'me@example.com');
  assert.ok(Array.isArray(res.data.permissions));
});

test('compliance gate blocks DNC numbers', async () => {
  const gate = new ComplianceGate(pg);
  const tenantId = 'tenant_test_dnc';
  await pg.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1, $2, 'free')`, [
    tenantId,
    'DNC Tenant'
  ]);

  await pg.query(
    `INSERT INTO compliance_dnc_list (id, tenant_id, phone_number, reason) VALUES ($1, $2, $3, $4)`,
    ['dnc_1', tenantId, '+8613800138000', 'customer request']
  );

  const result = await gate.checkOutbound({
    tenantId,
    phoneNumber: '+8613800138000',
    timezone: 'Asia/Shanghai',
    now: new Date('2026-06-21T10:00:00Z')
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'dnc_blocked');
});

test('compliance gate enforces daily frequency limit', async () => {
  const gate = new ComplianceGate(pg);
  const tenantId = 'tenant_freq';
  await pg.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1, $2, 'free')`, [
    tenantId,
    'Freq Tenant'
  ]);

  const phone = '+8613900139000';
  const now = new Date('2026-06-21T10:00:00Z');
  for (let i = 0; i < 3; i++) {
    await gate.recordDialAttempt(tenantId, phone, 'no_answer');
  }

  const result = await gate.checkOutbound({ tenantId, phoneNumber: phone, timezone: 'Asia/Shanghai', now });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'frequency_limit');
});

test('compliance HTTP check endpoint', async () => {
  const reg = await httpJson(server, 'POST', '/api/auth/register', {
    email: 'compliance@example.com',
    password: 'password123',
    name: 'C',
    tenantName: 'Compliance Co'
  });

  const res = await httpJson(
    server,
    'POST',
    '/api/compliance/check',
    { phone_number: '+8613700137000', timezone: 'Asia/Shanghai' },
    { Authorization: `Bearer ${reg.data.token}` }
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.allowed, true);
});

test('disclosure complete records consent', async () => {
  const tracker = new ConsentTracker(pg);
  const callSessionId = 'call_session_test_1';
  const tenantId = 'tenant_consent';

  await pg.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1, $2, 'free')`, [
    tenantId,
    'Consent Tenant'
  ]);

  beginDisclosure(callSessionId, tenantId, 'zh');
  completeDisclosure(callSessionId);
  await tracker.recordAiDisclosureGranted(callSessionId, tenantId);

  const status = await tracker.getAiDisclosureConsent(callSessionId, tenantId);
  assert.equal(status, 'granted');
});

test('WebSocket connects with valid token and receives connected event', async () => {
  const token = signAccessToken({ sub: 'user_ws', tid: 'tenant_ws', role: 'operator' });
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error('ws timeout')), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'connected') {
        clearTimeout(timer);
        assert.equal(msg.data.userId, 'user_ws');
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
});

test('wsBroadcast delivers events to same tenant', async () => {
  const token = signAccessToken({ sub: 'user_bcast', tid: 'tenant_bcast', role: 'admin' });
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error('broadcast timeout')), 5000);

    ws.on('open', () => {
      wsBroadcast('tenant_bcast', 'notification', { title: 'test', body: 'hello' });
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'notification') {
        clearTimeout(timer);
        assert.equal(msg.data.body, 'hello');
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
});

test('verifyAccessToken rejects tampered token', () => {
  const token = signAccessToken({ sub: 'u1', tid: 't1', role: 'viewer' });
  const bad = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal(verifyAccessToken(bad), null);
});
