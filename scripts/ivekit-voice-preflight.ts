import { fileURLToPath } from 'node:url';

import { runIveKitVoicePreflight } from '../src/ivekit-voice-preflight.js';

export { inspectIveKitVoice } from '../src/agent-runtime/ivekit/voice/preflight.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runIveKitVoicePreflight().catch(() => { process.exitCode = 1; });
}
