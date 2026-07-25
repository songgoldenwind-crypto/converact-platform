#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  runSippRtpCheckCampaign,
  sippRtpCheckCampaignOptionsFromEnv,
  type SippRtpCheckCampaignOptions,
  type SippRtpCheckCampaignReport
} from './sipp-rtp-campaign.js';
import {
  parseDockerStatsSample,
  type DockerStatsSample
} from './tinode-staircase.js';

const execFile = promisify(execFileCallback);

export type SippRtpResourceRole =
  | 'rustpbx'
  | 'kamailio'
  | 'router'
  | 'postgres'
  | 'uac'
  | 'uas';

export interface SippRtpResourceSample {
  elapsed_ms: number;
  containers: Partial<Record<SippRtpResourceRole, DockerStatsSample>>;
  errors: string[];
}

export interface SippRtpResourceSummary {
  containers: Partial<Record<SippRtpResourceRole, {
    sample_count: number;
    cpu_max_percent: number;
    cpu_average_percent: number;
    memory_max_bytes: number;
    pids_max: number;
    network_rx_delta_bytes: number;
    network_tx_delta_bytes: number;
  }>>;
  missing_roles: SippRtpResourceRole[];
  sampling_error_count: number;
}

export interface SippRtpStaircaseConfig {
  output_dir: string;
  run_id: string;
  points: number[];
  maximum_calls_per_second: number;
  sample_interval_ms: number;
  settle_ms: number;
  campaign: SippRtpCheckCampaignOptions;
  containers: Record<
    Exclude<SippRtpResourceRole, 'uac' | 'uas'>,
    string
  >;
}

export interface SippRtpStaircasePointEvidence {
  calls: number;
  calls_per_second: number;
  status: 'controlled_pass' | 'controlled_failed';
  error_code: string;
  campaign_report_path: string;
  campaign_report_sha256: string;
  campaign: SippRtpCheckCampaignReport;
  resources: SippRtpResourceSummary;
  resource_samples: SippRtpResourceSample[];
}

export interface SippRtpStaircaseEvidence {
  schema_version: '1.0.0';
  suite: 'iveKit RustPBX PCMU RTP staircase';
  status: 'controlled_pass' | 'controlled_failed';
  error_code: string;
  capacity_claim: 'none';
  observation_scope: 'generator_and_sut_on_same_host';
  started_at: string;
  completed_at: string;
  points_requested: number[];
  highest_controlled_pass_calls: number;
  stopped_early: boolean;
  points: SippRtpStaircasePointEvidence[];
}

interface ContainerTarget {
  role: SippRtpResourceRole;
  name: string;
  required_while_running: boolean;
}

export function normalizeSippRtpStaircasePoints(raw: string): number[] {
  const values = raw.split(',').map((value) => value.trim());
  if (values.length === 0 || values.some((value) => !/^\d+$/.test(value))) {
    throw new Error('SIPp RTP staircase point list is invalid');
  }
  const points = [...new Set(values.map(Number))].sort((left, right) => left - right);
  if (points.length === 0 ||
      points.some((point) =>
        !Number.isSafeInteger(point) || point < 1 || point > 20_000)) {
    throw new Error('SIPp RTP staircase point must be between 1 and 20000');
  }
  return points;
}

export function summarizeSippRtpResourceSamples(
  samples: SippRtpResourceSample[],
  requiredRoles: SippRtpResourceRole[]
): SippRtpResourceSummary {
  const containers: SippRtpResourceSummary['containers'] = {};
  const roles: SippRtpResourceRole[] = [
    'rustpbx',
    'kamailio',
    'router',
    'postgres',
    'uac',
    'uas'
  ];
  for (const role of roles) {
    const values = samples
      .map((sample) => sample.containers[role])
      .filter((value): value is DockerStatsSample => value !== undefined);
    if (values.length === 0) continue;
    containers[role] = {
      sample_count: values.length,
      cpu_max_percent: Math.max(...values.map((value) => value.cpu_percent)),
      cpu_average_percent: round(
        values.reduce((total, value) => total + value.cpu_percent, 0) /
        values.length
      ),
      memory_max_bytes: Math.max(...values.map((value) => value.memory_bytes)),
      pids_max: Math.max(...values.map((value) => value.pids)),
      network_rx_delta_bytes: Math.max(
        0,
        values.at(-1)!.network_rx_bytes - values[0]!.network_rx_bytes
      ),
      network_tx_delta_bytes: Math.max(
        0,
        values.at(-1)!.network_tx_bytes - values[0]!.network_tx_bytes
      )
    };
  }
  return {
    containers,
    missing_roles: [...new Set(requiredRoles)]
      .filter((role) => containers[role] === undefined),
    sampling_error_count: samples.reduce(
      (total, sample) => total + sample.errors.length,
      0
    )
  };
}

export function sippRtpStaircaseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SippRtpStaircaseConfig {
  const points = normalizeSippRtpStaircasePoints(
    env.IVEKIT_RTP_STAIRCASE_POINTS || '1,5,10,25,50'
  );
  const maximumCallsPerSecond = integer(
    env.IVEKIT_RTP_STAIRCASE_MAXIMUM_CPS || '1250',
    1,
    100_000,
    'maximum call rate'
  );
  const mediaDurationMs = integer(
    env.IVEKIT_RTP_STAIRCASE_MEDIA_DURATION_MS || '10000',
    1_000,
    300_000,
    'media duration'
  );
  if (mediaDurationMs % 1_000 !== 0) {
    throw new Error('SIPp RTP staircase media duration must use whole seconds');
  }
  const outputDirectory = resolve(
    env.IVEKIT_RTP_STAIRCASE_OUTPUT_DIR ||
    `.tmp/ivekit-sipp-rtp-staircase-${Date.now()}`
  );
  const runId = safeId(
    env.IVEKIT_RTP_STAIRCASE_RUN_ID ||
    `pcmu-staircase-${Date.now()}`
  );
  const firstPoint = points[0]!;
  const firstRate = Math.min(firstPoint, maximumCallsPerSecond);
  const campaign = sippRtpCheckCampaignOptionsFromEnv({
    ...env,
    IVEKIT_RTP_CHECK_CALLS: String(firstPoint),
    IVEKIT_RTP_CHECK_CPS: String(firstRate),
    IVEKIT_RTP_CHECK_MEDIA_DURATION_MS: String(mediaDurationMs),
    IVEKIT_RTP_CHECK_RESULT_DIR: join(outputDirectory, 'base'),
    IVEKIT_RTP_CHECK_RUN_ID: `${runId}-base`
  });
  return {
    output_dir: outputDirectory,
    run_id: runId,
    points,
    maximum_calls_per_second: maximumCallsPerSecond,
    sample_interval_ms: integer(
      env.IVEKIT_RTP_STAIRCASE_SAMPLE_INTERVAL_MS || '1000',
      250,
      30_000,
      'sample interval'
    ),
    settle_ms: integer(
      env.IVEKIT_RTP_STAIRCASE_SETTLE_MS || '2000',
      0,
      60_000,
      'settle interval'
    ),
    campaign,
    containers: {
      rustpbx: safeContainer(
        env.IVEKIT_RTP_STAIRCASE_RUSTPBX_CONTAINER ||
        'ivekit-rustpbx-baseline-rustpbx-1'
      ),
      kamailio: safeContainer(
        env.IVEKIT_RTP_STAIRCASE_KAMAILIO_CONTAINER ||
        'ivekit-rustpbx-baseline-kamailio-1'
      ),
      router: safeContainer(
        env.IVEKIT_RTP_STAIRCASE_ROUTER_CONTAINER ||
        'ivekit-rustpbx-baseline-router-1'
      ),
      postgres: safeContainer(
        env.IVEKIT_RTP_STAIRCASE_POSTGRES_CONTAINER ||
        'ivekit-rustpbx-baseline-postgres-1'
      )
    }
  };
}

export async function runSippRtpStaircase(
  config: SippRtpStaircaseConfig
): Promise<SippRtpStaircaseEvidence> {
  validateConfig(config);
  mkdirSync(config.output_dir, { recursive: true });
  const startedAt = new Date();
  const points: SippRtpStaircasePointEvidence[] = [];

  for (const calls of config.points) {
    const callsPerSecond = Math.min(
      calls,
      config.maximum_calls_per_second
    );
    const pointRunId = `${config.run_id}-c${calls}`;
    const resultDirectory = join(config.output_dir, `calls-${calls}`);
    const campaign: SippRtpCheckCampaignOptions = {
      ...config.campaign,
      run_id: pointRunId,
      result_dir: resultDirectory,
      calls,
      calls_per_second: callsPerSecond,
      timeout_seconds:
        Math.ceil(calls / callsPerSecond) +
        config.campaign.media_duration_ms / 1_000 +
        20
    };
    const targets = containerTargets(config, pointRunId);
    const sampler = startResourceSampler(
      targets,
      config.sample_interval_ms
    );
    let campaignReport: SippRtpCheckCampaignReport;
    try {
      campaignReport = await runSippRtpCheckCampaign(campaign);
    } finally {
      await sampler.stop();
    }
    const samples = sampler.samples();
    const resources = summarizeSippRtpResourceSamples(
      samples,
      targets.map((target) => target.role)
    );
    const resourcePassed =
      resources.missing_roles.length === 0;
    const status =
      campaignReport.status === 'passed' && resourcePassed
        ? 'controlled_pass'
        : 'controlled_failed';
    const reportPath = join(resultDirectory, 'report.json');
    const point: SippRtpStaircasePointEvidence = {
      calls,
      calls_per_second: callsPerSecond,
      status,
      error_code: status === 'controlled_pass'
        ? 'none'
        : campaignReport.status !== 'passed'
          ? campaignReport.error_code
          : resources.missing_roles.length > 0
            ? 'resource_samples_missing'
            : 'campaign_failed',
      campaign_report_path: reportPath,
      campaign_report_sha256: sha256(readFileSync(reportPath)),
      campaign: campaignReport,
      resources,
      resource_samples: samples
    };
    points.push(point);
    writeEvidence(config, startedAt, points);
    if (status !== 'controlled_pass') break;
    if (calls !== config.points.at(-1) && config.settle_ms > 0) {
      await delay(config.settle_ms);
    }
  }

  return writeEvidence(config, startedAt, points);
}

function writeEvidence(
  config: SippRtpStaircaseConfig,
  startedAt: Date,
  points: SippRtpStaircasePointEvidence[]
): SippRtpStaircaseEvidence {
  const failed = points.find((point) => point.status !== 'controlled_pass');
  const evidence: SippRtpStaircaseEvidence = {
    schema_version: '1.0.0',
    suite: 'iveKit RustPBX PCMU RTP staircase',
    status: failed ? 'controlled_failed' : 'controlled_pass',
    error_code: failed?.error_code || 'none',
    capacity_claim: 'none',
    observation_scope: 'generator_and_sut_on_same_host',
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    points_requested: [...config.points],
    highest_controlled_pass_calls: Math.max(
      0,
      ...points
        .filter((point) => point.status === 'controlled_pass')
        .map((point) => point.calls)
    ),
    stopped_early: points.length < config.points.length,
    points: structuredClone(points)
  };
  const output = join(config.output_dir, 'staircase-report.json');
  const temporary = `${output}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600
  });
  renameSync(temporary, output);
  return evidence;
}

function startResourceSampler(
  targets: ContainerTarget[],
  intervalMs: number
): {
  stop(): Promise<void>;
  samples(): SippRtpResourceSample[];
} {
  let stopped = false;
  let wake: (() => void) | undefined;
  const samples: SippRtpResourceSample[] = [];
  const startedAt = performance.now();
  const task = (async () => {
    while (!stopped) {
      samples.push(await sampleResources(targets, startedAt));
      if (stopped) break;
      await new Promise<void>((resolveDelay) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolveDelay();
        }, intervalMs);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolveDelay();
        };
      });
    }
  })();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await task;
    },
    samples() {
      return structuredClone(samples);
    }
  };
}

async function sampleResources(
  targets: ContainerTarget[],
  startedAt: number
): Promise<SippRtpResourceSample> {
  const errors: string[] = [];
  const containers: SippRtpResourceSample['containers'] = {};
  try {
    const running = new Set(
      (await docker(['ps', '--format', '{{.Names}}'], 10_000))
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean)
    );
    const selected = targets.filter((target) => running.has(target.name));
    for (const target of targets) {
      if (target.required_while_running && !running.has(target.name)) {
        errors.push(`${target.role}: container is not running`);
      }
    }
    if (selected.length > 0) {
      const output = await docker([
        'stats',
        '--no-stream',
        '--format',
        '{{json .}}',
        ...selected.map((target) => target.name)
      ], 15_000);
      const byName = new Map(
        output.split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const raw = JSON.parse(line) as Record<string, unknown>;
            return [String(raw.Name || ''), raw] as const;
          })
      );
      for (const target of selected) {
        const raw = byName.get(target.name);
        if (!raw) {
          errors.push(`${target.role}: Docker stats row is missing`);
          continue;
        }
        containers[target.role] = parseDockerStatsSample(raw);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    elapsed_ms: round(performance.now() - startedAt),
    containers,
    errors
  };
}

function containerTargets(
  config: SippRtpStaircaseConfig,
  pointRunId: string
): ContainerTarget[] {
  return [
    { role: 'rustpbx', name: config.containers.rustpbx, required_while_running: true },
    { role: 'kamailio', name: config.containers.kamailio, required_while_running: true },
    { role: 'router', name: config.containers.router, required_while_running: true },
    { role: 'postgres', name: config.containers.postgres, required_while_running: true },
    { role: 'uac', name: `ivekit-rtp-uac-${pointRunId}`, required_while_running: false },
    { role: 'uas', name: `ivekit-rtp-uas-${pointRunId}`, required_while_running: false }
  ];
}

function validateConfig(config: SippRtpStaircaseConfig): void {
  if (!resolve(config.output_dir).startsWith('/')) {
    throw new Error('SIPp RTP staircase output directory is invalid');
  }
  safeId(config.run_id);
  normalizeSippRtpStaircasePoints(config.points.join(','));
  integer(String(config.maximum_calls_per_second), 1, 100_000, 'maximum call rate');
  integer(String(config.sample_interval_ms), 250, 30_000, 'sample interval');
  integer(String(config.settle_ms), 0, 60_000, 'settle interval');
  for (const name of Object.values(config.containers)) safeContainer(name);
}

async function docker(args: string[], timeoutMs: number): Promise<string> {
  try {
    const result = await execFile('docker', args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8'
    });
    return String(result.stdout || '');
  } catch (error) {
    const value = error as Error & { stderr?: string; stdout?: string };
    const detail = String(
      value.stderr || value.stdout || value.message || ''
    ).trim();
    throw new Error(`docker failed${detail ? `: ${detail}` : ''}`);
  }
}

function safeId(value: string): string {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,96}$/.test(result)) {
    throw new Error('SIPp RTP staircase run ID is invalid');
  }
  return result;
}

function safeContainer(value: string): string {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/.test(result)) {
    throw new Error('SIPp RTP staircase container name is invalid');
  }
  return result;
}

function integer(
  raw: string,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`SIPp RTP staircase ${label} is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`SIPp RTP staircase ${label} is invalid`);
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runSippRtpStaircase(sippRtpStaircaseConfigFromEnv())
    .then((evidence) => {
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
      process.exitCode = evidence.status === 'controlled_pass' ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    });
}
