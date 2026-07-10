import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, all } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { PLAN_DEFINITIONS, getPlanDefinition, seedQuotaLimitsForPlan } from '../src/plan-definitions.js';

test('PLAN_DEFINITIONS contains free, pro, enterprise', () => {
  assert.ok(PLAN_DEFINITIONS.free);
  assert.ok(PLAN_DEFINITIONS.pro);
  assert.ok(PLAN_DEFINITIONS.enterprise);
  assert.equal(Object.keys(PLAN_DEFINITIONS).length, 3);
});

test('getPlanDefinition returns correct plan for known codes', () => {
  const free = getPlanDefinition('free');
  assert.equal(free.code, 'free');
  assert.equal(free.maxSeats, 2);
  assert.equal(free.monthlyAiMinutes, 100);
  assert.equal(free.monthlyToolCalls, 500);
  assert.deepEqual(free.features, []);

  const pro = getPlanDefinition('pro');
  assert.equal(pro.code, 'pro');
  assert.equal(pro.maxSeats, 20);
  assert.deepEqual(pro.features, ['qm']);

  const ent = getPlanDefinition('enterprise');
  assert.equal(ent.maxSeats, -1);
  assert.equal(ent.monthlyAiMinutes, -1);
  assert.deepEqual(ent.features, ['qm', 'rag', 'wfm', 'white_label']);
});

test('getPlanDefinition throws for unknown plan code', () => {
  assert.throws(
    () => getPlanDefinition('platinum'),
    (err: any) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /unknown plan code/);
      return true;
    }
  );
});

test('seedQuotaLimitsForPlan creates correct limits for free plan', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Free Tenant' });

  seedQuotaLimitsForPlan(db, tenant.id, 'free');

  const limits = all(db, 'SELECT * FROM tenant_quota_limits WHERE tenant_id = ? ORDER BY quota_key', [tenant.id]);
  assert.equal(limits.length, 3);

  const aiMinutes = limits.find((l) => l.quota_key === 'ai_minutes');
  assert.ok(aiMinutes);
  assert.equal(aiMinutes.hard_limit, 100);
  assert.equal(aiMinutes.soft_limit, 80);
  assert.equal(aiMinutes.period, 'monthly');
  assert.equal(aiMinutes.status, 'active');

  const seats = limits.find((l) => l.quota_key === 'seats');
  assert.ok(seats);
  assert.equal(seats.hard_limit, 2);

  const toolCalls = limits.find((l) => l.quota_key === 'tool_calls');
  assert.ok(toolCalls);
  assert.equal(toolCalls.hard_limit, 500);
  assert.equal(toolCalls.soft_limit, 400);
});

test('seedQuotaLimitsForPlan creates correct limits for pro plan', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Pro Tenant' });

  seedQuotaLimitsForPlan(db, tenant.id, 'pro');

  const limits = all(db, 'SELECT * FROM tenant_quota_limits WHERE tenant_id = ? ORDER BY quota_key', [tenant.id]);
  assert.equal(limits.length, 3);

  const aiMinutes = limits.find((l) => l.quota_key === 'ai_minutes');
  assert.equal(aiMinutes!.hard_limit, 2000);

  const toolCalls = limits.find((l) => l.quota_key === 'tool_calls');
  assert.equal(toolCalls!.hard_limit, 10000);

  const seats = limits.find((l) => l.quota_key === 'seats');
  assert.equal(seats!.hard_limit, 20);
});

test('seedQuotaLimitsForPlan uses 0 for unlimited enterprise limits', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Enterprise Tenant' });

  seedQuotaLimitsForPlan(db, tenant.id, 'enterprise');

  const limits = all(db, 'SELECT * FROM tenant_quota_limits WHERE tenant_id = ? ORDER BY quota_key', [tenant.id]);
  assert.equal(limits.length, 3);

  for (const limit of limits) {
    assert.equal(limit.hard_limit, 0, `${limit.quota_key} should be unlimited (0)`);
    assert.equal(limit.soft_limit, 0);
  }
});

test('seedQuotaLimitsForPlan is idempotent (upsert)', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Idempotent Tenant' });

  seedQuotaLimitsForPlan(db, tenant.id, 'free');
  seedQuotaLimitsForPlan(db, tenant.id, 'pro');

  const limits = all(db, 'SELECT * FROM tenant_quota_limits WHERE tenant_id = ? ORDER BY quota_key', [tenant.id]);
  assert.equal(limits.length, 3, 'should still be 3 rows after upsert');

  const aiMinutes = limits.find((l) => l.quota_key === 'ai_minutes');
  assert.equal(aiMinutes!.hard_limit, 2000, 'should reflect pro plan after upsert');
});

test('seedQuotaLimitsForPlan throws for unknown plan', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Unknown Plan Tenant' });

  assert.throws(
    () => seedQuotaLimitsForPlan(db, tenant.id, 'platinum'),
    (err: any) => {
      assert.match(err.message, /unknown plan code/);
      return true;
    }
  );
});
