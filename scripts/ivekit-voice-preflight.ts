import { fileURLToPath } from 'node:url';

import { inspectIveKitVoice } from '../src/agent-runtime/ivekit/voice/preflight.js';
import { closePostgres, initPostgres } from '../src/db-pg.js';

export { inspectIveKitVoice };

async function main(): Promise<void> {
  let pg = null;
  try {
    pg = await initPostgres();
  } catch {
    pg = null;
  }
  try {
    const report = await inspectIveKitVoice({ pg, env: process.env });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
  } finally {
    if (pg) await closePostgres().catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch(() => { process.exitCode = 1; });
}
