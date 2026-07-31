import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('iveKit retention migration defines policies, legal holds, leases and controlled audit deletion', () => {
  const sql = readFileSync('src/migrations/068_ivekit_retention.sql', 'utf8');
  const runtimeSecurity = readFileSync(
    'services/converact-service/migrations/090_ivekit_runtime_security.sql',
    'utf8'
  );
  for (const table of [
    'ivekit_retention_policies', 'ivekit_legal_holds', 'ivekit_retention_runs',
    'ivekit_audit_retention_checkpoints'
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'));
  assert.match(sql, /lease_expires_at TIMESTAMPTZ/i);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(sql, /opc_ivekit_delete_expired_audit_events/i);
  assert.match(sql,
    /CREATE OR REPLACE FUNCTION opc_ivekit_event_retention_tenant_ids[\s\S]*hold\.category = 'tenant_events'/i);
  assert.match(sql, /p_started_at TIMESTAMPTZ/i);
  assert.match(runtimeSecurity,
    /opc_ivekit_delete_expired_audit_events\(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER\)/i);
  assert.match(runtimeSecurity,
    /opc_ivekit_event_retention_tenant_ids\(TIMESTAMPTZ, INTEGER\)/i);
  assert.match(sql, /app\.audit_retention_cleanup/i);
  assert.match(sql, /jsonb_agg\(event_hash ORDER BY occurred_at, id\)/i);
  assert.match(sql, /audit retention checkpoints are immutable/i);
  assert.match(sql, /WHERE status = 'active'/i);
  assert.match(sql, /hold\.status = 'active'/i);
  assert.match(sql, /SECURITY DEFINER/i);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(sql, /\)\s*\n\s*\),\s*checkpoint\s+AS/i);
});
