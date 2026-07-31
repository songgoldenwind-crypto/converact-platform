import { fileURLToPath } from 'node:url';

import {
  recoverRustPbxRuntime,
  rustPbxRecoveryOptionsFromEnv
} from './agent-runtime/ivekit/voice/rustpbx-recovery.js';

export * from './agent-runtime/ivekit/voice/rustpbx-recovery.js';

export async function runRustPbxRecovery(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const result = await recoverRustPbxRuntime(rustPbxRecoveryOptionsFromEnv(env));
  console.log(JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runRustPbxRecovery().catch((error) => {
    console.error(error instanceof Error ? error.message : 'RustPBX runtime recovery failed');
    process.exitCode = 1;
  });
}
