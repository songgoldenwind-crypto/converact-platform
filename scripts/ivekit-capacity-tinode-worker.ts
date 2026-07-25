#!/usr/bin/env -S node --import tsx

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  executeTinodeCapacityWorkerInput,
  type TinodeCapacityWorkerInput
} from './capacity/generators/tinode-worker.js';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

export async function runTinodeCapacityWorkerCli(
  argv: string[] = process.argv.slice(2),
  stdin: NodeJS.ReadableStream = process.stdin
): Promise<void> {
  const resultPath = parseArguments(argv);
  const input = await readInput(stdin);
  if (input.result_path !== resultPath) {
    throw new Error('Tinode capacity result path does not match the worker command');
  }
  const result = await executeTinodeCapacityWorkerInput(input);
  const temporary = join(
    dirname(resultPath),
    `.tinode-result-${process.pid}-${Date.now()}.tmp`
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(result)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    renameSync(temporary, resultPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseArguments(argv: string[]): string {
  if (argv.length !== 5 || argv[0] !== 'run' ||
      argv[1] !== '--input-json' || argv[2] !== '-' ||
      argv[3] !== '--result') {
    throw new Error('usage: ivekit-capacity-tinode-worker run --input-json - --result <absolute-path>');
  }
  const path = String(argv[4] || '');
  if (!path.startsWith('/') || /[\r\n\0]/.test(path) ||
      path.split('/').includes('..')) {
    throw new Error('Tinode capacity result path must be absolute');
  }
  return path;
}

async function readInput(stdin: NodeJS.ReadableStream): Promise<TinodeCapacityWorkerInput> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Tinode capacity worker input is too large');
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new Error('Tinode capacity worker input is not valid JSON');
  }
  return parsed as TinodeCapacityWorkerInput;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTinodeCapacityWorkerCli().catch((error) => {
    process.stderr.write(
      `Tinode capacity worker failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
