import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildLiveKitNetworkNamespaceAttestation,
  buildLiveKitNetworkNamespacePlan,
  type LiveKitNetworkNamespaceCommand,
  type LiveKitNetworkNamespacePlan
} from './capacity/generators/network-namespace.js';
import {
  FencedNetworkImpairmentController,
  buildNetworkImpairmentPlan,
  type NetworkImpairmentCommand,
  type NetworkImpairmentProfile,
  type NetworkImpairmentReceipt,
  type NetworkImpairmentReleaseReceipt
} from './capacity/generators/network-impairment.js';
import type {
  LiveKitCapacityQualityContract,
  LiveKitCapacityProcessInput
} from './capacity/generators/livekit.js';
import {
  assertLiveKitNetworkQualityContract
} from './capacity/generators/livekit-network-evidence.js';
import {
  validateLiveKitBrowserBaselineInput
} from './ivekit-livekit-browser-capacity.js';
import {
  runLiveKitBrowserEvidence
} from './ivekit-livekit-browser-evidence.js';
import {
  runLiveKitNetworkEvidence
} from './ivekit-livekit-network-evidence.js';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..');
const COLLECTOR_PATH = resolve(SCRIPT_DIRECTORY, 'ivekit-livekit-browser-capacity.ts');

export interface LiveKitNetworkCampaignArgs {
  input_path: string;
  profile_path: string;
  result_directory: string;
  namespace_ordinal: number;
  livekit_port: number;
  binary_version: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export interface LiveKitNetworkCampaignPaths {
  raw: string;
  evaluated: string;
  apply: string;
  release: string;
  window: string;
  networkPathAttestation: string;
  networkEvidence: string;
  collectorLog: string;
}

export function parseLiveKitNetworkCampaignArgs(
  argv: readonly string[]
): LiveKitNetworkCampaignArgs {
  if (argv.length !== 12) throw new Error('LiveKit network campaign options are incomplete');
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || options.has(name)) {
      throw new Error('LiveKit network campaign options are invalid');
    }
    options.set(name, value);
  }
  const allowed = new Set([
    '--input',
    '--profile',
    '--result-dir',
    '--namespace-ordinal',
    '--livekit-port',
    '--binary-version'
  ]);
  if ([...options.keys()].some((name) => !allowed.has(name))) {
    throw new Error('LiveKit network campaign option is unknown');
  }
  return {
    input_path: absolute(required(options, '--input')),
    profile_path: absolute(required(options, '--profile')),
    result_directory: absolute(required(options, '--result-dir')),
    namespace_ordinal: integer(required(options, '--namespace-ordinal'), 0, 199, 'ordinal'),
    livekit_port: integer(required(options, '--livekit-port'), 1, 65_535, 'LiveKit port'),
    binary_version: boundedText(required(options, '--binary-version'), 255, 'binary version')
  };
}

export async function runLiveKitNetworkCampaign(
  args: LiveKitNetworkCampaignArgs
): Promise<{
  run_id: string;
  media_status: string;
  network_path_qualification: string;
  result_path: string;
}> {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' ||
      process.getuid() !== 0) {
    throw new Error('LiveKit network campaign requires Linux root');
  }
  const [inputRaw, profileRaw] = await Promise.all([
    readPrivateBounded(args.input_path),
    readPrivateBounded(args.profile_path)
  ]);
  const inputUnknown = parseJson(inputRaw, 'input');
  validateLiveKitBrowserBaselineInput(inputUnknown);
  const input = inputUnknown as LiveKitCapacityProcessInput;
  const profile = parseJson(profileRaw, 'profile') as NetworkImpairmentProfile;
  const qualityContract: LiveKitCapacityQualityContract = {
    camera_bitrate: input.camera.minimum_bitrate_bps === undefined
      ? {
          mode: 'target_tolerance',
          target_bps: input.camera.bitrate_bps,
          tolerance_ratio: 0.1
        }
      : {
          mode: 'adaptive_minimum',
          target_bps: input.camera.bitrate_bps,
          minimum_bps: input.camera.minimum_bitrate_bps
        },
    endpoint_packet_loss_p95_ratio:
      input.quality_limits.endpoint_packet_loss_p95_ratio,
    quality_limits: structuredClone(input.quality_limits)
  };
  assertLiveKitNetworkQualityContract(profile, qualityContract);
  const namespace = buildLiveKitNetworkNamespacePlan({
    ordinal: args.namespace_ordinal,
    livekit_port: args.livekit_port
  });
  const paths = buildLiveKitNetworkCampaignPaths(args.result_directory);
  await validateResultDirectory(args.result_directory, paths);
  if (input.livekit_url !== namespace.livekit_url) {
    throw new Error(`LiveKit network campaign input URL must be ${namespace.livekit_url}`);
  }
  if (input.result_path !== paths.raw) {
    throw new Error(`LiveKit network campaign input result_path must be ${paths.raw}`);
  }
  await assertNamespaceAvailable(namespace);

  const lease = {
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch
  };
  const impairment = new FencedNetworkImpairmentController({
    execute: (command) => executeInsideNamespace(namespace, command)
  });
  const impairmentPlan = buildNetworkImpairmentPlan({
    lease,
    interface_name: namespace.generator_interface_name,
    ifb_interface_name: namespace.ifb_interface_name,
    profile
  });
  let namespaceOwned = false;
  let impairmentActive = false;
  let releaseReceipt: NetworkImpairmentReleaseReceipt | null = null;
  let primaryError: unknown;

  try {
    await executeNamespaceCommand(namespace.setup[0]);
    namespaceOwned = true;
    for (const command of namespace.setup.slice(1)) {
      await executeNamespaceCommand(command);
    }
    const networkPathAttestation = await captureNetworkPathAttestation(
      namespace,
      lease
    );
    await writePrivateJson(paths.networkPathAttestation, networkPathAttestation);
    const applyReceipt = await impairment.apply(impairmentPlan);
    impairmentActive = true;
    await writePrivateJson(paths.apply, applyReceipt);
    const measurementStartedAt = new Date().toISOString();
    let measurementCompletedAt = measurementStartedAt;
    try {
      const collector = await runCollector(namespace, inputRaw, input, paths.raw);
      measurementCompletedAt = new Date().toISOString();
      await writePrivateText(paths.collectorLog, collectorLog(collector));
      if (collector.timed_out || collector.code !== 0) {
        throw new Error(
          collector.timed_out
            ? 'LiveKit network campaign collector timed out'
            : `LiveKit network campaign collector exited with ${collector.code}`
        );
      }
    } finally {
      measurementCompletedAt = new Date().toISOString();
      releaseReceipt = await impairment.release(lease);
      impairmentActive = false;
      await writePrivateJson(paths.release, releaseReceipt);
      await writePrivateJson(paths.window, {
        schema_version: '1.0.0',
        measurement_started_at: measurementStartedAt,
        measurement_completed_at: measurementCompletedAt
      });
    }

    const collectorSha = createHash('sha256')
      .update(await readFile(COLLECTOR_PATH))
      .digest('hex');
    const mediaEvidence = await runLiveKitBrowserEvidence({
      input_path: args.input_path,
      raw_path: paths.raw,
      binary_version: args.binary_version,
      binary_sha256: collectorSha,
      result_path: paths.evaluated
    });
    const networkEvidence = await runLiveKitNetworkEvidence({
      media_path: paths.evaluated,
      apply_path: paths.apply,
      release_path: paths.release,
      window_path: paths.window,
      network_path_attestation_path: paths.networkPathAttestation,
      result_path: paths.networkEvidence
    });
    return {
      run_id: input.run_id,
      media_status: mediaEvidence.status,
      network_path_qualification: networkEvidence.network_path_qualification,
      result_path: paths.networkEvidence
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    if (impairmentActive) {
      try {
        releaseReceipt = await impairment.release(lease);
        if (!await pathExists(paths.release)) {
          await writePrivateJson(paths.release, releaseReceipt);
        }
      } catch (error) {
        cleanupErrors.push(message(error));
      }
    }
    if (namespaceOwned) {
      for (const command of namespace.restore) {
        const result = await executeNamespaceCommand(command, true);
        if (result.code !== 0 && !command.ignore_failure) {
          cleanupErrors.push(result.stderr || `${command.executable} cleanup failed`);
        }
      }
    }
    if (cleanupErrors.length > 0 && !primaryError) {
      throw new Error(`LiveKit network campaign cleanup failed: ${cleanupErrors.join('; ')}`);
    }
  }
}

async function runCollector(
  namespace: LiveKitNetworkNamespacePlan,
  inputRaw: string,
  input: LiveKitCapacityProcessInput,
  resultPath: string
): Promise<CommandResult> {
  const timeoutMs = (input.duration_seconds + 60) * 1_000;
  const path = process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return runCommand('/sbin/ip', [
    'netns', 'exec', namespace.namespace_name,
    '/usr/bin/env',
    `HOME=${process.env.HOME || '/root'}`,
    `PATH=${path}`,
    `CONVERACT_FABRIC_LIVEKIT_GENERATOR_INTERFACE=${namespace.generator_interface_name}`,
    'CONVERACT_FABRIC_LIVEKIT_GENERATOR_NIC_BPS=10000000000',
    process.execPath,
    '--import', 'tsx',
    COLLECTOR_PATH,
    'run', '--input-json', '-', '--result', resultPath
  ], {
    cwd: REPOSITORY_ROOT,
    input: inputRaw,
    timeoutMs
  });
}

async function executeInsideNamespace(
  namespace: LiveKitNetworkNamespacePlan,
  command: NetworkImpairmentCommand
): Promise<{ code: number; stderr: string }> {
  const result = await runCommand('/sbin/ip', [
    'netns', 'exec', namespace.namespace_name,
    command.executable,
    ...command.args
  ]);
  return { code: result.code, stderr: result.stderr };
}

async function captureNetworkPathAttestation(
  namespace: LiveKitNetworkNamespacePlan,
  lease: NetworkImpairmentReceipt['lease']
) {
  const [host, generator, routes] = await Promise.all([
    runCommand('/sbin/ip', [
      '-j', 'address', 'show', 'dev', namespace.host_interface_name
    ]),
    runCommand('/sbin/ip', [
      'netns', 'exec', namespace.namespace_name,
      '/sbin/ip', '-j', 'address', 'show', 'dev', namespace.generator_interface_name
    ]),
    runCommand('/sbin/ip', [
      'netns', 'exec', namespace.namespace_name,
      '/sbin/ip', '-j', 'route', 'show', 'default'
    ])
  ]);
  for (const observation of [host, generator, routes]) {
    if (observation.code !== 0 || observation.timed_out) {
      throw new Error(
        observation.stderr || 'LiveKit network namespace observation failed'
      );
    }
  }
  return buildLiveKitNetworkNamespaceAttestation({
    plan: namespace,
    lease,
    observed_at: new Date().toISOString(),
    host_interfaces: parseJson(host.stdout, 'host interface observation'),
    generator_interfaces: parseJson(
      generator.stdout,
      'generator interface observation'
    ),
    generator_routes: parseJson(routes.stdout, 'generator route observation')
  });
}

async function executeNamespaceCommand(
  command: LiveKitNetworkNamespaceCommand,
  cleanup = false
): Promise<CommandResult> {
  const result = await runCommand(command.executable, command.args);
  if (result.code !== 0 && !command.ignore_failure && !cleanup) {
    throw new Error(
      result.stderr || `${command.executable} exited with ${result.code}`
    );
  }
  return result;
}

async function assertNamespaceAvailable(plan: LiveKitNetworkNamespacePlan): Promise<void> {
  const namespaces = await runCommand('/sbin/ip', ['netns', 'list']);
  if (namespaces.code !== 0) throw new Error('cannot inspect network namespaces');
  const names = namespaces.stdout.split('\n')
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter(Boolean);
  if (names.includes(plan.namespace_name)) {
    throw new Error('LiveKit network campaign namespace is already active');
  }
  const link = await runCommand('/sbin/ip', ['link', 'show', plan.host_interface_name]);
  if (link.code === 0) throw new Error('LiveKit network campaign veth is already active');
}

export function buildLiveKitNetworkCampaignPaths(
  directory: string
): LiveKitNetworkCampaignPaths {
  return {
    raw: resolve(directory, 'raw.json'),
    evaluated: resolve(directory, 'evaluated.json'),
    apply: resolve(directory, 'apply.json'),
    release: resolve(directory, 'release.json'),
    window: resolve(directory, 'window.json'),
    networkPathAttestation: resolve(directory, 'network-path-attestation.json'),
    networkEvidence: resolve(directory, 'network-evidence.json'),
    collectorLog: resolve(directory, 'collector.log')
  };
}

async function validateResultDirectory(
  directory: string,
  paths: LiveKitNetworkCampaignPaths
): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new Error('LiveKit network campaign result directory must be owned mode 0700');
  }
  for (const path of Object.values(paths)) {
    if (await pathExists(path)) {
      throw new Error(`LiveKit network campaign result already exists: ${path}`);
    }
  }
}

async function readPrivateBounded(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES ||
      (metadata.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new Error('LiveKit network campaign input must be an owned mode 0600 file');
  }
  return readFile(path, 'utf8');
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateText(path: string, value: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function runCommand(
  executable: string,
  args: string[],
  options: { cwd?: string; input?: string; timeoutMs?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: {
        HOME: process.env.HOME || '/root',
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString('utf8')}`.slice(-MAX_COMMAND_OUTPUT_BYTES);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolveResult({ code: -1, stdout, stderr: error.message, timed_out: timedOut });
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, options.timeoutMs || 30_000);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolveResult({ code: code ?? -1, stdout, stderr, timed_out: timedOut });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function collectorLog(result: CommandResult): string {
  return [
    `exit_code=${result.code}`,
    `timed_out=${result.timed_out}`,
    '--- stdout ---',
    result.stdout,
    '--- stderr ---',
    result.stderr
  ].join('\n');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`LiveKit network campaign ${label} is invalid JSON`);
  }
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`LiveKit network campaign ${name} is required`);
  return value;
}

function absolute(value: string): string {
  if (!isAbsolute(value) || /[\r\n\u0000]/.test(value) || value.split('/').includes('..')) {
    throw new Error('LiveKit network campaign requires an absolute path');
  }
  return value;
}

function integer(value: string, minimum: number, maximum: number, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`LiveKit network campaign ${label} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`LiveKit network campaign ${label} is invalid`);
  }
  return parsed;
}

function boundedText(value: string, maximumLength: number, label: string): string {
  if (!value || value.length > maximumLength || /[\r\n\u0000]/.test(value)) {
    throw new Error(`LiveKit network campaign ${label} is invalid`);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const result = await runLiveKitNetworkCampaign(
    parseLiveKitNetworkCampaignArgs(process.argv.slice(2))
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${message(error)}\n`);
    process.exitCode = 1;
  });
}
