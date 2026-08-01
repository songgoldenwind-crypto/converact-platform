import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const path = 'src/migrations/066_ivekit_audit.sql';

test('Converact Fabric audit migration is append-only tenant-scoped and hash chained', () => {
  const sql = readFileSync(path, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_audit_events/i);
  assert.match(sql, /tenant_id TEXT NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /previous_hash TEXT NOT NULL/i);
  assert.match(sql, /event_hash TEXT NOT NULL.*char_length\(event_hash\) = 64/i);
  assert.match(sql, /source_ip_hmac TEXT NOT NULL/i);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON ivekit_audit_events/i);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/i);
  assert.match(sql, /GRANT SELECT, INSERT ON ivekit_audit_events TO opc_runtime/i);
  assert.doesNotMatch(sql, /email_address|phone_number|access_token|secret_value|request_body/i);
});
