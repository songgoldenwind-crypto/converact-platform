import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'src/migrations/050_ivekit_ivr_runtime.sql';

test('IVR runtime migration adds idempotent immutable release metadata', () => {
  assert.equal(existsSync(migrationPath), true, migrationPath);
  const sql = readFileSync(migrationPath, 'utf8');

  for (const column of [
    'release_kind',
    'source_version',
    'publication_key',
    'publication_payload_hash',
    'release_metadata'
  ]) assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`, 'i'), column);
  assert.match(sql, /release_kind[\s\S]*CHECK \(release_kind IN \('publish', 'rollback'\)\)/i);
  assert.match(sql, /publication_payload_hash[\s\S]*char_length\(publication_payload_hash\) = 64/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_ivr_versions_publication_key[\s\S]*WHERE publication_key <> ''/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_versions_published/i);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS ivekit_ivr_flow_versions_tenant_id_flow_id_graph_hash_key/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_versions_graph_hash/i);
  assert.doesNotMatch(sql, /UPDATE\s+ivekit_ivr_flow_versions\s+SET/i);
});

test('IVR runtime migration persists provider sequence and replay state on sessions', () => {
  assert.equal(existsSync(migrationPath), true, migrationPath);
  const sql = readFileSync(migrationPath, 'utf8');

  for (const column of [
    'provider_profile_id',
    'provider_session_id',
    'last_event_sequence',
    'last_event_payload_hash',
    'last_action_revision',
    'last_action',
    'provider_metadata',
    'trace_id'
  ]) assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`, 'i'), column);
  assert.match(sql, /last_event_sequence INTEGER NOT NULL DEFAULT 0\s+CHECK \(last_event_sequence >= 0\)/i);
  assert.match(sql, /last_action_revision INTEGER NOT NULL DEFAULT 0\s+CHECK \(last_action_revision >= 0\)/i);
  assert.match(sql, /last_event_payload_hash TEXT NOT NULL DEFAULT ''[\s\S]*char_length\(last_event_payload_hash\) = 64/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, provider_profile_id\)[\s\S]*ivekit_voice_deployment_profiles\(tenant_id, id\)/i);
  assert.match(sql, /CHECK \([\s\S]*provider_profile_id IS NULL[\s\S]*provider_session_id IS NULL[\s\S]*provider_profile_id <> ''[\s\S]*provider_session_id <> ''/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_ivr_sessions_provider_binding/i);
  assert.match(sql, /ALTER TABLE ivekit_ivr_session_steps[\s\S]*ADD COLUMN IF NOT EXISTS flow_id TEXT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS flow_version INTEGER CHECK \(flow_version > 0\)/i);
  assert.match(sql, /UPDATE ivekit_ivr_session_steps step[\s\S]*SET flow_id = session\.flow_id/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, flow_id, flow_version\)[\s\S]*ivekit_ivr_flow_versions/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_steps_flow_version/i);
});

test('IVR runtime migration extends durable action recovery and tenant discovery', () => {
  assert.equal(existsSync(migrationPath), true, migrationPath);
  const sql = readFileSync(migrationPath, 'utf8');

  assert.match(sql, /ALTER TABLE ivekit_ivr_pending_actions[\s\S]*ADD COLUMN IF NOT EXISTS trace_id/i);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS ivekit_ivr_pending_actions_action_kind_check/i);
  for (const kind of [
    'play', 'collect', 'flush', 'queue', 'transfer', 'record', 'webhook',
    'knowledge', 'ai', 'media', 'hangup', 'wait'
  ]) assert.match(sql, new RegExp(`'${kind}'`), kind);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS dispatch_mode TEXT NOT NULL DEFAULT 'worker'/i);
  assert.match(sql, /dispatch_mode IN \('worker', 'provider_exchange'\)/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reconciliation_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_actions_tenant_due/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION opc_worker_tenant_ids\(/i);
  assert.match(sql, /p_queue = 'ivr_pending_action'/i);
  assert.match(sql, /FROM public\.ivekit_ivr_pending_actions/i);
  assert.match(sql, /a\.dispatch_mode = 'worker'/i);
  for (const queue of [
    'tinode', 'attachment', 'quality', 'translation', 'media_call_timeout',
    'voice_command', 'voice_configuration', 'voice_provider_event', 'ivr_pending_action'
  ]) assert.match(sql, new RegExp(`p_queue = '${queue}'`, 'i'), queue);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_worker_tenant_ids\(TEXT, TIMESTAMPTZ, INTEGER\) FROM PUBLIC/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION opc_worker_tenant_ids\(TEXT, TIMESTAMPTZ, INTEGER\) TO opc_runtime/i);
});

test('standalone source and delivery manifests include IVR runtime migration in order', () => {
  const sourcePolicy = readFileSync('services/converact-service/source-policy.json', 'utf8');
  const delivery = readFileSync('scripts/ivekit-delivery-bundle.ts', 'utf8');
  for (const source of [sourcePolicy, delivery]) assert.match(source, /050_ivekit_ivr_runtime\.sql/);
  assert.ok(sourcePolicy.indexOf('049_ivekit_voice_route_deployment.sql') < sourcePolicy.indexOf('050_ivekit_ivr_runtime.sql'));
  assert.ok(sourcePolicy.indexOf('050_ivekit_ivr_runtime.sql') < sourcePolicy.indexOf('090_ivekit_runtime_security.sql'));
});
