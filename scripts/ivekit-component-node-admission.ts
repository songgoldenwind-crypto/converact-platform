import { pathToFileURL } from 'node:url';

import {
  componentNodeAdmissionRuntimeConfig,
  runComponentNodeAdmission
} from '../src/ivekit-component-node-admission.js';

export * from '../src/ivekit-component-node-admission.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runComponentNodeAdmission(componentNodeAdmissionRuntimeConfig()).catch((error) => {
    console.error(
      '[ivekit-component-node-admission] FATAL:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
