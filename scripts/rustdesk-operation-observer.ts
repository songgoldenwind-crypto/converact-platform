import { resolveBrandEnv } from '../src/config/converact-env.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  normalizeRustDeskOperationObservation,
  type RustDeskNativeOperationObservation
} from '../src/agent-runtime/collaboration/rustdesk-operation-observation.js';
import {
  createRustDeskEventForwarderConfigFromEnv,
  forwardRustDeskEvents,
  type RustDeskEventForwarderConfig
} from './rustdesk-event-forwarder.js';

export { normalizeRustDeskOperationObservation };
export type { RustDeskNativeOperationObservation };

export async function forwardRustDeskOperationObservations(
  observations: RustDeskNativeOperationObservation[],
  config: RustDeskEventForwarderConfig,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  let forwarded = 0;
  for (const observation of observations) {
    const result = await forwardRustDeskEvents({
      ...config,
      inlineEvent: normalizeRustDeskOperationObservation(observation),
      eventFile: undefined,
      replayDeadLetterFile: undefined,
      replayRemainingFile: undefined
    }, fetchImpl);
    forwarded += result.forwarded;
  }
  return forwarded;
}

function loadObservationFile(path: string): RustDeskNativeOperationObservation[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as RustDeskNativeOperationObservation]; }
    catch { throw new Error(`invalid RustDesk observation JSON at ${path}:${index + 1}`); }
  });
}

async function main() {
  const path = String(resolveBrandEnv(process.env, 'RUSTDESK_OBSERVER_FILE') || '').trim();
  if (!path) throw new Error('CONVERACT_RUSTDESK_OBSERVER_FILE is required');
  const observations = loadObservationFile(path);
  const config = createRustDeskEventForwarderConfigFromEnv({
    ...process.env,
    CONVERACT_RUSTDESK_EVENT_EXTERNAL_ID: resolveBrandEnv(process.env, 'RUSTDESK_EVENT_EXTERNAL_ID') || observations[0]?.external_id || ''
  });
  const forwarded = await forwardRustDeskOperationObservations(observations, config);
  console.log(JSON.stringify({ forwarded }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error((error as Error).message); process.exit(1); });
}
