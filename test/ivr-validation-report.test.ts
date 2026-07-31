import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import { routeIvrApi } from '../src/agent-runtime/ivr/ivr-http.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { withCompleteMenuEdges } from './helpers/ivr-complete-menu-graph.js';

const API_KEY = 'test-ivr-validation-report-key';
const authHeaders = (tenantId: string) => ({ 'X-API-Key': API_KEY, 'X-Tenant-Id': tenantId });

const incompleteMenuGraph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
    {
      id: 'menu1',
      type: 'menu',
      name: 'M',
      position: { x: 200, y: 0 },
      data: {
        prompt: [{ playType: 'tts', text: 'press 1' }],
        options: [{ digit: '1', label: 'one', routeType: 'node', routeTarget: '' }],
      },
    },
    { id: 't1', type: 'transfer', name: 'T', position: { x: 400, y: 0 }, data: { targetType: 'queue', targetValue: 'q' } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'menu1', sourceHandle: 'out' },
    { id: 'e2', source: 'menu1', target: 't1', sourceHandle: 'digit_1' },
  ],
  variables: [],
};

function setup() {
  process.env.OPC_API_KEY = API_KEY;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Validation Report Test' });
  const store = new IvrFlowStore(db);
  const incomplete = store.saveFlow(tenant.id, 'ivr_rep_1', 'incomplete', incompleteMenuGraph);
  const complete = store.saveFlow(
    tenant.id,
    'ivr_rep_2',
    'complete',
    withCompleteMenuEdges(incompleteMenuGraph, 'menu1')
  );
  store.publishFlow(tenant.id, complete.id);
  return { db, tenantId: tenant.id, incompleteId: incomplete.id, completeId: complete.id };
}

test('GET validation-report lists all flows with publishBlocked flags', async () => {
  const { db, tenantId } = setup();
  const result = (await routeIvrApi(
    db,
    'GET',
    '/api/ivr/flows/validation-report',
    new URL('http://localhost/api/ivr/flows/validation-report'),
    {},
    authHeaders(tenantId)
  )) as {
    data: {
      flows: Array<{ id: string; publishBlocked: boolean }>;
      summary: { total: number; publishBlocked: number; needsRepair: number };
    };
  };

  assert.equal(result.data.summary.total, 2);
  assert.equal(result.data.summary.publishBlocked, 1);
  assert.equal(result.data.summary.needsRepair, 0);
  const incomplete = result.data.flows.find((f) => f.id === 'ivr_rep_1');
  assert.equal(incomplete?.publishBlocked, true);
});

test('GET validation-report?flowId= returns single flow entry', async () => {
  const { db, tenantId, completeId } = setup();
  const result = (await routeIvrApi(
    db,
    'GET',
    '/api/ivr/flows/validation-report',
    new URL(`http://localhost/api/ivr/flows/validation-report?flowId=${completeId}`),
    {},
    authHeaders(tenantId)
  )) as { data: { id: string; valid: boolean; publishBlocked: boolean } };

  assert.equal(result.data.id, completeId);
  assert.equal(result.data.valid, true);
  assert.equal(result.data.publishBlocked, false);
});

test('POST /api/ivr/flows/validate returns save/publish blocked flags', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Validate API Test' });

  const result = (await routeIvrApi(
    db,
    'POST',
    '/api/ivr/flows/validate',
    new URL('http://localhost/api/ivr/flows/validate'),
    { graph: incompleteMenuGraph },
    authHeaders(tenant.id)
  )) as { data: { publishBlocked: boolean; warnings: unknown[] } };

  assert.equal(result.data.publishBlocked, true);
  assert.ok(result.data.warnings.length > 0);
});

test('POST complete-missing-edges patches menu handles', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Complete Edges Test' });

  const result = (await routeIvrApi(
    db,
    'POST',
    '/api/ivr/flows/complete-missing-edges',
    new URL('http://localhost/api/ivr/flows/complete-missing-edges'),
    { graph: incompleteMenuGraph },
    authHeaders(tenant.id)
  )) as {
    data: {
      applied: Array<{ nodeId: string; handles: string[] }>;
      validation: { valid: boolean; warnings: unknown[] };
    };
  };

  assert.deepEqual(result.data.applied, [
    { nodeId: 'menu1', handles: ['timeout', 'invalid', 'max_retries'] },
  ]);
  assert.equal(result.data.validation.valid, true);
  assert.equal(result.data.validation.warnings.length, 0);
});
