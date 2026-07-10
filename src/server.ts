import { initPostgres, closePostgres, runMigrations } from './db-pg.js';
import { PgSyncDatabase } from './db-pg-sync.js';
import { createServer } from './http.js';
import { initWebSocket, wsBroadcast } from './ws.js';
import { connectNats } from './infra/nats-client.js';
import { startCallCenterRuntime } from './agent-runtime/call-center/call-center-runtime.js';
import { startTinodeSyncWorker } from './agent-runtime/collaboration/tinode-sync-worker.js';
import { startAttachmentProcessingWorker } from './agent-runtime/collaboration/attachment-processing-worker.js';
import {
  QualityReviewService,
  configuredQualityReviewProvider
} from './agent-runtime/collaboration/quality-review.js';
import { startQualityReviewWorker } from './agent-runtime/collaboration/quality-review-worker.js';
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
  if (!process.env.DATABASE_URL) {
    console.error('[db] FATAL: DATABASE_URL is required. SQLite is no longer supported in production.');
    console.error('[db] Set DATABASE_URL=postgres://user:pass@host:5432/opc');
    process.exit(1);
  }

  console.log('[db] using Postgres via PgSyncDatabase');
  const pg = await initPostgres();
  if (!pg) {
    console.error('[db] FATAL: cannot connect to Postgres');
    process.exit(1);
  }

  // Run migrations to ensure all 168 tables exist
  await runMigrations(pg);
  console.log('[postgres] migrations applied (168 tables)');

  // PgSyncDatabase makes run/one/all (from db.ts) work against Postgres synchronously.
  // Existing 72 stores call run(db, sql, params) — zero changes needed.
  const db = new PgSyncDatabase();
  migrateIvrRuntimeTables(db);

  const server = createServer(db, pg);
  initWebSocket(server);
  const tinodeWorker = startTinodeSyncWorker({
    pg,
    onDeliveryUpdated: (message) => {
      wsBroadcast(message.tenant_id, 'collaboration.message.delivery_updated', {
        session_id: message.session_id,
        message_id: message.id,
        delivery: message.provider_delivery
      });
    }
  });
  const qualityReviewProvider = configuredQualityReviewProvider();
  const qualityReviewEnqueue = new QualityReviewService({
    pg,
    provider: qualityReviewProvider
  });
  const attachmentWorker = startAttachmentProcessingWorker({
    pg,
    onProcessed: async ({ attachment, job, policy }) => {
      wsBroadcast(attachment.tenant_id, 'collaboration.attachment.processed', {
        session_id: attachment.session_id,
        message_id: attachment.message_id,
        attachment,
        job,
        policy
      });
      if (qualityReviewProvider || process.env.OPC_QUALITY_REVIEW_AUTO_ENQUEUE === '1') {
        await qualityReviewEnqueue.enqueueMessage({
          tenant_id: attachment.tenant_id,
          message_id: attachment.message_id
        });
      }
    }
  });
  const qualityWorker = startQualityReviewWorker({
    pg,
    onCompleted: ({ job, findings }) => {
      wsBroadcast(job.tenant_id, 'collaboration.quality_review.completed', {
        session_id: job.session_id,
        message_id: job.message_id,
        job,
        findings
      });
    }
  });

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
    await tinodeWorker.stop();
    await attachmentWorker.stop();
    await qualityWorker.stop();
    db.close();
    await closePostgres();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
