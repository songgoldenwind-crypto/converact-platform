import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSippRtpCheckDockerPlan,
  evaluateSippRtpCheckEvidence,
  parseSippRtpCheckDebug,
  renderSippRtpCheckScenarios,
  type SippRtpCheckDebugSummary
} from '../scripts/capacity/sipp-rtp-check.js';

function debugSummary(input: {
  worker_count: number;
  active_task_count: number;
  checked_packet_count: number;
  invalid_or_missing_packet_count: number;
  invalid_or_missing_ratio: number;
} & Partial<SippRtpCheckDebugSummary>): SippRtpCheckDebugSummary {
  const startup = input.startup_missing_packet_count || 0;
  const steady = input.steady_state_empty_poll_count || 0;
  const control = input.non_rtp_control_interference_count || 0;
  const payload = input.rtp_payload_mismatch_packet_count ??
    input.invalid_or_missing_packet_count - startup - steady - control;
  const sequenceErrors =
    (input.received_rtp_sequence_gap_packet_count || 0) +
    (input.received_rtp_duplicate_packet_count || 0) +
    (input.received_rtp_reordered_packet_count || 0);
  const mediaErrors = input.media_error_packet_count ??
    Math.max(payload, sequenceErrors);
  return {
    generated_rtp_packet_count: 0,
    received_rtp_packet_count: 0,
    received_non_rtp_control_packet_count: 0,
    startup_missing_packet_count: startup,
    steady_state_empty_poll_count: steady,
    non_rtp_control_interference_count: control,
    rtp_payload_mismatch_packet_count: payload,
    received_rtp_sequence_gap_packet_count: 0,
    received_rtp_duplicate_packet_count: 0,
    received_rtp_reordered_packet_count: 0,
    media_error_packet_count: mediaErrors,
    media_error_ratio: mediaErrors / input.checked_packet_count,
    ...input
  };
}

test('SIPp RTP-check parser aggregates active tasks across worker threads', () => {
  const parsed = parseSippRtpCheckDebug([
    'TID: 101 ----RTPCHECKS----',
    '0',
    '2',
    '0',
    'TID: 101 ----PACKET COUNTS----',
    '100',
    '100',
    '0',
    'TID: 202 ----RTPCHECKS----',
    '1',
    '0',
    'TID: 202 ----PACKET COUNTS----',
    '50',
    '0',
    ''
  ].join('\n'));

  assert.deepEqual(parsed, debugSummary({
    worker_count: 2,
    active_task_count: 3,
    checked_packet_count: 250,
    invalid_or_missing_packet_count: 3,
    invalid_or_missing_ratio: 0.012
  }));
});

test('SIPp RTP-check parser fails closed on incomplete or misaligned vectors', () => {
  assert.throws(
    () => parseSippRtpCheckDebug('TID: 101 ----RTPCHECKS----\n0\n'),
    /packet count vector is missing/
  );
  assert.throws(
    () => parseSippRtpCheckDebug([
      'TID: 101 ----RTPCHECKS----',
      '0',
      'TID: 101 ----PACKET COUNTS----',
      '100',
      '200',
      ''
    ].join('\n')),
    /vector lengths do not match/
  );
  assert.throws(
    () => parseSippRtpCheckDebug([
      'TID: 101 ----RTPCHECKS----',
      '0',
      'TID: 101 ----PACKET COUNTS----',
      '0',
      ''
    ].join('\n')),
    /contains no checked media packets/
  );
});

test('SIPp RTP-check parser stops vectors at trailing worker diagnostics', () => {
  const parsed = parseSippRtpCheckDebug([
    'TID: 101 ----DEBUG CURRENTTASK/NUMTASKS---- 0 0x0 1 []',
    'TID: 101 ----RTPCHECKS----',
    '0',
    'TID: 101 ----PACKET COUNTS----',
    '247',
    'TID: 101 PLAYBACK THREAD EXITING... 0 0x1 0 []',
    'TID: 202 EXISTING THREADID: 0 0x123 0 []',
    ''
  ].join('\n'));

  assert.deepEqual(parsed, debugSummary({
    worker_count: 1,
    active_task_count: 1,
    checked_packet_count: 247,
    invalid_or_missing_packet_count: 0,
    invalid_or_missing_ratio: 0
  }));
});

test('SIPp RTP-check parser separates startup probation and STUN from media errors', () => {
  const parsed = parseSippRtpCheckDebug([
    'TID: 101 NODATA 0 0x1 1 []',
    'TID: 101 ----FAILED RTP CHECK---- 0 0x1 1 []',
    'TID: 101 COMPARISON OK 0 0x1 2 []',
    'TID: 101 SIPP SUCCESS RECV LOG: 32 0x20 3 [0001000C2112A44200112233445566778899AABB]',
    'TID: 101 COMPARISON FAILED 0 0x2 3 []',
    'TID: 101 ----FAILED RTP CHECK---- 0 0x2 3 []',
    'TID: 101 ----RTPCHECKS----',
    '4',
    'TID: 101 ----PACKET COUNTS----',
    '100',
    ''
  ].join('\n'));

  assert.deepEqual(parsed, debugSummary({
    worker_count: 1,
    active_task_count: 1,
    checked_packet_count: 100,
    invalid_or_missing_packet_count: 4,
    invalid_or_missing_ratio: 0.04,
    startup_missing_packet_count: 1,
    non_rtp_control_interference_count: 1,
    received_non_rtp_control_packet_count: 1
  }));
});

test('SIPp RTP-check evaluator applies strict packet and media coverage gates', () => {
  const common = {
    expected_calls: 10,
    duration_seconds: 5,
    packets_per_second: 50,
    maximum_invalid_or_missing_ratio: 0.001,
    maximum_startup_missing_packets_per_call: 3,
    minimum_packet_coverage_ratio: 0.95,
    uac_exit_code: 0,
    uas_exit_code: 0,
    uac_successful_calls: 10,
    uac_failed_calls: 0,
    uac_retransmissions: 0,
    uas_successful_calls: 10,
    uas_failed_calls: 0,
    uas_retransmissions: 0
  };
  const clean = debugSummary({
    worker_count: 2,
    active_task_count: 10,
    checked_packet_count: 2_500,
    invalid_or_missing_packet_count: 0,
    invalid_or_missing_ratio: 0,
    generated_rtp_packet_count: 2_500,
    received_rtp_packet_count: 2_500
  });
  const pass = evaluateSippRtpCheckEvidence({
    ...common,
    debug: { uac: clean, uas: clean }
  });
  assert.equal(pass.status, 'controlled_pass', pass.reasons.join('\n'));
  assert.equal(pass.capacity_claim, 'none');
  assert.equal(pass.directions.uac_to_uas.edge_unobserved_packet_count, 0);
  assert.equal(pass.directions.uac_to_uas.durable_loss_packet_count, 0);
  assert.equal(pass.directions.uas_to_uac.durable_loss_packet_count, 0);

  const strictFailure = evaluateSippRtpCheckEvidence({
    ...common,
    debug: {
      uac: clean,
      uas: debugSummary({
        worker_count: 2,
        active_task_count: 10,
        checked_packet_count: 2_500,
        invalid_or_missing_packet_count: 0,
        invalid_or_missing_ratio: 0,
        generated_rtp_packet_count: 2_500,
        received_rtp_packet_count: 2_497,
        received_rtp_sequence_gap_packet_count: 3
      })
    }
  });
  assert.equal(strictFailure.status, 'controlled_failed');
  assert.match(strictFailure.reasons.join('\n'), /durable RTP loss/);

  const underRate = evaluateSippRtpCheckEvidence({
    ...common,
    debug: {
      uac: debugSummary({
        worker_count: 2,
        active_task_count: 10,
        checked_packet_count: 2_000,
        invalid_or_missing_packet_count: 0,
        invalid_or_missing_ratio: 0,
        generated_rtp_packet_count: 2_000,
        received_rtp_packet_count: 2_000
      }),
      uas: clean
    }
  });
  assert.equal(underRate.status, 'invalid_generator_capacity');
  assert.match(underRate.reasons.join('\n'), /packet coverage/);

  const probationAndStun = evaluateSippRtpCheckEvidence({
    ...common,
    debug: {
      uac: debugSummary({
        worker_count: 2,
        active_task_count: 10,
        checked_packet_count: 2_480,
        invalid_or_missing_packet_count: 30,
        invalid_or_missing_ratio: 30 / 2_480,
        generated_rtp_packet_count: 2_480,
        received_rtp_packet_count: 2_475,
        startup_missing_packet_count: 20,
        non_rtp_control_interference_count: 10,
        received_non_rtp_control_packet_count: 10
      }),
      uas: debugSummary({
        worker_count: 2,
        active_task_count: 10,
        checked_packet_count: 2_475,
        invalid_or_missing_packet_count: 20,
        invalid_or_missing_ratio: 20 / 2_475,
        generated_rtp_packet_count: 2_475,
        received_rtp_packet_count: 2_470,
        startup_missing_packet_count: 10,
        non_rtp_control_interference_count: 10,
        received_non_rtp_control_packet_count: 10
      })
    }
  });
  assert.equal(
    probationAndStun.status,
    'controlled_pass',
    probationAndStun.reasons.join('\n')
  );

  const schedulerEmptyPolls = evaluateSippRtpCheckEvidence({
    ...common,
    debug: {
      uac: debugSummary({
        worker_count: 2,
        active_task_count: 10,
        checked_packet_count: 2_500,
        invalid_or_missing_packet_count: 400,
        invalid_or_missing_ratio: 0.16,
        generated_rtp_packet_count: 2_500,
        received_rtp_packet_count: 2_500,
        steady_state_empty_poll_count: 400
      }),
      uas: debugSummary({
        worker_count: 2,
        active_task_count: 10,
        checked_packet_count: 2_500,
        invalid_or_missing_packet_count: 350,
        invalid_or_missing_ratio: 0.14,
        generated_rtp_packet_count: 2_500,
        received_rtp_packet_count: 2_500,
        steady_state_empty_poll_count: 350
      })
    }
  });
  assert.equal(
    schedulerEmptyPolls.status,
    'controlled_pass',
    schedulerEmptyPolls.reasons.join('\n')
  );

  const lifecycleEdgeSkew = evaluateSippRtpCheckEvidence({
    ...common,
    debug: {
      uac: debugSummary({
        worker_count: 2,
        active_task_count: 10,
        checked_packet_count: 2_500,
        invalid_or_missing_packet_count: 0,
        invalid_or_missing_ratio: 0,
        generated_rtp_packet_count: 2_500,
        received_rtp_packet_count: 2_475
      }),
      uas: debugSummary({
        worker_count: 2,
        active_task_count: 10,
        checked_packet_count: 2_500,
        invalid_or_missing_packet_count: 0,
        invalid_or_missing_ratio: 0,
        generated_rtp_packet_count: 2_520,
        received_rtp_packet_count: 2_480
      })
    }
  });
  assert.equal(
    lifecycleEdgeSkew.status,
    'controlled_pass',
    lifecycleEdgeSkew.reasons.join('\n')
  );
  assert.equal(
    lifecycleEdgeSkew.directions.uas_to_uac.edge_unobserved_packet_count,
    45
  );

  const receiverUnderCoverage = evaluateSippRtpCheckEvidence({
    ...common,
    debug: {
      uac: clean,
      uas: {
        ...clean,
        received_rtp_packet_count: 2_000
      }
    }
  });
  assert.equal(receiverUnderCoverage.status, 'controlled_failed');
  assert.match(
    receiverUnderCoverage.reasons.join('\n'),
    /remote receive coverage/
  );

  const retransmission = evaluateSippRtpCheckEvidence({
    ...common,
    uas_retransmissions: 1,
    debug: { uac: clean, uas: clean }
  });
  assert.equal(retransmission.status, 'controlled_failed');
  assert.match(retransmission.reasons.join('\n'), /SIP retransmissions/);

  const excessiveStartupLoss = evaluateSippRtpCheckEvidence({
    ...common,
    debug: {
      uac: debugSummary({
        worker_count: 2,
        active_task_count: 10,
        checked_packet_count: 2_480,
        invalid_or_missing_packet_count: 41,
        invalid_or_missing_ratio: 41 / 2_480,
        generated_rtp_packet_count: 2_480,
        received_rtp_packet_count: 2_475,
        startup_missing_packet_count: 31,
        non_rtp_control_interference_count: 10,
        received_non_rtp_control_packet_count: 10
      }),
      uas: debugSummary({
        worker_count: 2,
        active_task_count: 10,
        checked_packet_count: 2_475,
        invalid_or_missing_packet_count: 0,
        invalid_or_missing_ratio: 0,
        generated_rtp_packet_count: 2_475,
        received_rtp_packet_count: 2_470
      })
    }
  });
  assert.equal(excessiveStartupLoss.status, 'controlled_failed');
  assert.match(excessiveStartupLoss.reasons.join('\n'), /startup missing/);

  const impossibleReconciliation = evaluateSippRtpCheckEvidence({
    ...common,
    debug: {
      uac: {
        ...clean,
        generated_rtp_packet_count: 2_499
      },
      uas: clean
    }
  });
  assert.equal(
    impossibleReconciliation.status,
    'invalid_generator_capacity'
  );
  assert.match(
    impossibleReconciliation.reasons.join('\n'),
    /received more RTP/
  );
});

test('SIPp RTP-check scenarios carry PCMU through an active peer endpoint', () => {
  const scenarios = renderSippRtpCheckScenarios({ media_duration_ms: 5_000 });

  assert.match(scenarios.uac, /m=audio \[rtpstream_audio_port\] RTP\/AVP 0/);
  assert.match(scenarios.uac, /rtp_stream="apattern,1,0,PCMU\/8000"/);
  assert.match(scenarios.uac, /pause milliseconds="5000"/);
  assert.match(scenarios.uac, /rtp_stream="pauseapattern"/);
  assert.match(scenarios.uas, /m=audio \[rtpstream_audio_port\] RTP\/AVP 0/);
  assert.match(scenarios.uas, /rtp_stream="apattern,1,0,PCMU\/8000"/);
  assert.match(scenarios.uas, /rtp_stream="pauseapattern"/);
  assert.doesNotMatch(scenarios.uas, /rtp_echo=/);
  assert.ok(
    scenarios.uas.indexOf('<recv request="ACK" />') <
    scenarios.uas.indexOf('rtp_stream="apattern,1,0,PCMU/8000"')
  );
  assert.doesNotMatch(`${scenarios.uac}${scenarios.uas}`, /play_pcap/);
});

test('SIPp RTP-check scenario renderer rejects unbounded media duration', () => {
  assert.throws(
    () => renderSippRtpCheckScenarios({ media_duration_ms: 0 }),
    /media duration/
  );
  assert.throws(
    () => renderSippRtpCheckScenarios({ media_duration_ms: 300_001 }),
    /media duration/
  );
});

test('SIPp RTP-check Docker plan isolates media endpoints and preserves raw evidence', () => {
  const plan = buildSippRtpCheckDockerPlan({
    network: 'ivekit-rtp',
    target_ip: '172.30.44.9',
    uac_ip: '172.30.44.20',
    uas_ip: '172.30.44.22',
    sipp_binary: '/cache/sipp',
    result_dir: '/evidence/rtp-point',
    container_image: 'alpine@sha256:abc',
    run_id: 'pcmu-10',
    service: '+18005550200',
    calls: 10,
    calls_per_second: 10,
    timeout_seconds: 30,
    rtp_port_min: 6000,
    rtp_tasks_per_thread: 64
  });

  assert.equal(plan.uac_container, 'ivekit-rtp-uac-pcmu-10');
  assert.equal(plan.uas_container, 'ivekit-rtp-uas-pcmu-10');
  assert.deepEqual(plan.rtp_port_range, { minimum: 6000, maximum: 6019 });
  assert.deepEqual(plan.artifacts, {
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
  });

  const uac = plan.uac_args.join(' ');
  assert.match(uac, /--network ivekit-rtp --ip 172\.30\.44\.20/);
  assert.match(uac, /-w \/results\/uac/);
  assert.match(uac, /172\.30\.44\.9:5060/);
  assert.match(uac, /-mi 172\.30\.44\.20/);
  assert.match(uac, /-s \+18005550200/);
  assert.match(uac, /-min_rtp_port 6000 -max_rtp_port 6019/);
  assert.match(uac, /-rtp_threadtasks 64/);
  assert.match(uac, /-rtpcheck_debug -audiotolerance 1/);
  assert.match(uac, /-m 10 -r 10 -rp 1000 -l 10/);
  assert.match(uac, /-stf \/results\/rtp-check-uac\.csv/);
  assert.match(uac, /-message_file \/results\/rtp-check-uac-messages\.log/);

  const uas = plan.uas_args.join(' ');
  assert.match(uas, /run -d --name ivekit-rtp-uas-pcmu-10/);
  assert.match(uas, /-w \/results\/uas/);
  assert.match(uas, /--network ivekit-rtp --ip 172\.30\.44\.22/);
  assert.match(uas, /-mi 172\.30\.44\.22/);
  assert.match(uas, /-min_rtp_port 6000 -max_rtp_port 6019/);
  assert.match(uas, /-rtpcheck_debug -audiotolerance 1/);
});

test('SIPp RTP throughput plan omits per-packet debug logging', () => {
  const plan = buildSippRtpCheckDockerPlan({
    network: 'ivekit-rtp',
    target_ip: '172.30.44.9',
    uac_ip: '172.30.44.20',
    uas_ip: '172.30.44.22',
    sipp_binary: '/cache/sipp',
    result_dir: '/evidence/rtp-point',
    container_image: 'alpine@sha256:abc',
    run_id: 'pcmu-throughput',
    service: '18005550200',
    calls: 200,
    calls_per_second: 200,
    timeout_seconds: 30,
    rtp_port_min: 6000,
    rtp_tasks_per_thread: 64,
    evidence_mode: 'throughput'
  });

  assert.doesNotMatch(plan.uac_args.join(' '), /rtpcheck_debug/);
  assert.doesNotMatch(plan.uas_args.join(' '), /rtpcheck_debug/);
  assert.doesNotMatch(plan.uac_args.join(' '), /trace_msg/);
  assert.doesNotMatch(plan.uas_args.join(' '), /trace_msg/);
});

test('SIPp RTP-check Docker plan rejects unsafe names and exhausted RTP ranges', () => {
  const input = {
    network: 'ivekit-rtp',
    target_ip: '172.30.44.9',
    uac_ip: '172.30.44.20',
    uas_ip: '172.30.44.22',
    sipp_binary: '/cache/sipp',
    result_dir: '/evidence/rtp-point',
    container_image: 'alpine@sha256:abc',
    run_id: 'pcmu',
    service: '18005550200',
    calls: 10,
    calls_per_second: 10,
    timeout_seconds: 30,
    rtp_port_min: 6000,
    rtp_tasks_per_thread: 64
  };

  assert.throws(
    () => buildSippRtpCheckDockerPlan({ ...input, run_id: '../../escape' }),
    /run ID/
  );
  assert.throws(
    () => buildSippRtpCheckDockerPlan({
      ...input,
      calls: 10,
      rtp_port_min: 65_530
    }),
    /RTP port range/
  );
  assert.throws(
    () => buildSippRtpCheckDockerPlan({
      ...input,
      service: '+18005550200;transport=tcp'
    }),
    /service/
  );
});
