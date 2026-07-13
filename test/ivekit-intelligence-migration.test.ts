import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'src/migrations/043_ivekit_intelligence_translation.sql';
const qualityRoutingMigrationPath = 'src/migrations/044_quality_review_policy_routing.sql';
const translationWorkerMigrationPath = 'src/migrations/045_translation_worker_routing.sql';

test('V3 intelligence migration defines tenant policy, source links, and durable translation jobs', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  for (const table of [
    'collaboration_intelligence_policies',
    'collaboration_intelligence_source_links',
    'collaboration_translation_jobs'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'), table);
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'), table);
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'), table);
    assert.match(
      sql,
      new RegExp(`CREATE POLICY tenant_isolation ON ${table}[\\s\\S]*tenant_id = opc_current_tenant\\(\\)`, 'i'),
      table
    );
  }

  assert.match(sql, /source_type TEXT NOT NULL[\s\S]*CHECK \(source_type IN \('media_recording', 'remote_recording'\)\)/i);
  assert.match(sql, /UNIQUE \(tenant_id, source_type, source_ref_id, session_id\)/i);
  assert.match(sql, /collaboration_intelligence_source_links[\s\S]*idempotency_key TEXT NOT NULL/i);
  assert.match(sql, /collaboration_intelligence_source_links[\s\S]*request_hash TEXT NOT NULL/i);
  assert.match(sql, /processor_profile_id TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'pending'[\s\S]*'retry_wait'[\s\S]*'cancelled'/i);
  assert.match(sql, /source_hash TEXT NOT NULL[\s\S]*char_length\(source_hash\) = 64/i);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/i);
  assert.match(sql, /UNIQUE \(tenant_id, source_type, source_ref_id, target_language, source_hash\)/i);
  assert.match(sql, /idx_collaboration_translation_jobs_due/i);
  assert.match(
    sql,
    /ALTER TABLE collaboration_attachment_processing_jobs[\s\S]*ADD COLUMN IF NOT EXISTS provider_profile_id/i
  );
  assert.match(
    sql,
    /ALTER TABLE collaboration_quality_review_jobs[\s\S]*ADD COLUMN IF NOT EXISTS provider_profile_id/i
  );
});

test('quality routing migration records whether work was automatically triggered', () => {
  const sql = readFileSync(qualityRoutingMigrationPath, 'utf8');
  assert.match(
    sql,
    /ALTER TABLE collaboration_quality_review_jobs[\s\S]*ADD COLUMN IF NOT EXISTS automatic BOOLEAN NOT NULL DEFAULT TRUE/i
  );
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM/i);
});

test('translation worker migration adds trigger origin and tenant discovery without weakening function security', () => {
  const sql = readFileSync(translationWorkerMigrationPath, 'utf8');
  assert.match(sql, /collaboration_translation_jobs[\s\S]*automatic BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(sql, /p_queue = 'translation'[\s\S]*collaboration_translation_jobs/i);
  assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_worker_tenant_ids/i);
});

test('V3 intelligence migration extends translation results without dropping legacy data', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  for (const column of [
    'source_type',
    'source_ref_id',
    'source_hash',
    'source_language',
    'provider_profile_id',
    'provider_mode',
    'provider_request_id',
    'output_metadata',
    'updated_at'
  ]) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE collaboration_message_translations[\\s\\S]*ADD COLUMN IF NOT EXISTS ${column}\\b`, 'i'),
      column
    );
  }

  assert.match(sql, /UPDATE collaboration_message_translations[\s\S]*source_ref_id = message_id/i);
  assert.match(sql, /UPDATE collaboration_message_translations[\s\S]*source_hash =/i);
  assert.match(sql, /idx_collaboration_translations_current_source/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM collaboration_message_translations/i);
});

test('V3 intelligence policy is deployment-profile based and cannot store provider secrets', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  for (const column of [
    'ocr_profile_id',
    'asr_profile_id',
    'quality_profile_id',
    'translation_profile_id',
    'allow_third_party',
    'auto_translation',
    'translation_target_languages',
    'version',
    'updated_by'
  ]) assert.match(sql, new RegExp(`\\b${column}\\b`, 'i'), column);

  assert.doesNotMatch(sql, /api_key|access_key|secret_key|password|bearer_token|provider_token/i);
  assert.match(sql, /min_ocr_confidence[\s\S]*BETWEEN 0 AND 1/i);
  assert.match(sql, /min_asr_confidence[\s\S]*BETWEEN 0 AND 1/i);
});
