import type { ExternalJsonGeneratorPlan } from './external-json.js';

export interface RtpMediaTwinPlanInput {
  binary: string;
  binary_version: string;
  binary_sha256: string;
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  session_manifest_path: string;
  codec: 'pcmu' | 'pcma' | 'opus';
  payload_type: number;
  clock_rate_hz: number;
  packetization_ms: number;
  directions_per_session: 1 | 2;
  duration_seconds: number;
  local_bind_ip: string;
  result_path: string;
  maximum_loss_ratio: number;
  maximum_jitter_p99_ms: number;
}

export interface RtpMediaTwinProcessInput extends Record<string, unknown> {
  schema_version: '1.0.0';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  expected_sessions: number;
  expected_packet_rate: number;
  session_manifest_path: string;
  codec: RtpMediaTwinPlanInput['codec'];
  payload_type: number;
  clock_rate_hz: number;
  packetization_ms: number;
  directions_per_session: 1 | 2;
  duration_seconds: number;
  local_bind_ip: string;
  result_path: string;
}

export interface RtpMediaTwinPlan extends ExternalJsonGeneratorPlan<RtpMediaTwinProcessInput> {
  protocol: 'rtp';
  source: RtpMediaTwinPlanInput;
}

export interface RtpMediaTwinRawEvidence {
  protocol_handshake_count: number;
  active_peak_sessions: number;
  sent_packets: number;
  received_packets: number;
  actual_packet_rate: number;
  receive_loss_ratio: number;
  duplicate_packet_count: number;
  out_of_order_packet_count: number;
  jitter_p99_ms: number;
  stale_epoch_action_count: number;
  generator_cpu_p95_ratio: number;
  generator_nic_p95_ratio: number;
  host_packet_drop_count: number;
}

export interface RtpMediaTwinEvidence {
  protocol: 'rtp';
  evidence_level: 'controlled';
  status: 'controlled_pass' | 'controlled_failed' | 'invalid_generator_capacity';
  failure_class: 'none' | 'generator' | 'sut_or_protocol';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  expected_sessions: number;
  expected_packet_rate: number;
  actual_packet_rate: number;
  reasons: string[];
  binary_version: string;
  binary_sha256: string;
  raw: RtpMediaTwinRawEvidence;
}

export function buildRtpMediaTwinPlan(input: RtpMediaTwinPlanInput): RtpMediaTwinPlan {
  validateCommon(input);
  if (!['pcmu', 'pcma', 'opus'].includes(input.codec)) throw new Error('invalid RTP codec');
  boundedInteger(input.payload_type, 0, 127, 'payload type');
  boundedInteger(input.clock_rate_hz, 8_000, 48_000, 'clock rate');
  if (![10, 20, 30, 40, 60].includes(input.packetization_ms)) {
    throw new Error('invalid RTP packetization');
  }
  boundedInteger(input.duration_seconds, 1, 86_400, 'duration');
  ratio(input.maximum_loss_ratio, 'maximum loss ratio');
  positive(input.maximum_jitter_p99_ms, 'maximum jitter');
  const expectedSessions = input.ordinal_end_exclusive - input.ordinal_start;
  const expectedPacketRate = expectedSessions * input.directions_per_session *
    (1_000 / input.packetization_ms);
  if (!Number.isInteger(expectedPacketRate)) throw new Error('RTP packet rate must be integral');
  const processInput: RtpMediaTwinProcessInput = {
    schema_version: '1.0.0',
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    ordinal_start: input.ordinal_start,
    ordinal_end_exclusive: input.ordinal_end_exclusive,
    expected_sessions: expectedSessions,
    expected_packet_rate: expectedPacketRate,
    session_manifest_path: absolutePath(input.session_manifest_path, 'session manifest'),
    codec: input.codec,
    payload_type: input.payload_type,
    clock_rate_hz: input.clock_rate_hz,
    packetization_ms: input.packetization_ms,
    directions_per_session: input.directions_per_session,
    duration_seconds: input.duration_seconds,
    local_bind_ip: ipAddress(input.local_bind_ip),
    result_path: absolutePath(input.result_path, 'result path')
  };
  return {
    protocol: 'rtp',
    source: structuredClone(input),
    executable: absolutePath(input.binary, 'binary'),
    binary_version: input.binary_version,
    binary_sha256: input.binary_sha256,
    args: ['run', '--input-json', '-', '--result', processInput.result_path],
    input: processInput,
    result_path: processInput.result_path,
    timeout_ms: (input.duration_seconds + 30) * 1_000
  };
}

export function evaluateRtpMediaTwinEvidence(input: {
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  expected_sessions: number;
  expected_packet_rate: number;
  duration_seconds: number;
  maximum_loss_ratio: number;
  maximum_jitter_p99_ms: number;
  binary_version: string;
  binary_sha256: string;
  raw: RtpMediaTwinRawEvidence;
}): RtpMediaTwinEvidence {
  validateEvidenceIdentity(input);
  const raw = validateRaw(input.raw);
  const reasons: string[] = [];
  const rateConformant = Math.abs(raw.actual_packet_rate - input.expected_packet_rate) <=
    input.expected_packet_rate * 0.01;
  const generatorInvalid = !rateConformant || raw.generator_cpu_p95_ratio > 0.6 ||
    raw.generator_nic_p95_ratio > 0.7 || raw.host_packet_drop_count > 0;
  if (!rateConformant) reasons.push('RTP generator packet rate is outside 1% tolerance');
  if (raw.generator_cpu_p95_ratio > 0.6) reasons.push('RTP generator CPU P95 exceeds 60%');
  if (raw.generator_nic_p95_ratio > 0.7) reasons.push('RTP generator NIC P95 exceeds 70%');
  if (raw.host_packet_drop_count > 0) reasons.push('RTP generator host reported packet drops');
  if (raw.protocol_handshake_count !== input.expected_sessions) {
    reasons.push('RTP protocol handshake count does not match expected sessions');
  }
  if (raw.active_peak_sessions !== input.expected_sessions) {
    reasons.push('RTP active peak does not match expected sessions');
  }
  if (raw.receive_loss_ratio > input.maximum_loss_ratio) {
    reasons.push('RTP receive loss exceeds the configured SLO');
  }
  if (raw.jitter_p99_ms > input.maximum_jitter_p99_ms) {
    reasons.push('RTP jitter P99 exceeds the configured SLO');
  }
  if (raw.duplicate_packet_count > 0) reasons.push('RTP duplicate packets were observed');
  if (raw.out_of_order_packet_count > 0) reasons.push('RTP out-of-order packets were observed');
  if (raw.stale_epoch_action_count > 0) reasons.push('RTP stale lease actions were observed');
  const passed = reasons.length === 0;
  return {
    protocol: 'rtp',
    evidence_level: 'controlled',
    status: passed ? 'controlled_pass'
      : generatorInvalid ? 'invalid_generator_capacity' : 'controlled_failed',
    failure_class: passed ? 'none' : generatorInvalid ? 'generator' : 'sut_or_protocol',
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    expected_sessions: input.expected_sessions,
    expected_packet_rate: input.expected_packet_rate,
    actual_packet_rate: raw.actual_packet_rate,
    reasons,
    binary_version: input.binary_version,
    binary_sha256: input.binary_sha256,
    raw
  };
}

export function evaluateRtpMediaTwinPlanEvidence(
  plan: RtpMediaTwinPlan,
  raw: RtpMediaTwinRawEvidence
): RtpMediaTwinEvidence {
  return evaluateRtpMediaTwinEvidence({
    run_id: plan.input.run_id,
    shard_id: plan.input.shard_id,
    worker_id: plan.input.worker_id,
    lease_epoch: plan.input.lease_epoch,
    expected_sessions: plan.input.expected_sessions,
    expected_packet_rate: plan.input.expected_packet_rate,
    duration_seconds: plan.input.duration_seconds,
    maximum_loss_ratio: plan.source.maximum_loss_ratio,
    maximum_jitter_p99_ms: plan.source.maximum_jitter_p99_ms,
    binary_version: plan.binary_version,
    binary_sha256: plan.binary_sha256,
    raw
  });
}

function validateCommon(input: RtpMediaTwinPlanInput): void {
  safeId(input.run_id, 'run ID');
  safeShard(input.shard_id);
  safeId(input.worker_id, 'worker ID');
  epoch(input.lease_epoch);
  if (!input.binary_version || input.binary_version.length > 255) throw new Error('invalid RTP binary version');
  sha(input.binary_sha256);
  boundedInteger(input.ordinal_start, 0, 1_000_000_000, 'ordinal start');
  boundedInteger(input.ordinal_end_exclusive, input.ordinal_start + 1, 1_000_000_000, 'ordinal end');
}

function validateEvidenceIdentity(input: {
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  expected_sessions: number;
  expected_packet_rate: number;
  duration_seconds: number;
  maximum_loss_ratio: number;
  maximum_jitter_p99_ms: number;
  binary_version: string;
  binary_sha256: string;
}): void {
  safeId(input.run_id, 'run ID');
  safeShard(input.shard_id);
  safeId(input.worker_id, 'worker ID');
  epoch(input.lease_epoch);
  positive(input.expected_sessions, 'expected sessions');
  positive(input.expected_packet_rate, 'expected packet rate');
  positive(input.duration_seconds, 'duration');
  ratio(input.maximum_loss_ratio, 'maximum loss ratio');
  positive(input.maximum_jitter_p99_ms, 'maximum jitter');
  if (!input.binary_version) throw new Error('invalid RTP binary version');
  sha(input.binary_sha256);
}

function validateRaw(raw: RtpMediaTwinRawEvidence): RtpMediaTwinRawEvidence {
  for (const [key, value] of Object.entries(raw)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid RTP evidence ${key}`);
  }
  return structuredClone(raw);
}

function safeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) throw new Error(`invalid ${label}`);
}

function safeShard(value: string): void {
  if (!value || value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._@:/-]+$/.test(value)) {
    throw new Error('invalid shard ID');
  }
}

function epoch(value: string): void {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new Error('invalid lease epoch');
}

function sha(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid SHA-256');
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid ${label}`);
  }
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid ${label}`);
}

function ratio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`invalid ${label}`);
}

function absolutePath(value: string, label: string): string {
  if (!value.startsWith('/') || /[\r\n\0]/.test(value) || value.split('/').includes('..')) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function ipAddress(value: string): string {
  if (!/^[0-9a-fA-F:.]+$/.test(value)) throw new Error('invalid local bind IP');
  return value;
}
