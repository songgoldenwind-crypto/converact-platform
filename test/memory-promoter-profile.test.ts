import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, all, one, run } from '../src/db.js';
import { createTenant } from '../src/services.js';
import { MemoryStore } from '../src/agent-runtime/memory/memory-store.js';
import { MemoryPromoter } from '../src/agent-runtime/memory/memory-promoter.js';

test('promoter: propose candidate', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);

  const candidate = promoter.propose({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是 ABC 公司',
    confidence: 0.85
  });

  assert.ok(candidate, 'should return candidate');
  assert.equal(candidate?.status, 'candidate');
  assert.equal(candidate?.memory_type, 'fact');
  assert.ok(candidate?.id?.startsWith('memcand_'), 'candidate ID should have memcand_ prefix');
});

test('promoter: approve candidate creates active memory', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);

  const candidate = promoter.propose({
    tenant_id: tenant.id,
    memory_type: 'preference',
    content: '客户偏好微信沟通',
    confidence: 0.9
  });

  const result = promoter.approve(tenant.id, candidate?.id as string);

  assert.ok(result.memory, 'should create memory');
  assert.equal((result.memory as any).status, 'active');
  assert.equal((result.memory as any).memory_type, 'preference');

  const fromDb = one(db, `SELECT * FROM memory_entries WHERE id = ?`, [(result.memory as any).id]);
  assert.equal(fromDb.status, 'active');
});

test('promoter: reject candidate', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);

  const candidate = promoter.propose({
    tenant_id: tenant.id,
    memory_type: 'fact',
    content: 'test',
    confidence: 0.5
  });

  const rejected = promoter.reject(tenant.id, candidate?.id as string);
  assert.equal(rejected?.status, 'rejected');

  const fromDb = one(db, `SELECT status FROM memory_candidates WHERE id = ?`, [candidate?.id]);
  assert.equal(fromDb.status, 'rejected');
});

test('promoter: approve with conflict supersedes old memory', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);
  const promoter = new MemoryPromoter(db, store, null);

  // Existing active memory
  const old = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是旧公司',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:客户公司',
    confidence: 0.8
  });

  // New candidate with same entity+fact key
  const candidate = promoter.propose({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是 ABC 公司',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:客户公司',
    confidence: 0.9
  });

  const result = promoter.approve(tenant.id, candidate?.id as string);

  assert.ok(result.superseded.length > 0, 'should supersede conflicting memory');
  const oldStatus = one(db, `SELECT status FROM memory_entries WHERE id = ?`, [old?.id]);
  assert.equal(oldStatus.status, 'superseded');
});

test('profile synthesis: creates profile from source memories', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);

  store.write({ tenant_id: tenant.id, scope_type: 'lead', scope_id: 'lead-1', memory_type: 'preference', content: '偏好微信', confidence: 0.9 });
  store.write({ tenant_id: tenant.id, scope_type: 'lead', scope_id: 'lead-1', memory_type: 'fact', content: 'ABC 公司', confidence: 0.85 });
  store.write({ tenant_id: tenant.id, scope_type: 'lead', scope_id: 'lead-1', memory_type: 'condition', content: '预算 10 万', confidence: 0.8 });

  const profile = store.synthesizeProfile({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1'
  });

  assert.ok(profile, 'should synthesize profile');
  assert.equal(profile?.memory_type, 'profile');
  assert.ok(profile?.content.includes('ABC 公司'), 'profile should include fact content');
  assert.ok(profile?.content.includes('偏好微信'), 'profile should include preference content');

  // Old profiles should be superseded
  const oldProfiles = all(db, `SELECT * FROM memory_entries WHERE tenant_id = ? AND memory_type = 'profile' AND status = 'superseded'`, [tenant.id]);
  assert.equal(oldProfiles.length, 0, 'first profile has nothing to supersede');
});

test('profile synthesis: resynthesis supersedes old profile', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);

  store.write({ tenant_id: tenant.id, scope_type: 'lead', scope_id: 'lead-1', memory_type: 'fact', content: '事实 1', confidence: 0.8 });

  const p1 = store.synthesizeProfile({ tenant_id: tenant.id, scope_type: 'lead', scope_id: 'lead-1' });
  const p2 = store.synthesizeProfile({ tenant_id: tenant.id, scope_type: 'lead', scope_id: 'lead-1' });

  assert.ok(p1 && p2, 'both profiles created');
  assert.notEqual(p1?.id, p2?.id, 'profiles should have different IDs');

  const p1Status = one(db, `SELECT status FROM memory_entries WHERE id = ?`, [p1?.id]);
  assert.equal(p1Status.status, 'superseded', 'first profile should be superseded');

  const p2Status = one(db, `SELECT status FROM memory_entries WHERE id = ?`, [p2?.id]);
  assert.equal(p2Status.status, 'active', 'second profile should be active');
});

test('conflict detection: findActiveConflicts finds same fact_key', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);

  const m1 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是 ABC 公司',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:公司',
    confidence: 0.8
  });
  const m2 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: '客户是 XYZ 公司',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:公司',
    confidence: 0.85
  });

  const conflicts = store.findActiveConflicts({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    fact_key: 'fact:公司'
  });

  assert.equal(conflicts.length, 2, 'should find both memories with same fact_key');
});

test('conflict detection: exclude_memory_id works', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'test', admin_email: 'test@example.com' });
  const store = new MemoryStore(db);

  const m1 = store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: 'A',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:test',
    confidence: 0.8
  });
  store.write({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    memory_type: 'fact',
    content: 'B',
    entity_key: 'lead:lead-1',
    fact_key: 'fact:test',
    confidence: 0.85
  });

  const conflicts = store.findActiveConflicts({
    tenant_id: tenant.id,
    scope_type: 'lead',
    scope_id: 'lead-1',
    fact_key: 'fact:test',
    exclude_memory_id: m1?.id
  });

  assert.equal(conflicts.length, 1, 'should exclude m1');
  assert.equal(conflicts[0].id !== m1?.id, true);
});
