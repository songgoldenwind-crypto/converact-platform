import { pathToFileURL } from 'node:url';

import {
  componentNodeAdmissionRuntimeConfig,
  runComponentNodeAdmission
} from '../src/converact-component-node-admission.js';

export * from '../src/converact-component-node-admission.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runComponentNodeAdmission(componentNodeAdmissionRuntimeConfig()).catch((error) => {
    console.error(
      '[converact-component-node-admission] FATAL:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
