import { fileURLToPath } from 'node:url';

import { inspectConveractFabricVoice } from './agent-runtime/converact/voice/preflight.js';
import { closePostgres, initPostgres } from './db-pg.js';

export { inspectConveractFabricVoice };

export async function runConveractFabricVoicePreflight(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  let pg = null;
  try {
    pg = await initPostgres();
  } catch {
    pg = null;
  }
  try {
    const report = await inspectConveractFabricVoice({ pg, env });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
  } finally {
    if (pg) await closePostgres().catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runConveractFabricVoicePreflight().catch(() => { process.exitCode = 1; });
}
