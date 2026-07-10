/**
 * H6 — flow history rows use unique ids (no version PK collision on rollback).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, all } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function minimalGraph(label: string): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    nodes: [
      {
        id: 'p1',
        type: 'play',
        name: label,
        position: { x: 0, y: 0 },
        data: { contents: [{ playType: 'tts', text: label }] },
      },
    ],
    edges: [],
  };
}

test('saveFlow history: rollback re-save uses unique history ids (no PK collision)', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'History PK' });
  const store = new IvrFlowStore(db);
  const flowId = 'flow_hist_test';

  store.saveFlow(tenant.id, flowId, 'v1', minimalGraph('one'));
  store.saveFlow(tenant.id, flowId, 'v2', minimalGraph('two'));
  const rolled = store.rollbackFlow(tenant.id, flowId, 1);
  assert.ok(rolled);
  store.saveFlow(tenant.id, flowId, 'v2 again', minimalGraph('three'));

  const ids = all(db, 'SELECT id FROM ivr_flow_history WHERE flow_id = ?', [flowId]).map(
    (r) => r.id as string
  );
  assert.ok(ids.length >= 2);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.includes('_h_')));

  const listed = store.listFlowHistory(tenant.id, flowId);
  assert.equal(listed.length, new Set(listed.map((h) => h.version)).size);
});
