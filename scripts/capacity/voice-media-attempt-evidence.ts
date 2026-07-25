import { createHash } from 'node:crypto';

export interface VoiceMediaAttemptInput {
  schema_version: '1.0.0';
  run_id: string;
  attempt_id: string;
  profile_id: string;
  phase_id: string;
  repetition: number;
  observation_kind: 'steady_state' | 'phase_end';
  started_at: string;
  finished_at: string;
  source_identity: {
    profile_sha256: string;
    fork_manifest_sha256: string;
    sut_release_id: string;
    generator_release_id: string;
  };
  counters: VoiceMediaAttemptCounters;
  generator: {
    expected_packet_rate: number;
    actual_packet_rate: number;
    cpu_p95_ratio: number;
    nic_p95_ratio: number;
    host_packet_drop_count: number;
    scheduler_lag_p99_seconds: number;
  };
  clock: {
    clock_source: string;
    ntp_offset_seconds: number;
    captured_at: string;
  };
  media: {
    expected_sessions: number;
    protocol_handshake_count: number;
    sent_packets: number;
    received_packets: number;
    receive_loss_ratio: number;
    duplicate_packet_count: number;
    out_of_order_packet_count: number;
    jitter_p99_seconds: number;
  };
  sut: {
    setup_success_ratio: number;
    relay_latency_p99_seconds: number;
    unexpected_restart_count: number;
    oom_kill_count: number;
  };
  thresholds: {
    generator_packet_rate_tolerance_ratio: number;
    generator_cpu_p95_ratio: number;
    generator_nic_p95_ratio: number;
    generator_scheduler_lag_p99_seconds: number;
    clock_offset_seconds: number;
    setup_success_ratio: number;
    server_packet_loss_ratio: number;
    jitter_p99_seconds: number;
    relay_latency_p99_seconds: number;
  };
}

export interface VoiceMediaAttemptCounters {
  attempted: number;
  connected: number;
  failed: number;
  active: number;
  completed: number;
}

export interface VoiceMediaAttemptEvidence {
  schema_version: '1.0.0';
  evidence_type: 'voice_media_attempt';
  status: 'passed' | 'failed' | 'invalid_generator_capacity';
  failure_class: 'none' | 'generator' | 'sut_or_protocol';
  run_id: string;
  attempt_id: string;
  profile_id: string;
  phase_id: string;
  repetition: number;
  observation_kind: VoiceMediaAttemptInput['observation_kind'];
  started_at: string;
  finished_at: string;
  source_identity: VoiceMediaAttemptInput['source_identity'];
  counters: VoiceMediaAttemptCounters;
  reconciliation: {
    attempted_minus_connected_failed: number;
    connected_minus_active_completed: number;
    reconciled: boolean;
  };
  generator_qualification: {
    qualified: boolean;
    reasons: string[];
    observed: VoiceMediaAttemptInput['generator'];
  };
  sut_evaluation: {
    passed: boolean;
    reasons: string[];
    media: VoiceMediaAttemptInput['media'];
    sut: VoiceMediaAttemptInput['sut'];
  };
  clock: VoiceMediaAttemptInput['clock'];
  raw_input_sha256: string;
}

export function evaluateVoiceMediaAttempt(
  input: VoiceMediaAttemptInput
): VoiceMediaAttemptEvidence {
  validateInput(input);
  const counters = structuredClone(input.counters);
  const attemptedDelta = counters.attempted - counters.connected - counters.failed;
  const connectedDelta = counters.connected - counters.active - counters.completed;
  const reconciliation = {
    attempted_minus_connected_failed: attemptedDelta,
    connected_minus_active_completed: connectedDelta,
    reconciled: attemptedDelta === 0 && connectedDelta === 0
  };

  const generatorReasons = generatorQualificationReasons(input, reconciliation);
  const sutReasons = sutEvaluationReasons(input);
  const generatorQualified = generatorReasons.length === 0;
  const sutPassed = sutReasons.length === 0;
  const status = !generatorQualified
    ? 'invalid_generator_capacity'
    : sutPassed
      ? 'passed'
      : 'failed';

  return {
    schema_version: '1.0.0',
    evidence_type: 'voice_media_attempt',
    status,
    failure_class: status === 'passed'
      ? 'none'
      : status === 'invalid_generator_capacity'
        ? 'generator'
        : 'sut_or_protocol',
    run_id: input.run_id,
    attempt_id: input.attempt_id,
    profile_id: input.profile_id,
    phase_id: input.phase_id,
    repetition: input.repetition,
    observation_kind: input.observation_kind,
    started_at: input.started_at,
    finished_at: input.finished_at,
    source_identity: structuredClone(input.source_identity),
    counters,
    reconciliation,
    generator_qualification: {
      qualified: generatorQualified,
      reasons: generatorReasons,
      observed: structuredClone(input.generator)
    },
    sut_evaluation: {
      passed: sutPassed,
      reasons: sutReasons,
      media: structuredClone(input.media),
      sut: structuredClone(input.sut)
    },
    clock: structuredClone(input.clock),
    raw_input_sha256: canonicalSha256(input)
  };
}

function generatorQualificationReasons(
  input: VoiceMediaAttemptInput,
  reconciliation: VoiceMediaAttemptEvidence['reconciliation']
): string[] {
  const reasons: string[] = [];
  const generator = input.generator;
  const thresholds = input.thresholds;
  const packetRateDelta = Math.abs(
    generator.actual_packet_rate - generator.expected_packet_rate
  );
  if (
    packetRateDelta >
    generator.expected_packet_rate * thresholds.generator_packet_rate_tolerance_ratio
  ) {
    reasons.push('generator_packet_rate_outside_tolerance');
  }
  if (generator.cpu_p95_ratio > thresholds.generator_cpu_p95_ratio) {
    reasons.push('generator_cpu_exceeded');
  }
  if (generator.nic_p95_ratio > thresholds.generator_nic_p95_ratio) {
    reasons.push('generator_nic_exceeded');
  }
  if (generator.host_packet_drop_count > 0) {
    reasons.push('generator_host_packet_drop_observed');
  }
  if (
    generator.scheduler_lag_p99_seconds >
    thresholds.generator_scheduler_lag_p99_seconds
  ) {
    reasons.push('generator_scheduler_lag_exceeded');
  }
  if (Math.abs(input.clock.ntp_offset_seconds) > thresholds.clock_offset_seconds) {
    reasons.push('generator_clock_offset_exceeded');
  }
  const capturedAt = Date.parse(input.clock.captured_at);
  if (
    capturedAt < Date.parse(input.started_at) ||
    capturedAt > Date.parse(input.finished_at)
  ) {
    reasons.push('generator_clock_capture_outside_attempt');
  }
  if (reconciliation.attempted_minus_connected_failed !== 0) {
    reasons.push('attempted_connected_failed_reconciliation_failed');
  }
  if (reconciliation.connected_minus_active_completed !== 0) {
    reasons.push('connected_active_completed_reconciliation_failed');
  }
  const derivedSetupSuccess = input.counters.connected / input.counters.attempted;
  if (Math.abs(derivedSetupSuccess - input.sut.setup_success_ratio) > 1e-9) {
    reasons.push('setup_success_ratio_reconciliation_failed');
  }
  return reasons;
}

function sutEvaluationReasons(input: VoiceMediaAttemptInput): string[] {
  const reasons: string[] = [];
  if (input.media.protocol_handshake_count !== input.media.expected_sessions) {
    reasons.push('protocol_handshake_count_mismatch');
  }
  if (input.sut.setup_success_ratio < input.thresholds.setup_success_ratio) {
    reasons.push('setup_success_ratio_below_threshold');
  }
  if (
    input.media.receive_loss_ratio >
    input.thresholds.server_packet_loss_ratio
  ) {
    reasons.push('server_packet_loss_exceeded');
  }
  if (input.media.jitter_p99_seconds > input.thresholds.jitter_p99_seconds) {
    reasons.push('jitter_p99_exceeded');
  }
  if (
    input.sut.relay_latency_p99_seconds >
    input.thresholds.relay_latency_p99_seconds
  ) {
    reasons.push('relay_latency_p99_exceeded');
  }
  if (input.media.duplicate_packet_count > 0) {
    reasons.push('duplicate_packets_observed');
  }
  if (input.media.out_of_order_packet_count > 0) {
    reasons.push('out_of_order_packets_observed');
  }
  if (input.sut.unexpected_restart_count > 0) {
    reasons.push('unexpected_process_restart');
  }
  if (input.sut.oom_kill_count > 0) {
    reasons.push('oom_kill_observed');
  }
  if (input.observation_kind === 'phase_end' && input.counters.active !== 0) {
    reasons.push('phase_end_active_sessions_remaining');
  }
  return reasons;
}

function validateInput(input: VoiceMediaAttemptInput): void {
  if (!input || typeof input !== 'object') throw new Error('voice media input is required');
  if (input.schema_version !== '1.0.0') {
    throw new Error('unsupported voice media input schema');
  }
  safeId(input.run_id, 'run ID');
  safeId(input.attempt_id, 'attempt ID');
  safeId(input.profile_id, 'profile ID');
  safeId(input.phase_id, 'phase ID');
  positiveInteger(input.repetition, 'repetition');
  if (!['steady_state', 'phase_end'].includes(input.observation_kind)) {
    throw new Error('invalid observation kind');
  }
  const startedAt = timestamp(input.started_at, 'started at');
  const finishedAt = timestamp(input.finished_at, 'finished at');
  if (finishedAt <= startedAt) throw new Error('attempt finish must follow start');

  sha256(input.source_identity.profile_sha256, 'profile');
  sha256(input.source_identity.fork_manifest_sha256, 'fork manifest');
  safeId(input.source_identity.sut_release_id, 'SUT release ID');
  safeId(input.source_identity.generator_release_id, 'generator release ID');

  for (const [name, value] of Object.entries(input.counters)) {
    nonNegativeInteger(value, `counter ${name}`);
  }
  positiveInteger(input.counters.attempted, 'attempted counter');
  if (input.counters.connected > input.counters.attempted) {
    throw new Error('connected counter exceeds attempted');
  }
  if (input.counters.failed > input.counters.attempted) {
    throw new Error('failed counter exceeds attempted');
  }
  if (input.counters.active > input.counters.connected) {
    throw new Error('active counter exceeds connected');
  }
  if (input.counters.completed > input.counters.connected) {
    throw new Error('completed counter exceeds connected');
  }

  positive(input.generator.expected_packet_rate, 'expected packet rate');
  nonNegative(input.generator.actual_packet_rate, 'actual packet rate');
  ratio(input.generator.cpu_p95_ratio, 'generator CPU P95');
  ratio(input.generator.nic_p95_ratio, 'generator NIC P95');
  nonNegativeInteger(input.generator.host_packet_drop_count, 'host packet drops');
  nonNegative(
    input.generator.scheduler_lag_p99_seconds,
    'generator scheduler lag P99'
  );

  safeId(input.clock.clock_source, 'clock source');
  finite(input.clock.ntp_offset_seconds, 'NTP offset');
  timestamp(input.clock.captured_at, 'clock captured at');

  positiveInteger(input.media.expected_sessions, 'expected sessions');
  nonNegativeInteger(
    input.media.protocol_handshake_count,
    'protocol handshake count'
  );
  nonNegativeInteger(input.media.sent_packets, 'sent packets');
  nonNegativeInteger(input.media.received_packets, 'received packets');
  ratio(input.media.receive_loss_ratio, 'receive loss ratio');
  nonNegativeInteger(input.media.duplicate_packet_count, 'duplicate packets');
  nonNegativeInteger(input.media.out_of_order_packet_count, 'out of order packets');
  nonNegative(input.media.jitter_p99_seconds, 'jitter P99');

  ratio(input.sut.setup_success_ratio, 'setup success ratio');
  nonNegative(input.sut.relay_latency_p99_seconds, 'relay latency P99');
  nonNegativeInteger(input.sut.unexpected_restart_count, 'unexpected restarts');
  nonNegativeInteger(input.sut.oom_kill_count, 'OOM kills');

  ratio(
    input.thresholds.generator_packet_rate_tolerance_ratio,
    'generator packet rate tolerance'
  );
  ratio(input.thresholds.generator_cpu_p95_ratio, 'generator CPU threshold');
  ratio(input.thresholds.generator_nic_p95_ratio, 'generator NIC threshold');
  positive(
    input.thresholds.generator_scheduler_lag_p99_seconds,
    'generator scheduler lag threshold'
  );
  positive(input.thresholds.clock_offset_seconds, 'clock offset threshold');
  ratio(input.thresholds.setup_success_ratio, 'setup success threshold');
  ratio(input.thresholds.server_packet_loss_ratio, 'packet loss threshold');
  positive(input.thresholds.jitter_p99_seconds, 'jitter threshold');
  positive(input.thresholds.relay_latency_p99_seconds, 'relay latency threshold');
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}

function safeId(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._@:/-]{1,255}$/.test(value)
  ) {
    throw new Error(`invalid ${label}`);
  }
}

function sha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`invalid ${label} SHA-256`);
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${label}`);
  return parsed;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${label}`);
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid ${label}`);
}

function nonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${label}`);
}

function ratio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid ${label}`);
  }
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`invalid ${label}`);
}
