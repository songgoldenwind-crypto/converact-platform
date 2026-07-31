import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, all } from '../src/db.js';

const repoRoot = new URL('..', import.meta.url).pathname;

test('architecture stabilization keeps learning sources schema-backed and fail-fast', () => {
  const learningSources = [
    'src/agent-runtime/auto-prompt-learning.ts',
    'src/agent-runtime/iterative-refinement.ts'
  ].map((relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8')).join('\n');

  assert.doesNotMatch(
    learningSources,
    /lead_acquisition_run_items\s+\w+[\s\S]{0,300}\b(script_content|route_type|conversion_rate|period|call_count|conversions)\b/
  );
  assert.doesNotMatch(
    learningSources,
    /Learning insight extraction failed|Route trend analysis failed|Pattern extraction failed/
  );
});

test('architecture stabilization schema includes traceable context and feedback lifecycle tables', () => {
  const schema = readFileSync(join(repoRoot, 'src/schema.sql'), 'utf8');

  assert.match(schema, /CREATE TABLE IF NOT EXISTS context_compression_traces/);
  assert.match(schema, /critical_open_loops_retained/);
  assert.match(schema, /feedback_actions[\s\S]+CHECK \(status IN \('pending', 'applied', 'verified', 'dismissed', 'superseded'\)\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS lead_run_particle_snapshots/);
  assert.match(schema, /particle_key TEXT NOT NULL CHECK \(particle_key IN \(/);
  assert.match(schema, /human_feedback_calibration_packet/);
  assert.match(schema, /feedback_action_application_packet/);
  assert.match(schema, /write_order INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /idx_lead_run_particle_snapshots_latest/);
  assert.doesNotMatch(schema, /provider_config_ui|agent_platform_console|dag_visualizer/);
});

test('database migration removes legacy feedback action lifecycle uniqueness and adds lifecycle columns', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'opc-feedback-migration-'));
  const dbPath = join(tempDir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE feedback_actions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      lead_acquisition_run_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'superseded')),
      source_stage TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      metrics TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, workflow_run_id, lead_acquisition_run_id, action_type, source_stage, status)
    );
  `);
  legacyDb.close();

  const migratedDb = createDatabase(dbPath);
  try {
    const columns = all(migratedDb, "PRAGMA table_info('feedback_actions')").map((row) => String(row.name));
    const tableSql = String(
      all(migratedDb, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'feedback_actions'")[0]?.sql || ''
    );

    assert.ok(columns.includes('application_result'));
    assert.ok(columns.includes('verification_metrics'));
    assert.doesNotMatch(tableSql, /UNIQUE\(tenant_id, workflow_run_id, lead_acquisition_run_id, action_type, source_stage, status\)/);
    assert.match(tableSql, /'verified'/);
  } finally {
    migratedDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('database migration creates lead run particle snapshot table for existing databases', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'opc-particle-migration-'));
  const dbPath = join(tempDir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacyDb.close();

  const migratedDb = createDatabase(dbPath);
  try {
    const columns = all(migratedDb, "PRAGMA table_info('lead_run_particle_snapshots')").map((row) => String(row.name));
    const indexSql = all(migratedDb, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lead_run_particle_snapshots'")
      .map((row) => String(row.name));

    assert.ok(columns.includes('particle_key'));
    assert.ok(columns.includes('payload_hash'));
    assert.ok(columns.includes('writeback_status'));
    assert.ok(columns.includes('write_order'));
    assert.ok(indexSql.includes('idx_lead_run_particle_snapshots_latest'));
  } finally {
    migratedDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('database migration adds particle snapshot write order for existing tables', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'opc-particle-order-migration-'));
  const dbPath = join(tempDir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE lead_run_particle_snapshots (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_acquisition_run_id TEXT NOT NULL,
      particle_key TEXT NOT NULL,
      particle_version TEXT NOT NULL DEFAULT 'v1',
      source_stage TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      quality_status TEXT NOT NULL DEFAULT 'info',
      writeback_status TEXT NOT NULL DEFAULT 'generated',
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
    );
    CREATE INDEX idx_lead_run_particle_snapshots_latest
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, updated_at DESC);
  `);
  legacyDb.close();

  const migratedDb = createDatabase(dbPath);
  try {
    const columns = all(migratedDb, "PRAGMA table_info('lead_run_particle_snapshots')").map((row) => String(row.name));
    const latestIndexSql = String(
      all(migratedDb, "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_lead_run_particle_snapshots_latest'")[0]?.sql || ''
    );

    assert.ok(columns.includes('write_order'));
    assert.match(latestIndexSql, /write_order DESC/);
  } finally {
    migratedDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('database migration preserves existing particle snapshot recency when backfilling write order', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'opc-particle-recency-migration-'));
  const dbPath = join(tempDir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE lead_run_particle_snapshots (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_acquisition_run_id TEXT NOT NULL,
      particle_key TEXT NOT NULL,
      particle_version TEXT NOT NULL DEFAULT 'v1',
      source_stage TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      quality_status TEXT NOT NULL DEFAULT 'info',
      writeback_status TEXT NOT NULL DEFAULT 'generated',
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
    );
    INSERT INTO lead_run_particle_snapshots
      (id, tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash, payload, created_at, updated_at)
    VALUES
      ('snapshot_old_row_updated_later', 'tenant_1', 'run_1', 'human_feedback_calibration_packet', 'human_feedback', 'old', 'hash_old', '{}', '2026-01-01 00:00:00', '2026-01-01 00:00:10'),
      ('snapshot_new_row_updated_earlier', 'tenant_1', 'run_1', 'human_feedback_calibration_packet', 'human_feedback', 'new', 'hash_new', '{}', '2026-01-01 00:00:05', '2026-01-01 00:00:05');
    CREATE INDEX idx_lead_run_particle_snapshots_latest
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, updated_at DESC);
  `);
  legacyDb.close();

  const migratedDb = createDatabase(dbPath);
  try {
    const [latest] = all(
      migratedDb,
      `SELECT id
         FROM lead_run_particle_snapshots
        WHERE tenant_id = 'tenant_1'
          AND lead_acquisition_run_id = 'run_1'
          AND particle_key = 'human_feedback_calibration_packet'
        ORDER BY write_order DESC, updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1`
    );

    assert.equal(latest.id, 'snapshot_old_row_updated_later');
  } finally {
    migratedDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
