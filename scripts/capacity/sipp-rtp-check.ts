import { isAbsolute } from 'node:path';

const STARTUP_STABILITY_RTP_PACKETS = 3;

export interface SippRtpCheckDebugSummary {
  worker_count: number;
  active_task_count: number;
  checked_packet_count: number;
  invalid_or_missing_packet_count: number;
  invalid_or_missing_ratio: number;
  generated_rtp_packet_count: number;
  received_rtp_packet_count: number;
  received_non_rtp_control_packet_count: number;
  startup_missing_packet_count: number;
  steady_state_empty_poll_count: number;
  non_rtp_control_interference_count: number;
  rtp_payload_mismatch_packet_count: number;
  received_rtp_sequence_gap_packet_count: number;
  received_rtp_duplicate_packet_count: number;
  received_rtp_reordered_packet_count: number;
  media_error_packet_count: number;
  media_error_ratio: number;
}

export interface SippRtpDirectionEvidence {
  generated_packet_count: number;
  remote_received_packet_count: number;
  remote_receive_coverage_ratio: number;
  edge_unobserved_packet_count: number;
  durable_loss_packet_count: number;
  received_sequence_gap_packet_count: number;
  received_duplicate_packet_count: number;
  received_reordered_packet_count: number;
}

export interface SippRtpCheckEvidence {
  schema_version: '1.0.0';
  protocol: 'sipp_rtp_check';
  evidence_level: 'controlled';
  status:
    | 'controlled_pass'
    | 'controlled_failed'
    | 'invalid_generator_capacity';
  failure_class: 'none' | 'generator' | 'sut_or_protocol';
  capacity_claim: 'none';
  expected_calls: number;
  expected_packet_count: number;
  packet_coverage_ratio: number;
  reasons: string[];
  directions: {
    uac_to_uas: SippRtpDirectionEvidence;
    uas_to_uac: SippRtpDirectionEvidence;
  };
  debug: {
    uac: SippRtpCheckDebugSummary;
    uas: SippRtpCheckDebugSummary;
  };
}

export interface SippRtpCheckDockerPlanInput {
  network: string;
  target_ip: string;
  uac_ip: string;
  uas_ip: string;
  sipp_binary: string;
  result_dir: string;
  container_image: string;
  run_id: string;
  service: string;
  calls: number;
  calls_per_second: number;
  timeout_seconds: number;
  rtp_port_min: number;
  rtp_tasks_per_thread: number;
  evidence_mode?: 'strict' | 'throughput';
}

export interface SippRtpCheckArtifacts {
  uac_scenario: 'rtp-check-uac.xml';
  uas_scenario: 'rtp-check-uas.xml';
  uac_statistics: 'rtp-check-uac.csv';
  uas_statistics: 'rtp-check-uas.csv';
  uac_errors: 'rtp-check-uac-errors.log';
  uas_errors: 'rtp-check-uas-errors.log';
  uac_messages: 'rtp-check-uac-messages.log';
  uas_messages: 'rtp-check-uas-messages.log';
  uac_rtp_debug: 'uac/debugafile';
  uas_rtp_debug: 'uas/debugafile';
}

export interface SippRtpCheckDockerPlan {
  uac_container: string;
  uas_container: string;
  rtp_port_range: {
    minimum: number;
    maximum: number;
  };
  artifacts: SippRtpCheckArtifacts;
  uac_args: string[];
  uas_args: string[];
}

interface WorkerVectors {
  checks?: number[];
  packets?: number[];
}

export function buildSippRtpCheckDockerPlan(
  input: SippRtpCheckDockerPlanInput
): SippRtpCheckDockerPlan {
  boundedName(input.network, 'network');
  boundedName(input.run_id, 'run ID');
  ipv4(input.target_ip, 'target IP');
  ipv4(input.uac_ip, 'UAC IP');
  ipv4(input.uas_ip, 'UAS IP');
  absolutePath(input.sipp_binary, 'SIPp binary');
  absolutePath(input.result_dir, 'result directory');
  if (!/^[^\s]{3,512}$/.test(input.container_image)) {
    throw new Error('SIPp RTP-check container image is invalid');
  }
  if (!/^\+?\d{2,32}$/.test(input.service)) {
    throw new Error('SIPp RTP-check service is invalid');
  }
  positiveInteger(input.calls, 'calls');
  positiveInteger(input.calls_per_second, 'call rate');
  boundedInteger(input.timeout_seconds, 1, 3_600, 'timeout');
  boundedInteger(
    input.rtp_tasks_per_thread,
    1,
    4_096,
    'RTP tasks per thread'
  );
  boundedInteger(input.rtp_port_min, 1_024, 65_534, 'RTP port minimum');
  const rtpPortMaximum = input.rtp_port_min + input.calls * 2 - 1;
  if (rtpPortMaximum > 65_535) {
    throw new Error('SIPp RTP-check RTP port range is exhausted');
  }

  const artifacts: SippRtpCheckArtifacts = {
    uac_scenario: 'rtp-check-uac.xml',
    uas_scenario: 'rtp-check-uas.xml',
    uac_statistics: 'rtp-check-uac.csv',
    uas_statistics: 'rtp-check-uas.csv',
    uac_errors: 'rtp-check-uac-errors.log',
    uas_errors: 'rtp-check-uas-errors.log',
    uac_messages: 'rtp-check-uac-messages.log',
    uas_messages: 'rtp-check-uas-messages.log',
    uac_rtp_debug: 'uac/debugafile',
    uas_rtp_debug: 'uas/debugafile'
  };
  const uacContainer = `converact-rtp-uac-${input.run_id}`;
  const uasContainer = `converact-rtp-uas-${input.run_id}`;
  const dockerPrefix = (
    role: 'uac' | 'uas',
    container: string,
    detached: boolean
  ): string[] => [
    'run',
    ...(detached ? ['-d'] : []),
    '--name', container,
    '--network', input.network,
    '--ip', role === 'uac' ? input.uac_ip : input.uas_ip,
    '-v', `${input.sipp_binary}:/acceptance/sipp:ro`,
    '-v', `${input.result_dir}:/results`,
    '-w', `/results/${role}`,
    input.container_image,
    '/acceptance/sipp'
  ];
  const sippCommon = (
    role: 'uac' | 'uas',
    scenario: string,
    statistics: string,
    errors: string,
    messages: string
  ): string[] => {
    const ip = role === 'uac' ? input.uac_ip : input.uas_ip;
    const strict = input.evidence_mode !== 'throughput';
    return [
      '-sf', `/results/${scenario}`,
      '-i', ip,
      '-mi', ip,
      '-p', '5060',
      '-t', 'u1',
      '-min_rtp_port', String(input.rtp_port_min),
      '-max_rtp_port', String(rtpPortMaximum),
      '-rtp_threadtasks', String(input.rtp_tasks_per_thread),
      ...(strict ? ['-rtpcheck_debug', '-audiotolerance', '1'] : []),
      '-random_base_ssrc',
      '-timeout', String(input.timeout_seconds),
      '-timeout_error',
      '-nostdin',
      '-trace_stat',
      '-stf', `/results/${statistics}`,
      '-trace_err',
      '-error_file', `/results/${errors}`,
      ...(strict
        ? ['-trace_msg', '-message_file', `/results/${messages}`]
        : [])
    ];
  };
  const uacArgs = [
    ...dockerPrefix('uac', uacContainer, false),
    `${input.target_ip}:5060`,
    ...sippCommon(
      'uac',
      artifacts.uac_scenario,
      artifacts.uac_statistics,
      artifacts.uac_errors,
      artifacts.uac_messages
    ),
    '-s', input.service,
    '-m', String(input.calls),
    '-r', String(input.calls_per_second),
    '-rp', '1000',
    '-l', String(input.calls)
  ];
  const uasArgs = [
    ...dockerPrefix('uas', uasContainer, true),
    ...sippCommon(
      'uas',
      artifacts.uas_scenario,
      artifacts.uas_statistics,
      artifacts.uas_errors,
      artifacts.uas_messages
    ),
    '-m', String(input.calls)
  ];

  return {
    uac_container: uacContainer,
    uas_container: uasContainer,
    rtp_port_range: {
      minimum: input.rtp_port_min,
      maximum: rtpPortMaximum
    },
    artifacts,
    uac_args: uacArgs,
    uas_args: uasArgs
  };
}

export function parseSippRtpCheckDebug(
  input: string
): SippRtpCheckDebugSummary {
  const workers = new Map<string, WorkerVectors>();
  const currentTaskByWorker = new Map<string, number>();
  const consecutiveValidPacketsByTask = new Map<string, number>();
  const stableMediaTasks = new Set<string>();
  const lastReceivedKindByWorker = new Map<
    string,
    'rtp' | 'stun' | 'other'
  >();
  const previousSequenceByStream = new Map<string, number>();
  let startupMissingPacketCount = 0;
  let emptyPollCount = 0;
  let generatedRtpPacketCount = 0;
  let receivedRtpPacketCount = 0;
  let receivedNonRtpControlPacketCount = 0;
  let nonRtpControlInterferenceCount = 0;
  let rtpPayloadMismatchPacketCount = 0;
  let receivedRtpSequenceGapPacketCount = 0;
  let receivedRtpDuplicatePacketCount = 0;
  let receivedRtpReorderedPacketCount = 0;
  let current:
    | { worker_id: string; kind: 'checks' | 'packets'; values: number[] }
    | null = null;

  const finishVector = (): void => {
    if (!current) return;
    const worker = workers.get(current.worker_id) || {};
    const field = current.kind;
    if (worker[field]) {
      throw new Error(`SIPp RTP-check ${field} vector is duplicated`);
    }
    worker[field] = current.values;
    workers.set(current.worker_id, worker);
    current = null;
  };

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    const currentTask = line.match(
      /^TID:\s+([0-9]+)\s+----DEBUG CURRENTTASK\/NUMTASKS----\s+([0-9]+)\s+/
    );
    if (currentTask) {
      currentTaskByWorker.set(currentTask[1]!, Number(currentTask[2]));
    }
    const comparisonOk = line.match(
      /^TID:\s+([0-9]+)\s+COMPARISON OK\s+([0-9]+)\s+/
    );
    if (comparisonOk) {
      const task = `${comparisonOk[1]}:${comparisonOk[2]}`;
      const consecutive =
        (consecutiveValidPacketsByTask.get(task) || 0) + 1;
      consecutiveValidPacketsByTask.set(task, consecutive);
      if (consecutive >= STARTUP_STABILITY_RTP_PACKETS) {
        stableMediaTasks.add(task);
      }
      lastReceivedKindByWorker.delete(comparisonOk[1]!);
    }
    const noData = line.match(
      /^TID:\s+([0-9]+)\s+NODATA\s+([0-9]+)\s+/
    );
    if (noData) {
      emptyPollCount += 1;
      const task = `${noData[1]}:${noData[2]}`;
      if (!stableMediaTasks.has(task)) startupMissingPacketCount += 1;
      consecutiveValidPacketsByTask.set(task, 0);
    }
    const sent = line.match(
      /^TID:\s+([0-9]+)\s+SIPP SUCCESS SEND LOG:\s+[0-9]+\s+0x[0-9a-f]+\s+[0-9]+\s+\[([0-9a-f]+)\]$/i
    );
    if (sent && isRtpPacket(sent[2]!)) generatedRtpPacketCount += 1;
    const received = line.match(
      /^TID:\s+([0-9]+)\s+SIPP SUCCESS RECV LOG:\s+[0-9]+\s+0x[0-9a-f]+\s+[0-9]+\s+\[([0-9a-f]+)\]$/i
    );
    if (received) {
      const workerId = received[1]!;
      const packet = received[2]!;
      if (isRtpPacket(packet)) {
        receivedRtpPacketCount += 1;
        lastReceivedKindByWorker.set(workerId, 'rtp');
        const task = currentTaskByWorker.get(workerId) || 0;
        const ssrc = packet.slice(16, 24).toLowerCase();
        const sequence = Number.parseInt(packet.slice(4, 8), 16);
        const stream = `${workerId}:${task}:${ssrc}`;
        const previous = previousSequenceByStream.get(stream);
        if (previous !== undefined) {
          const delta = (sequence - previous + 65_536) % 65_536;
          if (delta === 0) {
            receivedRtpDuplicatePacketCount += 1;
          } else if (delta < 32_768) {
            receivedRtpSequenceGapPacketCount += Math.max(0, delta - 1);
          } else {
            receivedRtpReorderedPacketCount += 1;
          }
        }
        previousSequenceByStream.set(stream, sequence);
      } else if (isStunPacket(packet)) {
        receivedNonRtpControlPacketCount += 1;
        lastReceivedKindByWorker.set(workerId, 'stun');
      } else {
        lastReceivedKindByWorker.set(workerId, 'other');
      }
    }
    const comparisonFailed = line.match(
      /^TID:\s+([0-9]+)\s+COMPARISON FAILED\s+/
    );
    if (comparisonFailed) {
      const workerId = comparisonFailed[1]!;
      const kind = lastReceivedKindByWorker.get(workerId);
      if (kind === 'stun') nonRtpControlInterferenceCount += 1;
      else rtpPayloadMismatchPacketCount += 1;
      lastReceivedKindByWorker.delete(workerId);
    }
    const header = line.match(
      /^TID:\s+([0-9]+)\s+----(RTPCHECKS|PACKET COUNTS)----$/
    );
    if (header) {
      finishVector();
      current = {
        worker_id: header[1]!,
        kind: header[2] === 'RTPCHECKS' ? 'checks' : 'packets',
        values: []
      };
      continue;
    }
    if (current && /^TID:\s+[0-9]+\s+/.test(line)) {
      finishVector();
      continue;
    }
    if (!current || !line) continue;
    if (!/^[0-9]+$/.test(line)) {
      throw new Error('SIPp RTP-check vector contains an invalid value');
    }
    const value = Number(line);
    if (!Number.isSafeInteger(value)) {
      throw new Error('SIPp RTP-check vector contains an invalid value');
    }
    current.values.push(value);
  }
  finishVector();

  if (workers.size === 0) {
    throw new Error('SIPp RTP-check vectors are missing');
  }

  let activeTaskCount = 0;
  let checkedPacketCount = 0;
  let invalidOrMissingPacketCount = 0;
  for (const worker of workers.values()) {
    if (!worker.checks) {
      throw new Error('SIPp RTP-check result vector is missing');
    }
    if (!worker.packets) {
      throw new Error('SIPp RTP-check packet count vector is missing');
    }
    if (worker.checks.length !== worker.packets.length) {
      throw new Error('SIPp RTP-check vector lengths do not match');
    }
    for (let index = 0; index < worker.packets.length; index += 1) {
      const packets = worker.packets[index]!;
      const failed = worker.checks[index]!;
      if (failed > packets) {
        throw new Error('SIPp RTP-check failures exceed checked packets');
      }
      if (packets === 0) continue;
      activeTaskCount += 1;
      checkedPacketCount += packets;
      invalidOrMissingPacketCount += failed;
    }
  }
  if (checkedPacketCount === 0) {
    throw new Error('SIPp RTP-check contains no checked media packets');
  }
  const classifiedFailures =
    emptyPollCount +
    nonRtpControlInterferenceCount +
    rtpPayloadMismatchPacketCount;
  if (classifiedFailures > invalidOrMissingPacketCount) {
    throw new Error(
      'SIPp RTP-check classified failures exceed invalid packet count'
    );
  }
  rtpPayloadMismatchPacketCount +=
    invalidOrMissingPacketCount - classifiedFailures;
  const steadyStateEmptyPollCount =
    emptyPollCount - startupMissingPacketCount;
  const sequenceErrorPacketCount =
    receivedRtpSequenceGapPacketCount +
    receivedRtpDuplicatePacketCount +
    receivedRtpReorderedPacketCount;
  const mediaErrorPacketCount =
    Math.max(rtpPayloadMismatchPacketCount, sequenceErrorPacketCount);

  return {
    worker_count: workers.size,
    active_task_count: activeTaskCount,
    checked_packet_count: checkedPacketCount,
    invalid_or_missing_packet_count: invalidOrMissingPacketCount,
    invalid_or_missing_ratio:
      invalidOrMissingPacketCount / checkedPacketCount,
    generated_rtp_packet_count: generatedRtpPacketCount,
    received_rtp_packet_count: receivedRtpPacketCount,
    received_non_rtp_control_packet_count:
      receivedNonRtpControlPacketCount,
    startup_missing_packet_count: startupMissingPacketCount,
    steady_state_empty_poll_count: steadyStateEmptyPollCount,
    non_rtp_control_interference_count:
      nonRtpControlInterferenceCount,
    rtp_payload_mismatch_packet_count: rtpPayloadMismatchPacketCount,
    received_rtp_sequence_gap_packet_count:
      receivedRtpSequenceGapPacketCount,
    received_rtp_duplicate_packet_count:
      receivedRtpDuplicatePacketCount,
    received_rtp_reordered_packet_count:
      receivedRtpReorderedPacketCount,
    media_error_packet_count: mediaErrorPacketCount,
    media_error_ratio: mediaErrorPacketCount / checkedPacketCount
  };
}

export function evaluateSippRtpCheckEvidence(input: {
  expected_calls: number;
  duration_seconds: number;
  packets_per_second: number;
  maximum_invalid_or_missing_ratio: number;
  maximum_startup_missing_packets_per_call: number;
  minimum_packet_coverage_ratio: number;
  uac_exit_code: number;
  uas_exit_code: number;
  uac_successful_calls: number;
  uac_failed_calls: number;
  uac_retransmissions: number;
  uas_successful_calls: number;
  uas_failed_calls: number;
  uas_retransmissions: number;
  debug: {
    uac: SippRtpCheckDebugSummary;
    uas: SippRtpCheckDebugSummary;
  };
}): SippRtpCheckEvidence {
  positiveInteger(input.expected_calls, 'expected calls');
  positiveInteger(input.duration_seconds, 'duration');
  positiveInteger(input.packets_per_second, 'packet rate');
  ratio(input.maximum_invalid_or_missing_ratio, 'maximum error ratio');
  nonNegativeInteger(
    input.maximum_startup_missing_packets_per_call,
    'maximum startup missing packets per call'
  );
  ratio(input.minimum_packet_coverage_ratio, 'minimum packet coverage');
  nonNegativeInteger(input.uac_exit_code, 'UAC exit code');
  nonNegativeInteger(input.uas_exit_code, 'UAS exit code');
  nonNegativeInteger(input.uac_successful_calls, 'UAC successful calls');
  nonNegativeInteger(input.uac_failed_calls, 'UAC failed calls');
  nonNegativeInteger(input.uac_retransmissions, 'UAC retransmissions');
  nonNegativeInteger(input.uas_successful_calls, 'UAS successful calls');
  nonNegativeInteger(input.uas_failed_calls, 'UAS failed calls');
  nonNegativeInteger(input.uas_retransmissions, 'UAS retransmissions');
  validateDebugSummary(input.debug.uac);
  validateDebugSummary(input.debug.uas);

  const expectedPacketCount =
    input.expected_calls * input.duration_seconds * input.packets_per_second;
  if (!Number.isSafeInteger(expectedPacketCount)) {
    throw new Error('SIPp RTP-check expected packet count is unsafe');
  }
  const packetCoverageRatio = Math.min(
    input.debug.uac.checked_packet_count,
    input.debug.uas.checked_packet_count
  ) / expectedPacketCount;
  const startupBudget =
    input.expected_calls * input.maximum_startup_missing_packets_per_call;
  const directions = {
    uac_to_uas: directionEvidence(
      input.debug.uac,
      input.debug.uas,
      expectedPacketCount
    ),
    uas_to_uac: directionEvidence(
      input.debug.uas,
      input.debug.uac,
      expectedPacketCount
    )
  };
  const reasons: string[] = [];
  let generatorInvalid = false;

  for (const [endpoint, debug] of Object.entries(input.debug)) {
    if (debug.active_task_count !== input.expected_calls) {
      reasons.push(
        `SIPp RTP-check ${endpoint.toUpperCase()} active media tasks do not match expected calls`
      );
      generatorInvalid = true;
    }
    if (debug.checked_packet_count / expectedPacketCount <
        input.minimum_packet_coverage_ratio ||
        debug.generated_rtp_packet_count / expectedPacketCount <
        input.minimum_packet_coverage_ratio) {
      reasons.push(
        `SIPp RTP-check ${endpoint.toUpperCase()} packet coverage is below the configured floor`
      );
      generatorInvalid = true;
    }
    if (debug.startup_missing_packet_count > startupBudget) {
      reasons.push(
        `SIPp RTP-check ${endpoint.toUpperCase()} startup missing packets exceed the configured budget`
      );
    }
    if (debug.media_error_ratio > input.maximum_invalid_or_missing_ratio) {
      reasons.push(
        `SIPp RTP-check ${endpoint.toUpperCase()} media error ratio exceeds the configured SLO`
      );
    }
  }

  for (const [direction, evidence] of Object.entries(directions)) {
    const label = direction.replace('_to_', ' -> ').toUpperCase();
    if (evidence.remote_received_packet_count >
        evidence.generated_packet_count) {
      reasons.push(
        `SIPp RTP-check ${label} received more RTP packets than the sender generated`
      );
      generatorInvalid = true;
    }
    if (evidence.remote_receive_coverage_ratio <
        input.minimum_packet_coverage_ratio) {
      reasons.push(
        `SIPp RTP-check ${label} remote receive coverage is below the configured floor`
      );
    }
    if (evidence.durable_loss_packet_count > 0) {
      reasons.push(`SIPp RTP-check ${label} has durable RTP loss`);
    }
    if (evidence.received_duplicate_packet_count > 0) {
      reasons.push(`SIPp RTP-check ${label} has duplicate RTP packets`);
    }
    if (evidence.received_reordered_packet_count > 0) {
      reasons.push(`SIPp RTP-check ${label} has reordered RTP packets`);
    }
  }
  if (input.uac_successful_calls !== input.expected_calls ||
      input.uas_successful_calls !== input.expected_calls ||
      input.uac_failed_calls !== 0 ||
      input.uas_failed_calls !== 0) {
    reasons.push('SIPp RTP-check SIP call reconciliation failed');
  }
  if (input.uac_retransmissions !== 0 || input.uas_retransmissions !== 0) {
    reasons.push('SIPp RTP-check SIP retransmissions are non-zero');
  }
  if (input.uac_exit_code !== 0) {
    reasons.push(`SIPp RTP-check UAC exited with code ${input.uac_exit_code}`);
  }
  if (input.uas_exit_code !== 0) {
    reasons.push(`SIPp RTP-check UAS exited with code ${input.uas_exit_code}`);
  }

  const passed = reasons.length === 0;
  return {
    schema_version: '1.0.0',
    protocol: 'sipp_rtp_check',
    evidence_level: 'controlled',
    status: passed
      ? 'controlled_pass'
      : generatorInvalid
        ? 'invalid_generator_capacity'
        : 'controlled_failed',
    failure_class: passed
      ? 'none'
      : generatorInvalid
        ? 'generator'
        : 'sut_or_protocol',
    capacity_claim: 'none',
    expected_calls: input.expected_calls,
    expected_packet_count: expectedPacketCount,
    packet_coverage_ratio: packetCoverageRatio,
    reasons,
    directions,
    debug: structuredClone(input.debug)
  };
}

function directionEvidence(
  sender: SippRtpCheckDebugSummary,
  receiver: SippRtpCheckDebugSummary,
  expectedPacketCount: number
): SippRtpDirectionEvidence {
  const edgeUnobserved = Math.max(
    0,
    sender.generated_rtp_packet_count - receiver.received_rtp_packet_count
  );
  const sequenceGaps = receiver.received_rtp_sequence_gap_packet_count;
  return {
    generated_packet_count: sender.generated_rtp_packet_count,
    remote_received_packet_count: receiver.received_rtp_packet_count,
    remote_receive_coverage_ratio:
      receiver.received_rtp_packet_count / expectedPacketCount,
    edge_unobserved_packet_count: edgeUnobserved,
    durable_loss_packet_count: sequenceGaps,
    received_sequence_gap_packet_count: sequenceGaps,
    received_duplicate_packet_count:
      receiver.received_rtp_duplicate_packet_count,
    received_reordered_packet_count:
      receiver.received_rtp_reordered_packet_count
  };
}

export function renderSippRtpCheckScenarios(input: {
  media_duration_ms: number;
}): { uac: string; uas: string } {
  if (!Number.isSafeInteger(input.media_duration_ms) ||
      input.media_duration_ms < 1 ||
      input.media_duration_ms > 300_000) {
    throw new Error('SIPp RTP-check media duration must be 1..300000 ms');
  }
  return {
    uac: renderUacScenario(input.media_duration_ms),
    uas: renderUasScenario()
  };
}

function renderUacScenario(mediaDurationMs: number): string {
  return `<?xml version="1.0" encoding="ISO-8859-1" ?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<scenario name="Converact Fabric RustPBX PCMU RTP-check UAC">
  <send retrans="500">
    <![CDATA[
      INVITE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/UDP [local_ip]:[local_port];branch=[branch]
      From: Converact Fabric RTP UAC <sip:rtp-uac@[local_ip]:[local_port]>;tag=[call_number]
      To: Converact Fabric RTP Route <sip:[service]@[remote_ip]:[remote_port]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: <sip:rtp-uac@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 1 1 IN IP[local_ip_type] [local_ip]
      s=Converact Fabric RustPBX RTP check
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [rtpstream_audio_port] RTP/AVP 0
      a=rtcp:[rtpstream_audio_port+1]
      a=sendrecv
      a=rtpmap:0 PCMU/8000
    ]]>
  </send>
  <recv response="100" optional="true" />
  <recv response="180" optional="true" />
  <recv response="183" optional="true" />
  <recv response="200" rrs="true" />
  <send>
    <![CDATA[
      ACK [next_url] SIP/2.0
      Via: SIP/2.0/UDP [local_ip]:[local_port];branch=[branch]
      [routes]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      CSeq: 1 ACK
      Contact: <sip:rtp-uac@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>
  <nop>
    <action>
      <exec rtp_stream="apattern,1,0,PCMU/8000" />
    </action>
  </nop>
  <pause milliseconds="${mediaDurationMs}" />
  <nop>
    <action>
      <exec rtp_stream="pauseapattern" />
    </action>
  </nop>
  <send retrans="500">
    <![CDATA[
      BYE [next_url] SIP/2.0
      Via: SIP/2.0/UDP [local_ip]:[local_port];branch=[branch]
      [routes]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      CSeq: 2 BYE
      Contact: <sip:rtp-uac@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Length: 0

    ]]>
  </send>
  <recv response="200" />
</scenario>
`;
}

function renderUasScenario(): string {
  return `<?xml version="1.0" encoding="ISO-8859-1" ?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<scenario name="Converact Fabric RustPBX PCMU RTP peer UAS">
  <recv request="INVITE" />
  <send>
    <![CDATA[
      SIP/2.0 100 Trying
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Content-Length: 0

    ]]>
  </send>
  <send>
    <![CDATA[
      SIP/2.0 180 Ringing
      [last_Via:]
      [last_From:]
      [last_To:];tag=[pid]RtpPeer[call_number]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:rtp-uas@[local_ip]:[local_port]>
      Content-Length: 0

    ]]>
  </send>
  <send retrans="500">
    <![CDATA[
      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:];tag=[pid]RtpPeer[call_number]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:rtp-uas@[local_ip]:[local_port]>
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=sipp 2 2 IN IP[local_ip_type] [local_ip]
      s=Converact Fabric RustPBX RTP peer
      c=IN IP[media_ip_type] [media_ip]
      t=0 0
      m=audio [rtpstream_audio_port] RTP/AVP 0
      a=rtcp:[rtpstream_audio_port+1]
      a=sendrecv
      a=rtpmap:0 PCMU/8000
    ]]>
  </send>
  <recv request="ACK" />
  <nop>
    <action>
      <exec rtp_stream="apattern,1,0,PCMU/8000" />
    </action>
  </nop>
  <recv request="BYE" />
  <nop>
    <action>
      <exec rtp_stream="pauseapattern" />
    </action>
  </nop>
  <send>
    <![CDATA[
      SIP/2.0 200 OK
      [last_Via:]
      [last_From:]
      [last_To:]
      [last_Call-ID:]
      [last_CSeq:]
      Contact: <sip:rtp-uas@[local_ip]:[local_port]>
      Content-Length: 0

    ]]>
  </send>
</scenario>
`;
}

function validateDebugSummary(value: SippRtpCheckDebugSummary): void {
  positiveInteger(value.worker_count, 'debug worker count');
  positiveInteger(value.active_task_count, 'debug active task count');
  positiveInteger(value.checked_packet_count, 'debug packet count');
  nonNegativeInteger(
    value.invalid_or_missing_packet_count,
    'debug invalid packet count'
  );
  ratio(value.invalid_or_missing_ratio, 'debug invalid packet ratio');
  nonNegativeInteger(
    value.generated_rtp_packet_count,
    'debug generated RTP packet count'
  );
  nonNegativeInteger(
    value.received_rtp_packet_count,
    'debug received RTP packet count'
  );
  nonNegativeInteger(
    value.received_non_rtp_control_packet_count,
    'debug received non-RTP control packet count'
  );
  nonNegativeInteger(
    value.startup_missing_packet_count,
    'debug startup missing packet count'
  );
  nonNegativeInteger(
    value.steady_state_empty_poll_count,
    'debug steady-state empty poll count'
  );
  nonNegativeInteger(
    value.non_rtp_control_interference_count,
    'debug non-RTP control interference count'
  );
  nonNegativeInteger(
    value.rtp_payload_mismatch_packet_count,
    'debug RTP payload mismatch packet count'
  );
  nonNegativeInteger(
    value.received_rtp_sequence_gap_packet_count,
    'debug RTP sequence gap packet count'
  );
  nonNegativeInteger(
    value.received_rtp_duplicate_packet_count,
    'debug duplicate RTP packet count'
  );
  nonNegativeInteger(
    value.received_rtp_reordered_packet_count,
    'debug reordered RTP packet count'
  );
  nonNegativeInteger(
    value.media_error_packet_count,
    'debug media error packet count'
  );
  ratio(value.media_error_ratio, 'debug media error ratio');
  if (value.invalid_or_missing_packet_count > value.checked_packet_count ||
      Math.abs(
        value.invalid_or_missing_ratio -
        value.invalid_or_missing_packet_count / value.checked_packet_count
      ) > 1e-12 ||
      value.startup_missing_packet_count +
        value.steady_state_empty_poll_count +
        value.non_rtp_control_interference_count +
        value.rtp_payload_mismatch_packet_count !==
        value.invalid_or_missing_packet_count ||
      Math.abs(
        value.media_error_ratio -
        value.media_error_packet_count / value.checked_packet_count
      ) > 1e-12) {
    throw new Error('SIPp RTP-check debug summary is inconsistent');
  }
}

function isStunPacket(hex: string): boolean {
  return hex.length >= 40 &&
    /^[0-3][0-9a-f]{7}2112a442/i.test(hex);
}

function isRtpPacket(hex: string): boolean {
  return hex.length >= 24 &&
    (Number.parseInt(hex.slice(0, 2), 16) >> 6) === 2;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`SIPp RTP-check ${label} is invalid`);
  }
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SIPp RTP-check ${label} is invalid`);
  }
}

function ratio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`SIPp RTP-check ${label} is invalid`);
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`SIPp RTP-check ${label} is invalid`);
  }
}

function boundedName(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)) {
    throw new Error(`SIPp RTP-check ${label} is invalid`);
  }
}

function absolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || value.includes('\0')) {
    throw new Error(`SIPp RTP-check ${label} is invalid`);
  }
}

function ipv4(value: string, label: string): void {
  const parts = value.split('.');
  if (parts.length !== 4 ||
      parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error(`SIPp RTP-check ${label} is invalid`);
  }
}
