import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { createServer } from '../src/http.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { INTENT_TRANSFER_THRESHOLD, intentRecommendation } from '../src/agent-runtime/call-center/intent-policy.js';
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
  const tenant = createTenant(db, { name: 'Intent Navigation Flow' });
  tenantId = tenant.id;
  const session = voiceStore.createCallSession({
    tenant_id: tenantId,
    provider: 'rustpbx',
    direction: 'outbound',
    status: 'active',
    phone: '+8613800138000',
    metadata: {}
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

test('intent policy threshold matches python TRANSFER_THRESHOLD', () => {
  assert.equal(INTENT_TRANSFER_THRESHOLD, 0.7);
  assert.equal(intentRecommendation(0.69), 'continue');
  assert.equal(intentRecommendation(0.7), 'transfer');
});

test('import IVR spec and navigate to sales node', async () => {
  const imported = await post(
    '/api/voice-agents/import-ivr',
    {
      tenant_id: tenantId,
      goal: '销售分流',
      publish: true,
      menus: [
        {
          id: 'root',
          name: '主菜单',
          prompt: '按1销售',
          options: [{ key: '1', label: '销售', target: 'sales' }]
        },
        {
          id: 'sales',
          name: '销售',
          prompt: '请说预算',
          action: 'transfer_human'
        }
      ]
    },
    { 'X-API-Key': apiKey }
  );
  assert.equal(imported.status, 201);
  specId = (imported.data as { id: string }).id;

  const nav = await post(
    `/api/call-center/calls/${sessionId}/navigate`,
    { trigger: '1', agent_spec_id: specId },
    { 'X-API-Key': apiKey }
  );
  assert.equal(nav.status, 200);
  assert.equal((nav.data as { current_node_id: string }).current_node_id, 'sales');
});

test('high intent report then intent_high navigation reaches transfer terminal', async () => {
  const intent = await post(
    `/api/call-center/calls/${sessionId}/intent`,
    { intent_score: 0.85, signals: ['询问价格', '确认看房'] },
    { 'X-API-Key': apiKey }
  );
  assert.equal(intent.status, 200);
  assert.equal(intentRecommendation(0.85), 'transfer');

  const sessionAfterIntent = voiceStore.getCallSession(tenantId, sessionId);
  const meta = sessionAfterIntent?.metadata as Record<string, unknown>;
  assert.equal(meta.intent_score, 0.85);

  const transfer = await post(
    `/api/call-center/calls/${sessionId}/navigate`,
    {
      trigger: 'intent_high',
      agent_spec_id: specId,
      customer_text: '客户确认预算并想周六看房'
    },
    { 'X-API-Key': apiKey }
  );
  assert.equal(transfer.status, 200);
  const body = transfer.data as {
    action_taken: string;
    reached_terminal: boolean;
    current_node_id: string;
  };
  assert.equal(body.action_taken, 'transfer_human');
  assert.equal(body.reached_terminal, true);
  assert.equal(body.current_node_id, 'sales');
});

test('low intent report keeps conversation on sales node without terminal', async () => {
  await post(
    `/api/call-center/calls/${sessionId}/navigate`,
    { trigger: 'start', agent_spec_id: specId },
    { 'X-API-Key': apiKey }
  );
  await post(
    `/api/call-center/calls/${sessionId}/navigate`,
    { trigger: '1', agent_spec_id: specId },
    { 'X-API-Key': apiKey }
  );

  const intent = await post(
    `/api/call-center/calls/${sessionId}/intent`,
    { intent_score: 0.35, signals: ['随便看看'] },
    { 'X-API-Key': apiKey }
  );
  assert.equal(intent.status, 200);
  assert.equal(intentRecommendation(0.35), 'continue');

  const stay = await post(
    `/api/call-center/calls/${sessionId}/navigate`,
    {
      trigger: 'default',
      agent_spec_id: specId,
      customer_text: '我再考虑一下'
    },
    { 'X-API-Key': apiKey }
  );
  assert.equal(stay.status, 200);
  const body = stay.data as { current_node_id: string; reached_terminal: boolean };
  assert.equal(body.current_node_id, 'sales');
  assert.equal(body.reached_terminal, false);
});
