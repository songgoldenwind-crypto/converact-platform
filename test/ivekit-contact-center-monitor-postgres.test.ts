import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresContactCenterMonitorSource } from
  '../src/agent-runtime/ivekit/contact-center/index.js';
import type { PgQueryable } from '../src/db-pg.js';

test('Contact Center PostgreSQL monitor loads tenant-scoped operational projections', async () => {
  const pg = new MonitorPg((sql) => {
    if (sql.includes('FROM ivekit_cc_agents agent')) return [{
      configured: '4', active: '3', offline: '0', available: '1', busy: '1',
      after_call: '1', away: '0', active_voice_count: '2', voice_capacity: '4'
    }];
    if (sql.includes('FROM ivekit_voice_calls voice_call')) return [{
      active_inbound: '2', active_outbound: '1'
    }];
    if (sql.includes('FROM ivekit_cc_queues queue')) return [{
      queue_id: 'queue-a', queue_name: 'Support', status: 'active',
      routing_strategy: 'longest_idle', max_wait_seconds: '300',
      service_level_seconds: '20', waiting_count: '3', offered_count: '1',
      assigned_count: '0', answered_count: '1', available_agents: '1',
      available_capacity: '2', oldest_wait_seconds: '45.8',
      average_handle_seconds: '60.4', answered_today: '8',
      answered_in_service_level_today: '6', abandoned_today: '1',
      timed_out_today: '1', overflowed_today: '2', average_wait_seconds_today: '17.3',
      callbacks_pending: '2', callbacks_failed_today: '1', overflows_pending: '3',
      overflows_failed_today: '2'
    }];
    if (sql.includes('callbacks_pending')) return [{
      callbacks_pending: '2', callbacks_failed_today: '1', overflows_pending: '3',
      overflows_failed_today: '2', supervisor_requested: '1', supervisor_active: '1'
    }];
    return [];
  });
  const source = new PostgresContactCenterMonitorSource(pg);

  const result = await source.load('tenant-a', {
    now: '2026-07-13T09:30:00.000Z', day_start: '2026-07-13T00:00:00.000Z',
    day_end: '2026-07-14T00:00:00.000Z'
  });

  assert.equal(result.agents.configured, 4);
  assert.equal(result.calls.active_inbound, 2);
  assert.equal(result.operations.overflows_failed_today, 2);
  assert.equal(result.queues[0]?.available_capacity, 2);
  assert.equal(result.queues[0]?.oldest_wait_seconds, 45);
  assert.equal(result.queues[0]?.average_handle_seconds, 60);
  const queueQuery = pg.queries.find((query) =>
    query.sql.includes('FROM ivekit_cc_queues queue')
  )!;
  assert.match(queueQuery.sql, /NOT EXISTS[\s\S]*ivekit_cc_queue_skill_requirements/);
  assert.deepEqual(queueQuery.params, [
    'tenant-a', '2026-07-13T00:00:00.000Z', '2026-07-14T00:00:00.000Z',
    '2026-07-13T09:30:00.000Z'
  ]);
  const operationQuery = pg.queries.find((query) =>
    query.sql.includes('callbacks_pending') && !query.sql.includes('FROM ivekit_cc_queues queue')
  )!;
  assert.deepEqual(operationQuery.params, [
    'tenant-a', '2026-07-13T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
  ]);
  assert.equal(pg.queries.every((query) =>
    query.sql.includes("set_config('app.current_tenant'") || query.params[0] === 'tenant-a'
  ), true);
});

class MonitorPg implements PgQueryable {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  constructor(private readonly rows: (sql: string, params: unknown[]) => unknown[]) {}

  async query<R extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    const rows = this.rows(sql, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}
