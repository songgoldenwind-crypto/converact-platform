import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const probePath = new URL(
  '../services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts',
  import.meta.url
);

test('G03 PostgreSQL restart probe freezes a deterministic cross-process effect identity', async () => {
  assert.equal(
    existsSync(probePath),
    true,
    'missing G03 PostgreSQL restart probe'
  );

  const probe = await import(pathToFileURL(probePath.pathname).href);
  const first = probe.createPostgresRestartFixture('g03-pg-restart-01');
  const second = probe.createPostgresRestartFixture('g03-pg-restart-01');

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first.authority), true);
  assert.equal(Object.isFrozen(first.input.prepared_effect), true);
  assert.equal(first.identity.tenant_id, 'g03-pg-restart-01');
  assert.equal(first.identity.protocol_effect_id, 'g03-effect-g03-pg-restart-01');
  assert.match(first.identity.wire_bytes_hash, /^[a-f0-9]{64}$/u);
  assert.match(first.identity.wire_freeze_sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(first.identity), /password|database_url|secret/iu);
});

test('G03 PostgreSQL restart probe accepts only explicit evidence phases', async () => {
  assert.equal(existsSync(probePath), true, 'missing G03 PostgreSQL restart probe');
  const probe = await import(pathToFileURL(probePath.pathname).href);

  assert.equal(probe.parsePostgresRestartPhase(['prepare']), 'prepare');
  assert.equal(probe.parsePostgresRestartPhase(['recover']), 'recover');
  assert.equal(probe.parsePostgresRestartPhase(['verify']), 'verify');
  assert.equal(probe.parsePostgresRestartPhase(['cleanup']), 'cleanup');
  assert.throws(
    () => probe.parsePostgresRestartPhase([]),
    /g03_postgres_restart_phase_invalid/u
  );
  assert.throws(
    () => probe.parsePostgresRestartPhase(['prepare', 'extra']),
    /g03_postgres_restart_phase_invalid/u
  );
  assert.throws(
    () => probe.parsePostgresRestartPhase(['unknown']),
    /g03_postgres_restart_phase_invalid/u
  );
});

test('G03 PostgreSQL restart cleanup removes child receipts before the tenant cascade', async () => {
  assert.equal(existsSync(probePath), true, 'missing G03 PostgreSQL restart probe');
  const probe = await import(pathToFileURL(probePath.pathname).href);
  assert.equal(
    typeof probe.createPostgresRestartBinding,
    'function',
    'missing G03 PostgreSQL restart campaign binding'
  );
  assert.equal(
    typeof probe.createPostgresRestartCleanupPlan,
    'function',
    'missing G03 PostgreSQL restart cleanup plan'
  );

  const binding = probe.createPostgresRestartBinding(
    'g03-pg-restart-01',
    '1'.repeat(40)
  );
  assert.equal(binding.database_name, 'converact_g03_g03_pg_restart_01');
  assert.match(binding.confirmation_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(binding.tenant_marker.goal_id, 'G03');
  assert.equal(binding.tenant_marker.run_id, 'g03-pg-restart-01');
  assert.equal(binding.tenant_marker.source_commit, '1'.repeat(40));
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.tenant_marker), true);

  const plan = probe.createPostgresRestartCleanupPlan(binding);
  assert.equal(plan.length, 4);
  assert.match(plan[0].sql, /^DELETE FROM ivekit_sip_effect_receipts/u);
  assert.match(plan[0].sql, /protocol_effect_id = \$2/u);
  assert.match(plan[1].sql, /^DELETE FROM tenants/u);
  assert.match(plan[1].sql, /name = \$2 AND settings = \$3::jsonb/u);
  assert.match(plan[2].sql, /activation_receipt_id = \$2/u);
  assert.match(plan[3].sql, /activation_receipt_id = \$3/u);
  assert.deepEqual(plan.map((statement: { expected_row_count: number }) =>
    statement.expected_row_count), [4, 1, 1, 1]);
  assert.deepEqual(plan[0].params, [
    'g03-pg-restart-01',
    'g03-effect-g03-pg-restart-01'
  ]);
  assert.deepEqual(plan[1].params, [
    'g03-pg-restart-01',
    'G03 PostgreSQL restart g03-pg-restart-01',
    JSON.stringify(binding.tenant_marker)
  ]);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan[0]), true);
});

test('G03 PostgreSQL restart verifier requires a real server restart and distinct process', async () => {
  const probe = await import(pathToFileURL(probePath.pathname).href);
  assert.equal(
    typeof probe.verifyPostgresRestartEvidence,
    'function',
    'missing G03 PostgreSQL restart evidence verifier'
  );
  const binding = probe.createPostgresRestartBinding(
    'g03-pg-restart-01',
    '2'.repeat(40)
  );
  const prepared = {
    status: 'passed',
    phase: 'prepare',
    process_instance_id: '11111111-1111-4111-8111-111111111111',
    campaign_binding: binding,
    postgres_identity: {
      system_identifier: '7555511111111111111',
      postmaster_start_time: '2026-08-02 01:00:00+00'
    },
    state: 'transport_accepted',
    revision: '4',
    last_receipt_id: binding.accepted_receipt_id,
    production_eligible: false
  };
  const recovered = {
    status: 'passed',
    phase: 'recover',
    process_instance_id: '22222222-2222-4222-8222-222222222222',
    campaign_binding: binding,
    postgres_identity: {
      system_identifier: '7555511111111111111',
      postmaster_start_time: '2026-08-02 01:01:00+00'
    },
    prepare_replayed: true,
    accepted_receipt_replayed: true,
    recovered_state: 'transport_accepted',
    recovered_revision: '4',
    observed_state: 'protocol_observed',
    observed_revision: '5',
    replay_revision: '5',
    effect_count: 1,
    receipt_count: 4,
    production_eligible: false
  };

  const verified = probe.verifyPostgresRestartEvidence(
    binding,
    prepared,
    recovered
  );
  assert.equal(verified.status, 'passed');
  assert.equal(verified.restart_confirmed, true);
  assert.equal(verified.pre_restart_effect_replay_confirmed, true);
  assert.equal(Object.isFrozen(verified), true);
  assert.throws(
    () => probe.verifyPostgresRestartEvidence(binding, prepared, {
      ...recovered,
      postgres_identity: prepared.postgres_identity
    }),
    /g03_postgres_restart_not_observed/u
  );
  assert.throws(
    () => probe.verifyPostgresRestartEvidence(binding, prepared, {
      ...recovered,
      postgres_identity: {
        ...recovered.postgres_identity,
        system_identifier: '7555599999999999999'
      }
    }),
    /g03_postgres_restart_system_identifier_changed/u
  );
  assert.throws(
    () => probe.verifyPostgresRestartEvidence(binding, prepared, {
      ...recovered,
      process_instance_id: prepared.process_instance_id
    }),
    /g03_postgres_restart_process_not_replaced/u
  );
  assert.throws(
    () => probe.verifyPostgresRestartEvidence(binding, prepared, {
      ...recovered,
      prepare_replayed: false
    }),
    /g03_postgres_restart_pre_restart_replay_missing/u
  );
});

test('G03 PostgreSQL restart recovery replays pre-restart prepare and acceptance receipts', async () => {
  const probe = await import(pathToFileURL(probePath.pathname).href);
  assert.equal(
    typeof probe.replayPostgresRestartEffect,
    'function',
    'missing G03 PostgreSQL pre-restart replay helper'
  );
  const binding = probe.createPostgresRestartBinding(
    'g03-pg-restart-01',
    '3'.repeat(40)
  );
  const fixture = probe.createPostgresRestartFixture(binding.run_id);
  const calls: string[] = [];
  const accepted = Object.freeze({
    state: 'transport_accepted' as const,
    revision: '4',
    last_receipt_id: binding.accepted_receipt_id
  });
  const observed = Object.freeze({
    state: 'protocol_observed' as const,
    revision: '5',
    last_receipt_id: binding.observed_receipt_id
  });
  const oracle = {
    async query() {
      calls.push('query');
      return accepted;
    },
    async prepare() {
      calls.push('prepare');
      return { effect: accepted, replayed: true };
    },
    async recordTransportAccepted() {
      calls.push('transport_accepted');
      return accepted;
    },
    async recordProtocolObserved() {
      calls.push('protocol_observed');
      return observed;
    }
  };

  const result = await probe.replayPostgresRestartEffect(
    oracle,
    fixture,
    binding
  );
  assert.deepEqual(calls, [
    'query',
    'prepare',
    'transport_accepted',
    'protocol_observed',
    'protocol_observed'
  ]);
  assert.equal(result.prepare_replayed, true);
  assert.equal(result.accepted_receipt_replayed, true);
  assert.equal(result.recovered_revision, '4');
  assert.equal(result.observed_revision, '5');
  assert.equal(result.replay_revision, '5');
});

test('G03 PostgreSQL restart probe freezes database and phase deadlines', async () => {
  const probe = await import(pathToFileURL(probePath.pathname).href);
  assert.deepEqual(probe.POSTGRES_RESTART_DATABASE_LIMITS, {
    connection_timeout_ms: 2_000,
    statement_timeout_ms: 2_000,
    lock_timeout_ms: 1_000,
    query_timeout_ms: 2_500,
    phase_timeout_ms: 15_000
  });
  assert.equal(Object.isFrozen(probe.POSTGRES_RESTART_DATABASE_LIMITS), true);
  const source = readFileSync(probePath, 'utf8');
  assert.match(source, /statement_timeout:\s*POSTGRES_RESTART_DATABASE_LIMITS\.statement_timeout_ms/u);
  assert.match(source, /lock_timeout:\s*POSTGRES_RESTART_DATABASE_LIMITS\.lock_timeout_ms/u);
  assert.match(source, /query_timeout:\s*POSTGRES_RESTART_DATABASE_LIMITS\.query_timeout_ms/u);
  assert.match(source, /withPostgresRestartPhaseDeadline/u);
  assert.match(source, /SET LOCAL statement_timeout/u);
  assert.match(source, /SET LOCAL lock_timeout/u);
  assert.doesNotMatch(source, /Promise\.race\(\[operation\(\), deadline\]\)/u);
  assert.match(source, /process\.exit\(124\)/u);
});

test('G03 PostgreSQL restart baseline is sampled after the accepted effect write', async () => {
  const source = readFileSync(probePath, 'utf8');
  const prepareStart = source.indexOf('async function prepare(');
  const recoverStart = source.indexOf('async function recover(');
  const prepareSource = source.slice(prepareStart, recoverStart);
  const acceptedWrite = prepareSource.indexOf(
    'await oracle.recordTransportAccepted('
  );
  const identityRead = prepareSource.indexOf(
    'const postgresIdentity = await readDatabaseIdentity(admin);'
  );
  assert.ok(acceptedWrite >= 0, 'missing accepted Effect write');
  assert.ok(identityRead >= 0, 'missing prepare PostgreSQL identity read');
  assert.ok(
    identityRead > acceptedWrite,
    'PostgreSQL identity must be sampled after all durable prepare writes'
  );
});

test('G03 PostgreSQL runtime-role initialization stays on one checked-out client', async () => {
  const source = readFileSync(probePath, 'utf8');
  const prepareStart = source.indexOf('async function prepare(');
  const recoverStart = source.indexOf('async function recover(');
  const prepareSource = source.slice(prepareStart, recoverStart);
  assert.match(prepareSource, /const bootstrapClient = await admin\.connect\(\)/u);
  assert.match(
    prepareSource,
    /initializeConveractFabricRuntimeRole\(\s*bootstrapClient,/u
  );
  assert.match(prepareSource, /bootstrapClient\.release\(\)/u);
  assert.doesNotMatch(
    prepareSource,
    /initializeConveractFabricRuntimeRole\(admin,/u
  );
});
