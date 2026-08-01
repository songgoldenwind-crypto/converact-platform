import { resolveFabricEnv } from './config/converact-env.js';
import { startConveractFabricApplication } from './agent-runtime/converact/application.js';
import { closePostgres, initPostgres } from './db-pg.js';
import { validateEnvOrExit } from './env-config.js';
import { shutdownOpenTelemetry } from './telemetry.js';

validateEnvOrExit();

if (process.env.NODE_ENV !== 'test') {
  process.on('unhandledRejection', (reason) => {
    console.error('[converact-fabric-worker] unhandled rejection', reason);
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    throw new Error('DATABASE_URL or PGHOST/PGDATABASE/PGUSER is required');
  }
  const pg = await initPostgres();
  if (!pg) throw new Error('cannot connect to Postgres');
  const instanceId = resolveFabricEnv(process.env, 'INSTANCE_ID') ||
    process.env.HOSTNAME || `converact-fabric-worker-${process.pid}`;
  process.env.CONVERACT_FABRIC_INSTANCE_ID = instanceId;
  const application = startConveractFabricApplication({ pg, instanceId });
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
        try {
          await shutdownOpenTelemetry();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) {
          throw new AggregateError(errors, 'Converact Fabric worker shutdown failed');
        }
      })();
    }
    return shutdownPromise;
  };

  const exitAfterShutdown = () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error('[converact-fabric-worker-shutdown] FATAL:', error);
        process.exit(1);
      }
    );
  };
  process.on('SIGINT', exitAfterShutdown);
  process.on('SIGTERM', exitAfterShutdown);
  console.log(`Converact Fabric worker ${instanceId} started`);
}

void main().catch((error) => {
  console.error(
    '[converact-fabric-worker-startup] FATAL:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
