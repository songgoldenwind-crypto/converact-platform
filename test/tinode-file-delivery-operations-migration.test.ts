import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Tinode file delivery operations migration defines bounded states, replay audit, and worker recovery', () => {
  const sql = readFileSync('src/migrations/062_tinode_file_delivery_operations.sql', 'utf8');
  for (const status of ['blocked_by_file_security', 'blocked']) {
    assert.match(sql, new RegExp(`'${status}'`));
  }
  assert.match(sql, /tinode_inbound_dead_letter_replays/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /opc_tinode_delivery_worker_tenant_ids/);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_tinode_delivery_worker_tenant_ids/);
  assert.doesNotMatch(sql, /auth_token|basic_password|api_key|attachment_bytes|provider_credential/i);
});

test('standalone migration manifest orders Tinode operations before runtime security', () => {
  const policy = JSON.parse(readFileSync('services/converact-service/source-policy.json', 'utf8')) as {
    migrations: string[];
  };
  const operations = policy.migrations.indexOf('062_tinode_file_delivery_operations.sql');
  const security = policy.migrations.indexOf(
    'services/converact-service/migrations/090_ivekit_runtime_security.sql'
  );
  assert.equal(operations >= 0, true);
  assert.equal(operations < security, true);
});
