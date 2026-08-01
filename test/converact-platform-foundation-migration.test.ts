import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { REQUIRED_MIGRATIONS } from '../src/agent-runtime/converact/operations/readiness.js';
import { readPostgresMigrationPlan } from '../src/postgres-migrations.js';

const EXPECTED = [
  '108_converact_platform_identity_consent.sql',
  '109_converact_platform_event_receipts.sql',
  '110_converact_platform_usage_ledger.sql',
  '111_converact_platform_key_lifecycle.sql'
] as const;

test('platform foundation migrations are additive and ordered immediately after 107', () => {
  const plan = readPostgresMigrationPlan(new URL('../src/migrations', import.meta.url).pathname);
  assert.deepEqual(plan.slice(-5).map((entry) => entry.file), [
    '107_ivekit_sip_effect_oracle.sql', ...EXPECTED
  ]);
  for (const file of EXPECTED) assert.match(readFileSync(new URL(`../src/migrations/${file}`, import.meta.url), 'utf8'), /tenant_id/i);
  assert.deepEqual(REQUIRED_MIGRATIONS.slice(-5), [
    '107_ivekit_sip_effect_oracle',
    '108_converact_platform_identity_consent',
    '109_converact_platform_event_receipts',
    '110_converact_platform_usage_ledger',
    '111_converact_platform_key_lifecycle'
  ]);
});

test('identity consent and policy tables are tenant scoped without persisted monotonic instants', () => {
  const sql = migration(108);
  for (const table of [
    'converact_platform_identity_sessions',
    'converact_platform_revocation_snapshots',
    'converact_platform_policy_revisions',
    'converact_platform_consent_evidence',
    'converact_platform_consent_leases'
  ]) assertTenantRls(sql, table);
  assert.match(sql, /UNIQUE\s*\(tenant_id, subject_id, scope, purpose, revision\)/i);
  assert.match(sql, /monotonic_duration_ms/i);
  assert.doesNotMatch(sql, /monotonic_(?:started|instant|now)/i);
});

test('event inbox outbox and effect receipt schema is bounded fenced and append only', () => {
  const sql = migration(109);
  for (const table of [
    'converact_platform_outbox', 'converact_platform_inbox', 'converact_platform_effect_receipts'
  ]) assertTenantRls(sql, table);
  assert.match(sql, /UNIQUE\s*\(tenant_id, consumer_id, event_id\)/i);
  assert.match(sql, /UNIQUE\s*\(tenant_id, effect_id, stage, generation\)/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON converact_platform_effect_receipts/i);
  assert.match(sql, /CREATE INDEX[\s\S]*converact_platform_outbox\s*\(tenant_id, status, next_attempt_at, id\)/i);
  assert.match(sql, /CHECK\s*\(schema_version IN \(1, 2\)\)/i);
});

test('usage and key metadata are immutable writer-fenced references without raw secret columns', () => {
  const usage = migration(110);
  for (const table of [
    'converact_platform_billing_writers', 'converact_platform_usage_entries'
  ]) assertTenantRls(usage, table);
  assert.match(usage, /WHERE entry_kind = 'usage'/i);
  assert.match(usage, /BEFORE UPDATE OR DELETE ON converact_platform_usage_entries/i);
  assert.match(usage, /FOREIGN KEY\s*\(tenant_id, billing_key, writer_id, writer_epoch\)/i);
  assert.match(usage, /CHECK\s*\(quantity > 0\)/i);

  const keys = migration(111);
  for (const table of [
    'converact_platform_key_versions', 'converact_platform_key_lifecycle_receipts',
    'converact_platform_certificate_bindings'
  ]) assertTenantRls(keys, table);
  assert.match(keys, /material_ref/i);
  assert.match(keys, /BEFORE UPDATE OR DELETE ON converact_platform_key_lifecycle_receipts/i);
  assert.doesNotMatch(keys, /\b(?:raw_material|private_key|client_secret|secret_value)\b/i);
});

test('standalone package and delivery allowlists include the four platform migrations', () => {
  const sourcePolicy = JSON.parse(readFileSync(new URL(
    '../services/converact-service/source-policy.json', import.meta.url
  ), 'utf8')) as { migrations: string[] };
  assert.deepEqual(sourcePolicy.migrations.slice(-4), [...EXPECTED]);
  const delivery = readFileSync(new URL('../scripts/converact-delivery-bundle.ts', import.meta.url), 'utf8');
  for (const file of EXPECTED) assert.match(delivery, new RegExp(file.replace('.', '\\.')));
});

function migration(version: number): string {
  const file = EXPECTED.find((candidate) => candidate.startsWith(`${version}_`));
  assert.ok(file);
  return readFileSync(new URL(`../src/migrations/${file}`, import.meta.url), 'utf8');
}

function assertTenantRls(sql: string, table: string): void {
  assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
  assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
  assert.match(sql, new RegExp(`CREATE POLICY tenant_isolation ON ${table}[\\s\\S]*tenant_id = opc_current_tenant\\(\\)`, 'i'));
}
