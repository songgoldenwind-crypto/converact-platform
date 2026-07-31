import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { routeIvrApi } from '../src/agent-runtime/ivr/ivr-http.js';
import { FEW_SHOT_M1 } from '../src/agent-runtime/ivr/ivr-generator-seeds.js';

const API_KEY = 'test-ivr-generator-http-key';
const authHeaders = (tenantId: string) => ({ 'X-API-Key': API_KEY, 'X-Tenant-Id': tenantId });

const saved: Record<string, string | undefined> = {};

afterEach(() => {
  mock.restoreAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

function setEnv(key: string, value: string | undefined) {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function setupTenant() {
  process.env.OPC_API_KEY = API_KEY;
  setEnv('LLM_API_KEY', 'test-key');
  setEnv('LLM_BASE_URL', 'http://primary/v1');
  setEnv('LLM_MODEL', 'Qwen3.6-27B');
  setEnv('DEEPSEEK_API_KEY', undefined);
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Generator HTTP Test' });
  return { db, tenantId: tenant.id };
}

function mockLlmResponse(content: string) {
  return mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

test('POST /api/ivr/generate-from-text returns publishReady graph with llmTier', async () => {
  const { db, tenantId } = setupTenant();
  mockLlmResponse(FEW_SHOT_M1);

  const res = (await routeIvrApi(
    db,
    'POST',
    '/api/ivr/generate-from-text',
    new URL('http://localhost/api/ivr/generate-from-text'),
    { description: '两段欢迎语，按1转销售队列' },
    authHeaders(tenantId)
  )) as { data: { publishReady: boolean; llmTier: string; model: string; graph: { nodes: unknown[] } } };

  assert.equal(res.data.publishReady, true);
  assert.equal(res.data.llmTier, 'primary');
  assert.equal(res.data.model, 'Qwen3.6-27B');
  assert.ok(res.data.graph.nodes.length > 0);
});

test('POST /api/ivr/generate-from-csv returns publishReady graph', async () => {
  const { db, tenantId } = setupTenant();
  mockLlmResponse(FEW_SHOT_M1);

  const res = (await routeIvrApi(
    db,
    'POST',
    '/api/ivr/generate-from-csv',
    new URL('http://localhost/api/ivr/generate-from-csv'),
    { csv: 'digit,description,target\n1,销售,sales' },
    authHeaders(tenantId)
  )) as { data: { publishReady: boolean; llmTier: string } };

  assert.equal(res.data.publishReady, true);
  assert.equal(res.data.llmTier, 'primary');
});

test('POST /api/ivr/generate-from-text returns 422 on bad LLM JSON', async () => {
  const { db, tenantId } = setupTenant();
  mockLlmResponse('not valid json {{{');

  const res = (await routeIvrApi(
    db,
    'POST',
    '/api/ivr/generate-from-text',
    new URL('http://localhost/api/ivr/generate-from-text'),
    { description: '任意描述' },
    authHeaders(tenantId)
  )) as { status: number; data: { error: string; validation?: unknown } };

  assert.equal(res.status, 422);
  assert.match(res.data.error, /JSON parse failed/);
  assert.equal(res.data.validation, undefined);
});

test('POST /api/ivr/generate-from-csv returns 400 for empty CSV', async () => {
  const { db, tenantId } = setupTenant();

  const res = (await routeIvrApi(
    db,
    'POST',
    '/api/ivr/generate-from-csv',
    new URL('http://localhost/api/ivr/generate-from-csv'),
    { csv: 'digit,description\n' },
    authHeaders(tenantId)
  )) as { status: number; data: { error: string } };

  assert.equal(res.status, 400);
  assert.match(res.data.error, /No valid rows in CSV/);
});

test('POST /api/ivr/generate-from-text returns 401 when LLM auth fails — no fallback', async () => {
  const { db, tenantId } = setupTenant();
  setEnv('DEEPSEEK_API_KEY', 'sk-fallback');
  setEnv('DEEPSEEK_API_BASE', 'http://fallback/v1');
  mock.method(globalThis, 'fetch', async () => new Response('unauthorized', { status: 401 }));

  const res = (await routeIvrApi(
    db,
    'POST',
    '/api/ivr/generate-from-text',
    new URL('http://localhost/api/ivr/generate-from-text'),
    { description: '任意描述' },
    authHeaders(tenantId)
  )) as { status: number; data: { error: string } };

  assert.equal(res.status, 401);
  assert.match(res.data.error, /401/);
});

test('POST /api/ivr/generate-from-text returns upstream status when LLM unavailable', async () => {
  const { db, tenantId } = setupTenant();
  mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));

  const res = (await routeIvrApi(
    db,
    'POST',
    '/api/ivr/generate-from-text',
    new URL('http://localhost/api/ivr/generate-from-text'),
    { description: '任意描述' },
    authHeaders(tenantId)
  )) as { status: number; data: { error: string } };

  assert.equal(res.status, 503);
  assert.match(res.data.error, /503/);
});
