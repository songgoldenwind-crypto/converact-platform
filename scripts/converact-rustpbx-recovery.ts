import { fileURLToPath } from 'node:url';

import { runRustPbxRecovery } from '../src/converact-rustpbx-recovery.js';

export * from '../src/agent-runtime/converact/voice/rustpbx-recovery.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runRustPbxRecovery().catch((error) => {
    console.error(error instanceof Error ? error.message : 'RustPBX runtime recovery failed');
    process.exitCode = 1;
  });
}
