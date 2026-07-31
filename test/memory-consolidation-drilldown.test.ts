import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, all, one, run } from '../src/db.js';
import { createTenant } from '../src/services.js';
import { MemoryStore, computeMemoryScore, computeRecencyScore, computeRelevanceScore } from '../src/agent-runtime/memory/memory-store.js';
import { MemoryConsolidator } from '../src/agent-runtime/memory/memory-consolidator.js';
import { MemorySummarizer } from '../src/agent-runtime/memory/memory-summarizer.js';

test('consolidator: exact dedupe + canonicalization', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const consolidator = new MemoryConsolidator(db, store);

  // Same entity_key + fact_key -> exact dedupe keeps highest confidence
  const m1 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是 ABC 公司',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:客户是_abc_公司',
    confidence: 0.8
  });
  const m2 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是 ABC 公司（重复）',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:客户是_abc_公司',
    confidence: 0.9
  });

  // Same entity + type -> will be grouped with exact-deduped m2
  const m3 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户偏好微信沟通',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:偏好微信沟通',
    confidence: 0.85
  });

  const consolidated = consolidator.run(tenant.id);

  // After exact dedupe: m2 survives (higher confidence), m1 dropped
  // Group by entity_key:memory_type -> lead:lead-1:fact has 2 entries (m2, m3)
  // -> canonicalization creates 1 group
  assert.equal(consolidated, 1, 'should create 1 consolidated group for entity lead:lead-1 + type fact');

  // m3 should be archived (lower importance_score default 0.5 vs m2 default 0.5,
  // tie broken by confidence: m2=0.9 > m3=0.85)
  const m3Status = one(db, `SELECT status FROM memory_entries WHERE id = ?`, [m3?.id]);
  assert.equal(m3Status.status, 'archived', 'lower-confidence entry should be archived as supporting');
});

test('consolidator: approximate dedupe + supporting archive', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const consolidator = new MemoryConsolidator(db, store);

  // High token overlap (>0.85) -> approximate dedupe
  const m1 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是 ABC 公司，位于北京',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:abc_公司_北京',
    confidence: 0.9,
    importance_score: 0.9
  });
  const m2 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是 ABC 公司，位于北京市',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:abc_公司_北京市',
    confidence: 0.85,
    importance_score: 0.5
  });

  // Same entity_key + memory_type -> canonicalization group
  const m3 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是 ABC 公司，位于北京朝阳区',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:abc_公司_北京朝阳区',
    confidence: 0.88,
    importance_score: 0.6
  });

  const consolidated = consolidator.run(tenant.id);

  assert.ok(consolidated >= 1, 'should create at least one consolidated group');

  // The highest importance_score memory should be canonical, others archived
  const statuses = all(db, `SELECT id, status, summary_parent_id FROM memory_entries WHERE tenant_id = ?`, [tenant.id]);
  const archived = statuses.filter((r) => r.status === 'archived');
  assert.ok(archived.length >= 1, 'at least one supporting memory should be archived');

  // Canonical should have highest importance_score
  const canonical = statuses.find((r) => r.status === 'active' && !r.summary_parent_id);
  assert.ok(canonical, 'should have one canonical active memory');
});

test('drill-down: summary with supporting archived memories', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);

  // Create a summary memory
  const summary = store.write({
    tenant_id: tenant.id,
    memory_type: 'summary',
    content: 'ABC 公司综合画像',
    entity_key: 'lead:lead-1',
    fact_key: 'summary:lead:lead-1',
    confidence: 0.9
  });

  // Create supporting archived memories
  const child1 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是 ABC 公司',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:abc_公司',
    confidence: 0.8,
    status: 'archived',
    summary_parent_id: summary?.id
  });
  const child2 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'preference',
    content: '客户偏好微信沟通',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:偏好微信',
    confidence: 0.85,
    status: 'archived',
    summary_parent_id: summary?.id
  });

  const pack = store.buildPack({ tenantId: tenant.id });

  const summaryEntry = pack.facts.find((f) => f.memory_type === 'summary');
  assert.ok(summaryEntry, 'summary should appear in facts');
  assert.ok(summaryEntry?.drill_down_memories, 'summary should have drill_down_memories');
  assert.equal(summaryEntry?.drill_down_memories?.length, 2, 'should have 2 supporting memories');

  const drillIds = summaryEntry?.drill_down_memories?.map((m) => m.id).sort();
  assert.deepEqual(drillIds, [child1?.id, child2?.id].sort(), 'drill-down IDs should match children');
});

test('drill-down: no summary memories => empty drill-down', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);

  store.write({
    tenant_id: tenant.id,
    memory_type: 'fact',
    content: 'plain fact',
    confidence: 0.8
  });

  const pack = store.buildPack({ tenantId: tenant.id });

  const factEntry = pack.facts.find((f) => f.memory_type === 'fact');
  assert.ok(factEntry, 'fact should exist');
  assert.equal(factEntry?.drill_down_memories, undefined, 'non-summary should not have drill_down_memories');
});

test('score engine: computeRecencyScore respects effective_known_at', () => {
  const now = Date.now();
  const entry = {
    id: 'test',
    tenant_id: 't1',
    scope_type: 'tenant',
    scope_id: '',
    memory_type: 'fact',
    content: 'test',
    evidence_object_type: '',
    evidence_object_id: '',
    confidence: 1,
    status: 'active',
    effective_known_at: new Date(now - 7 * 86_400_000).toISOString(),
    recall_count: 0
  };

  const score = computeRecencyScore(entry, {
    halfLifeMs: 7 * 86_400_000,
    alpha: 0.1,
    beta: 2.0,
    archiveThreshold: 0.05
  });

  assert.ok(score > 0.4 && score < 0.6, `recency score after exactly 1 half-life should be ~0.5, got ${score}`);
});

test('score engine: computeRelevanceScore boosts matched scope', () => {
  const entry = {
    id: 'test',
    tenant_id: 't1',
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'preference',
    content: '客户偏好微信沟通',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:偏好微信',
    evidence_object_type: '',
    evidence_object_id: '',
    confidence: 0.9,
    status: 'active'
  };

  const matched = computeRelevanceScore(entry, [{ scope_type: 'lead', scope_id: 'lead-1' }], '客户偏好');
  const unmatched = computeRelevanceScore(entry, [{ scope_type: 'lead', scope_id: 'lead-2' }], '客户偏好');

  assert.ok(matched > unmatched, 'matched scope should have higher relevance score');
});

test('score engine: computeMemoryScore composite decreases with age', () => {
  const now = Date.now();
  const fresh = {
    id: 'fresh',
    tenant_id: 't1',
    scope_type: 'tenant',
    scope_id: '',
    memory_type: 'fact',
    content: 'fresh',
    evidence_object_type: '',
    evidence_object_id: '',
    confidence: 1,
    status: 'active',
    effective_known_at: new Date(now - 1 * 86_400_000).toISOString(),
    importance_score: 0.9,
    recall_count: 0
  };
  const stale = {
    ...fresh,
    id: 'stale',
    content: 'stale',
    effective_known_at: new Date(now - 365 * 86_400_000).toISOString()
  };

  const config = { halfLifeMs: 7 * 86_400_000, alpha: 0.1, beta: 2.0, archiveThreshold: 0.05 };
  const freshScore = computeMemoryScore(fresh, [], '', config);
  const staleScore = computeMemoryScore(stale, [], '', config);

  assert.ok(freshScore.composite > staleScore.composite, 'fresh memory should have higher composite score');
});

test('summarizer: deterministic fallback when no model gateway', async () => {
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
  assert.equal(summarized, 1, 'should summarize heavy group');

  const summary = one(db, `SELECT * FROM memory_entries WHERE memory_type = 'summary' AND tenant_id = ?`, [tenant.id]);
  assert.ok(summary, 'summary memory should be created');
  assert.ok(String(summary.content).includes('lead:lead-1'), 'summary should contain entity key');

  const archived = all(db, `SELECT * FROM memory_entries WHERE tenant_id = ? AND status = 'archived'`, [tenant.id]);
  assert.equal(archived.length, 3, 'all 3 original memories should be archived');
});
