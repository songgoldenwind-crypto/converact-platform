import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const voiceMigrationPath = 'src/migrations/046_ivekit_voice_foundation.sql';

const voiceTables = [
  'ivekit_voice_deployment_profiles',
  'ivekit_voice_capability_snapshots',
  'ivekit_voice_sip_trunks',
  'ivekit_voice_dids',
  'ivekit_voice_extensions',
  'ivekit_voice_routes',
  'ivekit_voice_route_versions',
  'ivekit_voice_calls',
  'ivekit_voice_call_participants',
  'ivekit_voice_call_commands',
  'ivekit_voice_provider_events',
  'ivekit_voice_livekit_bridges',
  'ivekit_voice_recordings',
  'ivekit_voice_consents',
  'ivekit_voice_policies',
  'ivekit_voice_webrtc_sessions'
].sort();

function createdTables(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)]
    .map((match) => match[1])
    .sort();
}

function tableDefinition(sql: string, table: string): string {
  const match = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`,
    'i'
  ));
  assert.ok(match, `missing table definition: ${table}`);
  return match[1];
}

function assertTenantRls(sql: string, table: string): void {
  const definition = tableDefinition(sql, table);
  assert.match(
    definition,
    /tenant_id TEXT NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/i,
    `${table} tenant foreign key`
  );
  assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
  assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
  assert.match(sql, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`, 'i'));
}

test('Voice foundation migration owns only the standalone Voice authority tables', () => {
  assert.equal(existsSync(voiceMigrationPath), true, voiceMigrationPath);
  const sql = readFileSync(voiceMigrationPath, 'utf8');

  assert.deepEqual(createdTables(sql), voiceTables);
  for (const table of voiceTables) assertTenantRls(sql, table);
  for (const forbidden of [
    'lead_id',
    'customer_id',
    'campaign_id',
    'workspace_id',
    'sqlite',
    'voice_call_sessions',
    'ivr_flows'
  ]) assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}\\b`, 'i'), forbidden);
});

test('Voice foundation migration protects addresses and durable side effects', () => {
  assert.equal(existsSync(voiceMigrationPath), true, voiceMigrationPath);
  const sql = readFileSync(voiceMigrationPath, 'utf8');
  const calls = tableDefinition(sql, 'ivekit_voice_calls');
  const commands = tableDefinition(sql, 'ivekit_voice_call_commands');
  const events = tableDefinition(sql, 'ivekit_voice_provider_events');
  const recordings = tableDefinition(sql, 'ivekit_voice_recordings');

  for (const field of [
    'from_address_ciphertext',
    'from_address_hmac',
    'from_address_redacted',
    'to_address_ciphertext',
    'to_address_hmac',
    'to_address_redacted'
  ]) assert.match(calls, new RegExp(`\\b${field}\\b`), field);
  assert.match(calls, /from_address_hmac TEXT NOT NULL CHECK \(char_length\(from_address_hmac\) = 64\)/);
  assert.match(calls, /to_address_hmac TEXT NOT NULL CHECK \(char_length\(to_address_hmac\) = 64\)/);
  assert.match(calls, /business_ref_type TEXT NOT NULL/);
  assert.match(calls, /business_ref_id TEXT NOT NULL/);
  assert.match(calls, /revision INTEGER NOT NULL DEFAULT 1 CHECK \(revision > 0\)/);
  assert.match(commands, /idempotency_key TEXT NOT NULL/);
  assert.match(commands, /payload_hash TEXT NOT NULL CHECK \(char_length\(payload_hash\) = 64\)/);
  assert.match(commands, /attempt_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(commands, /max_attempts INTEGER NOT NULL DEFAULT 3/);
  assert.match(commands, /lease_until TIMESTAMPTZ/);
  assert.match(commands, /next_attempt_at TIMESTAMPTZ/);
  assert.match(commands, /'uncertain'/);
  assert.match(events, /canonical_hash TEXT NOT NULL CHECK \(char_length\(canonical_hash\) = 64\)/);
  assert.match(recordings, /object_ref TEXT NOT NULL DEFAULT ''/);
  assert.match(recordings, /evidence_ref TEXT NOT NULL DEFAULT ''/);
  assert.doesNotMatch(sql, /password|authorization|raw_sdp|ice_password/i);
});

test('Voice route versions are immutable and schema uses PostgreSQL-native JSONB', () => {
  assert.equal(existsSync(voiceMigrationPath), true, voiceMigrationPath);
  const sql = readFileSync(voiceMigrationPath, 'utf8');

  assert.match(sql, /JSONB/);
  assert.doesNotMatch(sql, /metadata TEXT|config TEXT|payload TEXT|result TEXT/i);
  assert.match(sql, /SECURITY INVOKER/);
  assert.match(
    sql,
    /CREATE TRIGGER ivekit_voice_route_versions_immutable[\s\S]*BEFORE UPDATE OR DELETE ON ivekit_voice_route_versions/i
  );
  assert.match(sql, /ERRCODE = '55000'/);
});

test('Voice composite tenant foreign keys never null the tenant column', () => {
  assert.equal(existsSync(voiceMigrationPath), true, voiceMigrationPath);
  const sql = readFileSync(voiceMigrationPath, 'utf8');

  assert.doesNotMatch(
    sql,
    /FOREIGN KEY \(tenant_id, [^)]+\)[\s\S]{0,160}?ON DELETE SET NULL/i
  );
});
