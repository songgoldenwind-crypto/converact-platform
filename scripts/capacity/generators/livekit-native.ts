import type {
  LinuxProcessTreeObservation
} from './linux-process-tree-observer.js';
import {
  validateLiveKitNativeWorkloadManifest,
  type LiveKitNativeWorkloadManifest
} from './livekit-native-workload.js';

export interface LiveKitCliLoadTestSummary {
  received_tracks: number;
  expected_tracks: number;
  aggregate_bitrate_bps: number;
  average_subscriber_bitrate_bps: number;
  packet_loss_count: number;
  packet_loss_ratio: number;
  error_count: number;
}

export interface LiveKitNativeCommandObservation extends LinuxProcessTreeObservation {
  schema_version: '1.0.0' | '1.1.0';
  mode: 'run';
  observed_pid: number;
  executable: string;
  executable_sha256?: string;
  command_arg_count?: number;
  command_args_sha256?: string;
  exit_code: number;
  signal: string | null;
}

export interface LiveKitNativePidObservation extends LinuxProcessTreeObservation {
  schema_version: '1.0.0';
  mode: 'pid';
  observed_pid: number;
  duration_seconds: number;
}

export interface LiveKitNativeCapacityEvidence {
  schema_version: '1.2.0';
  protocol: 'livekit_webrtc_native_load';
  evidence_level: 'controlled';
  capacity_claim: 'none';
  status: 'controlled_pass' | 'controlled_failed' | 'invalid_generator_capacity';
  failure_class: 'none' | 'generator' | 'sut_or_protocol';
  run_id: string;
  expected_tracks: number;
  maximum_packet_loss_ratio: number;
  distinct_hosts_required: boolean;
  host_scope: 'unverified' | 'same_boot_domain' | 'distinct_boot_domain';
  workload_binding_required: boolean;
  workload_scope: 'unverified' | 'verified';
  workload?: LiveKitNativeWorkloadManifest;
  reasons: string[];
  summary: LiveKitCliLoadTestSummary;
  generator: LiveKitNativeCommandObservation;
  sut: LiveKitNativePidObservation;
}

export function parseLiveKitCliLoadTestSummary(raw: string): LiveKitCliLoadTestSummary {
  const rows = stripAnsi(raw)
    .split(/\r?\n/)
    .map((line) => line.split('│').map((cell) => cell.trim()).filter(Boolean))
    .filter((cells) => cells.length >= 5 && cells[0] === 'Total');
  const cells = rows.at(-1);
  if (!cells) throw new Error('LiveKit load-test aggregate summary is missing');

  const tracks = /^([0-9]+)\s*\/\s*([0-9]+)$/.exec(cells[1]);
  const bitrate = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?bps)\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?bps)\s+avg\s*\)$/i
    .exec(cells[2]);
  const loss = /^([0-9]+)\s*\(\s*([0-9]+(?:\.[0-9]+)?)%\s*\)$/.exec(cells[3]);
  const errors = /^([0-9]+)$/.exec(cells[4]);
  if (!tracks || !bitrate || !loss || !errors) {
    throw new Error('LiveKit load-test aggregate summary is invalid');
  }

  return {
    received_tracks: integer(tracks[1], 'received tracks'),
    expected_tracks: integer(tracks[2], 'expected tracks'),
    aggregate_bitrate_bps: bitrateBps(bitrate[1], bitrate[2]),
    average_subscriber_bitrate_bps: bitrateBps(bitrate[3], bitrate[4]),
    packet_loss_count: integer(loss[1], 'packet loss count'),
    packet_loss_ratio: Number(loss[2]) / 100,
    error_count: integer(errors[1], 'error count')
  };
}

export function evaluateLiveKitNativeCapacity(input: {
  run_id: string;
  expected_tracks: number;
  maximum_packet_loss_ratio: number;
  summary: LiveKitCliLoadTestSummary;
  generator: LiveKitNativeCommandObservation;
  sut: LiveKitNativePidObservation;
  require_distinct_hosts?: boolean;
  require_workload_binding?: boolean;
  workload?: LiveKitNativeWorkloadManifest;
}): LiveKitNativeCapacityEvidence {
  safeRunId(input.run_id);
  positiveInteger(input.expected_tracks, 'expected tracks');
  ratio(input.maximum_packet_loss_ratio, 'maximum packet loss ratio');
  validateSummary(input.summary);
  validateObservation(input.generator, 'run');
  validateObservation(input.sut, 'pid');
  const distinctHostsRequired = input.require_distinct_hosts ?? false;
  if (typeof distinctHostsRequired !== 'boolean') {
    throw new Error('invalid LiveKit distinct-host requirement');
  }
  const workloadBindingRequired = input.require_workload_binding ?? false;
  if (typeof workloadBindingRequired !== 'boolean') {
    throw new Error('invalid LiveKit workload-binding requirement');
  }
  const hostScope = classifyHostScope(input.generator, input.sut);

  const generatorReasons: string[] = [];
  const sutOrProtocolReasons: string[] = [];
  let workloadScope: LiveKitNativeCapacityEvidence['workload_scope'] = 'unverified';
  if (!input.workload) {
    if (workloadBindingRequired) {
      generatorReasons.push('LiveKit workload manifest is missing');
    }
  } else {
    validateLiveKitNativeWorkloadManifest(input.workload);
    const workloadReasons = qualifyWorkloadBinding({
      run_id: input.run_id,
      expected_tracks: input.expected_tracks,
      generator: input.generator,
      workload: input.workload
    });
    generatorReasons.push(...workloadReasons);
    if (workloadReasons.length === 0) workloadScope = 'verified';
  }
  if (distinctHostsRequired && hostScope === 'unverified') {
    generatorReasons.push('LiveKit generator/SUT boot-domain witness is missing');
  }
  if (distinctHostsRequired && hostScope === 'same_boot_domain') {
    generatorReasons.push('LiveKit load generator and SUT share the same boot domain');
  }
  if (input.generator.exit_code !== 0) {
    generatorReasons.push(`LiveKit load generator exited with code ${input.generator.exit_code}`);
  }
  if (input.generator.signal !== null) {
    generatorReasons.push(`LiveKit load generator exited on signal ${input.generator.signal}`);
  }
  if (input.generator.generator_cpu_p95_ratio > 0.6) {
    generatorReasons.push('LiveKit load generator CPU P95 exceeds 60%');
  }
  if (input.generator.host_cpu_p95_ratio > 0.85) {
    generatorReasons.push('LiveKit load generator host CPU P95 exceeds 85%');
  }
  if (input.generator.generator_nic_p95_ratio > 0.7) {
    generatorReasons.push('LiveKit load generator NIC P95 exceeds 70%');
  }
  if (input.generator.host_packet_drop_count > 0) {
    generatorReasons.push('LiveKit load generator host reported packet drops');
  }

  exact(input.summary.expected_tracks, input.expected_tracks, 'summary expected tracks', sutOrProtocolReasons);
  exact(input.summary.received_tracks, input.expected_tracks, 'received tracks', sutOrProtocolReasons);
  if (input.summary.error_count > 0) {
    sutOrProtocolReasons.push(`LiveKit load test reported ${input.summary.error_count} errors`);
  }
  if (input.summary.packet_loss_ratio > input.maximum_packet_loss_ratio) {
    sutOrProtocolReasons.push(
      `LiveKit packet loss ratio ${input.summary.packet_loss_ratio} exceeds ${input.maximum_packet_loss_ratio}`
    );
  }
  if (input.sut.generator_cpu_p95_ratio > 0.8) {
    sutOrProtocolReasons.push('LiveKit SUT CPU P95 exceeds 80%');
  }
  if (input.sut.host_cpu_p95_ratio > 0.85) {
    sutOrProtocolReasons.push('LiveKit SUT host CPU P95 exceeds 85%');
  }
  if (input.sut.generator_nic_p95_ratio > 0.7) {
    sutOrProtocolReasons.push('LiveKit SUT NIC P95 exceeds 70%');
  }
  if (input.sut.host_packet_drop_count > 0) {
    sutOrProtocolReasons.push('LiveKit SUT host reported packet drops');
  }

  const reasons = [...generatorReasons, ...sutOrProtocolReasons];
  const passed = reasons.length === 0;
  const invalidGenerator = generatorReasons.length > 0;
  return {
    schema_version: '1.2.0',
    protocol: 'livekit_webrtc_native_load',
    evidence_level: 'controlled',
    capacity_claim: 'none',
    status: passed ? 'controlled_pass'
      : invalidGenerator ? 'invalid_generator_capacity' : 'controlled_failed',
    failure_class: passed ? 'none' : invalidGenerator ? 'generator' : 'sut_or_protocol',
    run_id: input.run_id,
    expected_tracks: input.expected_tracks,
    maximum_packet_loss_ratio: input.maximum_packet_loss_ratio,
    distinct_hosts_required: distinctHostsRequired,
    host_scope: hostScope,
    workload_binding_required: workloadBindingRequired,
    workload_scope: workloadScope,
    ...(input.workload ? { workload: structuredClone(input.workload) } : {}),
    reasons,
    summary: { ...input.summary },
    generator: { ...input.generator },
    sut: { ...input.sut }
  };
}

function validateSummary(summary: LiveKitCliLoadTestSummary): void {
  nonNegativeInteger(summary.received_tracks, 'received tracks');
  nonNegativeInteger(summary.expected_tracks, 'summary expected tracks');
  nonNegativeNumber(summary.aggregate_bitrate_bps, 'aggregate bitrate');
  nonNegativeNumber(summary.average_subscriber_bitrate_bps, 'average subscriber bitrate');
  nonNegativeInteger(summary.packet_loss_count, 'packet loss count');
  ratio(summary.packet_loss_ratio, 'packet loss ratio');
  nonNegativeInteger(summary.error_count, 'error count');
}

function validateObservation(
  observation: LiveKitNativeCommandObservation | LiveKitNativePidObservation,
  mode: 'run' | 'pid'
): void {
  const schemaValid = mode === 'run'
    ? observation.schema_version === '1.0.0' || observation.schema_version === '1.1.0'
    : observation.schema_version === '1.0.0';
  if (!schemaValid || observation.mode !== mode ||
      observation.generator_observation_source !== 'linux_proc_tree') {
    throw new Error(`invalid LiveKit ${mode} observation`);
  }
  positiveInteger(observation.observed_pid, 'observed PID');
  positiveInteger(observation.generator_observation_sample_count, 'observation sample count');
  positiveInteger(observation.generator_nic_capacity_bps, 'NIC capacity');
  ratio(observation.generator_cpu_p95_ratio, 'process CPU P95 ratio');
  ratio(observation.host_cpu_p95_ratio, 'host CPU P95 ratio');
  ratio(observation.generator_nic_p95_ratio, 'NIC P95 ratio');
  nonNegativeInteger(observation.host_packet_drop_count, 'host packet drop count');
  const hasWitnessSource = observation.host_witness_source !== undefined;
  const hasBootHash = observation.host_boot_id_sha256 !== undefined;
  if (hasWitnessSource || hasBootHash) {
    if (observation.host_witness_source !== 'linux_boot_id_sha256' ||
        typeof observation.host_boot_id_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(observation.host_boot_id_sha256)) {
      throw new Error(`invalid LiveKit ${mode} host witness`);
    }
  }
  if (mode === 'run' && observation.schema_version === '1.1.0') {
    if (typeof observation.executable_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(observation.executable_sha256) ||
        !Number.isSafeInteger(observation.command_arg_count) ||
        Number(observation.command_arg_count) < 1 ||
        typeof observation.command_args_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(observation.command_args_sha256)) {
      throw new Error('invalid LiveKit run command witness');
    }
  }
}

function qualifyWorkloadBinding(input: {
  run_id: string;
  expected_tracks: number;
  generator: LiveKitNativeCommandObservation;
  workload: LiveKitNativeWorkloadManifest;
}): string[] {
  const reasons: string[] = [];
  if (input.generator.schema_version !== '1.1.0') {
    reasons.push('LiveKit generator observation has no command witness');
    return reasons;
  }
  if (input.workload.run_id !== input.run_id) {
    reasons.push('LiveKit workload run ID does not match the evidence run');
  }
  if (input.workload.expected_subscribed_tracks !== input.expected_tracks) {
    reasons.push('LiveKit workload track count does not match expected tracks');
  }
  if (input.workload.executable_sha256 !== input.generator.executable_sha256) {
    reasons.push('LiveKit workload executable does not match the observed executable');
  }
  if (input.workload.command_arg_count !== input.generator.command_arg_count) {
    reasons.push('LiveKit workload command argument count does not match the observed command');
  }
  if (input.workload.command_args_sha256 !== input.generator.command_args_sha256) {
    reasons.push('LiveKit workload command arguments do not match the observed command');
  }
  return reasons;
}

function classifyHostScope(
  generator: LiveKitNativeCommandObservation,
  sut: LiveKitNativePidObservation
): LiveKitNativeCapacityEvidence['host_scope'] {
  if (generator.host_witness_source !== 'linux_boot_id_sha256' ||
      sut.host_witness_source !== 'linux_boot_id_sha256' ||
      !generator.host_boot_id_sha256 ||
      !sut.host_boot_id_sha256) {
    return 'unverified';
  }
  return generator.host_boot_id_sha256 === sut.host_boot_id_sha256
    ? 'same_boot_domain'
    : 'distinct_boot_domain';
}

function bitrateBps(value: string, unit: string): number {
  const multiplier = new Map([
    ['bps', 1],
    ['kbps', 1_000],
    ['mbps', 1_000_000],
    ['gbps', 1_000_000_000],
    ['tbps', 1_000_000_000_000]
  ]).get(unit.toLowerCase());
  if (!multiplier) throw new Error('invalid LiveKit bitrate unit');
  const result = Number(value) * multiplier;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('invalid LiveKit bitrate');
  return result;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function exact(actual: number, expected: number, label: string, reasons: string[]): void {
  if (actual !== expected) reasons.push(`LiveKit ${label} ${actual} does not equal ${expected}`);
}

function safeRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value)) {
    throw new Error('invalid LiveKit native run ID');
  }
}

function integer(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid LiveKit ${label}`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`invalid LiveKit ${label}`);
  }
}

function nonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`invalid LiveKit ${label}`);
  }
}

function nonNegativeNumber(value: unknown, label: string): void {
  if (!Number.isFinite(value) || Number(value) < 0) throw new Error(`invalid LiveKit ${label}`);
}

function ratio(value: unknown, label: string): void {
  if (!Number.isFinite(value) || Number(value) < 0 || Number(value) > 1) {
    throw new Error(`invalid LiveKit ${label}`);
  }
}
