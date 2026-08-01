import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import { PostgresConveractFabricAuditStore } from '../src/agent-runtime/converact/operations/audit/postgres-store.js';
import type { ConveractFabricAuditAppendInput } from '../src/agent-runtime/converact/operations/audit/types.js';

class RecordingPg implements PgQueryable {
  calls: Array<{ text: string; params: unknown[] }> = [];
  constructor(private readonly respond: (text: string, params: unknown[]) => unknown[] = () => []) {}
  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = this.respond(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

test('Postgres audit store serializes tenant chains and appends immutable hashes', async () => {
  const pg = new RecordingPg((sql, params) => {
    if (/INSERT INTO ivekit_audit_events/i.test(sql)) return [eventRow({
      id: String(params[0]), previous_hash: String(params[16]), event_hash: String(params[17]),
      metadata: String(params[14]), occurred_at: String(params[15]),
      retention_until: params[18], legal_hold: params[19]
    })];
    return [];
  });
  const store = new PostgresConveractFabricAuditStore(pg, { id: () => 'audit-a' });
  const result = await store.append(appendInput());
  assert.equal(result.created, true);
  assert.equal(result.event.previous_hash, '0'.repeat(64));
  assert.match(result.event.event_hash, /^[a-f0-9]{64}$/);
  assert.equal(pg.calls.some((call) => /pg_advisory_xact_lock/i.test(call.text)), true);
  const insert = pg.calls.find((call) => /INSERT INTO ivekit_audit_events/i.test(call.text))!;
  assert.equal(insert.text.includes('203.0.113.10'), false);
  assert.equal(insert.params.includes('203.0.113.10'), false);
});

test('Postgres audit store lists tenant events with bounded keyset pagination', async () => {
  const pg = new RecordingPg((sql) => /SELECT event\.\*/i.test(sql) ? [eventRow()] : []);
  const page = await new PostgresConveractFabricAuditStore(pg).list({ tenant_id: 'tenant-a', limit: 20 });
  assert.equal(page.items.length, 1);
  const query = pg.calls.find((call) => /SELECT event\.\*/i.test(call.text))!;
  assert.match(query.text, /event\.tenant_id = \$1/i);
  assert.match(query.text, /ORDER BY event\.occurred_at DESC, event\.id DESC/i);
});

test('Postgres audit store replays identical idempotency keys and rejects changed payloads', async () => {
  const existing = eventRow();
  let calls = 0;
  const seedStore = new PostgresConveractFabricAuditStore(new RecordingPg((sql, params) => {
    if (/INSERT INTO ivekit_audit_events/i.test(sql)) return [eventRow({
      id: String(params[0]), previous_hash: String(params[16]), event_hash: String(params[17]),
      metadata: String(params[14]), occurred_at: String(params[15])
    })];
    return [];
  }), { id: () => 'audit-a' });
  const created = await seedStore.append(appendInput());
  Object.assign(existing, created.event);

  const pg = new RecordingPg((sql) => {
    if (/idempotency_key = \$2/i.test(sql)) {
      calls += 1;
      return [existing];
    }
    return [];
  });
  const store = new PostgresConveractFabricAuditStore(pg);
  const replay = await store.append({ ...appendInput(), occurred_at: '2026-07-15T09:00:00.000Z' });
  assert.equal(replay.created, false);
  assert.equal(calls, 1);
  await assert.rejects(
    () => store.append({ ...appendInput(), action: 'notification.endpoint.delete' }),
    (error: unknown) => (error as { code?: string }).code === 'idempotency_conflict'
  );
});

function appendInput(): ConveractFabricAuditAppendInput {
  return {
    tenant_id: 'tenant-a', actor_id: 'admin-a', actor_role: 'admin',
    action: 'notification.endpoint.create', resource_type: 'notification_endpoint',
    resource_id: 'endpoint-a', business_ref_type: 'endpoint', business_ref_id: 'endpoint-a',
    request_id: 'request-a', idempotency_key: 'audit-a', result: 'succeeded',
    policy_decision: 'allow', source_ip_hmac: 'b'.repeat(64), metadata: { channel: 'sms' },
    occurred_at: '2026-07-15T08:00:00.000Z', retention_until: null, legal_hold: false
  };
}

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'audit-a', ...appendInput(), previous_hash: '0'.repeat(64), event_hash: 'a'.repeat(64),
    created_at: '2026-07-15T08:00:00.000Z', ...overrides
  };
}
