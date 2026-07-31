import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrSettingsStore } from '../src/agent-runtime/ivr/ivr-settings-store.js';
import { routeIvrSettingsApi } from '../src/agent-runtime/ivr/ivr-settings-http.js';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function setupStore() {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Holiday Test' });
  const store = new IvrSettingsStore(db);
  store.ensureTables();
  return { tenantId: tenant.id, store };
}

test('checkTimeGroupActive: holiday closed on MM-DD', () => {
  const { tenantId, store } = setupStore();
  store.upsertTimeGroup({
    id: 'tg-hol',
    tenant_id: tenantId,
    name: '国庆',
    schedule: { mon: [9, 18], tue: [9, 18], wed: [9, 18], thu: [9, 18], fri: [9, 18] },
    holidays: [{ date: '10-01', closed: true }],
    timezone: 'Asia/Shanghai',
  });
  const nationalDay = new Date('2026-10-01T10:00:00+08:00');
  assert.equal(store.checkTimeGroupActive('tg-hol', tenantId, nationalDay), false);
});

test('checkTimeGroupActive: weekday after holiday is active', () => {
  const { tenantId, store } = setupStore();
  store.upsertTimeGroup({
    id: 'tg-hol',
    tenant_id: tenantId,
    name: '国庆后',
    schedule: { thu: [9, 18] },
    holidays: [{ date: '10-01', closed: true }],
    timezone: 'Asia/Shanghai',
  });
  const thursday = new Date('2026-10-08T10:00:00+08:00');
  assert.equal(store.checkTimeGroupActive('tg-hol', tenantId, thursday), true);
});

test('checkTimeGroupActive: respects timezone for hour window', () => {
  const { tenantId, store } = setupStore();
  store.upsertTimeGroup({
    id: 'tg-tz',
    tenant_id: tenantId,
    name: 'TZ',
    schedule: { wed: [9, 18] },
    timezone: 'Asia/Shanghai',
  });
  const earlyUtc = new Date('2026-10-07T00:30:00Z'); // 08:30 Shanghai Wed
  assert.equal(store.checkTimeGroupActive('tg-tz', tenantId, earlyUtc), false);
  const openUtc = new Date('2026-10-07T02:00:00Z'); // 10:00 Shanghai Wed
  assert.equal(store.checkTimeGroupActive('tg-tz', tenantId, openUtc), true);
});

test('time_condition node routes false on holiday', async () => {
  const { tenantId, store } = setupStore();
  store.upsertTimeGroup({
    id: 'tg-ivr',
    tenant_id: tenantId,
    name: 'IVR',
    schedule: { thu: [9, 18] },
    holidays: [{ date: '10-01', closed: true }],
    timezone: 'Asia/Shanghai',
  });

  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'tc1',
    variables: [],
    nodes: [
      { id: 'tc1', type: 'time_condition', name: 'TC', position: { x: 0, y: 0 }, data: { scheduleId: 'tg-ivr' } },
      { id: 'open', type: 'play', name: 'Open', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'open' }] } },
      { id: 'closed', type: 'play', name: 'Closed', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'closed' }] } },
    ],
    edges: [
      { id: 'e1', source: 'tc1', target: 'open', sourceHandle: 'true' },
      { id: 'e2', source: 'tc1', target: 'closed', sourceHandle: 'false' },
    ],
  };

  const holiday = new Date('2026-10-01T10:00:00+08:00');
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    timeGroupChecker: (id) => store.checkTimeGroupActive(id, tenantId, holiday),
  });
  assert.equal(step.nextNodeId, 'closed');
});

test('time_condition node routes true on business day', async () => {
  const { tenantId, store } = setupStore();
  store.upsertTimeGroup({
    id: 'tg-ivr',
    tenant_id: tenantId,
    name: 'IVR',
    schedule: { thu: [9, 18] },
    holidays: [{ date: '10-01', closed: true }],
    timezone: 'Asia/Shanghai',
  });

  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'tc1',
    variables: [],
    nodes: [
      { id: 'tc1', type: 'time_condition', name: 'TC', position: { x: 0, y: 0 }, data: { scheduleId: 'tg-ivr' } },
      { id: 'open', type: 'play', name: 'Open', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'open' }] } },
      { id: 'closed', type: 'play', name: 'Closed', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'closed' }] } },
    ],
    edges: [
      { id: 'e1', source: 'tc1', target: 'open', sourceHandle: 'true' },
      { id: 'e2', source: 'tc1', target: 'closed', sourceHandle: 'false' },
    ],
  };

  const workday = new Date('2026-10-08T10:00:00+08:00');
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    timeGroupChecker: (id) => store.checkTimeGroupActive(id, tenantId, workday),
  });
  assert.equal(step.nextNodeId, 'open');
});

test('time group preview API: holiday returns inactive', () => {
  const API_KEY = 'test-time-preview-key';
  process.env.CONVERACT_API_KEY = API_KEY;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Preview Test' });
  const store = new IvrSettingsStore(db);
  store.ensureTables();
  store.upsertTimeGroup({
    id: 'tg-prev',
    tenant_id: tenant.id,
    name: '预览',
    schedule: { wed: [9, 18] },
    holidays: [{ date: '10-01', closed: true }],
    timezone: 'Asia/Shanghai',
  });
  const url = new URL('http://localhost/api/ivr/settings/time-groups/tg-prev/preview?at=2026-10-01T10:00:00%2B08:00');
  const result = routeIvrSettingsApi(
    db,
    'GET',
    '/api/ivr/settings/time-groups/tg-prev/preview',
    url,
    null,
    { 'X-API-Key': API_KEY, 'X-Tenant-Id': tenant.id }
  ) as { data: { active: boolean; at: string } };
  assert.equal(result.data.active, false);
  assert.ok(result.data.at);
});
