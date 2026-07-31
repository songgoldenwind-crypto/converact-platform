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
let sessionId = '';
let specId = '';
const apiKey = 'dev-opc-key';

before(async () => {
  process.env.CONVERACT_API_KEY = apiKey;
  const tenant = createTenant(db, { name: 'IVR Navigation HTTP' });
  tenantId = tenant.id;
  const session = voiceStore.createCallSession({
    tenant_id: tenantId,
    provider: 'rustpbx',
    direction: 'outbound',
    status: 'active',
    phone: '+8613800138000'
  });
  sessionId = session.id;
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

test('POST import-ivr creates spec with nodes', async () => {
  const res = await post(
    '/api/voice-agents/import-ivr',
    {
      tenant_id: tenantId,
      goal: '客服分流',
      brand_name: 'OPC',
      publish: true,
      menus: [
        {
          id: 'root',
          name: '主菜单',
          prompt: '请问需要销售还是售后？',
          options: [
            { key: '1', label: '销售', target: 'sales' },
            { key: '2', label: '售后', target: 'support' }
          ]
        },
        { id: 'sales', name: '销售', prompt: '请说预算。' },
        { id: 'support', name: '售后', prompt: '请说问题。' }
      ]
    },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 201);
  const body = res.data as { id: string; nodes: unknown[]; status: string };
  assert.equal(body.status, 'published');
  assert.equal(body.nodes.length, 3);
  specId = body.id;
});

test('POST navigate moves session node from root to sales', async () => {
  const res = await post(
    `/api/call-center/calls/${sessionId}/navigate`,
    { trigger: '1', agent_spec_id: specId },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 200);
  const body = res.data as { current_node_id: string; node_name: string };
  assert.equal(body.current_node_id, 'sales');
  assert.equal(body.node_name, '销售');

  const session = voiceStore.getCallSession(tenantId, sessionId);
  const metadata = session?.metadata as Record<string, unknown> | undefined;
  assert.equal(metadata?.current_node_id, 'sales');
  assert.equal(metadata?.navigation_version, 1);
});

test('POST navigate with customer_text matches keyword route', async () => {
  await post(
    `/api/call-center/calls/${sessionId}/navigate`,
    { trigger: 'start', agent_spec_id: specId },
    { 'X-API-Key': apiKey }
  );

  const res = await post(
    `/api/call-center/calls/${sessionId}/navigate`,
    { trigger: 'default', agent_spec_id: specId, customer_text: '我要售后' },
    { 'X-API-Key': apiKey }
  );
  assert.equal(res.status, 200);
  assert.equal((res.data as { current_node_id: string }).current_node_id, 'support');
});
