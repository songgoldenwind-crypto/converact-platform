import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/db.js';
import { PgSyncDatabase } from '../src/db-pg-sync.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const MIN_GRAPH: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  variables: [],
  nodes: [
    { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
    {
      id: 'm1',
      type: 'menu',
      name: 'Menu',
      position: { x: 100, y: 0 },
      data: {
        prompt: [{ playType: 'tts', text: 'press 1' }],
        options: [{ digit: '1', label: 'a', routeType: 'node', routeTarget: 't1' }],
      },
    },
    {
      id: 't1',
      type: 'transfer',
      name: 'T',
      position: { x: 200, y: 0 },
      data: { targetType: 'queue', targetValue: 'sales' },
    },
  ],
  edges: [
    { id: 'e0', source: 'start', target: 'm1', sourceHandle: 'out' },
    { id: 'e1', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
  ],
};

test('PG voice_agent_specs accepts needs_repair status', () => {
  if (!process.env.DATABASE_URL && !process.env.PG_TEST_URL) return;

  const pgDb = new PgSyncDatabase();
  const store = new IvrFlowStore(pgDb);
  const tenantId = `tenant_nr_${Date.now()}`;
  const flowId = `flow_nr_${Date.now()}`;

  try {
    store.saveFlow(tenantId, flowId, 'needs-repair probe', MIN_GRAPH);
    store.publishFlow(tenantId, flowId);
    store.setFlowStatus(tenantId, flowId, 'needs_repair');

    const flow = store.getFlow(tenantId, flowId);
    assert.equal(flow?.status, 'needs_repair');
  } finally {
    try {
      run(pgDb, 'DELETE FROM voice_agent_specs WHERE id = ?', [flowId]);
    } catch {
      /* best-effort */
    }
    pgDb.close();
  }
});
