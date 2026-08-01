import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import { PostgresConveractFabricEventWebhookStore } from '../src/agent-runtime/converact/integration-events/postgres-store.js';
import type { ConveractFabricEventWebhookSubscription } from '../src/agent-runtime/converact/integration-events/types.js';

test('event webhook store inserts idempotently and rejects changed payloads', async () => {
  const insertedPg = new RecordingPg((sql) => /INSERT INTO ivekit_event_webhook_subscriptions/i.test(sql)
    ? [subscriptionRow()]
    : []);
  const inserted = await new PostgresConveractFabricEventWebhookStore(insertedPg).insert(subscriptionRow());
  assert.equal(inserted.created, true);
  assert.match(
    insertedPg.calls.find((call) => /INSERT INTO ivekit_event_webhook_subscriptions/i.test(call.text))!.text,
    /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/i
  );

  const conflictPg = new RecordingPg((sql) => /INSERT INTO ivekit_event_webhook_subscriptions/i.test(sql)
    ? []
    : /idempotency_key = \$2/i.test(sql)
      ? [{ ...subscriptionRow(), payload_hash: 'f'.repeat(64) }]
      : []);
  await assert.rejects(
    new PostgresConveractFabricEventWebhookStore(conflictPg).insert(subscriptionRow()),
    (error: any) => error.status === 409
  );
});

test('event webhook store claims subscriptions scans events and fences cursor updates', async () => {
  const pg = new RecordingPg((sql) => {
    if (/opc_event_webhook_worker_tenant_ids/i.test(sql)) return [{ tenant_id: 'tenant-1' }];
    if (/WITH candidate AS/i.test(sql)) return [{
      ...subscriptionRow(), worker_id: 'worker-1', lease_token_hash: 'b'.repeat(64),
      lease_until: '2026-07-15T20:01:00.000Z', attempt_count: 1
    }];
    if (/FROM ivekit_tenant_events event/i.test(sql)) return [{
      id: '44', tenant_id: 'tenant-1', event_type: 'notification.created',
      visibility_scope: 'tenant', visibility_ref_id: '', audience_user_ids: [],
      payload: { notification_id: 'notification-1' },
      occurred_at: '2026-07-15T20:00:01.000Z', expires_at: '2026-07-16T20:00:01.000Z'
    }];
    if (/UPDATE ivekit_event_webhook_subscriptions subscription/i.test(sql)) {
      return [{ ...subscriptionRow(), last_event_id: '44', attempt_count: 0 }];
    }
    return [];
  });
  const store = new PostgresConveractFabricEventWebhookStore(pg);

  assert.deepEqual(await store.listWorkerTenants(new Date('2026-07-15T20:00:00.000Z'), 10), ['tenant-1']);
  const claims = await store.claimDue({
    tenant_id: 'tenant-1', worker_id: 'worker-1', lease_token_hash: 'b'.repeat(64),
    now: new Date('2026-07-15T20:00:00.000Z'), lease_ms: 60_000, limit: 5
  });
  assert.equal(claims.length, 1);
  const claim = pg.calls.find((call) => /WITH candidate AS/i.test(call.text))!;
  assert.match(claim.text, /FOR UPDATE SKIP LOCKED/i);
  assert.match(claim.text, /attempt_count = subscription\.attempt_count \+ 1/i);

  const events = await store.listEvents('tenant-1', '43', new Date('2026-07-15T20:00:00.000Z'), 20);
  assert.equal(events[0].id, '44');
  const complete = await store.completeClaim({
    tenant_id: 'tenant-1', subscription_id: 'subscription-1', worker_id: 'worker-1',
    lease_token_hash: 'b'.repeat(64), last_event_id: '44', now: new Date('2026-07-15T20:00:02.000Z')
  });
  assert.equal(complete.last_event_id, '44');
  const update = pg.calls.find((call) => /last_event_id = GREATEST/i.test(call.text))!;
  assert.match(update.text, /subscription\.worker_id = \$3/);
  assert.match(update.text, /subscription\.lease_token_hash = \$4/);
  assert.match(update.text, /last_event_id = GREATEST/);
});

class RecordingPg implements PgQueryable {
  calls: Array<{ text: string; params: unknown[] }> = [];
  constructor(private readonly respond: (text: string, params: unknown[]) => unknown[] = () => []) {}
  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = this.respond(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

function subscriptionRow(): ConveractFabricEventWebhookSubscription {
  return {
    id: 'subscription-1', tenant_id: 'tenant-1', endpoint_id: 'endpoint-1', name: 'LED events',
    event_patterns: ['notification.*'], status: 'active', last_event_id: '0',
    next_attempt_at: '2026-07-15T20:00:00.000Z', attempt_count: 0, error_code: '',
    lease_token_hash: '', lease_until: null, worker_id: '', revision: 1,
    idempotency_key: 'create-led-events', payload_hash: 'a'.repeat(64), created_by: 'admin-1',
    updated_by: 'admin-1', created_at: '2026-07-15T20:00:00.000Z',
    updated_at: '2026-07-15T20:00:00.000Z'
  };
}
