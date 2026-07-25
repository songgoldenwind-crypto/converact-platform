import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Pool } from 'pg';

import {
  DurableLoadRunOrchestrator,
  PostgresCapacityLoadRunRepository,
  type CapacityCommandBus
} from '../scripts/capacity/orchestrator/index.js';
import { canonicalSha256 } from '../scripts/capacity/canonical-json.js';
import type { LoadRunManifest } from '../scripts/capacity/profile-compiler.js';

const databaseUrl = process.env.OPC_IVEKIT_CAPACITY_TEST_DATABASE_URL || '';
const performanceContract = JSON.parse(
  readFileSync('docs/capacity/profiles/mix-100k-v1.json', 'utf8')
).performance_contract;

test('PostgreSQL capacity runtime preserves leases, accounting, outbox and pass barriers', {
  skip: !databaseUrl
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const repository = new PostgresCapacityLoadRunRepository(pool, {
    id: () => 'command-capacity-001'
  });
  const bus: CapacityCommandBus = { async publish() {} };
  const orchestrator = new DurableLoadRunOrchestrator({
    repository,
    command_bus: bus
  });
  const manifest = runManifest();

  try {
    await pool.query(`
      TRUNCATE TABLE
        ivekit_capacity_command_outbox,
        ivekit_capacity_evidence,
        ivekit_capacity_load_workers,
        ivekit_capacity_load_shards,
        ivekit_capacity_load_phases,
        ivekit_capacity_load_runs
      CASCADE
    `);
    await orchestrator.createRun({
      manifest,
      manifest_sha256: canonicalSha256(manifest),
      created_at: '2026-07-16T08:00:00.000Z'
    });
    const controller = await orchestrator.claimController({
      run_id: manifest.run_id,
      controller_id: 'controller-a',
      lease_ttl_ms: 60_000,
      now: '2026-07-16T08:00:01.000Z'
    });
    await orchestrator.heartbeatWorker({
      run_id: manifest.run_id,
      worker_id: 'tinode-worker-a',
      fleet_id: 'tinode',
      release_id: 'loadgen@abc123',
      state: 'online',
      safe_capacity: 2_000,
      reported_load: 0,
      observed_at: '2026-07-16T08:00:01.000Z',
      metadata: {}
    });
    await orchestrator.startPhase({
      run_id: manifest.run_id,
      phase_id: 'steady',
      controller_id: controller.controller_id,
      controller_lease_epoch: controller.lease_epoch,
      now: '2026-07-16T08:00:02.000Z'
    });
    const assignment = await orchestrator.assignNextShard({
      run_id: manifest.run_id,
      phase_id: 'steady',
      worker_id: 'tinode-worker-a',
      fleet_id: 'tinode',
      lease_ttl_ms: 30_000,
      now: '2026-07-16T08:00:03.000Z'
    });
    assert.equal(assignment?.lease_epoch, '1');
    assert.deepEqual(assignment?.covered_workloads, [{
      workload_domain: 'interaction',
      workload_id: 'tinode-im',
      workload_kind: 'tinode_im',
      ordinal_start: 0,
      ordinal_end_exclusive: 1000,
      expected_count: 1000
    }]);

    const commands = await repository.claimCommands({
      dispatcher_id: 'dispatcher-a',
      lease_ttl_ms: 10_000,
      limit: 10,
      now: '2026-07-16T08:00:04.000Z'
    });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].payload.phase_id, 'steady');
    assert.deepEqual(
      commands[0].payload.assignment.covered_workloads,
      assignment?.covered_workloads
    );
    await repository.markCommandPublished({
      command_id: commands[0].command_id,
      dispatcher_id: commands[0].dispatcher_id,
      dispatch_epoch: commands[0].dispatch_epoch,
      now: '2026-07-16T08:00:05.000Z'
    });

    await orchestrator.registerEvidence({
      evidence_id: 'evidence-capacity-001',
      run_id: manifest.run_id,
      phase_id: 'steady',
      shard_id: assignment!.shard_id,
      kind: 'shard_summary',
      metadata: {},
      now: '2026-07-16T08:00:06.000Z'
    });
    await orchestrator.startEvidenceUpload({
      evidence_id: 'evidence-capacity-001',
      now: '2026-07-16T08:00:07.000Z'
    });
    await orchestrator.completeEvidenceUpload({
      evidence_id: 'evidence-capacity-001',
      object_uri: 's3://capacity/run-capacity-pg-001/evidence-capacity-001.json',
      sha256: 'a'.repeat(64),
      byte_size: 100,
      captured_at: '2026-07-16T08:00:07.000Z',
      now: '2026-07-16T08:00:08.000Z'
    });
    await orchestrator.verifyEvidence({
      evidence_id: 'evidence-capacity-001',
      outcome: 'verified',
      error_code: '',
      now: '2026-07-16T08:00:09.000Z'
    });
    await orchestrator.renewShardLease({
      run_id: manifest.run_id,
      phase_id: 'steady',
      shard_id: assignment!.shard_id,
      worker_id: assignment!.worker_id,
      lease_epoch: assignment!.lease_epoch,
      lease_ttl_ms: 30_000,
      now: '2026-07-16T08:00:10.000Z'
    });
    await orchestrator.completeShard({
      run_id: manifest.run_id,
      phase_id: 'steady',
      shard_id: assignment!.shard_id,
      worker_id: assignment!.worker_id,
      lease_epoch: assignment!.lease_epoch,
      outcome: 'completed',
      evidence_id: 'evidence-capacity-001',
      error_code: '',
      now: '2026-07-16T08:00:11.000Z'
    });
    await orchestrator.completePhase({
      run_id: manifest.run_id,
      phase_id: 'steady',
      controller_id: controller.controller_id,
      controller_lease_epoch: controller.lease_epoch,
      outcome: 'completed',
      now: '2026-07-16T08:00:12.000Z'
    });
    await orchestrator.registerEvidence({
      evidence_id: 'evidence-manifest-001',
      run_id: manifest.run_id,
      phase_id: '',
      shard_id: '',
      kind: 'run_evidence_manifest',
      metadata: {},
      now: '2026-07-16T08:00:12.100Z'
    });
    await orchestrator.startEvidenceUpload({
      evidence_id: 'evidence-manifest-001',
      now: '2026-07-16T08:00:12.200Z'
    });
    await orchestrator.completeEvidenceUpload({
      evidence_id: 'evidence-manifest-001',
      object_uri: 's3://capacity/run-capacity-pg-001/manifest.json',
      sha256: 'b'.repeat(64),
      byte_size: 100,
      captured_at: '2026-07-16T08:00:12.200Z',
      now: '2026-07-16T08:00:12.300Z'
    });
    await orchestrator.verifyEvidence({
      evidence_id: 'evidence-manifest-001',
      outcome: 'verified',
      error_code: '',
      now: '2026-07-16T08:00:12.400Z'
    });
    await orchestrator.finalizeRun({
      run_id: manifest.run_id,
      controller_id: controller.controller_id,
      controller_lease_epoch: controller.lease_epoch,
      outcome: 'passed',
      evidence_manifest_sha256: 'b'.repeat(64),
      failure_code: '',
      now: '2026-07-16T08:00:13.000Z'
    });

    const state = await pool.query<{
      state: string;
      outcome: string;
      assigned_load: number;
      reported_load: number;
    }>(`
      SELECT run.state, run.outcome, worker.assigned_load, worker.reported_load
      FROM ivekit_capacity_load_runs run
      JOIN ivekit_capacity_load_workers worker ON worker.run_id = run.run_id
      WHERE run.run_id = $1
    `, [manifest.run_id]);
    assert.deepEqual(state.rows[0], {
      state: 'completed',
      outcome: 'passed',
      assigned_load: 0,
      reported_load: 0
    });
  } finally {
    await pool.end();
  }
});

function runManifest(): LoadRunManifest {
  return {
    schema_version: '1.0.0',
    run_id: 'run-capacity-pg-001',
    profile_id: 'mix-100k-v1',
    profile_sha256: 'c'.repeat(64),
    fork_manifest_id: 'fork-capacity-001',
    fork_manifest_sha256: 'd'.repeat(64),
    sut_release_id: 'ivekit@abc123',
    generator_release_id: 'loadgen@abc123',
    seed: 'seed-capacity-001',
    run_epoch: '2026-07-16T08:00:00.000Z',
    topology: {
      fleets: [{
        fleet_id: 'tinode',
        worker_count: 1,
        protocols: ['tinode_websocket']
      }]
    },
    shards: [{
      shard_id: 'connection/tinode-websocket/0-1500',
      workload_domain: 'connection',
      workload_id: 'tinode-websocket',
      workload_kind: 'tinode_websocket',
      ordinal_start: 0,
      ordinal_end_exclusive: 1500,
      expected_count: 1500,
      covered_workloads: [{
        workload_domain: 'interaction',
        workload_id: 'tinode-im',
        workload_kind: 'tinode_im',
        ordinal_start: 0,
        ordinal_end_exclusive: 1000,
        expected_count: 1000
      }],
      required_protocols: ['tinode_websocket'],
      assigned_fleet: 'tinode',
      initial_lease_epoch: 0,
      seed: 'seed-capacity-001'
    }],
    phases: [{ id: 'steady', duration_seconds: 300 }],
    faults: [],
    expected_totals: {
      interactions: 1000,
      connections: 1500,
      by_workload: { 'tinode-im': 1000, 'tinode-websocket': 1500 }
    },
    performance_contract: performanceContract,
    external_dependencies: [],
    start_not_before: '2026-07-16T08:00:00.000Z',
    evidence_prefix: 'capacity/run-capacity-pg-001'
  };
}
