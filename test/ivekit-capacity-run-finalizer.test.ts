import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalSha256 } from '../scripts/capacity/canonical-json.js';
import { qualifyGeneratorFleet } from '../scripts/capacity/generator-qualification.js';
import {
  CapacityRunEvidenceFinalizer,
  capacityRunEvidenceDocument,
  type CapacityRunEvidenceControl,
  type CapacityRunEvidenceSubmission
} from '../scripts/capacity/orchestrator/run-finalizer.js';
import type {
  CapacityEvidenceRecord,
  CapacityRunOutcome
} from '../scripts/capacity/orchestrator/types.js';
import type { CapacityEvidenceObjectStore } from '../scripts/capacity/orchestrator/worker-runtime.js';
import {
  capacityFinalizerConfig,
  readCapacityEvidenceSubmission
} from '../scripts/ivekit-capacity-finalizer.js';

test('run finalizer validates every phase shard and binds the verified manifest object', async () => {
  const manifest = finalizerManifest(false);
  const submission = finalizerSubmission(manifest, 'controlled');
  const control = new FakeRunEvidenceControl(canonicalSha256(manifest));
  const objectStore = new FakeRunEvidenceStore();
  const finalizer = new CapacityRunEvidenceFinalizer({
    control,
    object_store: objectStore,
    controller_id: 'capacity-finalizer-a',
    lease_ttl_ms: 15_000,
    evidence_prefix: 'capacity/cell-10k',
    now: () => '2026-07-16T14:00:00.000Z'
  });

  const result = await finalizer.finalize({ manifest, submission });

  assert.equal(result.outcome, 'passed');
  assert.deepEqual(
    capacityRunEvidenceDocument(manifest, submission, result).manifest,
    manifest
  );
  assert.equal(control.finalized?.outcome, 'passed');
  assert.equal(control.record.state, 'verified');
  assert.equal(
    control.finalized?.evidence_manifest_sha256,
    canonicalSha256(capacityRunEvidenceDocument(manifest, submission, result))
  );
  assert.equal(objectStore.puts, 1);

  const replay = await finalizer.finalize({ manifest, submission });
  assert.equal(replay.outcome, 'passed');
  assert.equal(objectStore.puts, 1);
});

test('production run remains not_run when a required real dependency is unavailable', async () => {
  const manifest = finalizerManifest(true);
  const submission = finalizerSubmission(manifest, 'production');
  const control = new FakeRunEvidenceControl(canonicalSha256(manifest));
  const finalizer = new CapacityRunEvidenceFinalizer({
    control,
    object_store: new FakeRunEvidenceStore(),
    controller_id: 'capacity-finalizer-a',
    lease_ttl_ms: 15_000,
    evidence_prefix: 'capacity/cell-10k'
  });

  const result = await finalizer.finalize({ manifest, submission });

  assert.equal(result.outcome, 'not_run');
  assert.equal(control.finalized?.outcome, 'not_run');
  assert.equal(control.finalized?.failure_code, 'capacity_external_not_run');
});

test('capacity finalizer entrypoint loads bounded submission and explicit S3 configuration', () => {
  const manifest = finalizerManifest(false);
  const submission = finalizerSubmission(manifest, 'controlled');
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-capacity-finalizer-'));
  const path = join(directory, 'submission.json');
  try {
    writeFileSync(path, JSON.stringify(submission));
    assert.deepEqual(readCapacityEvidenceSubmission(path), submission);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const config = capacityFinalizerConfig({
    OPC_DATABASE_URL: 'postgresql://opc@postgres/ivekit',
    OPC_IVEKIT_CAPACITY_FINALIZER_ID: 'capacity-finalizer-a',
    OPC_IVEKIT_CAPACITY_MANIFEST_PATH: '/run/capacity/manifest.json',
    OPC_IVEKIT_CAPACITY_EVIDENCE_SUBMISSION_PATH: '/run/capacity/submission.json',
    OPC_IVEKIT_CAPACITY_FINALIZER_LEASE_MS: '15000',
    OPC_IVEKIT_CAPACITY_EVIDENCE_PREFIX: 'capacity/cell-10k',
    OPC_IVEKIT_CAPACITY_EVIDENCE_S3_BUCKET: 'capacity-evidence',
    OPC_IVEKIT_CAPACITY_EVIDENCE_S3_REGION: 'ap-southeast-1'
  });
  assert.equal(config.finalizer_id, 'capacity-finalizer-a');
  assert.equal(config.evidence_s3.bucket, 'capacity-evidence');
});

class FakeRunEvidenceStore implements CapacityEvidenceObjectStore {
  puts = 0;

  async put(input: any): Promise<{ object_uri: string }> {
    this.puts += 1;
    return { object_uri: `s3://capacity-evidence/${input.key}` };
  }
}

class FakeRunEvidenceControl implements CapacityRunEvidenceControl {
  record = runEvidence('pending');
  runState = 'finalizing';
  runOutcome = '';
  finalized: {
    outcome: CapacityRunOutcome;
    evidence_manifest_sha256: string;
    failure_code: string;
  } | null = null;

  constructor(private readonly manifestSha256: string) {}

  async readRunControlState(): Promise<any> {
    return {
      state: this.runState,
      current_phase_id: 'steady',
      manifest_sha256: this.manifestSha256,
      evidence_manifest_sha256: this.finalized?.evidence_manifest_sha256 || '',
      outcome: this.runOutcome
    };
  }

  async claimController(input: any): Promise<any> {
    return {
      run_id: input.run_id,
      controller_id: input.controller_id,
      lease_epoch: '2',
      lease_expires_at: '2026-07-16T14:00:15.000Z'
    };
  }

  async registerEvidence(input: any): Promise<CapacityEvidenceRecord> {
    if (Object.keys(this.record.metadata).length === 0) {
      this.record.metadata = structuredClone(input.metadata);
      this.record.kind = input.kind;
    }
    return structuredClone(this.record);
  }

  async startEvidenceUpload(): Promise<CapacityEvidenceRecord> {
    if (this.record.state === 'pending') this.record.state = 'uploading';
    return structuredClone(this.record);
  }

  async completeEvidenceUpload(input: any): Promise<CapacityEvidenceRecord> {
    if (this.record.state === 'uploading') {
      Object.assign(this.record, {
        state: 'uploaded',
        object_uri: input.object_uri,
        sha256: input.sha256,
        byte_size: input.byte_size,
        captured_at: input.captured_at
      });
    }
    return structuredClone(this.record);
  }

  async verifyEvidence(): Promise<CapacityEvidenceRecord> {
    if (this.record.state === 'uploaded') this.record.state = 'verified';
    return structuredClone(this.record);
  }

  async finalizeRun(input: any): Promise<void> {
    this.finalized = {
      outcome: input.outcome,
      evidence_manifest_sha256: input.evidence_manifest_sha256,
      failure_code: input.failure_code
    };
    this.runOutcome = input.outcome;
    this.runState = input.outcome === 'passed'
      ? 'completed'
      : input.outcome === 'not_run'
        ? 'not_run'
        : 'failed';
  }
}

function finalizerManifest(realDependencyNotRun: boolean): any {
  return {
    schema_version: '1.0.0',
    run_id: 'run-capacity-finalize-001',
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    fork_manifest_id: 'ivekit-forks-v1',
    fork_manifest_sha256: 'b'.repeat(64),
    sut_release_id: 'ivekit@abc123',
    generator_release_id: 'loadgen@abc123',
    seed: 'seed-capacity-finalize',
    run_epoch: '2026-07-16T14:00:00.000Z',
    topology: {
      fleets: [{
        fleet_id: 'tinode',
        worker_count: 1,
        protocols: ['tinode_websocket']
      }]
    },
    shards: [{
      shard_id: 'interaction/tinode_im/0-100',
      workload_domain: 'interaction',
      workload_id: 'tinode_im',
      workload_kind: 'tinode_im',
      ordinal_start: 0,
      ordinal_end_exclusive: 100,
      expected_count: 100,
      required_protocols: ['tinode_websocket'],
      assigned_fleet: 'tinode',
      initial_lease_epoch: 0,
      seed: 'c'.repeat(64)
    }],
    phases: [
      { id: 'ramp', duration_seconds: 60 },
      { id: 'steady', duration_seconds: 300 }
    ],
    faults: [],
    expected_totals: {
      interactions: 100,
      connections: 0,
      by_workload: { tinode_im: 100 }
    },
    external_dependencies: realDependencyNotRun
      ? [{
        id: 'real_tinode',
        status: 'not_run',
        required_for_production_pass: true
      }]
      : [],
    start_not_before: '2026-07-16T13:59:00.000Z',
    evidence_prefix: 's3://capacity/run-capacity-finalize-001'
  };
}

function finalizerSubmission(
  manifest: any,
  mode: 'controlled' | 'production'
): CapacityRunEvidenceSubmission {
  return {
    schema_version: '1.0.0',
    run_id: manifest.run_id,
    manifest_sha256: canonicalSha256(manifest),
    mode,
    fleet_qualifications: [qualifyGeneratorFleet({
      fleet_id: 'tinode',
      target_load: 100,
      workers: Array.from({ length: 5 }, (_, index) => ({
        worker_id: `tinode-worker-${index + 1}`,
        protocol: 'tinode_websocket',
        release_id: 'loadgen@abc123',
        hardware_class: 'gen-c16-10gbe',
        calibrated: true,
        safe_capacity: 40,
        assigned_load: 20,
        cpu_p95_ratio: 0.4,
        memory_p95_ratio: 0.4,
        nic_p95_ratio: 0.4,
        host_packet_drop_count: 0,
        scheduler_lag_p99_ms: 2,
        scheduler_lag_limit_ms: 10
      }))
    })],
    shard_evidence: manifest.phases.map((phase: any) => ({
      phase_id: phase.id,
      shard_id: 'interaction/tinode_im/0-100',
      workload_domain: 'interaction' as const,
      workload_id: 'tinode_im',
      expected_count: 100,
      lease_epoch: '1',
      attempted_count: 100,
      accepted_count: 100,
      active_peak_count: 100,
      sut_observed_count: 100,
      independent_observed_count: 100,
      duplicate_id_count: 0,
      stale_action_count: 0,
      protocol_error_count: 0,
      rate_conformant: true,
      slo_passed: true
    }))
  };
}

function runEvidence(state: CapacityEvidenceRecord['state']): CapacityEvidenceRecord {
  return {
    evidence_id: 'capacity-run-evidence',
    run_id: 'run-capacity-finalize-001',
    phase_id: '',
    shard_id: '',
    kind: 'run_evidence_manifest',
    state,
    object_uri: '',
    sha256: '',
    byte_size: 0,
    metadata: {},
    error_code: '',
    captured_at: '',
    verified_at: ''
  };
}
