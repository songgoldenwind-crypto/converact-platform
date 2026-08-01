import { resolveFabricEnv } from './config/converact-env.js';
import { initPostgres, closePostgres } from './db-pg.js';
import { PgSyncDatabase } from './db-pg-sync.js';
import { createServer } from './http.js';
import { initWebSocket, wsBroadcast } from './ws.js';
import { connectNats } from './infra/nats-client.js';
import { startCallCenterRuntime } from './agent-runtime/call-center/call-center-runtime.js';
import { startConveractFabricApplication } from './agent-runtime/converact/application.js';
import { createConfiguredPlacementFoundation } from './agent-runtime/converact/placement/index.js';
import {
  rustDeskOwnerBindingPrepareClientFromEnv
} from './agent-runtime/converact/placement/rustdesk-owner-binding.js';
import {
  ConveractFabricTenantEventStore,
  converactFabricEventReplayEnabled
} from './agent-runtime/converact/tenant-event-store.js';
import { migrateIvrRuntimeTables } from './db-migrations/ivr-runtime-schema.js';
import { validateEnvOrExit } from './env-config.js';
import { shutdownOpenTelemetry } from './telemetry.js';
import { startConfiguredAuthJwksLifecycle } from './middleware/auth.js';

// Fail-fast on missing required env vars (production) / warn (other envs).
validateEnvOrExit();

// Last-resort safety net: any Promise rejection that slips past a .catch
// becomes an unhandledRejection, which Node's default behavior escalates to
// process termination. Since call-center paths fire-and-forget several
// promises (compliance logging, webhook dispatch, RWI event handling, cache
// writes), a single unguarded rejection could crash the whole server.
// Log with an errorId so ops can correlate; do NOT exit — the process may
// still be serving other healthy requests. Skipped in tests so intentional
// rejections in test doubles do not pollute stderr.
if (process.env.NODE_ENV !== 'test') {
  process.on('unhandledRejection', (reason) => {
    const errorId = `ur_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    console.error(`[unhandledRejection] ${errorId}`, reason);
  });
}
process.on('uncaughtException', (error) => {
  const errorId = `uc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  console.error(`[uncaughtException] ${errorId}`, error);
  // An uncaught exception leaves the process in an indeterminate state.
  // Exit after logging so the supervisor restarts cleanly; do not continue
  // serving on potentially-corrupted state.
  process.exit(1);
});
const port = Number(process.env.PORT || 3000);

async function main() {
  // Production: Postgres is the only data store (via PgSyncDatabase).
  // SQLite is used only in tests (createDatabase(':memory:') in test files).
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error('[db] FATAL: DATABASE_URL or PGHOST/PGDATABASE/PGUSER is required.');
    process.exit(1);
  }

  console.log('[db] using Postgres via PgSyncDatabase');
  const pg = await initPostgres();
  if (!pg) {
    console.error('[db] FATAL: cannot connect to Postgres');
    process.exit(1);
  }

  console.log('[postgres] migrations applied');
  const authJwksLifecycle = await startConfiguredAuthJwksLifecycle();

  // PgSyncDatabase makes run/one/all (from db.ts) work against Postgres synchronously.
  // Existing 72 stores call run(db, sql, params) — zero changes needed.
  const db = new PgSyncDatabase();
  migrateIvrRuntimeTables(db);

  const instanceId = resolveFabricEnv(process.env, 'INSTANCE_ID') ||
    process.env.HOSTNAME ||
    `converact-${process.pid}`;
  process.env.CONVERACT_FABRIC_INSTANCE_ID = instanceId;
  const placement = createConfiguredPlacementFoundation({
    pg,
    instance_id: instanceId
  });
  const rustdeskOwnerBindings = rustDeskOwnerBindingPrepareClientFromEnv();
  const server = createServer(db, pg, {
    converactFabricMedia: {
      placement: placement?.media,
      egressPlacement: placement?.egress
    },
    converactFabricChat: {
      tinodePlacement: placement?.tinode,
      placementWorkerId: placement?.worker_id
    },
    collaboration: {
      rustdeskPlacement: placement?.rustdesk,
      ...(rustdeskOwnerBindings ? { rustdeskOwnerBindings } : {}),
      placementWorkerId: placement?.worker_id
    }
  });
  initWebSocket(server, converactFabricEventReplayEnabled()
    ? { eventStore: new ConveractFabricTenantEventStore(pg) }
    : {});
  const converactFabricApplication = startConveractFabricApplication({
    pg,
    instanceId,
    placement: placement || undefined
  });

  void connectNats().catch((error) => {
    console.warn('[nats] optional connect skipped:', error instanceof Error ? error.message : error);
  });

  void startCallCenterRuntime(db, {}).catch((error) => {
    console.error('[call-center] runtime failed to start:', error);
  });

  server.listen(port, () => {
    console.log(`Converact Platform running at http://localhost:${port}`);
  });

  const shutdown = async () => {
    server.close();
    authJwksLifecycle?.stop();
    await converactFabricApplication.stop();
    db.close();
    await closePostgres();
    await shutdownOpenTelemetry();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  console.error('[startup] FATAL:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
