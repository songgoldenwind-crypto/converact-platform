#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import {
  provisionTinodeCompositeBundle,
  type TinodeCompositeProvisionInput
} from './capacity/generators/tinode-composite-provisioner.js';

async function readInput(stdin: NodeJS.ReadableStream): Promise<TinodeCompositeProvisionInput> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > 1024 * 1024) throw new Error('Tinode provision input exceeds 1 MiB');
    chunks.push(value);
  }
  if (total === 0) throw new Error('Tinode provision input is required');
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as TinodeCompositeProvisionInput;
}

async function main(): Promise<void> {
  const result = await provisionTinodeCompositeBundle(await readInput(process.stdin));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
