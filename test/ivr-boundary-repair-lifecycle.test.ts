/**
 * P0 — needs_repair 标记、修复后清除、入站恢复。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import { refreshFlowRepairStatuses } from '../src/agent-runtime/ivr/ivr-flow-repair-status.js';
import { withCompleteMenuEdges } from '../src/agent-runtime/ivr/ivr-complete-menu-edges.js';
import { startIvrSession } from '../src/agent-runtime/ivr/ivr-inbound-routing.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const incompleteGraph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  variables: [],
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
};

test('refreshFlowRepairStatuses clears needs_repair after graph is repaired', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Repair Clear Test' });
  const store = new IvrFlowStore(db);
  const flow = store.saveFlow(tenant.id, 'ivr_repair_clear', 'bad', incompleteGraph);
  store.publishFlow(tenant.id, flow.id);

  const marked = refreshFlowRepairStatuses(store, tenant.id);
  assert.equal(marked.marked, 1);
  assert.equal(store.getFlow(tenant.id, flow.id)?.status, 'needs_repair');

  const repaired = withCompleteMenuEdges(incompleteGraph, 'menu1');
  store.saveFlow(tenant.id, flow.id, 'fixed', repaired);

  const cleared = refreshFlowRepairStatuses(store, tenant.id);
  assert.equal(cleared.cleared, 1);
  assert.equal(cleared.marked, 0);
  assert.equal(store.getFlow(tenant.id, flow.id)?.status, 'published');
});

test('startIvrSession works after needs_repair flow is repaired and cleared', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Repair Session Recovery' });
  const store = new IvrFlowStore(db);
  const flow = store.saveFlow(tenant.id, 'ivr_repair_sess', 'bad', incompleteGraph);
  store.publishFlow(tenant.id, flow.id);
  refreshFlowRepairStatuses(store, tenant.id);
  assert.equal(store.getFlow(tenant.id, flow.id)?.status, 'needs_repair');
  assert.equal(startIvrSession(db, tenant.id, 'call-blocked', flow.id), null);

  const repaired = withCompleteMenuEdges(incompleteGraph, 'menu1');
  store.saveFlow(tenant.id, flow.id, 'fixed', repaired);
  refreshFlowRepairStatuses(store, tenant.id);
  assert.equal(store.getFlow(tenant.id, flow.id)?.status, 'published');

  const session = startIvrSession(db, tenant.id, 'call-ok', flow.id);
  assert.ok(session);
  assert.equal(session!.flowId, flow.id);
  assert.equal(session!.terminated, false);
});

test('draft flows are not marked needs_repair even when invalid', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Draft Skip Repair' });
  const store = new IvrFlowStore(db);
  store.saveFlow(tenant.id, 'ivr_draft_bad', 'draft bad', incompleteGraph);

  const result = refreshFlowRepairStatuses(store, tenant.id);
  assert.equal(result.marked, 0);
  assert.equal(store.getFlow(tenant.id, 'ivr_draft_bad')?.status, 'draft');
});
