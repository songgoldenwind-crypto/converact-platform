/**
 * PgSyncDatabase — a synchronous Postgres adapter that mimics node:sqlite's DatabaseSync interface.
 *
 * This allows the existing 72 stores (which call run/one/all from db.ts synchronously)
 * to use Postgres WITHOUT any code changes. The stores continue calling
 * `run(db, sql, params)` / `one(db, sql, params)` / `all(db, sql, params)` —
 * but `db` is a PgSyncDatabase instance backed by Postgres, not SQLite.
 *
 * Implementation: a worker thread runs async pg.Pool queries. The main thread
 * uses Atomics.wait to synchronously block until the worker signals completion
 * via SharedArrayBuffer + Atomics.notify.
 *
 * WARNING: This blocks the main event loop during each query — same as SQLite
 * (which is also synchronous/blocking). For a real-time call center, queries
 * must be fast (<5ms typical). Postgres with a warm connection pool achieves this.
 * If query latency becomes a problem, stores should be migrated to async DbClient.
 */

import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPgTenantContext } from './db-pg-tenant.js';

const WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
const { Pool } = require('pg');

let pool = null;
const buf = workerData;
const arr = new Int32Array(buf);

function getPool() {
  if (!pool) {
    const connStr = process.env.DATABASE_URL;
    pool = new Pool(connStr ? { connectionString: connStr, max: 5 } : { max: 5 });
  }
  return pool;
}

function convertPlaceholders(sql) {
  let i = 0;
  let pg = sql.replace(/\\?/g, () => '$' + (++i));
  // SQLite → Postgres SQL dialect conversions
  // INSERT OR IGNORE INTO t ... VALUES (...) → INSERT INTO t ... VALUES (...) ON CONFLICT DO NOTHING
  // We append ON CONFLICT DO NOTHING at the end of INSERT OR IGNORE statements
  if (pg.match(/^INSERT OR IGNORE INTO/i)) {
    pg = pg.replace(/^INSERT OR IGNORE INTO/i, 'INSERT INTO');
    pg = pg.replace(/;?$/, ' ON CONFLICT DO NOTHING');
  }
  // INSERT OR REPLACE → INSERT (caller must handle upsert via ON CONFLICT)
  pg = pg.replace(/^INSERT OR REPLACE INTO/i, 'INSERT INTO');
  pg = pg.replace(/datetime\\(\\s*'now'\\s*\\)/gi, 'CURRENT_TIMESTAMP');
  return pg;
}

parentPort.on('message', async ({ sql, params, tenantId, bypassRls }) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (bypassRls) {
      await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    } else if (tenantId) {
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    }
    const result = await client.query(convertPlaceholders(sql), params || []);
    await client.query('COMMIT');
    const json = JSON.stringify({ ok: true, rows: result.rows, rowCount: result.rowCount });
    new TextEncoder().encodeInto(json, new Uint8Array(buf, 4, 262140));
    arr[0] = 1;
  } catch (err) {
    await client.query('ROLLBACK');
    const json = JSON.stringify({ ok: false, error: err.message });
    new TextEncoder().encodeInto(json, new Uint8Array(buf, 4, 262140));
    arr[0] = 2;
  } finally {
    client.release();
  }
  Atomics.notify(arr, 0);
});
`;

const SHARED_BUF_SIZE = 4 + 262140; // 4 bytes for signal + 256KB for JSON result
const SHARED_BUF = new SharedArrayBuffer(SHARED_BUF_SIZE);
const SHARED_ARR = new Int32Array(SHARED_BUF);

let workerInstance: Worker | null = null;

function getWorker(): Worker {
  if (workerInstance) return workerInstance;

  // Always rewrite worker file (ensures code updates take effect, no stale cache)
  const workerPath = join(process.cwd(), '.pg-sync-worker.cjs');
  writeFileSync(workerPath, WORKER_CODE);

  workerInstance = new Worker(workerPath, { workerData: SHARED_BUF });
  return workerInstance;
}

function syncQuery(sql: string, params: unknown[]): { ok: boolean; rows?: any[]; rowCount?: number; error?: string } {
  SHARED_ARR[0] = 0;
  // Clear the result buffer
  new Uint8Array(SHARED_BUF, 4, 262140).fill(0);

  const ctx = getPgTenantContext();
  const worker = getWorker();
  worker.postMessage({
    sql,
    params,
    tenantId: ctx.tenantId ?? '',
    bypassRls: ctx.bypassRls ?? false
  });

  // Synchronously block until worker signals (max 5 second timeout)
  const result = Atomics.wait(SHARED_ARR, 0, 0, 5000);
  if (result === 'timed-out') {
    throw new Error(`Postgres query timed out after 5s: ${sql.slice(0, 100)}`);
  }

  const json = new TextDecoder().decode(new Uint8Array(SHARED_BUF, 4, 262140));
  const nul = json.indexOf('\0');
  const clean = nul >= 0 ? json.slice(0, nul) : json;
  return JSON.parse(clean);
}

/**
 * A prepared statement that proxies to Postgres via the sync worker.
 * Mimics the SQLite StatementSync interface (get/all/run).
 */
class PgSyncStatement {
  constructor(private sql: string) {}

  get(...params: unknown[]): any {
    const result = syncQuery(this.sql, params);
    if (!result.ok) throw new Error(result.error || 'Postgres query failed');
    return result.rows?.[0] ?? null;
  }

  all(...params: unknown[]): any[] {
    const result = syncQuery(this.sql, params);
    if (!result.ok) throw new Error(result.error || 'Postgres query failed');
    return result.rows || [];
  }

  run(...params: unknown[]): any {
    const result = syncQuery(this.sql, params);
    if (!result.ok) throw new Error(result.error || 'Postgres query failed');
    return { changes: result.rowCount || 0, lastInsertRowid: null };
  }
}

/**
 * PgSyncDatabase — mimics node:sqlite DatabaseSync.
 * Drop-in replacement: stores call `one(db, sql, params)` which does
 * `asDatabase(db).prepare(sql).get(...params)` — this makes it work with Postgres.
 */
export class PgSyncDatabase {
  prepare(sql: string): PgSyncStatement {
    return new PgSyncStatement(sql);
  }

  exec(sql: string): void {
    if (shouldSkipRuntimeSchemaDdl(sql)) return;
    const result = syncQuery(sql, []);
    if (!result.ok) throw new Error(result.error || 'Postgres query failed');
  }

  close(): void {
    if (workerInstance) {
      workerInstance.terminate();
      workerInstance = null;
    }
  }
}

export function shouldSkipRuntimeSchemaDdl(
  sql: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.OPC_SCHEMA_MANAGED_BY_MIGRATIONS !== '1') return false;
  return /\b(?:CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/i.test(sql);
}
