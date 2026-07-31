import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('integration webhook migration is tenant scoped leased and PostgreSQL only', () => {
  const sql = readFileSync('src/migrations/073_ivekit_integration_webhooks.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_event_webhook_subscriptions/);
  assert.match(sql, /endpoint_id TEXT NOT NULL/);
  assert.match(sql, /event_patterns TEXT\[\] NOT NULL/);
  assert.match(sql, /last_event_id BIGINT NOT NULL DEFAULT 0/);
  assert.match(sql, /lease_token_hash TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /lease_until TIMESTAMPTZ/);
  assert.match(sql, /revision INTEGER NOT NULL DEFAULT 1/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /opc_event_webhook_worker_tenant_ids/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_event_webhook_worker_tenant_ids[\s\S]*FROM PUBLIC/);
  assert.doesNotMatch(sql, /sqlite/i);
});
