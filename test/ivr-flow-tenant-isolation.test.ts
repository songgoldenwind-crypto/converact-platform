/**
 * saveFlow must not overwrite another tenant's flow by id alone.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
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

test('saveFlow refuses to overwrite a flow owned by another tenant', () => {
  const db = createDatabase(':memory:');
  const tenantA = createTenant(db, { name: 'Tenant A' });
  const tenantB = createTenant(db, { name: 'Tenant B' });
  const store = new IvrFlowStore(db);
  const flowId = 'shared_looking_id';

  store.saveFlow(tenantA.id, flowId, 'A flow', minimalGraph('owner-a'));

  assert.throws(
    () => store.saveFlow(tenantB.id, flowId, 'B hijack', minimalGraph('hijack')),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /another tenant|tenant/i);
      assert.equal((err as { status?: number }).status, 403);
      return true;
    }
  );

  const stillA = store.getFlow(tenantA.id, flowId);
  assert.ok(stillA);
  assert.equal(stillA.name, 'A flow');
  assert.equal(stillA.graph.nodes[0]?.name, 'owner-a');
  assert.equal(store.getFlow(tenantB.id, flowId), null);
});

test('saveFlow updates when same tenant owns the flow', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Same Tenant' });
  const store = new IvrFlowStore(db);
  const flowId = 'own_flow';

  store.saveFlow(tenant.id, flowId, 'v1', minimalGraph('one'));
  const updated = store.saveFlow(tenant.id, flowId, 'v2', minimalGraph('two'));
  assert.equal(updated.name, 'v2');
  assert.equal(updated.graph.nodes[0]?.name, 'two');
  assert.equal(updated.version, 2);
});
