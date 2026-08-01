import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const canonicalSchemas = [
  ['src/schema.sql', readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8')],
  [
    'src/migrations/005_full_schema.sql',
    readFileSync(new URL('../src/migrations/005_full_schema.sql', import.meta.url), 'utf8')
  ]
] as const;

test('canonical schemas include RustDesk device and gateway tables', () => {
  for (const [label, sql] of canonicalSchemas) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS rustdesk_devices \(/, `${label} must create rustdesk_devices`);
    assert.match(sql, /rustdesk_id TEXT NOT NULL/, `${label} must store the RustDesk peer id`);
    assert.match(sql, /runtime_status TEXT NOT NULL DEFAULT 'unknown'/, `${label} must store device runtime status`);
    assert.match(sql, /last_seen_at TIMESTAMPTZ/, `${label} must store device heartbeat time`);
    assert.match(sql, /last_seen_actor TEXT NOT NULL DEFAULT ''/, `${label} must store heartbeat actor`);
    assert.match(sql, /idx_rustdesk_devices_runtime_status/, `${label} must index online device lookup`);

    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS rustdesk_gateway_sessions \(/,
      `${label} must create rustdesk gateway sessions`
    );
    assert.match(sql, /external_id TEXT PRIMARY KEY/, `${label} must key RustDesk sessions by external id`);
    assert.match(sql, /permissions TEXT NOT NULL DEFAULT '\[\]'/, `${label} must store granted permissions`);
    assert.match(sql, /actor_identity TEXT NOT NULL DEFAULT ''/, `${label} must store the session actor`);
    assert.match(sql, /launch_url TEXT NOT NULL DEFAULT ''/, `${label} must store the launch URL`);

    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS rustdesk_gateway_events \(/,
      `${label} must create rustdesk gateway events`
    );
    assert.match(sql, /event_type TEXT NOT NULL/, `${label} must store RustDesk audit event type`);
    assert.match(sql, /idempotency_key TEXT NOT NULL DEFAULT ''/, `${label} must store event idempotency keys`);
    assert.match(sql, /idx_rustdesk_gateway_events_idempotency/, `${label} must dedupe event writes`);

    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS rustdesk_device_commands \(/,
      `${label} must create RustDesk device commands`
    );
    assert.match(
      sql,
      /command_type TEXT NOT NULL DEFAULT 'disconnect_session'/,
      `${label} must fix the v1 command type`
    );
    assert.match(
      sql,
      /CHECK \(status IN \('pending', 'claimed', 'succeeded', 'failed'\)\)/,
      `${label} must constrain command lifecycle status`
    );
    assert.match(
      sql,
      /UNIQUE \(tenant_id, external_id, command_type\)/,
      `${label} must dedupe disconnect commands per gateway session`
    );
    assert.match(
      sql,
      /idx_rustdesk_device_commands_claim/,
      `${label} must index edge command claims`
    );
  }
});

test('RustDesk migrations enable tenant RLS after creating gateway tables', () => {
  const migrationUrl = new URL('../src/migrations/022_rustdesk_tenant_rls.sql', import.meta.url);

  assert.equal(existsSync(migrationUrl), true, 'RustDesk tables are created after the global RLS migration');

  const sql = readFileSync(migrationUrl, 'utf8');
  const tables = ['rustdesk_devices', 'rustdesk_gateway_sessions', 'rustdesk_gateway_events'];

  for (const table of tables) {
    assert.match(sql, new RegExp(`'${table}'`), `RLS migration must include ${table}`);
  }

  assert.match(sql, /ENABLE ROW LEVEL SECURITY/, 'RLS migration must enable row-level security');
  assert.match(sql, /FORCE ROW LEVEL SECURITY/, 'RLS migration must force row-level security for table owners');
  assert.match(sql, /DROP POLICY IF EXISTS tenant_isolation/, 'RLS migration must replace stale tenant policies');
  assert.match(sql, /opc_rls_bypass\(\) OR tenant_id = opc_current_tenant\(\)/, 'RLS policy must use Converact tenant context');
});

test('RustDesk device command migration creates and protects the command queue', () => {
  const migrationUrl = new URL('../src/migrations/024_rustdesk_device_commands.sql', import.meta.url);

  assert.equal(existsSync(migrationUrl), true, 'RustDesk command migration must exist');

  const sql = readFileSync(migrationUrl, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS rustdesk_device_commands \(/);
  assert.match(sql, /command_type = 'disconnect_session'/);
  assert.match(sql, /idx_rustdesk_device_commands_claim/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY tenant_isolation/);
  assert.match(sql, /opc_rls_bypass\(\) OR tenant_id = opc_current_tenant\(\)/);
});
