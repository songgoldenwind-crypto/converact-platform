import { resolveConveractEnv } from '../../src/config/converact-env.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALPINE_ACCEPTANCE_IMAGE,
  parseSippStatistics,
  SIPP_BINARY_SHA256,
  type SippStatistics
} from '../converact-rustpbx-sipp-acceptance.js';
import {
  buildSippRtpCheckDockerPlan,
  evaluateSippRtpCheckEvidence,
  parseSippRtpCheckDebug,
  renderSippRtpCheckScenarios,
  type SippRtpCheckDockerPlan,
  type SippRtpCheckEvidence
} from './sipp-rtp-check.js';
import {
  evaluateSippRtpThroughputEvidence,
  parseLinuxUdpSnmp,
  type LinuxUdpCounters,
  type SippRtpThroughputEvidence
} from './sipp-rtp-throughput.js';

const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;

export interface SippRtpCheckCampaignOptions {
  docker: string;
  network: string;
  target_ip: string;
  uac_ip: string;
  uas_ip: string;
  sipp_binary: string;
  sipp_sha256: string;
  result_dir: string;
  container_image: string;
  run_id: string;
  service: string;
  calls: number;
  calls_per_second: number;
  media_duration_ms: number;
  timeout_seconds: number;
  packets_per_second: number;
  maximum_invalid_or_missing_ratio: number;
  maximum_startup_missing_packets_per_call: number;
  minimum_packet_coverage_ratio: number;
  rtp_port_min: number;
  rtp_tasks_per_thread: number;
  evidence_mode?: 'strict' | 'throughput';
  sut_container?: string;
}

export interface SippRtpCheckCampaignCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export interface SippRtpCheckCampaignDependencies {
  command?: (
    executable: string,
    args: string[],
    timeoutMs: number
  ) => Promise<SippRtpCheckCampaignCommandResult>;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface SippRtpCheckCampaignReport {
  schema_version: '1.0.0';
  suite: 'Converact Fabric RustPBX SIPp PCMU RTP check';
  status: 'passed' | 'failed';
  error_code: string;
  generated_at: string;
  duration_ms: number;
  target: {
    docker_network: string;
    sip_target: string;
    uac_ip: string;
    uas_ip: string;
    service: string;
  };
  load: {
    calls: number;
    calls_per_second: number;
    media_duration_ms: number;
    packets_per_second: number;
    expected_media_packets: number;
    maximum_startup_missing_packets_per_call: number;
    evidence_mode: 'strict' | 'throughput';
    rtp_port_min: number;
    rtp_port_max: number;
  };
  tools: {
    sipp_version: '3.7.7';
    sipp_sha256: string;
    container_image: string;
    uac_scenario_sha256: string;
    uas_scenario_sha256: string;
  };
  commands: {
    uac_exit_code: number | null;
    uac_timed_out: boolean;
    uas_exit_code: number | null;
    uas_wait_timed_out: boolean;
  };
  sip: {
    uac?: SippStatistics;
    uas?: SippStatistics;
  };
  media?: SippRtpCheckEvidence | SippRtpThroughputEvidence;
}

export async function runSippRtpCheckCampaign(
  options: SippRtpCheckCampaignOptions,
  dependencies: SippRtpCheckCampaignDependencies = {}
): Promise<SippRtpCheckCampaignReport> {
  const command = dependencies.command || runCommand;
  const now = dependencies.now || (() => new Date());
  const sleep = dependencies.sleep ||
    ((milliseconds: number) =>
      new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const generatedAt = validDate(now()).toISOString();
  const startedAt = validDate(now()).getTime();
  const evidenceMode = options.evidence_mode || 'strict';
  validateCampaignOptions(options);
  assertSippBinary(options.sipp_binary, options.sipp_sha256);
  mkdirSync(options.result_dir, { recursive: true });

  const scenarios = renderSippRtpCheckScenarios({
    media_duration_ms: options.media_duration_ms
  });
  const plan = buildSippRtpCheckDockerPlan({
    network: options.network,
    target_ip: options.target_ip,
    uac_ip: options.uac_ip,
    uas_ip: options.uas_ip,
    sipp_binary: options.sipp_binary,
    result_dir: options.result_dir,
    container_image: options.container_image,
    run_id: options.run_id,
    service: options.service,
    calls: options.calls,
    calls_per_second: options.calls_per_second,
    timeout_seconds: options.timeout_seconds,
    rtp_port_min: options.rtp_port_min,
    rtp_tasks_per_thread: options.rtp_tasks_per_thread,
    evidence_mode: evidenceMode
  });
  prepareArtifacts(options.result_dir, plan, scenarios);
  await requireCommand(
    command,
    options.docker,
    ['network', 'inspect', options.network],
    10_000,
    'docker_network_unavailable'
  );
  await requireCommand(
    command,
    options.docker,
    ['image', 'inspect', options.container_image],
    10_000,
    'container_image_unavailable'
  );

  let uacResult: SippRtpCheckCampaignCommandResult | null = null;
  let uasExitCode: number | null = null;
  let uasWaitTimedOut = false;
  let runtimeError = '';
  let udpBefore: LinuxUdpCounters | null = null;
  let udpAfter: LinuxUdpCounters | null = null;
  try {
    if (evidenceMode === 'throughput') {
      udpBefore = await readUdpCounters(
        command,
        options.docker,
        options.sut_container || 'converact-rustpbx-baseline-rustpbx-1'
      );
    }
    const uasStart = await command(options.docker, plan.uas_args, 15_000);
    if (uasStart.code !== 0 || uasStart.timed_out) {
      runtimeError = 'uas_start_failed';
    } else {
      await sleep(300);
      const running = await command(options.docker, [
        'inspect',
        '--format={{.State.Running}}',
        plan.uas_container
      ], 10_000);
      if (running.code !== 0 || running.stdout.trim() !== 'true') {
        runtimeError = 'uas_not_running';
      }
    }

    if (!runtimeError) {
      uacResult = await command(
        options.docker,
        plan.uac_args,
        (options.timeout_seconds + 5) * 1_000
      );
      if (!uacResult.timed_out) {
        const waited = await command(
          options.docker,
          ['wait', plan.uas_container],
          (options.timeout_seconds + 5) * 1_000
        );
        uasWaitTimedOut = waited.timed_out;
        if (waited.code === 0 && !waited.timed_out) {
          const parsed = Number(waited.stdout.trim());
          uasExitCode = Number.isInteger(parsed) ? parsed : null;
          if (uasExitCode === null) runtimeError = 'uas_exit_invalid';
          if (!runtimeError && evidenceMode === 'throughput') {
            udpAfter = await readUdpCounters(
              command,
              options.docker,
              options.sut_container ||
              'converact-rustpbx-baseline-rustpbx-1'
            );
          }
        } else {
          runtimeError = 'uas_wait_failed';
        }
      } else {
        runtimeError = 'uac_timeout';
      }
    }
  } catch {
    runtimeError = 'campaign_runtime_error';
  } finally {
    await cleanupContainer(command, options.docker, plan.uac_container);
    await cleanupContainer(command, options.docker, plan.uas_container);
  }

  const report = buildReport({
    options,
    plan,
    scenarios,
    generated_at: generatedAt,
    duration_ms: Math.max(0, validDate(now()).getTime() - startedAt),
    uac_result: uacResult,
    uas_exit_code: uasExitCode,
    uas_wait_timed_out: uasWaitTimedOut,
    runtime_error: runtimeError,
    udp_before: udpBefore,
    udp_after: udpAfter
  });
  writeFileSync(
    join(options.result_dir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 }
  );
  return report;
}

export function sippRtpCheckCampaignOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SippRtpCheckCampaignOptions {
  const calls = integer(env.CONVERACT_FABRIC_RTP_CHECK_CALLS || '1', 1, 20_000, 'calls');
  const callsPerSecond = integer(
    env.CONVERACT_FABRIC_RTP_CHECK_CPS || String(Math.min(calls, 10)),
    1,
    100_000,
    'call rate'
  );
  const mediaDurationMs = integer(
    env.CONVERACT_FABRIC_RTP_CHECK_MEDIA_DURATION_MS || '5000',
    1_000,
    300_000,
    'media duration'
  );
  if (mediaDurationMs % 1_000 !== 0) {
    throw new Error('SIPp RTP-check media duration must use whole seconds');
  }
  const defaultTimeout =
    Math.ceil(calls / callsPerSecond) + mediaDurationMs / 1_000 + 20;
  const resultDirectory = resolve(
    env.CONVERACT_FABRIC_RTP_CHECK_RESULT_DIR ||
    `.tmp/converact-sipp-rtp-${Date.now()}`
  );
  return {
    docker: String(env.CONVERACT_FABRIC_DOCKER_COMMAND || 'docker').trim(),
    network: required(env, 'CONVERACT_FABRIC_RTP_CHECK_NETWORK'),
    target_ip: String(
      env.CONVERACT_FABRIC_RTP_CHECK_TARGET_IP || '172.30.44.9'
    ).trim(),
    uac_ip: String(env.CONVERACT_FABRIC_RTP_CHECK_UAC_IP || '172.30.44.20').trim(),
    uas_ip: String(env.CONVERACT_FABRIC_RTP_CHECK_UAS_IP || '172.30.44.22').trim(),
    sipp_binary: resolve(required(env, 'CONVERACT_FABRIC_SIPP_BINARY')),
    sipp_sha256: SIPP_BINARY_SHA256,
    result_dir: resultDirectory,
    container_image: ALPINE_ACCEPTANCE_IMAGE,
    run_id: String(
      env.CONVERACT_FABRIC_RTP_CHECK_RUN_ID || `pcmu-${calls}-${Date.now()}`
    ).trim(),
    service: String(
      env.CONVERACT_FABRIC_RTP_CHECK_SERVICE || '18005550200'
    ).trim(),
    calls,
    calls_per_second: callsPerSecond,
    media_duration_ms: mediaDurationMs,
    timeout_seconds: integer(
      env.CONVERACT_FABRIC_RTP_CHECK_TIMEOUT_SECONDS || String(defaultTimeout),
      1,
      3_600,
      'timeout'
    ),
    packets_per_second: 50,
    maximum_invalid_or_missing_ratio: ratio(
      env.CONVERACT_FABRIC_RTP_CHECK_MAXIMUM_ERROR_RATIO || '0.001',
      'maximum error ratio'
    ),
    maximum_startup_missing_packets_per_call: integer(
      env.CONVERACT_FABRIC_RTP_CHECK_MAXIMUM_STARTUP_MISSING_PACKETS_PER_CALL || '3',
      0,
      1_000,
      'maximum startup missing packets per call'
    ),
    minimum_packet_coverage_ratio: ratio(
      env.CONVERACT_FABRIC_RTP_CHECK_MINIMUM_COVERAGE_RATIO || '0.95',
      'minimum packet coverage'
    ),
    rtp_port_min: integer(
      env.CONVERACT_FABRIC_RTP_CHECK_RTP_PORT_MIN || '6000',
      1_024,
      65_534,
      'RTP port minimum'
    ),
    rtp_tasks_per_thread: integer(
      env.CONVERACT_FABRIC_RTP_CHECK_TASKS_PER_THREAD || '64',
      1,
      4_096,
      'RTP tasks per thread'
    ),
    evidence_mode: evidenceMode(
      env.CONVERACT_FABRIC_RTP_CHECK_EVIDENCE_MODE || 'strict'
    ),
    sut_container: containerName(
      env.CONVERACT_FABRIC_RTP_CHECK_SUT_CONTAINER ||
      'converact-rustpbx-baseline-rustpbx-1'
    )
  };
}

function buildReport(input: {
  options: SippRtpCheckCampaignOptions;
  plan: SippRtpCheckDockerPlan;
  scenarios: { uac: string; uas: string };
  generated_at: string;
  duration_ms: number;
  uac_result: SippRtpCheckCampaignCommandResult | null;
  uas_exit_code: number | null;
  uas_wait_timed_out: boolean;
  runtime_error: string;
  udp_before: LinuxUdpCounters | null;
  udp_after: LinuxUdpCounters | null;
}): SippRtpCheckCampaignReport {
  const { options, plan } = input;
  const uac = readStatistics(
    join(options.result_dir, plan.artifacts.uac_statistics)
  );
  const uas = readStatistics(
    join(options.result_dir, plan.artifacts.uas_statistics)
  );
  const media = input.uac_result && input.uac_result.code >= 0 && uac && uas
    ? options.evidence_mode === 'throughput'
      ? readThroughputEvidence(
        options,
        input.uac_result.code,
        input.uas_exit_code,
        uac,
        uas,
        input.udp_before,
        input.udp_after
      )
      : readMediaEvidence(
        options,
        plan,
        input.uac_result.code,
        input.uas_exit_code,
        uac,
        uas
      )
    : undefined;
  const infrastructurePassed =
    !input.runtime_error &&
    input.uac_result !== null &&
    !input.uac_result.timed_out &&
    input.uas_exit_code === 0;
  const passed = infrastructurePassed && media?.status === 'controlled_pass';
  const errorCode = passed
    ? 'none'
    : input.runtime_error ||
      media?.status ||
      (input.uac_result?.code !== 0 ? 'uac_failed' : '') ||
      (input.uas_exit_code !== 0 ? 'uas_failed' : '') ||
      'media_evidence_missing';

  return {
    schema_version: '1.0.0',
    suite: 'Converact Fabric RustPBX SIPp PCMU RTP check',
    status: passed ? 'passed' : 'failed',
    error_code: errorCode,
    generated_at: input.generated_at,
    duration_ms: input.duration_ms,
    target: {
      docker_network: options.network,
      sip_target: `${options.target_ip}:5060`,
      uac_ip: options.uac_ip,
      uas_ip: options.uas_ip,
      service: options.service
    },
    load: {
      calls: options.calls,
      calls_per_second: options.calls_per_second,
      media_duration_ms: options.media_duration_ms,
      packets_per_second: options.packets_per_second,
      expected_media_packets:
        options.calls *
        (options.media_duration_ms / 1_000) *
        options.packets_per_second,
      maximum_startup_missing_packets_per_call:
        options.maximum_startup_missing_packets_per_call,
      evidence_mode: options.evidence_mode || 'strict',
      rtp_port_min: plan.rtp_port_range.minimum,
      rtp_port_max: plan.rtp_port_range.maximum
    },
    tools: {
      sipp_version: '3.7.7',
      sipp_sha256: options.sipp_sha256,
      container_image: options.container_image,
      uac_scenario_sha256: sha256(input.scenarios.uac),
      uas_scenario_sha256: sha256(input.scenarios.uas)
    },
    commands: {
      uac_exit_code: input.uac_result?.code ?? null,
      uac_timed_out: input.uac_result?.timed_out || false,
      uas_exit_code: input.uas_exit_code,
      uas_wait_timed_out: input.uas_wait_timed_out
    },
    sip: {
      ...(uac ? { uac } : {}),
      ...(uas ? { uas } : {})
    },
    ...(media ? { media } : {})
  };
}

function readThroughputEvidence(
  options: SippRtpCheckCampaignOptions,
  uacExitCode: number,
  uasExitCode: number | null,
  uac: SippStatistics,
  uas: SippStatistics,
  before: LinuxUdpCounters | null,
  after: LinuxUdpCounters | null
): SippRtpThroughputEvidence | undefined {
  if (uasExitCode === null || !before || !after) return undefined;
  try {
    return evaluateSippRtpThroughputEvidence({
      expected_calls: options.calls,
      duration_seconds: options.media_duration_ms / 1_000,
      packets_per_second: options.packets_per_second,
      minimum_packet_coverage_ratio: options.minimum_packet_coverage_ratio,
      uac_exit_code: uacExitCode,
      uas_exit_code: uasExitCode,
      uac_successful_calls: uac.successful_calls,
      uac_failed_calls: uac.failed_calls,
      uac_retransmissions: uac.retransmissions,
      uas_successful_calls: uas.successful_calls,
      uas_failed_calls: uas.failed_calls,
      uas_retransmissions: uas.retransmissions,
      before,
      after
    });
  } catch {
    return undefined;
  }
}

function readMediaEvidence(
  options: SippRtpCheckCampaignOptions,
  plan: SippRtpCheckDockerPlan,
  uacExitCode: number,
  uasExitCode: number | null,
  uac: SippStatistics,
  uas: SippStatistics
): SippRtpCheckEvidence | undefined {
  try {
    if (uasExitCode === null) return undefined;
    const debug = {
      uac: parseSippRtpCheckDebug(readFileSync(
        join(options.result_dir, plan.artifacts.uac_rtp_debug),
        'utf8'
      )),
      uas: parseSippRtpCheckDebug(readFileSync(
        join(options.result_dir, plan.artifacts.uas_rtp_debug),
        'utf8'
      ))
    };
    return evaluateSippRtpCheckEvidence({
      expected_calls: options.calls,
      duration_seconds: options.media_duration_ms / 1_000,
      packets_per_second: options.packets_per_second,
      maximum_invalid_or_missing_ratio:
        options.maximum_invalid_or_missing_ratio,
      maximum_startup_missing_packets_per_call:
        options.maximum_startup_missing_packets_per_call,
      minimum_packet_coverage_ratio: options.minimum_packet_coverage_ratio,
      uac_exit_code: uacExitCode,
      uas_exit_code: uasExitCode,
      uac_successful_calls: uac.successful_calls,
      uac_failed_calls: uac.failed_calls,
      uac_retransmissions: uac.retransmissions,
      uas_successful_calls: uas.successful_calls,
      uas_failed_calls: uas.failed_calls,
      uas_retransmissions: uas.retransmissions,
      debug
    });
  } catch {
    return undefined;
  }
}

async function readUdpCounters(
  command: NonNullable<SippRtpCheckCampaignDependencies['command']>,
  docker: string,
  container: string
): Promise<LinuxUdpCounters> {
  const result = await command(
    docker,
    ['exec', container, 'cat', '/proc/net/snmp'],
    10_000
  );
  if (result.code !== 0 || result.timed_out) {
    throw new Error('RTP throughput UDP counters are unavailable');
  }
  return parseLinuxUdpSnmp(result.stdout);
}

function prepareArtifacts(
  resultDirectory: string,
  plan: SippRtpCheckDockerPlan,
  scenarios: { uac: string; uas: string }
): void {
  mkdirSync(join(resultDirectory, 'uac'), { recursive: true });
  mkdirSync(join(resultDirectory, 'uas'), { recursive: true });
  for (const file of [
    ...Object.values(plan.artifacts),
    'report.json'
  ]) {
    rmSync(join(resultDirectory, file), { force: true });
  }
  writeFileSync(
    join(resultDirectory, plan.artifacts.uac_scenario),
    scenarios.uac,
    { mode: 0o600 }
  );
  writeFileSync(
    join(resultDirectory, plan.artifacts.uas_scenario),
    scenarios.uas,
    { mode: 0o600 }
  );
}

function readStatistics(path: string): SippStatistics | undefined {
  try {
    return parseSippStatistics(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function validateCampaignOptions(options: SippRtpCheckCampaignOptions): void {
  if (!/^[a-f0-9]{64}$/.test(options.sipp_sha256)) {
    throw new Error('SIPp RTP-check binary checksum is invalid');
  }
  if (options.media_duration_ms % 1_000 !== 0) {
    throw new Error('SIPp RTP-check media duration must use whole seconds');
  }
  ratio(String(options.maximum_invalid_or_missing_ratio), 'maximum error ratio');
  ratio(String(options.minimum_packet_coverage_ratio), 'minimum packet coverage');
  evidenceMode(options.evidence_mode || 'strict');
  containerName(
    options.sut_container || 'converact-rustpbx-baseline-rustpbx-1'
  );
}

function assertSippBinary(path: string, expected: string): void {
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== expected) {
    throw new Error('SIPp RTP-check binary checksum mismatch');
  }
}

async function requireCommand(
  command: NonNullable<SippRtpCheckCampaignDependencies['command']>,
  executable: string,
  args: string[],
  timeoutMs: number,
  errorCode: string
): Promise<void> {
  const result = await command(executable, args, timeoutMs);
  if (result.code !== 0 || result.timed_out) throw new Error(errorCode);
}

async function cleanupContainer(
  command: NonNullable<SippRtpCheckCampaignDependencies['command']>,
  docker: string,
  container: string
): Promise<void> {
  await command(docker, ['rm', '-f', container], 10_000).catch(() => undefined);
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<SippRtpCheckCampaignCommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const value = target === 'stdout' ? stdout : stderr;
      const next = `${value}${chunk.toString('utf8')}`.slice(
        -MAX_COMMAND_OUTPUT
      );
      if (target === 'stdout') stdout = next;
      else stderr = next;
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolveCommand({ code: -1, stdout, stderr, timed_out: timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveCommand({
        code: code ?? -1,
        stdout,
        stderr,
        timed_out: timedOut
      });
    });
  });
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(resolveConveractEnv(env, name) || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function evidenceMode(value: string): 'strict' | 'throughput' {
  const mode = String(value || '').trim().toLowerCase();
  if (mode !== 'strict' && mode !== 'throughput') {
    throw new Error('SIPp RTP-check evidence mode is invalid');
  }
  return mode;
}

function containerName(value: string): string {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/.test(name)) {
    throw new Error('SIPp RTP-check SUT container name is invalid');
  }
  return name;
}

function integer(
  raw: string,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`SIPp RTP-check ${label} is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`SIPp RTP-check ${label} is invalid`);
  }
  return value;
}

function ratio(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`SIPp RTP-check ${label} is invalid`);
  }
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('SIPp RTP-check clock is invalid');
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runSippRtpCheckCampaign(sippRtpCheckCampaignOptionsFromEnv())
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status !== 'passed') process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error
          ? error.message
          : 'SIPp RTP-check campaign failed'}\n`
      );
      process.exitCode = 1;
    });
}
