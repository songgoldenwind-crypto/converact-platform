import { open, readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  evaluateLiveKitNativeCapacity,
  parseLiveKitCliLoadTestSummary,
  type LiveKitNativeCapacityEvidence,
  type LiveKitNativeCommandObservation,
  type LiveKitNativePidObservation
} from './capacity/generators/livekit-native.js';
import type {
  LiveKitNativeWorkloadManifest
} from './capacity/generators/livekit-native-workload.js';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

export interface LiveKitNativeEvidenceArgs {
  run_id: string;
  expected_tracks: number;
  maximum_packet_loss_ratio: number;
  summary_path: string;
  generator_path: string;
  sut_path: string;
  result_path: string;
  require_distinct_hosts: boolean;
  workload_path?: string;
  require_workload_binding?: boolean;
}

export function parseLiveKitNativeEvidenceArgs(argv: readonly string[]): LiveKitNativeEvidenceArgs {
  if (argv.length < 14 || argv.length > 20 || argv.length % 2 !== 0) {
    throw new Error('LiveKit native evidence options are incomplete');
  }
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith('--') || !value || options.has(name)) {
      throw new Error('LiveKit native evidence options are invalid');
    }
    options.set(name, value);
  }
  const allowed = new Set([
    '--run-id',
    '--expected-tracks',
    '--maximum-packet-loss-ratio',
    '--summary',
    '--generator',
    '--sut',
    '--result',
    '--require-distinct-hosts',
    '--workload',
    '--require-workload-binding'
  ]);
  if ([...options.keys()].some((name) => !allowed.has(name))) {
    throw new Error('LiveKit native evidence option is unknown');
  }

  const workloadPath = options.get('--workload');
  const requireWorkloadBinding = booleanOption(
    options.get('--require-workload-binding') ?? 'false',
    'require workload binding'
  );
  if (requireWorkloadBinding && !workloadPath) {
    throw new Error('LiveKit native evidence workload is required in strict workload mode');
  }
  return {
    run_id: required(options, '--run-id'),
    expected_tracks: positiveInteger(required(options, '--expected-tracks'), 'expected tracks'),
    maximum_packet_loss_ratio: ratio(
      required(options, '--maximum-packet-loss-ratio'),
      'maximum packet loss ratio'
    ),
    summary_path: absolutePath(required(options, '--summary')),
    generator_path: absolutePath(required(options, '--generator')),
    sut_path: absolutePath(required(options, '--sut')),
    result_path: absolutePath(required(options, '--result')),
    require_distinct_hosts: booleanOption(
      options.get('--require-distinct-hosts') ?? 'false',
      'require distinct hosts'
    ),
    require_workload_binding: requireWorkloadBinding,
    ...(workloadPath ? { workload_path: absolutePath(workloadPath) } : {})
  };
}

export async function runLiveKitNativeEvidence(
  args: LiveKitNativeEvidenceArgs
): Promise<LiveKitNativeCapacityEvidence> {
  const [summaryRaw, generatorRaw, sutRaw, workloadRaw] = await Promise.all([
    readBounded(args.summary_path),
    readBounded(args.generator_path),
    readBounded(args.sut_path),
    args.workload_path ? readBounded(args.workload_path) : Promise.resolve(null)
  ]);
  const evidence = evaluateLiveKitNativeCapacity({
    run_id: args.run_id,
    expected_tracks: args.expected_tracks,
    maximum_packet_loss_ratio: args.maximum_packet_loss_ratio,
    summary: parseLiveKitCliLoadTestSummary(summaryRaw),
    generator: parseJson(generatorRaw, 'generator') as LiveKitNativeCommandObservation,
    sut: parseJson(sutRaw, 'SUT') as LiveKitNativePidObservation,
    require_distinct_hosts: args.require_distinct_hosts,
    require_workload_binding: args.require_workload_binding ?? false,
    ...(workloadRaw ? {
      workload: parseJson(workloadRaw, 'workload') as LiveKitNativeWorkloadManifest
    } : {})
  });
  await writePrivateEvidence(args.result_path, evidence);
  return evidence;
}

async function readBounded(path: string): Promise<string> {
  absolutePath(path);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error('LiveKit native evidence input file is invalid');
  }
  return readFile(path, 'utf8');
}

async function writePrivateEvidence(
  path: string,
  evidence: LiveKitNativeCapacityEvidence
): Promise<void> {
  absolutePath(path);
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`LiveKit native evidence result already exists: ${path}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`LiveKit native ${label} observation is invalid JSON`);
  }
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`LiveKit native evidence ${name} is required`);
  return value;
}

function absolutePath(value: string): string {
  if (!isAbsolute(value) || /[\r\n\u0000]/.test(value) || value.split('/').includes('..')) {
    throw new Error('LiveKit native evidence requires an absolute path');
  }
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`LiveKit native evidence ${label} is invalid`);
  }
  return parsed;
}

function ratio(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`LiveKit native evidence ${label} is invalid`);
  }
  return parsed;
}

function booleanOption(value: string, label: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`LiveKit native evidence ${label} is invalid`);
}

async function main(): Promise<void> {
  const evidence = await runLiveKitNativeEvidence(
    parseLiveKitNativeEvidenceArgs(process.argv.slice(2))
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
