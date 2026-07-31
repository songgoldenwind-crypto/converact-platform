import type { WorkloadDomain } from './profile-compiler.js';
import type { RtcPerformanceContract } from './profile-compiler.js';
import type { GeneratorFleetQualification } from './generator-qualification.js';
import {
  evaluateRtcPerformanceEvidence,
  type RtcPerformanceEvidence
} from './performance-evaluator.js';

export interface ExpectedEvidenceShard {
  phase_id?: string;
  shard_id: string;
  workload_domain: WorkloadDomain;
  workload_id: string;
  expected_count: number;
}

export interface ShardRunEvidence extends ExpectedEvidenceShard {
  lease_epoch: string;
  attempted_count: number;
  accepted_count: number;
  active_peak_count: number;
  sut_observed_count: number;
  independent_observed_count: number;
  duplicate_id_count: number;
  stale_action_count: number;
  protocol_error_count: number;
  rate_conformant: boolean;
  slo_passed: boolean;
}

export interface CapacityEvidenceResult {
  outcome: 'passed' | 'failed' | 'invalid_generator_capacity' | 'not_run';
  reasons: string[];
  external_not_run: string[];
  reconciliation: {
    expected: number;
    attempted: number;
    accepted: number;
    sut_observed: number;
    independent_observed: number;
    by_workload: Record<string, {
      expected: number;
      attempted: number;
      accepted: number;
      sut_observed: number;
      independent_observed: number;
    }>;
  };
}

export function validateCapacityRunEvidence(input: {
  mode: 'controlled' | 'production';
  expected_manifest_sha256: string;
  evidence_manifest_sha256: string;
  expected_shards: ExpectedEvidenceShard[];
  required_fleet_ids: string[];
  fleet_qualifications: ReadonlyArray<Readonly<GeneratorFleetQualification>>;
  shard_evidence: ShardRunEvidence[];
  performance_contract: RtcPerformanceContract;
  performance_evidence: RtcPerformanceEvidence;
  external_dependencies: Array<{
    id: string;
    status: string;
    required_for_production_pass: boolean;
  }>;
}): CapacityEvidenceResult {
  const reasons: string[] = [];
  const externalNotRun = input.external_dependencies
    .filter((dependency) => dependency.status === 'not_run')
    .map((dependency) => dependency.id)
    .sort();
  const reconciliation = {
    expected: input.expected_shards.reduce((sum, shard) => sum + shard.expected_count, 0),
    attempted: 0,
    accepted: 0,
    sut_observed: 0,
    independent_observed: 0,
    by_workload: {} as CapacityEvidenceResult['reconciliation']['by_workload']
  };
  for (const shard of input.expected_shards) {
    const key = `${shard.workload_domain}:${shard.workload_id}`;
    const workload = reconciliation.by_workload[key] ||= {
      expected: 0,
      attempted: 0,
      accepted: 0,
      sut_observed: 0,
      independent_observed: 0
    };
    workload.expected += shard.expected_count;
  }

  const requiredFleets = new Set(input.required_fleet_ids);
  const qualificationFleets = new Set<string>();
  if (requiredFleets.size === 0 || requiredFleets.size !== input.required_fleet_ids.length) {
    reasons.push('required generator fleet IDs must be non-empty and unique');
  }
  for (const qualification of input.fleet_qualifications) {
    if (qualificationFleets.has(qualification.fleet_id)) {
      reasons.push(`duplicate qualification evidence for generator fleet ${qualification.fleet_id}`);
    }
    qualificationFleets.add(qualification.fleet_id);
  }
  for (const fleetId of requiredFleets) {
    if (!qualificationFleets.has(fleetId)) reasons.push(`missing qualification evidence for generator fleet ${fleetId}`);
  }
  const invalidFleets = input.fleet_qualifications
    .filter((qualification) => qualification.status !== 'qualified');
  if (invalidFleets.length > 0 || reasons.length > 0) {
    for (const fleet of invalidFleets) {
      reasons.push(`generator fleet ${fleet.fleet_id} is not qualified: ${fleet.reasons.join('; ')}`);
    }
    return { outcome: 'invalid_generator_capacity', reasons, external_not_run: externalNotRun, reconciliation };
  }
  if (input.fleet_qualifications.length === 0) {
    return {
      outcome: 'invalid_generator_capacity',
      reasons: ['no generator fleet qualification evidence was supplied'],
      external_not_run: externalNotRun,
      reconciliation
    };
  }

  if (!/^[a-f0-9]{64}$/.test(input.expected_manifest_sha256) ||
      input.evidence_manifest_sha256 !== input.expected_manifest_sha256) {
    reasons.push('evidence does not bind the expected immutable manifest hash');
  }
  const performance = evaluateRtcPerformanceEvidence(
    input.performance_contract,
    input.performance_evidence
  );
  reasons.push(...performance.reasons.map((reason) => `RTC performance: ${reason}`));

  const expectedById = uniqueMap(input.expected_shards, 'expected');
  const evidenceById = uniqueMap(input.shard_evidence, 'evidence', reasons);
  for (const [evidenceKey, expected] of expectedById) {
    const evidence = evidenceById.get(evidenceKey);
    const shardLabel = evidenceLabel(expected);
    if (!evidence) {
      reasons.push(`missing evidence for shard ${shardLabel}`);
      continue;
    }
    if ((evidence.phase_id || '') !== (expected.phase_id || '') ||
        evidence.workload_domain !== expected.workload_domain ||
        evidence.workload_id !== expected.workload_id ||
        evidence.expected_count !== expected.expected_count) {
      reasons.push(`evidence contract mismatch for shard ${shardLabel}`);
    }
    validateNonNegativeIntegers(evidence, reasons);
    reconciliation.attempted += evidence.attempted_count;
    reconciliation.accepted += evidence.accepted_count;
    reconciliation.sut_observed += evidence.sut_observed_count;
    reconciliation.independent_observed += evidence.independent_observed_count;
    const workload = reconciliation.by_workload[
      `${expected.workload_domain}:${expected.workload_id}`
    ];
    workload.attempted += evidence.attempted_count;
    workload.accepted += evidence.accepted_count;
    workload.sut_observed += evidence.sut_observed_count;
    workload.independent_observed += evidence.independent_observed_count;
    if (!/^[1-9][0-9]{0,18}$/.test(evidence.lease_epoch)) {
      reasons.push(`shard ${shardLabel} has no active lease epoch`);
    }
    if (evidence.attempted_count !== expected.expected_count ||
        evidence.accepted_count !== expected.expected_count ||
        evidence.active_peak_count !== expected.expected_count ||
        evidence.sut_observed_count !== expected.expected_count ||
        evidence.independent_observed_count !== expected.expected_count) {
      reasons.push(`client, SUT and independent observations do not reconcile for shard ${shardLabel}`);
    }
    if (evidence.duplicate_id_count > 0) reasons.push(`shard ${shardLabel} contains duplicate IDs`);
    if (evidence.stale_action_count > 0) reasons.push(`shard ${shardLabel} contains stale lease actions`);
    if (evidence.protocol_error_count > 0) reasons.push(`shard ${shardLabel} contains protocol errors`);
    if (!evidence.rate_conformant) reasons.push(`shard ${shardLabel} missed its rate contract`);
    if (!evidence.slo_passed) reasons.push(`shard ${shardLabel} failed its SLO`);
  }
  for (const evidenceKey of evidenceById.keys()) {
    if (!expectedById.has(evidenceKey)) {
      reasons.push(`unexpected evidence shard ${evidenceKey}`);
    }
  }

  if (reasons.length > 0) {
    return {
      outcome: 'failed',
      reasons,
      external_not_run: externalNotRun,
      reconciliation
    };
  }

  if (input.mode === 'production') {
    const missingProduction = input.external_dependencies
      .filter((dependency) => dependency.required_for_production_pass && dependency.status !== 'passed')
      .map((dependency) => dependency.id)
      .sort();
    if (missingProduction.length > 0) {
      return {
        outcome: 'not_run',
        reasons: [`required production dependencies are not passed: ${missingProduction.join(', ')}`],
        external_not_run: externalNotRun,
        reconciliation
      };
    }
  }

  return {
    outcome: 'passed',
    reasons,
    external_not_run: externalNotRun,
    reconciliation
  };
}

function uniqueMap<T extends {
  phase_id?: string;
  shard_id: string;
  workload_domain: WorkloadDomain;
  workload_id: string;
}>(
  items: T[],
  label: string,
  reasons?: string[]
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = evidenceKey(item);
    if (result.has(key)) {
      if (reasons) reasons.push(`duplicate ${label} for shard ${evidenceLabel(item)}`);
      else throw new Error(`duplicate ${label} shard ${evidenceLabel(item)}`);
    } else {
      result.set(key, item);
    }
  }
  return result;
}

function evidenceKey(value: {
  phase_id?: string;
  shard_id: string;
  workload_domain: WorkloadDomain;
  workload_id: string;
}): string {
  return [
    value.phase_id || '',
    value.shard_id,
    value.workload_domain,
    value.workload_id
  ].join(':');
}

function evidenceLabel(value: {
  phase_id?: string;
  shard_id: string;
  workload_domain?: WorkloadDomain;
  workload_id?: string;
}): string {
  const shard = value.phase_id ? `${value.phase_id}/${value.shard_id}` : value.shard_id;
  return value.workload_domain && value.workload_id
    ? `${shard}[${value.workload_domain}:${value.workload_id}]`
    : shard;
}

function validateNonNegativeIntegers(evidence: ShardRunEvidence, reasons: string[]): void {
  const shardLabel = evidenceLabel(evidence);
  for (const [field, value] of Object.entries({
    expected_count: evidence.expected_count,
    attempted_count: evidence.attempted_count,
    accepted_count: evidence.accepted_count,
    active_peak_count: evidence.active_peak_count,
    sut_observed_count: evidence.sut_observed_count,
    independent_observed_count: evidence.independent_observed_count,
    duplicate_id_count: evidence.duplicate_id_count,
    stale_action_count: evidence.stale_action_count,
    protocol_error_count: evidence.protocol_error_count
  })) {
    if (!Number.isInteger(value) || value < 0) reasons.push(`shard ${shardLabel} has invalid ${field}`);
  }
}
