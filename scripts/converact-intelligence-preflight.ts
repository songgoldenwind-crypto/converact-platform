import { fileURLToPath } from 'node:url';

import {
  inspectConveractFabricIntelligenceEnv,
  type ConveractFabricIntelligencePreflightReport
} from '../src/agent-runtime/converact/intelligence-preflight.js';

export { inspectConveractFabricIntelligenceEnv, type ConveractFabricIntelligencePreflightReport };

function main(): void {
  const report = inspectConveractFabricIntelligenceEnv(process.env);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
