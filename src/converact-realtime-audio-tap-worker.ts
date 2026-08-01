import {
  createConveractFabricRealtimeSpeechProjection
} from './agent-runtime/converact/application.js';
import {
  createConfiguredRealtimeAudioTapRuntime
} from './agent-runtime/converact/voice/realtime-audio-tap-runtime.js';
import { closePostgres, initPostgres } from './db-pg.js';
import { validateEnvOrExit } from './env-config.js';
import { shutdownOpenTelemetry } from './telemetry.js';

validateEnvOrExit();

if (process.env.NODE_ENV !== 'test') {
  process.on('unhandledRejection', (reason) => {
    console.error('[converact-fabric-realtime-audio-tap] unhandled rejection', reason);
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    throw new Error('DATABASE_URL or PGHOST/PGDATABASE/PGUSER is required');
  }
  const pg = await initPostgres();
  if (!pg) throw new Error('cannot connect to Postgres');
  let runtime:
    ReturnType<typeof createConfiguredRealtimeAudioTapRuntime> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      const errors: unknown[] = [];
      for (const close of [
        () => runtime?.stop() ?? Promise.resolve(),
        () => closePostgres(),
        () => shutdownOpenTelemetry()
      ]) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, 'realtime audio tap worker shutdown failed');
      }
    })();
    return shutdownPromise;
  };
  const exitAfterShutdown = () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error('[converact-fabric-realtime-audio-tap-shutdown] FATAL:', error);
        process.exit(1);
      }
    );
  };
  process.on('SIGINT', exitAfterShutdown);
  process.on('SIGTERM', exitAfterShutdown);

  try {
    runtime = createConfiguredRealtimeAudioTapRuntime({
      pg,
      projection: createConveractFabricRealtimeSpeechProjection(pg)
    });
    if (!runtime.enabled) {
      throw new Error(
        'realtime audio tap worker requires CONVERACT_FABRIC_REALTIME_AUDIO_TAP_ENABLED=1'
      );
    }
    await runtime.start();
    console.log('Converact Fabric realtime audio tap worker started');
  } catch (error) {
    await shutdown().catch((shutdownError) => {
      throw new AggregateError(
        [error, shutdownError],
        'realtime audio tap worker startup and cleanup failed'
      );
    });
    throw error;
  }
}

void main().catch((error) => {
  console.error(
    '[converact-fabric-realtime-audio-tap-startup] FATAL:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
