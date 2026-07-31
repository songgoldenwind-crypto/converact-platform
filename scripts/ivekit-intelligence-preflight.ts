import { fileURLToPath } from 'node:url';

import {
  inspectIveKitIntelligenceEnv,
  type IveKitIntelligencePreflightReport
} from '../src/agent-runtime/converact/intelligence-preflight.js';

export { inspectIveKitIntelligenceEnv, type IveKitIntelligencePreflightReport };

function main(): void {
  const report = inspectIveKitIntelligenceEnv(process.env);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
