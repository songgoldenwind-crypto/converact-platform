#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import {
  executeTinodeCompositeRunnerInput,
  type TinodeCompositeRunnerInput
} from './capacity/generators/tinode-composite-runner.js';

async function readInput(stdin: NodeJS.ReadableStream): Promise<TinodeCompositeRunnerInput> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > 1024 * 1024) throw new Error('Tinode composite runner input exceeds 1 MiB');
    chunks.push(value);
  }
  if (total === 0) throw new Error('Tinode composite runner input is required');
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as TinodeCompositeRunnerInput;
}

async function main(): Promise<void> {
  const result = await executeTinodeCompositeRunnerInput(await readInput(process.stdin));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.client.status !== 'controlled_pass') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
