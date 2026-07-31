import { fileURLToPath } from 'node:url';

import {
  bootstrapTinodeServiceAccount,
  tinodeServiceAccountBootstrapConfigFromEnv
} from '../src/agent-runtime/collaboration/tinode-service-account-bootstrap.js';

export {
  bootstrapTinodeServiceAccount,
  promoteTinodeBasicAccountToRoot,
  tinodeServiceAccountBootstrapConfigFromEnv
} from '../src/agent-runtime/collaboration/tinode-service-account-bootstrap.js';

async function main(): Promise<void> {
  const result = await bootstrapTinodeServiceAccount(
    tinodeServiceAccountBootstrapConfigFromEnv(process.env)
  );
  console.log(`Tinode service account ${result.status}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
