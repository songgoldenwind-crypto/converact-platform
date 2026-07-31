import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  PostgresIveKitRetentionStore,
  type IveKitRetentionClaim
} from '../src/agent-runtime/converact/operations/retention/index.js';

class RecordingPg implements PgQueryable {
  calls: Array<{ text: string; params: unknown[] }> = [];
  constructor(private readonly respond: (text: string, params: unknown[]) => unknown[] = () => []) {}
  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = this.respond(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

test('Postgres retention store claims policies with skip-locked leases and durable runs', async () => {
  const pg = new RecordingPg((sql) => {
    if (/SELECT \* FROM ivekit_retention_policies/i.test(sql)) return [policyRow()];
    if (/UPDATE ivekit_retention_policies/i.test(sql)) return [{ ...policyRow(), lease_owner: 'worker-a' }];
    return [];
  });
  const claims = await new PostgresIveKitRetentionStore(pg, { id: () => 'run-a' }).claimDue({
    tenant_id: 'tenant-a', worker_id: 'worker-a', lease_ms: 30_000, limit: 5,
    now: '2026-07-15T08:00:00.000Z'
  });
  assert.equal(claims[0]?.run_id, 'run-a');
  assert.equal(claims[0]?.cutoff_at, '2026-06-15T08:00:00.000Z');
  assert.equal(pg.calls.some((call) => /FOR UPDATE SKIP LOCKED/i.test(call.text)), true);
  assert.equal(pg.calls.some((call) => /INSERT INTO ivekit_retention_runs/i.test(call.text)), true);
});

test('Postgres retention store enforces terminal notification deletion and legal holds', async () => {
  const pg = new RecordingPg((sql) => /WITH candidates AS MATERIALIZED/i.test(sql)
    ? [{ scanned_count: '5', deleted_count: '4', held_count: '1' }]
    : []);
  const summary = await new PostgresIveKitRetentionStore(pg).deleteExpired(claim());
  assert.deepEqual(summary, { scanned_count: 5, deleted_count: 4, held_count: 1 });
  const query = pg.calls.find((call) => /WITH candidates AS MATERIALIZED/i.test(call.text))!;
  assert.match(query.text, /partial_failed/);
  assert.match(query.text, /ivekit_legal_holds/);
  assert.match(query.text, /hold\.status = 'active'/);
  assert.match(query.text, /notification\.retention_until <= \$3::timestamptz/i);
  assert.match(query.text,
    /notification\.retention_until IS NULL[\s\S]*notification\.created_at <= \$2/i);
  assert.equal(query.params[2], claim().started_at);
  assert.match(query.text, /ORDER BY held ASC/i);
});

test('Postgres audit retention separates absolute deadlines from policy age', async () => {
  const pg = new RecordingPg((sql) => {
    if (/SELECT COUNT\(\*\) AS scanned_count/i.test(sql)) {
      return [{ scanned_count: '2', held_count: '1' }];
    }
    if (/opc_ivekit_delete_expired_audit_events/i.test(sql)) return [{ deleted_count: '1' }];
    return [];
  });
  const summary = await new PostgresIveKitRetentionStore(pg).deleteExpired({
    ...claim(),
    policy: { ...claim().policy, category: 'audit' }
  });
  assert.deepEqual(summary, { scanned_count: 2, deleted_count: 1, held_count: 1 });
  const candidates = pg.calls.find((call) => /SELECT COUNT\(\*\) AS scanned_count/i.test(call.text))!;
  assert.match(candidates.text, /event\.retention_until <= \$3::timestamptz/i);
  assert.equal(candidates.params[2], claim().started_at);
  assert.match(candidates.text, /ORDER BY held ASC/i);
  const deletion = pg.calls.find((call) => /opc_ivekit_delete_expired_audit_events/i.test(call.text))!;
  assert.equal(deletion.params[3], claim().started_at);
});

test('Postgres retention store deletes tenant events in bounded legal-hold-aware batches', async () => {
  const pg = new RecordingPg((sql) => /DELETE FROM ivekit_tenant_events/i.test(sql)
    ? [{ scanned_count: '4', deleted_count: '3', held_count: '1' }]
    : []);
  const summary = await new PostgresIveKitRetentionStore(pg).deleteExpired({
    ...claim(),
    policy: { ...claim().policy, category: 'tenant_events' }
  });
  assert.deepEqual(summary, { scanned_count: 4, deleted_count: 3, held_count: 1 });
  const query = pg.calls.find((call) => /DELETE FROM ivekit_tenant_events/i.test(call.text))!;
  assert.match(query.text, /hold\.category = 'tenant_events'/i);
  assert.match(query.text, /hold\.resource_type = 'tenant_event'/i);
  assert.match(query.text, /FOR UPDATE SKIP LOCKED/i);
  assert.match(query.text, /event\.expires_at <= \$3::timestamptz/i);
  assert.equal(query.params?.[2], claim().started_at);
  assert.match(query.text, /ORDER BY held ASC/i);
  assert.match(
    query.text,
    /cdr_call\.billing_event_id = event\.id/i
  );
  assert.match(
    query.text,
    /cdr_receipt\.billing_event_id = event\.id/i
  );
});

test('Postgres retention store writes optimistic policies and idempotent legal holds', async () => {
  const pg = new RecordingPg((sql, params) => {
    if (/INSERT INTO ivekit_retention_policies/i.test(sql)) return [policyRow()];
    if (/idempotency_key = \$2/i.test(sql)) return [];
    if (/resource_id = \$4/i.test(sql)) return [];
    if (/INSERT INTO ivekit_legal_holds/i.test(sql)) return [holdRow({ id: String(params[0]) })];
    return [];
  });
  const store = new PostgresIveKitRetentionStore(pg, { id: () => 'hold-a' });
  const policy = await store.putPolicy({
    tenant_id: 'tenant-a', category: 'audit', enabled: true, retention_days: 365,
    batch_size: 100, interval_seconds: 3600, expected_revision: 0,
    actor: 'admin-a', now: '2026-07-15T08:00:00.000Z'
  });
  const hold = await store.placeLegalHold({
    tenant_id: 'tenant-a', category: 'audit', resource_type: 'audit_event',
    resource_id: 'audit-a', reason_code: 'legal_case', idempotency_key: 'hold-idem-a',
    actor: 'admin-a', now: '2026-07-15T08:00:00.000Z'
  });
  assert.equal(policy.category, 'notifications');
  assert.equal(hold.created, true);
  assert.equal(hold.hold.id, 'hold-a');
});

function claim(): IveKitRetentionClaim {
  return {
    run_id: 'run-a', worker_id: 'worker-a', cutoff_at: '2026-06-15T08:00:00.000Z',
    started_at: '2026-07-15T08:00:00.000Z', policy: policyRow() as any
  };
}

function policyRow(): Record<string, unknown> {
  return {
    tenant_id: 'tenant-a', category: 'notifications', enabled: true,
    retention_days: 30, batch_size: 100, interval_seconds: 3600,
    next_run_at: '2026-07-15T08:00:00.000Z', lease_owner: null,
    lease_expires_at: null, revision: 1, created_by: 'admin-a', updated_by: 'admin-a',
    created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z'
  };
}

function holdRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'hold-a', tenant_id: 'tenant-a', category: 'audit', resource_type: 'audit_event',
    resource_id: 'audit-a', reason_code: 'legal_case', idempotency_key: 'hold-idem-a',
    status: 'active', placed_by: 'admin-a', released_by: null,
    placed_at: '2026-07-15T08:00:00.000Z', released_at: null, ...overrides
  };
}
