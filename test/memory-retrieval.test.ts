import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, one } from '../src/db.js';
import { createTenant } from '../src/services.js';
import { MemoryStore } from '../src/agent-runtime/memory/memory-store.js';
import { MemorySummarizer } from '../src/agent-runtime/memory/memory-summarizer.js';

test('retrieve query pre-filter uses SQL content LIKE to reduce JS scan', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);

  store.write({ tenant_id: tenant.id, memory_type: 'fact', content: '客户喜欢香蕉口味', confidence: 0.8 });
  store.write({ tenant_id: tenant.id, memory_type: 'fact', content: '客户偏好苹果口味', confidence: 0.8 });

  const result = store.retrieve({ tenant_id: tenant.id, query: '香蕉', limit: 10 });

  assert.equal(result.memories.length, 1, 'should filter to one memory');
  assert.ok(result.memories[0].content.includes('香蕉'), 'returned memory should match query token');
});

test('retrieve scoped query pre-filter filters by scope and content', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);

  store.write({ tenant_id: tenant.id, scope_type: 'lead', scope_id: 'lead-1', memory_type: 'fact', content: 'lead-1 喜欢香蕉', confidence: 0.8 });
  store.write({ tenant_id: tenant.id, scope_type: 'lead', scope_id: 'lead-2', memory_type: 'fact', content: 'lead-2 喜欢苹果', confidence: 0.8 });

  const result = store.retrieve({
    tenant_id: tenant.id,
    query: '香蕉',
    scopes: [{ scope_type: 'lead', scope_id: 'lead-1' }],
    limit: 10
  });

  assert.equal(result.memories.length, 1, 'should return only scoped match');
  assert.equal(result.memories[0].scope_id, 'lead-1', 'returned memory should belong to lead-1');
});

test('rankMemory boosts entity_key and fact_key matches', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);

  store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: 'generic content',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:generic',
    confidence: 0.8
  });
  store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-2',
    memory_type: 'fact',
    content: 'generic content',
    entity_key: 'lead:lead-2',
    fact_key: 'fact:generic',
    confidence: 0.8
  });
  store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-10',
    memory_type: 'fact',
    content: 'generic content',
    entity_key: 'lead:lead-10',
    fact_key: 'fact:generic',
    confidence: 0.8,
    effective_known_at: '2099-01-01T00:00:00.000Z'
  });

  const result = store.retrieve({
    tenant_id: tenant.id,
    query: 'lead-1',
    limit: 10
  });

  assert.ok(result.memories.length >= 2, 'should have both memories');
  assert.equal(result.memories[0].scope_id, 'lead-1', 'entity-key match should rank first');
});

test('summarizer uses structured JSON output when model gateway returns JSON', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const summarizer = new MemorySummarizer(db, store, 3, {
    complete: async () => ({
      output: { text: '{"summary": "综合摘要：客户关注价格和交付时间"}' }
    })
  } as any);

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
  assert.equal(summarized, 1, 'should summarize one group');

  const summary = one(db, `SELECT content, metadata FROM memory_entries WHERE memory_type = 'summary'`);
  assert.equal(summary.content, '综合摘要：客户关注价格和交付时间', 'should use JSON summary');
  const metadata = JSON.parse(summary.metadata);
  assert.equal(metadata.fallback_reason, null, 'should not fallback when JSON parses');
});

test('retrieve query pre-filter with multiple tokens returns union matches', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);

  store.write({ tenant_id: tenant.id, memory_type: 'fact', content: '客户喜欢香蕉和巧克力', confidence: 0.8 });
  store.write({ tenant_id: tenant.id, memory_type: 'fact', content: '客户偏好苹果', confidence: 0.8 });

  const result = store.retrieve({ tenant_id: tenant.id, query: '香蕉 苹果', limit: 10 });

  assert.equal(result.memories.length, 2, 'should match either token');
});
