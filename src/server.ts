import { initPostgres, closePostgres } from './db-pg.js';
import { PgSyncDatabase } from './db-pg-sync.js';
import { createServer } from './http.js';
import { initWebSocket, wsBroadcast } from './ws.js';
import { connectNats } from './infra/nats-client.js';
import { startCallCenterRuntime } from './agent-runtime/call-center/call-center-runtime.js';
import { startIveKitApplication } from './agent-runtime/ivekit/application.js';
import {
  IveKitTenantEventStore,
  iveKitEventReplayEnabled
} from './agent-runtime/ivekit/tenant-event-store.js';
import { migrateIvrRuntimeTables } from './db-migrations/ivr-runtime-schema.js';
import { validateEnvOrExit } from './env-config.js';

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

  // PgSyncDatabase makes run/one/all (from db.ts) work against Postgres synchronously.
  // Existing 72 stores call run(db, sql, params) — zero changes needed.
  const db = new PgSyncDatabase();
  migrateIvrRuntimeTables(db);

  const server = createServer(db, pg);
  initWebSocket(server, iveKitEventReplayEnabled()
    ? { eventStore: new IveKitTenantEventStore(pg) }
    : {});
  const iveKitApplication = startIveKitApplication({ pg, publish: wsBroadcast });

  void connectNats().catch((error) => {
    console.warn('[nats] optional connect skipped:', error instanceof Error ? error.message : error);
  });

  void startCallCenterRuntime(db, {}).catch((error) => {
    console.error('[call-center] runtime failed to start:', error);
  });

  server.listen(port, () => {
    console.log(`OPC AI 通信平台 running at http://localhost:${port}`);
  });

  const shutdown = async () => {
    server.close();
    await iveKitApplication.stop();
    db.close();
    await closePostgres();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  console.error('[startup] FATAL:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
