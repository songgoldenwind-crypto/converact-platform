import { fileURLToPath } from 'node:url';

import { writeRustPbxConfig } from './agent-runtime/converact/voice/rustpbx-config.js';

export * from './agent-runtime/converact/voice/rustpbx-config.js';

export function runRustPbxConfigRenderer(env: NodeJS.ProcessEnv = process.env): void {
  console.log(JSON.stringify(writeRustPbxConfig(env), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runRustPbxConfigRenderer();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
