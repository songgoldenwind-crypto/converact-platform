import { runKamailioWebPhoneAcceptanceFromEnv } from './agent-runtime/converact/voice/kamailio-webphone-acceptance.js';

runKamailioWebPhoneAcceptanceFromEnv().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
