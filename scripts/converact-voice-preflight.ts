import { fileURLToPath } from 'node:url';

import { runConveractFabricVoicePreflight } from '../src/converact-voice-preflight.js';

export { inspectConveractFabricVoice } from '../src/agent-runtime/converact/voice/preflight.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runConveractFabricVoicePreflight().catch(() => { process.exitCode = 1; });
}
