import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASELINE_DIRECTORY = join(REPOSITORY_ROOT, 'infra/capacity/rustpbx-baseline');
const BASELINE_RUNNER = join(BASELINE_DIRECTORY, 'run.sh');
const BASELINE_COMPOSE = join(BASELINE_DIRECTORY, 'docker-compose.yml');
const BASELINE_PREPARE = join(BASELINE_DIRECTORY, 'prepare.py');
const SCENARIO = join(
  REPOSITORY_ROOT,
  'services/converact-service/acceptance/sipp/inbound-reject-486-uac.xml'
);

export interface SipKamailioStaircaseConfigInput {
  output_file: string;
  artifact_root: string;
  runtime_root: string;
  points: number[];
  duration_seconds: number;
  sipp_binary: string;
  rustpbx_image: string;
  kamailio_image: string;
  postgres_image: string;
  python_image: string;
  capacity_tools_image: string;
  node_command: string;
  rate_tolerance_ratio?: number;
  maximum_route_p95_ms?: number;
  maximum_route_p99_ms?: number;
  cdr_drain_seconds?: number;
  kamailio_shm_allocator?: 'fm' | 'qm' | 'tlsf';
  kamailio_shm_memory_mb?: number;
  kamailio_pkg_memory_mb?: number;
}

export interface SipKamailioStaircaseConfig extends SipKamailioStaircaseConfigInput {
  capacity_claim: 'none';
  rate_tolerance_ratio: number;
  maximum_route_p95_ms: number;
  maximum_route_p99_ms: number;
  cdr_drain_seconds: number;
  kamailio_shm_allocator: 'fm' | 'qm' | 'tlsf';
  kamailio_shm_memory_mb: number;
  kamailio_pkg_memory_mb: number;
}

export interface SipDockerStatsSample {
  timestamp: string;
  name: string;
  cpu_percent: number;
  memory_bytes: number;
  pids: number;
}

export interface SipDockerResourceSummary {
  sample_count: number;
  cpu_max_percent: number;
  memory_max_bytes: number;
  pids_max: number;
}

interface BaselineSummary {
  status: 'passed' | 'failed';
  failed_checks: string[];
  calls_created: number;
  successful_calls: number;
  failed_calls: number;
  current_calls: number;
  retransmissions: number;
  target_cps: number;
  actual_cumulative_cps: number;
  rate_conformant: boolean;
  router_delta: number;
  cdr_delta: number;
  kamailio_new_invites_delta: number | null;
  sip_route_sample_count: number;
  sip_route_p95_ms: number | null;
  sip_route_p99_ms: number | null;
  kamailio_error_log_lines: number;
  queue_drop_log_lines: number;
  wall_timeout: boolean;
  cdr_drained: boolean;
}

interface PreservedContainer {
  id: string;
  name: string;
  state: string;
  health: string | null;
  restart_count: number;
}

interface ImageIdentity {
  reference: string;
  image_id: string;
  repo_digests: string[];
  created_at: string;
}

interface PointEvidence {
  target_cps: number;
  duration_seconds: number;
  expected_calls: number;
  status: 'controlled_pass' | 'controlled_failed';
  capacity_claim: 'none';
  baseline: BaselineSummary | null;
  resources: Record<string, SipDockerResourceSummary>;
  artifact_sha256: Record<string, string>;
  artifact_set_sha256: string | null;
  runner_error_code?: 'baseline_failed_before_summary' | 'baseline_process_failed';
}

export interface SipKamailioStaircaseEvidence {
  schema_version: '1.0.0';
  suite: 'iveKit SIPp -> Kamailio -> RustPBX strict staircase';
  run_id: string;
  status: 'controlled_pass' | 'controlled_failed';
  capacity_claim: 'none';
  generated_at: string;
  completed_at: string;
  configuration: {
    points: number[];
    duration_seconds: number;
    rate_tolerance_ratio: number;
    maximum_route_p95_ms: number;
    maximum_route_p99_ms: number;
    cdr_drain_seconds: number;
    kamailio_shm_allocator: 'fm' | 'qm' | 'tlsf';
    kamailio_shm_memory_mb: number;
    kamailio_pkg_memory_mb: number;
  };
  source: {
    git_commit: string | null;
    dirty: boolean;
    files: Record<string, string>;
  };
  machine: {
    platform: string;
    release: string;
    architecture: string;
    logical_cpu_count: number;
    cpu_model: string;
    memory_bytes: number;
    docker_version: string;
  };
  tools: {
    sipp_version: string;
    sipp_sha256: string;
  };
  images: {
    rustpbx: ImageIdentity;
    kamailio: ImageIdentity;
    postgres: ImageIdentity;
    python: ImageIdentity;
    capacity_tools: ImageIdentity;
  };
  preserved_containers: {
    before: PreservedContainer[];
    after: PreservedContainer[];
    unchanged: boolean;
  };
  points: PointEvidence[];
  cleanup: {
    runtime_removed: boolean;
    baseline_containers_remaining: string[];
  };
  sensitive_inputs_removed: true;
  errors: string[];
}

export function buildSipKamailioStaircaseConfig(
  input: SipKamailioStaircaseConfigInput
): SipKamailioStaircaseConfig {
  for (const [field, value] of Object.entries({
    output_file: input.output_file,
    artifact_root: input.artifact_root,
    runtime_root: input.runtime_root,
    sipp_binary: input.sipp_binary,
    node_command: input.node_command
  })) {
    if (!isAbsolute(String(value || ''))) throw new Error(`${field} must be an absolute path`);
  }
  if (!Array.isArray(input.points) || input.points.length === 0) {
    throw new Error('SIP staircase points are required');
  }
  for (let index = 0; index < input.points.length; index += 1) {
    const value = input.points[index]!;
    if (!Number.isInteger(value) || value < 1 || value > 100_000) {
      throw new Error('SIP staircase points must be positive integers');
    }
    if (index > 0 && value <= input.points[index - 1]!) {
      throw new Error('SIP staircase points must be strictly ascending');
    }
  }
  if (!Number.isInteger(input.duration_seconds) ||
      input.duration_seconds < 5 || input.duration_seconds > 300) {
    throw new Error('SIP staircase duration_seconds must be between 5 and 300');
  }
  immutableImage(input.rustpbx_image, 'RustPBX');
  immutableImage(input.kamailio_image, 'Kamailio');
  digestImage(input.postgres_image, 'PostgreSQL');
  digestImage(input.python_image, 'Python');
  immutableImage(input.capacity_tools_image, 'capacity tools');
  const rateTolerance = ratio(input.rate_tolerance_ratio ?? 0.03, 'rate_tolerance_ratio');
  const maximumRouteP95 = positive(
    input.maximum_route_p95_ms ?? 150,
    'maximum_route_p95_ms'
  );
  const maximumRouteP99 = positive(
    input.maximum_route_p99_ms ?? 250,
    'maximum_route_p99_ms'
  );
  if (maximumRouteP99 < maximumRouteP95) {
    throw new Error('maximum_route_p99_ms must be >= maximum_route_p95_ms');
  }
  const cdrDrain = input.cdr_drain_seconds ?? 60;
  if (!Number.isInteger(cdrDrain) || cdrDrain < 1 || cdrDrain > 300) {
    throw new Error('cdr_drain_seconds must be between 1 and 300');
  }
  const kamailioShmAllocator = input.kamailio_shm_allocator ?? 'fm';
  if (!['fm', 'qm', 'tlsf'].includes(kamailioShmAllocator)) {
    throw new Error('kamailio_shm_allocator must be fm, qm, or tlsf');
  }
  const kamailioShmMemory = boundedInteger(
    input.kamailio_shm_memory_mb ?? 512,
    64,
    4096,
    'kamailio_shm_memory_mb'
  );
  const kamailioPkgMemory = boundedInteger(
    input.kamailio_pkg_memory_mb ?? 32,
    8,
    256,
    'kamailio_pkg_memory_mb'
  );
  return {
    ...input,
    output_file: resolve(input.output_file),
    artifact_root: resolve(input.artifact_root),
    runtime_root: resolve(input.runtime_root),
    sipp_binary: resolve(input.sipp_binary),
    node_command: resolve(input.node_command),
    points: [...input.points],
    capacity_claim: 'none',
    rate_tolerance_ratio: rateTolerance,
    maximum_route_p95_ms: maximumRouteP95,
    maximum_route_p99_ms: maximumRouteP99,
    cdr_drain_seconds: cdrDrain,
    kamailio_shm_allocator: kamailioShmAllocator,
    kamailio_shm_memory_mb: kamailioShmMemory,
    kamailio_pkg_memory_mb: kamailioPkgMemory
  };
}

export function parseSipDockerStatsCsv(csv: string): SipDockerStatsSample[] {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const samples: SipDockerStatsSample[] = [];
  for (const line of lines.slice(1)) {
    const columns = line.split(',');
    if (columns.length !== 7) continue;
    const cpu = Number(columns[2]!.replace(/%$/, ''));
    const memory = dataSize(columns[3]!.split('/')[0]!.trim());
    const pids = Number(columns[6]);
    if (!Number.isFinite(cpu) || cpu < 0 || !Number.isFinite(memory) ||
        !Number.isInteger(pids) || pids < 0) continue;
    samples.push({
      timestamp: columns[0]!,
      name: columns[1]!,
      cpu_percent: cpu,
      memory_bytes: memory,
      pids
    });
  }
  return samples;
}

export function summarizeSipDockerResources(
  samples: SipDockerStatsSample[]
): Record<string, SipDockerResourceSummary> {
  const summaries: Record<string, SipDockerResourceSummary> = {};
  for (const sample of samples) {
    const current = summaries[sample.name] || {
      sample_count: 0,
      cpu_max_percent: 0,
      memory_max_bytes: 0,
      pids_max: 0
    };
    current.sample_count += 1;
    current.cpu_max_percent = Math.max(current.cpu_max_percent, sample.cpu_percent);
    current.memory_max_bytes = Math.max(current.memory_max_bytes, sample.memory_bytes);
    current.pids_max = Math.max(current.pids_max, sample.pids);
    summaries[sample.name] = current;
  }
  return summaries;
}

export async function runSipKamailioStaircase(
  input: SipKamailioStaircaseConfigInput
): Promise<SipKamailioStaircaseEvidence> {
  const config = buildSipKamailioStaircaseConfig(input);
  assertRequiredFiles(config);
  const startedAt = new Date();
  const runId = `sip-kamailio-staircase-${compactTimestamp(startedAt)}-${randomBytes(4).toString('hex')}`;
  const source = await sourceIdentity();
  const machine = await machineIdentity();
  const tools = await sippIdentity(config.sipp_binary);
  const images = {
    rustpbx: await imageIdentity(config.rustpbx_image),
    kamailio: await imageIdentity(config.kamailio_image),
    postgres: await imageIdentity(config.postgres_image),
    python: await imageIdentity(config.python_image),
    capacity_tools: await imageIdentity(config.capacity_tools_image)
  };
  const before = await preservedContainers();
  mkdirSync(config.runtime_root, { recursive: true, mode: 0o700 });
  mkdirSync(config.artifact_root, { recursive: true });
  mkdirSync(dirname(config.output_file), { recursive: true });
  const runtimeDirectory = mkdtempSync(join(config.runtime_root, `${runId}-`));
  const resultDirectory = join(config.artifact_root, runId);
  mkdirSync(resultDirectory, { recursive: true });
  const points: PointEvidence[] = [];
  const errors: string[] = [];
  let runtimePrepared = false;
  let runtimeRemoved = false;
  let remainingContainers: string[] = [];

  try {
    await command('python3', [BASELINE_PREPARE, runtimeDirectory], {
      ...process.env,
      RUSTPBX_IMAGE: config.rustpbx_image,
      KAMAILIO_IMAGE: config.kamailio_image,
      POSTGRES_IMAGE: config.postgres_image,
      PYTHON_IMAGE: config.python_image,
      CAPACITY_TOOLS_IMAGE: config.capacity_tools_image,
      KAMAILIO_SHM_ALLOCATOR: config.kamailio_shm_allocator,
      KAMAILIO_SHM_MEMORY_MB: String(config.kamailio_shm_memory_mb),
      KAMAILIO_PKG_MEMORY_MB: String(config.kamailio_pkg_memory_mb)
    }, 60_000);
    runtimePrepared = true;

    for (const targetCps of config.points) {
      const pointRunId = `${runId}-q${targetCps}`;
      const pointDirectory = join(resultDirectory, pointRunId);
      let runnerFailed = false;
      try {
        await command(BASELINE_RUNNER, [
          String(targetCps),
          String(config.duration_seconds)
        ], {
          ...process.env,
          IVEKIT_RUSTPBX_RUNTIME_DIR: runtimeDirectory,
          IVEKIT_CAPACITY_RESULT_ROOT: resultDirectory,
          IVEKIT_CAPACITY_RUN_ID: pointRunId,
          IVEKIT_NODE_COMMAND: config.node_command,
          IVEKIT_SIPP_BINARY: config.sipp_binary,
          IVEKIT_CAPACITY_INCLUDE_KAMAILIO: '1',
          IVEKIT_SIP_TARGET_IP: '172.30.44.9',
          RATE_TOLERANCE_RATIO: String(config.rate_tolerance_ratio),
          MAX_SIP_ROUTE_P95_MS: String(config.maximum_route_p95_ms),
          MAX_SIP_ROUTE_P99_MS: String(config.maximum_route_p99_ms),
          CDR_DRAIN_SECONDS: String(config.cdr_drain_seconds)
        }, (config.duration_seconds + config.cdr_drain_seconds + 180) * 1_000);
      } catch {
        runnerFailed = true;
      }
      const point = loadPointEvidence(
        pointDirectory,
        targetCps,
        config.duration_seconds,
        runnerFailed
      );
      points.push(point);
      if (point.status !== 'controlled_pass') break;
    }
  } catch {
    errors.push(runtimePrepared ? 'staircase_runner_failed' : 'runtime_prepare_failed');
  } finally {
    if (runtimePrepared) {
      await command('docker', [
        'compose',
        '--env-file', join(runtimeDirectory, '.env'),
        '-f', BASELINE_COMPOSE,
        'down',
        '--remove-orphans'
      ], process.env, 90_000).catch(() => {
        errors.push('baseline_cleanup_failed');
      });
    }
    remainingContainers = await baselineContainers();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    runtimeRemoved = !existsSync(runtimeDirectory);
  }

  const after = await preservedContainers();
  const allPointsPassed = points.length === config.points.length &&
    points.every((point) => point.status === 'controlled_pass');
  const cleanupPassed = runtimeRemoved && remainingContainers.length === 0;
  const preserved = canonicalSipEvidenceJson(before) === canonicalSipEvidenceJson(after);
  if (!preserved) errors.push('preserved_containers_changed');
  if (!cleanupPassed) errors.push('capacity_resources_not_cleaned');
  const evidence: SipKamailioStaircaseEvidence = {
    schema_version: '1.0.0',
    suite: 'iveKit SIPp -> Kamailio -> RustPBX strict staircase',
    run_id: runId,
    status: allPointsPassed && cleanupPassed && preserved && errors.length === 0
      ? 'controlled_pass'
      : 'controlled_failed',
    capacity_claim: 'none',
    generated_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    configuration: {
      points: [...config.points],
      duration_seconds: config.duration_seconds,
      rate_tolerance_ratio: config.rate_tolerance_ratio,
      maximum_route_p95_ms: config.maximum_route_p95_ms,
      maximum_route_p99_ms: config.maximum_route_p99_ms,
      cdr_drain_seconds: config.cdr_drain_seconds,
      kamailio_shm_allocator: config.kamailio_shm_allocator,
      kamailio_shm_memory_mb: config.kamailio_shm_memory_mb,
      kamailio_pkg_memory_mb: config.kamailio_pkg_memory_mb
    },
    source,
    machine,
    tools,
    images,
    preserved_containers: { before, after, unchanged: preserved },
    points,
    cleanup: {
      runtime_removed: runtimeRemoved,
      baseline_containers_remaining: remainingContainers
    },
    sensitive_inputs_removed: true,
    errors
  };
  atomicJsonWrite(config.output_file, evidence);
  return evidence;
}

function loadPointEvidence(
  directory: string,
  targetCps: number,
  durationSeconds: number,
  runnerFailed: boolean
): PointEvidence {
  const summaryPath = join(directory, 'summary.json');
  if (!existsSync(summaryPath)) {
    return {
      target_cps: targetCps,
      duration_seconds: durationSeconds,
      expected_calls: targetCps * durationSeconds,
      status: 'controlled_failed',
      capacity_claim: 'none',
      baseline: null,
      resources: {},
      artifact_sha256: {},
      artifact_set_sha256: null,
      runner_error_code: 'baseline_failed_before_summary'
    };
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as BaselineSummary;
  const statsPath = join(directory, 'docker-stats.csv');
  const resources = existsSync(statsPath)
    ? summarizeSipDockerResources(parseSipDockerStatsCsv(readFileSync(statsPath, 'utf8')))
    : {};
  const artifactSha256 = artifactDigests(directory);
  const artifactSetSha256 = createHash('sha256')
    .update(canonicalSipEvidenceJson(artifactSha256))
    .digest('hex');
  return {
    target_cps: targetCps,
    duration_seconds: durationSeconds,
    expected_calls: targetCps * durationSeconds,
    status: summary.status === 'passed' && !runnerFailed
      ? 'controlled_pass'
      : 'controlled_failed',
    capacity_claim: 'none',
    baseline: summary,
    resources,
    artifact_sha256: artifactSha256,
    artifact_set_sha256: artifactSetSha256,
    ...(runnerFailed && summary.status === 'passed'
      ? { runner_error_code: 'baseline_process_failed' as const }
      : {})
  };
}

function artifactDigests(directory: string): Record<string, string> {
  const allowed = new Set([
    'summary.json',
    'statistics.csv',
    'docker-stats.csv',
    'host-vmstat.log',
    'kamailio-metrics-before.txt',
    'kamailio-metrics-after.txt',
    'router-evidence-before.json',
    'router-evidence-after.json',
    'route-preflight-evidence.json',
    'route-preflight-attempts.txt',
    'kamailio.log',
    'rustpbx.log',
    'sipp.log',
    'errors.log'
  ]);
  const files = readdirSync(directory)
    .filter((name) => allowed.has(name) || name.endsWith('_rtt.csv'))
    .sort();
  return Object.fromEntries(files.map((name) => [
    name,
    sha256(join(directory, name))
  ]));
}

async function sourceIdentity(): Promise<SipKamailioStaircaseEvidence['source']> {
  const files = [
    'infra/capacity/rustpbx-baseline/prepare.py',
    'infra/capacity/rustpbx-baseline/docker-compose.yml',
    'infra/capacity/rustpbx-baseline/run.sh',
    'services/converact-service/acceptance/sipp/inbound-reject-486-uac.xml',
    'src/agent-runtime/converact/voice/kamailio-config.ts',
    'scripts/capacity/sip-kamailio-staircase.ts',
    'scripts/ivekit-capacity-sip-kamailio-staircase.ts'
  ];
  let gitCommit: string | null = null;
  let dirty = true;
  try {
    gitCommit = (await command('git', [
      '-c', `safe.directory=${REPOSITORY_ROOT}`,
      '-C', REPOSITORY_ROOT,
      'rev-parse', 'HEAD'
    ], process.env, 10_000)).trim();
    dirty = Boolean((await command('git', [
      '-c', `safe.directory=${REPOSITORY_ROOT}`,
      '-C', REPOSITORY_ROOT,
      'status', '--short', '--', ...files
    ], process.env, 10_000)).trim());
  } catch {
    gitCommit = null;
    dirty = true;
  }
  return {
    git_commit: gitCommit && /^[a-f0-9]{40}$/.test(gitCommit) ? gitCommit : null,
    dirty,
    files: Object.fromEntries(files.map((file) => [file, sha256(join(REPOSITORY_ROOT, file))]))
  };
}

async function machineIdentity(): Promise<SipKamailioStaircaseEvidence['machine']> {
  const processors = cpus();
  const dockerVersion = (await command(
    'docker',
    ['version', '--format', '{{.Server.Version}}'],
    process.env,
    10_000
  )).trim();
  return {
    platform: platform(),
    release: release(),
    architecture: arch(),
    logical_cpu_count: processors.length,
    cpu_model: processors[0]?.model || 'unknown',
    memory_bytes: totalmem(),
    docker_version: dockerVersion
  };
}

async function sippIdentity(path: string): Promise<SipKamailioStaircaseEvidence['tools']> {
  const version = parseSippVersionProbe(
    await probeCommand(path, ['-v'], process.env, 10_000)
  );
  return { sipp_version: version, sipp_sha256: sha256(path) };
}

export function parseSippVersionProbe(result: {
  exit_code: number;
  stdout: string;
  stderr: string;
}): string {
  if (result.exit_code !== 0 && result.exit_code !== 99) {
    throw new Error(`SIPp version probe failed with exit code ${result.exit_code}`);
  }
  const version = `${result.stdout}${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /SIPp v/i.test(line));
  if (!version) throw new Error('SIPp version could not be identified');
  return version;
}

async function imageIdentity(reference: string): Promise<ImageIdentity> {
  const output = await command('docker', ['image', 'inspect', reference], process.env, 20_000);
  const image = (JSON.parse(output) as Array<{
    Id: string;
    RepoDigests?: string[];
    Created: string;
  }>)[0];
  if (!image?.Id?.startsWith('sha256:')) throw new Error('Docker image identity is invalid');
  return {
    reference,
    image_id: image.Id,
    repo_digests: [...(image.RepoDigests || [])].sort(),
    created_at: image.Created
  };
}

async function preservedContainers(): Promise<PreservedContainer[]> {
  const ids = (await command('docker', [
    'ps', '-aq', '--filter', 'name=led-platform'
  ], process.env, 10_000)).trim().split(/\r?\n/).filter(Boolean);
  if (ids.length === 0) return [];
  const output = await command('docker', ['inspect', ...ids], process.env, 20_000);
  return (JSON.parse(output) as Array<{
    Id: string;
    Name: string;
    RestartCount: number;
    State: { Status: string; Health?: { Status: string } };
  }>).map((container) => ({
    id: container.Id,
    name: container.Name.replace(/^\//, ''),
    state: container.State.Status,
    health: container.State.Health?.Status || null,
    restart_count: container.RestartCount
  })).sort((left, right) => left.name.localeCompare(right.name));
}

async function baselineContainers(): Promise<string[]> {
  return (await command('docker', [
    'ps', '-aq', '--filter', 'name=ivekit-rustpbx-baseline'
  ], process.env, 10_000)).trim().split(/\r?\n/).filter(Boolean).sort();
}

function assertRequiredFiles(config: SipKamailioStaircaseConfig): void {
  for (const path of [
    BASELINE_RUNNER,
    BASELINE_COMPOSE,
    BASELINE_PREPARE,
    SCENARIO,
    config.sipp_binary,
    config.node_command
  ]) {
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`${basename(path)} is missing`);
    }
  }
}

function immutableImage(value: string, label: string): string {
  const input = String(value || '').trim();
  if (/\s|:latest(?:$|@)/.test(input) || !(
    /@sha256:[a-f0-9]{64}$/.test(input) ||
    /:\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(input)
  )) {
    throw new Error(`${label} image must use an immutable digest or exact version tag`);
  }
  return input;
}

function digestImage(value: string, label: string): string {
  const input = String(value || '').trim();
  if (!/@sha256:[a-f0-9]{64}$/.test(input)) {
    throw new Error(`${label} image must be pinned by immutable SHA-256 digest`);
  }
  return input;
}

function ratio(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 0.25) {
    throw new Error(`${label} must be > 0 and <= 0.25`);
  }
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function dataSize(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?i?b)$/i.exec(value);
  if (!match) return Number.NaN;
  const units: Record<string, number> = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4
  };
  return Math.round(Number(match[1]) * units[match[2]!.toLowerCase()]!);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function canonicalSipEvidenceJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('evidence contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSipEvidenceJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSipEvidenceJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('evidence must contain JSON values only');
}

function atomicJsonWrite(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function command(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number
): Promise<string> {
  const result = await execFile(executable, args, {
    cwd: REPOSITORY_ROOT,
    env,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8'
  });
  return result.stdout || '';
}

async function probeCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const options = {
    cwd: REPOSITORY_ROOT,
    env,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8' as const
  };
  try {
    const result = await execFile(executable, args, options);
    return {
      exit_code: 0,
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = Number(failure.code);
    if (!Number.isInteger(exitCode)) throw error;
    return {
      exit_code: exitCode,
      stdout: failure.stdout || '',
      stderr: failure.stderr || ''
    };
  }
}

function compactTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
