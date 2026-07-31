import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  qualifyGeneratorFleet,
  type GeneratorWorkerCapacity
} from '../scripts/capacity/generator-qualification.js';
import { validateCapacityRunEvidence } from '../scripts/capacity/evidence-validator.js';

const performanceContract = JSON.parse(readFileSync(
  'docs/capacity/profiles/cell-10k-v1.json',
  'utf8'
)).performance_contract;

function performanceEvidence() {
  return {
    schema_version: '1.0.0' as const,
    measurement_scope: performanceContract.measurement_scope,
    clock_offset_p99_ms: 1,
    quantiles_collected: [...performanceContract.required_quantiles],
    latency_ms: { ...performanceContract.latency_ms },
    media_quality: { ...performanceContract.media_quality },
    reliability: { ...performanceContract.reliability },
    recovery_ms: { ...performanceContract.recovery_ms },
    overload: {
      jain_fairness_index: 0.99,
      noisy_neighbor_p99_degradation_ratio: 0.1,
      unbounded_queue_event_count: 0,
      audio_priority_violation_count: 0,
      slow_consumer_escape_count: 0,
      observed_degradation_order: [...performanceContract.overload.degradation_order]
    },
    security_performance: {
      authorization_p99_ms: 40,
      rate_limit_decision_p99_ms: 5,
      overload_rejection_p99_ms: 50,
      unauthorized_admission_count: 0,
      established_media_remote_authorization_count: 0
    },
    resource_metrics: Object.fromEntries(
      performanceContract.required_resource_metrics.map((id: string) => [id, 1])
    ),
    impairment_profiles: performanceContract.impairment_profiles.map((profile: any) => ({
      id: profile.id,
      applied: structuredClone(profile),
      sample_count: 100,
      client_crash_count: 0,
      established_media_terminated_count: 0,
      unbounded_queue_event_count: 0,
      reconnect_success_ratio: 1,
      recovery_p99_ms: profile.id === 'network_handoff' ? 4000 : 2500
    }))
  };
}

function workers(overrides: Partial<GeneratorWorkerCapacity> = {}): GeneratorWorkerCapacity[] {
  return Array.from({ length: 5 }, (_, index) => ({
    worker_id: `worker-${index + 1}`,
    protocol: 'ivekit_event_websocket',
    release_id: 'loadgen@abc',
    hardware_class: 'gen-c32-25gbe',
    calibrated: true,
    safe_capacity: 300,
    assigned_load: 200,
    cpu_p95_ratio: 0.5,
    memory_p95_ratio: 0.5,
    nic_p95_ratio: 0.5,
    host_packet_drop_count: 0,
    scheduler_lag_p99_ms: 2,
    scheduler_lag_limit_ms: 10,
    ...overrides
  }));
}

test('generator qualification enforces fleet and worker headroom', () => {
  const qualified = qualifyGeneratorFleet({
    fleet_id: 'ivekit_event_ws',
    target_load: 1000,
    workers: workers()
  });
  assert.equal(qualified.status, 'qualified');
  assert.equal(qualified.total_safe_capacity, 1500);

  const insufficient = qualifyGeneratorFleet({
    fleet_id: 'ivekit_event_ws',
    target_load: 1001,
    workers: workers()
  });
  assert.equal(insufficient.status, 'invalid_generator_capacity');
  assert.match(insufficient.reasons.join('\n'), /150%/);

  const overloaded = qualifyGeneratorFleet({
    fleet_id: 'ivekit_event_ws',
    target_load: 1000,
    workers: workers({ assigned_load: 211 })
  });
  assert.equal(overloaded.status, 'invalid_generator_capacity');
  assert.match(overloaded.reasons.join('\n'), /70%/);
});

test('unhealthy generator telemetry invalidates the run source', () => {
  const result = qualifyGeneratorFleet({
    fleet_id: 'ivekit_event_ws',
    target_load: 1000,
    workers: workers({ cpu_p95_ratio: 0.61, host_packet_drop_count: 1 })
  });
  assert.equal(result.status, 'invalid_generator_capacity');
  assert.match(result.reasons.join('\n'), /CPU|packet drop/);
});

const qualification = qualifyGeneratorFleet({
  fleet_id: 'ivekit_event_ws',
  target_load: 1000,
  workers: workers()
});

const shardEvidence = {
  shard_id: 'connection/ivekit_event_websocket/0-1000',
  workload_domain: 'connection' as const,
  workload_id: 'ivekit_event_websocket',
  lease_epoch: '1',
  expected_count: 1000,
  attempted_count: 1000,
  accepted_count: 1000,
  active_peak_count: 1000,
  sut_observed_count: 1000,
  independent_observed_count: 1000,
  duplicate_id_count: 0,
  stale_action_count: 0,
  protocol_error_count: 0,
  rate_conformant: true,
  slo_passed: true
};

test('controlled evidence passes only when all three observation planes reconcile', () => {
  const result = validateCapacityRunEvidence({
    mode: 'controlled',
    expected_manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: 'a'.repeat(64),
    expected_shards: [{
      shard_id: shardEvidence.shard_id,
      workload_domain: shardEvidence.workload_domain,
      workload_id: shardEvidence.workload_id,
      expected_count: shardEvidence.expected_count
    }],
    required_fleet_ids: ['ivekit_event_ws'],
    fleet_qualifications: [qualification],
    shard_evidence: [shardEvidence],
    performance_contract: performanceContract,
    performance_evidence: performanceEvidence(),
    external_dependencies: [
      { id: 'windows_endpoints', status: 'not_run', required_for_production_pass: true }
    ]
  });

  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.reconciliation, {
    expected: 1000,
    attempted: 1000,
    accepted: 1000,
    sut_observed: 1000,
    independent_observed: 1000,
    by_workload: {
      'connection:ivekit_event_websocket': {
        expected: 1000,
        attempted: 1000,
        accepted: 1000,
        sut_observed: 1000,
        independent_observed: 1000
      }
    }
  });
  assert.deepEqual(result.external_not_run, ['windows_endpoints']);
});

test('production evidence remains not_run while a required real dependency is absent', () => {
  const result = validateCapacityRunEvidence({
    mode: 'production',
    expected_manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: 'a'.repeat(64),
    expected_shards: [{
      shard_id: shardEvidence.shard_id,
      workload_domain: shardEvidence.workload_domain,
      workload_id: shardEvidence.workload_id,
      expected_count: shardEvidence.expected_count
    }],
    required_fleet_ids: ['ivekit_event_ws'],
    fleet_qualifications: [qualification],
    shard_evidence: [shardEvidence],
    performance_contract: performanceContract,
    performance_evidence: performanceEvidence(),
    external_dependencies: [
      { id: 'windows_endpoints', status: 'not_run', required_for_production_pass: true }
    ]
  });
  assert.equal(result.outcome, 'not_run');
  assert.match(result.reasons.join('\n'), /windows_endpoints/);
});

test('production dependency gaps do not hide an observed SUT reconciliation failure', () => {
  const result = validateCapacityRunEvidence({
    mode: 'production',
    expected_manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: 'a'.repeat(64),
    expected_shards: [{
      shard_id: shardEvidence.shard_id,
      workload_domain: shardEvidence.workload_domain,
      workload_id: shardEvidence.workload_id,
      expected_count: shardEvidence.expected_count
    }],
    required_fleet_ids: ['ivekit_event_ws'],
    fleet_qualifications: [qualification],
    shard_evidence: [{ ...shardEvidence, sut_observed_count: 999 }],
    performance_contract: performanceContract,
    performance_evidence: performanceEvidence(),
    external_dependencies: [
      { id: 'windows_endpoints', status: 'not_run', required_for_production_pass: true }
    ]
  });
  assert.equal(result.outcome, 'failed');
  assert.match(result.reasons.join('\n'), /reconcile/i);
});

test('every required generator fleet must have qualification evidence', () => {
  const result = validateCapacityRunEvidence({
    mode: 'controlled',
    expected_manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: 'a'.repeat(64),
    expected_shards: [{
      shard_id: shardEvidence.shard_id,
      workload_domain: shardEvidence.workload_domain,
      workload_id: shardEvidence.workload_id,
      expected_count: shardEvidence.expected_count
    }],
    required_fleet_ids: ['ivekit_event_ws', 'sip'],
    fleet_qualifications: [qualification],
    shard_evidence: [shardEvidence],
    performance_contract: performanceContract,
    performance_evidence: performanceEvidence(),
    external_dependencies: []
  });
  assert.equal(result.outcome, 'invalid_generator_capacity');
  assert.match(result.reasons.join('\n'), /sip/);
});

test('under-qualified fleets and observation mismatches cannot pass', () => {
  const invalidFleet = qualifyGeneratorFleet({
    fleet_id: 'ivekit_event_ws',
    target_load: 1001,
    workers: workers()
  });
  const invalid = validateCapacityRunEvidence({
    mode: 'controlled',
    expected_manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: 'a'.repeat(64),
    expected_shards: [{
      shard_id: shardEvidence.shard_id,
      workload_domain: shardEvidence.workload_domain,
      workload_id: shardEvidence.workload_id,
      expected_count: shardEvidence.expected_count
    }],
    required_fleet_ids: ['ivekit_event_ws'],
    fleet_qualifications: [invalidFleet],
    shard_evidence: [shardEvidence],
    performance_contract: performanceContract,
    performance_evidence: performanceEvidence(),
    external_dependencies: []
  });
  assert.equal(invalid.outcome, 'invalid_generator_capacity');

  const mismatch = validateCapacityRunEvidence({
    mode: 'controlled',
    expected_manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: 'a'.repeat(64),
    expected_shards: [{
      shard_id: shardEvidence.shard_id,
      workload_domain: shardEvidence.workload_domain,
      workload_id: shardEvidence.workload_id,
      expected_count: shardEvidence.expected_count
    }],
    required_fleet_ids: ['ivekit_event_ws'],
    fleet_qualifications: [qualification],
    shard_evidence: [{ ...shardEvidence, sut_observed_count: 999 }],
    performance_contract: performanceContract,
    performance_evidence: performanceEvidence(),
    external_dependencies: []
  });
  assert.equal(mismatch.outcome, 'failed');
  assert.match(mismatch.reasons.join('\n'), /reconcile/i);
});

test('run evidence distinguishes the same shard across multiple phases', () => {
  const expected = [
    { ...shardEvidence, phase_id: 'ramp' },
    { ...shardEvidence, phase_id: 'steady' }
  ];
  const result = validateCapacityRunEvidence({
    mode: 'controlled',
    expected_manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: 'a'.repeat(64),
    expected_shards: expected.map((item) => ({
      phase_id: item.phase_id,
      shard_id: item.shard_id,
      workload_domain: item.workload_domain,
      workload_id: item.workload_id,
      expected_count: item.expected_count
    })),
    required_fleet_ids: ['ivekit_event_ws'],
    fleet_qualifications: [qualification],
    shard_evidence: expected,
    performance_contract: performanceContract,
    performance_evidence: performanceEvidence(),
    external_dependencies: []
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.reconciliation.expected, 2000);
});

test('run evidence reconciles multiple workload dimensions from one physical shard', () => {
  const connection = {
    ...shardEvidence,
    shard_id: 'connection/tinode_websocket/0-150',
    workload_id: 'tinode_websocket',
    expected_count: 150,
    attempted_count: 150,
    accepted_count: 150,
    active_peak_count: 150,
    sut_observed_count: 150,
    independent_observed_count: 150
  };
  const interaction = {
    ...connection,
    workload_domain: 'interaction' as const,
    workload_id: 'tinode_im',
    expected_count: 100,
    attempted_count: 100,
    accepted_count: 100,
    active_peak_count: 100,
    sut_observed_count: 100,
    independent_observed_count: 100
  };
  const result = validateCapacityRunEvidence({
    mode: 'controlled',
    expected_manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: 'a'.repeat(64),
    expected_shards: [connection, interaction].map((item) => ({
      shard_id: item.shard_id,
      workload_domain: item.workload_domain,
      workload_id: item.workload_id,
      expected_count: item.expected_count
    })),
    required_fleet_ids: ['ivekit_event_ws'],
    fleet_qualifications: [qualification],
    shard_evidence: [connection, interaction],
    performance_contract: performanceContract,
    performance_evidence: performanceEvidence(),
    external_dependencies: []
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.reconciliation.expected, 250);
  assert.equal(result.reconciliation.accepted, 250);
  assert.deepEqual(result.reconciliation.by_workload, {
    'connection:tinode_websocket': {
      expected: 150,
      attempted: 150,
      accepted: 150,
      sut_observed: 150,
      independent_observed: 150
    },
    'interaction:tinode_im': {
      expected: 100,
      attempted: 100,
      accepted: 100,
      sut_observed: 100,
      independent_observed: 100
    }
  });
});

test('raw endpoint QoE overrides a generator-provided SLO boolean', () => {
  const measured = performanceEvidence();
  measured.latency_ms.voice_mouth_to_ear_p95 =
    performanceContract.latency_ms.voice_mouth_to_ear_p95 + 1;
  const result = validateCapacityRunEvidence({
    mode: 'controlled',
    expected_manifest_sha256: 'a'.repeat(64),
    evidence_manifest_sha256: 'a'.repeat(64),
    expected_shards: [{
      shard_id: shardEvidence.shard_id,
      workload_domain: shardEvidence.workload_domain,
      workload_id: shardEvidence.workload_id,
      expected_count: shardEvidence.expected_count
    }],
    required_fleet_ids: ['ivekit_event_ws'],
    fleet_qualifications: [qualification],
    shard_evidence: [{ ...shardEvidence, slo_passed: true }],
    performance_contract: performanceContract,
    performance_evidence: measured,
    external_dependencies: []
  });

  assert.equal(result.outcome, 'failed');
  assert.match(result.reasons.join('\n'), /voice_mouth_to_ear_p95/i);
});
