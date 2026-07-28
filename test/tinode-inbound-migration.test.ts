import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'src/migrations/041_tinode_inbound_sync.sql';
const closedSessionMigrationPath = 'src/migrations/105_tinode_closed_session_inbound.sql';

test('Tinode inbound migration defines durable mappings, cursors, inbox, and dead letters', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  for (const table of [
    'collaboration_provider_users',
    'tinode_inbound_cursors',
    'tinode_inbound_events',
    'tinode_inbound_dead_letters'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
  }

  assert.match(sql, /UNIQUE \(tenant_id, session_id, provider, identity\)/);
  assert.match(sql, /UNIQUE \(tenant_id, session_id, provider, provider_user_id\)/);
  assert.match(sql, /UNIQUE \(tenant_id, binding_id, dedupe_key\)/);
  assert.match(sql, /provider_sequence BIGINT NOT NULL DEFAULT 0/);
  assert.match(sql, /uq_collaboration_messages_provider_sequence/);
  assert.match(sql, /opc_tinode_inbound_tenant_ids/);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_tinode_inbound_tenant_ids/);
  assert.doesNotMatch(sql, /auth_token|basic_password|api_key|attachment_bytes|provider_credential/i);
});

test('standalone migration manifest includes Tinode inbound before runtime security', () => {
  const policy = JSON.parse(readFileSync('services/ivekit-service/source-policy.json', 'utf8')) as {
    migrations: string[];
  };
  const inbound = policy.migrations.indexOf('041_tinode_inbound_sync.sql');
  const security = policy.migrations.indexOf('services/ivekit-service/migrations/090_ivekit_runtime_security.sql');
  assert.equal(inbound >= 0, true);
  assert.equal(inbound < security, true);
});

test('Tinode closed-session migration pauses cursors and excludes closed sessions from discovery', () => {
  const sql = readFileSync(closedSessionMigrationPath, 'utf8');
  const policy = JSON.parse(readFileSync('services/ivekit-service/source-policy.json', 'utf8')) as {
    migrations: string[];
  };
  const store = readFileSync('src/agent-runtime/collaboration/tinode-inbound-store.ts', 'utf8');
  const lifecycle = readFileSync(
    'src/agent-runtime/collaboration/collaboration-session-lifecycle.ts',
    'utf8'
  );

  assert.match(sql, /UPDATE (?:public\.)?tinode_inbound_cursors/);
  assert.match(sql, /SET status = 'paused'/);
  assert.match(sql, /session\.status = 'closed'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION opc_tinode_inbound_tenant_ids/);
  assert.match(sql, /session\.status = 'open'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_tinode_inbound_tenant_ids/);
  assert.equal(policy.migrations.includes('105_tinode_closed_session_inbound.sql'), true);
  assert.equal(policy.migrations.at(-1), '106_tinode_open_session_mutation_queue.sql');

  assert.match(store, /async pauseBinding/);
  assert.equal((store.match(/session\.status = 'open'/g) || []).length >= 2, true);
  assert.match(lifecycle, /pauseBinding\(\{/);
});
