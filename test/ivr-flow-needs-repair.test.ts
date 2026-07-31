import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import { refreshFlowRepairStatuses } from '../src/agent-runtime/ivr/ivr-flow-repair-status.js';
import { startIvrSession } from '../src/agent-runtime/ivr/ivr-inbound-routing.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const incompleteGraph: IvrFlowGraph = {
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

test('refreshFlowRepairStatuses marks published invalid flows as needs_repair', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Repair Status Test' });
  const store = new IvrFlowStore(db);
  const flow = store.saveFlow(tenant.id, 'ivr_repair_1', 'bad', incompleteGraph);
  store.publishFlow(tenant.id, flow.id);

  const result = refreshFlowRepairStatuses(store, tenant.id);
  assert.equal(result.marked, 1);
  assert.equal(store.getFlow(tenant.id, flow.id)?.status, 'needs_repair');
});

test('startIvrSession rejects needs_repair flows', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Repair Session Test' });
  const store = new IvrFlowStore(db);
  const flow = store.saveFlow(tenant.id, 'ivr_repair_2', 'bad', incompleteGraph);
  store.publishFlow(tenant.id, flow.id);
  store.setFlowStatus(tenant.id, flow.id, 'needs_repair');

  assert.equal(startIvrSession(db, tenant.id, 'call-1'), null);
});
