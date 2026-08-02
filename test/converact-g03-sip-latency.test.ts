import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSipLatencyReport,
  parseSippRttCsv,
  parseSippScenarioStatistics
} from '../scripts/converact-g03-sip-latency.js';

test('G03 latency evidence uses nearest-rank quantiles and the Trying hard gate', () => {
  const trying = Array.from({ length: 100 }, (_, index) => index + 1);
  trying[99] = 150;
  const report = buildSipLatencyReport({
    identity: identity(),
    expected_samples_per_scenario: 100,
    scenario_statistics: {
      trying: statistics('a'),
      final: statistics('b'),
      overload: statistics('c')
    },
    measurements: {
      trying: measurement('g03_trying', trying, 'd'),
      final: measurement('g03_final', [10, 20, 30, 40, 50, ...trying.slice(5)], 'e'),
      overload: measurement('g03_overload', trying.map((value) => value / 2), 'f')
    }
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.measurements.trying.p99_ms, 99);
  assert.equal(report.measurements.trying.max_ms, 150);
  assert.deepEqual(report.failed_checks, []);
  assert.equal(report.thresholds.trying_p99_budget_ms, 100);
  assert.equal(report.thresholds.trying_hard_deadline_ms, 200);
  assert.equal(report.thresholds.final_and_overload, 'distribution_only_no_invented_budget');
});

test('G03 latency evidence fails when Trying P99 or one-response ownership fails', () => {
  const trying = Array.from({ length: 100 }, (_, index) => index + 3);
  assert.equal(trying[98], 101);
  const report = buildSipLatencyReport({
    identity: identity(),
    expected_samples_per_scenario: 100,
    scenario_statistics: {
      trying: statistics('1', { response_received: 101 }),
      final: statistics('2'),
      overload: statistics('3', { successful_calls: 99, failed_calls: 1 })
    },
    measurements: {
      trying: measurement('g03_trying', trying, '4'),
      final: measurement('g03_final', trying, '5'),
      overload: measurement('g03_overload', trying, '6')
    }
  });

  assert.equal(report.status, 'failed');
  assert.deepEqual(report.failed_checks, [
    'trying_p99_ms',
    'trying_response_count',
    'overload_successful_calls',
    'overload_failed_calls',
    'overload_retry_after'
  ]);
});

test('SIPp RTT parser rejects missing, mixed or malformed samples', () => {
  const csv = [
    'Date_ms;response_time_ms;rtd_no',
    '1785628800000;12.5;g03_trying',
    '1785628800001;25;g03_trying'
  ].join('\n');
  assert.deepEqual(parseSippRttCsv(csv, 'g03_trying'), [12.5, 25]);
  assert.throws(
    () => parseSippRttCsv(csv.replace('25;g03_trying', '25;g03_final'), 'g03_trying'),
    /unexpected RTT domain/i
  );
  assert.throws(
    () => parseSippRttCsv(csv.replace('12.5', '-1'), 'g03_trying'),
    /response time/i
  );
  assert.throws(
    () => parseSippRttCsv(csv.replace('1785628800001', 'not-a-date'), 'g03_trying'),
    /measurement date/i
  );
  assert.throws(
    () => parseSippRttCsv(csv.replace(
      'Date_ms;response_time_ms;rtd_no',
      'call_id;rtd_no;response_time_ms'
    ), 'g03_trying'),
    /header/i
  );
  assert.throws(() => parseSippRttCsv('broken', 'g03_trying'), /header/i);
});

test('SIPp statistics parser derives exact message ownership from the final row', () => {
  const aggregate = [
    'TotalCallCreated(C);SuccessfulCall(C);FailedCall(C)',
    '1;1;0',
    '100;100;0'
  ].join('\n');
  const counts = [
    [
      'CurrentTime', 'ElapsedTime',
      '0_INVITE_Sent', '0_INVITE_Retrans',
      '1_100_Recv', '1_100_Retrans', '1_100_Timeout', '1_100_Unexp'
    ].join(';'),
    '2026-08-02T00:00:00Z;00:00:00.001;1;0;1;0;0;0',
    '2026-08-02T00:00:01Z;00:00:01.000;100;0;100;0;0;0'
  ].join('\n');

  assert.deepEqual(parseSippScenarioStatistics(aggregate, counts, '100'), {
    total_calls_created: 100,
    successful_calls: 100,
    failed_calls: 0,
    invite_sent: 100,
    invite_retransmissions: 0,
    response_received: 100,
    response_retransmissions: 0,
    response_timeouts: 0,
    unexpected_responses: 0
  });
  assert.throws(
    () => parseSippScenarioStatistics(
      aggregate,
      counts.replace('1_100_Recv', '1_486_Recv'),
      '100'
    ),
    /response counter/i
  );
  assert.throws(
    () => parseSippScenarioStatistics(aggregate, `${counts};unexpected`, '100'),
    /row width/i
  );
});

function measurement(rtdNo: string, samples: number[], seed: string) {
  return {
    rtd_no: rtdNo,
    samples_ms: samples,
    raw_csv_sha256: seed.repeat(64)
  };
}

function statistics(seed: string, overrides: Partial<ReturnType<typeof statisticsBase>> = {}) {
  return {
    ...statisticsBase(seed),
    ...overrides
  };
}

function statisticsBase(seed: string) {
  return {
    total_calls_created: 100,
    successful_calls: 100,
    failed_calls: 0,
    invite_sent: 100,
    invite_retransmissions: 0,
    response_received: 100,
    response_retransmissions: 0,
    response_timeouts: 0,
    unexpected_responses: 0,
    aggregate_csv_sha256: seed.repeat(64),
    message_counts_csv_sha256: seed.repeat(64)
  };
}

function identity() {
  return {
    generated_at: '2026-08-02T00:00:00.000Z',
    source_commit: '1'.repeat(40),
    rustpbx_commit: '6c49ee76baa54fdbf8f98020cc9bee158c7c15de',
    rsipstack_commit: '8318e97b1170de4e5245b120afec1cdf53e3d716',
    patchset: 'ivekit.41' as const,
    sipp_version: '3.7.7' as const,
    sipp_binary_sha256: '8e8ecdbe923bf608c844038adfa35c8595400c4629d629f00d51539ac24cdfef',
    host_fingerprint_sha256: '2'.repeat(64)
  };
}
