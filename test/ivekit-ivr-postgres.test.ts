import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';

import { withPgTenant } from '../src/db-pg-tenant.js';
import {
  IvrFlowService,
  PostgresIvrFlowStore,
  PostgresIvrFlowUnitOfWork,
  type IvrFlowGraph
} from '../src/agent-runtime/ivekit/ivr/index.js';

const url = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL;

test('PostgreSQL IVR flow store publishes, replays, rolls back, isolates, and preserves history', {
  skip: url ? false : 'requires OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL'
}, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantA = 'ivekit_ivr_runtime_a';
  const tenantB = 'ivekit_ivr_runtime_b';
  try {
    const adminUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL!;
    const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(`INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING`,
        [tenantA, 'IVR runtime A', tenantB, 'IVR runtime B']);
    } finally {
      await admin.end();
    }

    let id = 0;
    const service = new IvrFlowService({
      unit_of_work: new PostgresIvrFlowUnitOfWork(pool),
      id: (kind) => `${kind}-pg-${++id}`,
      now: () => new Date(`2026-07-13T00:00:0${Math.min(id, 9)}.000Z`)
    });
    const flow = await service.createFlow({ tenant_id: tenantA, actor: 'admin-a', name: 'Main', graph: graph('V1') });
    const first = await service.publish({ tenant_id: tenantA, actor: 'admin-a', flow_id: flow.id,
      expected_draft_revision: 1, idempotency_key: 'postgres-publish-v1' });
    const replay = await service.publish({ tenant_id: tenantA, actor: 'admin-a', flow_id: flow.id,
      expected_draft_revision: 1, idempotency_key: 'postgres-publish-v1' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.version.id, first.version.id);

    await service.updateDraft({ tenant_id: tenantA, actor: 'admin-a', flow_id: flow.id,
      expected_revision: 1, graph: graph('V2') });
    await service.publish({ tenant_id: tenantA, actor: 'admin-a', flow_id: flow.id,
      expected_draft_revision: 2, idempotency_key: 'postgres-publish-v2' });
    const rolledBack = await service.rollback({ tenant_id: tenantA, actor: 'admin-b', flow_id: flow.id,
      expected_draft_revision: 2, source_version: 1, idempotency_key: 'postgres-rollback-v1' });
    assert.equal(rolledBack.version.version, 3);
    assert.equal(rolledBack.version.graph_hash, first.version.graph_hash);

    const store = new PostgresIvrFlowStore(pool);
    assert.equal((await store.listVersions(tenantA, flow.id)).length, 3);
    assert.equal(await store.getFlow(tenantB, flow.id), null);
    await assert.rejects(
      () => withPgTenant(pool, tenantA, (client) => client.query(
        `UPDATE ivekit_ivr_flow_versions SET graph = '{}'::jsonb WHERE id = $1`,
        [first.version.id]
      )),
      /immutable/i
    );
  } finally {
    await pool.end();
  }
});

function graph(text: string): IvrFlowGraph {
  return {
    version: 1, entryNodeId: 'start', variables: [],
    nodes: [
      { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
      { id: 'play', type: 'play', name: 'Play', position: { x: 1, y: 0 }, data: { text } },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 2, y: 0 }, data: {} }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'play', sourceHandle: 'out' },
      { id: 'e2', source: 'play', target: 'end', sourceHandle: 'out' }
    ]
  };
}
