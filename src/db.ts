import { resolveBrandEnv } from './config/converact-env.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { all, asDatabase, one, run } from './db-compat.js';
import type { DatabaseLike } from './db-compat.js';
import { LEAD_RUN_PARTICLE_KEYS } from './db-migrations/legacy-lead-run-particle-keys.js';
import { migrateIvrRuntimeTables } from './db-migrations/ivr-runtime-schema.js';

export { all, id, json, one, parseJson, run } from './db-compat.js';
export type { SqliteParams } from './db-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

export function createDatabase(
  dbPath: string = resolveBrandEnv(process.env, 'DB_PATH') || join(process.cwd(), 'data', 'opc.sqlite')
): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  migrateLegacyWikiEvents(db);
  migrateLegacyTaskColumns(db);
  migrateLeadAcquisitionColumns(db);
  migrateMemorySchema(db);
  migrateFeedbackActionsSchema(db);
  migrateLeadRunParticleSnapshotsSchema(db);
  migrateAIScriptGenerationJobKey(db);
  migrateCompressionDiscardAuditKey(db);
  migrateCallCenterSchema(db);
  migrateAgentSeatStatuses(db);
  migrateInboundAcdSchema(db);
  migrateAgentToolsSchema(db);
  migrateSupervisorVoicemailSchema(db);
  migrateOutboundCampaignSchema(db);
  migrateOmniChannelSchema(db);
  migrateSprint10Schema(db);
  migrateSprint11Schema(db);
  migrateSprint10CompleteSchema(db);
  migrateSprint12Schema(db);
  migrateSprint12IvrMarketplaceSchema(db);
  migrateOmniFacebookMessengerChannel(db);
  migrateFacebookChannelConfigSchema(db);
  migratePhase3AgentPanelSchema(db);
  migrateIvrFlowNeedsRepairStatus(db);
  migrateIvrRuntimeTables(db);
  return db;
}

function migrateLegacyWikiEvents(db: unknown): void {
  const database = asDatabase(db);
  const row = one(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wiki_events'");
  if (!row || String(row.sql || '').includes('contradiction_review')) return;

  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE wiki_events RENAME TO wiki_events_old;
      CREATE TABLE wiki_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        event_type TEXT NOT NULL CHECK (event_type IN ('ingest', 'page_upsert', 'query', 'lint', 'index_build', 'synthesis_draft', 'diff_proposal', 'contradiction_review')),
        object_type TEXT NOT NULL DEFAULT '',
        object_id TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO wiki_events (id, tenant_id, workspace_id, event_type, object_type, object_id, payload, created_at)
        SELECT id, tenant_id, workspace_id, event_type, object_type, object_id, payload, created_at
        FROM wiki_events_old;
      DROP TABLE wiki_events_old;
      CREATE INDEX IF NOT EXISTS idx_wiki_events_tenant ON wiki_events(tenant_id, workspace_id, created_at);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  } catch (error) {
    database.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
    throw error;
  }
}

function migrateLegacyTaskColumns(db: unknown): void {
  const database = asDatabase(db);
  const columns = all(db, "PRAGMA table_info('tasks')").map((row) => String(row.name));
  const alterations = [
    columns.includes('completion_result') ? null : "ALTER TABLE tasks ADD COLUMN completion_result TEXT NOT NULL DEFAULT '';",
    columns.includes('completion_reason') ? null : "ALTER TABLE tasks ADD COLUMN completion_reason TEXT NOT NULL DEFAULT '';",
    columns.includes('next_step_type') ? null : "ALTER TABLE tasks ADD COLUMN next_step_type TEXT NOT NULL DEFAULT '';",
    columns.includes('next_step_due_at') ? null : 'ALTER TABLE tasks ADD COLUMN next_step_due_at TEXT;',
    columns.includes('script_metadata') ? null : "ALTER TABLE tasks ADD COLUMN script_metadata TEXT NOT NULL DEFAULT '';",
    columns.includes('followup_task_id') ? null : 'ALTER TABLE tasks ADD COLUMN followup_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;'
  ].filter(Boolean);

  if (!alterations.length) return;
  database.exec(alterations.join('\n'));
}

function migrateMemorySchema(db: unknown): void {
  const database = asDatabase(db);
  const entryColumns = all(db, "PRAGMA table_info('memory_entries')").map((row) => String(row.name));
  const entryAlterations = [
    entryColumns.includes('entity_key') ? null : "ALTER TABLE memory_entries ADD COLUMN entity_key TEXT NOT NULL DEFAULT '';",
    entryColumns.includes('fact_key') ? null : "ALTER TABLE memory_entries ADD COLUMN fact_key TEXT NOT NULL DEFAULT '';",
    entryColumns.includes('source_refs') ? null : "ALTER TABLE memory_entries ADD COLUMN source_refs TEXT NOT NULL DEFAULT '[]';",
    entryColumns.includes('occurred_at') ? null : 'ALTER TABLE memory_entries ADD COLUMN occurred_at TEXT;',
    entryColumns.includes('known_at') ? null : 'ALTER TABLE memory_entries ADD COLUMN known_at TEXT;',
    entryColumns.includes('valid_from') ? null : 'ALTER TABLE memory_entries ADD COLUMN valid_from TEXT;',
    entryColumns.includes('valid_to') ? null : 'ALTER TABLE memory_entries ADD COLUMN valid_to TEXT;',
    entryColumns.includes('supersedes_memory_id') ? null : 'ALTER TABLE memory_entries ADD COLUMN supersedes_memory_id TEXT REFERENCES memory_entries(id) ON DELETE SET NULL;',
    entryColumns.includes('superseded_by_memory_id') ? null : 'ALTER TABLE memory_entries ADD COLUMN superseded_by_memory_id TEXT REFERENCES memory_entries(id) ON DELETE SET NULL;',
    entryColumns.includes('contradiction_group_id') ? null : "ALTER TABLE memory_entries ADD COLUMN contradiction_group_id TEXT NOT NULL DEFAULT '';",
    entryColumns.includes('recall_count') ? null : 'ALTER TABLE memory_entries ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;',
    entryColumns.includes('last_recalled_at') ? null : 'ALTER TABLE memory_entries ADD COLUMN last_recalled_at TEXT;',
    entryColumns.includes('importance_score') ? null : 'ALTER TABLE memory_entries ADD COLUMN importance_score REAL NOT NULL DEFAULT 0.5;',
    entryColumns.includes('protected') ? null : 'ALTER TABLE memory_entries ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;',
    entryColumns.includes('summary_parent_id') ? null : "ALTER TABLE memory_entries ADD COLUMN summary_parent_id TEXT NOT NULL DEFAULT '';",
    entryColumns.includes('effective_known_at') ? null : 'ALTER TABLE memory_entries ADD COLUMN effective_known_at TEXT;',
    entryColumns.includes('metadata') ? null : "ALTER TABLE memory_entries ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';"
  ].filter(Boolean);
  if (entryAlterations.length) database.exec(entryAlterations.join('\n'));

  // 初始化 effective_known_at（用现有的 known_at / occurred_at / created_at）
  if (entryColumns.includes('effective_known_at')) {
    run(db, "UPDATE memory_entries SET effective_known_at = COALESCE(known_at, occurred_at, created_at) WHERE effective_known_at IS NULL");
  }

  // 差异化初始化 importance_score（冷启动保护）
  if (entryColumns.includes('importance_score')) {
    const hasExistingScore = one(db, "SELECT 1 FROM memory_entries WHERE importance_score != 0.5 LIMIT 1");
    if (!hasExistingScore) {
      run(db, `
        UPDATE memory_entries
        SET importance_score = CASE
          WHEN memory_type IN ('preference', 'condition') THEN 0.85
          WHEN memory_type = 'profile' THEN 0.80
          WHEN memory_type = 'learning' THEN 0.75
          WHEN memory_type = 'open_loop' THEN 0.70
          WHEN evidence_object_id != '' THEN 0.65
          ELSE 0.60
        END
        WHERE importance_score = 0.5
      `);
    }
  }

  // 初始化 protected 标记
  if (entryColumns.includes('protected')) {
    const hasExistingProtected = one(db, "SELECT 1 FROM memory_entries WHERE protected = 1 LIMIT 1");
    if (!hasExistingProtected) {
      run(db, `
        UPDATE memory_entries
        SET protected = CASE WHEN memory_type IN ('preference', 'condition') THEN 1 ELSE 0 END
      `);
    }
  }

  const candidateColumns = all(db, "PRAGMA table_info('memory_candidates')").map((row) => String(row.name));
  const candidateAlterations = [
    candidateColumns.includes('entity_key') ? null : "ALTER TABLE memory_candidates ADD COLUMN entity_key TEXT NOT NULL DEFAULT '';",
    candidateColumns.includes('fact_key') ? null : "ALTER TABLE memory_candidates ADD COLUMN fact_key TEXT NOT NULL DEFAULT '';",
    candidateColumns.includes('source_refs') ? null : "ALTER TABLE memory_candidates ADD COLUMN source_refs TEXT NOT NULL DEFAULT '[]';",
    candidateColumns.includes('occurred_at') ? null : 'ALTER TABLE memory_candidates ADD COLUMN occurred_at TEXT;',
    candidateColumns.includes('known_at') ? null : 'ALTER TABLE memory_candidates ADD COLUMN known_at TEXT;',
    candidateColumns.includes('valid_from') ? null : 'ALTER TABLE memory_candidates ADD COLUMN valid_from TEXT;',
    candidateColumns.includes('valid_to') ? null : 'ALTER TABLE memory_candidates ADD COLUMN valid_to TEXT;',
    candidateColumns.includes('metadata') ? null : "ALTER TABLE memory_candidates ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';"
  ].filter(Boolean);
  if (candidateAlterations.length) database.exec(candidateAlterations.join('\n'));

  const entrySchema = String(one(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'")?.sql || '');
  if (!entrySchema.includes("'open_loop'") || !entrySchema.includes("'superseded'") || !entrySchema.includes("'lead_acquisition_run'")) {
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN;
        ALTER TABLE memory_entries RENAME TO memory_entries_old;
        CREATE TABLE memory_entries (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant', 'workspace', 'campaign', 'lead', 'customer', 'agent', 'skill', 'workflow', 'task', 'call', 'lead_acquisition_run')),
          scope_id TEXT NOT NULL DEFAULT '',
          memory_type TEXT NOT NULL CHECK (memory_type IN ('fact', 'preference', 'learning', 'skill', 'summary', 'condition', 'open_loop', 'profile')),
          content TEXT NOT NULL,
          entity_key TEXT NOT NULL DEFAULT '',
          fact_key TEXT NOT NULL DEFAULT '',
          evidence_object_type TEXT NOT NULL DEFAULT '',
          evidence_object_id TEXT NOT NULL DEFAULT '',
          source_refs TEXT NOT NULL DEFAULT '[]',
          confidence REAL NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'contradicted', 'superseded', 'archived')),
          occurred_at TEXT,
          known_at TEXT,
          valid_from TEXT,
          valid_to TEXT,
          supersedes_memory_id TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
          superseded_by_memory_id TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
          contradiction_group_id TEXT NOT NULL DEFAULT '',
          recall_count INTEGER NOT NULL DEFAULT 0,
          last_recalled_at TEXT,
          importance_score REAL NOT NULL DEFAULT 0.5,
          protected INTEGER NOT NULL DEFAULT 0,
          summary_parent_id TEXT NOT NULL DEFAULT '',
          effective_known_at TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO memory_entries (
          id, tenant_id, scope_type, scope_id, memory_type, content, entity_key, fact_key,
          evidence_object_type, evidence_object_id, source_refs, confidence, status,
          occurred_at, known_at, valid_from, valid_to, supersedes_memory_id, superseded_by_memory_id,
          contradiction_group_id, recall_count, last_recalled_at,
          importance_score, protected, summary_parent_id, effective_known_at,
          metadata, created_at, updated_at
        )
          SELECT id, tenant_id, scope_type, scope_id, memory_type, content, entity_key, fact_key,
            evidence_object_type, evidence_object_id, source_refs, confidence,
            CASE WHEN status = 'superseded' THEN 'superseded' ELSE status END,
            occurred_at, known_at, valid_from, valid_to, supersedes_memory_id, superseded_by_memory_id,
            contradiction_group_id, recall_count, last_recalled_at,
            0.5, 0, '', COALESCE(known_at, occurred_at, created_at),
            metadata, created_at, updated_at
          FROM memory_entries_old;
        DROP TABLE memory_entries_old;
        CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(tenant_id, scope_type, scope_id, status);
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    } catch (error) {
      database.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
      throw error;
    }
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_fact ON memory_entries(tenant_id, entity_key, fact_key, status);
    CREATE INDEX IF NOT EXISTS idx_memory_temporal ON memory_entries(tenant_id, occurred_at, known_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_fact ON memory_candidates(tenant_id, entity_key, fact_key, status);
  `);
}

function migrateLeadAcquisitionColumns(db: unknown): void {
  const database = asDatabase(db);
  const landingPageColumns = all(db, "PRAGMA table_info('landing_pages')").map((row) => String(row.name));
  const inquiryColumns = all(db, "PRAGMA table_info('raw_inquiries')").map((row) => String(row.name));
  const alterations = [
    landingPageColumns.includes('lead_acquisition_run_id')
      ? null
      : 'ALTER TABLE landing_pages ADD COLUMN lead_acquisition_run_id TEXT REFERENCES lead_acquisition_runs(id) ON DELETE SET NULL;',
    inquiryColumns.includes('lead_acquisition_run_id')
      ? null
      : 'ALTER TABLE raw_inquiries ADD COLUMN lead_acquisition_run_id TEXT REFERENCES lead_acquisition_runs(id) ON DELETE SET NULL;'
  ].filter(Boolean);

  if (alterations.length) database.exec(alterations.join('\n'));
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_landing_pages_run ON landing_pages(lead_acquisition_run_id);
    CREATE INDEX IF NOT EXISTS idx_inquiries_run ON raw_inquiries(lead_acquisition_run_id);
  `);
}

function migrateFeedbackActionsSchema(db: unknown): void {
  const database = asDatabase(db);
  const columns = all(db, "PRAGMA table_info('feedback_actions')").map((row) => String(row.name));
  if (!columns.length) return;

  const tableSql = String(one(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'feedback_actions'")?.sql || '');
  const hasLegacyLifecycleUnique = /UNIQUE\s*\(\s*tenant_id\s*,\s*workflow_run_id\s*,\s*lead_acquisition_run_id\s*,\s*action_type\s*,\s*source_stage\s*,\s*status\s*\)/.test(tableSql);
  const missingVerifiedStatus = !tableSql.includes("'verified'");
  if (hasLegacyLifecycleUnique || missingVerifiedStatus) {
    rebuildFeedbackActionsTable(database, columns);
    return;
  }

  const alterations = [
    columns.includes('applied_by') ? null : "ALTER TABLE feedback_actions ADD COLUMN applied_by TEXT NOT NULL DEFAULT '';",
    columns.includes('application_result') ? null : "ALTER TABLE feedback_actions ADD COLUMN application_result TEXT NOT NULL DEFAULT '{}';",
    columns.includes('applied_at') ? null : 'ALTER TABLE feedback_actions ADD COLUMN applied_at TEXT;',
    columns.includes('verification_result') ? null : "ALTER TABLE feedback_actions ADD COLUMN verification_result TEXT NOT NULL DEFAULT '';",
    columns.includes('verification_metrics') ? null : "ALTER TABLE feedback_actions ADD COLUMN verification_metrics TEXT NOT NULL DEFAULT '{}';",
    columns.includes('verified_at') ? null : 'ALTER TABLE feedback_actions ADD COLUMN verified_at TEXT;'
  ].filter(Boolean);
  if (alterations.length) database.exec(alterations.join('\n'));
}

function rebuildFeedbackActionsTable(database: DatabaseLike, columns: string[]): void {
  const columnExpression = (column: string, fallback: string): string =>
    columns.includes(column) ? column : fallback;

  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE feedback_actions RENAME TO feedback_actions_old;
      CREATE TABLE feedback_actions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL CHECK (action_type IN (
          'tighten_lead_scoring',
          'refresh_script_angles',
          'prioritize_verified_channels',
          'prepare_next_batch'
        )),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'verified', 'dismissed', 'superseded')),
        source_stage TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        metrics TEXT NOT NULL DEFAULT '{}',
        applied_by TEXT NOT NULL DEFAULT '',
        application_result TEXT NOT NULL DEFAULT '{}',
        applied_at TEXT,
        verification_result TEXT NOT NULL DEFAULT '',
        verification_metrics TEXT NOT NULL DEFAULT '{}',
        verified_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO feedback_actions (
        id, tenant_id, workflow_run_id, lead_acquisition_run_id, action_type, status,
        source_stage, reason, metrics, applied_by, application_result, applied_at,
        verification_result, verification_metrics, verified_at, created_at, updated_at
      )
        SELECT
          id, tenant_id, workflow_run_id, lead_acquisition_run_id, action_type, status,
          ${columnExpression('source_stage', "''")},
          ${columnExpression('reason', "''")},
          ${columnExpression('metrics', "'{}'")},
          ${columnExpression('applied_by', "''")},
          ${columnExpression('application_result', "'{}'")},
          ${columnExpression('applied_at', 'NULL')},
          ${columnExpression('verification_result', "''")},
          ${columnExpression('verification_metrics', "'{}'")},
          ${columnExpression('verified_at', 'NULL')},
          ${columnExpression('created_at', 'CURRENT_TIMESTAMP')},
          ${columnExpression('updated_at', 'CURRENT_TIMESTAMP')}
        FROM feedback_actions_old;
      DROP TABLE feedback_actions_old;
      CREATE INDEX IF NOT EXISTS idx_feedback_actions_run
        ON feedback_actions(tenant_id, lead_acquisition_run_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_actions_workflow
        ON feedback_actions(tenant_id, workflow_run_id, status);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  } catch (error) {
    database.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
    throw error;
  }
}

function migrateLeadRunParticleSnapshotOutreachKeys(db: unknown): void {
  const database = asDatabase(db);
  const tableSql = String(one(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lead_run_particle_snapshots'")?.sql || '');
  if (!tableSql || tableSql.includes('prospect_outreach_writeback_packet')) return;

  const columns = all(db, "PRAGMA table_info('lead_run_particle_snapshots')").map((row) => String(row.name));
  const writeOrderSelect = columns.includes('write_order') ? 'write_order' : '0 AS write_order';

  database.exec(`
    PRAGMA foreign_keys=OFF;

    CREATE TABLE lead_run_particle_snapshots_next (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
      particle_key TEXT NOT NULL CHECK (particle_key IN (
        'human_feedback_calibration_packet',
        'source_quality_benchmark',
        'mission_autoplay_guard',
        'multi_channel_followup_pack',
        'feedback_action_application_packet',
        'prospect_outreach_writeback_packet',
        'next_batch_learning_profile',
        'next_batch_seed_queue',
        'prospect_outreach_channel_adapter_receipt',
        'prospect_outreach_live_demo_acceptance'
      )),
      particle_version TEXT NOT NULL DEFAULT 'v1',
      source_stage TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      quality_status TEXT NOT NULL DEFAULT 'info' CHECK (quality_status IN ('pass', 'warn', 'fail', 'info')),
      writeback_status TEXT NOT NULL DEFAULT 'generated' CHECK (writeback_status IN ('generated', 'applied', 'verified', 'captured')),
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      write_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
    );

    INSERT INTO lead_run_particle_snapshots_next
      (id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
       quality_status, writeback_status, payload_hash, payload, write_order, created_at, updated_at)
    SELECT id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
           quality_status, writeback_status, payload_hash, payload, ${writeOrderSelect}, created_at, updated_at
      FROM lead_run_particle_snapshots;

    DROP TABLE lead_run_particle_snapshots;
    ALTER TABLE lead_run_particle_snapshots_next RENAME TO lead_run_particle_snapshots;

    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_latest
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, write_order DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_status
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, writeback_status, updated_at DESC);

    PRAGMA foreign_keys=ON;
  `);
}

function migrateLeadRunParticleSnapshotLiveDemoKey(db: unknown): void {
  const database = asDatabase(db);
  const tableSql = String(one(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lead_run_particle_snapshots'")?.sql || '');
  if (!tableSql || tableSql.includes('prospect_outreach_live_demo_acceptance')) return;

  const columns = all(db, "PRAGMA table_info('lead_run_particle_snapshots')").map((row) => String(row.name));
  const writeOrderSelect = columns.includes('write_order') ? 'write_order' : '0 AS write_order';

  database.exec(`
    PRAGMA foreign_keys=OFF;

    CREATE TABLE lead_run_particle_snapshots_next (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
      particle_key TEXT NOT NULL CHECK (particle_key IN (
        'human_feedback_calibration_packet',
        'source_quality_benchmark',
        'mission_autoplay_guard',
        'multi_channel_followup_pack',
        'feedback_action_application_packet',
        'prospect_outreach_writeback_packet',
        'next_batch_learning_profile',
        'next_batch_seed_queue',
        'prospect_outreach_channel_adapter_receipt',
        'prospect_outreach_live_demo_acceptance'
      )),
      particle_version TEXT NOT NULL DEFAULT 'v1',
      source_stage TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      quality_status TEXT NOT NULL DEFAULT 'info' CHECK (quality_status IN ('pass', 'warn', 'fail', 'info')),
      writeback_status TEXT NOT NULL DEFAULT 'generated' CHECK (writeback_status IN ('generated', 'applied', 'verified', 'captured')),
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      write_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
    );

    INSERT INTO lead_run_particle_snapshots_next
      (id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
       quality_status, writeback_status, payload_hash, payload, write_order, created_at, updated_at)
    SELECT id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
           quality_status, writeback_status, payload_hash, payload, ${writeOrderSelect}, created_at, updated_at
      FROM lead_run_particle_snapshots;

    DROP TABLE lead_run_particle_snapshots;
    ALTER TABLE lead_run_particle_snapshots_next RENAME TO lead_run_particle_snapshots;

    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_latest
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, write_order DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_status
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, writeback_status, updated_at DESC);

    PRAGMA foreign_keys=ON;
  `);
}

const STRATEGY_MIRROR_PARTICLE_KEYS = LEAD_RUN_PARTICLE_KEYS.filter(
  (key) => !['founder_decision_writeback_packet', 'execution_state_machine_snapshot', 'non_phone_receipt_writeback'].includes(key)
);

function migrateLeadRunParticleSnapshotFounderExecutionKeys(db: unknown): void {
  const database = asDatabase(db);
  const tableSql = String(one(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lead_run_particle_snapshots'")?.sql || '');
  if (!tableSql || tableSql.includes('founder_decision_writeback_packet')) return;

  const columns = all(db, "PRAGMA table_info('lead_run_particle_snapshots')").map((row) => String(row.name));
  const writeOrderSelect = columns.includes('write_order') ? 'write_order' : '0 AS write_order';
  const particleKeySql = LEAD_RUN_PARTICLE_KEYS.map((key) => `'${key}'`).join(',\n        ');

  database.exec(`
    PRAGMA foreign_keys=OFF;

    CREATE TABLE lead_run_particle_snapshots_next (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
      particle_key TEXT NOT NULL CHECK (particle_key IN (
        ${particleKeySql}
      )),
      particle_version TEXT NOT NULL DEFAULT 'v1',
      source_stage TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      quality_status TEXT NOT NULL DEFAULT 'info' CHECK (quality_status IN ('pass', 'warn', 'fail', 'info')),
      writeback_status TEXT NOT NULL DEFAULT 'generated' CHECK (writeback_status IN ('generated', 'applied', 'verified', 'captured')),
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      write_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
    );

    INSERT INTO lead_run_particle_snapshots_next
      (id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
       quality_status, writeback_status, payload_hash, payload, write_order, created_at, updated_at)
    SELECT id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
           quality_status, writeback_status, payload_hash, payload, ${writeOrderSelect}, created_at, updated_at
      FROM lead_run_particle_snapshots;

    DROP TABLE lead_run_particle_snapshots;
    ALTER TABLE lead_run_particle_snapshots_next RENAME TO lead_run_particle_snapshots;

    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_latest
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, write_order DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_status
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, writeback_status, updated_at DESC);

    PRAGMA foreign_keys=ON;
  `);
}

function migrateLeadRunParticleSnapshotStrategyMirrorKeys(db: unknown): void {
  const database = asDatabase(db);
  const tableSql = String(one(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lead_run_particle_snapshots'")?.sql || '');
  if (!tableSql || tableSql.includes('writeback_confirmation_packet')) return;

  const columns = all(db, "PRAGMA table_info('lead_run_particle_snapshots')").map((row) => String(row.name));
  const writeOrderSelect = columns.includes('write_order') ? 'write_order' : '0 AS write_order';
  const particleKeySql = STRATEGY_MIRROR_PARTICLE_KEYS.map((key) => `'${key}'`).join(',\n        ');

  database.exec(`
    PRAGMA foreign_keys=OFF;

    CREATE TABLE lead_run_particle_snapshots_next (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
      particle_key TEXT NOT NULL CHECK (particle_key IN (
        ${particleKeySql}
      )),
      particle_version TEXT NOT NULL DEFAULT 'v1',
      source_stage TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      quality_status TEXT NOT NULL DEFAULT 'info' CHECK (quality_status IN ('pass', 'warn', 'fail', 'info')),
      writeback_status TEXT NOT NULL DEFAULT 'generated' CHECK (writeback_status IN ('generated', 'applied', 'verified', 'captured')),
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      write_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
    );

    INSERT INTO lead_run_particle_snapshots_next
      (id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
       quality_status, writeback_status, payload_hash, payload, write_order, created_at, updated_at)
    SELECT id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
           quality_status, writeback_status, payload_hash, payload, ${writeOrderSelect}, created_at, updated_at
      FROM lead_run_particle_snapshots;

    DROP TABLE lead_run_particle_snapshots;
    ALTER TABLE lead_run_particle_snapshots_next RENAME TO lead_run_particle_snapshots;

    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_latest
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, write_order DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_status
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, writeback_status, updated_at DESC);

    PRAGMA foreign_keys=ON;
  `);
}

function migrateLeadRunParticleSnapshotDiscoverJobKey(db: unknown): void {
  const database = asDatabase(db);
  const tableSql = String(one(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lead_run_particle_snapshots'")?.sql || '');
  if (!tableSql || tableSql.includes('public_source_discover_job')) return;

  const columns = all(db, "PRAGMA table_info('lead_run_particle_snapshots')").map((row) => String(row.name));
  const writeOrderSelect = columns.includes('write_order') ? 'write_order' : '0 AS write_order';

  database.exec(`
    PRAGMA foreign_keys=OFF;

    CREATE TABLE lead_run_particle_snapshots_next (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
      particle_key TEXT NOT NULL CHECK (particle_key IN (
        'human_feedback_calibration_packet',
        'source_quality_benchmark',
        'mission_autoplay_guard',
        'multi_channel_followup_pack',
        'feedback_action_application_packet',
        'prospect_outreach_writeback_packet',
        'next_batch_learning_profile',
        'next_batch_seed_queue',
        'prospect_outreach_channel_adapter_receipt',
        'prospect_outreach_live_demo_acceptance',
        'public_source_discover_job'
      )),
      particle_version TEXT NOT NULL DEFAULT 'v1',
      source_stage TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      quality_status TEXT NOT NULL DEFAULT 'info' CHECK (quality_status IN ('pass', 'warn', 'fail', 'info')),
      writeback_status TEXT NOT NULL DEFAULT 'generated' CHECK (writeback_status IN ('generated', 'applied', 'verified', 'captured')),
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      write_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
    );

    INSERT INTO lead_run_particle_snapshots_next
      (id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
       quality_status, writeback_status, payload_hash, payload, write_order, created_at, updated_at)
    SELECT id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
           quality_status, writeback_status, payload_hash, payload, ${writeOrderSelect}, created_at, updated_at
      FROM lead_run_particle_snapshots;

    DROP TABLE lead_run_particle_snapshots;
    ALTER TABLE lead_run_particle_snapshots_next RENAME TO lead_run_particle_snapshots;

    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_latest
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, write_order DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_status
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, writeback_status, updated_at DESC);

    PRAGMA foreign_keys=ON;
  `);
}

function migrateLeadRunParticleSnapshotsSchema(db: unknown): void {
  const database = asDatabase(db);
  const columns = all(db, "PRAGMA table_info('lead_run_particle_snapshots')").map((row) => String(row.name));
  if (columns.length) {
    if (!columns.includes('write_order')) {
      database.exec(`
        ALTER TABLE lead_run_particle_snapshots ADD COLUMN write_order INTEGER NOT NULL DEFAULT 0;
        WITH ranked AS (
          SELECT
            rowid AS snapshot_rowid,
            ROW_NUMBER() OVER (
              PARTITION BY tenant_id, lead_acquisition_run_id
              ORDER BY updated_at ASC, created_at ASC, rowid ASC
            ) AS migrated_write_order
          FROM lead_run_particle_snapshots
        )
        UPDATE lead_run_particle_snapshots
           SET write_order = (
             SELECT migrated_write_order
               FROM ranked
              WHERE ranked.snapshot_rowid = lead_run_particle_snapshots.rowid
           )
         WHERE write_order = 0;
      `);
    }
    migrateLeadRunParticleSnapshotOutreachKeys(db);
    migrateLeadRunParticleSnapshotLiveDemoKey(db);
    migrateLeadRunParticleSnapshotDiscoverJobKey(db);
    migrateLeadRunParticleSnapshotStrategyMirrorKeys(db);
    migrateLeadRunParticleSnapshotFounderExecutionKeys(db);
    database.exec(`
      DROP INDEX IF EXISTS idx_lead_run_particle_snapshots_latest;
      CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_latest
        ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, write_order DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_status
        ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, writeback_status, updated_at DESC);
    `);
    return;
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS lead_run_particle_snapshots (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
      particle_key TEXT NOT NULL CHECK (particle_key IN (
        'human_feedback_calibration_packet',
        'source_quality_benchmark',
        'mission_autoplay_guard',
        'multi_channel_followup_pack',
        'feedback_action_application_packet',
        'prospect_outreach_writeback_packet',
        'next_batch_learning_profile',
        'next_batch_seed_queue',
        'prospect_outreach_channel_adapter_receipt',
        'prospect_outreach_live_demo_acceptance',
        'public_source_discover_job'
      )),
      particle_version TEXT NOT NULL DEFAULT 'v1',
      source_stage TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      quality_status TEXT NOT NULL DEFAULT 'info' CHECK (quality_status IN ('pass', 'warn', 'fail', 'info')),
      writeback_status TEXT NOT NULL DEFAULT 'generated' CHECK (writeback_status IN ('generated', 'applied', 'verified', 'captured')),
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      write_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_latest
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, write_order DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_status
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, writeback_status, updated_at DESC);
  `);
  migrateLeadRunParticleSnapshotDiscoverJobKey(db);
}

function migrateAIScriptGenerationJobKey(db: unknown): void {
  const database = asDatabase(db);
  const tableSql = String(one(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lead_run_particle_snapshots'")?.sql || '');
  if (!tableSql || tableSql.includes('ai_script_generation_job')) return;

  const columns = all(db, "PRAGMA table_info('lead_run_particle_snapshots')").map((row) => String(row.name));
  const writeOrderSelect = columns.includes('write_order') ? 'write_order' : '0 AS write_order';
  const particleKeySql = LEAD_RUN_PARTICLE_KEYS.map((key) => `'${key}'`).join(',\n        ');

  database.exec(`
    PRAGMA foreign_keys=OFF;

    CREATE TABLE lead_run_particle_snapshots_next (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
      particle_key TEXT NOT NULL CHECK (particle_key IN (
        ${particleKeySql}
      )),
      particle_version TEXT NOT NULL DEFAULT 'v1',
      source_stage TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      quality_status TEXT NOT NULL DEFAULT 'info' CHECK (quality_status IN ('pass', 'warn', 'fail', 'info')),
      writeback_status TEXT NOT NULL DEFAULT 'generated' CHECK (writeback_status IN ('generated', 'applied', 'verified', 'captured')),
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      write_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
    );

    INSERT INTO lead_run_particle_snapshots_next
      (id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
       quality_status, writeback_status, payload_hash, payload, write_order, created_at, updated_at)
    SELECT id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
           quality_status, writeback_status, payload_hash, payload, ${writeOrderSelect}, created_at, updated_at
      FROM lead_run_particle_snapshots;

    DROP TABLE lead_run_particle_snapshots;
    ALTER TABLE lead_run_particle_snapshots_next RENAME TO lead_run_particle_snapshots;

    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_latest
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, write_order DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_status
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, writeback_status, updated_at DESC);

    PRAGMA foreign_keys=ON;
  `);
}

/** I73: add compression_discard_audit particle key */
function migrateCompressionDiscardAuditKey(db: unknown): void {
  const database = asDatabase(db);
  const tableSql = String(one(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lead_run_particle_snapshots'")?.sql || '');
  if (!tableSql || tableSql.includes('compression_discard_audit')) return;

  const columns = all(db, "PRAGMA table_info('lead_run_particle_snapshots')").map((row) => String(row.name));
  const writeOrderSelect = columns.includes('write_order') ? 'write_order' : '0 AS write_order';
  const particleKeySql = LEAD_RUN_PARTICLE_KEYS.map((key) => `'${key}'`).join(',\n        ');

  database.exec(`
    PRAGMA foreign_keys=OFF;

    CREATE TABLE lead_run_particle_snapshots_next (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
      particle_key TEXT NOT NULL CHECK (particle_key IN (
        ${particleKeySql}
      )),
      particle_version TEXT NOT NULL DEFAULT 'v1',
      source_stage TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      quality_status TEXT NOT NULL DEFAULT 'info' CHECK (quality_status IN ('pass', 'warn', 'fail', 'info')),
      writeback_status TEXT NOT NULL DEFAULT 'generated' CHECK (writeback_status IN ('generated', 'applied', 'verified', 'captured')),
      payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      write_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
    );

    INSERT INTO lead_run_particle_snapshots_next
      (id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
       quality_status, writeback_status, payload_hash, payload, write_order, created_at, updated_at)
    SELECT id, tenant_id, lead_acquisition_run_id, particle_key, particle_version, source_stage, source_ref,
           quality_status, writeback_status, payload_hash, payload, ${writeOrderSelect}, created_at, updated_at
      FROM lead_run_particle_snapshots;

    DROP TABLE lead_run_particle_snapshots;
    ALTER TABLE lead_run_particle_snapshots_next RENAME TO lead_run_particle_snapshots;

    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_latest
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, write_order DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_status
      ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, writeback_status, updated_at DESC);

    PRAGMA foreign_keys=ON;
  `);
}

function migrateCallCenterSchema(db: unknown): void {
  const database = asDatabase(db);
  const sessionColumns = all(db, "PRAGMA table_info('voice_call_sessions')").map((row) => String(row.name));
  const sessionAlters = [
    sessionColumns.includes('media_type') ? null : "ALTER TABLE voice_call_sessions ADD COLUMN media_type TEXT NOT NULL DEFAULT 'audio';",
    sessionColumns.includes('livekit_room_name') ? null : 'ALTER TABLE voice_call_sessions ADD COLUMN livekit_room_name TEXT NOT NULL DEFAULT \'\';',
    sessionColumns.includes('livekit_room_sid') ? null : 'ALTER TABLE voice_call_sessions ADD COLUMN livekit_room_sid TEXT NOT NULL DEFAULT \'\';',
    sessionColumns.includes('transfer_chain') ? null : "ALTER TABLE voice_call_sessions ADD COLUMN transfer_chain TEXT NOT NULL DEFAULT '[]';",
    sessionColumns.includes('ai_handled') ? null : 'ALTER TABLE voice_call_sessions ADD COLUMN ai_handled INTEGER NOT NULL DEFAULT 0;',
    sessionColumns.includes('transferred') ? null : 'ALTER TABLE voice_call_sessions ADD COLUMN transferred INTEGER NOT NULL DEFAULT 0;'
  ].filter(Boolean) as string[];
  for (const sql of sessionAlters) database.exec(sql);

  database.exec(`
    CREATE TABLE IF NOT EXISTS livekit_rooms (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      room_name TEXT NOT NULL UNIQUE,
      room_sid TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL CHECK (purpose IN ('ai_outbound', 'video_service', 'screen_share', 'conference', 'pstn_bridge')),
      status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'active', 'closed')),
      call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_livekit_rooms_tenant_status ON livekit_rooms(tenant_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_livekit_rooms_call_session ON livekit_rooms(call_session_id);

    CREATE TABLE IF NOT EXISTS livekit_participants (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      room_name TEXT NOT NULL,
      identity TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'unknown' CHECK (role IN ('agent', 'customer', 'supervisor', 'ai', 'sip', 'unknown')),
      status TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'left')),
      metadata TEXT NOT NULL DEFAULT '{}',
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      left_at TEXT,
      UNIQUE(room_name, identity)
    );
    CREATE INDEX IF NOT EXISTS idx_livekit_participants_room ON livekit_participants(room_name, status, joined_at);
    CREATE INDEX IF NOT EXISTS idx_livekit_participants_tenant ON livekit_participants(tenant_id, joined_at DESC);

    CREATE TABLE IF NOT EXISTS call_recordings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
      media_call_id TEXT,
      room_name TEXT NOT NULL DEFAULT '',
      business_ref_type TEXT NOT NULL DEFAULT '',
      business_ref_id TEXT NOT NULL DEFAULT '',
      business_ref_metadata TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL CHECK (source IN ('livekit_egress', 'rustpbx_sipflow')),
      format TEXT NOT NULL CHECK (format IN ('mp4', 'webm', 'wav', 'ogg')),
      storage_url TEXT NOT NULL DEFAULT '',
      evidence_record_id TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER,
      file_size_bytes INTEGER,
      has_video INTEGER NOT NULL DEFAULT 0,
      recording_mode TEXT NOT NULL DEFAULT 'room_composite' CHECK (recording_mode IN ('track', 'track_composite', 'room_composite')),
      egress_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('starting', 'pending', 'recording', 'stopping', 'stopped', 'completed', 'failed', 'deleted')),
      retention_until TEXT,
      object_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (object_status IN ('unchecked', 'readable', 'missing_storage_url', 'not_found', 'forbidden', 'unsupported', 'fetch_failed', 'deleted', 'delete_failed')),
      object_checked_at TEXT,
      failure_code TEXT NOT NULL DEFAULT '',
      completed_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_call_recordings_session ON call_recordings(call_session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_recordings_business ON call_recordings(tenant_id, business_ref_type, business_ref_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_recordings_retention ON call_recordings(tenant_id, retention_until, status);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_call_recordings_egress_id ON call_recordings(egress_id) WHERE egress_id != '';
    CREATE TABLE IF NOT EXISTS livekit_egress_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      recording_id TEXT NOT NULL REFERENCES call_recordings(id) ON DELETE CASCADE,
      job_sequence INTEGER NOT NULL CHECK (job_sequence >= 1),
      room_name TEXT NOT NULL,
      recording_mode TEXT NOT NULL CHECK (recording_mode IN ('track', 'track_composite', 'room_composite')),
      track_id TEXT NOT NULL DEFAULT '',
      track_kind TEXT NOT NULL DEFAULT '',
      track_source TEXT NOT NULL DEFAULT '',
      audio_track_id TEXT NOT NULL DEFAULT '',
      video_track_id TEXT NOT NULL DEFAULT '',
      storage_url TEXT NOT NULL,
      egress_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'pending', 'recording', 'stopping', 'stopped', 'completed', 'failed')),
      failure_code TEXT NOT NULL DEFAULT '',
      reservation_id TEXT NOT NULL DEFAULT '',
      owner_epoch TEXT,
      duration_ms INTEGER,
      file_size_bytes INTEGER,
      object_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (object_status IN ('unchecked', 'readable', 'missing_storage_url', 'not_found', 'forbidden', 'unsupported', 'fetch_failed', 'deleted', 'delete_failed')),
      object_checked_at TEXT,
      provider_observed_at TEXT,
      provider_missing_count INTEGER NOT NULL DEFAULT 0 CHECK (provider_missing_count >= 0),
      reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
      reconcile_after TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reconcile_lease_until TEXT,
      reconcile_worker_id TEXT NOT NULL DEFAULT '',
      completed_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(recording_id, id),
      UNIQUE(recording_id, job_sequence)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_livekit_egress_jobs_provider_id
      ON livekit_egress_jobs(egress_id) WHERE egress_id != '';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_livekit_egress_jobs_track
      ON livekit_egress_jobs(recording_id, track_id)
      WHERE recording_mode = 'track';
    CREATE INDEX IF NOT EXISTS idx_livekit_egress_jobs_recording
      ON livekit_egress_jobs(tenant_id, recording_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_livekit_egress_jobs_active
      ON livekit_egress_jobs(tenant_id, status, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_livekit_egress_jobs_reconcile
      ON livekit_egress_jobs(tenant_id, reconcile_after, reconcile_lease_until, updated_at, id)
      WHERE status IN ('starting', 'recording', 'stopping');
    CREATE TABLE IF NOT EXISTS ai_conversation_turns (
      id TEXT PRIMARY KEY,
      call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('customer', 'ai', 'system', 'agent')),
      content TEXT NOT NULL,
      stt_confidence REAL,
      intent_score REAL,
      latency_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_conversation_turns_session ON ai_conversation_turns(call_session_id, turn_index);

    CREATE TABLE IF NOT EXISTS agent_seats (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'idle', 'busy', 'break', 'away', 'training', 'lunch', 'wrap_up')),
      skills TEXT NOT NULL DEFAULT '[]',
      current_call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
      livekit_identity TEXT NOT NULL DEFAULT '',
      rustpbx_extension TEXT NOT NULL DEFAULT '',
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_seats_tenant_status ON agent_seats(tenant_id, status, last_heartbeat_at DESC);

    CREATE TABLE IF NOT EXISTS outbound_tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id TEXT NOT NULL DEFAULT '',
      phone_number TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('pstn_voice', 'video_link_sms', 'video_link_wechat')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dialing', 'connected', 'completed', 'failed', 'cancelled')),
      strategy TEXT NOT NULL DEFAULT '{}',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      priority INTEGER NOT NULL DEFAULT 5,
      scheduled_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      result TEXT NOT NULL DEFAULT '{}',
      call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_tasks_pick ON outbound_tasks(tenant_id, status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_outbound_tasks_phone ON outbound_tasks(tenant_id, phone_number, created_at DESC);

    CREATE TABLE IF NOT EXISTS voice_agent_specs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'zh' CHECK (language IN ('zh', 'en', 'ja')),
      goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'needs_repair')),
      version INTEGER NOT NULL DEFAULT 1,
      tools TEXT NOT NULL DEFAULT '[]',
      compliance TEXT NOT NULL DEFAULT '{}',
      runtime TEXT NOT NULL DEFAULT '{}',
      nodes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_voice_agent_specs_tenant ON voice_agent_specs(tenant_id, status, updated_at DESC);
  `);
  migrateCallRecordingsBusinessRef(db);
}

function migrateCallRecordingsBusinessRef(db: unknown): void {
  const database = asDatabase(db);
  const columns = all(db, "PRAGMA table_info('call_recordings')");
  const columnNames = columns.map((row) => String(row.name));
  const alters = [
    columnNames.includes('business_ref_type') ? null : "ALTER TABLE call_recordings ADD COLUMN business_ref_type TEXT NOT NULL DEFAULT '';",
    columnNames.includes('business_ref_id') ? null : "ALTER TABLE call_recordings ADD COLUMN business_ref_id TEXT NOT NULL DEFAULT '';",
    columnNames.includes('business_ref_metadata') ? null : "ALTER TABLE call_recordings ADD COLUMN business_ref_metadata TEXT NOT NULL DEFAULT '{}';"
  ].filter(Boolean) as string[];
  for (const sql of alters) database.exec(sql);

  const refreshedColumns = all(db, "PRAGMA table_info('call_recordings')");
  const callSessionColumn = refreshedColumns.find((row) => String(row.name) === 'call_session_id');
  if (Number(callSessionColumn?.notnull || 0) === 1) {
    database.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE call_recordings_business_ref (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
        media_call_id TEXT,
        room_name TEXT NOT NULL DEFAULT '',
        business_ref_type TEXT NOT NULL DEFAULT '',
        business_ref_id TEXT NOT NULL DEFAULT '',
        business_ref_metadata TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL CHECK (source IN ('livekit_egress', 'rustpbx_sipflow')),
        format TEXT NOT NULL CHECK (format IN ('mp4', 'webm', 'wav', 'ogg')),
        storage_url TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER,
        file_size_bytes INTEGER,
        has_video INTEGER NOT NULL DEFAULT 0,
        egress_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'completed',
        retention_until TEXT,
        object_status TEXT NOT NULL DEFAULT 'unchecked',
        object_checked_at TEXT,
        failure_code TEXT NOT NULL DEFAULT '',
        completed_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO call_recordings_business_ref
        (id, tenant_id, call_session_id, media_call_id, room_name, business_ref_type, business_ref_id, business_ref_metadata,
         source, format, storage_url, duration_ms, file_size_bytes, has_video, egress_id, created_at)
      SELECT
        id,
        tenant_id,
        call_session_id,
        NULL,
        '',
        CASE WHEN business_ref_type != '' THEN business_ref_type ELSE 'call_session' END,
        CASE WHEN business_ref_id != '' THEN business_ref_id ELSE call_session_id END,
        COALESCE(business_ref_metadata, '{}'),
        source,
        format,
        storage_url,
        duration_ms,
        file_size_bytes,
        has_video,
        egress_id,
        created_at
      FROM call_recordings;
      DROP TABLE call_recordings;
      ALTER TABLE call_recordings_business_ref RENAME TO call_recordings;
      PRAGMA foreign_keys=ON;
    `);
  }

  const lifecycleColumns = all(db, "PRAGMA table_info('call_recordings')").map((row) => String(row.name));
  const lifecycleAlters = [
    lifecycleColumns.includes('media_call_id') ? null : 'ALTER TABLE call_recordings ADD COLUMN media_call_id TEXT;',
    lifecycleColumns.includes('room_name') ? null : "ALTER TABLE call_recordings ADD COLUMN room_name TEXT NOT NULL DEFAULT '';",
    lifecycleColumns.includes('status') ? null : "ALTER TABLE call_recordings ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';",
    lifecycleColumns.includes('retention_until') ? null : 'ALTER TABLE call_recordings ADD COLUMN retention_until TEXT;',
    lifecycleColumns.includes('object_status') ? null : "ALTER TABLE call_recordings ADD COLUMN object_status TEXT NOT NULL DEFAULT 'unchecked';",
    lifecycleColumns.includes('object_checked_at') ? null : 'ALTER TABLE call_recordings ADD COLUMN object_checked_at TEXT;',
    lifecycleColumns.includes('failure_code') ? null : "ALTER TABLE call_recordings ADD COLUMN failure_code TEXT NOT NULL DEFAULT '';",
    lifecycleColumns.includes('completed_at') ? null : 'ALTER TABLE call_recordings ADD COLUMN completed_at TEXT;',
    lifecycleColumns.includes('deleted_at') ? null : 'ALTER TABLE call_recordings ADD COLUMN deleted_at TEXT;',
    lifecycleColumns.includes('updated_at') ? null : 'ALTER TABLE call_recordings ADD COLUMN updated_at TEXT;',
    lifecycleColumns.includes('evidence_record_id') ? null : "ALTER TABLE call_recordings ADD COLUMN evidence_record_id TEXT NOT NULL DEFAULT '';"
  ].filter(Boolean) as string[];
  for (const sql of lifecycleAlters) database.exec(sql);

  database.exec(`
    UPDATE call_recordings
    SET business_ref_type = 'call_session',
        business_ref_id = call_session_id,
        business_ref_metadata = COALESCE(NULLIF(business_ref_metadata, ''), '{}')
    WHERE business_ref_type = '' AND COALESCE(call_session_id, '') != '';
    CREATE INDEX IF NOT EXISTS idx_call_recordings_session ON call_recordings(call_session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_recordings_media_call ON call_recordings(tenant_id, media_call_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_recordings_evidence ON call_recordings(tenant_id, evidence_record_id) WHERE evidence_record_id != '';
    CREATE INDEX IF NOT EXISTS idx_call_recordings_room ON call_recordings(tenant_id, room_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_recordings_business ON call_recordings(tenant_id, business_ref_type, business_ref_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_recordings_retention ON call_recordings(tenant_id, retention_until, status);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_call_recordings_egress_id ON call_recordings(egress_id) WHERE egress_id != '';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_call_recordings_active_room ON call_recordings(tenant_id, room_name)
      WHERE room_name != '' AND status IN ('starting', 'pending', 'recording', 'stopping');
    UPDATE call_recordings SET updated_at = COALESCE(updated_at, created_at);
  `);
}

function migrateAgentSeatStatuses(db: unknown): void {
  const database = asDatabase(db);
  const table = one(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_seats'");
  const sql = String(table?.sql || '');
  if (!sql || sql.includes("'training'")) return;

  database.exec(`
    CREATE TABLE agent_seats_sprint3 (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'idle', 'busy', 'break', 'away', 'training', 'lunch', 'wrap_up')),
      skills TEXT NOT NULL DEFAULT '[]',
      current_call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
      livekit_identity TEXT NOT NULL DEFAULT '',
      rustpbx_extension TEXT NOT NULL DEFAULT '',
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, user_id)
    );
    INSERT INTO agent_seats_sprint3 SELECT * FROM agent_seats;
    DROP TABLE agent_seats;
    ALTER TABLE agent_seats_sprint3 RENAME TO agent_seats;
    CREATE INDEX IF NOT EXISTS idx_agent_seats_tenant_status ON agent_seats(tenant_id, status, last_heartbeat_at DESC);
  `);
}

function migrateInboundAcdSchema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS call_queues (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'longest_idle',
      max_wait_sec INTEGER NOT NULL DEFAULT 300,
      max_size INTEGER NOT NULL DEFAULT 50,
      overflow_target TEXT,
      music_url TEXT,
      callback_after_sec INTEGER NOT NULL DEFAULT 120,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_call_queues_tenant ON call_queues(tenant_id, is_active);

    CREATE TABLE IF NOT EXISTS queue_members (
      queue_id TEXT NOT NULL REFERENCES call_queues(id) ON DELETE CASCADE,
      seat_id TEXT NOT NULL REFERENCES agent_seats(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (queue_id, seat_id)
    );

    CREATE TABLE IF NOT EXISTS did_numbers (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
      number TEXT NOT NULL UNIQUE,
      label TEXT,
      route_type TEXT NOT NULL DEFAULT 'queue',
      route_target TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_did_numbers_tenant ON did_numbers(tenant_id, is_active);

    CREATE TABLE IF NOT EXISTS queue_entries (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL REFERENCES call_queues(id) ON DELETE CASCADE,
      call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      assigned_seat_id TEXT REFERENCES agent_seats(id) ON DELETE SET NULL,
      entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      answered_at TEXT,
      abandoned_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_entries_queue ON queue_entries(queue_id, abandoned_at, answered_at, position);

    CREATE TABLE IF NOT EXISTS queue_callbacks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      queue_id TEXT NOT NULL REFERENCES call_queues(id) ON DELETE CASCADE,
      call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
      phone_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dialing', 'completed', 'failed', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_callbacks_status ON queue_callbacks(tenant_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS auto_attendant_config (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      business_hours TEXT NOT NULL DEFAULT '{"mon":[9,18],"tue":[9,18],"wed":[9,18],"thu":[9,18],"fri":[9,18]}',
      after_hours_route_type TEXT NOT NULL DEFAULT 'announcement',
      after_hours_route_target TEXT,
      announcement_text TEXT NOT NULL DEFAULT '您好，当前为非工作时间，请在工作日 9:00-18:00 来电。',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function migrateAgentToolsSchema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS disposition_codes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      category TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(tenant_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_disposition_codes_tenant ON disposition_codes(tenant_id, is_active);

    CREATE TABLE IF NOT EXISTS call_dispositions (
      call_session_id TEXT PRIMARY KEY REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
      disposition_code TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_script_templates (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      steps TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agent_script_templates_tenant ON agent_script_templates(tenant_id, is_active);

    CREATE TABLE IF NOT EXISTS call_summaries (
      call_session_id TEXT PRIMARY KEY REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'llm',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function migrateSupervisorVoicemailSchema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS voicemails (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
      from_number TEXT NOT NULL DEFAULT '',
      mailbox TEXT NOT NULL DEFAULT 'default',
      recording_url TEXT NOT NULL DEFAULT '',
      transcript TEXT,
      duration_sec INTEGER,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'archived')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_voicemails_tenant ON voicemails(tenant_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS call_park_slots (
      slot INTEGER NOT NULL,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
      parked_by_seat_id TEXT NOT NULL,
      parked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, slot)
    );

    CREATE TABLE IF NOT EXISTS qm_appeals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      evaluation_id TEXT NOT NULL,
      call_session_id TEXT NOT NULL,
      appellant_user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewer_user_id TEXT,
      resolution_notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_qm_appeals_tenant ON qm_appeals(tenant_id, status, created_at DESC);
  `);
}

function migrateOutboundCampaignSchema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS outbound_campaigns (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      dial_mode TEXT NOT NULL DEFAULT 'predictive' CHECK (dial_mode IN ('preview', 'progressive', 'predictive')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
      agent_spec_id_a TEXT NOT NULL DEFAULT '',
      agent_spec_id_b TEXT NOT NULL DEFAULT '',
      ab_enabled INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      scheduled_start TEXT,
      scheduled_end TEXT,
      stats TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_tenant ON outbound_campaigns(tenant_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS outbound_campaign_contacts (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      phone_number TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dialed', 'completed', 'skipped', 'failed')),
      ab_variant TEXT NOT NULL DEFAULT 'A',
      disposition TEXT,
      outbound_task_id TEXT REFERENCES outbound_tasks(id) ON DELETE SET NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_pick ON outbound_campaign_contacts(campaign_id, status, created_at ASC);

    CREATE TABLE IF NOT EXISTS post_call_surveys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
      campaign_id TEXT REFERENCES outbound_campaigns(id) ON DELETE SET NULL,
      score INTEGER CHECK (score BETWEEN 1 AND 5),
      comment TEXT,
      channel TEXT NOT NULL DEFAULT 'ivr',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_post_call_surveys_tenant ON post_call_surveys(tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wfm_shift_swap_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      requester_seat_id TEXT NOT NULL,
      target_seat_id TEXT,
      schedule_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewer_user_id TEXT,
      resolution_notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wfm_shift_swap_tenant ON wfm_shift_swap_requests(tenant_id, status, created_at DESC);
  `);

  const taskCols = all(db, 'PRAGMA table_info(outbound_tasks)');
  const colNames = new Set(taskCols.map((c) => String((c as { name: string }).name)));
  if (!colNames.has('campaign_id')) {
    database.exec(`ALTER TABLE outbound_tasks ADD COLUMN campaign_id TEXT REFERENCES outbound_campaigns(id) ON DELETE SET NULL`);
  }
  if (!colNames.has('campaign_contact_id')) {
    database.exec(`ALTER TABLE outbound_tasks ADD COLUMN campaign_contact_id TEXT`);
  }
}

function migrateOmniChannelSchema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS omni_conversations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('web_chat', 'sms', 'email', 'wechat', 'whatsapp', 'facebook_messenger')),
      customer_id TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      customer_email TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'assigned', 'resolved', 'closed')),
      assigned_seat_id TEXT REFERENCES agent_seats(id) ON DELETE SET NULL,
      intent_score REAL,
      last_message_preview TEXT NOT NULL DEFAULT '',
      last_message_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_omni_conversations_inbox ON omni_conversations(tenant_id, status, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_omni_conversations_customer ON omni_conversations(tenant_id, customer_phone, customer_email);

    CREATE TABLE IF NOT EXISTS omni_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES omni_conversations(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'system')),
      sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'agent', 'bot', 'system')),
      content TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'html', 'image', 'file')),
      external_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_omni_messages_conv ON omni_messages(conversation_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS omni_notifications (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
      target TEXT NOT NULL,
      template_key TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
      sent_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_omni_notifications_pending ON omni_notifications(tenant_id, status, scheduled_at);

    CREATE TABLE IF NOT EXISTS customer_journey_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      customer_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      channel TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      ref_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_journey_customer ON customer_journey_events(tenant_id, customer_key, occurred_at DESC);
  `);
}

function migrateSprint10Schema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      secret TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_tenant ON webhook_subscriptions(tenant_id);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'retrying')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_retry_at TEXT,
      http_status INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant ON webhook_deliveries(tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS knowledge_query_log (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      query TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      confidence REAL,
      source_channel TEXT NOT NULL DEFAULT 'api',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_kb_query_tenant ON knowledge_query_log(tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS recording_batch_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      filters TEXT NOT NULL DEFAULT '{}',
      result TEXT NOT NULL DEFAULT '{}',
      recording_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rec_batch_tenant ON recording_batch_jobs(tenant_id, created_at DESC);
  `);
}

function migrateSprint11Schema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS tenant_compliance_settings (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      recording_retention_days INTEGER NOT NULL DEFAULT 90,
      audit_log_retention_days INTEGER NOT NULL DEFAULT 365,
      omni_retention_days INTEGER NOT NULL DEFAULT 180,
      auto_purge_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gdpr_deletion_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      customer_key TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
      summary TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gdpr_tenant ON gdpr_deletion_requests(tenant_id, created_at DESC);
  `);
}

function migrateSprint10CompleteSchema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS tenant_sso_configs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      issuer_url TEXT NOT NULL DEFAULT '',
      client_id TEXT NOT NULL DEFAULT '',
      client_secret TEXT NOT NULL DEFAULT '',
      redirect_uri TEXT NOT NULL DEFAULT '',
      scopes TEXT NOT NULL DEFAULT 'openid profile email',
      default_role TEXT NOT NULL DEFAULT 'operator',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS white_label_email_templates (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      template_key TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, template_key)
    );
    CREATE INDEX IF NOT EXISTS idx_wl_email_tpl ON white_label_email_templates(tenant_id, template_key);
  `);
}

function migrateSprint12Schema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS proactive_push_rules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      trigger_event TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'web_chat',
      message_template TEXT NOT NULL DEFAULT '',
      min_intent_score REAL NOT NULL DEFAULT 0.5,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_push_rules_tenant ON proactive_push_rules(tenant_id, enabled);

    CREATE TABLE IF NOT EXISTS proactive_push_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      rule_id TEXT NOT NULL REFERENCES proactive_push_rules(id) ON DELETE CASCADE,
      customer_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('sent', 'queued', 'failed', 'skipped')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_push_events_tenant ON proactive_push_events(tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS dashboard_widgets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      widget_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_tenant ON dashboard_widgets(tenant_id, position);

    CREATE TABLE IF NOT EXISTS screen_recordings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      call_session_id TEXT,
      seat_id TEXT,
      storage_url TEXT NOT NULL DEFAULT '',
      duration_sec INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_screen_rec_tenant ON screen_recordings(tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS routing_predictions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      queue_id TEXT,
      recommended_seat_id TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      factors TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_routing_pred_tenant ON routing_predictions(tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS intent_predictions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      customer_key TEXT NOT NULL,
      intent_score REAL NOT NULL DEFAULT 0,
      predicted_topic TEXT NOT NULL DEFAULT '',
      signals TEXT NOT NULL DEFAULT '[]',
      recommended_action TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_intent_pred_tenant ON intent_predictions(tenant_id, created_at DESC);
  `);
}

function migrateSprint12IvrMarketplaceSchema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS ivr_marketplace_components (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0.0',
      author TEXT NOT NULL DEFAULT 'Converact',
      description TEXT NOT NULL DEFAULT '',
      manifest TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ivr_components_tenant ON ivr_marketplace_components(tenant_id, status);

    CREATE TABLE IF NOT EXISTS ivr_component_installs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES ivr_marketplace_components(id) ON DELETE CASCADE,
      menu_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, menu_key)
    );
    CREATE INDEX IF NOT EXISTS idx_ivr_installs_tenant ON ivr_component_installs(tenant_id, menu_key);
  `);
}

function migrateOmniFacebookMessengerChannel(db: unknown): void {
  const database = asDatabase(db);
  const row = one(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='omni_conversations'");
  if (!row || String(row.sql || '').includes('facebook_messenger')) return;
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE omni_conversations_new (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('web_chat', 'sms', 'email', 'wechat', 'whatsapp', 'facebook_messenger')),
      customer_id TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      customer_email TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'assigned', 'resolved', 'closed')),
      assigned_seat_id TEXT REFERENCES agent_seats(id) ON DELETE SET NULL,
      intent_score REAL,
      last_message_preview TEXT NOT NULL DEFAULT '',
      last_message_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO omni_conversations_new SELECT * FROM omni_conversations;
    DROP TABLE omni_conversations;
    ALTER TABLE omni_conversations_new RENAME TO omni_conversations;
    CREATE INDEX IF NOT EXISTS idx_omni_conversations_inbox ON omni_conversations(tenant_id, status, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_omni_conversations_customer ON omni_conversations(tenant_id, customer_phone, customer_email);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function migrateFacebookChannelConfigSchema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS facebook_channel_configs (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      page_id TEXT NOT NULL DEFAULT '',
      page_access_token TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function migratePhase3AgentPanelSchema(db: unknown): void {
  const database = asDatabase(db);
  database.exec(`
    CREATE TABLE IF NOT EXISTS transfer_queue (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
      room_name TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      customer_summary TEXT NOT NULL DEFAULT '',
      intent_score REAL NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 5,
      enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      assigned_seat_id TEXT REFERENCES agent_seats(id) ON DELETE SET NULL,
      assigned_at TEXT,
      expired_at TEXT,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'assigned', 'expired', 'cancelled'))
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_queue_status ON transfer_queue(tenant_id, status, enqueued_at ASC);
  `);
}

function migrateIvrFlowNeedsRepairStatus(db: unknown): void {
  const row = one(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='voice_agent_specs'");
  const sql = String(row?.sql || '');
  if (!sql || sql.includes('needs_repair')) return;

  const database = asDatabase(db);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE voice_agent_specs_needs_repair (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'zh' CHECK (language IN ('zh', 'en', 'ja')),
      goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'needs_repair')),
      version INTEGER NOT NULL DEFAULT 1,
      tools TEXT NOT NULL DEFAULT '[]',
      compliance TEXT NOT NULL DEFAULT '{}',
      runtime TEXT NOT NULL DEFAULT '{}',
      nodes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO voice_agent_specs_needs_repair
      SELECT * FROM voice_agent_specs;
    DROP TABLE voice_agent_specs;
    ALTER TABLE voice_agent_specs_needs_repair RENAME TO voice_agent_specs;
    CREATE INDEX IF NOT EXISTS idx_voice_agent_specs_tenant ON voice_agent_specs(tenant_id, status, updated_at DESC);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
