import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'src/migrations/052_ivekit_contact_center.sql';
const idempotencyMigrationPath =
  'src/migrations/053_ivekit_contact_center_configuration_idempotency.sql';
const workerMigrationPath = 'src/migrations/054_ivekit_contact_center_worker.sql';
const tables = [
  'ivekit_cc_skills',
  'ivekit_cc_agents',
  'ivekit_cc_agent_skills',
  'ivekit_cc_agent_presence',
  'ivekit_cc_queues',
  'ivekit_cc_queue_memberships',
  'ivekit_cc_queue_skill_requirements',
  'ivekit_cc_queue_entries',
  'ivekit_cc_assignments',
  'ivekit_cc_callbacks',
  'ivekit_cc_supervisor_sessions',
  'ivekit_cc_routing_cursors'
].sort();

test('Contact Center migration is standalone, tenant scoped, and PostgreSQL only', () => {
  assert.equal(existsSync(migrationPath), true, migrationPath);
  const sql = readFileSync(migrationPath, 'utf8');
  assert.deepEqual(createdTables(sql), tables);
  for (const table of tables) assertTenantRls(sql, table);
  for (const forbidden of ['lead_id', 'customer_id', 'campaign_id', 'workspace_id', 'stripe', 'wfm', 'sqlite']) {
    assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}\\b`, 'i'), forbidden);
  }
  assert.match(sql, /JSONB/);
});

test('Contact Center migration protects queue concurrency and callback addresses', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  const entries = tableDefinition(sql, 'ivekit_cc_queue_entries');
  const assignments = tableDefinition(sql, 'ivekit_cc_assignments');
  const callbacks = tableDefinition(sql, 'ivekit_cc_callbacks');
  const presence = tableDefinition(sql, 'ivekit_cc_agent_presence');

  assert.match(entries, /call_id TEXT NOT NULL/);
  assert.match(entries, /idempotency_key TEXT NOT NULL/);
  assert.match(entries, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(entries, /revision INTEGER NOT NULL DEFAULT 1 CHECK \(revision > 0\)/);
  assert.match(assignments, /offer_expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(assignments, /idempotency_key TEXT NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_cc_assignments_active_agent[\s\S]*WHERE state IN \('offered', 'accepted', 'connected'\)/i);
  assert.match(presence, /active_voice_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(presence, /voice_capacity INTEGER NOT NULL/);
  for (const field of ['address_ciphertext', 'address_hmac', 'address_redacted']) {
    assert.match(callbacks, new RegExp(`\\b${field}\\b`), field);
  }
  assert.doesNotMatch(callbacks, /phone_number|raw_address/i);
});

test('Contact Center history is immutable and standalone manifests include migration 052', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  assert.match(sql, /SECURITY INVOKER/);
  assert.match(sql, /CREATE TRIGGER ivekit_cc_assignments_immutable_delete[\s\S]*BEFORE DELETE ON ivekit_cc_assignments/i);
  assert.match(sql, /CREATE TRIGGER ivekit_cc_supervisor_sessions_immutable_delete[\s\S]*BEFORE DELETE ON ivekit_cc_supervisor_sessions/i);
  assert.doesNotMatch(sql, /FOREIGN KEY \(tenant_id, [^)]+\)[\s\S]{0,160}?ON DELETE SET NULL/i);

  const sourcePolicy = readFileSync('services/ivekit-service/source-policy.json', 'utf8');
  const delivery = readFileSync('scripts/ivekit-delivery-bundle.ts', 'utf8');
  for (const source of [sourcePolicy, delivery]) assert.match(source, /052_ivekit_contact_center\.sql/);
  assert.ok(sourcePolicy.indexOf('051_ivekit_ivr_resources.sql') < sourcePolicy.indexOf('052_ivekit_contact_center.sql'));
  assert.ok(sourcePolicy.indexOf('052_ivekit_contact_center.sql') < sourcePolicy.indexOf('090_ivekit_runtime_security.sql'));
});

test('Contact Center configuration idempotency upgrades after migration 052', () => {
  const sql = readFileSync(idempotencyMigrationPath, 'utf8');
  assert.deepEqual(createdTables(sql), ['ivekit_cc_configuration_idempotency']);
  assertTenantRls(sql, 'ivekit_cc_configuration_idempotency');
  const table = tableDefinition(sql, 'ivekit_cc_configuration_idempotency');
  assert.match(table, /PRIMARY KEY \(tenant_id, idempotency_key\)/);
  assert.match(table, /payload_hash TEXT NOT NULL CHECK \(char_length\(payload_hash\) = 64\)/);
  assert.match(sql, /CREATE TRIGGER ivekit_cc_configuration_idempotency_immutable_delete[\s\S]*BEFORE DELETE ON ivekit_cc_configuration_idempotency/i);

  const sourcePolicy = readFileSync('services/ivekit-service/source-policy.json', 'utf8');
  const delivery = readFileSync('scripts/ivekit-delivery-bundle.ts', 'utf8');
  for (const source of [sourcePolicy, delivery]) {
    assert.match(source, /053_ivekit_contact_center_configuration_idempotency\.sql/);
  }
  assert.ok(sourcePolicy.indexOf('052_ivekit_contact_center.sql') <
    sourcePolicy.indexOf('053_ivekit_contact_center_configuration_idempotency.sql'));
  assert.ok(sourcePolicy.indexOf('053_ivekit_contact_center_configuration_idempotency.sql') <
    sourcePolicy.indexOf('090_ivekit_runtime_security.sql'));
});

test('Contact Center worker migration discovers only tenants with due maintenance', () => {
  assert.equal(existsSync(workerMigrationPath), true, workerMigrationPath);
  const sql = readFileSync(workerMigrationPath, 'utf8');
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_ivekit_cc_queue_entries_timeout/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION opc_ivekit_cc_worker_tenant_ids\(/i);
  assert.match(sql, /assignment\.state = 'offered'/i);
  assert.match(sql, /entry\.state = 'waiting'/i);
  assert.match(sql, /entry\.timeout_at <= p_now/i);
  assert.match(sql, /queue\.status = 'active'/i);
  assert.match(sql, /SECURITY DEFINER/i);
  assert.match(sql, /SET search_path = pg_catalog, public/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_ivekit_cc_worker_tenant_ids\(TIMESTAMPTZ, INTEGER\)\s+FROM PUBLIC/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION opc_ivekit_cc_worker_tenant_ids\(TIMESTAMPTZ, INTEGER\)\s+TO opc_runtime/i);

  const sourcePolicy = readFileSync('services/ivekit-service/source-policy.json', 'utf8');
  const delivery = readFileSync('scripts/ivekit-delivery-bundle.ts', 'utf8');
  for (const source of [sourcePolicy, delivery]) {
    assert.match(source, /054_ivekit_contact_center_worker\.sql/);
  }
  assert.ok(sourcePolicy.indexOf('053_ivekit_contact_center_configuration_idempotency.sql') <
    sourcePolicy.indexOf('054_ivekit_contact_center_worker.sql'));
  assert.ok(sourcePolicy.indexOf('054_ivekit_contact_center_worker.sql') <
    sourcePolicy.indexOf('090_ivekit_runtime_security.sql'));
});

function createdTables(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)]
    .map((match) => match[1])
    .sort();
}

function tableDefinition(sql: string, table: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  assert.ok(match, `missing table definition: ${table}`);
  return match[1];
}

function assertTenantRls(sql: string, table: string): void {
  const definition = tableDefinition(sql, table);
  assert.match(definition, /tenant_id TEXT NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/i, `${table} tenant foreign key`);
  assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
  assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
  assert.match(sql, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`, 'i'));
}
