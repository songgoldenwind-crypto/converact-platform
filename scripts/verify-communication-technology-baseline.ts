import { verifyCommunicationTechnologyBaseline } from './lib/communication-technology-baseline.js';

async function main() {
  const result = await verifyCommunicationTechnologyBaseline(process.cwd());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`communication technology baseline verification failed: ${message}\n`);
  process.exitCode = 1;
});
