import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateSippRtpThroughputEvidence,
  parseLinuxUdpSnmp
} from '../scripts/capacity/sipp-rtp-throughput.js';

const counters = (input: Partial<ReturnType<typeof parseLinuxUdpSnmp>> = {}) => ({
  in_datagrams: 100,
  no_ports: 0,
  in_errors: 0,
  out_datagrams: 200,
  receive_buffer_errors: 0,
  send_buffer_errors: 0,
  ...input
});

test('RTP throughput parser extracts Linux UDP counters by header name', () => {
  assert.deepEqual(parseLinuxUdpSnmp([
    'Ip: Forwarding DefaultTTL InReceives',
    'Ip: 1 64 10',
    'Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti MemErrors',
    'Udp: 101 2 3 202 4 5 6 7 8',
    ''
  ].join('\n')), {
    in_datagrams: 101,
    no_ports: 2,
    in_errors: 3,
    out_datagrams: 202,
    receive_buffer_errors: 4,
    send_buffer_errors: 5
  });
});

test('RTP throughput evidence gates packet rate, SIP, and kernel drops', () => {
  const common = {
    expected_calls: 10,
    duration_seconds: 5,
    packets_per_second: 50,
    minimum_packet_coverage_ratio: 0.95,
    uac_exit_code: 0,
    uas_exit_code: 0,
    uac_successful_calls: 10,
    uac_failed_calls: 0,
    uac_retransmissions: 0,
    uas_successful_calls: 10,
    uas_failed_calls: 0,
    uas_retransmissions: 0,
    before: counters(),
    after: counters({
      in_datagrams: 5_100,
      out_datagrams: 5_200
    })
  };
  const pass = evaluateSippRtpThroughputEvidence(common);
  assert.equal(pass.status, 'controlled_pass', pass.reasons.join('\n'));
  assert.equal(pass.evidence_level, 'controlled_throughput');
  assert.equal(pass.capacity_claim, 'none');
  assert.equal(pass.expected_sut_datagrams_per_direction, 5_000);
  assert.equal(pass.udp.in_datagrams_delta, 5_000);
  assert.equal(pass.udp.out_datagrams_delta, 5_000);

  const underRate = evaluateSippRtpThroughputEvidence({
    ...common,
    after: counters({
      in_datagrams: 4_100,
      out_datagrams: 5_200
    })
  });
  assert.equal(underRate.status, 'invalid_generator_capacity');
  assert.equal(underRate.failure_class, 'generator');
  assert.equal(underRate.attribution.conclusion, 'generator_limited');
  assert.match(underRate.reasons.join('\n'), /inbound UDP coverage/);

  const kernelDrop = evaluateSippRtpThroughputEvidence({
    ...common,
    after: counters({
      in_datagrams: 5_100,
      out_datagrams: 5_200,
      receive_buffer_errors: 1
    })
  });
  assert.equal(kernelDrop.status, 'controlled_failed');
  assert.equal(kernelDrop.failure_class, 'sut_or_protocol');
  assert.equal(kernelDrop.attribution.conclusion, 'sut_or_protocol_limited');
  assert.match(kernelDrop.reasons.join('\n'), /buffer errors/);
});

test('RTP throughput evidence does not hide SUT drops behind generator under-rate', () => {
  const evidence = evaluateSippRtpThroughputEvidence({
    expected_calls: 900,
    duration_seconds: 30,
    packets_per_second: 50,
    minimum_packet_coverage_ratio: 0.95,
    uac_exit_code: 0,
    uas_exit_code: 1,
    uac_successful_calls: 900,
    uac_failed_calls: 0,
    uac_retransmissions: 0,
    uas_successful_calls: 847,
    uas_failed_calls: 53,
    uas_retransmissions: 122,
    before: counters(),
    after: counters({
      in_datagrams: 2_560_508,
      out_datagrams: 2_609_176,
      receive_buffer_errors: 104,
      in_errors: 104,
      no_ports: 1
    })
  });

  assert.equal(evidence.status, 'controlled_failed');
  assert.equal(evidence.failure_class, 'mixed_or_inconclusive');
  assert.equal(evidence.attribution.conclusion, 'mixed_or_inconclusive');
  assert.match(evidence.attribution.generator_signals.join('\n'), /inbound UDP coverage/);
  assert.match(
    evidence.attribution.sut_or_protocol_signals.join('\n'),
    /receive buffer/
  );
});
