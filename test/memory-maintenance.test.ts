import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, all, one, run } from '../src/db.js';
import { MemoryStore } from '../src/agent-runtime/memory/memory-store.js';
import { MemoryMaintenance } from '../src/agent-runtime/memory/memory-maintenance.js';
import { createTenant } from '../src/services.js';

test('memory maintenance: archive stale memories', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const memoryStore = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, memoryStore);

  // Create a very old, low-importance memory
  const oldMem = memoryStore.write({
    tenant_id: tenant.id,
    memory_type: 'fact',
    content: 'old fact',
    confidence: 0.3,
    effective_known_at: new Date(Date.now() - 365 * 86_400_000).toISOString()
  });

  // Create a protected memory (should not be archived)
  const protectedMem = memoryStore.write({
    tenant_id: tenant.id,
    memory_type: 'preference',
    content: 'protected preference',
    confidence: 0.3,
    effective_known_at: new Date(Date.now() - 365 * 86_400_000).toISOString()
  });

  // Run maintenance (skip cold-start by pre-seeding config)
  run(db, `INSERT INTO system_config (key, value) VALUES (?, ?)`,
    [`first_maintenance_at:${tenant.id}`, new Date(Date.now() - 30 * 86_400_000).toISOString()]);

  const result = await maintenance.runMaintenanceCycle(tenant.id);

  assert.ok(result.archived >= 1, 'should archive at least one stale memory');
  assert.equal(result.consolidated, 0, 'no consolidation with only 2 memories');

  const archivedOld = one(db, `SELECT status FROM memory_entries WHERE id = ?`, [oldMem?.id]);
  assert.equal(archivedOld.status, 'archived', 'old unprotected memory should be archived');

  const stillActive = one(db, `SELECT status FROM memory_entries WHERE id = ?`, [protectedMem?.id]);
  assert.equal(stillActive.status, 'active', 'protected memory should stay active');
});

test('memory maintenance: importance_score refresh', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const memoryStore = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, memoryStore);

  const mem = memoryStore.write({
    tenant_id: tenant.id,
    memory_type: 'fact',
    content: 'test fact with durable detail',
    confidence: 0.9
  });

  // Simulate recall by directly updating recall_count
  run(db, `UPDATE memory_entries SET recall_count = 10 WHERE id = ?`, [mem?.id]);

  // Run maintenance
  run(db, `INSERT INTO system_config (key, value) VALUES (?, ?)`,
    [`first_maintenance_at:${tenant.id}`, new Date(Date.now() - 30 * 86_400_000).toISOString()]);

  const result = await maintenance.runMaintenanceCycle(tenant.id);

  assert.ok(result.importanceRefreshed >= 1, 'should refresh importance scores');

  const updated = one(db, `SELECT importance_score FROM memory_entries WHERE id = ?`, [mem?.id]);
  assert.ok(updated.importance_score > 0.5, 'importance should increase after recalls');
});

test('memory maintenance: recall_log batch consumption', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const memoryStore = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, memoryStore);

  const mem = memoryStore.write({
    tenant_id: tenant.id,
    memory_type: 'fact',
    content: 'test fact'
  });

  // Insert recall logs
  for (let i = 0; i < 5; i++) {
    run(db, `INSERT INTO memory_recall_logs (tenant_id, memory_id) VALUES (?, ?)`,
      [tenant.id, mem?.id]);
  }

  // Run maintenance
  run(db, `INSERT INTO system_config (key, value) VALUES (?, ?)`,
    [`first_maintenance_at:${tenant.id}`, new Date(Date.now() - 30 * 86_400_000).toISOString()]);

  const result = await maintenance.runMaintenanceCycle(tenant.id);

  assert.equal(result.recallLogsConsumed, 5, 'should consume all 5 recall logs');

  const updated = one(db, `SELECT recall_count FROM memory_entries WHERE id = ?`, [mem?.id]);
  assert.equal(updated.recall_count, 5, 'recall_count should be 5 after batch consumption');

  const remainingLogs = one(db, `SELECT COUNT(*) as cnt FROM memory_recall_logs WHERE tenant_id = ?`, [tenant.id]);
  assert.equal(remainingLogs.cnt, 0, 'all recall logs should be deleted after consumption');
});

test('memory maintenance: cold start protection', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const memoryStore = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, memoryStore);

  const oldMem = memoryStore.write({
    tenant_id: tenant.id,
    memory_type: 'fact',
    content: 'old fact',
    confidence: 0.3,
    effective_known_at: new Date(Date.now() - 365 * 86_400_000).toISOString()
  });

  // Do NOT seed system_config — first run should be in cold-start
  const result = await maintenance.runMaintenanceCycle(tenant.id);

  assert.equal(result.archived, 0, 'should NOT archive during cold-start');
  assert.equal(result.importanceRefreshed, 1, 'should still refresh importance');

  const stillActive = one(db, `SELECT status FROM memory_entries WHERE id = ?`, [oldMem?.id]);
  assert.equal(stillActive.status, 'active', 'memory should stay active during cold-start');
});
