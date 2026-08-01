import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import {
  ConveractFabricTenantEventStore,
  converactFabricEventReplayEnabled
} from '../src/agent-runtime/converact/tenant-event-store.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';

test('tenant event migration defines monotonic durable events with forced RLS', () => {
  const migration = readFileSync('src/migrations/042_ivekit_tenant_events.sql', 'utf8');
  assert.match(migration, /id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
  assert.match(migration, /audience_user_ids TEXT\[\]/);
  assert.match(migration, /visibility_scope TEXT/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
});

test('tenant event idempotency migration deduplicates stable producer keys per tenant', () => {
  const migration = readFileSync('src/migrations/072_ivekit_notification_events.sql', 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS idempotency_key TEXT NOT NULL DEFAULT ''/i);
  assert.match(migration, /CHECK \(char_length\(idempotency_key\) <= 255\)/i);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX[\s\S]*ON ivekit_tenant_events\(tenant_id, idempotency_key\)/i
  );
  assert.match(migration, /WHERE idempotency_key <> ''/i);
});

test('tenant event replay requires an explicit signing secret when enabled', () => {
  assert.equal(converactFabricEventReplayEnabled({}), false);
  assert.equal(converactFabricEventReplayEnabled({ CONVERACT_JWT_SECRET: 'configured-secret' }), true);
  assert.equal(converactFabricEventReplayEnabled({
    CONVERACT_FABRIC_EVENT_REPLAY_ENABLED: '0',
    CONVERACT_JWT_SECRET: 'configured-secret'
  }), false);
  assert.throws(
    () => converactFabricEventReplayEnabled({ CONVERACT_FABRIC_EVENT_REPLAY_ENABLED: '1' }),
    /EVENT_CURSOR_SECRET or CONVERACT_JWT_SECRET is required/
  );
});

test('tenant event replay uses signed cursors, current membership and strict targeted visibility', async () => {
  const pg = new MemoryPg();
  const collaboration = new CollaborationStore(pg);
  const tenantId = 'tenant_event_replay';
  let now = new Date('2026-07-12T10:00:00.000Z');
  const events = new ConveractFabricTenantEventStore(pg, {
    cursor_secret: 'tenant-event-test-secret',
    retention_ms: 60_000,
    now: () => now
  });

  const session = await collaboration.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'event-replay-order' }
  });
  await collaboration.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'member-1',
    role: 'agent'
  });

  const before = await events.headCursor(tenantId);
  const created = await events.append({
    tenant_id: tenantId,
    type: 'collaboration.message.created',
    data: { session_id: session.id, message_id: 'message-1' }
  });
  const targeted = await events.append({
    tenant_id: tenantId,
    type: 'ivekit.media.participant.moderated',
    data: { call_id: 'call-1' },
    audience_user_ids: ['member-1']
  });

  assert.equal(BigInt(targeted.event_id) > BigInt(created.event_id), true);
  assert.equal(created.visibility_scope, 'chat_session');
  assert.equal(created.visibility_ref_id, session.id);

  const memberPage = await events.list({
    tenant_id: tenantId,
    user_id: 'member-1',
    role: 'operator',
    cursor: before,
    limit: 10
  });
  assert.equal(memberPage.snapshot_required, false);
  assert.deepEqual(memberPage.items.map((event) => event.event_id), [created.event_id, targeted.event_id]);
  assert.equal(memberPage.next_cursor, targeted.cursor);

  const outsiderPage = await events.list({
    tenant_id: tenantId,
    user_id: 'outsider',
    role: 'operator',
    cursor: before,
    limit: 10
  });
  assert.deepEqual(outsiderPage.items, []);

  const adminPage = await events.list({
    tenant_id: tenantId,
    user_id: 'admin-1',
    role: 'admin',
    cursor: before,
    limit: 10
  });
  assert.deepEqual(adminPage.items.map((event) => event.event_id), [created.event_id]);

  await collaboration.leaveParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'member-1'
  });
  const revokedPage = await events.list({
    tenant_id: tenantId,
    user_id: 'member-1',
    role: 'operator',
    cursor: before,
    limit: 10
  });
  assert.deepEqual(revokedPage.items.map((event) => event.event_id), [targeted.event_id]);

  const tampered = `${targeted.cursor.slice(0, -1)}${targeted.cursor.endsWith('a') ? 'b' : 'a'}`;
  const invalidPage = await events.list({
    tenant_id: tenantId,
    user_id: 'member-1',
    role: 'operator',
    cursor: tampered,
    limit: 10
  });
  assert.equal(invalidPage.snapshot_required, true);
  assert.equal(invalidPage.reason, 'invalid_cursor');

  const crossTenantPage = await events.list({
    tenant_id: 'tenant_other',
    user_id: 'member-1',
    role: 'operator',
    cursor: before,
    limit: 10
  });
  assert.equal(crossTenantPage.snapshot_required, true);
  assert.equal(crossTenantPage.reason, 'cursor_tenant_mismatch');

  now = new Date('2026-07-12T10:02:00.000Z');
  const expiredPage = await events.list({
    tenant_id: tenantId,
    user_id: 'member-1',
    role: 'operator',
    cursor: before,
    limit: 10
  });
  assert.equal(expiredPage.snapshot_required, true);
  assert.equal(expiredPage.reason, 'cursor_expired');
});

test('tenant event retention prunes expired rows per tenant without touching live events', async () => {
  const source = readFileSync('src/agent-runtime/converact/tenant-event-store.ts', 'utf8');
  assert.match(source, /hold\.category = 'tenant_events'/);
  assert.match(source, /hold\.resource_type = 'tenant_event'/);
  assert.match(source, /FROM ivekit_voice_cdr_calls cdr_call/);
  assert.match(source, /cdr_call\.billing_event_id = ivekit_tenant_events\.id/);
  assert.match(source, /FROM ivekit_voice_cdr_receipts cdr_receipt/);
  assert.match(source, /cdr_receipt\.billing_event_id = ivekit_tenant_events\.id/);
  const pg = new MemoryPg();
  let now = new Date('2026-07-12T10:00:00.000Z');
  const events = new ConveractFabricTenantEventStore(pg, {
    cursor_secret: 'tenant-event-retention-secret',
    retention_ms: 1_000,
    now: () => now
  });
  const tenantId = 'tenant_event_retention';
  await events.append({ tenant_id: tenantId, type: 'expired.event', data: { id: 'expired' } });
  now = new Date('2026-07-12T10:00:02.000Z');
  const summary = await events.pruneExpired({ now, tenant_limit: 10, batch_size: 100 });
  assert.deepEqual(summary, { tenants: 1, deleted: 1 });

  const head = await events.headCursor(tenantId);
  await events.append({ tenant_id: tenantId, type: 'live.event', data: { id: 'live' } });
  const live = await events.list({
    tenant_id: tenantId,
    user_id: 'retention-viewer',
    role: 'operator',
    cursor: head,
    limit: 10
  });
  assert.deepEqual(live.items.map((event) => event.type), ['live.event']);
});

test('tenant event payload accepts shared references but rejects actual cycles', async () => {
  const events = new ConveractFabricTenantEventStore(new MemoryPg(), {
    cursor_secret: 'tenant-event-shared-reference-secret'
  });
  const shared = { id: 'shared-message' };
  const accepted = await events.append({
    tenant_id: 'tenant_event_shared_reference',
    type: 'collaboration.message.created',
    data: { message: shared, result: { message: shared } }
  });
  assert.equal((accepted.data as any).message.id, 'shared-message');

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(
    () => events.append({
      tenant_id: 'tenant_event_shared_reference',
      type: 'collaboration.message.created',
      data: cyclic
    }),
    /must be acyclic/
  );
});

test('tenant event append returns the original event for a repeated producer idempotency key', async () => {
  const events = new ConveractFabricTenantEventStore(new MemoryPg(), {
    cursor_secret: 'tenant-event-idempotency-secret'
  });
  const input = {
    tenant_id: 'tenant_event_idempotency',
    type: 'notification.delivery.updated',
    data: { notification_id: 'notification-a', delivery_id: 'delivery-a', state: 'delivered' },
    audience_user_ids: ['user-a'],
    idempotency_key: 'notification:delivery:stable-key'
  };
  const first = await events.append(input);
  const repeated = await events.append(input);

  assert.equal(repeated.event_id, first.event_id);
  const before = await events.headCursor(input.tenant_id);
  const after = await events.append({
    ...input,
    idempotency_key: 'notification:delivery:second-key',
    data: { ...input.data, state: 'failed' }
  });
  const page = await events.list({
    tenant_id: input.tenant_id,
    user_id: 'user-a',
    role: 'operator',
    cursor: before,
    limit: 10
  });
  assert.deepEqual(page.items.map((event) => event.event_id), [after.event_id]);
});

test('tenant event live visibility batches scoped membership into one database probe', async () => {
  class VisibilityPg implements PgQueryable {
    readonly queries: string[] = [];

    async query<R>(text: string): Promise<any> {
      this.queries.push(text);
      if (/set_config\('app\.current_tenant'/i.test(text)) return { rows: [] as R[] };
      if (/FROM collaboration_participants participant/i.test(text)) {
        return {
          rows: [
            { user_id: 'member-1' },
            { user_id: 'member-3' }
          ] as R[]
        };
      }
      throw new Error(`unexpected query: ${text}`);
    }
  }

  const pg = new VisibilityPg();
  const events = new ConveractFabricTenantEventStore(pg, {
    cursor_secret: 'tenant-event-batch-visibility-secret'
  });
  const viewers: Array<{ user_id: string; role: 'operator' | 'admin' }> =
    Array.from({ length: 1_000 }, (_, index) => ({
    user_id: `member-${index}`,
    role: 'operator' as const
    }));
  viewers.push({ user_id: 'tenant-admin', role: 'admin' as const });
  const visible = await events.canViewMany({
    event_id: '1',
    cursor: 'unused',
    tenant_id: 'tenant-batch-visibility',
    type: 'collaboration.message.created',
    data: { session_id: 'session-batch-visibility' },
    timestamp: '2026-07-16T00:00:00.000Z',
    expires_at: '2026-07-17T00:00:00.000Z',
    visibility_scope: 'chat_session',
    visibility_ref_id: 'session-batch-visibility',
    audience_user_ids: []
  }, viewers);

  assert.equal(visible.length, viewers.length);
  assert.equal(visible[1], true);
  assert.equal(visible[2], false);
  assert.equal(visible[3], true);
  assert.equal(visible.at(-1), true);
  assert.equal(
    pg.queries.filter((query) => /FROM collaboration_participants participant/i.test(query)).length,
    1
  );
  assert.equal(pg.queries.some((query) => /ANY\(\$3/i.test(query)), false);
});
