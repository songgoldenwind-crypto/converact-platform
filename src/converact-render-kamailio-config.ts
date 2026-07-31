import { pathToFileURL } from 'node:url';

import {
  loadKamailioConfigRuntime,
  writeKamailioConfigRuntime
} from './agent-runtime/converact/voice/kamailio-config.js';

export * from './agent-runtime/converact/voice/kamailio-config.js';

export async function runKamailioConfigRenderer(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const runtime = await loadKamailioConfigRuntime(env);
  await writeKamailioConfigRuntime(runtime);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runKamailioConfigRenderer().catch((error) => {
    console.error(
      '[ivekit-render-kamailio-config] FATAL:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
