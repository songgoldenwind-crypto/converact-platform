import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(
  new URL('../src/migrations/074_tinode_message_mutation_outbox.sql', import.meta.url),
  'utf8'
);

test('Tinode mutation migration defines a durable ordered tenant-isolated outbox', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tinode_message_mutation_outbox/);
  assert.match(sql, /mutation_id TEXT NOT NULL REFERENCES collaboration_message_mutations/);
  assert.match(sql, /UNIQUE \(tenant_id, mutation_id\)/);
  assert.match(sql, /UNIQUE \(tenant_id, message_id, mutation_version\)/);
  assert.match(sql, /pending.*processing.*retry_wait.*delivered.*dead_letter/s);
  assert.match(sql, /claim_token TEXT NOT NULL/);
  assert.match(sql, /claimed_until TIMESTAMPTZ/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /opc_current_tenant\(\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tinode_message_mutation_replays/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
});
