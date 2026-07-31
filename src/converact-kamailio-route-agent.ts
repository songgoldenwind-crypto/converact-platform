import { pathToFileURL } from 'node:url';

import {
  loadKamailioRouteAgentRuntimeConfig,
  runKamailioRouteAgent
} from './agent-runtime/converact/voice/kamailio-route-agent.js';

export * from './agent-runtime/converact/voice/kamailio-route-agent.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadKamailioRouteAgentRuntimeConfig()
    .then(runKamailioRouteAgent)
    .catch((error) => {
      console.error(
        '[ivekit-kamailio-route-agent] FATAL:',
        error instanceof Error ? error.message : String(error)
      );
      process.exitCode = 1;
    });
}
