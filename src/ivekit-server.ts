import { startIveKitApplication } from './agent-runtime/ivekit/application.js';
import { createIveKitHttpServer } from './agent-runtime/ivekit/http-server.js';
import { createIveKitMediaHooks } from './agent-runtime/ivekit/media-hooks.js';
import { createConfiguredPlacementFoundation } from './agent-runtime/ivekit/placement/index.js';
import {
  rustDeskOwnerBindingPrepareClientFromEnv
} from './agent-runtime/ivekit/placement/rustdesk-owner-binding.js';
import {
  createConfiguredWebPhoneExtensionSessionService
} from './agent-runtime/ivekit/voice/webphone-session-service.js';
import {
  IveKitTenantEventStore,
  iveKitEventReplayEnabled
} from './agent-runtime/ivekit/tenant-event-store.js';
import { closePostgres, initPostgres } from './db-pg.js';
import { PgSyncDatabase } from './db-pg-sync.js';
import { validateEnvOrExit } from './env-config.js';
import { createObjectStorage } from './storage/object-storage.js';
import { initWebSocket } from './ws.js';

validateEnvOrExit();

if (process.env.NODE_ENV !== 'test') {
  process.on('unhandledRejection', (reason) => {
    console.error('[ivekit] unhandled rejection', reason);
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    throw new Error('DATABASE_URL or PGHOST/PGDATABASE/PGUSER is required');
  }
  createObjectStorage();
  const pg = await initPostgres();
  if (!pg) throw new Error('cannot connect to Postgres');

  const instanceId = process.env.OPC_IVEKIT_INSTANCE_ID || process.env.HOSTNAME || `ivekit-${process.pid}`;
  process.env.OPC_IVEKIT_INSTANCE_ID = instanceId;
  const db = new PgSyncDatabase();
  const placement = createConfiguredPlacementFoundation({
    pg,
    instance_id: instanceId
  });
  const rustdeskOwnerBindings = rustDeskOwnerBindingPrepareClientFromEnv();
  const webphoneSessions = createConfiguredWebPhoneExtensionSessionService(pg);
  const server = createIveKitHttpServer({
    db,
    pg,
    mediaOptions: {
      ...createIveKitMediaHooks({ db, pg }),
      placement: placement?.media,
      egressPlacement: placement?.egress,
      placementWorkerId: placement?.worker_id
    },
    chatOptions: {
      tinodePlacement: placement?.tinode,
      placementWorkerId: placement?.worker_id
    },
    collaborationOptions: {
      rustdeskPlacement: placement?.rustdesk,
      ...(rustdeskOwnerBindings ? { rustdeskOwnerBindings } : {}),
      placementWorkerId: placement?.worker_id
    },
    voiceOptions: {
      placement: placement?.voice,
      extension_sessions: webphoneSessions
    },
    placementReadinessProbe: placement?.runtime
  });
  initWebSocket(server, iveKitEventReplayEnabled()
    ? { eventStore: new IveKitTenantEventStore(pg) }
    : {});
  const application = startIveKitApplication({ pg, instanceId, placement: placement || undefined });
  const port = Number(process.env.PORT || 3000);
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        const errors: unknown[] = [];
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          await application.stop();
        } catch (error) {
          errors.push(error);
        }
        try {
          db.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await closePostgres();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'iveKit shutdown failed');
      })();
    }
    return shutdownPromise;
  };

  const exitAfterShutdown = () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error('[ivekit-shutdown] FATAL:', error);
        process.exit(1);
      }
    );
  };
  process.on('SIGINT', exitAfterShutdown);
  process.on('SIGTERM', exitAfterShutdown);
  server.listen(port, () => {
    console.log(`iveKit communication platform running at http://localhost:${port}`);
  });
}

void main().catch((error) => {
  console.error('[ivekit-startup] FATAL:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
