import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('iveKit rate limit migration creates shared HMAC buckets with tenant RLS', () => {
  const sql = readFileSync('src/migrations/067_ivekit_rate_limits.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_rate_limit_buckets/i);
  assert.match(sql, /scope_key_hmac TEXT NOT NULL/i);
  assert.match(sql, /PRIMARY KEY \(tenant_id, scope_type, scope_key_hmac, route_group, window_seconds\)/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/i);
  assert.equal(/source_ip\s+TEXT/i.test(sql), false);
  assert.equal(/recipient\s+TEXT/i.test(sql), false);
});
