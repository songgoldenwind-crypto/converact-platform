import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';

import {
  ContactCenterError,
  PostgresContactCenterConfigurationStore,
  PostgresContactCenterConfigurationUnitOfWork,
  PostgresContactCenterRepository,
  PostgresContactCenterUnitOfWork,
  type ContactCenterAgent,
  type ContactCenterAgentPresence,
  type ContactCenterCallbackRecord,
  type ContactCenterQueue,
  type ContactCenterSupervisorSession
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

test('Contact Center PostgreSQL claims expired waiting entries and lists active queues', async () => {
  const pg = new ScriptedPg((sql) => {
    if (sql.includes("entry.state = 'waiting'") && sql.includes('entry.timeout_at <=')) {
      return [entryRow()];
    }
    if (sql.includes('SELECT queue.id')) return [{ id: 'queue-a' }, { id: 'queue-b' }];
    return [];
  });
  const store = new PostgresContactCenterRepository(pg);
  const now = new Date('2026-07-13T00:06:00.000Z');
  assert.equal((await store.listExpiredWaitingEntries('tenant-a', now, 10))[0]?.id, 'entry-a');
  assert.deepEqual(await store.listRoutableQueueIds('tenant-a', now, 10), ['queue-a', 'queue-b']);

  const expired = pg.queries.find((query) => query.sql.includes('entry.timeout_at <='))!;
  assert.match(expired.sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(expired.params, ['tenant-a', now, 10]);
  const queues = pg.queries.find((query) => query.sql.includes('SELECT queue.id'))!;
  assert.match(queues.sql, /queue.status = 'active'/);
  assert.match(queues.sql, /entry.state = 'waiting'/);
  assert.deepEqual(queues.params, ['tenant-a', now, 10]);
});

test('Contact Center PostgreSQL pages queue entries and batches assignment history', async () => {
  const pg = new ScriptedPg((sql) => {
    if (sql.includes('FROM ivekit_cc_queue_entries entry')) return [entryRow()];
    if (sql.includes('FROM ivekit_cc_assignments assignment')) return [assignmentRow()];
    return [];
  });
  const store = new PostgresContactCenterRepository(pg);
  const page = await store.listEntries({
    tenant_id: 'tenant-a', queue_id: 'queue-a', state: 'waiting', limit: 10
  });
  assert.equal(page.items[0]?.id, 'entry-a');
  assert.equal(page.next_cursor, null);
  const assignments = await store.listAssignmentsForEntries('tenant-a', ['entry-a']);
  assert.equal(assignments[0]?.id, 'assignment-a');
  const list = pg.queries.find((query) => query.sql.includes('FROM ivekit_cc_queue_entries entry'))!;
  assert.match(list.sql, /ORDER BY entry\.entered_at DESC, entry\.id DESC/);
  assert.deepEqual(list.params.slice(0, 3), ['tenant-a', 'queue-a', 'waiting']);
  const history = pg.queries.find((query) => query.sql.includes('queue_entry_id = ANY'))!;
  assert.deepEqual(history.params, ['tenant-a', ['entry-a']]);
});

test('Contact Center queue entry cursors cannot cross queue or state scope', async () => {
  const pg = new ScriptedPg((sql) => sql.includes('FROM ivekit_cc_queue_entries entry') ? [
    { ...entryRow(), id: 'entry-b', entered_at: '2026-07-13T00:00:01.000Z' },
    entryRow()
  ] : []);
  const store = new PostgresContactCenterRepository(pg);
  const first = await store.listEntries({
    tenant_id: 'tenant-a', queue_id: 'queue-a', state: 'waiting', limit: 1
  });
  assert.ok(first.next_cursor);
  await assert.rejects(
    async () => store.listEntries({
      tenant_id: 'tenant-a', queue_id: 'queue-b', state: 'waiting', limit: 1,
      cursor: first.next_cursor!
    }),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'validation_failed'
  );
  await assert.rejects(
    async () => store.listEntries({
      tenant_id: 'tenant-a', queue_id: 'queue-a', state: 'completed', limit: 1,
      cursor: first.next_cursor!
    }),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'validation_failed'
  );
});

test('Contact Center PostgreSQL persists protected callbacks and pages safe records', async () => {
  const pg = new ScriptedPg((sql) => {
    if (sql.includes('INSERT INTO ivekit_cc_callbacks')) return [callbackRow()];
    if (sql.includes('FROM ivekit_cc_callbacks callback')) return [callbackRow()];
    if (sql.includes("assignment.state IN ('offered', 'accepted', 'connected')")) {
      return [assignmentRow()];
    }
    return [];
  });
  const store = new PostgresContactCenterRepository(pg);
  const inserted = await store.insertCallback(callbackEntity());
  assert.equal(inserted.address_redacted, '+86******9000');
  assert.equal((await store.getActiveAssignmentForEntry(
    'tenant-a', 'entry-a', { for_update: true }
  ))?.id, 'assignment-a');
  const page = await store.listCallbacks({
    tenant_id: 'tenant-a', queue_id: 'queue-a', state: 'scheduled', limit: 10
  });
  assert.equal(page.items[0]?.id, 'callback-a');
  const now = new Date('2026-07-13T00:05:00.000Z');
  assert.equal((await store.getNextDueCallback('tenant-a', now))?.id, 'callback-a');
  assert.equal((await store.listCallbacksForReconciliation('tenant-a', 10))[0]?.id, 'callback-a');
  const insert = pg.queries.find((query) => query.sql.includes('INSERT INTO ivekit_cc_callbacks'))!;
  assert.equal(insert.params[9], 'v1.encrypted.callback');
  assert.equal(JSON.stringify(insert.params).includes('+8613900139000'), false);
  const list = pg.queries.find((query) => query.sql.includes('FROM ivekit_cc_callbacks callback'))!;
  assert.match(list.sql, /ORDER BY callback\.created_at DESC, callback\.id DESC/);
  assert.deepEqual(list.params.slice(0, 3), ['tenant-a', 'queue-a', 'scheduled']);
  const active = pg.queries.find((query) =>
    query.sql.includes("assignment.state IN ('offered', 'accepted', 'connected')")
  )!;
  assert.match(active.sql, /FOR UPDATE/);
  const due = pg.queries.find((query) =>
    query.sql.includes("callback.state IN ('requested', 'scheduled')")
  )!;
  assert.match(due.sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(due.params, ['tenant-a', now]);
  const reconcile = pg.queries.find((query) =>
    query.sql.includes("callback.state IN ('dialing', 'connected')")
  )!;
  assert.match(reconcile.sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(reconcile.params, ['tenant-a', 10]);
});

test('Contact Center PostgreSQL persists supervisor sessions only for assigned calls', async () => {
  const pg = new ScriptedPg((sql) => {
    if (sql.includes('SELECT EXISTS') && sql.includes('ivekit_cc_assignments')) {
      return [{ assigned: true }];
    }
    if (sql.includes('INSERT INTO ivekit_cc_supervisor_sessions')) return [supervisorRow()];
    if (sql.includes('UPDATE ivekit_cc_supervisor_sessions')) {
      return [{ ...supervisorRow(), state: 'active', provider_session_id: 'provider-a', revision: 2 }];
    }
    if (sql.includes('FROM ivekit_cc_supervisor_sessions supervisor')) return [supervisorRow()];
    return [];
  });
  const store = new PostgresContactCenterRepository(pg);
  assert.equal(await store.isAgentAssignedToCall('tenant-a', 'call-a', 'agent-a'), true);
  assert.equal((await store.insertSupervisorSession(supervisorEntity())).id, 'supervisor-a');
  assert.equal((await store.getSupervisorSession(
    'tenant-a', 'supervisor-a', { for_update: true }
  ))?.authorization_ref, 'policy:42');
  const active = await store.updateSupervisorSession({
    ...supervisorEntity(), state: 'active', provider_session_id: 'provider-a',
    started_at: '2026-07-13T00:00:01.000Z', updated_at: '2026-07-13T00:00:01.000Z'
  }, 1);
  assert.equal(active.state, 'active');

  const assignment = pg.queries.find((query) => query.sql.includes('SELECT EXISTS'))!;
  assert.match(assignment.sql, /entry\.call_id = \$2/);
  assert.match(assignment.sql, /assignment\.state IN \('accepted', 'connected'\)/);
  assert.deepEqual(assignment.params, ['tenant-a', 'call-a', 'agent-a']);
  const insert = pg.queries.find((query) =>
    query.sql.includes('INSERT INTO ivekit_cc_supervisor_sessions')
  )!;
  assert.equal(insert.params[7], 'policy:42');
  const locked = pg.queries.find((query) =>
    query.sql.includes('FROM ivekit_cc_supervisor_sessions supervisor')
  )!;
  assert.match(locked.sql, /FOR UPDATE/);
  const update = pg.queries.find((query) =>
    query.sql.includes('UPDATE ivekit_cc_supervisor_sessions')
  )!;
  assert.match(update.sql, /revision = revision \+ 1/);
  assert.equal(update.params.at(-1), 1);
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

test('Contact Center configuration store creates agent and presence atomically', async () => {
  const pg = new ScriptedPg((sql) => sql.includes('INSERT INTO ivekit_cc_agents') ? [agentRow()] : []);
  const store = new PostgresContactCenterConfigurationStore(pg);
  const created = await store.insertAgent(agentEntity(), presenceEntity());
  assert.equal(created.identity, 'agent-a');
  const agentInsert = pg.queries.find((query) => query.sql.includes('INSERT INTO ivekit_cc_agents'))!;
  const presenceInsert = pg.queries.find((query) => query.sql.includes('INSERT INTO ivekit_cc_agent_presence'))!;
  assert.equal(agentInsert.params[1], 'tenant-a');
  assert.deepEqual(presenceInsert.params.slice(0, 3), ['tenant-a', 'agent-a', 'offline']);
});

test('Contact Center configuration serializes and persists idempotency receipts', async () => {
  const receipt = {
    tenant_id: 'tenant-a', idempotency_key: 'create-agent-a', resource_type: 'agent',
    payload_hash: 'a'.repeat(64), resource_id: 'agent-a',
    created_at: '2026-07-13T00:00:00.000Z'
  } as const;
  const pg = new ScriptedPg((sql) => {
    if (sql.includes('INSERT INTO ivekit_cc_configuration_idempotency')) return [receipt];
    if (sql.includes('FROM ivekit_cc_configuration_idempotency')) return [receipt];
    return [];
  });
  const store = new PostgresContactCenterConfigurationStore(pg);
  await store.lockIdempotencyKey('tenant-a', receipt.idempotency_key);
  assert.deepEqual(await store.insertIdempotencyRecord(receipt), receipt);
  assert.deepEqual(await store.findIdempotencyRecord('tenant-a', receipt.idempotency_key), receipt);
  const lock = pg.queries.find((query) => query.sql.includes('pg_advisory_xact_lock'))!;
  assert.equal(lock.params[0], 'ivekit:cc:configuration:tenant-a:create-agent-a');
});

test('Contact Center configuration cursors are bound to tenant resource and filter', async () => {
  const rows = [skillRow('skill-c'), skillRow('skill-b'), skillRow('skill-a')];
  const pg = new ScriptedPg((sql) => sql.includes('FROM ivekit_cc_skills skill') ? rows : []);
  const store = new PostgresContactCenterConfigurationStore(pg);
  const first = await store.listSkills({ tenant_id: 'tenant-a', status: 'active', limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), ['skill-c', 'skill-b']);
  assert.ok(first.next_cursor);
  await store.listSkills({
    tenant_id: 'tenant-a', status: 'active', limit: 2, cursor: first.next_cursor!
  });
  const listQueries = pg.queries.filter((query) => query.sql.includes('FROM ivekit_cc_skills skill'));
  assert.equal(listQueries[1]!.params[1], 'active');
  assert.equal(listQueries[1]!.params[3], 'skill-b');
  await assert.rejects(
    () => store.listSkills({
      tenant_id: 'tenant-a', status: 'disabled', limit: 2, cursor: first.next_cursor!
    }),
    (error: unknown) => error instanceof ContactCenterError && error.status === 400
  );
});

test('Contact Center configuration replaces skill sets with structured PostgreSQL input', async () => {
  const pg = new ScriptedPg(() => []);
  const store = new PostgresContactCenterConfigurationStore(pg);
  await store.replaceAgentSkills('tenant-a', 'agent-a', [
    { skill_id: 'sales', proficiency: 90 }
  ], '2026-07-13T00:00:00.000Z');
  const insert = pg.queries.find((query) => query.sql.includes('jsonb_to_recordset'))!;
  assert.match(insert.sql, /AS input\(skill_id text, proficiency integer\)/);
  assert.equal(insert.params[0], 'tenant-a');
  assert.equal(insert.params[1], 'agent-a');
  assert.equal(insert.params[2], '[{"skill_id":"sales","proficiency":90}]');
});

test('Contact Center configuration updates queues with revision compare-and-swap', async () => {
  const pg = new ScriptedPg((sql) => sql.includes('UPDATE ivekit_cc_queues') ? [queueRow()] : []);
  const queue = queueEntity();
  const updated = await new PostgresContactCenterConfigurationStore(pg).updateQueue(queue, 4);
  assert.equal(updated.id, 'queue-a');
  const query = pg.queries.find((value) => value.sql.includes('UPDATE ivekit_cc_queues'))!;
  assert.match(query.sql, /revision = revision \+ 1/);
  assert.equal(query.params.at(-1), 4);
});

test('Contact Center configuration unit of work exposes the tenant-scoped store', async () => {
  const pg = new ScriptedPg(() => []);
  const result = await new PostgresContactCenterConfigurationUnitOfWork(pg).run(
    'tenant-a', async (repository) => repository instanceof PostgresContactCenterConfigurationStore
  );
  assert.equal(result, true);
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
    created_by: 'admin-a', updated_by: 'admin-a',
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

function callbackRow(): Record<string, unknown> {
  return { ...callbackEntity() };
}

function callbackEntity(): ContactCenterCallbackRecord {
  return {
    id: 'callback-a', tenant_id: 'tenant-a', queue_id: 'queue-a',
    queue_entry_id: 'entry-a', source_call_id: 'call-a', outbound_call_id: null,
    business_ref_type: 'ticket', business_ref_id: 'ticket-a', address_kind: 'e164',
    address_ciphertext: 'v1.encrypted.callback', address_hmac: 'b'.repeat(64),
    address_redacted: '+86******9000', state: 'scheduled',
    scheduled_for: '2026-07-13T00:05:00.000Z', attempt_count: 0, max_attempts: 3,
    idempotency_key: 'callback-key-a', requested_by: 'agent-a', cancelled_by: '',
    failure_code: '', revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z',
    completed_at: null
  };
}

function supervisorRow(): Record<string, unknown> {
  return { ...supervisorEntity() };
}

function supervisorEntity(): ContactCenterSupervisorSession {
  return {
    id: 'supervisor-a', tenant_id: 'tenant-a', call_id: 'call-a',
    target_agent_id: 'agent-a', supervisor_identity: 'admin-a', mode: 'whisper',
    state: 'requested', authorization_ref: 'policy:42', idempotency_key: 'supervisor-key-a',
    provider_session_id: '', reason: '', requested_at: '2026-07-13T00:00:00.000Z',
    started_at: null, ended_at: null, revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function skillRow(id: string): Record<string, unknown> {
  return {
    id, tenant_id: 'tenant-a', name: id, description: '', status: 'active', revision: 1,
    created_by: 'admin-a', updated_by: 'admin-a',
    created_at: `2026-07-13T00:00:0${id.endsWith('a') ? 1 : id.endsWith('b') ? 2 : 3}.000Z`,
    updated_at: '2026-07-13T00:00:03.000Z'
  };
}

function agentRow(): Record<string, unknown> {
  return { ...agentEntity() };
}

function agentEntity(): ContactCenterAgent {
  return {
    id: 'agent-a', tenant_id: 'tenant-a', identity: 'agent-a', display_name: 'Agent A',
    voice_extension_id: null, status: 'active', voice_capacity: 1, metadata: {}, revision: 1,
    created_by: 'admin-a', updated_by: 'admin-a',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function presenceEntity(): ContactCenterAgentPresence {
  return {
    tenant_id: 'tenant-a', agent_id: 'agent-a', state: 'offline', active_voice_count: 0,
    voice_capacity: 1, current_call_id: null, idle_since: null, heartbeat_at: null,
    session_ref: '', revision: 1, updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function queueEntity(): ContactCenterQueue {
  return {
    id: 'queue-a', tenant_id: 'tenant-a', name: 'Support', routing_strategy: 'longest_idle',
    max_wait_seconds: 300, max_size: 100, callback_after_seconds: 120,
    overflow_action: 'none', overflow_queue_id: null, overflow_target: '', service_level_seconds: 20,
    status: 'active', metadata: {}, revision: 5, created_by: 'admin-a', updated_by: 'admin-a',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}
