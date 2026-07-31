import {
  loadKamailioConfigRuntime,
  writeKamailioConfigRuntime
} from '../src/agent-runtime/converact/voice/kamailio-config.js';

async function main() {
  const runtime = await loadKamailioConfigRuntime(process.env);
  await writeKamailioConfigRuntime(runtime);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`Kamailio config render failed: ${message}\n`);
  process.exitCode = 1;
});
