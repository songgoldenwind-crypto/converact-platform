import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { createServer } from '../src/http.js';
import { listenOnRandomPort } from './test-helpers.js';

const db = createDatabase(':memory:');
const server = createServer(db);
let baseUrl = '';
let tenantId = '';
const apiKey = 'dev-converact-key';

before(async () => {
  process.env.CONVERACT_API_KEY = apiKey;
  process.env.DISABLE_AI_SCRIPT_GENERATION = 'true';
  const tenant = createTenant(db, { name: 'Agent Factory HTTP' });
  tenantId = tenant.id;
  const port = await listenOnRandomPort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  delete process.env.DISABLE_AI_SCRIPT_GENERATION;
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

test('POST /api/voice-agents/generate creates draft spec from goal', async () => {
  const res = await post(
    '/api/voice-agents/generate',
    {
      tenant_id: tenantId,
      goal: '邀请客户参加线上产品演示',
      industry: 'SaaS',
      brand_name: 'Converact',
      language: 'zh'
    },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 201);
  const body = res.data as { id: string; status: string; generation_source: string; runtime: { greeting: string } };
  assert.equal(body.status, 'draft');
  assert.equal(body.generation_source, 'template');
  assert.ok(body.runtime.greeting.includes('Converact'));

  (globalThis as any).__generatedSpecId = body.id;
});

test('POST publish promotes draft to published', async () => {
  const specId = (globalThis as any).__generatedSpecId;
  const res = await post(
    `/api/voice-agents/specs/${specId}/publish?tenant_id=${tenantId}`,
    {},
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 200);
  assert.equal((res.data as { status: string }).status, 'published');
});

test('generated spec can be used in outbound task strategy', async () => {
  const specId = (globalThis as any).__generatedSpecId;
  const res = await post('/api/call-center/outbound-tasks', {
    tenant_id: tenantId,
    phone_number: '+8613800138000',
    channel: 'pstn_voice',
    strategy: { language: 'zh', agent_spec_id: specId }
  });
  assert.equal(res.status, 201);
  const task = res.data as { strategy: { agent_spec_id: string } };
  assert.equal(task.strategy.agent_spec_id, specId);
});
