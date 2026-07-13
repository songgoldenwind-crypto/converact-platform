import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'src/migrations/048_ivekit_voice_operations.sql';

function tableDefinition(sql: string, table: string): string {
  const match = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`,
    'i'
  ));
  assert.ok(match, `missing table definition: ${table}`);
  return match[1];
}

test('Voice operations migration adds a durable configuration command authority', () => {
  assert.equal(existsSync(migrationPath), true, migrationPath);
  const sql = readFileSync(migrationPath, 'utf8');
  const table = tableDefinition(sql, 'ivekit_voice_configuration_commands');

  for (const field of [
    'tenant_id',
    'profile_id',
    'resource_type',
    'resource_id',
    'operation',
    'state',
    'idempotency_key',
    'payload_hash',
    'payload',
    'attempt_count',
    'max_attempts',
    'next_attempt_at',
    'lease_until',
    'worker_id',
    'provider_command_id',
    'result',
    'error_code',
    'error_message',
    'created_at',
    'updated_at',
    'completed_at'
  ]) assert.match(table, new RegExp(`\\b${field}\\b`, 'i'), field);

  assert.match(table, /tenant_id TEXT NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/i);
  assert.match(table, /FOREIGN KEY \(tenant_id, profile_id\)[\s\S]*ivekit_voice_deployment_profiles\(tenant_id, id\)/i);
  assert.match(table, /payload_hash TEXT NOT NULL CHECK \(char_length\(payload_hash\) = 64\)/i);
  assert.match(table, /attempt_count INTEGER NOT NULL DEFAULT 0 CHECK \(attempt_count >= 0\)/i);
  assert.match(table, /max_attempts INTEGER NOT NULL DEFAULT 3 CHECK \(max_attempts BETWEEN 1 AND 10\)/i);
  assert.match(table, /CHECK \(attempt_count <= max_attempts\)/i);
  assert.match(table, /UNIQUE \(tenant_id, idempotency_key\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_ivekit_voice_configuration_commands_due/i);
  assert.match(sql, /ALTER TABLE ivekit_voice_configuration_commands ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /ALTER TABLE ivekit_voice_configuration_commands FORCE ROW LEVEL SECURITY/i);
  assert.match(sql, /CREATE POLICY tenant_isolation ON ivekit_voice_configuration_commands/i);
  assert.doesNotMatch(sql, /\bsqlite\b|voice_call_sessions|lead_id|customer_id|campaign_id/i);
});

test('Voice operations migration preserves all worker queues and adds Voice discovery', () => {
  assert.equal(existsSync(migrationPath), true, migrationPath);
  const sql = readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION opc_worker_tenant_ids\(/i);
  assert.match(sql, /SECURITY DEFINER/i);
  assert.match(sql, /SET search_path = pg_catalog, public/i);
  for (const queue of [
    'tinode',
    'attachment',
    'quality',
    'translation',
    'media_call_timeout',
    'voice_command',
    'voice_configuration',
    'voice_provider_event'
  ]) assert.match(sql, new RegExp(`p_queue = '${queue}'`, 'i'), queue);

  assert.match(sql, /FROM public\.ivekit_voice_call_commands/i);
  assert.match(sql, /FROM public\.ivekit_voice_configuration_commands/i);
  assert.match(sql, /FROM public\.ivekit_voice_provider_events/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_worker_tenant_ids\(TEXT, TIMESTAMPTZ, INTEGER\) FROM PUBLIC/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION opc_worker_tenant_ids\(TEXT, TIMESTAMPTZ, INTEGER\) TO opc_runtime/i);
});

test('Voice profile context lookup exposes only tenant binding and secret refs', () => {
  assert.equal(existsSync(migrationPath), true, migrationPath);
  const sql = readFileSync(migrationPath, 'utf8');
  const functionMatch = sql.match(
    /CREATE OR REPLACE FUNCTION opc_ivekit_voice_profile_context\(p_profile_id TEXT\)([\s\S]*?)\$\$;/i
  );
  assert.ok(functionMatch, 'profile context function');
  const definition = functionMatch[1];

  assert.match(definition, /RETURNS TABLE \(tenant_id TEXT, profile_id TEXT, adapter TEXT, secret_refs JSONB\)/i);
  assert.match(definition, /STABLE/i);
  assert.match(definition, /SECURITY DEFINER/i);
  assert.match(definition, /SET search_path = pg_catalog, public/i);
  assert.match(definition, /FROM public\.ivekit_voice_deployment_profiles/i);
  assert.match(definition, /p\.id = p_profile_id/i);
  assert.match(definition, /p\.status <> 'archived'/i);
  assert.doesNotMatch(definition, /base_url|desired_version|\bp\.config\b/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_ivekit_voice_profile_context\(TEXT\) FROM PUBLIC/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION opc_ivekit_voice_profile_context\(TEXT\) TO opc_runtime/i);
});
