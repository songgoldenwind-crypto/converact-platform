/**
 * IvrSessionStore.upsert must not allow cross-tenant overwrite by call_session_id.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrSessionStore } from '../src/agent-runtime/ivr/ivr-session-store.js';
import type { IvrRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';

function emptyCtx(): IvrRuntimeContext {
  return {
    graph: { version: 1, entryNodeId: 's', nodes: [], edges: [], variables: [] },
    currentNodeId: 's',
    variables: {},
    flowStack: [],
  };
}

test('upsert refuses to overwrite session owned by another tenant', () => {
  const db = createDatabase(':memory:');
  const tenantA = createTenant(db, { name: 'Sess A' });
  const tenantB = createTenant(db, { name: 'Sess B' });
  const store = new IvrSessionStore(db);
  const callSessionId = 'call_shared';

  store.upsert({
    callSessionId,
    tenantId: tenantA.id,
    flowId: 'flow-a',
    context: emptyCtx(),
    stepCount: 1,
    terminated: false,
  });

  assert.throws(
    () =>
      store.upsert({
        callSessionId,
        tenantId: tenantB.id,
        flowId: 'flow-b',
        context: emptyCtx(),
        stepCount: 99,
        terminated: true,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /tenant/i);
      assert.equal((err as { status?: number }).status, 409);
      return true;
    }
  );

  const stillA = store.get(callSessionId, tenantA.id);
  assert.ok(stillA);
  assert.equal(stillA.flow_id, 'flow-a');
  assert.equal(stillA.step_count, 1);
  assert.equal(store.get(callSessionId, tenantB.id), null);
});
