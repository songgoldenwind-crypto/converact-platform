import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const TRYING_P99_BUDGET_MS = 100;
const TRYING_HARD_DEADLINE_MS = 200;

export interface SipLatencyIdentity {
  readonly generated_at: string;
  readonly source_commit: string;
  readonly rustpbx_commit: string;
  readonly rsipstack_commit: string;
  readonly patchset: 'ivekit.42';
  readonly sipp_version: '3.7.7';
  readonly sipp_binary_sha256: string;
  readonly host_fingerprint_sha256: string;
}

export interface SipLatencyMeasurementInput {
  readonly rtd_no: string;
  readonly samples_ms: readonly number[];
  readonly raw_csv_sha256: string;
}

export interface SippScenarioStatistics {
  readonly total_calls_created: number;
  readonly successful_calls: number;
  readonly failed_calls: number;
  readonly invite_sent: number;
  readonly invite_retransmissions: number;
  readonly response_received: number;
  readonly response_retransmissions: number;
  readonly response_timeouts: number;
  readonly unexpected_responses: number;
}

export interface SipLatencyScenarioStatisticsInput extends SippScenarioStatistics {
  readonly aggregate_csv_sha256: string;
  readonly message_counts_csv_sha256: string;
}

export interface SipLatencyReport {
  readonly schema_id: 'converact-g03-sip-latency-v1';
  readonly schema_version: '1.0.0';
  readonly status: 'passed' | 'failed';
  readonly identity: SipLatencyIdentity;
  readonly thresholds: {
    readonly trying_p99_budget_ms: 100;
    readonly trying_hard_deadline_ms: 200;
    readonly final_and_overload: 'distribution_only_no_invented_budget';
  };
  readonly ownership: {
    readonly trying_invites: number;
    readonly trying_responses: number;
    readonly trying_response_retransmissions: number;
    readonly one_trying_per_invite: boolean;
    readonly overload_retry_after_verified: boolean;
  };
  readonly scenario_statistics: Record<
    'trying' | 'final' | 'overload',
    SipLatencyScenarioStatisticsInput
  >;
  readonly measurements: Record<'trying' | 'final' | 'overload', {
    readonly rtd_no: string;
    readonly sample_count: number;
    readonly p50_ms: number;
    readonly p95_ms: number;
    readonly p99_ms: number;
    readonly max_ms: number;
    readonly raw_csv_sha256: string;
  }>;
  readonly failed_checks: readonly string[];
}

export function buildSipLatencyReport(input: {
  readonly identity: SipLatencyIdentity;
  readonly expected_samples_per_scenario: number;
  readonly scenario_statistics: Record<
    'trying' | 'final' | 'overload',
    SipLatencyScenarioStatisticsInput
  >;
  readonly measurements: Record<'trying' | 'final' | 'overload', SipLatencyMeasurementInput>;
}): SipLatencyReport {
  validateIdentity(input.identity);
  const expected = boundedInteger(input.expected_samples_per_scenario, 1, 10_000_000);
  const scenarioStatistics = {
    trying: validateScenarioStatistics(input.scenario_statistics.trying),
    final: validateScenarioStatistics(input.scenario_statistics.final),
    overload: validateScenarioStatistics(input.scenario_statistics.overload)
  };

  const measurements = {
    trying: summarizeMeasurement(input.measurements.trying, 'g03_trying', expected),
    final: summarizeMeasurement(input.measurements.final, 'g03_final', expected),
    overload: summarizeMeasurement(input.measurements.overload, 'g03_overload', expected)
  };
  const failedChecks: string[] = [];
  if (measurements.trying.p99_ms > TRYING_P99_BUDGET_MS) {
    failedChecks.push('trying_p99_ms');
  }
  if (measurements.trying.max_ms > TRYING_HARD_DEADLINE_MS) {
    failedChecks.push('trying_max_ms');
  }
  for (const name of ['trying', 'final', 'overload'] as const) {
    appendScenarioChecks(failedChecks, name, scenarioStatistics[name], expected);
  }
  const overloadRetryAfterVerified = scenarioConforms(scenarioStatistics.overload, expected);
  if (!overloadRetryAfterVerified) {
    failedChecks.push('overload_retry_after');
  }
  const oneTryingPerInvite = scenarioConforms(scenarioStatistics.trying, expected);

  return Object.freeze({
    schema_id: 'converact-g03-sip-latency-v1',
    schema_version: '1.0.0',
    status: failedChecks.length === 0 ? 'passed' : 'failed',
    identity: Object.freeze({ ...input.identity }),
    thresholds: Object.freeze({
      trying_p99_budget_ms: TRYING_P99_BUDGET_MS,
      trying_hard_deadline_ms: TRYING_HARD_DEADLINE_MS,
      final_and_overload: 'distribution_only_no_invented_budget' as const
    }),
    ownership: Object.freeze({
      trying_invites: scenarioStatistics.trying.invite_sent,
      trying_responses: scenarioStatistics.trying.response_received,
      trying_response_retransmissions:
        scenarioStatistics.trying.response_retransmissions,
      one_trying_per_invite: oneTryingPerInvite,
      overload_retry_after_verified: overloadRetryAfterVerified
    }),
    scenario_statistics: Object.freeze(scenarioStatistics),
    measurements: Object.freeze(measurements),
    failed_checks: Object.freeze(failedChecks)
  });
}

function validateScenarioStatistics(
  value: SipLatencyScenarioStatisticsInput
): Readonly<SipLatencyScenarioStatisticsInput> {
  const keys = [
    'total_calls_created', 'successful_calls', 'failed_calls', 'invite_sent',
    'invite_retransmissions', 'response_received', 'response_retransmissions',
    'response_timeouts', 'unexpected_responses', 'aggregate_csv_sha256',
    'message_counts_csv_sha256'
  ];
  if (!value ||
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key)) ||
      !SHA256_PATTERN.test(value.aggregate_csv_sha256) ||
      !SHA256_PATTERN.test(value.message_counts_csv_sha256)) {
    throw new Error('SIPp scenario statistics identity is invalid');
  }
  for (const [name, count] of Object.entries(value)) {
    if (!name.endsWith('_sha256')) boundedInteger(Number(count), 0, 10_000_000);
  }
  return Object.freeze({ ...value });
}

function appendScenarioChecks(
  failedChecks: string[],
  name: 'trying' | 'final' | 'overload',
  statistics: SipLatencyScenarioStatisticsInput,
  expected: number
): void {
  const expectedCounts: Array<[keyof SippScenarioStatistics, number]> = [
    ['total_calls_created', expected],
    ['successful_calls', expected],
    ['failed_calls', 0],
    ['invite_sent', expected],
    ['invite_retransmissions', 0],
    ['response_received', expected],
    ['response_retransmissions', 0],
    ['response_timeouts', 0],
    ['unexpected_responses', 0]
  ];
  for (const [field, expectedValue] of expectedCounts) {
    const check = field === 'response_received' ? 'response_count' : field;
    if (statistics[field] !== expectedValue) failedChecks.push(`${name}_${check}`);
  }
}

function scenarioConforms(
  statistics: SipLatencyScenarioStatisticsInput,
  expected: number
): boolean {
  const failedChecks: string[] = [];
  appendScenarioChecks(failedChecks, 'trying', statistics, expected);
  return failedChecks.length === 0;
}

export function parseSippRttCsv(csv: string, expectedRtdNo: string): number[] {
  if (typeof csv !== 'string' || csv.includes('\0')) {
    throw new Error('SIPp RTT CSV is invalid');
  }
  const lines = csv.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error('SIPp RTT CSV header or samples are missing');
  }
  const header = fields(lines[0]!);
  const expectedHeader = ['Date_ms', 'response_time_ms', 'rtd_no'];
  if (header.length !== expectedHeader.length ||
      !header.every((value, index) => value === expectedHeader[index])) {
    throw new Error('SIPp RTT CSV header is invalid');
  }
  const samples: number[] = [];
  for (const line of lines.slice(1)) {
    const row = fields(line);
    if (row.length !== header.length) {
      throw new Error('SIPp RTT CSV row width is invalid');
    }
    const measuredAt = Number(row[0]);
    if (!Number.isFinite(measuredAt) || measuredAt < 0 || measuredAt > Number.MAX_SAFE_INTEGER) {
      throw new Error('SIPp RTT measurement date is invalid');
    }
    if (row[2] !== expectedRtdNo) {
      throw new Error('SIPp RTT CSV contains an unexpected RTT domain');
    }
    const responseTime = Number(row[1]);
    if (!Number.isFinite(responseTime) || responseTime < 0 || responseTime > 600_000) {
      throw new Error('SIPp RTT response time is invalid');
    }
    samples.push(responseTime);
  }
  if (samples.length < 1) {
    throw new Error('SIPp RTT CSV samples are missing');
  }
  return samples;
}

export function parseSippScenarioStatistics(
  aggregateCsv: string,
  messageCountsCsv: string,
  expectedResponseStatus: string
): SippScenarioStatistics {
  if (!/^\d{3}$/.test(expectedResponseStatus)) {
    throw new Error('SIPp statistics input is invalid');
  }
  const aggregate = finalCsvRow(aggregateCsv, 'aggregate statistics');
  const counts = finalCsvRow(messageCountsCsv, 'message counts');
  const invitePrefix = uniqueCounterPrefix(
    counts.header,
    /^\d+_INVITE_Sent$/,
    'INVITE counter'
  );
  const responsePrefix = uniqueCounterPrefix(
    counts.header,
    new RegExp(`^\\d+_${expectedResponseStatus}_Recv$`),
    'response counter'
  );
  const value = (source: { header: string[]; row: string[] }, name: string): number => {
    const index = source.header.indexOf(name);
    if (index < 0) throw new Error(`SIPp statistics are missing ${name}`);
    const parsed = Number(source.row[index]);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`SIPp statistics contain invalid ${name}`);
    }
    return parsed;
  };

  return Object.freeze({
    total_calls_created: value(aggregate, 'TotalCallCreated'),
    successful_calls: value(aggregate, 'SuccessfulCall(C)'),
    failed_calls: value(aggregate, 'FailedCall(C)'),
    invite_sent: value(counts, `${invitePrefix}Sent`),
    invite_retransmissions: value(counts, `${invitePrefix}Retrans`),
    response_received: value(counts, `${responsePrefix}Recv`),
    response_retransmissions: value(counts, `${responsePrefix}Retrans`),
    response_timeouts: value(counts, `${responsePrefix}Timeout`),
    unexpected_responses: value(counts, `${responsePrefix}Unexp`)
  });
}

function finalCsvRow(csv: string, label: string): { header: string[]; row: string[] } {
  if (typeof csv !== 'string' || csv.includes('\0')) {
    throw new Error(`SIPp ${label} input is invalid`);
  }
  const lines = csv.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error(`SIPp ${label} header or samples are missing`);
  const header = fields(lines[0]!);
  if (new Set(header).size !== header.length) {
    throw new Error(`SIPp ${label} header contains duplicate counters`);
  }
  const rows = lines.slice(1).map((line) => fields(line));
  if (rows.some((row) => row.length !== header.length)) {
    throw new Error(`SIPp ${label} row width is invalid`);
  }
  return { header, row: rows.at(-1)! };
}

function uniqueCounterPrefix(
  header: readonly string[],
  pattern: RegExp,
  label: string
): string {
  const matches = header.filter((name) => pattern.test(name));
  if (matches.length !== 1) throw new Error(`SIPp statistics ${label} is ambiguous or missing`);
  const suffix = matches[0]!.endsWith('_Sent') ? 'Sent' : 'Recv';
  return matches[0]!.slice(0, -suffix.length);
}

function fields(line: string): string[] {
  if (line.includes('"')) {
    throw new Error('quoted SIPp RTT CSV fields are not supported');
  }
  const values = line.split(';');
  if (values.at(-1) === '') values.pop();
  return values;
}

function summarizeMeasurement(
  input: SipLatencyMeasurementInput,
  expectedRtdNo: string,
  expectedSamples: number
) {
  if (input.rtd_no !== expectedRtdNo ||
      !Array.isArray(input.samples_ms) ||
      input.samples_ms.length !== expectedSamples ||
      !input.samples_ms.every((value) =>
        Number.isFinite(value) && value >= 0 && value <= 600_000
      ) ||
      !SHA256_PATTERN.test(input.raw_csv_sha256)) {
    throw new Error(`SIP latency measurement is invalid for ${expectedRtdNo}`);
  }
  const ordered = [...input.samples_ms].sort((left, right) => left - right);
  return Object.freeze({
    rtd_no: expectedRtdNo,
    sample_count: ordered.length,
    p50_ms: nearestRank(ordered, 0.50),
    p95_ms: nearestRank(ordered, 0.95),
    p99_ms: nearestRank(ordered, 0.99),
    max_ms: ordered.at(-1)!,
    raw_csv_sha256: input.raw_csv_sha256
  });
}

function nearestRank(ordered: readonly number[], ratio: number): number {
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)]!;
}

function validateIdentity(identity: SipLatencyIdentity): void {
  if (Number.isNaN(Date.parse(identity.generated_at)) ||
      !COMMIT_PATTERN.test(identity.source_commit) ||
      identity.rustpbx_commit !== '6c49ee76baa54fdbf8f98020cc9bee158c7c15de' ||
      identity.rsipstack_commit !== '8318e97b1170de4e5245b120afec1cdf53e3d716' ||
      identity.patchset !== 'ivekit.42' ||
      identity.sipp_version !== '3.7.7' ||
      identity.sipp_binary_sha256 !==
        '8e8ecdbe923bf608c844038adfa35c8595400c4629d629f00d51539ac24cdfef' ||
      !SHA256_PATTERN.test(identity.host_fingerprint_sha256)) {
    throw new Error('SIP latency identity is invalid');
  }
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('SIP latency integer is invalid');
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments(arguments_: readonly string[]): Record<string, string> {
  const expected = new Set([
    'trying-rtt-csv', 'final-rtt-csv', 'overload-rtt-csv',
    'trying-stat-csv', 'final-stat-csv', 'overload-stat-csv', 'expected-samples',
    'trying-count-csv', 'final-count-csv', 'overload-count-csv',
    'output', 'generated-at', 'source-commit', 'host-fingerprint-sha256'
  ]);
  const parsed: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('SIP latency arguments are invalid');
    }
    const name = flag.slice(2);
    if (!expected.has(name) || parsed[name] !== undefined) {
      throw new Error(`SIP latency argument is invalid: ${flag}`);
    }
    parsed[name] = value;
  }
  if ([...expected].some((name) => parsed[name] === undefined)) {
    throw new Error('SIP latency arguments are incomplete');
  }
  return parsed;
}

function runCli(): void {
  const arguments_ = parseArguments(process.argv.slice(2));
  const rttCsv = {
    trying: readFileSync(resolve(arguments_['trying-rtt-csv']!)),
    final: readFileSync(resolve(arguments_['final-rtt-csv']!)),
    overload: readFileSync(resolve(arguments_['overload-rtt-csv']!))
  };
  const aggregateCsv = {
    trying: readFileSync(resolve(arguments_['trying-stat-csv']!)),
    final: readFileSync(resolve(arguments_['final-stat-csv']!)),
    overload: readFileSync(resolve(arguments_['overload-stat-csv']!))
  };
  const messageCountsCsv = {
    trying: readFileSync(resolve(arguments_['trying-count-csv']!)),
    final: readFileSync(resolve(arguments_['final-count-csv']!)),
    overload: readFileSync(resolve(arguments_['overload-count-csv']!))
  };
  const report = buildSipLatencyReport({
    identity: {
      generated_at: arguments_['generated-at']!,
      source_commit: arguments_['source-commit']!,
      rustpbx_commit: '6c49ee76baa54fdbf8f98020cc9bee158c7c15de',
      rsipstack_commit: '8318e97b1170de4e5245b120afec1cdf53e3d716',
      patchset: 'ivekit.42',
      sipp_version: '3.7.7',
      sipp_binary_sha256: '8e8ecdbe923bf608c844038adfa35c8595400c4629d629f00d51539ac24cdfef',
      host_fingerprint_sha256: arguments_['host-fingerprint-sha256']!
    },
    expected_samples_per_scenario: Number(arguments_['expected-samples']),
    scenario_statistics: {
      trying: {
        ...parseSippScenarioStatistics(
          aggregateCsv.trying.toString('utf8'),
          messageCountsCsv.trying.toString('utf8'),
          '100'
        ),
        aggregate_csv_sha256: sha256(aggregateCsv.trying),
        message_counts_csv_sha256: sha256(messageCountsCsv.trying)
      },
      final: {
        ...parseSippScenarioStatistics(
          aggregateCsv.final.toString('utf8'),
          messageCountsCsv.final.toString('utf8'),
          '486'
        ),
        aggregate_csv_sha256: sha256(aggregateCsv.final),
        message_counts_csv_sha256: sha256(messageCountsCsv.final)
      },
      overload: {
        ...parseSippScenarioStatistics(
          aggregateCsv.overload.toString('utf8'),
          messageCountsCsv.overload.toString('utf8'),
          '503'
        ),
        aggregate_csv_sha256: sha256(aggregateCsv.overload),
        message_counts_csv_sha256: sha256(messageCountsCsv.overload)
      }
    },
    measurements: {
      trying: {
        rtd_no: 'g03_trying',
        samples_ms: parseSippRttCsv(rttCsv.trying.toString('utf8'), 'g03_trying'),
        raw_csv_sha256: sha256(rttCsv.trying)
      },
      final: {
        rtd_no: 'g03_final',
        samples_ms: parseSippRttCsv(rttCsv.final.toString('utf8'), 'g03_final'),
        raw_csv_sha256: sha256(rttCsv.final)
      },
      overload: {
        rtd_no: 'g03_overload',
        samples_ms: parseSippRttCsv(rttCsv.overload.toString('utf8'), 'g03_overload'),
        raw_csv_sha256: sha256(rttCsv.overload)
      }
    }
  });
  writeFileSync(resolve(arguments_['output']!), `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  });
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'SIP latency evidence failed');
    process.exitCode = 1;
  }
}
