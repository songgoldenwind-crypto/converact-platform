import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { shouldSkipRuntimeSchemaDdl } from '../src/db-pg-sync.js';

const migration = readFileSync(
  new URL('../src/migrations/031_legacy_runtime_schema_rls.sql', import.meta.url),
  'utf8'
);
const leastPrivilegeMigrationUrl = new URL(
  '../src/migrations/032_runtime_least_privilege.sql',
  import.meta.url
);

test('legacy tenant tables are owned by PostgreSQL migrations and force RLS', () => {
  for (const table of [
    'billing_subscriptions',
    'billing_usage',
    'knowledge_bases',
    'knowledge_documents',
    'qm_evaluations',
    'wfm_forecasts',
    'wfm_schedules',
    'white_label_configs'
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE POLICY tenant_isolation/);
});

test('migration-managed runtime skips legacy schema DDL but not transactions or DML', () => {
  const managed = { OPC_SCHEMA_MANAGED_BY_MIGRATIONS: '1' };
  assert.equal(shouldSkipRuntimeSchemaDdl('CREATE TABLE IF NOT EXISTS demo (id text)', managed), true);
  assert.equal(shouldSkipRuntimeSchemaDdl('CREATE INDEX IF NOT EXISTS demo_idx ON demo(id)', managed), true);
  assert.equal(shouldSkipRuntimeSchemaDdl('ALTER TABLE demo ADD COLUMN value text', managed), true);
  assert.equal(shouldSkipRuntimeSchemaDdl('BEGIN', managed), false);
  assert.equal(shouldSkipRuntimeSchemaDdl('INSERT INTO demo (id) VALUES (1)', managed), false);
  assert.equal(shouldSkipRuntimeSchemaDdl('CREATE TABLE demo (id text)', {}), false);
});

test('runtime least-privilege migration removes generic GUC bypass and grants fixed operations only', () => {
  assert.equal(existsSync(leastPrivilegeMigrationUrl), true, 'migration 032 must exist');
  const sql = readFileSync(leastPrivilegeMigrationUrl, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION opc_rls_bypass\(\)/);
  assert.match(sql, /current_user = 'opc_admin'/);
  assert.match(sql, /SECURITY DEFINER/g);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_auth_user_by_email/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION opc_auth_user_by_email/);
  assert.match(sql, /opc_register_tenant_owner/);
  assert.match(sql, /opc_rustdesk_session_by_external_id/);
  assert.match(sql, /opc_worker_tenant_ids/);
  assert.doesNotMatch(sql, /current_setting\('app\.bypass_rls'/);
});
