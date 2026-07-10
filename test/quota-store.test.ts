import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, all } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { QuotaStore } from '../src/agent-runtime/quota/quota-store.js';

test('QuotaStore upsertLimit defaults soft_limit to 80% of hard_limit', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Q' });
  const limit = store.upsertLimit({ tenant_id: tenant.id, quota_key: 'tool_calls', hard_limit: 100 });
  assert.equal(limit.hard_limit, 100);
  assert.equal(limit.soft_limit, 80);
});

test('QuotaStore allows when no limit is configured', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'NoLimit' });
  const decision = store.check({ tenant_id: tenant.id, quota_key: 'unconfigured', amount: 1 });
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.usage.hard_limit, null);
  assert.equal(decision.usage.status, 'unlimited');
});

test('QuotaStore allows when usage is well within limit', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Within' });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'tool_calls', hard_limit: 100, soft_limit: 80 });
  store.recordUsage({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 50 });
  const decision = store.check({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 1 });
  assert.equal(decision.decision, 'allow');
});

test('QuotaStore warns when usage crosses soft_limit', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Warn' });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'tool_calls', hard_limit: 100, soft_limit: 80 });
  store.recordUsage({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 75 });
  // 75 + 10 = 85 >= soft_limit(80) but < hard_limit(100)
  const decision = store.check({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 10 });
  assert.equal(decision.decision, 'warn');
  assert.ok(decision.reason.includes('approaching'));
});

test('QuotaStore denies when usage exceeds hard_limit', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Deny' });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'tool_calls', hard_limit: 100, soft_limit: 80 });
  store.recordUsage({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 95 });
  // 95 + 10 = 105 > hard_limit(100)
  const decision = store.check({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 10 });
  assert.equal(decision.decision, 'deny');
  assert.ok(decision.reason.includes('exceeded'));
  assert.ok(decision.reason.includes('105/100'));
});

test('QuotaStore allows exact fit at hard_limit boundary', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Exact' });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'tool_calls', hard_limit: 100, soft_limit: 80 });
  store.recordUsage({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 90 });
  // 90 + 10 = 100, not > 100 → allowed (but warned since >= soft_limit)
  const decision = store.check({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 10 });
  assert.equal(decision.decision, 'warn');
});

test('QuotaStore assertWithinLimit throws 429 on deny', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Throw429' });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'tool_calls', hard_limit: 10, soft_limit: 8 });
  store.recordUsage({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 10 });
  try {
    store.assertWithinLimit({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 1 });
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal((error as Error).name, 'QuotaExceededError');
    assert.equal((error as Error & { status: number }).status, 429);
  }
});

test('QuotaStore getUsage sums across multiple recordUsage calls', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Sum' });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'tool_calls', hard_limit: 100 });
  store.recordUsage({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 10 });
  store.recordUsage({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 25 });
  store.recordUsage({ tenant_id: tenant.id, quota_key: 'tool_calls', amount: 5 });
  const usage = store.getUsage({ tenant_id: tenant.id, quota_key: 'tool_calls' });
  assert.equal(usage.used, 40);
  assert.equal(usage.status, 'ok');
});

test('QuotaStore period isolation: daily vs monthly do not cross-count', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Periods' });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'calls', period: 'daily', hard_limit: 10 });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'calls', period: 'monthly', hard_limit: 100 });
  store.recordUsage({ tenant_id: tenant.id, quota_key: 'calls', amount: 5, period: 'daily' });
  store.recordUsage({ tenant_id: tenant.id, quota_key: 'calls', amount: 5, period: 'monthly' });
  const daily = store.getUsage({ tenant_id: tenant.id, quota_key: 'calls', period: 'daily' });
  const monthly = store.getUsage({ tenant_id: tenant.id, quota_key: 'calls', period: 'monthly' });
  assert.equal(daily.used, 5);
  assert.equal(monthly.used, 5);
});

test('QuotaStore recordUsage with amount 0 is a no-op', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Zero' });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'calls', hard_limit: 10 });
  const result = store.recordUsage({ tenant_id: tenant.id, quota_key: 'calls', amount: 0 });
  assert.equal(result, null);
  const usage = store.getUsage({ tenant_id: tenant.id, quota_key: 'calls' });
  assert.equal(usage.used, 0);
});

test('QuotaStore upsertLimit updates existing limit (ON CONFLICT)', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Update' });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'calls', hard_limit: 100 });
  assert.equal(store.getLimit(tenant.id, 'calls')?.hard_limit, 100);
  // Update to new limit
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'calls', hard_limit: 500, soft_limit: 400 });
  const updated = store.getLimit(tenant.id, 'calls');
  assert.equal(updated.hard_limit, 500);
  assert.equal(updated.soft_limit, 400);
});

test('QuotaStore records policy decisions for audit trail', () => {
  const db = createDatabase(':memory:');
  const store = new QuotaStore(db);
  const tenant = createTenant(db, { name: 'Audit' });
  store.upsertLimit({ tenant_id: tenant.id, quota_key: 'calls', hard_limit: 5 });
  // allowed
  store.assertWithinLimit({ tenant_id: tenant.id, quota_key: 'calls', amount: 1, actor_id: 'user-1' });
  // denied
  assert.throws(() =>
    store.assertWithinLimit({ tenant_id: tenant.id, quota_key: 'calls', amount: 10, actor_id: 'user-1' })
  );
  const decisions = all(db, 'SELECT * FROM policy_decisions WHERE tenant_id = ? AND decision_type = ? ORDER BY created_at', [tenant.id, 'quota']);
  assert.ok(decisions.some((d) => d.decision === 'allow'));
  assert.ok(decisions.some((d) => d.decision === 'deny'));
});
