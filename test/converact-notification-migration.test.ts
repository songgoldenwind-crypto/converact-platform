import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const migrationPath = 'src/migrations/065_ivekit_notifications.sql';
const tables = [
  'ivekit_notification_deliveries',
  'ivekit_notification_endpoints',
  'ivekit_notification_endpoint_runtime',
  'ivekit_notification_inbox_items',
  'ivekit_notification_preferences',
  'ivekit_notification_receipts',
  'ivekit_notification_template_versions',
  'ivekit_notification_templates',
  'ivekit_notifications'
].sort();

function tableDefinition(sql: string, table: string): string {
  const match = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`,
    'i'
  ));
  assert.ok(match, `missing table definition: ${table}`);
  return match[1];
}

test('notification migration creates only tenant-scoped PostgreSQL authority tables', () => {
  assert.equal(existsSync(migrationPath), true, migrationPath);
  const sql = readFileSync(migrationPath, 'utf8');
  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(created, tables);
  assert.doesNotMatch(sql, /\bsqlite\b|lead_id|campaign_id|customer_id|workspace_id/i);
  for (const table of tables) {
    assert.match(
      tableDefinition(sql, table),
      /tenant_id TEXT NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/i,
      `${table} tenant foreign key`
    );
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
    assert.match(sql, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`, 'i'));
  }
});

test('notification and delivery rows protect recipients and durable side effects', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  const notifications = tableDefinition(sql, 'ivekit_notifications');
  const deliveries = tableDefinition(sql, 'ivekit_notification_deliveries');

  assert.match(notifications, /business_ref_type TEXT NOT NULL/);
  assert.match(notifications, /business_ref_id TEXT NOT NULL/);
  assert.match(notifications, /idempotency_key TEXT NOT NULL/);
  assert.match(notifications, /payload_hash TEXT NOT NULL CHECK \(char_length\(payload_hash\) = 64\)/);
  assert.match(notifications, /content_ciphertext TEXT NOT NULL/);
  assert.match(notifications, /content_projection JSONB NOT NULL/);
  assert.match(deliveries, /recipient_ciphertext TEXT NOT NULL/);
  assert.match(deliveries, /recipient_hmac TEXT NOT NULL CHECK \(char_length\(recipient_hmac\) = 64\)/);
  assert.match(deliveries, /recipient_redacted TEXT NOT NULL/);
  assert.match(deliveries, /provider_idempotency_key TEXT NOT NULL/);
  assert.match(deliveries, /attempt_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(deliveries, /max_attempts INTEGER NOT NULL/);
  assert.match(deliveries, /lease_token_hash TEXT NOT NULL/);
  assert.match(deliveries, /lease_until TIMESTAMPTZ/);
  assert.match(deliveries, /next_attempt_at TIMESTAMPTZ/);
  assert.match(deliveries, /'uncertain'/);
  assert.doesNotMatch(sql, /recipient_address TEXT|smtp_password|api_token|authorization_header/i);
});

test('notification migration has immutable template versions and append-only receipts', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  assert.match(
    sql,
    /CREATE TRIGGER ivekit_notification_template_versions_immutable[\s\S]*BEFORE UPDATE OR DELETE ON ivekit_notification_template_versions/i
  );
  assert.match(
    sql,
    /CREATE TRIGGER ivekit_notification_receipts_append_only[\s\S]*BEFORE UPDATE OR DELETE ON ivekit_notification_receipts/i
  );
  assert.match(sql, /ERRCODE = '55000'/);
});

test('notification worker discovery is tenant-aware and security definer is locked down', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION opc_notification_worker_tenant_ids/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION opc_notification_receipt_tenant_ids/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION opc_notification_queue_metrics/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = pg_catalog, public/);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_notification_worker_tenant_ids/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION opc_notification_worker_tenant_ids/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION opc_notification_receipt_tenant_ids/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION opc_notification_queue_metrics/);
});

test('notification endpoint runtime stores atomic quota buckets and circuit state', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  const runtime = tableDefinition(sql, 'ivekit_notification_endpoint_runtime');
  assert.match(runtime, /circuit_state TEXT NOT NULL DEFAULT 'closed'/i);
  assert.match(runtime, /circuit_open_until TIMESTAMPTZ/i);
  assert.match(runtime, /consecutive_failures INTEGER NOT NULL DEFAULT 0/i);
  assert.match(runtime, /minute_bucket TIMESTAMPTZ/i);
  assert.match(runtime, /minute_used INTEGER NOT NULL DEFAULT 0/i);
  assert.match(runtime, /day_bucket DATE/i);
  assert.match(runtime, /day_used INTEGER NOT NULL DEFAULT 0/i);
  assert.match(runtime, /PRIMARY KEY \(tenant_id, endpoint_id\)/i);
});
