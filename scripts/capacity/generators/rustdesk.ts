import type { ExternalJsonGeneratorPlan } from './external-json.js';

export interface RustDeskSyntheticPlanInput {
  binary: string;
  binary_version: string;
  binary_sha256: string;
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  id_server: string;
  relay_server: string;
  public_key_fingerprint: string;
  identity_bundle_path: string;
  office_trace_path: string;
  office_trace_sha256: string;
  high_motion_trace_path: string;
  high_motion_trace_sha256: string;
  file_fixture_path: string;
  file_fixture_sha256: string;
  forced_relay_ratio: number;
  high_motion_session_ratio: number;
  file_transfer_session_ratio: number;
  reconnect_session_ratio: number;
  quality_limits: RustDeskSyntheticQualityLimits;
  duration_seconds: number;
  result_path: string;
  driver: 'rustdesk_native';
}

export interface RustDeskSyntheticQualityLimits {
  control_ack_p95_ms: number;
  control_ack_p99_ms: number;
  media_update_p95_ms: number;
  media_update_p99_ms: number;
  reconnect_success_ratio: number;
  reconnect_recovery_p99_ms: number;
}

export interface RustDeskSyntheticProcessInput extends Record<string, unknown> {
  schema_version: '1.1.0';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  expected_sessions: number;
  expected_forced_relay_sessions: number;
  expected_high_motion_sessions: number;
  expected_file_transfers: number;
  expected_reconnect_sessions: number;
  quality_limits: RustDeskSyntheticQualityLimits;
  id_server: string;
  relay_server: string;
  public_key_fingerprint: string;
  identity_bundle_path: string;
  office_trace: { path: string; sha256: string; target_bitrate_bps: 800_000 };
  high_motion_trace: { path: string; sha256: string; peak_bitrate_bps: 24_000_000 };
  file_fixture: { path: string; sha256: string };
  duration_seconds: number;
  driver: 'rustdesk_native';
  correctness_lane: 'synthetic_protocol_only';
  latency_lane: 'synthetic_protocol_delivery_only';
  result_path: string;
}

export interface RustDeskSyntheticPlan
  extends ExternalJsonGeneratorPlan<RustDeskSyntheticProcessInput> {
  protocol: 'rustdesk_native';
  source: RustDeskSyntheticPlanInput;
}

export interface RustDeskSyntheticRawEvidence {
  hbbs_registration_count: number;
  hbbs_rendezvous_count: number;
  hbbr_relay_handshake_count: number;
  active_peak_sessions: number;
  direct_session_count: number;
  relay_session_count: number;
  media_bytes_sent: number;
  media_bytes_received: number;
  input_event_count: number;
  clipboard_event_count: number;
  file_transfer_completed_count: number;
  file_transfer_checksum_mismatch_count: number;
  control_ack_p95_ms: number;
  control_ack_p99_ms: number;
  media_update_p95_ms: number;
  media_update_p99_ms: number;
  reconnect_attempt_count: number;
  reconnect_success_count: number;
  reconnect_recovery_p99_ms: number;
  stale_epoch_action_count: number;
  generator_cpu_p95_ratio: number;
  generator_nic_p95_ratio: number;
  host_packet_drop_count: number;
}

export interface RustDeskSyntheticEvidence {
  protocol: 'rustdesk_native';
  evidence_level: 'controlled';
  correctness_lane: 'synthetic_protocol_only';
  latency_lane: 'synthetic_protocol_delivery_only';
  status: 'controlled_pass' | 'controlled_failed' | 'invalid_generator_capacity';
  failure_class: 'none' | 'generator' | 'sut_or_protocol';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  reasons: string[];
  binary_version: string;
  binary_sha256: string;
  raw: RustDeskSyntheticRawEvidence;
}

export function buildRustDeskSyntheticPlan(
  input: RustDeskSyntheticPlanInput
): RustDeskSyntheticPlan {
  common(input);
  if (input.driver !== 'rustdesk_native') {
    throw new Error('RustDesk synthetic fleet requires the native protocol driver');
  }
  endpoint(input.id_server, 'ID server');
  endpoint(input.relay_server, 'relay server');
  if (!/^sha256:[a-f0-9]{64}$/.test(input.public_key_fingerprint)) {
    throw new Error('invalid RustDesk public key fingerprint');
  }
  ratio(input.forced_relay_ratio, 'forced relay ratio');
  ratio(input.high_motion_session_ratio, 'high motion ratio');
  ratio(input.file_transfer_session_ratio, 'file transfer ratio');
  ratio(input.reconnect_session_ratio, 'reconnect session ratio');
  validateQualityLimits(input.quality_limits);
  bounded(input.duration_seconds, 1, 86_400, 'duration');
  const expectedSessions = input.ordinal_end_exclusive - input.ordinal_start;
  const processInput: RustDeskSyntheticProcessInput = {
    schema_version: '1.1.0',
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    ordinal_start: input.ordinal_start,
    ordinal_end_exclusive: input.ordinal_end_exclusive,
    expected_sessions: expectedSessions,
    expected_forced_relay_sessions: Math.round(expectedSessions * input.forced_relay_ratio),
    expected_high_motion_sessions: Math.round(expectedSessions * input.high_motion_session_ratio),
    expected_file_transfers: Math.round(expectedSessions * input.file_transfer_session_ratio),
    expected_reconnect_sessions: Math.round(expectedSessions * input.reconnect_session_ratio),
    quality_limits: structuredClone(input.quality_limits),
    id_server: input.id_server,
    relay_server: input.relay_server,
    public_key_fingerprint: input.public_key_fingerprint,
    identity_bundle_path: absolute(input.identity_bundle_path, 'identity bundle'),
    office_trace: {
      path: absolute(input.office_trace_path, 'office trace'),
      sha256: checkedSha(input.office_trace_sha256),
      target_bitrate_bps: 800_000
    },
    high_motion_trace: {
      path: absolute(input.high_motion_trace_path, 'high motion trace'),
      sha256: checkedSha(input.high_motion_trace_sha256),
      peak_bitrate_bps: 24_000_000
    },
    file_fixture: {
      path: absolute(input.file_fixture_path, 'file fixture'),
      sha256: checkedSha(input.file_fixture_sha256)
    },
    duration_seconds: input.duration_seconds,
    driver: 'rustdesk_native',
    correctness_lane: 'synthetic_protocol_only',
    latency_lane: 'synthetic_protocol_delivery_only',
    result_path: absolute(input.result_path, 'result path')
  };
  return {
    protocol: 'rustdesk_native',
    source: structuredClone(input),
    executable: absolute(input.binary, 'binary'),
    binary_version: input.binary_version,
    binary_sha256: input.binary_sha256,
    args: ['run', '--input-json', '-', '--result', processInput.result_path],
    input: processInput,
    result_path: processInput.result_path,
    timeout_ms: (input.duration_seconds + 60) * 1_000
  };
}

export function evaluateRustDeskSyntheticEvidence(input: {
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  expected_sessions: number;
  expected_forced_relay_sessions: number;
  expected_file_transfers: number;
  expected_reconnect_sessions: number;
  quality_limits: RustDeskSyntheticQualityLimits;
  binary_version: string;
  binary_sha256: string;
  raw: RustDeskSyntheticRawEvidence;
}): RustDeskSyntheticEvidence {
  safeId(input.run_id, 'run ID');
  safeShard(input.shard_id);
  safeId(input.worker_id, 'worker ID');
  epoch(input.lease_epoch);
  checkedSha(input.binary_sha256);
  validateQualityLimits(input.quality_limits);
  const raw = finiteRaw(input.raw);
  const reasons: string[] = [];
  const generatorInvalid = raw.generator_cpu_p95_ratio > 0.6 ||
    raw.generator_nic_p95_ratio > 0.7 || raw.host_packet_drop_count > 0;
  if (raw.generator_cpu_p95_ratio > 0.6) reasons.push('RustDesk generator CPU P95 exceeds 60%');
  if (raw.generator_nic_p95_ratio > 0.7) reasons.push('RustDesk generator NIC P95 exceeds 70%');
  if (raw.host_packet_drop_count > 0) reasons.push('RustDesk generator host reported packet drops');
  if (raw.hbbs_registration_count !== input.expected_sessions) {
    reasons.push('RustDesk hbbs registration count does not match expected sessions');
  }
  if (raw.hbbs_rendezvous_count !== input.expected_sessions) {
    reasons.push('RustDesk hbbs rendezvous count does not match expected sessions');
  }
  if (input.expected_forced_relay_sessions > 0 &&
      raw.hbbr_relay_handshake_count !== input.expected_forced_relay_sessions) {
    reasons.push('RustDesk hbbr relay handshake count does not match forced relay sessions');
  }
  exact(raw.active_peak_sessions, input.expected_sessions, 'active peak sessions', reasons);
  exact(raw.relay_session_count, input.expected_forced_relay_sessions, 'relay sessions', reasons);
  exact(
    raw.direct_session_count,
    input.expected_sessions - input.expected_forced_relay_sessions,
    'direct sessions',
    reasons
  );
  if (raw.media_bytes_sent <= 0 || raw.media_bytes_received <= 0) {
    reasons.push('RustDesk native media bytes were not observed');
  }
  if (raw.input_event_count < input.expected_sessions) {
    reasons.push('RustDesk input event count is below expected sessions');
  }
  if (raw.clipboard_event_count < input.expected_sessions) {
    reasons.push('RustDesk clipboard event count is below expected sessions');
  }
  exact(
    raw.file_transfer_completed_count,
    input.expected_file_transfers,
    'file transfer completions',
    reasons
  );
  if (raw.file_transfer_checksum_mismatch_count > 0) {
    reasons.push('RustDesk file transfer checksum mismatches were observed');
  }
  maximum(raw.control_ack_p95_ms, input.quality_limits.control_ack_p95_ms, 'control ACK P95', reasons);
  maximum(raw.control_ack_p99_ms, input.quality_limits.control_ack_p99_ms, 'control ACK P99', reasons);
  maximum(raw.media_update_p95_ms, input.quality_limits.media_update_p95_ms, 'media update P95', reasons);
  maximum(raw.media_update_p99_ms, input.quality_limits.media_update_p99_ms, 'media update P99', reasons);
  exact(
    raw.reconnect_attempt_count,
    input.expected_reconnect_sessions,
    'reconnect attempts',
    reasons
  );
  if (raw.reconnect_success_count > raw.reconnect_attempt_count) {
    reasons.push('RustDesk reconnect successes exceed attempts');
  }
  if (input.expected_reconnect_sessions > 0) {
    const reconnectSuccessRatio = raw.reconnect_success_count / raw.reconnect_attempt_count;
    if (reconnectSuccessRatio < input.quality_limits.reconnect_success_ratio) {
      reasons.push(
        `RustDesk reconnect success ratio ${reconnectSuccessRatio} is below ${input.quality_limits.reconnect_success_ratio}`
      );
    }
    maximum(
      raw.reconnect_recovery_p99_ms,
      input.quality_limits.reconnect_recovery_p99_ms,
      'reconnect recovery P99',
      reasons
    );
  }
  if (raw.stale_epoch_action_count > 0) reasons.push('RustDesk stale lease actions were observed');
  const passed = reasons.length === 0;
  return {
    protocol: 'rustdesk_native',
    evidence_level: 'controlled',
    correctness_lane: 'synthetic_protocol_only',
    latency_lane: 'synthetic_protocol_delivery_only',
    status: passed ? 'controlled_pass'
      : generatorInvalid ? 'invalid_generator_capacity' : 'controlled_failed',
    failure_class: passed ? 'none' : generatorInvalid ? 'generator' : 'sut_or_protocol',
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    reasons,
    binary_version: input.binary_version,
    binary_sha256: input.binary_sha256,
    raw
  };
}

export function evaluateRustDeskSyntheticPlanEvidence(
  plan: RustDeskSyntheticPlan,
  raw: RustDeskSyntheticRawEvidence
): RustDeskSyntheticEvidence {
  return evaluateRustDeskSyntheticEvidence({
    run_id: plan.input.run_id,
    shard_id: plan.input.shard_id,
    worker_id: plan.input.worker_id,
    lease_epoch: plan.input.lease_epoch,
    expected_sessions: plan.input.expected_sessions,
    expected_forced_relay_sessions: plan.input.expected_forced_relay_sessions,
    expected_file_transfers: plan.input.expected_file_transfers,
    expected_reconnect_sessions: plan.input.expected_reconnect_sessions,
    quality_limits: plan.input.quality_limits,
    binary_version: plan.binary_version,
    binary_sha256: plan.binary_sha256,
    raw
  });
}

function common(input: RustDeskSyntheticPlanInput): void {
  safeId(input.run_id, 'run ID');
  safeShard(input.shard_id);
  safeId(input.worker_id, 'worker ID');
  epoch(input.lease_epoch);
  if (!input.binary_version || input.binary_version.length > 255) throw new Error('invalid RustDesk binary version');
  checkedSha(input.binary_sha256);
  bounded(input.ordinal_start, 0, 1_000_000_000, 'ordinal start');
  bounded(input.ordinal_end_exclusive, input.ordinal_start + 1, 1_000_000_000, 'ordinal end');
}

function finiteRaw<T extends object>(raw: T): T {
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`invalid RustDesk evidence ${field}`);
    }
  }
  return structuredClone(raw);
}

function exact(actual: number, expected: number, label: string, reasons: string[]): void {
  if (actual !== expected) reasons.push(`RustDesk ${label} ${actual} does not equal ${expected}`);
}

function maximum(actual: number, limit: number, label: string, reasons: string[]): void {
  if (actual > limit) reasons.push(`RustDesk ${label} ${actual} exceeds ${limit}`);
}

function validateQualityLimits(limits: RustDeskSyntheticQualityLimits): void {
  if (!limits || typeof limits !== 'object') throw new Error('invalid RustDesk quality limits');
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid RustDesk quality limit ${field}`);
  }
  ratio(limits.reconnect_success_ratio, 'RustDesk reconnect success ratio');
  if (limits.reconnect_success_ratio <= 0) throw new Error('invalid RustDesk reconnect success ratio');
  if (limits.control_ack_p95_ms > limits.control_ack_p99_ms) {
    throw new Error('RustDesk control ACK P95 limit exceeds P99 limit');
  }
  if (limits.media_update_p95_ms > limits.media_update_p99_ms) {
    throw new Error('RustDesk media update P95 limit exceeds P99 limit');
  }
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function safeShard(value: string): void {
  if (!value || value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._@:/-]+$/.test(value)) {
    throw new Error('invalid shard ID');
  }
}

function epoch(value: string): void {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new Error('invalid lease epoch');
}

function checkedSha(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid SHA-256');
  return value;
}

function bounded(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid ${label}`);
  }
}

function ratio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`invalid ${label}`);
}

function absolute(value: string, label: string): string {
  if (!value.startsWith('/') || /[\r\n\0]/.test(value) || value.split('/').includes('..')) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function endpoint(value: string, label: string): void {
  if (!/^[A-Za-z0-9.-]+:[1-9][0-9]{0,4}$/.test(value)) throw new Error(`invalid RustDesk ${label}`);
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  if (port > 65_535) throw new Error(`invalid RustDesk ${label}`);
}
