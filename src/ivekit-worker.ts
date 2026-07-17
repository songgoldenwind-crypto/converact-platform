import { startIveKitApplication } from './agent-runtime/ivekit/application.js';
import { closePostgres, initPostgres } from './db-pg.js';
import { validateEnvOrExit } from './env-config.js';

validateEnvOrExit();

if (process.env.NODE_ENV !== 'test') {
  process.on('unhandledRejection', (reason) => {
    console.error('[ivekit-worker] unhandled rejection', reason);
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    throw new Error('DATABASE_URL or PGHOST/PGDATABASE/PGUSER is required');
  }
  const pg = await initPostgres();
  if (!pg) throw new Error('cannot connect to Postgres');
  const instanceId = process.env.OPC_IVEKIT_INSTANCE_ID ||
    process.env.HOSTNAME || `ivekit-worker-${process.pid}`;
  process.env.OPC_IVEKIT_INSTANCE_ID = instanceId;
  const application = startIveKitApplication({ pg, instanceId });
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        const errors: unknown[] = [];
        try {
          await application.stop();
        } catch (error) {
          errors.push(error);
        }
        try {
          await closePostgres();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) {
          throw new AggregateError(errors, 'iveKit worker shutdown failed');
        }
      })();
    }
    return shutdownPromise;
  };

  const exitAfterShutdown = () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error('[ivekit-worker-shutdown] FATAL:', error);
        process.exit(1);
      }
    );
  };
  process.on('SIGINT', exitAfterShutdown);
  process.on('SIGTERM', exitAfterShutdown);
  console.log(`iveKit worker ${instanceId} started`);
}

void main().catch((error) => {
  console.error(
    '[ivekit-worker-startup] FATAL:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
