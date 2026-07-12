import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

test('RustDesk control ownership migration defines leases confirmations and immutable events', () => {
  const migrationUrl = new URL('../src/migrations/040_rustdesk_control_ownership.sql', import.meta.url);
  assert.equal(existsSync(migrationUrl), true, 'RustDesk control ownership migration must exist');

  const migration = readFileSync(migrationUrl, 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rustdesk_control_locks \(/);
  assert.match(migration, /PRIMARY KEY \(tenant_id, external_id\)/);
  assert.match(migration, /owner_identity TEXT NOT NULL/);
  assert.match(migration, /lease_expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(migration, /version INTEGER NOT NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rustdesk_secondary_confirmations \(/);
  assert.match(migration, /operation TEXT NOT NULL/);
  assert.match(migration, /consumed_at TIMESTAMPTZ/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rustdesk_control_events \(/);
  assert.match(migration, /event_type TEXT NOT NULL/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /opc_rls_bypass\(\) OR tenant_id = opc_current_tenant\(\)/g);
  assert.doesNotMatch(migration, /password|credential_ref|credential-ref/i);
});

test('full schema includes RustDesk control ownership tables without early RLS helpers', () => {
  const schema = readFileSync(new URL('../src/migrations/005_full_schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rustdesk_control_locks \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rustdesk_secondary_confirmations \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rustdesk_control_events \(/);
  assert.doesNotMatch(
    schema,
    /ALTER TABLE rustdesk_control_locks ENABLE ROW LEVEL SECURITY;[\s\S]*opc_current_tenant\(\)/
  );
});
