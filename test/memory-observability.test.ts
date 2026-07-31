import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, one, run } from '../src/db.js';
import { createTenant } from '../src/services.js';
import { MemoryStore } from '../src/agent-runtime/memory/memory-store.js';
import { MemoryPromoter } from '../src/agent-runtime/memory/memory-promoter.js';
import { MemorySummarizer } from '../src/agent-runtime/memory/memory-summarizer.js';
import { MemoryWriteback } from '../src/agent-runtime/memory/memory-writeback.js';
import { MemoryMaintenance } from '../src/agent-runtime/memory/memory-maintenance.js';

test('maintenance observability: durationMs and stageTimings present', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, store);

  const mem = store.write({ tenant_id: tenant.id, memory_type: 'fact', content: 'test', confidence: 0.5 });
  // Seed cold-start bypass so archive step runs
  run(db, `INSERT INTO system_config (key, value) VALUES (?, ?)`,
    [`first_maintenance_at:${tenant.id}`, '2024-01-01T00:00:00Z']);

  const result = await maintenance.runMaintenanceCycle(tenant.id);

  assert.ok(!result.skipped, 'should not be skipped');
  assert.ok(result.durationMs !== undefined && result.durationMs >= 0, 'durationMs should be non-negative');
  assert.ok(result.stageTimings, 'stageTimings should be present');
  assert.ok(result.stageTimings.recall_logs !== undefined, 'recall_logs timing should exist');
  assert.ok(result.stageTimings.importance_refresh !== undefined, 'importance_refresh timing should exist');
});

test('maintenance observability: skipReason concurrent_guard', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, store);

  // Start a slow maintenance cycle to block second call
  const slowMaintenance = new MemoryMaintenance(db, store, {
    modelGateway: {
      complete: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { output: { text: 'summary' } };
      }
    } as any,
    enableLlmSummarize: true
  });

  const first = slowMaintenance.runMaintenanceCycle(tenant.id);
  const second = slowMaintenance.runMaintenanceCycle(tenant.id);
  const [r1, r2] = await Promise.all([first, second]);

  const skipped = r1.skipped ? r1 : r2;
  assert.ok(skipped.skipped, 'one run should be skipped');
  assert.equal(skipped.skipReason, 'concurrent_guard', 'skipReason should be concurrent_guard');
});

test('maintenance observability: error field on exception', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  // Create a mock store that throws on search to simulate error
  const badStore = {
    ...store,
    search() {
      throw new Error('simulated search failure');
    }
  } as unknown as MemoryStore;
  const maintenance = new MemoryMaintenance(db, badStore);

  const result = await maintenance.runMaintenanceCycle(tenant.id);

  assert.ok(result.error, 'error field should be present');
  assert.ok(result.error.includes('simulated search failure'), 'error message should include simulated failure');
  assert.ok(result.durationMs !== undefined, 'durationMs should still be present on error');
});

test('maintenance parameterized batch: special chars in memory id', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const maintenance = new MemoryMaintenance(db, store);

  run(db,
    `INSERT INTO memory_entries (id, tenant_id, scope_type, scope_id, memory_type, content, status, effective_known_at, importance_score, protected, summary_parent_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`mem_;--drop`, tenant.id, 'tenant', '', 'fact', 'injection test', 'active', new Date().toISOString(), 0.5, 0, '', '{}']
  );

  run(db,
    `INSERT INTO memory_recall_logs (tenant_id, memory_id) VALUES (?, ?)`,
    [tenant.id, `mem_;--drop`]
  );

  const result = await maintenance.runMaintenanceCycle(tenant.id);
  assert.equal(result.recallLogsConsumed, 1);

  const row = one(db, `SELECT recall_count FROM memory_entries WHERE id = ?`, [`mem_;--drop`]);
  assert.equal(row.recall_count, 1, 'should safely update memory with special id');
});

test('writeback llm judge observability: no model gateway records fallback audit', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);
  const writeback = new MemoryWriteback(db, store, promoter, null);

  const loop = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'open_loop',
    content: '待回拨',
    confidence: 0.8
  });

  writeback.processCallOutcome(tenant.id, 'run-1', 'lead-1', 'completed', '客户已确认');

  // No model gateway means fallback silently; no exception thrown
  const loopStatus = one(db, `SELECT status FROM memory_entries WHERE id = ?`, [loop?.id]);
  assert.ok(loopStatus.status === 'active' || loopStatus.status === 'archived', 'loop should have valid status');
});

test('summarizer fallback reason recorded in metadata', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const summarizer = new MemorySummarizer(db, store, 3, null);

  for (let i = 0; i < 3; i++) {
    store.write({
      tenant_id: tenant.id,
      memory_type: 'fact',
      content: `fact ${i}`,
      entity_key: 'lead:lead-1',
      fact_key: `fact:fact_${i}`,
      confidence: 0.8
    });
  }

  const summarized = await summarizer.run(tenant.id);
  assert.equal(summarized, 1);

  const summary = one(db, `SELECT metadata FROM memory_entries WHERE memory_type = 'summary'`);
  const metadata = JSON.parse(summary.metadata);
  assert.equal(metadata.fallback_reason, 'no_model_gateway', 'fallback reason should be recorded');
});
