import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import { routeIvrApi } from '../src/agent-runtime/ivr/ivr-http.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { withCompleteMenuEdges } from './helpers/ivr-complete-menu-graph.js';

const API_KEY = 'test-ivr-sessions-key';
const authHeaders = (tenantId: string) => ({ 'X-API-Key': API_KEY, 'X-Tenant-Id': tenantId });

const baseSampleGraph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  nodes: [
    { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
    { id: 'play1', type: 'play', name: '欢迎', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: '欢迎致电' }] } },
    { id: 'menu1', type: 'menu', name: '菜单', position: { x: 400, y: 0 }, data: {
      prompt: [{ playType: 'tts', text: '按1销售' }],
      options: [{ digit: '1', label: '销售', routeType: 'node', routeTarget: '' }],
      timeoutSec: 5, maxRetries: 3,
    } },
    { id: 'transfer1', type: 'transfer', name: '转销售', position: { x: 600, y: 0 }, data: { targetType: 'queue', targetValue: 'sales' } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'play1', sourceHandle: 'out' },
    { id: 'e2', source: 'play1', target: 'menu1', sourceHandle: 'out' },
    { id: 'e3', source: 'menu1', target: 'transfer1', sourceHandle: 'digit_1' },
  ],
  variables: [],
};

const sampleGraph = withCompleteMenuEdges(baseSampleGraph, 'menu1');

function setup() {
  process.env.OPC_API_KEY = API_KEY;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Session Test' });
  const store = new IvrFlowStore(db);
  const flow = store.saveFlow(tenant.id, 'ivr_sess_1', '测试流程', sampleGraph);
  store.publishFlow(tenant.id, flow.id);
  return { db, tenantId: tenant.id, flowId: flow.id };
}

test('POST /api/ivr/sessions creates session and returns first prompt', async () => {
  const { db, tenantId, flowId } = setup();
  const result = await routeIvrApi(
    db,
    'POST',
    '/api/ivr/sessions',
    new URL('http://localhost/api/ivr/sessions'),
    { callSessionId: 'call-sess-1', flowId },
    authHeaders(tenantId)
  ) as { data: { session: { prompt: string; action: { kind: string } }; rwi: { command: string } | null } };

  assert.ok(result.data.session.prompt.includes('欢迎') || result.data.session.prompt.includes('按1'));
  assert.equal(result.data.session.action.kind, 'menu');
  assert.equal(result.data.rwi?.command, 'gather_digits');
});

test('POST /api/ivr/sessions/:id/advance handles DTMF and reaches transfer', async () => {
  const { db, tenantId, flowId } = setup();
  await routeIvrApi(
    db,
    'POST',
    '/api/ivr/sessions',
    new URL('http://localhost/api/ivr/sessions'),
    { callSessionId: 'call-sess-2', flowId },
    authHeaders(tenantId)
  );

  const advanced = await routeIvrApi(
    db,
    'POST',
    '/api/ivr/sessions/call-sess-2/advance',
    new URL('http://localhost/api/ivr/sessions/call-sess-2/advance'),
    { dtmf: '1' },
    authHeaders(tenantId)
  ) as { data: { action: { kind: string; targetValue?: string }; terminated: boolean; rwi: { command: string } | null } };

  assert.equal(advanced.data.action.kind, 'transfer');
  assert.equal(advanced.data.action.targetValue, 'sales');
  assert.equal(advanced.data.rwi?.command, 'transfer');
  assert.equal(advanced.data.terminated, true);
});

test('GET /api/ivr/sessions/:id returns stored session', async () => {
  const { db, tenantId, flowId } = setup();
  await routeIvrApi(
    db,
    'POST',
    '/api/ivr/sessions',
    new URL('http://localhost/api/ivr/sessions'),
    { callSessionId: 'call-sess-3', flowId },
    authHeaders(tenantId)
  );

  const got = await routeIvrApi(
    db,
    'GET',
    '/api/ivr/sessions/call-sess-3',
    new URL('http://localhost/api/ivr/sessions/call-sess-3'),
    null,
    authHeaders(tenantId)
  ) as { data: { currentNodeId: string | null; stepCount: number } };

  assert.equal(got.data.currentNodeId, 'menu1');
  assert.ok(got.data.stepCount >= 1);
});
