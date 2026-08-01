import { inspectConveractFabricIntelligenceEnv } from './agent-runtime/converact/intelligence-preflight.js';

const report = inspectConveractFabricIntelligenceEnv(process.env);
console.log(JSON.stringify(report, null, 2));
if (!report.ready) process.exitCode = 1;
