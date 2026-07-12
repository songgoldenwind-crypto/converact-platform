import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import {
  IveKitTenantEventStore,
  iveKitEventReplayEnabled
} from '../src/agent-runtime/ivekit/tenant-event-store.js';
import { MemoryPg } from '../src/db-pg.js';

test('tenant event migration defines monotonic durable events with forced RLS', () => {
  const migration = readFileSync('src/migrations/042_ivekit_tenant_events.sql', 'utf8');
  assert.match(migration, /id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
  assert.match(migration, /audience_user_ids TEXT\[\]/);
  assert.match(migration, /visibility_scope TEXT/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
});

test('tenant event replay requires an explicit signing secret when enabled', () => {
  assert.equal(iveKitEventReplayEnabled({}), false);
  assert.equal(iveKitEventReplayEnabled({ OPC_JWT_SECRET: 'configured-secret' }), true);
  assert.equal(iveKitEventReplayEnabled({
    OPC_IVEKIT_EVENT_REPLAY_ENABLED: '0',
    OPC_JWT_SECRET: 'configured-secret'
  }), false);
  assert.throws(
    () => iveKitEventReplayEnabled({ OPC_IVEKIT_EVENT_REPLAY_ENABLED: '1' }),
    /EVENT_CURSOR_SECRET or OPC_JWT_SECRET is required/
  );
});

test('tenant event replay uses signed cursors, current membership and strict targeted visibility', async () => {
  const pg = new MemoryPg();
  const collaboration = new CollaborationStore(pg);
  const tenantId = 'tenant_event_replay';
  let now = new Date('2026-07-12T10:00:00.000Z');
  const events = new IveKitTenantEventStore(pg, {
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
  const pg = new MemoryPg();
  let now = new Date('2026-07-12T10:00:00.000Z');
  const events = new IveKitTenantEventStore(pg, {
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
  const events = new IveKitTenantEventStore(new MemoryPg(), {
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
