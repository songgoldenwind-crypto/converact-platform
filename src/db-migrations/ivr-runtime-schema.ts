/**
 * IVR runtime DDL — single source for SQLite test DB bootstrap.
 * Postgres: src/migrations/007_ivr_runtime_tables.sql
 */
import { all, one, run } from '../db.js';

const ivrRuntimeReady = new WeakSet<object>();

function isPgSyncDatabase(db: unknown): boolean {
  const ctor = (db as { constructor?: { name?: string } })?.constructor?.name;
  return ctor === 'PgSyncDatabase';
}

function ensureIvrSessionColumns(db: unknown): void {
  if (isPgSyncDatabase(db)) {
    const cols = all(
      db,
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ivr_sessions'`
    );
    if (!cols.some((c) => c.name === 'last_action_json')) {
      run(db, `ALTER TABLE ivr_sessions ADD COLUMN last_action_json TEXT`);
    }
    if (!cols.some((c) => c.name === 'revision')) {
      run(db, `ALTER TABLE ivr_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
    }
    const stepCols = all(
      db,
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ivr_session_steps'`
    );
    if (!stepCols.some((c) => c.name === 'branch_taken')) {
      run(db, `ALTER TABLE ivr_session_steps ADD COLUMN branch_taken TEXT`);
    }
    return;
  }

  const sessionCols = all(db, `PRAGMA table_info(ivr_sessions)`);
  if (sessionCols.length > 0 && !sessionCols.some((c) => c.name === 'last_action_json')) {
    run(db, `ALTER TABLE ivr_sessions ADD COLUMN last_action_json TEXT`);
  }
  if (sessionCols.length > 0 && !sessionCols.some((c) => c.name === 'revision')) {
    run(db, `ALTER TABLE ivr_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
  }
  const stepCols = all(db, `PRAGMA table_info(ivr_session_steps)`);
  if (stepCols.length > 0 && !stepCols.some((c) => c.name === 'branch_taken')) {
    run(db, `ALTER TABLE ivr_session_steps ADD COLUMN branch_taken TEXT`);
  }
}

/** Idempotent IVR runtime tables for SQLite (and legacy PG rows pre-007). */
export function migrateIvrRuntimeTables(db: unknown): void {
  const dbKey = db as object;
  if (ivrRuntimeReady.has(dbKey)) {
    return;
  }

  if (isPgSyncDatabase(db)) {
    ensureIvrSessionColumns(db);
    ivrRuntimeReady.add(dbKey);
    return;
  }

  const existing = one(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='ivr_sessions'");
  if (existing) {
    ensureIvrSessionColumns(db);
    ivrRuntimeReady.add(dbKey);
    return;
  }

  run(db, `
    CREATE TABLE IF NOT EXISTS ivr_sessions (
      call_session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      flow_id TEXT NOT NULL,
      context_json TEXT NOT NULL,
      step_count INTEGER NOT NULL DEFAULT 0,
      terminated INTEGER NOT NULL DEFAULT 0,
      last_action_json TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  run(db, `CREATE INDEX IF NOT EXISTS idx_ivr_sessions_tenant ON ivr_sessions(tenant_id)`);
  run(db, `
    CREATE TABLE IF NOT EXISTS ivr_session_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_session_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      node_id TEXT,
      action_kind TEXT NOT NULL,
      action_json TEXT NOT NULL,
      branch_taken TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  run(db, `CREATE INDEX IF NOT EXISTS idx_ivr_session_steps_call ON ivr_session_steps(call_session_id)`);

  run(db, `
    CREATE TABLE IF NOT EXISTS audio_library (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'enterprise' CHECK (scope IN ('public', 'enterprise')),
      tenant_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      description TEXT,
      entry_type TEXT NOT NULL DEFAULT 'tts' CHECK (entry_type IN ('tts', 'audio_file', 'audio_var')),
      tts_text TEXT,
      tts_engine TEXT,
      audio_url TEXT,
      variable_name TEXT,
      language TEXT DEFAULT 'zh',
      duration_sec REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  run(db, `CREATE INDEX IF NOT EXISTS idx_audio_library_scope ON audio_library(scope)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_audio_library_tenant ON audio_library(tenant_id)`);

  run(db, `
    CREATE TABLE IF NOT EXISTS ivr_time_groups (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL DEFAULT '{}',
      holidays TEXT,
      timezone TEXT DEFAULT 'Asia/Shanghai',
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  run(db, `
    CREATE TABLE IF NOT EXISTS ivr_region_groups (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      regions TEXT NOT NULL DEFAULT '[]',
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  run(db, `
    CREATE TABLE IF NOT EXISTS ivr_group_call_groups (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      member_seat_ids TEXT NOT NULL DEFAULT '[]',
      strategy TEXT NOT NULL DEFAULT 'simultaneous',
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  run(db, `
    CREATE TABLE IF NOT EXISTS ivr_flow_history (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      graph TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  run(db, `CREATE INDEX IF NOT EXISTS idx_ivr_flow_history ON ivr_flow_history(flow_id, version)`);
  ivrRuntimeReady.add(dbKey);
}
