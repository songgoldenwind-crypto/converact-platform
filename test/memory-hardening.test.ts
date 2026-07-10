import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, one, run } from '../src/db.js';
import { createTenant } from '../src/services.js';
import { MemoryStore } from '../src/agent-runtime/memory/memory-store.js';
import { MemoryMaintenance } from '../src/agent-runtime/memory/memory-maintenance.js';

test('cache invalidation: updateStatus invalidates buildPack cache', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db, null, 5000);

  const mem = store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'visible fact', confidence: 0.8 });
  const before = store.buildPack({ tenantId: tenant.id });
  assert.equal(before.facts.length, 1);

  store.updateStatus(tenant.id, mem?.id as string, 'archived');
  const after = store.buildPack({ tenantId: tenant.id });

  assert.equal(after.facts.length, 0, 'archived memory should disappear after cache invalidation');
});

test('cache invalidation: updateImportance invalidates buildPack cache ordering', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db, null, 5000);

  const low = store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'low', confidence: 0.8, importance_score: 0.1 });
  const high = store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'high', confidence: 0.8, importance_score: 0.9 });

  const before = store.buildPack({ tenantId: tenant.id });
  assert.equal(before.facts[0].content, 'high');

  store.updateImportance(tenant.id, low?.id as string, 1.0);
  const after = store.buildPack({ tenantId: tenant.id });

  assert.equal(after.facts[0].content, 'low', 'importance update should affect cached order');
});

test('cache invalidation: supersede invalidates buildPack cache', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db, null, 5000);

  const oldMem = store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'old fact', confidence: 0.8 });
  const newMem = store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'new fact', confidence: 0.9 });

  const before = store.buildPack({ tenantId: tenant.id });
  assert.equal(before.facts.length, 2);

  store.supersede(tenant.id, oldMem?.id as string, newMem?.id as string);
  const after = store.buildPack({ tenantId: tenant.id });

  assert.equal(after.facts.length, 1, 'superseded memory should disappear after cache invalidation');
  assert.equal(after.facts[0].content, 'new fact');
});

test('maintenance guard: concurrent same-tenant run is skipped', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const modelGateway = {
    complete: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { output: { text: 'summary' } };
    }
  };
  const maintenance = new MemoryMaintenance(db, store, { enableLlmSummarize: true, modelGateway });

  for (let i = 0; i < 3; i++) {
    store.write({
      tenant_id: tenant.id,
      memory_type: 'fact',
      content: `fact ${i}`,
      entity_key: 'lead:1',
      fact_key: `fact:${i}`,
      confidence: 0.8
    });
  }

  const [first, second] = await Promise.all([
    maintenance.runMaintenanceCycle(tenant.id),
    maintenance.runMaintenanceCycle(tenant.id)
  ]);

  assert.ok(first.skipped || second.skipped, 'one concurrent run should be skipped');
  assert.notEqual(Boolean(first.skipped), Boolean(second.skipped), 'only one run should be skipped');
});

test('parameterized batch update handles quoted memory ids', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, store);

  run(db,
    `INSERT INTO memory_entries (id, tenant_id, scope_type, scope_id, memory_type, content, status, effective_known_at, importance_score, protected, summary_parent_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`mem_quote_'_id`, tenant.id, 'tenant', '', 'fact', 'quoted id memory', 'active', new Date().toISOString(), 0.5, 0, '', '{}']
  );

  run(db,
    `INSERT INTO memory_recall_logs (tenant_id, memory_id) VALUES (?, ?)`,
    [tenant.id, `mem_quote_'_id`]
  );

  const result = await maintenance.runMaintenanceCycle(tenant.id);
  assert.equal(result.recallLogsConsumed, 1);

  const row = one(db, `SELECT recall_count FROM memory_entries WHERE id = ?`, [`mem_quote_'_id`]);
  assert.equal(row.recall_count, 1, 'quoted id should update safely');
});
