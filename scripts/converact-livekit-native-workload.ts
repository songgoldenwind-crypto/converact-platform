import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildLiveKitNativeWorkloadManifest
} from './capacity/generators/livekit-native-workload.js';
import {
  sha256LinuxExecutable
} from './converact-linux-process-observer.js';

interface LiveKitNativeWorkloadArgs {
  run_id: string;
  executable: string;
  result_path: string;
  command_args: string[];
}

export function parseLiveKitNativeWorkloadArgs(
  argv: readonly string[]
): LiveKitNativeWorkloadArgs {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator + 1 >= argv.length) {
    throw new Error('LiveKit native workload requires -- and load-test arguments');
  }
  const options = new Map<string, string>();
  for (let index = 0; index < separator; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--') || options.has(name)) {
      throw new Error('LiveKit native workload options are invalid');
    }
    options.set(name, value);
  }
  const allowed = new Set(['--run-id', '--executable', '--result']);
  if (options.size !== 3 || [...options.keys()].some((name) => !allowed.has(name))) {
    throw new Error('LiveKit native workload requires run-id, executable and result');
  }
  return {
    run_id: required(options, '--run-id'),
    executable: absolutePath(required(options, '--executable')),
    result_path: absolutePath(required(options, '--result')),
    command_args: argv.slice(separator + 1)
  };
}

export async function runLiveKitNativeWorkload(
  args: LiveKitNativeWorkloadArgs
) {
  const manifest = buildLiveKitNativeWorkloadManifest({
    run_id: args.run_id,
    executable_sha256: await sha256LinuxExecutable(args.executable),
    args: args.command_args
  });
  let handle;
  try {
    handle = await open(args.result_path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`LiveKit native workload result already exists: ${args.result_path}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return manifest;
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`LiveKit native workload ${name} is required`);
  return value;
}

function absolutePath(value: string): string {
  if (!isAbsolute(value) || /[\r\n\u0000]/.test(value) || value.split('/').includes('..')) {
    throw new Error('LiveKit native workload requires an absolute path');
  }
  return value;
}

async function main(): Promise<void> {
  const manifest = await runLiveKitNativeWorkload(
    parseLiveKitNativeWorkloadArgs(process.argv.slice(2))
  );
  process.stdout.write(`${JSON.stringify({
    status: 'created',
    run_id: manifest.run_id,
    expected_subscribed_tracks: manifest.expected_subscribed_tracks
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
