import { verifyComponentGovernance } from './lib/component-governance.js';

const result = await verifyComponentGovernance(process.cwd());
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
