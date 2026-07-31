import {
  bootstrapTinodeServiceAccount,
  tinodeServiceAccountBootstrapConfigFromEnv
} from './agent-runtime/collaboration/tinode-service-account-bootstrap.js';

async function main(): Promise<void> {
  const result = await bootstrapTinodeServiceAccount(
    tinodeServiceAccountBootstrapConfigFromEnv(process.env)
  );
  console.log(`Tinode service account ${result.status}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
