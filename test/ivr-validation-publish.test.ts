import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import { routeIvrApi } from '../src/agent-runtime/ivr/ivr-http.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { withCompleteMenuEdges } from './helpers/ivr-complete-menu-graph.js';

const API_KEY = 'test-ivr-validation-key';
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

afterEach(() => {
  delete process.env.IVR_STRICT_VALIDATE;
});

test('publish blocks incomplete menu graph (warnings treated as errors)', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Validation Test' });
  const store = new IvrFlowStore(db);
  const flow = store.saveFlow(tenant.id, 'ivr_val_1', 'draft', incompleteMenuGraph);

  const result = (await routeIvrApi(
    db,
    'POST',
    `/api/ivr/flows/${flow.id}/publish`,
    new URL(`http://localhost/api/ivr/flows/${flow.id}/publish`),
    {},
    authHeaders(tenant.id)
  )) as { status: number; data: { error?: string; warnings?: unknown[] } };

  assert.equal(result.status, 400);
  assert.equal(result.data.error, 'validation failed');
  assert.ok((result.data.warnings?.length ?? 0) > 0);
});

test('publish succeeds when menu has required edges', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Validation Test 2' });
  const store = new IvrFlowStore(db);
  const graph = withCompleteMenuEdges(incompleteMenuGraph, 'menu1');
  const flow = store.saveFlow(tenant.id, 'ivr_val_2', 'complete', graph);

  const result = (await routeIvrApi(
    db,
    'POST',
    `/api/ivr/flows/${flow.id}/publish`,
    new URL(`http://localhost/api/ivr/flows/${flow.id}/publish`),
    {},
    authHeaders(tenant.id)
  )) as { data: { status?: string } };

  assert.equal((result as { status?: number }).status, undefined);
  assert.equal(store.getFlow(tenant.id, flow.id)?.status, 'published');
});

test('save allows warnings when IVR_STRICT_VALIDATE=warn (default)', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Validation Test 3' });

  const result = (await routeIvrApi(
    db,
    'POST',
    '/api/ivr/flows',
    new URL('http://localhost/api/ivr/flows'),
    { id: 'ivr_val_3', name: 'warn ok', graph: incompleteMenuGraph },
    authHeaders(tenant.id)
  )) as { status?: number; data: { id?: string; validation?: { warnings?: unknown[] } } };

  assert.equal(result.status, undefined);
  assert.equal(result.data.id, 'ivr_val_3');
  assert.ok((result.data.validation?.warnings?.length ?? 0) > 0);
});

test('save blocks warnings when IVR_STRICT_VALIDATE=block', async () => {
  process.env.OPC_API_KEY = API_KEY;
  process.env.IVR_STRICT_VALIDATE = 'block';
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Validation Test 4' });

  const result = (await routeIvrApi(
    db,
    'POST',
    '/api/ivr/flows',
    new URL('http://localhost/api/ivr/flows'),
    { id: 'ivr_val_4', name: 'block', graph: incompleteMenuGraph },
    authHeaders(tenant.id)
  )) as { status: number; data: { error?: string } };

  assert.equal(result.status, 400);
  assert.equal(result.data.error, 'validation failed');
});
