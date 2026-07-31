import { fileURLToPath } from 'node:url';

import { runRustPbxConfigRenderer } from '../src/converact-render-rustpbx-config.js';

export * from '../src/agent-runtime/converact/voice/rustpbx-config.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runRustPbxConfigRenderer();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
