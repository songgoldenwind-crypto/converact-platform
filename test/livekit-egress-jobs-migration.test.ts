import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync('src/migrations/087_livekit_egress_jobs.sql', 'utf8');
const reconciliationSql = readFileSync('src/migrations/088_livekit_egress_reconciliation.sql', 'utf8');

test('LiveKit Egress job migration owns provider execution and object lifecycle per tenant', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS livekit_egress_jobs/i);
  assert.match(sql, /recording_id TEXT NOT NULL REFERENCES call_recordings\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /UNIQUE \(recording_id, job_sequence\)/i);
  assert.match(sql, /recording_mode IN \('track', 'track_composite', 'room_composite'\)/i);
  assert.match(sql, /object_status TEXT NOT NULL DEFAULT 'unchecked'/i);
  assert.match(sql, /'deleted', 'delete_failed'/i);
  assert.match(sql, /object_checked_at TIMESTAMPTZ/i);
  assert.match(sql, /deleted_at TIMESTAMPTZ/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/i);
  assert.match(sql, /tenant_id = opc_current_tenant\(\)/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON livekit_egress_jobs TO opc_runtime/i);
});

test('LiveKit Egress reconciliation migration supports leased multi-instance claims', () => {
  assert.match(reconciliationSql, /provider_observed_at TIMESTAMPTZ/i);
  assert.match(reconciliationSql, /provider_missing_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(reconciliationSql, /reconcile_attempts INTEGER NOT NULL DEFAULT 0/i);
  assert.match(reconciliationSql, /reconcile_after TIMESTAMPTZ NOT NULL/i);
  assert.match(reconciliationSql, /reconcile_lease_until TIMESTAMPTZ/i);
  assert.match(reconciliationSql, /reconcile_worker_id TEXT NOT NULL DEFAULT ''/i);
  assert.match(reconciliationSql, /idx_livekit_egress_jobs_reconcile/i);
  assert.match(reconciliationSql, /status IN \('starting', 'recording', 'stopping'\)/i);
});

test('standalone delivery orders Egress job migration after manifests and before runtime security', () => {
  const policy = JSON.parse(
    readFileSync('services/converact-service/source-policy.json', 'utf8')
  ) as { migrations: string[] };
  const manifests = policy.migrations.indexOf('086_ivekit_recording_manifests.sql');
  const jobs = policy.migrations.indexOf('087_livekit_egress_jobs.sql');
  const reconciliation = policy.migrations.indexOf('088_livekit_egress_reconciliation.sql');
  const security = policy.migrations.indexOf(
    'services/converact-service/migrations/090_ivekit_runtime_security.sql'
  );
  assert.ok(manifests >= 0 && manifests < jobs && jobs < reconciliation && reconciliation < security);
});
