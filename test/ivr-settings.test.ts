import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrSettingsStore } from '../src/agent-runtime/ivr/ivr-settings-store.js';

function setup() {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Settings Test' });
  const store = new IvrSettingsStore(db);
  store.ensureTables();
  return { db, tenantId: tenant.id, store };
}

// --- Time Groups ---
test('TimeGroup: create, list, get, delete', () => {
  const { tenantId, store } = setup();
  const tg = store.upsertTimeGroup({
    id: 'tg-1', tenant_id: tenantId, name: '工作时间',
    schedule: { mon: [9, 18], tue: [9, 18], wed: [9, 18], thu: [9, 18], fri: [9, 18] },
    timezone: 'Asia/Shanghai',
  });
  assert.equal(tg.name, '工作时间');
  assert.deepEqual(tg.schedule.mon, [9, 18]);

  assert.equal(store.listTimeGroups(tenantId).length, 1);
  assert.ok(store.getTimeGroup(tenantId, 'tg-1'));
  assert.equal(store.deleteTimeGroup(tenantId, 'tg-1'), true);
  assert.equal(store.getTimeGroup(tenantId, 'tg-1'), null);
});

test('TimeGroup: checkTimeGroupActive during business hours', () => {
  const { tenantId, store } = setup();
  store.upsertTimeGroup({
    id: 'tg-2', tenant_id: tenantId, name: '工作时间',
    schedule: { mon: [9, 18], tue: [9, 18], wed: [9, 18], thu: [9, 18], fri: [9, 18], sat: [0, 0], sun: [0, 0] },
  });
  // Monday 10:00 → active
  const monday = new Date('2026-06-29T10:00:00'); // Monday
  assert.equal(store.checkTimeGroupActive('tg-2', tenantId, monday), true);
  // Monday 20:00 → inactive
  const mondayNight = new Date('2026-06-29T20:00:00');
  assert.equal(store.checkTimeGroupActive('tg-2', tenantId, mondayNight), false);
  // Saturday → inactive (0-0 = closed)
  const saturday = new Date('2026-06-27T10:00:00');
  assert.equal(store.checkTimeGroupActive('tg-2', tenantId, saturday), false);
  // Non-existent group → active (no schedule = always open)
  assert.equal(store.checkTimeGroupActive('nonexistent', tenantId, monday), true);
});

// --- Region Groups ---
test('RegionGroup: create with regions, list, delete', () => {
  const { tenantId, store } = setup();
  const rg = store.upsertRegionGroup({
    id: 'rg-1', tenant_id: tenantId, name: '华东区',
    regions: ['上海', '杭州', '南京'],
  });
  assert.equal(rg.name, '华东区');
  assert.deepEqual(rg.regions, ['上海', '杭州', '南京']);
  assert.equal(store.listRegionGroups(tenantId).length, 1);
  assert.equal(store.deleteRegionGroup(tenantId, 'rg-1'), true);
});

// --- Group Call Groups ---
test('GroupCallGroup: create with members, list, delete', () => {
  const { tenantId, store } = setup();
  const gc = store.upsertGroupCallGroup({
    id: 'gc-1', tenant_id: tenantId, name: '销售组',
    member_seat_ids: ['seat-1', 'seat-2', 'seat-3'],
    strategy: 'round_robin',
  });
  assert.equal(gc.name, '销售组');
  assert.deepEqual(gc.member_seat_ids, ['seat-1', 'seat-2', 'seat-3']);
  assert.equal(gc.strategy, 'round_robin');
  assert.equal(store.listGroupCallGroups(tenantId).length, 1);
  assert.equal(store.deleteGroupCallGroup(tenantId, 'gc-1'), true);
});

test('ensureTables is idempotent', () => {
  const db = createDatabase(':memory:');
  const store = new IvrSettingsStore(db);
  store.ensureTables();
  store.ensureTables(); // no error
  assert.ok(store.listTimeGroups('any-tenant'));
});

test('TimeGroup: upsert updates existing', () => {
  const { tenantId, store } = setup();
  store.upsertTimeGroup({ id: 'tg-3', tenant_id: tenantId, name: 'Original', schedule: {} });
  const updated = store.upsertTimeGroup({ id: 'tg-3', tenant_id: tenantId, name: 'Updated', schedule: { mon: [8, 17] } });
  assert.equal(updated.name, 'Updated');
  assert.deepEqual(updated.schedule.mon, [8, 17]);
});

test('RegionGroup: matchRegionGroup matches area code prefix', () => {
  const { tenantId, store } = setup();
  store.upsertRegionGroup({
    id: 'rg-sh', tenant_id: tenantId, name: '上海',
    regions: ['021', '310000'],
  });
  assert.equal(store.matchRegionGroup('rg-sh', tenantId, '+862112345678'), true);
  assert.equal(store.matchRegionGroup('rg-sh', tenantId, '01012345678'), false);
  assert.equal(store.matchRegionGroup('missing', tenantId, '021'), true);
});

test('GroupCallGroup: resolveGroupCallMembers returns seat ids', () => {
  const { tenantId, store } = setup();
  store.upsertGroupCallGroup({
    id: 'gc-1', tenant_id: tenantId, name: '值班',
    member_seat_ids: ['seat_a', 'seat_b'], strategy: 'simultaneous',
  });
  assert.deepEqual(store.resolveGroupCallMembers('gc-1', tenantId), ['seat_a', 'seat_b']);
});