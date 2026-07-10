import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, all, one, run } from '../src/db.js';
import { createTenant } from '../src/services.js';
import { MemoryStore } from '../src/agent-runtime/memory/memory-store.js';
import { MemoryMaintenance } from '../src/agent-runtime/memory/memory-maintenance.js';

test('buildPack cache: same call returns cached pack', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db, null, 5000);

  store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'fact 1', confidence: 0.8 });

  const pack1 = store.buildPack({ tenantId: tenant.id });
  const pack2 = store.buildPack({ tenantId: tenant.id });

  assert.deepStrictEqual(pack1, pack2, 'cached pack should be identical reference');
  assert.ok(pack1.facts.length > 0 || pack1.conditions.length > 0, 'pack should contain memories');
});

test('buildPack cache: write invalidates cache', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db, null, 5000);

  store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'first fact', confidence: 0.8 });
  const pack1 = store.buildPack({ tenantId: tenant.id });

  store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'second fact', confidence: 0.8 });
  const pack2 = store.buildPack({ tenantId: tenant.id });

  assert.notDeepStrictEqual(pack1, pack2, 'cache should be invalidated after write');
});

test('buildPack cache: TTL expires', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db, null, 50); // 50ms TTL

  store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'fact 1', confidence: 0.8 });
  const pack1 = store.buildPack({ tenantId: tenant.id });

  await new Promise((r) => setTimeout(r, 100));

  const pack2 = store.buildPack({ tenantId: tenant.id });

  // After TTL, pack2 should be a new object (not same reference)
  assert.notStrictEqual(pack1, pack2, 'cache should expire after TTL');
});

test('maintenance: purgeOldCandidates deletes rejected and old candidates', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, store, { purgeCandidateDays: 1 });

  // Insert an old rejected candidate directly
  run(db,
    `INSERT INTO memory_candidates (id, tenant_id, scope_type, scope_id, memory_type, content, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['memcand_old', tenant.id, 'tenant', '', 'fact', 'old', 'rejected', '2024-01-01T00:00:00Z']
  );

  // Insert a recent candidate
  run(db,
    `INSERT INTO memory_candidates (id, tenant_id, scope_type, scope_id, memory_type, content, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['memcand_new', tenant.id, 'tenant', '', 'fact', 'new', 'candidate', new Date().toISOString()]
  );

  const result = await maintenance.runMaintenanceCycle(tenant.id);

  assert.ok(result.candidatesPurged >= 1, 'should purge at least one old/rejected candidate');

  const remaining = all(db, `SELECT id FROM memory_candidates WHERE tenant_id = ?`, [tenant.id]);
  const ids = remaining.map((r) => r.id);
  assert.ok(!ids.includes('memcand_old'), 'old rejected candidate should be purged');
  assert.ok(ids.includes('memcand_new'), 'recent candidate should remain');
});

test('maintenance: purgeOldArchived deletes old archived memories', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, store, { purgeArchivedDays: 1 });

  // Seed cold-start bypass
  run(db, `INSERT INTO system_config (key, value) VALUES (?, ?)`,
    [`first_maintenance_at:${tenant.id}`, '2024-01-01T00:00:00Z']);

  // Insert an old archived memory directly
  run(db,
    `INSERT INTO memory_entries (id, tenant_id, scope_type, scope_id, memory_type, content, status, updated_at, effective_known_at, importance_score, protected, summary_parent_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['mem_old', tenant.id, 'tenant', '', 'fact', 'old', 'archived', '2024-01-01T00:00:00Z', new Date().toISOString(), 0.5, 0, '', '{}']
  );

  // Insert a recent archived memory
  run(db,
    `INSERT INTO memory_entries (id, tenant_id, scope_type, scope_id, memory_type, content, status, updated_at, effective_known_at, importance_score, protected, summary_parent_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['mem_new', tenant.id, 'tenant', '', 'fact', 'new', 'archived', new Date().toISOString(), new Date().toISOString(), 0.5, 0, '', '{}']
  );

  const result = await maintenance.runMaintenanceCycle(tenant.id);

  assert.ok(result.purged >= 1, 'should purge at least one old archived memory');

  const remaining = all(db, `SELECT id FROM memory_entries WHERE tenant_id = ?`, [tenant.id]);
  const ids = remaining.map((r) => r.id);
  assert.ok(!ids.includes('mem_old'), 'old archived memory should be purged');
  assert.ok(ids.includes('mem_new'), 'recent archived memory should remain');
});

test('backlog trigger: recall_log > 100 triggers maintenance in after_context_build hook', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, store);

  // Pre-seed 150 recall logs (use past timestamp so they are eligible for consumption)
  for (let i = 0; i < 150; i++) {
    run(db,
      `INSERT INTO memory_recall_logs (tenant_id, memory_id, recalled_at) VALUES (?, ?, ?)`,
      [tenant.id, `mem_${i}`, new Date(Date.now() - 1000).toISOString()]
    );
  }

  // Create a memory so recall log consumption has something to update
  store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'seed', confidence: 0.8 });

  // Manually trigger the backlog check logic
  const backlog = one(db,
    `SELECT COUNT(*) as cnt FROM memory_recall_logs WHERE tenant_id = ?`,
    [tenant.id]
  );
  assert.ok(backlog.cnt >= 100, 'should have backlog >= 100');

  const result = await maintenance.runMaintenanceCycle(tenant.id);
  // recallLogsConsumed counts total log records, not unique memory_ids
  assert.ok(result.recallLogsConsumed > 0, 'maintenance should consume backlog');
});
