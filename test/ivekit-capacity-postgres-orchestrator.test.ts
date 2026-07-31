import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalSha256 } from '../scripts/capacity/canonical-json.js';
import {
  LoadRunControlError,
  PostgresCapacityLoadRunRepository
} from '../scripts/capacity/orchestrator/index.js';

test('postgres shard assignment is atomic, skip-locked and writes its command outbox', async () => {
  const pg = new QueryStub([{
    run_id: 'run-a',
    phase_id: 'steady',
    shard_id: 'shard-a',
    worker_id: 'worker-a',
    fleet_id: 'tinode',
    lease_epoch: '9007199254740993',
    lease_expires_at: '2026-07-16T08:00:10.000Z',
    workload_domain: 'interaction',
    workload_id: 'tinode-im',
    workload_kind: 'tinode_im',
    ordinal_start: 0,
    ordinal_end_exclusive: 1000,
    expected_count: 1000,
    covered_workloads: [],
    required_protocols: ['tinode_websocket'],
    seed: 'seed-a'
  }]);
  const repository = new PostgresCapacityLoadRunRepository(pg as any, {
    id: () => 'command-a'
  });

  const assignment = await repository.assignNextShard({
    run_id: 'run-a',
    phase_id: 'steady',
    worker_id: 'worker-a',
    fleet_id: 'tinode',
    lease_ttl_ms: 10_000,
    now: '2026-07-16T08:00:00.000Z'
  });

  assert.equal(assignment?.lease_epoch, '9007199254740993');
  assert.deepEqual(assignment?.covered_workloads, []);
  assert.match(pg.calls[0]?.text || '', /FOR UPDATE OF shard, worker SKIP LOCKED/i);
  assert.match(pg.calls[0]?.text || '', /lease_epoch\s*=\s*selected\.lease_epoch\s*\+\s*1/i);
  assert.match(pg.calls[0]?.text || '', /INSERT INTO ivekit_capacity_command_outbox/i);
  assert.match(pg.calls[0]?.text || '', /assigned_load\s*=\s*worker\.assigned_load\s*\+/i);
  assert.match(pg.calls[0]?.text || '', /SELECT\s+\$7::text,\s*assigned\.run_id/i);
  assert.match(pg.calls[0]?.text || '', /'command_id',\s*\$7::text/i);
  assert.match(pg.calls[0]?.text || '', /'covered_workloads',\s*assigned\.covered_workloads/i);
  assert.match(pg.calls[0]?.text || '', /\$8::text,\s*jsonb_build_object/i);
});

test('postgres completion rejects a stale worker or lease epoch', async () => {
  const pg = new QueryStub([]);
  const repository = new PostgresCapacityLoadRunRepository(pg as any);

  await assert.rejects(
    () => repository.completeShard({
      run_id: 'run-a',
      phase_id: 'steady',
      shard_id: 'shard-a',
      worker_id: 'worker-old',
      lease_epoch: '2',
      outcome: 'completed',
      evidence_id: 'evidence-a',
      error_code: '',
      now: '2026-07-16T08:00:11.000Z'
    }),
    (error: unknown) => error instanceof LoadRunControlError && error.code === 'stale_shard_lease'
  );
  assert.match(pg.calls[0]?.text || '', /phase_id\s*=\s*\$2/i);
  assert.match(pg.calls[0]?.text || '', /lease_owner\s*=\s*\$4/i);
  assert.match(pg.calls[0]?.text || '', /lease_epoch\s*=\s*\$5::bigint/i);
  assert.match(pg.calls[0]?.text || '', /lease_expires_at\s*>\s*\$9::timestamptz/i);
});

test('postgres lease renewal atomically claims execution only from leased state', async () => {
  const pg = new QueryStub([{
    run_id: 'run-a',
    phase_id: 'steady',
    shard_id: 'shard-a',
    worker_id: 'worker-a',
    fleet_id: 'tinode',
    lease_epoch: '3',
    lease_expires_at: '2026-07-16T08:00:20.000Z',
    workload_domain: 'interaction',
    workload_id: 'tinode-im',
    workload_kind: 'tinode_im',
    ordinal_start: 0,
    ordinal_end_exclusive: 1000,
    expected_count: 1000,
    required_protocols: ['tinode_websocket'],
    seed: 'seed-a',
    execution_claimed: true,
    execution_state: 'running',
    execution_result: {},
    execution_result_sha256: ''
  }]);
  const repository = new PostgresCapacityLoadRunRepository(pg as any);
  const renewal = await repository.renewShardLease({
    run_id: 'run-a',
    phase_id: 'steady',
    shard_id: 'shard-a',
    worker_id: 'worker-a',
    lease_epoch: '3',
    lease_ttl_ms: 10_000,
    now: '2026-07-16T08:00:10.000Z'
  });
  assert.equal(renewal.execution_claimed, true);
  assert.match(pg.calls[0]?.text || '', /FOR UPDATE/i);
  assert.match(
    pg.calls[0]?.text || '',
    /\(selected\.state\s*=\s*'leased'\)\s+AS execution_claimed/i
  );
  assert.equal(renewal.execution_checkpoint?.state, 'running');
});

test('postgres persists a fenced generator result checkpoint before evidence publication', async () => {
  const result = {
    schema_version: '1.0.0' as const,
    outcome: 'completed' as const,
    error_code: '',
    evidence_kind: 'tinode_shard_result',
    evidence: { status: 'controlled_pass' }
  };
  const pg = new QueryStub([{
    execution_state: 'result_ready',
    execution_result: result,
    execution_result_sha256: canonicalSha256(result)
  }]);
  const repository = new PostgresCapacityLoadRunRepository(pg as any);

  const checkpoint = await repository.saveShardExecutionResult({
    run_id: 'run-a',
    phase_id: 'steady',
    shard_id: 'shard-a',
    worker_id: 'worker-a',
    lease_epoch: '3',
    result,
    result_sha256: canonicalSha256(result),
    now: '2026-07-16T08:00:11.000Z'
  });

  assert.equal(checkpoint.state, 'result_ready');
  assert.match(pg.calls[0]?.text || '', /execution_state\s*=\s*'result_ready'/i);
  assert.match(pg.calls[0]?.text || '', /lease_owner\s*=\s*\$4/i);
  assert.match(pg.calls[0]?.text || '', /lease_epoch\s*=\s*\$5::bigint/i);
  assert.match(pg.calls[0]?.text || '', /lease_expires_at\s*>\s*\$8::timestamptz/i);
});

test('postgres controller claims increment epochs only after expiry or owner change', async () => {
  const pg = new QueryStub([{
    run_id: 'run-a',
    controller_id: 'controller-b',
    lease_epoch: '12',
    lease_expires_at: '2026-07-16T08:00:15.000Z'
  }]);
  const repository = new PostgresCapacityLoadRunRepository(pg as any);
  const lease = await repository.claimController({
    run_id: 'run-a',
    controller_id: 'controller-b',
    lease_ttl_ms: 15_000,
    now: '2026-07-16T08:00:00.000Z'
  });

  assert.equal(lease.lease_epoch, '12');
  assert.match(pg.calls[0]?.text || '', /controller_lease_epoch\s*\+\s*1/i);
  assert.match(pg.calls[0]?.text || '', /controller_lease_expires_at\s*<=\s*\$3::timestamptz/i);
  assert.match(
    pg.calls[0]?.text || '',
    /controller_lease_expires_at\s+AS\s+lease_expires_at/i
  );
});

test('postgres exposes restart-safe run and phase controller state', async () => {
  const runPg = new QueryStub([{
    state: 'running',
    current_phase_id: 'steady',
    manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: '',
    outcome: ''
  }]);
  const repository = new PostgresCapacityLoadRunRepository(runPg as any);
  assert.deepEqual(await repository.readRunControlState({ run_id: 'run-a' }), {
    state: 'running',
    current_phase_id: 'steady',
    manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: '',
    outcome: ''
  });

  const phasePg = new QueryStub([{
    phase_id: 'steady',
    state: 'running',
    total_shards: 10,
    completed_shards: 8,
    failed_shards: 1,
    cancelled_shards: 0,
    not_run_shards: 0,
    active_shards: 1
  }]);
  const phaseRepository = new PostgresCapacityLoadRunRepository(phasePg as any);
  assert.deepEqual(await phaseRepository.readPhaseProgress({
    run_id: 'run-a',
    phase_id: 'steady'
  }), {
    phase_id: 'steady',
    state: 'running',
    total_shards: 10,
    completed_shards: 8,
    failed_shards: 1,
    cancelled_shards: 0,
    not_run_shards: 0,
    active_shards: 1
  });
  assert.match(phasePg.calls[0]?.text || '', /FILTER \(WHERE shard\.state = 'completed'\)/i);
});

test('postgres phase start enforces schedule and records the first run start time', async () => {
  const pg = new QueryStub([{ phase_id: 'steady' }]);
  const repository = new PostgresCapacityLoadRunRepository(pg as any);
  await repository.startPhase({
    run_id: 'run-a',
    phase_id: 'steady',
    controller_id: 'controller-a',
    controller_lease_epoch: '2',
    now: '2026-07-16T08:00:00.000Z'
  });
  assert.match(pg.calls[0]?.text || '', /start_not_before\s*<=\s*\$5::timestamptz/i);
  assert.match(pg.calls[0]?.text || '', /started_at\s*=\s*COALESCE\(run\.started_at/i);
});

test('postgres worker heartbeat clamps future timestamps to bounded clock skew', async () => {
  const pg = new QueryStub([{ worker_id: 'worker-a' }]);
  const repository = new PostgresCapacityLoadRunRepository(pg as any);
  await repository.heartbeatWorker({
    run_id: 'run-a',
    worker_id: 'worker-a',
    fleet_id: 'tinode',
    release_id: 'loadgen@abc123',
    state: 'online',
    safe_capacity: 1000,
    reported_load: 0,
    observed_at: '2099-07-16T08:00:00.000Z',
    metadata: {}
  });
  assert.match(
    pg.calls[0]?.text || '',
    /LEAST\(\$9::timestamptz,\s*clock_timestamp\(\)\s*\+\s*INTERVAL '5 seconds'\)/i
  );
  assert.match(
    pg.calls[0]?.text || '',
    /manifest->>'generator_release_id'\s*=\s*\$4/i
  );
});

test('postgres worker schedules only after checking its durable outstanding shard load', async () => {
  const pg = new QueryStub([{ shard_count: 1, reported_load: 1000 }]);
  const repository = new PostgresCapacityLoadRunRepository(pg as any);
  const outstanding = await repository.readWorkerOutstanding({
    run_id: 'run-a',
    phase_id: 'steady',
    worker_id: 'worker-a',
    fleet_id: 'tinode',
    now: '2026-07-16T08:00:00.000Z'
  });

  assert.deepEqual(outstanding, { shard_count: 1, reported_load: 1000 });
  assert.match(pg.calls[0]?.text || '', /\$2 = '' OR phase_id = \$2/i);
  assert.match(pg.calls[0]?.text || '', /lease_owner\s*=\s*\$3/i);
  assert.match(pg.calls[0]?.text || '', /state IN \('leased', 'running'\)/i);
  assert.match(pg.calls[0]?.text || '', /lease_expires_at\s*>\s*\$5::timestamptz/i);
});

test('postgres exposes the current run phase for dynamic worker scheduling', async () => {
  const pg = new QueryStub([{ state: 'running', current_phase_id: 'steady' }]);
  const repository = new PostgresCapacityLoadRunRepository(pg as any);

  assert.deepEqual(await repository.readRunSchedulingState({ run_id: 'run-a' }), {
    state: 'running',
    current_phase_id: 'steady'
  });
  assert.match(pg.calls[0]?.text || '', /current_phase_id/i);
});

test('postgres evidence upload and verification enforce forward-only states', async () => {
  const uploaded = evidenceRow('uploaded');
  const uploadPg = new QueryStub([uploaded]);
  const repository = new PostgresCapacityLoadRunRepository(uploadPg as any);
  const result = await repository.completeEvidenceUpload({
    evidence_id: 'evidence-a',
    object_uri: 's3://capacity/run-a/evidence-a.json',
    sha256: 'a'.repeat(64),
    byte_size: 100,
    captured_at: '2026-07-16T08:00:10.000Z',
    now: '2026-07-16T08:00:11.000Z'
  });
  assert.equal(result.state, 'uploaded');
  assert.match(
    uploadPg.calls[0]?.text || '',
    /state = 'uploading'[\s\S]*state IN \('uploaded', 'verified'\)/i
  );

  const verifyPg = new QueryStub([evidenceRow('verified')]);
  const verifyRepository = new PostgresCapacityLoadRunRepository(verifyPg as any);
  const verified = await verifyRepository.verifyEvidence({
    evidence_id: 'evidence-a',
    outcome: 'verified',
    error_code: '',
    now: '2026-07-16T08:00:12.000Z'
  });
  assert.equal(verified.state, 'verified');
  assert.match(verifyPg.calls[0]?.text || '', /state = \$2 AND error_code = \$3/i);
});

test('phase and run completion SQL cannot turn failed shards or rejected evidence into pass', async () => {
  const phasePg = new QueryStub([{ phase_id: 'steady' }]);
  const phaseRepository = new PostgresCapacityLoadRunRepository(phasePg as any);
  await phaseRepository.completePhase({
    run_id: 'run-a',
    phase_id: 'steady',
    controller_id: 'controller-a',
    controller_lease_epoch: '2',
    outcome: 'completed',
    now: '2026-07-16T08:01:00.000Z'
  });
  assert.match(
    phasePg.calls[0]?.text || '',
    /\$5 <> 'completed'[\s\S]*shard\.state <> 'completed'/i
  );

  const runPg = new QueryStub([{ run_id: 'run-a' }]);
  const runRepository = new PostgresCapacityLoadRunRepository(runPg as any);
  await runRepository.finalizeRun({
    run_id: 'run-a',
    controller_id: 'controller-a',
    controller_lease_epoch: '2',
    outcome: 'passed',
    evidence_manifest_sha256: 'a'.repeat(64),
    failure_code: '',
    now: '2026-07-16T08:01:01.000Z'
  });
  assert.match(runPg.calls[0]?.text || '', /\$5 = 'passed'[\s\S]*phase\.state <> 'completed'/i);
  assert.match(runPg.calls[0]?.text || '', /\$5 = 'passed'[\s\S]*evidence\.state <> 'verified'/i);
  assert.match(
    runPg.calls[0]?.text || '',
    /kind\s*=\s*'run_evidence_manifest'[\s\S]*state\s*=\s*'verified'[\s\S]*sha256\s*=\s*\$6/i
  );
  assert.equal(runPg.calls[0]?.params.length, 8);
  assert.doesNotMatch(runPg.calls[0]?.text || '', /\$9\b/);
});

test('postgres controller skips pending phases and enters finalizing only after completed phases', async () => {
  const skipPg = new QueryStub([{ fenced: true, skipped_count: 2 }]);
  const skipRepository = new PostgresCapacityLoadRunRepository(skipPg as any);
  await skipRepository.skipPendingPhases({
    run_id: 'run-a',
    controller_id: 'controller-a',
    controller_lease_epoch: '2',
    now: '2026-07-16T08:01:00.000Z'
  });
  assert.match(skipPg.calls[0]?.text || '', /SET state = 'skipped'/i);
  assert.match(skipPg.calls[0]?.text || '', /controller_lease_epoch = \$3::bigint/i);

  const finalizingPg = new QueryStub([{ run_id: 'run-a' }]);
  const finalizingRepository = new PostgresCapacityLoadRunRepository(finalizingPg as any);
  await finalizingRepository.beginRunFinalization({
    run_id: 'run-a',
    controller_id: 'controller-a',
    controller_lease_epoch: '2',
    now: '2026-07-16T08:01:00.000Z'
  });
  assert.match(finalizingPg.calls[0]?.text || '', /SET state = 'finalizing'/i);
  assert.match(
    finalizingPg.calls[0]?.text || '',
    /phase\.state <> 'completed'/i
  );
});

test('postgres repository SQL never skips a positional placeholder', () => {
  const source = readFileSync(
    'scripts/capacity/orchestrator/postgres-store.ts',
    'utf8'
  );
  const queries = source.matchAll(
    /this\.#pg\.query(?:<[^>]+>)?\(\s*`([\s\S]*?)`,\s*\[/g
  );
  let count = 0;
  for (const match of queries) {
    count += 1;
    const placeholders = [...match[1].matchAll(/\$(\d+)/g)]
      .map((value) => Number(value[1]));
    const maximum = Math.max(0, ...placeholders);
    assert.deepEqual(
      [...new Set(placeholders)].sort((left, right) => left - right),
      Array.from({ length: maximum }, (_, index) => index + 1)
    );
  }
  assert.ok(count >= 15);
});

class QueryStub {
  calls: Array<{ text: string; params: unknown[] }> = [];

  constructor(private readonly nextRows: Array<Record<string, unknown>>) {}

  async query(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = this.nextRows.splice(0);
    return { rows, rowCount: rows.length };
  }
}

function evidenceRow(state: string): Record<string, unknown> {
  return {
    evidence_id: 'evidence-a',
    run_id: 'run-a',
    phase_id: 'steady',
    shard_id: 'shard-a',
    kind: 'shard_summary',
    state,
    object_uri: state === 'uploaded' || state === 'verified'
      ? 's3://capacity/run-a/evidence-a.json'
      : '',
    sha256: state === 'uploaded' || state === 'verified' ? 'a'.repeat(64) : '',
    byte_size: state === 'uploaded' || state === 'verified' ? 100 : 0,
    metadata: {},
    error_code: '',
    captured_at: state === 'uploaded' || state === 'verified'
      ? '2026-07-16T08:00:10.000Z'
      : null,
    verified_at: state === 'verified' ? '2026-07-16T08:00:12.000Z' : null
  };
}
