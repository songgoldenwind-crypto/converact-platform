import { lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  evaluateLiveKitCapacityEvidence,
  type LiveKitCapacityEvidence,
  type LiveKitCapacityProcessInput,
  type LiveKitCapacityRawEvidence
} from './capacity/generators/livekit.js';
import { validateLiveKitBrowserBaselineInput } from './ivekit-livekit-browser-capacity.js';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

export interface LiveKitBrowserEvidenceArgs {
  input_path: string;
  raw_path: string;
  binary_version: string;
  binary_sha256: string;
  result_path: string;
}

export function parseLiveKitBrowserEvidenceArgs(
  argv: readonly string[]
): LiveKitBrowserEvidenceArgs {
  if (argv.length !== 10) {
    throw new Error('LiveKit browser evidence options are incomplete');
  }
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || options.has(name)) {
      throw new Error('LiveKit browser evidence options are invalid');
    }
    options.set(name, value);
  }
  const allowed = new Set([
    '--input',
    '--raw',
    '--binary-version',
    '--binary-sha256',
    '--result'
  ]);
  if ([...options.keys()].some((name) => !allowed.has(name))) {
    throw new Error('LiveKit browser evidence option is unknown');
  }
  return {
    input_path: absolutePath(required(options, '--input')),
    raw_path: absolutePath(required(options, '--raw')),
    binary_version: required(options, '--binary-version'),
    binary_sha256: required(options, '--binary-sha256'),
    result_path: absolutePath(required(options, '--result'))
  };
}

export async function runLiveKitBrowserEvidence(
  args: LiveKitBrowserEvidenceArgs
): Promise<LiveKitCapacityEvidence> {
  const [processInputRaw, evidenceRaw] = await Promise.all([
    readPrivateBounded(args.input_path),
    readPrivateBounded(args.raw_path)
  ]);
  const processInput = parseJson(processInputRaw, 'input');
  validateLiveKitBrowserBaselineInput(processInput);
  const raw = parseJson(evidenceRaw, 'raw evidence') as LiveKitCapacityRawEvidence;
  const evidence = evaluateProcessEvidence(
    processInput,
    raw,
    args.binary_version,
    args.binary_sha256
  );
  await writePrivateEvidence(args.result_path, evidence);
  return evidence;
}

function evaluateProcessEvidence(
  input: LiveKitCapacityProcessInput,
  raw: LiveKitCapacityRawEvidence,
  binaryVersion: string,
  binarySha256: string
): LiveKitCapacityEvidence {
  return evaluateLiveKitCapacityEvidence({
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    expected_rooms: input.room_count,
    expected_participants: input.expected_participants,
    expected_camera_tracks: input.room_count * input.camera_publishers_per_room,
    expected_audio_tracks: input.room_count * input.audio_publishers_per_room,
    expected_screen_tracks: input.screen_room_count + input.overlay_screen_room_count,
    expected_forced_turn_participants: input.forced_turn_participant_count,
    expected_track_egress: input.track_egress_count,
    expected_room_composite_egress: input.room_composite_egress_count,
    camera_bitrate_bps: input.camera.bitrate_bps,
    camera_bitrate_minimum_bps: input.camera.minimum_bitrate_bps,
    screen_bitrate_bps: input.screen.bitrate_bps,
    expected_reconnect_participants: input.reconnect_participant_count,
    expected_reconnect_rooms:
      input.reconnect_participant_count / input.participants_per_room,
    expected_reconnect_blackout_ms: input.reconnect_blackout_ms,
    expected_reconnect_start_window_ms: input.reconnect_start_window_ms,
    quality_limits: input.quality_limits,
    binary_version: binaryVersion,
    binary_sha256: binarySha256,
    raw
  });
}

async function readPrivateBounded(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error('LiveKit browser evidence input file is invalid');
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error('LiveKit browser evidence input file must use mode 0600');
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error('LiveKit browser evidence input file must be owned by the current user');
  }
  return readFile(path, 'utf8');
}

async function writePrivateEvidence(
  path: string,
  evidence: LiveKitCapacityEvidence
): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`LiveKit browser evidence result already exists: ${path}`);
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
    throw new Error(`LiveKit browser ${label} is invalid JSON`);
  }
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`LiveKit browser evidence ${name} is required`);
  return value;
}

function absolutePath(value: string): string {
  if (!isAbsolute(value) || /[\r\n\u0000]/.test(value) ||
      value.split('/').includes('..')) {
    throw new Error('LiveKit browser evidence requires an absolute path');
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseLiveKitBrowserEvidenceArgs(process.argv.slice(2));
  const evidence = await runLiveKitBrowserEvidence(args);
  process.stdout.write(`${JSON.stringify({
    status: evidence.status,
    failure_class: evidence.failure_class,
    run_id: evidence.run_id,
    result_path: args.result_path
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
