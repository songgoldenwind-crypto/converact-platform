import {
  RustPbxRecordingSpoolWorker,
  rustPbxRecordingSpoolWorkerConfigFromEnv
} from './agent-runtime/converact/recordings/index.js';

const pollIntervalMs = envInteger(
  process.env.OPC_IVEKIT_RECORDING_POLL_INTERVAL_MS,
  1_000,
  100,
  60_000,
  'OPC_IVEKIT_RECORDING_POLL_INTERVAL_MS'
);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { stopping = true; });
}

async function main(): Promise<void> {
  const worker = await RustPbxRecordingSpoolWorker.open(
    rustPbxRecordingSpoolWorkerConfigFromEnv()
  );
  try {
    while (!stopping) {
      try {
        await worker.pollOnce();
      } catch (error) {
        console.error(
          '[ivekit-recording-spool] poll failed:',
          error instanceof Error ? error.message : String(error)
        );
      }
      if (!stopping) await delay(pollIntervalMs);
    }
  } finally {
    await worker.close();
  }
}

function envInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string
): number {
  const number = Number(value === undefined || value === '' ? fallback : value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} is invalid`);
  }
  return number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(
    '[ivekit-recording-spool] fatal:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
