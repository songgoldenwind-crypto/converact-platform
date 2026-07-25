export interface LinuxUdpCounters {
  in_datagrams: number;
  no_ports: number;
  in_errors: number;
  out_datagrams: number;
  receive_buffer_errors: number;
  send_buffer_errors: number;
}

export interface SippRtpThroughputEvidence {
  schema_version: '1.0.0';
  protocol: 'sipp_rtp_throughput';
  evidence_level: 'controlled_throughput';
  status:
    | 'controlled_pass'
    | 'controlled_failed'
    | 'invalid_generator_capacity';
  failure_class:
    | 'none'
    | 'generator'
    | 'sut_or_protocol'
    | 'mixed_or_inconclusive';
  capacity_claim: 'none';
  expected_calls: number;
  expected_sut_datagrams_per_direction: number;
  reasons: string[];
  attribution: {
    conclusion:
      | 'none'
      | 'generator_limited'
      | 'sut_or_protocol_limited'
      | 'mixed_or_inconclusive';
    generator_signals: string[];
    sut_or_protocol_signals: string[];
  };
  udp: {
    in_datagrams_delta: number;
    out_datagrams_delta: number;
    inbound_coverage_ratio: number;
    outbound_coverage_ratio: number;
    receive_buffer_errors_delta: number;
    send_buffer_errors_delta: number;
    in_errors_delta: number;
    no_ports_delta: number;
  };
}

const UDP_FIELDS = {
  InDatagrams: 'in_datagrams',
  NoPorts: 'no_ports',
  InErrors: 'in_errors',
  OutDatagrams: 'out_datagrams',
  RcvbufErrors: 'receive_buffer_errors',
  SndbufErrors: 'send_buffer_errors'
} as const;

export function parseLinuxUdpSnmp(input: string): LinuxUdpCounters {
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index]!.trim().split(/\s+/);
    const values = lines[index + 1]!.trim().split(/\s+/);
    if (header[0] !== 'Udp:' || values[0] !== 'Udp:') continue;
    if (header.length !== values.length) {
      throw new Error('Linux UDP SNMP columns are misaligned');
    }
    const raw = new Map<string, number>();
    for (let column = 1; column < header.length; column += 1) {
      const value = Number(values[column]);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('Linux UDP SNMP counter is invalid');
      }
      raw.set(header[column]!, value);
    }
    const result = {} as LinuxUdpCounters;
    for (const [source, target] of Object.entries(UDP_FIELDS)) {
      const value = raw.get(source);
      if (value === undefined) {
        throw new Error(`Linux UDP SNMP field ${source} is missing`);
      }
      result[target] = value;
    }
    return result;
  }
  throw new Error('Linux UDP SNMP section is missing');
}

export function evaluateSippRtpThroughputEvidence(input: {
  expected_calls: number;
  duration_seconds: number;
  packets_per_second: number;
  minimum_packet_coverage_ratio: number;
  uac_exit_code: number;
  uas_exit_code: number;
  uac_successful_calls: number;
  uac_failed_calls: number;
  uac_retransmissions: number;
  uas_successful_calls: number;
  uas_failed_calls: number;
  uas_retransmissions: number;
  before: LinuxUdpCounters;
  after: LinuxUdpCounters;
}): SippRtpThroughputEvidence {
  positive(input.expected_calls, 'expected calls');
  positive(input.duration_seconds, 'duration');
  positive(input.packets_per_second, 'packet rate');
  ratio(input.minimum_packet_coverage_ratio, 'minimum packet coverage');
  for (const [name, value] of Object.entries({
    uac_exit_code: input.uac_exit_code,
    uas_exit_code: input.uas_exit_code,
    uac_successful_calls: input.uac_successful_calls,
    uac_failed_calls: input.uac_failed_calls,
    uac_retransmissions: input.uac_retransmissions,
    uas_successful_calls: input.uas_successful_calls,
    uas_failed_calls: input.uas_failed_calls,
    uas_retransmissions: input.uas_retransmissions
  })) {
    nonNegative(value, name);
  }
  validateCounters(input.before);
  validateCounters(input.after);

  const expectedDatagrams =
    input.expected_calls *
    input.duration_seconds *
    input.packets_per_second *
    2;
  if (!Number.isSafeInteger(expectedDatagrams)) {
    throw new Error('RTP throughput expected datagram count is unsafe');
  }
  const delta = {
    in_datagrams: counterDelta(
      input.before.in_datagrams,
      input.after.in_datagrams,
      'inbound datagrams'
    ),
    out_datagrams: counterDelta(
      input.before.out_datagrams,
      input.after.out_datagrams,
      'outbound datagrams'
    ),
    receive_buffer_errors: counterDelta(
      input.before.receive_buffer_errors,
      input.after.receive_buffer_errors,
      'receive buffer errors'
    ),
    send_buffer_errors: counterDelta(
      input.before.send_buffer_errors,
      input.after.send_buffer_errors,
      'send buffer errors'
    ),
    in_errors: counterDelta(
      input.before.in_errors,
      input.after.in_errors,
      'inbound errors'
    ),
    no_ports: counterDelta(
      input.before.no_ports,
      input.after.no_ports,
      'no-port errors'
    )
  };
  const inboundCoverage = delta.in_datagrams / expectedDatagrams;
  const outboundCoverage = delta.out_datagrams / expectedDatagrams;
  const reasons: string[] = [];
  const generatorSignals: string[] = [];
  const sutOrProtocolSignals: string[] = [];

  if (inboundCoverage < input.minimum_packet_coverage_ratio) {
    const reason =
      'RTP throughput inbound UDP coverage is below the configured floor';
    reasons.push(reason);
    generatorSignals.push(reason);
  }
  if (outboundCoverage < input.minimum_packet_coverage_ratio) {
    const reason =
      'RTP throughput outbound UDP coverage is below the configured floor';
    reasons.push(reason);
    sutOrProtocolSignals.push(reason);
  }
  if (delta.receive_buffer_errors > 0 || delta.send_buffer_errors > 0) {
    const reason = delta.receive_buffer_errors > 0
      ? 'RTP throughput kernel UDP receive buffer errors are non-zero'
      : 'RTP throughput kernel UDP send buffer errors are non-zero';
    reasons.push(reason);
    sutOrProtocolSignals.push(reason);
  }
  if (delta.in_errors > 0) {
    const reason = 'RTP throughput kernel UDP inbound errors are non-zero';
    reasons.push(reason);
    sutOrProtocolSignals.push(reason);
  }
  if (input.uac_successful_calls !== input.expected_calls ||
      input.uas_successful_calls !== input.expected_calls ||
      input.uac_failed_calls !== 0 ||
      input.uas_failed_calls !== 0) {
    const reason = 'RTP throughput SIP call reconciliation failed';
    reasons.push(reason);
    sutOrProtocolSignals.push(reason);
  }
  if (input.uac_retransmissions !== 0 || input.uas_retransmissions !== 0) {
    const reason = 'RTP throughput SIP retransmissions are non-zero';
    reasons.push(reason);
    sutOrProtocolSignals.push(reason);
  }
  if (input.uac_exit_code !== 0 || input.uas_exit_code !== 0) {
    const reason = 'RTP throughput SIPp process exit code is non-zero';
    reasons.push(reason);
    generatorSignals.push(reason);
  }

  const passed = reasons.length === 0;
  const generatorInvalid =
    generatorSignals.length > 0 && sutOrProtocolSignals.length === 0;
  const mixed =
    generatorSignals.length > 0 && sutOrProtocolSignals.length > 0;
  const failureClass = passed
    ? 'none'
    : mixed
      ? 'mixed_or_inconclusive'
      : generatorInvalid
        ? 'generator'
        : 'sut_or_protocol';
  return {
    schema_version: '1.0.0',
    protocol: 'sipp_rtp_throughput',
    evidence_level: 'controlled_throughput',
    status: passed
      ? 'controlled_pass'
      : generatorInvalid
        ? 'invalid_generator_capacity'
        : 'controlled_failed',
    failure_class: failureClass,
    capacity_claim: 'none',
    expected_calls: input.expected_calls,
    expected_sut_datagrams_per_direction: expectedDatagrams,
    reasons,
    attribution: {
      conclusion: passed
        ? 'none'
        : mixed
          ? 'mixed_or_inconclusive'
          : generatorInvalid
            ? 'generator_limited'
            : 'sut_or_protocol_limited',
      generator_signals: generatorSignals,
      sut_or_protocol_signals: sutOrProtocolSignals
    },
    udp: {
      in_datagrams_delta: delta.in_datagrams,
      out_datagrams_delta: delta.out_datagrams,
      inbound_coverage_ratio: inboundCoverage,
      outbound_coverage_ratio: outboundCoverage,
      receive_buffer_errors_delta: delta.receive_buffer_errors,
      send_buffer_errors_delta: delta.send_buffer_errors,
      in_errors_delta: delta.in_errors,
      no_ports_delta: delta.no_ports
    }
  };
}

function validateCounters(value: LinuxUdpCounters): void {
  for (const [name, counter] of Object.entries(value)) {
    nonNegative(counter, name);
  }
}

function counterDelta(before: number, after: number, label: string): number {
  if (after < before) {
    throw new Error(`RTP throughput ${label} counter moved backwards`);
  }
  return after - before;
}

function positive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RTP throughput ${label} is invalid`);
  }
}

function nonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`RTP throughput ${label} is invalid`);
  }
}

function ratio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`RTP throughput ${label} is invalid`);
  }
}
