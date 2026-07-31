import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalSha256 } from '../scripts/capacity/canonical-json.js';
import {
  CapacityRunController,
  type CapacityRunControllerControl,
  type CapacityRunPhaseProgress
} from '../scripts/capacity/orchestrator/controller.js';
import { LoadRunControlError } from '../scripts/capacity/orchestrator/types.js';
import {
  capacityControllerConfig,
  readCapacityControllerManifest
} from '../scripts/ivekit-capacity-controller.js';

test('capacity controller restarts safely and advances all manifest phases to finalizing', async () => {
  const control = new FakeControllerControl();
  const manifest = runManifest();
  const controller = new CapacityRunController({
    control,
    controller_id: 'controller-a',
    lease_ttl_ms: 15_000,
    poll_interval_ms: 100,
    now: () => '2026-07-16T13:00:00.000Z',
    delay: async () => undefined
  });

  const result = await controller.run({
    manifest,
    manifest_sha256: canonicalSha256(manifest)
  });

  assert.deepEqual(result, {
    run_id: 'run-capacity-001',
    state: 'finalizing',
    outcome: 'awaiting_evidence_validation'
  });
  assert.deepEqual(control.started, ['ramp', 'steady']);
  assert.deepEqual(control.completed, ['ramp:completed', 'steady:completed']);
  assert.equal(control.beginFinalizationCalls, 1);
});

test('capacity controller fails the run after terminal shard failure and skips later phases', async () => {
  const control = new FakeControllerControl();
  control.failPhase = 'ramp';
  const manifest = runManifest();
  const controller = new CapacityRunController({
    control,
    controller_id: 'controller-a',
    lease_ttl_ms: 15_000,
    poll_interval_ms: 100,
    now: () => '2026-07-16T13:00:00.000Z',
    delay: async () => undefined
  });

  const result = await controller.run({
    manifest,
    manifest_sha256: canonicalSha256(manifest)
  });

  assert.equal(result.state, 'failed');
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(control.completed, ['ramp:failed']);
  assert.equal(control.skipped, 1);
  assert.equal(control.finalized[0]?.outcome, 'failed');
  assert.equal(control.finalized[0]?.evidence_manifest_sha256, '');
});

test('capacity controller rejects an existing run with a different immutable manifest', async () => {
  const control = new FakeControllerControl();
  control.existing = true;
  control.manifestSha256 = 'b'.repeat(64);
  const manifest = runManifest();
  const controller = new CapacityRunController({
    control,
    controller_id: 'controller-a',
    lease_ttl_ms: 15_000,
    poll_interval_ms: 100
  });

  await assert.rejects(
    () => controller.run({
      manifest,
      manifest_sha256: canonicalSha256(manifest)
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'existing_run_manifest_mismatch'
  );
});

test('capacity controller waits when another replica still owns the lease', async () => {
  const control = new FakeControllerControl();
  control.controllerLeaseFailures = 1;
  let delays = 0;
  const manifest = runManifest();
  const controller = new CapacityRunController({
    control,
    controller_id: 'controller-b',
    lease_ttl_ms: 15_000,
    poll_interval_ms: 100,
    delay: async () => { delays += 1; }
  });

  const result = await controller.run({
    manifest,
    manifest_sha256: canonicalSha256(manifest)
  });

  assert.equal(result.state, 'finalizing');
  assert.ok(delays >= 1);
});

test('capacity controller entrypoint loads only a hash-bound immutable manifest bundle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-capacity-controller-'));
  const path = join(directory, 'manifest.json');
  const manifest = runManifest();
  try {
    writeFileSync(path, JSON.stringify({
      manifest,
      manifest_sha256: canonicalSha256(manifest)
    }));
    assert.deepEqual(readCapacityControllerManifest(path), {
      manifest,
      manifest_sha256: canonicalSha256(manifest)
    });
    writeFileSync(path, JSON.stringify({
      manifest: { ...manifest, seed: 'tampered-seed' },
      manifest_sha256: canonicalSha256(manifest)
    }));
    assert.throws(() => readCapacityControllerManifest(path), /hash/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('capacity controller config keeps polling comfortably inside its lease', () => {
  assert.deepEqual(capacityControllerConfig({
    OPC_DATABASE_URL: 'postgresql://opc@postgres/ivekit',
    OPC_IVEKIT_CAPACITY_CONTROLLER_ID: 'capacity-controller-a',
    OPC_IVEKIT_CAPACITY_MANIFEST_PATH: '/run/ivekit-capacity/manifest.json',
    OPC_IVEKIT_CAPACITY_CONTROLLER_LEASE_MS: '15000',
    OPC_IVEKIT_CAPACITY_CONTROLLER_POLL_INTERVAL_MS: '500'
  }), {
    database_url: 'postgresql://opc@postgres/ivekit',
    controller_id: 'capacity-controller-a',
    manifest_path: '/run/ivekit-capacity/manifest.json',
    lease_ttl_ms: 15000,
    poll_interval_ms: 500
  });
  assert.throws(() => capacityControllerConfig({
    OPC_DATABASE_URL: 'postgresql://opc@postgres/ivekit',
    OPC_IVEKIT_CAPACITY_CONTROLLER_ID: 'capacity-controller-a',
    OPC_IVEKIT_CAPACITY_MANIFEST_PATH: '/run/ivekit-capacity/manifest.json',
    OPC_IVEKIT_CAPACITY_CONTROLLER_LEASE_MS: '3000',
    OPC_IVEKIT_CAPACITY_CONTROLLER_POLL_INTERVAL_MS: '1500'
  }), /numeric/i);
});

class FakeControllerControl implements CapacityRunControllerControl {
  existing = false;
  manifestSha256 = '';
  runState: any = 'planned';
  phases = new Map<string, CapacityRunPhaseProgress>([
    ['ramp', progress('ramp', 'pending')],
    ['steady', progress('steady', 'pending')]
  ]);
  failPhase = '';
  started: string[] = [];
  completed: string[] = [];
  skipped = 0;
  beginFinalizationCalls = 0;
  finalized: any[] = [];
  controllerLeaseFailures = 0;

  async createRun(input: any): Promise<void> {
    if (this.existing) throw new LoadRunControlError('run_already_exists', 409);
    this.existing = true;
    this.manifestSha256 = input.manifest_sha256;
  }

  async readRunControlState(): Promise<any> {
    return {
      state: this.runState,
      current_phase_id: '',
      manifest_sha256: this.manifestSha256,
      evidence_manifest_sha256: '',
      outcome: ''
    };
  }

  async claimController(input: any): Promise<any> {
    if (this.controllerLeaseFailures > 0) {
      this.controllerLeaseFailures -= 1;
      throw new LoadRunControlError('controller_lease_unavailable', 409, true);
    }
    return {
      run_id: input.run_id,
      controller_id: input.controller_id,
      lease_epoch: '1',
      lease_expires_at: '2026-07-16T13:00:15.000Z'
    };
  }

  async readPhaseProgress(input: any): Promise<CapacityRunPhaseProgress> {
    return structuredClone(this.phases.get(input.phase_id)!);
  }

  async startPhase(input: any): Promise<void> {
    this.started.push(input.phase_id);
    this.runState = 'running';
    this.phases.set(
      input.phase_id,
      this.failPhase === input.phase_id
        ? {
          ...progress(input.phase_id, 'running'),
          total_shards: 1,
          failed_shards: 1,
          active_shards: 0
        }
        : {
          ...progress(input.phase_id, 'running'),
          total_shards: 1,
          completed_shards: 1,
          active_shards: 0
        }
    );
  }

  async completePhase(input: any): Promise<void> {
    this.completed.push(`${input.phase_id}:${input.outcome}`);
    this.phases.set(
      input.phase_id,
      progress(input.phase_id, input.outcome)
    );
  }

  async skipPendingPhases(): Promise<void> {
    this.skipped += 1;
    for (const [id, phase] of this.phases) {
      if (phase.state === 'pending') this.phases.set(id, progress(id, 'skipped'));
    }
  }

  async beginRunFinalization(): Promise<void> {
    this.beginFinalizationCalls += 1;
    this.runState = 'finalizing';
  }

  async finalizeRun(input: any): Promise<void> {
    this.finalized.push(input);
    this.runState = 'failed';
  }
}

function progress(
  phaseId: string,
  state: CapacityRunPhaseProgress['state']
): CapacityRunPhaseProgress {
  return {
    phase_id: phaseId,
    state,
    total_shards: state === 'pending' || state === 'skipped' ? 1 : 1,
    completed_shards: state === 'completed' ? 1 : 0,
    failed_shards: state === 'failed' ? 1 : 0,
    cancelled_shards: 0,
    not_run_shards: 0,
    active_shards: state === 'running' ? 1 : 0
  };
}

function runManifest(): any {
  return {
    schema_version: '1.0.0',
    run_id: 'run-capacity-001',
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    fork_manifest_id: 'ivekit-forks-v1',
    fork_manifest_sha256: 'b'.repeat(64),
    sut_release_id: 'ivekit@abc123',
    generator_release_id: 'loadgen@abc123',
    seed: 'seed-capacity-001',
    run_epoch: '2026-07-16T13:00:00.000Z',
    topology: { fleets: [] },
    shards: [],
    phases: [
      { id: 'ramp', duration_seconds: 60 },
      { id: 'steady', duration_seconds: 300 }
    ],
    faults: [],
    expected_totals: {
      interactions: 0,
      connections: 0,
      by_workload: {}
    },
    external_dependencies: [],
    start_not_before: '2026-07-16T12:59:00.000Z',
    evidence_prefix: 's3://capacity/run-capacity-001'
  };
}
