import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSippCapacityProcessPlan,
  evaluateSippCapacityEvidence,
  runSippCapacityProcess
} from '../scripts/capacity/generators/sipp.js';

const statistics = [
  'StartTime;ElapsedTime(C);CallRate(C);SuccessfulCall(C);FailedCall(C);Retransmissions(C);',
  '2026-07-16 06:00:00;10.000;100.000;1000;0;3;'
].join('\n');

test('SIPp capacity plan binds shard, rate, concurrency and bounded evidence files', () => {
  const plan = buildSippCapacityProcessPlan({
    sipp_binary: '/opt/ivekit/bin/sipp',
    sipp_version: '3.7.7',
    sipp_binary_sha256: 'a'.repeat(64),
    scenario_path: '/opt/ivekit/scenarios/answer-bye-uac.xml',
    result_directory: '/var/lib/ivekit-loadgen/run-001',
    target_host: '10.10.0.12',
    target_port: 5060,
    local_ip: '10.20.0.21',
    local_port: 5062,
    transport: 'udp',
    service: '18005550200',
    run_id: 'sip-controlled-001',
    shard_id: 'interaction/sip_voice/0-1000',
    ordinal_start: 0,
    ordinal_end_exclusive: 1000,
    worker_id: 'sip-worker-1',
    lease_epoch: '1',
    total_calls: 1000,
    target_cps: 100,
    max_concurrent_calls: 500,
    timeout_seconds: 60
  });

  assert.equal(plan.executable, '/opt/ivekit/bin/sipp');
  assert.equal(plan.sipp_version, '3.7.7');
  assert.equal(plan.sipp_binary_sha256, 'a'.repeat(64));
  assert.deepEqual(plan.args.slice(0, 3), ['10.10.0.12:5060', '-sf', '/opt/ivekit/scenarios/answer-bye-uac.xml']);
  assert.equal(valueAfter(plan.args, '-m'), '1000');
  assert.equal(valueAfter(plan.args, '-r'), '100');
  assert.equal(valueAfter(plan.args, '-l'), '500');
  assert.equal(valueAfter(plan.args, '-t'), 'u1');
  assert.match(valueAfter(plan.args, '-cid_str'), /^sip-controlled-001-sip-worker-1-%u@10\.20\.0\.21$/);
  assert.match(plan.statistics_path, /sip-controlled-001-sip-worker-1-statistics\.csv$/);
  assert.equal(plan.args.includes('-trace_msg'), false);
  assert.equal(JSON.stringify(plan).includes('password'), false);
});

test('SIPp evidence accepts exact calls and rate without watchdog saturation', () => {
  const result = evaluateSippCapacityEvidence({
    run_id: 'sip-controlled-001',
    shard_id: 'interaction/sip_voice/0-1000',
    worker_id: 'sip-worker-1',
    lease_epoch: '1',
    expected_calls: 1000,
    target_cps: 100,
    rate_tolerance_ratio: 0.01,
    maximum_minor_watchdog_count: 0,
    sipp_version: '3.7.7',
    sipp_binary_sha256: 'a'.repeat(64),
    process: { code: 0, stdout: '', stderr: '', timed_out: false },
    statistics_csv: statistics
  });

  assert.equal(result.status, 'controlled_pass');
  assert.equal(result.failure_class, 'none');
  assert.equal(result.successful_calls, 1000);
  assert.equal(result.actual_cps, 100);
  assert.equal(result.rate_conformant, true);
});

test('SIPp watchdog saturation invalidates the generator rather than blaming the SUT', () => {
  const result = evaluateSippCapacityEvidence({
    run_id: 'sip-controlled-001',
    shard_id: 'interaction/sip_voice/0-1000',
    worker_id: 'sip-worker-1',
    lease_epoch: '1',
    expected_calls: 1000,
    target_cps: 100,
    rate_tolerance_ratio: 0.01,
    maximum_minor_watchdog_count: 0,
    sipp_version: '3.7.7',
    sipp_binary_sha256: 'a'.repeat(64),
    process: {
      code: 0,
      stdout: '',
      stderr: 'Watchdog major threshold triggered\nWatchdog minor threshold triggered',
      timed_out: false
    },
    statistics_csv: statistics
  });

  assert.equal(result.status, 'invalid_generator_capacity');
  assert.equal(result.failure_class, 'generator');
  assert.equal(result.watchdog_major_count, 1);
  assert.equal(result.watchdog_minor_count, 1);
});

test('SIPp under-generation without protocol failures is generator-invalid evidence', () => {
  const underGenerated = statistics
    .replace(';100.000;1000;0;3;', ';80.000;800;0;3;');
  const result = evaluateSippCapacityEvidence({
    run_id: 'sip-controlled-001',
    shard_id: 'interaction/sip_voice/0-1000',
    worker_id: 'sip-worker-1',
    lease_epoch: '1',
    expected_calls: 1000,
    target_cps: 100,
    rate_tolerance_ratio: 0.01,
    maximum_minor_watchdog_count: 0,
    sipp_version: '3.7.7',
    sipp_binary_sha256: 'a'.repeat(64),
    process: { code: 0, stdout: '', stderr: '', timed_out: false },
    statistics_csv: underGenerated
  });

  assert.equal(result.status, 'invalid_generator_capacity');
  assert.equal(result.failure_class, 'generator');
});

test('SIPp controlled runner uses executor evidence and preserves SUT failures', async () => {
  const plan = buildSippCapacityProcessPlan({
    sipp_binary: '/opt/ivekit/bin/sipp',
    sipp_version: '3.7.7',
    sipp_binary_sha256: 'a'.repeat(64),
    scenario_path: '/opt/ivekit/scenarios/answer-bye-uac.xml',
    result_directory: '/var/lib/ivekit-loadgen/run-002',
    target_host: '10.10.0.12',
    target_port: 5060,
    local_ip: '10.20.0.21',
    local_port: 5062,
    transport: 'tcp',
    service: '18005550200',
    run_id: 'sip-controlled-002',
    shard_id: 'interaction/sip_voice/0-1000',
    ordinal_start: 0,
    ordinal_end_exclusive: 1000,
    worker_id: 'sip-worker-2',
    lease_epoch: '1',
    total_calls: 1000,
    target_cps: 100,
    max_concurrent_calls: 500,
    timeout_seconds: 60
  });
  const failedStatistics = statistics.replace(';1000;0;3;', ';998;2;3;');
  const result = await runSippCapacityProcess(plan, async () => ({
    process: { code: 1, stdout: '', stderr: '', timed_out: false },
    statistics_csv: failedStatistics
  }));

  assert.equal(result.status, 'controlled_failed');
  assert.equal(result.failure_class, 'sut_or_protocol');
  assert.equal(result.failed_calls, 2);
});

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, `missing ${flag}`);
  return args[index + 1];
}
