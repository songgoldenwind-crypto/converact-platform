import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'src/migrations/043_ivekit_intelligence_translation.sql';

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
  assert.match(sql, /processor_profile_id TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'pending'[\s\S]*'retry_wait'[\s\S]*'cancelled'/i);
  assert.match(sql, /source_hash TEXT NOT NULL[\s\S]*char_length\(source_hash\) = 64/i);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/i);
  assert.match(sql, /UNIQUE \(tenant_id, source_type, source_ref_id, target_language, source_hash\)/i);
  assert.match(sql, /idx_collaboration_translation_jobs_due/i);
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
