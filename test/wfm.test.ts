import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { WfmStore } from '../src/agent-runtime/call-center/wfm/wfm-store.js';
import { forecastVolume } from '../src/agent-runtime/call-center/wfm/forecast.js';
import { generateSchedule } from '../src/agent-runtime/call-center/wfm/scheduler.js';
import { routeWfmApi } from '../src/agent-runtime/call-center/wfm/wfm-http.js';

const API_KEY = 'test-wfm-key';
function authHeaders(tenantId: string): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'X-Tenant-Id': tenantId };
}
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';

test('WfmStore creates and lists schedules', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'WFM Test' });
  const store = new WfmStore(db);

  const sched = store.createSchedule({
    tenant_id: tenant.id,
    agent_seat_id: 'seat_001',
    date: '2026-06-20',
    shift_start: '09:00',
    shift_end: '17:00',
    break_minutes: 30
  });

  assert.ok(sched.id.startsWith('sched_'));
  assert.equal(sched.tenant_id, tenant.id);
  assert.equal(sched.shift_start, '09:00');
  assert.equal(sched.shift_end, '17:00');
  assert.equal(sched.break_minutes, 30);
  assert.equal(sched.status, 'scheduled');

  store.createSchedule({
    tenant_id: tenant.id,
    agent_seat_id: 'seat_002',
    date: '2026-06-20',
    shift_start: '13:00',
    shift_end: '21:00'
  });

  const list = store.listSchedules(tenant.id, '2026-06-20');
  assert.equal(list.length, 2);

  const updated = store.updateSchedule(sched.id, { status: 'confirmed' });
  assert.equal(updated!.status, 'confirmed');

  store.deleteSchedule(sched.id);
  assert.equal(store.getSchedule(sched.id), null);
});

test('WfmStore saves and retrieves forecasts', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Forecast Test' });
  const store = new WfmStore(db);

  const fcst = store.saveForecast({
    tenant_id: tenant.id,
    date: '2026-06-21',
    hour: 9,
    predicted_volume: 12.5
  });

  assert.ok(fcst.id.startsWith('fcst_'));
  assert.equal(fcst.predicted_volume, 12.5);
  assert.equal(fcst.actual_volume, null);
  assert.equal(fcst.model_version, 'ses_v1');

  store.saveForecast({ tenant_id: tenant.id, date: '2026-06-21', hour: 10, predicted_volume: 8.0 });

  const list = store.getForecastsForDate(tenant.id, '2026-06-21');
  assert.equal(list.length, 2);
  assert.equal(list[0].hour, 9);
  assert.equal(list[1].hour, 10);

  store.recordActualVolume(tenant.id, '2026-06-21', 9, 14);
  const updated = store.getForecastsForDate(tenant.id, '2026-06-21');
  assert.equal(updated[0].actual_volume, 14);
});

test('forecastVolume applies SES correctly', () => {
  const history = [
    { date: '2026-06-01', hour: 9, volume: 10 },
    { date: '2026-06-02', hour: 9, volume: 12 },
    { date: '2026-06-03', hour: 9, volume: 15 }
  ];

  const results = forecastVolume(history, '2026-06-04', { alpha: 0.3 });
  const hour9 = results.find((r) => r.hour === 9)!;

  // SES: f0=10, f1=0.3*12+0.7*10=10.6, f2=0.3*15+0.7*10.6=11.92
  assert.equal(hour9.predicted_volume, 11.9);
});

test('forecastVolume returns 24 hourly predictions', () => {
  const history = [
    { date: '2026-06-01', hour: 0, volume: 2 },
    { date: '2026-06-01', hour: 12, volume: 20 },
    { date: '2026-06-01', hour: 23, volume: 3 }
  ];

  const results = forecastVolume(history, '2026-06-02');
  assert.equal(results.length, 24);
  assert.equal(results[0].hour, 0);
  assert.equal(results[23].hour, 23);
  assert.equal(results[0].predicted_volume, 2);
  assert.equal(results[12].predicted_volume, 20);
  assert.equal(results[1].predicted_volume, 0);
});

test('generateSchedule assigns agents to cover demand', () => {
  const forecastedVolume = Array.from({ length: 24 }, (_, hour) => ({
    date: '2026-06-20',
    hour,
    predicted_volume: hour >= 9 && hour < 17 ? 10 : 2
  }));

  const availableAgents = [
    { seat_id: 'a1', skills: [], max_hours: 8 },
    { seat_id: 'a2', skills: [], max_hours: 8 },
    { seat_id: 'a3', skills: [], max_hours: 8 }
  ];

  const proposal = generateSchedule({
    targetDate: '2026-06-20',
    forecastedVolume,
    availableAgents,
    constraints: { minAgentsPerShift: 1, maxConsecutiveHours: 8, minBreakMinutes: 30, agentsPerVolumeUnit: 5 }
  });

  assert.ok(proposal.schedules.length > 0);
  assert.equal(proposal.coverage.length, 24);

  const peakCoverage = proposal.coverage.filter((c) => c.hour >= 9 && c.hour < 17);
  for (const c of peakCoverage) {
    assert.ok(c.agents_needed >= 2);
    assert.ok(c.agents_assigned >= 1);
  }
});

test('generateSchedule respects max consecutive hours', () => {
  const forecastedVolume = Array.from({ length: 24 }, (_, hour) => ({
    date: '2026-06-20',
    hour,
    predicted_volume: 5
  }));

  const availableAgents = [{ seat_id: 'a1', skills: [], max_hours: 24 }];

  const proposal = generateSchedule({
    targetDate: '2026-06-20',
    forecastedVolume,
    availableAgents,
    constraints: { minAgentsPerShift: 1, maxConsecutiveHours: 6, minBreakMinutes: 30, agentsPerVolumeUnit: 5 }
  });

  for (const sched of proposal.schedules) {
    const start = parseInt(sched.shift_start.split(':')[0], 10);
    const end = parseInt(sched.shift_end.split(':')[0], 10);
    assert.ok(end - start <= 6, `shift ${sched.shift_start}-${sched.shift_end} exceeds max 6 hours`);
  }
});

test('generateSchedule warns on under-coverage', () => {
  const forecastedVolume = Array.from({ length: 24 }, (_, hour) => ({
    date: '2026-06-20',
    hour,
    predicted_volume: 50
  }));

  const availableAgents = [{ seat_id: 'a1', skills: [], max_hours: 8 }];

  const proposal = generateSchedule({
    targetDate: '2026-06-20',
    forecastedVolume,
    availableAgents,
    constraints: { minAgentsPerShift: 1, maxConsecutiveHours: 8, minBreakMinutes: 30, agentsPerVolumeUnit: 5 }
  });

  assert.ok(proposal.warnings.length > 0);
  assert.ok(proposal.warnings[0].includes('need'));
});

test('WFM HTTP routes work end-to-end', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'HTTP Test' });
  process.env.CONVERACT_API_KEY = API_KEY;
  const wfmStore = new WfmStore(db);
  const seatStore = new AgentSeatStore(db);

  seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u1', display_name: 'Agent 1' });
  seatStore.updateStatus(tenant.id, seatStore.listSeats(tenant.id)[0].id, 'idle');

  const forecastResult = (await routeWfmApi(
    db, 'POST', '/api/wfm/forecast',
    new URL('http://localhost/api/wfm/forecast'),
    {
      tenant_id: tenant.id,
      target_date: '2026-06-25',
      historical_data: [
        { date: '2026-06-20', hour: 9, volume: 10 },
        { date: '2026-06-21', hour: 9, volume: 12 },
        { date: '2026-06-22', hour: 9, volume: 15 }
      ]
    }
    , authHeaders(tenant.id)
  )) as any[];
  assert.ok(Array.isArray(forecastResult));
  assert.equal(forecastResult.length, 24);

  const getForecasts = (await routeWfmApi(
    db, 'GET', '/api/wfm/forecast',
    new URL(`http://localhost/api/wfm/forecast?tenant_id=${tenant.id}&date=2026-06-25`),
    null
    , authHeaders(tenant.id)
  )) as any[];
  assert.equal(getForecasts.length, 24);

  const scheduleResult = (await routeWfmApi(
    db, 'POST', '/api/wfm/schedule',
    new URL('http://localhost/api/wfm/schedule'),
    { tenant_id: tenant.id, target_date: '2026-06-25' }
    , authHeaders(tenant.id)
  )) as any;
  assert.ok(scheduleResult.schedules.length > 0);
  assert.ok(Array.isArray(scheduleResult.coverage));

  const listSchedules = (await routeWfmApi(
    db, 'GET', '/api/wfm/schedules',
    new URL(`http://localhost/api/wfm/schedules?tenant_id=${tenant.id}&date=2026-06-25`),
    null
    , authHeaders(tenant.id)
  )) as any[];
  assert.ok(listSchedules.length > 0);

  const firstId = listSchedules[0].id;
  const updated = (await routeWfmApi(
    db, 'PUT', `/api/wfm/schedules/${firstId}`,
    new URL(`http://localhost/api/wfm/schedules/${firstId}`),
    { status: 'confirmed' }
    , authHeaders(tenant.id)
  )) as any;
  assert.equal(updated.status, 'confirmed');

  const deleted = (await routeWfmApi(
    db, 'DELETE', `/api/wfm/schedules/${firstId}`,
    new URL(`http://localhost/api/wfm/schedules/${firstId}`),
    null
    , authHeaders(tenant.id)
  )) as any;
  assert.deepEqual(deleted, { ok: true });
});
