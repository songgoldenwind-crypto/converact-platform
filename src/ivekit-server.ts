import { startIveKitApplication } from './agent-runtime/ivekit/application.js';
import { createIveKitHttpServer } from './agent-runtime/ivekit/http-server.js';
import { createIveKitMediaHooks } from './agent-runtime/ivekit/media-hooks.js';
import { createConfiguredPlacementFoundation } from './agent-runtime/ivekit/placement/index.js';
import {
  rustDeskOwnerBindingPrepareClientFromEnv
} from './agent-runtime/ivekit/placement/rustdesk-owner-binding.js';
import {
  createConfiguredRealtimeAudioTapRuntime
} from './agent-runtime/ivekit/voice/realtime-audio-tap-runtime.js';
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
import { shutdownOpenTelemetry } from './telemetry.js';

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
  let application: ReturnType<typeof startIveKitApplication> | null = null;
  let realtimeAudioTap:
    ReturnType<typeof createConfiguredRealtimeAudioTapRuntime> | null = null;
  let server: ReturnType<typeof createIveKitHttpServer> | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        const errors: unknown[] = [];
        if (server) {
          try {
            await closeHttpServer(server);
          } catch (error) {
            errors.push(error);
          }
        }
        if (realtimeAudioTap) {
          try {
            await realtimeAudioTap.stop();
          } catch (error) {
            errors.push(error);
          }
        }
        if (application) {
          try {
            await application.stop();
          } catch (error) {
            errors.push(error);
          }
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
        try {
          await shutdownOpenTelemetry();
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

  try {
    const placement = createConfiguredPlacementFoundation({
      pg,
      instance_id: instanceId
    });
    const rustdeskOwnerBindings = rustDeskOwnerBindingPrepareClientFromEnv();
    const webphoneSessions = createConfiguredWebPhoneExtensionSessionService(pg);
    application = startIveKitApplication({
      pg,
      instanceId,
      placement: placement || undefined
    });
    realtimeAudioTap = createConfiguredRealtimeAudioTapRuntime({
      pg,
      projection: application.realtimeSpeechProjection
    });
    await realtimeAudioTap.start();
    server = createIveKitHttpServer({
      db,
      pg,
      mediaOptions: {
        ...createIveKitMediaHooks({ db, pg }),
        placement: placement?.media,
        egressPlacement: placement?.egress,
        placementWorkerId: placement?.worker_id,
        realtime_audio_tap_grants: realtimeAudioTap.grants,
        livekit_realtime_audio_tap_gateway_url:
          process.env.OPC_IVEKIT_LIVEKIT_AUDIO_TAP_GATEWAY_URL,
        ...(realtimeAudioTap.livekit_authorizer ? {
          livekit_realtime_audio_tap_authorizer:
            realtimeAudioTap.livekit_authorizer
        } : {})
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
        extension_sessions: webphoneSessions,
        realtime_audio_tap_grants: realtimeAudioTap.grants,
        ...(realtimeAudioTap.authorizer ? {
          realtime_audio_tap_authorizer: realtimeAudioTap.authorizer
        } : {})
      },
      placementReadinessProbe: placement?.runtime
    });
    initWebSocket(server, iveKitEventReplayEnabled()
      ? { eventStore: new IveKitTenantEventStore(pg) }
      : {});
    const port = Number(process.env.PORT || 3000);
    await listenHttpServer(server, port);
    console.log(`iveKit communication platform running at http://localhost:${port}`);
  } catch (error) {
    await shutdown().catch((shutdownError) => {
      throw new AggregateError(
        [error, shutdownError],
        'iveKit startup and cleanup failed'
      );
    });
    throw error;
  }
}

function listenHttpServer(
  server: ReturnType<typeof createIveKitHttpServer>,
  port: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

function closeHttpServer(
  server: ReturnType<typeof createIveKitHttpServer>
): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

void main().catch((error) => {
  console.error('[ivekit-startup] FATAL:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
