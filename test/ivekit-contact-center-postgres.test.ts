import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';

import {
  PostgresContactCenterRepository,
  PostgresContactCenterUnitOfWork
} from '../src/agent-runtime/ivekit/contact-center/index.js';
import type { PgQueryable } from '../src/db-pg.js';

test('Contact Center PostgreSQL repository decodes queues inside tenant context', async () => {
  const pg = new ScriptedPg((sql) => sql.includes('FROM ivekit_cc_queues queue') ? [queueRow()] : []);
  const store = new PostgresContactCenterRepository(pg);
  const queue = await store.getQueue('tenant-a', 'queue-a', { for_update: true });
  assert.equal(queue?.routing_strategy, 'longest_idle');
  assert.deepEqual(queue?.metadata, { channel: 'voice' });
  assert.ok(pg.queries.some((query) => query.sql.includes("set_config('app.current_tenant'")));
  const select = pg.queries.find((query) => query.sql.includes('FROM ivekit_cc_queues queue'))!;
  assert.deepEqual(select.params, ['tenant-a', 'queue-a']);
  assert.match(select.sql, /FOR UPDATE/);
});

test('Contact Center PostgreSQL claims waiting entries and offers without blocking peers', async () => {
  const pg = new ScriptedPg((sql) => {
    if (sql.includes('FROM ivekit_cc_queue_entries entry')) return [entryRow()];
    if (sql.includes('FROM ivekit_cc_assignments assignment')) return [assignmentRow()];
    return [];
  });
  const store = new PostgresContactCenterRepository(pg);
  assert.equal((await store.getNextWaitingEntry('tenant-a', 'queue-a'))?.id, 'entry-a');
  assert.equal((await store.listExpiredOffers('tenant-a', new Date('2026-07-13T00:01:00.000Z'), 10))[0]?.id, 'assignment-a');
  const entryQuery = pg.queries.find((query) => query.sql.includes('FROM ivekit_cc_queue_entries entry'))!.sql;
  const assignmentQuery = pg.queries.find((query) => query.sql.includes('FROM ivekit_cc_assignments assignment'))!.sql;
  assert.match(entryQuery, /FOR UPDATE SKIP LOCKED/);
  assert.match(assignmentQuery, /FOR UPDATE SKIP LOCKED/);
});

test('Contact Center PostgreSQL locks eligible presence and applies queue skill requirements', async () => {
  const pg = new ScriptedPg((sql) => sql.includes('FROM ivekit_cc_queue_memberships membership') ? [{
    agent_id: 'agent-a', presence_state: 'available', active_voice_count: 0, voice_capacity: 1,
    idle_since: '2026-07-13T00:00:00.000Z', handled_count: '2', member_priority: 4,
    skills: { support: 80 }
  }] : []);
  const candidates = await new PostgresContactCenterRepository(pg).listRoutingCandidates('tenant-a', 'queue-a');
  assert.deepEqual(candidates, [{
    agent_id: 'agent-a', presence_state: 'available', active_voice_count: 0, voice_capacity: 1,
    idle_since: '2026-07-13T00:00:00.000Z', handled_count: 2, member_priority: 4,
    skills: { support: 80 }
  }]);
  const query = pg.queries.find((value) => value.sql.includes('FROM ivekit_cc_queue_memberships membership'))!.sql;
  assert.match(query, /NOT EXISTS[\s\S]*ivekit_cc_queue_skill_requirements/i);
  assert.match(query, /FOR UPDATE OF presence SKIP LOCKED/i);
});

test('Contact Center unit of work exposes one transaction-scoped repository', async () => {
  const pg = new ScriptedPg(() => []);
  const result = await new PostgresContactCenterUnitOfWork(pg).run('tenant-a', async ({ repository }) => {
    assert.ok(repository instanceof PostgresContactCenterRepository);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.ok(pg.queries.some((query) => query.sql.includes("set_config('app.current_tenant'")));
});

class ScriptedPg implements PgQueryable {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  constructor(private readonly rows: (sql: string, params: unknown[]) => Record<string, unknown>[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    this.queries.push({ sql, params });
    const rows = this.rows(sql, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

function queueRow(): Record<string, unknown> {
  return {
    id: 'queue-a', tenant_id: 'tenant-a', name: 'Support', routing_strategy: 'longest_idle',
    max_wait_seconds: 300, max_size: 100, callback_after_seconds: 120,
    overflow_action: 'none', overflow_queue_id: null, overflow_target: '', service_level_seconds: 20,
    status: 'active', metadata: { channel: 'voice' }, revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function entryRow(): Record<string, unknown> {
  return {
    id: 'entry-a', tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', state: 'waiting',
    priority: 0, idempotency_key: 'entry-key', payload_hash: 'a'.repeat(64),
    entered_at: '2026-07-13T00:00:00.000Z', offered_at: null, assigned_at: null,
    answered_at: null, ended_at: null, timeout_at: '2026-07-13T00:05:00.000Z',
    outcome_reason: '', metadata: {}, revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function assignmentRow(): Record<string, unknown> {
  return {
    id: 'assignment-a', tenant_id: 'tenant-a', queue_entry_id: 'entry-a', agent_id: 'agent-a',
    capacity_slot: 1, state: 'offered', attempt: 1, idempotency_key: 'offer-key',
    offer_expires_at: '2026-07-13T00:00:20.000Z', accepted_at: null, connected_at: null,
    completed_at: null, outcome_reason: '', revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}
