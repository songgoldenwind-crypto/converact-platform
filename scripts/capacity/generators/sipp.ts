import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

export interface SippCapacityPlanInput {
  sipp_binary: string;
  sipp_version: string;
  sipp_binary_sha256: string;
  scenario_path: string;
  result_directory: string;
  target_host: string;
  target_port: number;
  local_ip: string;
  local_port: number;
  transport: 'udp' | 'tcp';
  service: string;
  run_id: string;
  shard_id: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  worker_id: string;
  lease_epoch: string;
  total_calls: number;
  target_cps: number;
  max_concurrent_calls: number;
  timeout_seconds: number;
  rate_tolerance_ratio?: number;
  maximum_minor_watchdog_count?: number;
  maximum_sip_route_p99_ms: number;
  maximum_post_dial_p95_ms: number;
  maximum_post_dial_p99_ms: number;
}

export interface SippCapacityProcessPlan {
  executable: string;
  sipp_version: string;
  sipp_binary_sha256: string;
  args: string[];
  statistics_path: string;
  error_path: string;
  result_directory: string;
  response_time_filename_prefix: string;
  timeout_ms: number;
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  expected_calls: number;
  target_cps: number;
  rate_tolerance_ratio: number;
  maximum_minor_watchdog_count: number;
  maximum_sip_route_p99_ms: number;
  maximum_post_dial_p95_ms: number;
  maximum_post_dial_p99_ms: number;
}

export interface SippProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export interface SippCapacityEvidence {
  protocol: 'sip';
  evidence_level: 'controlled';
  status: 'controlled_pass' | 'controlled_failed' | 'invalid_generator_capacity';
  failure_class: 'none' | 'generator' | 'sut_or_protocol' | 'runner';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  expected_calls: number;
  successful_calls: number;
  failed_calls: number;
  retransmissions: number;
  target_cps: number;
  actual_cps: number;
  rate_conformant: boolean;
  elapsed_seconds: number;
  watchdog_major_count: number;
  watchdog_minor_count: number;
  process_exit_code: number;
  process_timed_out: boolean;
  reasons: string[];
  sip_route_sample_count: number;
  sip_route_p99_ms: number;
  post_dial_sample_count: number;
  post_dial_p95_ms: number;
  post_dial_p99_ms: number;
  quality_gate_passed: boolean;
  quality_reasons: string[];
  sipp_version: string;
  sipp_binary_sha256: string;
}

export type SippCapacityExecutor = (plan: SippCapacityProcessPlan) => Promise<{
  process: SippProcessResult;
  statistics_csv: string;
  response_time_csv: string;
}>;

export function buildSippCapacityProcessPlan(input: SippCapacityPlanInput): SippCapacityProcessPlan {
  validatePlanInput(input);
  const artifactPrefix = `${input.run_id}-${input.worker_id}`;
  const statisticsPath = join(input.result_directory, `${artifactPrefix}-statistics.csv`);
  const errorPath = join(input.result_directory, `${artifactPrefix}-errors.log`);
  const responseTimePrefix = `${basename(input.scenario_path).replace(/\.xml$/i, '')}_`;
  const args = [
    `${input.target_host}:${input.target_port}`,
    '-sf', input.scenario_path,
    '-i', input.local_ip,
    '-p', String(input.local_port),
    '-t', input.transport === 'tcp' ? 't1' : 'u1',
    '-s', input.service,
    '-m', String(input.total_calls),
    '-r', String(input.target_cps),
    '-rp', '1000',
    '-l', String(input.max_concurrent_calls),
    '-timeout', String(input.timeout_seconds),
    '-cid_str', `${input.run_id}-${input.worker_id}-%u@${input.local_ip}`,
    '-nostdin',
    '-trace_stat',
    '-stf', statisticsPath,
    '-trace_err',
    '-error_file', errorPath,
    '-trace_rtt',
    '-rtt_freq', '1'
  ];
  return {
    executable: input.sipp_binary,
    sipp_version: input.sipp_version,
    sipp_binary_sha256: input.sipp_binary_sha256,
    args,
    statistics_path: statisticsPath,
    error_path: errorPath,
    result_directory: input.result_directory,
    response_time_filename_prefix: responseTimePrefix,
    timeout_ms: (input.timeout_seconds + 10) * 1_000,
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    expected_calls: input.total_calls,
    target_cps: input.target_cps,
    rate_tolerance_ratio: input.rate_tolerance_ratio ?? 0.01,
    maximum_minor_watchdog_count: input.maximum_minor_watchdog_count ?? 0,
    maximum_sip_route_p99_ms: input.maximum_sip_route_p99_ms,
    maximum_post_dial_p95_ms: input.maximum_post_dial_p95_ms,
    maximum_post_dial_p99_ms: input.maximum_post_dial_p99_ms
  };
}

export async function runSippCapacityProcess(
  plan: SippCapacityProcessPlan,
  executor: SippCapacityExecutor = executeSippCapacityPlan
): Promise<SippCapacityEvidence> {
  try {
    const executed = await executor(plan);
    return evaluateSippCapacityEvidence({
      run_id: plan.run_id,
      shard_id: plan.shard_id,
      worker_id: plan.worker_id,
      lease_epoch: plan.lease_epoch,
      expected_calls: plan.expected_calls,
      target_cps: plan.target_cps,
      rate_tolerance_ratio: plan.rate_tolerance_ratio,
      maximum_minor_watchdog_count: plan.maximum_minor_watchdog_count,
      maximum_sip_route_p99_ms: plan.maximum_sip_route_p99_ms,
      maximum_post_dial_p95_ms: plan.maximum_post_dial_p95_ms,
      maximum_post_dial_p99_ms: plan.maximum_post_dial_p99_ms,
      sipp_version: plan.sipp_version,
      sipp_binary_sha256: plan.sipp_binary_sha256,
      process: executed.process,
      statistics_csv: executed.statistics_csv,
      response_time_csv: executed.response_time_csv
    });
  } catch (error) {
    return {
      protocol: 'sip',
      evidence_level: 'controlled',
      status: 'controlled_failed',
      failure_class: 'runner',
      run_id: plan.run_id,
      shard_id: plan.shard_id,
      worker_id: plan.worker_id,
      lease_epoch: plan.lease_epoch,
      expected_calls: plan.expected_calls,
      successful_calls: 0,
      failed_calls: 0,
      retransmissions: 0,
      target_cps: plan.target_cps,
      actual_cps: 0,
      rate_conformant: false,
      elapsed_seconds: 0,
      watchdog_major_count: 0,
      watchdog_minor_count: 0,
      process_exit_code: -1,
      process_timed_out: false,
      reasons: [error instanceof Error ? error.message : String(error)],
      sip_route_sample_count: 0,
      sip_route_p99_ms: 0,
      post_dial_sample_count: 0,
      post_dial_p95_ms: 0,
      post_dial_p99_ms: 0,
      quality_gate_passed: false,
      quality_reasons: ['SIPp response-time evidence was not produced'],
      sipp_version: plan.sipp_version,
      sipp_binary_sha256: plan.sipp_binary_sha256
    };
  }
}

export function evaluateSippCapacityEvidence(input: {
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  expected_calls: number;
  target_cps: number;
  rate_tolerance_ratio: number;
  maximum_minor_watchdog_count: number;
  maximum_sip_route_p99_ms: number;
  maximum_post_dial_p95_ms: number;
  maximum_post_dial_p99_ms: number;
  sipp_version: string;
  sipp_binary_sha256: string;
  process: SippProcessResult;
  statistics_csv: string;
  response_time_csv: string;
}): SippCapacityEvidence {
  validateSippIdentity(input.sipp_version, input.sipp_binary_sha256);
  const stats = parseSippCapacityStatistics(input.statistics_csv);
  const output = `${input.process.stdout}\n${input.process.stderr}`;
  const watchdogMajor = countWatchdog(output, 'major');
  const watchdogMinor = countWatchdog(output, 'minor');
  const responseTimes = parseSippResponseTimes(input.response_time_csv);
  const sipRouteP99 = quantile(responseTimes.sip_route, 0.99);
  const postDialP95 = quantile(responseTimes.sip_post_dial, 0.95);
  const postDialP99 = quantile(responseTimes.sip_post_dial, 0.99);
  const rateConformant = Math.abs(stats.call_rate - input.target_cps) <=
    input.target_cps * input.rate_tolerance_ratio + Number.EPSILON;
  const reasons: string[] = [];
  const qualityReasons: string[] = [];
  const timerEvidenceInvalid = responseTimes.sip_route.length !== input.expected_calls ||
    responseTimes.sip_post_dial.length !== input.expected_calls;
  const generatorInvalid = watchdogMajor > 0 ||
    watchdogMinor > input.maximum_minor_watchdog_count ||
    (!rateConformant && stats.failed_calls === 0) || timerEvidenceInvalid;
  if (watchdogMajor > 0) reasons.push(`SIPp watchdog major triggered ${watchdogMajor} times`);
  if (watchdogMinor > input.maximum_minor_watchdog_count) {
    reasons.push(`SIPp watchdog minor count ${watchdogMinor} exceeds ${input.maximum_minor_watchdog_count}`);
  }
  if (!rateConformant) reasons.push(`SIPp actual CPS ${stats.call_rate} is outside target tolerance`);
  if (stats.successful_calls !== input.expected_calls) {
    reasons.push(`SIPp successful calls ${stats.successful_calls} do not equal ${input.expected_calls}`);
  }
  if (stats.failed_calls !== 0) reasons.push(`SIPp recorded ${stats.failed_calls} failed calls`);
  if (input.process.timed_out) reasons.push('SIPp process timed out');
  if (input.process.code !== 0) reasons.push(`SIPp process exited with ${input.process.code}`);
  if (responseTimes.sip_route.length !== input.expected_calls) {
    qualityReasons.push(
      `SIPp sip_route sample count ${responseTimes.sip_route.length} does not equal ${input.expected_calls}`
    );
  }
  if (responseTimes.sip_post_dial.length !== input.expected_calls) {
    qualityReasons.push(
      `SIPp sip_post_dial sample count ${responseTimes.sip_post_dial.length} does not equal ${input.expected_calls}`
    );
  }
  if (sipRouteP99 > input.maximum_sip_route_p99_ms) {
    qualityReasons.push(`SIPp route P99 ${sipRouteP99}ms exceeds ${input.maximum_sip_route_p99_ms}ms`);
  }
  if (postDialP95 > input.maximum_post_dial_p95_ms) {
    qualityReasons.push(`SIPp post-dial P95 ${postDialP95}ms exceeds ${input.maximum_post_dial_p95_ms}ms`);
  }
  if (postDialP99 > input.maximum_post_dial_p99_ms) {
    qualityReasons.push(`SIPp post-dial P99 ${postDialP99}ms exceeds ${input.maximum_post_dial_p99_ms}ms`);
  }
  reasons.push(...qualityReasons);

  const passed = input.process.code === 0 && !input.process.timed_out &&
    stats.successful_calls === input.expected_calls && stats.failed_calls === 0 && rateConformant &&
    watchdogMajor === 0 && watchdogMinor <= input.maximum_minor_watchdog_count &&
    qualityReasons.length === 0;
  return {
    protocol: 'sip',
    evidence_level: 'controlled',
    status: passed ? 'controlled_pass' : generatorInvalid ? 'invalid_generator_capacity' : 'controlled_failed',
    failure_class: passed ? 'none' : generatorInvalid ? 'generator' : 'sut_or_protocol',
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    expected_calls: input.expected_calls,
    successful_calls: stats.successful_calls,
    failed_calls: stats.failed_calls,
    retransmissions: stats.retransmissions,
    target_cps: input.target_cps,
    actual_cps: stats.call_rate,
    rate_conformant: rateConformant,
    elapsed_seconds: stats.elapsed_seconds,
    watchdog_major_count: watchdogMajor,
    watchdog_minor_count: watchdogMinor,
    process_exit_code: input.process.code,
    process_timed_out: input.process.timed_out,
    reasons,
    sip_route_sample_count: responseTimes.sip_route.length,
    sip_route_p99_ms: sipRouteP99,
    post_dial_sample_count: responseTimes.sip_post_dial.length,
    post_dial_p95_ms: postDialP95,
    post_dial_p99_ms: postDialP99,
    quality_gate_passed: qualityReasons.length === 0,
    quality_reasons: qualityReasons,
    sipp_version: input.sipp_version,
    sipp_binary_sha256: input.sipp_binary_sha256
  };
}

async function executeSippCapacityPlan(plan: SippCapacityProcessPlan): Promise<{
  process: SippProcessResult;
  statistics_csv: string;
  response_time_csv: string;
}> {
  mkdirSync(dirname(plan.statistics_path), { recursive: true });
  const actualDigest = createHash('sha256').update(readFileSync(plan.executable)).digest('hex');
  if (actualDigest !== plan.sipp_binary_sha256) throw new Error('SIPp binary SHA-256 mismatch');
  rmSync(plan.statistics_path, { force: true });
  rmSync(plan.error_path, { force: true });
  for (const name of responseTimeFiles(plan)) rmSync(join(plan.result_directory, name), { force: true });
  const process = await execute(plan.executable, plan.args, plan.timeout_ms, plan.result_directory);
  if (!existsSync(plan.statistics_path)) throw new Error('SIPp statistics file was not produced');
  const responseTimeFilesAfterRun = responseTimeFiles(plan);
  if (responseTimeFilesAfterRun.length !== 1) {
    throw new Error(`SIPp produced ${responseTimeFilesAfterRun.length} response-time files instead of one`);
  }
  return {
    process,
    statistics_csv: readFileSync(plan.statistics_path, 'utf8'),
    response_time_csv: readFileSync(join(plan.result_directory, responseTimeFilesAfterRun[0]), 'utf8')
  };
}

function execute(executable: string, args: string[], timeoutMs: number, cwd: string): Promise<SippProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current: string, chunk: Buffer) => `${current}${chunk.toString('utf8')}`.slice(-2 * 1024 * 1024);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      stderr = append(stderr, Buffer.from(error.message));
      resolve({ code: -1, stdout, stderr, timed_out: timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timed_out: timedOut });
    });
  });
}

function responseTimeFiles(plan: SippCapacityProcessPlan): string[] {
  return readdirSync(plan.result_directory)
    .filter((name) => name.startsWith(plan.response_time_filename_prefix) && name.endsWith('_rtt.csv'));
}

function parseSippCapacityStatistics(csv: string): {
  successful_calls: number;
  failed_calls: number;
  retransmissions: number;
  call_rate: number;
  elapsed_seconds: number;
} {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('SIPp capacity statistics are missing rows');
  const headers = lines[0].split(';');
  const values = lines.at(-1)!.split(';');
  const number = (name: string, integer: boolean): number => {
    const index = headers.indexOf(name);
    if (index < 0) throw new Error(`SIPp capacity statistics are missing ${name}`);
    const value = Number(values[index]);
    if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
      throw new Error(`SIPp capacity statistics contain invalid ${name}`);
    }
    return value;
  };
  return {
    successful_calls: number('SuccessfulCall(C)', true),
    failed_calls: number('FailedCall(C)', true),
    retransmissions: number('Retransmissions(C)', true),
    call_rate: number('CallRate(C)', false),
    elapsed_seconds: number('ElapsedTime(C)', false)
  };
}

function parseSippResponseTimes(csv: string): { sip_route: number[]; sip_post_dial: number[] } {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error('SIPp response-time evidence is missing its header');
  const headers = lines[0].split(';');
  const responseTimeIndex = headers.indexOf('response_time_ms');
  const timerIndex = headers.indexOf('rtd_no');
  if (responseTimeIndex < 0 || timerIndex < 0) {
    throw new Error('SIPp response-time evidence has an invalid header');
  }
  const result = { sip_route: [] as number[], sip_post_dial: [] as number[] };
  for (const line of lines.slice(1)) {
    const values = line.split(';');
    const timer = values[timerIndex] as keyof typeof result;
    if (!(timer in result)) continue;
    const responseTime = Number(values[responseTimeIndex]);
    if (!Number.isFinite(responseTime) || responseTime < 0) {
      throw new Error(`SIPp response-time evidence contains invalid ${timer}`);
    }
    result[timer].push(responseTime);
  }
  return result;
}

function quantile(samples: number[], value: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)];
}

function countWatchdog(output: string, severity: 'major' | 'minor'): number {
  const matches = output.match(new RegExp(`(?:watchdog[^\\n]*${severity}|${severity}[^\\n]*watchdog)`, 'gi'));
  return matches?.length ?? 0;
}

function validatePlanInput(input: SippCapacityPlanInput): void {
  if (!isAbsolute(input.sipp_binary) || !isAbsolute(input.scenario_path) || !isAbsolute(input.result_directory)) {
    throw new Error('SIPp binary, scenario and result directory must be absolute paths');
  }
  validateSippIdentity(input.sipp_version, input.sipp_binary_sha256);
  if (!safeHost(input.target_host) || !safeHost(input.local_ip)) throw new Error('SIPp host or local IP is invalid');
  if (!safePort(input.target_port) || !safePort(input.local_port)) throw new Error('SIPp port is invalid');
  if (!/^\d{2,32}$/.test(input.service)) throw new Error('SIPp service is invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(input.run_id) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(input.worker_id)) {
    throw new Error('SIPp run or worker ID is invalid');
  }
  if (!Number.isInteger(input.ordinal_start) || !Number.isInteger(input.ordinal_end_exclusive) ||
      input.ordinal_start < 0 || input.ordinal_end_exclusive <= input.ordinal_start) {
    throw new Error('SIPp shard range is invalid');
  }
  const expectedShard = `interaction/sip_voice/${input.ordinal_start}-${input.ordinal_end_exclusive}`;
  if (input.shard_id !== expectedShard) throw new Error(`SIPp shard ID must be ${expectedShard}`);
  if (input.total_calls !== input.ordinal_end_exclusive - input.ordinal_start) {
    throw new Error('SIPp total calls must equal the shard range');
  }
  if (!/^[1-9][0-9]{0,18}$/.test(input.lease_epoch)) {
    throw new Error('invalid SIPp lease_epoch');
  }
  for (const [field, value] of Object.entries({
    total_calls: input.total_calls,
    target_cps: input.target_cps,
    max_concurrent_calls: input.max_concurrent_calls,
    timeout_seconds: input.timeout_seconds
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid SIPp ${field}`);
  }
  if (!Number.isInteger(input.total_calls) || !Number.isInteger(input.max_concurrent_calls) ||
      !Number.isInteger(input.timeout_seconds)) {
    throw new Error('SIPp count and timeout values must be integers');
  }
  if (input.max_concurrent_calls > input.total_calls) throw new Error('SIPp concurrency exceeds total calls');
  const tolerance = input.rate_tolerance_ratio ?? 0.01;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.2) throw new Error('SIPp rate tolerance is invalid');
  const minor = input.maximum_minor_watchdog_count ?? 0;
  if (!Number.isInteger(minor) || minor < 0) throw new Error('SIPp minor watchdog limit is invalid');
  for (const [field, value] of Object.entries({
    maximum_sip_route_p99_ms: input.maximum_sip_route_p99_ms,
    maximum_post_dial_p95_ms: input.maximum_post_dial_p95_ms,
    maximum_post_dial_p99_ms: input.maximum_post_dial_p99_ms
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`SIPp ${field} is invalid`);
  }
  if (input.maximum_post_dial_p95_ms > input.maximum_post_dial_p99_ms) {
    throw new Error('SIPp post-dial P95 limit exceeds P99 limit');
  }
}

function validateSippIdentity(version: string, sha256: string): void {
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('SIPp version or binary SHA-256 is invalid');
  }
}

function safeHost(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}[A-Za-z0-9]$/.test(value) && !value.includes('..');
}

function safePort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}
