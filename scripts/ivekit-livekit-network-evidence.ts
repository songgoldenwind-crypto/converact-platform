import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  bindLiveKitNetworkImpairmentEvidence,
  type LiveKitNetworkImpairmentEvidence
} from './capacity/generators/livekit-network-evidence.js';
import type {
  NetworkImpairmentReceipt,
  NetworkImpairmentReleaseReceipt
} from './capacity/generators/network-impairment.js';
import type {
  LiveKitNetworkNamespaceAttestation
} from './capacity/generators/network-namespace.js';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

interface LiveKitNetworkEvidenceArgs {
  media_path: string;
  apply_path: string;
  release_path: string;
  window_path: string;
  network_path_attestation_path?: string;
  result_path: string;
}

interface MeasurementWindow {
  schema_version: '1.0.0';
  measurement_started_at: string;
  measurement_completed_at: string;
}

export function parseLiveKitNetworkEvidenceArgs(
  argv: readonly string[]
): LiveKitNetworkEvidenceArgs {
  if (argv.length !== 10 && argv.length !== 12) {
    throw new Error('LiveKit network evidence options are incomplete');
  }
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || options.has(name)) {
      throw new Error('LiveKit network evidence options are invalid');
    }
    options.set(name, value);
  }
  const allowed = new Set([
    '--media',
    '--apply',
    '--release',
    '--window',
    '--network-path-attestation',
    '--result'
  ]);
  if ([...options.keys()].some((name) => !allowed.has(name))) {
    throw new Error('LiveKit network evidence option is unknown');
  }
  return {
    media_path: absolute(required(options, '--media')),
    apply_path: absolute(required(options, '--apply')),
    release_path: absolute(required(options, '--release')),
    window_path: absolute(required(options, '--window')),
    ...(options.has('--network-path-attestation')
      ? {
          network_path_attestation_path:
            absolute(required(options, '--network-path-attestation'))
        }
      : {}),
    result_path: absolute(required(options, '--result'))
  };
}

export async function runLiveKitNetworkEvidence(
  args: LiveKitNetworkEvidenceArgs
): Promise<LiveKitNetworkImpairmentEvidence> {
  const [mediaRaw, applyRaw, releaseRaw, windowRaw, attestationRaw] = await Promise.all([
    readPrivateBounded(args.media_path),
    readPrivateBounded(args.apply_path),
    readPrivateBounded(args.release_path),
    readPrivateBounded(args.window_path),
    args.network_path_attestation_path
      ? readPrivateBounded(args.network_path_attestation_path)
      : Promise.resolve(undefined)
  ]);
  const mediaEvidence = parseJson(mediaRaw, 'media evidence');
  const applyReceipt = parseJson(applyRaw, 'apply receipt') as NetworkImpairmentReceipt;
  const releaseReceipt = parseJson(releaseRaw, 'release receipt') as
    NetworkImpairmentReleaseReceipt & { released: true };
  const window = parseJson(windowRaw, 'measurement window') as MeasurementWindow;
  if (window.schema_version !== '1.0.0') {
    throw new Error('LiveKit network evidence measurement window is invalid');
  }
  const evidence = bindLiveKitNetworkImpairmentEvidence({
    media_evidence: mediaEvidence,
    media_evidence_sha256: createHash('sha256').update(mediaRaw).digest('hex'),
    ...(attestationRaw
      ? {
          network_path_attestation:
            parseJson(attestationRaw, 'network path attestation') as
              LiveKitNetworkNamespaceAttestation,
          network_path_attestation_sha256:
            createHash('sha256').update(attestationRaw).digest('hex')
        }
      : {}),
    apply_receipt: applyReceipt,
    release_receipt: releaseReceipt,
    measurement_started_at: window.measurement_started_at,
    measurement_completed_at: window.measurement_completed_at
  });
  await writePrivateEvidence(args.result_path, evidence);
  return evidence;
}

async function readPrivateBounded(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES ||
      (metadata.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new Error('LiveKit network evidence input file is invalid');
  }
  return readFile(path, 'utf8');
}

async function writePrivateEvidence(
  path: string,
  evidence: LiveKitNetworkImpairmentEvidence
): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
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
    throw new Error(`LiveKit network ${label} is invalid JSON`);
  }
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`LiveKit network evidence ${name} is required`);
  return value;
}

function absolute(value: string): string {
  if (!isAbsolute(value) || /[\r\n\u0000]/.test(value) || value.split('/').includes('..')) {
    throw new Error('LiveKit network evidence requires an absolute path');
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseLiveKitNetworkEvidenceArgs(process.argv.slice(2));
  const evidence = await runLiveKitNetworkEvidence(args);
  process.stdout.write(`${JSON.stringify({
    run_id: evidence.run_id,
    media_status: evidence.media_status,
    profile: evidence.network_impairment.profile.id,
    result_path: args.result_path
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
