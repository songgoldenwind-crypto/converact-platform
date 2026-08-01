import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('notification health migration provides multi-instance leases and tenant discovery', () => {
  const sql = readFileSync('src/migrations/071_ivekit_notification_health.sql', 'utf8');
  assert.match(sql, /health_lease_token_hash/);
  assert.match(sql, /health_lease_until/);
  assert.match(sql, /opc_notification_health_tenant_ids/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION opc_notification_health_tenant_ids[\s\S]*FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION opc_notification_health_tenant_ids/);
});
