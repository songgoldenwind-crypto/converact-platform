import assert from 'node:assert/strict';
import test from 'node:test';

import {
  qualifyGeneratorFleet,
  type GeneratorWorkerCapacity
} from '../scripts/capacity/generator-qualification.js';
import { validateCapacityRunEvidence } from '../scripts/capacity/evidence-validator.js';

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
    independent_observed: 1000
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
    external_dependencies: []
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.reconciliation.expected, 2000);
});
