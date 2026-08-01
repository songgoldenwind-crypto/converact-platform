import { resolveFabricEnv } from './config/converact-env.js';
import { startConveractFabricApplication } from './agent-runtime/converact/application.js';
import {
  createConveractFabricHttpServer,
  type ConveractFabricHttpServerInput
} from './agent-runtime/converact/http-server.js';
import {
  loadConveractFabricInternalTlsConfig
} from './agent-runtime/converact/internal-tls.js';
import { createConveractFabricMediaHooks } from './agent-runtime/converact/media-hooks.js';
import { createConfiguredPlacementFoundation } from './agent-runtime/converact/placement/index.js';
import {
  rustDeskOwnerBindingPrepareClientFromEnv
} from './agent-runtime/converact/placement/rustdesk-owner-binding.js';
import {
  createConfiguredRealtimeAudioTapRuntime
} from './agent-runtime/converact/voice/realtime-audio-tap-runtime.js';
import {
  createConfiguredWebPhoneExtensionSessionService
} from './agent-runtime/converact/voice/webphone-session-service.js';
import {
  ConveractFabricTenantEventStore,
  converactFabricEventReplayEnabled
} from './agent-runtime/converact/tenant-event-store.js';
import { closePostgres, initPostgres } from './db-pg.js';
import { PgSyncDatabase } from './db-pg-sync.js';
import { validateEnvOrExit } from './env-config.js';
import {
  startConfiguredAuthJwksLifecycle,
  type AuthJwksLifecycle
} from './middleware/auth.js';
import { createObjectStorage } from './storage/object-storage.js';
import { initWebSocket } from './ws.js';
import { shutdownOpenTelemetry } from './telemetry.js';

validateEnvOrExit();

if (process.env.NODE_ENV !== 'test') {
  process.on('unhandledRejection', (reason) => {
    console.error('[converact-fabric] unhandled rejection', reason);
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    throw new Error('DATABASE_URL or PGHOST/PGDATABASE/PGUSER is required');
  }
  const internalTls = loadConveractFabricInternalTlsConfig();
  createObjectStorage();
  const pg = await initPostgres();
  if (!pg) throw new Error('cannot connect to Postgres');

  const instanceId = resolveFabricEnv(process.env, 'INSTANCE_ID') || process.env.HOSTNAME || `converact-fabric-${process.pid}`;
  process.env.CONVERACT_FABRIC_INSTANCE_ID = instanceId;
  const db = new PgSyncDatabase();
  let application: ReturnType<typeof startConveractFabricApplication> | null = null;
  let realtimeAudioTap:
    ReturnType<typeof createConfiguredRealtimeAudioTapRuntime> | null = null;
  let server: ReturnType<typeof createConveractFabricHttpServer> | null = null;
  let internalServer: ReturnType<typeof createConveractFabricHttpServer> | null = null;
  let authJwksLifecycle: AuthJwksLifecycle | null = null;
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
        if (internalServer) {
          try {
            await closeHttpServer(internalServer);
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
          authJwksLifecycle?.stop();
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
        try {
          await shutdownOpenTelemetry();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'Converact Fabric shutdown failed');
      })();
    }
    return shutdownPromise;
  };

  const exitAfterShutdown = () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error('[converact-fabric-shutdown] FATAL:', error);
        process.exit(1);
      }
    );
  };
  process.on('SIGINT', exitAfterShutdown);
  process.on('SIGTERM', exitAfterShutdown);

  try {
    authJwksLifecycle = await startConfiguredAuthJwksLifecycle();
    const placement = createConfiguredPlacementFoundation({
      pg,
      instance_id: instanceId
    });
    const rustdeskOwnerBindings = rustDeskOwnerBindingPrepareClientFromEnv();
    const webphoneSessions = createConfiguredWebPhoneExtensionSessionService(pg);
    application = startConveractFabricApplication({
      pg,
      instanceId,
      placement: placement || undefined
    });
    realtimeAudioTap = createConfiguredRealtimeAudioTapRuntime({
      pg,
      projection: application.realtimeSpeechProjection
    });
    await realtimeAudioTap.start();
    const serverInput: ConveractFabricHttpServerInput = {
      db,
      pg,
      mediaOptions: {
        ...createConveractFabricMediaHooks({ db, pg }),
        placement: placement?.media,
        egressPlacement: placement?.egress,
        placementWorkerId: placement?.worker_id,
        realtime_audio_tap_grants: realtimeAudioTap.grants,
        livekit_realtime_audio_tap_gateway_url:
          resolveFabricEnv(process.env, 'LIVEKIT_AUDIO_TAP_GATEWAY_URL'),
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
    };
    server = createConveractFabricHttpServer(serverInput);
    initWebSocket(server, converactFabricEventReplayEnabled()
      ? { eventStore: new ConveractFabricTenantEventStore(pg) }
      : {});
    const port = Number(process.env.PORT || 3000);
    if (internalTls?.port === port) {
      throw new Error('CONVERACT_FABRIC_INTERNAL_TLS_PORT must differ from PORT');
    }
    await listenHttpServer(server, port);
    console.log(`Converact Fabric communication runtime running at http://localhost:${port}`);
    if (internalTls) {
      internalServer = createConveractFabricHttpServer({
        ...serverInput,
        tls: internalTls.tls
      });
      await listenHttpServer(internalServer, internalTls.port);
      console.log(
        `Converact Fabric internal mTLS endpoint running at https://localhost:${internalTls.port}`
      );
    }
  } catch (error) {
    await shutdown().catch((shutdownError) => {
      throw new AggregateError(
        [error, shutdownError],
        'Converact Fabric startup and cleanup failed'
      );
    });
    throw error;
  }
}

function listenHttpServer(
  server: ReturnType<typeof createConveractFabricHttpServer>,
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
  server: ReturnType<typeof createConveractFabricHttpServer>
): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

void main().catch((error) => {
  console.error('[converact-fabric-startup] FATAL:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
