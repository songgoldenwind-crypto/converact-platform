import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  open,
  readFile,
  stat
} from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LinuxProcessTreeObserver,
  type LinuxProcessTreeObservation
} from './capacity/generators/linux-process-tree-observer.js';

export interface LinuxPidObserverArgs {
  mode: 'pid';
  pid: number;
  duration_seconds: number;
  interface_name: string;
  nic_capacity_bps: number;
  sample_interval_ms: number;
  result_path: string;
}

export interface LinuxCommandObserverArgs {
  mode: 'run';
  executable: string;
  args: string[];
  interface_name: string;
  nic_capacity_bps: number;
  sample_interval_ms: number;
  result_path: string;
}

export interface LinuxPidObservationEvidence extends LinuxProcessTreeObservation {
  schema_version: '1.0.0';
  mode: 'pid';
  observed_pid: number;
  duration_seconds: number;
}

export interface LinuxCommandObservationEvidence extends LinuxProcessTreeObservation {
  schema_version: '1.1.0';
  mode: 'run';
  observed_pid: number;
  executable: string;
  executable_sha256: string;
  command_arg_count: number;
  command_args_sha256: string;
  exit_code: number;
  signal: string | null;
}

export function hashLinuxCommandArguments(args: readonly string[]): string {
  if (!Array.isArray(args) || args.some((value) =>
    typeof value !== 'string' || value.includes('\u0000'))) {
    throw new Error('Linux observed command arguments are invalid');
  }
  return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

export async function sha256LinuxExecutable(path: string): Promise<string> {
  absolutePath(path, 'absolute executable');
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export function parseLinuxProcessObserverArgs(
  args: readonly string[]
): LinuxPidObserverArgs | LinuxCommandObserverArgs {
  const mode = args[0];
  if (mode !== 'pid' && mode !== 'run') {
    throw new Error('usage: pid|run [options]');
  }
  const separator = args.indexOf('--');
  const optionEnd = separator < 0 ? args.length : separator;
  const options = new Map<string, string>();
  for (let index = 1; index < optionEnd; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('Linux process observer option is invalid');
    }
    if (options.has(name)) throw new Error(`Linux process observer option ${name} is duplicated`);
    options.set(name, value);
  }
  const common = {
    interface_name: networkInterface(required(options, '--interface')),
    nic_capacity_bps: positiveInteger(required(options, '--nic-bps'), 'NIC capacity'),
    sample_interval_ms: boundedInteger(
      required(options, '--sample-ms'),
      100,
      10_000,
      'sample interval'
    ),
    result_path: absolutePath(required(options, '--result'), 'result path')
  };
  if (mode === 'pid') {
    exactOptions(options, [
      '--pid',
      '--duration-seconds',
      '--interface',
      '--nic-bps',
      '--sample-ms',
      '--result'
    ]);
    if (separator >= 0) throw new Error('Linux PID observer does not accept a command');
    return {
      mode,
      pid: positiveInteger(required(options, '--pid'), 'PID'),
      duration_seconds: boundedInteger(
        required(options, '--duration-seconds'),
        1,
        86_400,
        'duration'
      ),
      ...common
    };
  }

  exactOptions(options, [
    '--interface',
    '--nic-bps',
    '--sample-ms',
    '--result'
  ]);
  if (separator < 0 || separator + 1 >= args.length) {
    throw new Error('Linux command observer requires -- and an absolute executable');
  }
  const executable = absolutePath(args[separator + 1], 'absolute executable');
  const commandArgs = args.slice(separator + 2);
  for (const value of commandArgs) {
    if (value.includes('\u0000')) throw new Error('Linux observed command argument is invalid');
  }
  return {
    mode,
    executable,
    args: [...commandArgs],
    ...common
  };
}

export async function observeLinuxPidForDuration(
  input: Omit<LinuxPidObserverArgs, 'mode'>
): Promise<LinuxPidObservationEvidence> {
  linuxOnly();
  await ensureResultDoesNotExist(input.result_path);
  const observer = observerFor(input.pid, input);
  await observer.start();
  await delay(input.duration_seconds * 1_000);
  const observation = await observer.stop();
  const evidence: LinuxPidObservationEvidence = {
    schema_version: '1.0.0',
    mode: 'pid',
    observed_pid: input.pid,
    duration_seconds: input.duration_seconds,
    ...observation
  };
  await writePrivateResult(input.result_path, evidence);
  return evidence;
}

export async function runObservedLinuxCommand(
  input: Omit<LinuxCommandObserverArgs, 'mode'>
): Promise<LinuxCommandObservationEvidence> {
  linuxOnly();
  await ensureResultDoesNotExist(input.result_path);
  const [executableSha256, commandArgsSha256] = await Promise.all([
    sha256LinuxExecutable(input.executable),
    Promise.resolve(hashLinuxCommandArguments(input.args))
  ]);
  const child = spawn(input.executable, input.args, {
    stdio: 'inherit',
    shell: false
  });
  if (!child.pid) throw new Error('Linux observed command did not start');
  const observer = observerFor(child.pid, input);
  await observer.start();
  const completion = await new Promise<{ code: number; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({
        code: code ?? -1,
        signal
      }));
    }
  );
  const observation = await observer.stop();
  const evidence: LinuxCommandObservationEvidence = {
    schema_version: '1.1.0',
    mode: 'run',
    observed_pid: child.pid,
    executable: input.executable,
    executable_sha256: executableSha256,
    command_arg_count: input.args.length,
    command_args_sha256: commandArgsSha256,
    exit_code: completion.code,
    signal: completion.signal,
    ...observation
  };
  await writePrivateResult(input.result_path, evidence);
  return evidence;
}

async function main(): Promise<void> {
  const parsed = parseLinuxProcessObserverArgs(process.argv.slice(2));
  const evidence = parsed.mode === 'pid'
    ? await observeLinuxPidForDuration(parsed)
    : await runObservedLinuxCommand(parsed);
  process.stdout.write(`${JSON.stringify({
    status: 'observed',
    mode: evidence.mode,
    observed_pid: evidence.observed_pid,
    result_path: parsed.result_path
  })}\n`);
  if (evidence.mode === 'run' && evidence.exit_code !== 0) {
    process.exitCode = evidence.exit_code > 0 && evidence.exit_code <= 255
      ? evidence.exit_code
      : 1;
  }
}

function observerFor(
  pid: number,
  input: {
    interface_name: string;
    nic_capacity_bps: number;
    sample_interval_ms: number;
  }
): LinuxProcessTreeObserver {
  return new LinuxProcessTreeObserver({
    root_pid: pid,
    interface_name: input.interface_name,
    nic_capacity_bps: input.nic_capacity_bps,
    sample_interval_ms: input.sample_interval_ms
  });
}

async function ensureResultDoesNotExist(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error('Linux process observation result already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function writePrivateResult(path: string, value: object): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Linux process observation result already exists');
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function exactOptions(options: ReadonlyMap<string, string>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(`Linux process observer option ${name} is unknown`);
  }
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`Linux process observer option ${name} is required`);
  return value;
}

function networkInterface(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$/.test(value)) {
    throw new Error('Linux process observer interface is invalid');
  }
  return value;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || /[\r\n\u0000]/.test(value) || value.split('/').includes('..')) {
    throw new Error(`Linux process observer ${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Linux process observer ${label} is invalid`);
  }
  return parsed;
}

function boundedInteger(
  value: string,
  minimum: number,
  maximum: number,
  label: string
): number {
  const parsed = positiveInteger(value, label);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`Linux process observer ${label} is invalid`);
  }
  return parsed;
}

function linuxOnly(): void {
  if (process.platform !== 'linux') {
    throw new Error('Linux process observation requires Linux procfs');
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
