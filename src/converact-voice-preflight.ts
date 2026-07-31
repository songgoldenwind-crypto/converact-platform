import { fileURLToPath } from 'node:url';

import { inspectIveKitVoice } from './agent-runtime/converact/voice/preflight.js';
import { closePostgres, initPostgres } from './db-pg.js';

export { inspectIveKitVoice };

export async function runIveKitVoicePreflight(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  let pg = null;
  try {
    pg = await initPostgres();
  } catch {
    pg = null;
  }
  try {
    const report = await inspectIveKitVoice({ pg, env });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
  } finally {
    if (pg) await closePostgres().catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runIveKitVoicePreflight().catch(() => { process.exitCode = 1; });
}
