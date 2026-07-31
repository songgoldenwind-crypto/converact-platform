import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  NotificationError,
  type CreateNotificationRecord,
  type NotificationChannel,
  type NotificationDeliveryRecord,
  type NotificationInboxItem,
  type NotificationEndpoint,
  type NotificationPreference,
  type NotificationRecord,
  type NotificationReceipt,
  type NotificationTemplate,
  type NotificationTemplateVersion
} from '../src/agent-runtime/ivekit/notifications/index.js';
import {
  PostgresNotificationStore
} from '../src/agent-runtime/ivekit/notifications/postgres/store.js';

class RecordingPg implements PgQueryable {
  readonly calls: Array<{ text: string; params: unknown[] }> = [];

  constructor(private readonly respond: (text: string, params: unknown[]) => unknown[] = () => []) {}

  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    if (/INSERT INTO ivekit_tenant_events/i.test(text)) {
      return {
        rows: [{
          id: String(this.calls.length), tenant_id: params[0], event_type: params[1],
          visibility_scope: params[2], visibility_ref_id: params[3],
          audience_user_ids: params[4], payload: params[5], occurred_at: params[6],
          expires_at: params[7], idempotency_key: params[8]
        }],
        rowCount: 1, command: '', oid: 0, fields: []
      };
    }
    const rows = this.respond(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

test('Postgres notification store atomically inserts an idempotent notification and deliveries', async () => {
  const input = createRecord();
  const pg = new RecordingPg((sql, params) => {
    if (/INSERT INTO ivekit_notifications/i.test(sql)) return [notificationRow()];
    if (/INSERT INTO ivekit_notification_deliveries/i.test(sql)) {
      return [deliveryRow({ id: String(params[0]), channel: String(params[3]) as NotificationChannel })];
    }
    return [];
  });

  const result = await new PostgresNotificationStore(pg).create(input);
  assert.equal(result.created, true);
  assert.equal(result.deliveries.length, 2);
  const notificationInsert = pg.calls.find((call) => /INSERT INTO ivekit_notifications/i.test(call.text))!;
  assert.match(notificationInsert.text, /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/i);
  assert.equal(notificationInsert.text.includes(input.notification.content_ciphertext), false);
  assert.equal(notificationInsert.params.includes(input.notification.content_ciphertext), true);
  assert.equal(pg.calls.filter((call) => /INSERT INTO ivekit_notification_deliveries/i.test(call.text)).length, 2);
  const event = pg.calls.find((call) => /INSERT INTO ivekit_tenant_events/i.test(call.text))!;
  assert.ok(event);
  assert.equal(event.params[1], 'notification.created');
  assert.deepEqual(event.params[4], ['user-a']);
  assert.match(String(event.params[8]), /^notification:created:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(event.params).includes(input.notification.content_ciphertext), false);
});

test('Postgres notification store reloads identical idempotent creates and rejects payload conflicts', async () => {
  const input = createRecord();
  const samePg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_notifications/i.test(sql)) return [];
    if (/FROM ivekit_notifications notification/i.test(sql)) return [notificationRow()];
    if (/FROM ivekit_notification_deliveries delivery/i.test(sql)) return [deliveryRow()];
    return [];
  });
  const replay = await new PostgresNotificationStore(samePg).create(input);
  assert.equal(replay.created, false);
  assert.equal(replay.notification.id, 'notification-a');
  assert.equal(replay.deliveries.length, 1);

  const conflictPg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_notifications/i.test(sql)) return [];
    if (/FROM ivekit_notifications notification/i.test(sql)) {
      return [notificationRow({ payload_hash: 'f'.repeat(64) })];
    }
    return [];
  });
  await assert.rejects(
    new PostgresNotificationStore(conflictPg).create(input),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'idempotency_conflict'
  );
});

test('Postgres notification store claims due work with SKIP LOCKED and worker fencing', async () => {
  const pg = new RecordingPg((sql) => {
    if (/opc_notification_worker_tenant_ids/i.test(sql)) return [{ tenant_id: 'tenant-a' }];
    if (/WITH candidate AS/i.test(sql)) {
      return [deliveryRow({ state: 'processing', worker_id: 'worker-a', attempt_count: 1 })];
    }
    if (/UPDATE ivekit_notification_deliveries/i.test(sql)) {
      return [deliveryRow({ state: 'delivered', worker_id: '', delivered_at: '2026-07-15T00:00:05.000Z' })];
    }
    return [];
  });
  const store = new PostgresNotificationStore(pg);

  assert.deepEqual(
    await store.listWorkerTenants(
      new Date('2026-07-15T00:00:00.000Z'),
      10,
      [2, 6, 10]
    ),
    ['tenant-a']
  );
  const claimed = await store.claimDue({
    tenant_id: 'tenant-a',
    worker_id: 'worker-a',
    now: new Date('2026-07-15T00:00:00.000Z'),
    lease_ms: 30_000,
    limit: 10,
    lease_token_hash: 'a'.repeat(64),
    shard_ids: [2, 6, 10]
  });
  assert.equal(claimed[0].state, 'processing');
  const claim = pg.calls.find((call) => /WITH candidate AS/i.test(call.text))!;
  assert.match(claim.text, /FOR UPDATE SKIP LOCKED/i);
  assert.match(claim.text, /state = 'processing'/i);
  assert.match(claim.text, /attempt_count = delivery\.attempt_count \+ 1/i);
  assert.match(claim.text, /delivery\.worker_shard = ANY\(\$7::smallint\[\]\)/i);
  const tenantScan = pg.calls.find((call) => /opc_notification_worker_tenant_ids/i.test(call.text))!;
  assert.match(tenantScan.text, /\$3::smallint\[\]/i);
  assert.deepEqual(tenantScan.params[2], [2, 6, 10]);

  await store.finishDelivery({
    tenant_id: 'tenant-a',
    delivery_id: 'delivery-a',
    worker_id: 'worker-a',
    state: 'delivered',
    now: new Date('2026-07-15T00:00:05.000Z'),
    provider_request_id: 'request-a',
    provider_message_id: 'message-a',
    receipt_projection: { semantics: 'provider_accepted_as_delivered' }
  });
  const finish = pg.calls.find((call) => /UPDATE ivekit_notification_deliveries/i.test(call.text)
    && /provider_receipt_projection/i.test(call.text))!;
  assert.match(finish.text, /WHERE tenant_id = \$1 AND id = \$2 AND worker_id = \$3/i);
  const aggregate = pg.calls.find((call) => /UPDATE ivekit_notifications notification/i.test(call.text))!;
  assert.match(aggregate.text, /partial_failed/i);
  assert.match(aggregate.text, /ivekit_notification_deliveries/i);
});

test('Postgres notification store projects and mutates only the addressed user inbox', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_notification_inbox_items/i.test(sql)) return [inboxRow()];
    if (/COUNT\(\*\)/i.test(sql)) return [{ unread_count: '1' }];
    if (/SELECT inbox\.\*/i.test(sql)) return [inboxRow()];
    if (/UPDATE ivekit_notification_inbox_items/i.test(sql)) {
      return [inboxRow({ read_at: '2026-07-15T00:01:00.000Z' })];
    }
    return [];
  });
  const store = new PostgresNotificationStore(pg);
  const inserted = await store.upsertInboxItem(inboxRow());
  assert.equal(inserted.id, 'delivery-a');

  const page = await store.listInbox({
    tenant_id: 'tenant-a', user_id: 'user-a', limit: 20, include_archived: false
  });
  assert.equal(page.items.length, 1);
  assert.equal(await store.countUnread('tenant-a', 'user-a'), 1);
  const updated = await store.mutateInbox({
    tenant_id: 'tenant-a', user_id: 'user-a', item_id: 'delivery-a',
    action: 'read', now: new Date('2026-07-15T00:01:00.000Z')
  });
  assert.equal(updated?.read_at, '2026-07-15T00:01:00.000Z');
  const mutation = pg.calls.find((call) => /UPDATE ivekit_notification_inbox_items/i.test(call.text))!;
  assert.match(mutation.text, /WHERE tenant_id = \$1 AND id = \$2 AND user_id = \$3/i);
  const events = pg.calls.filter((call) => /INSERT INTO ivekit_tenant_events/i.test(call.text));
  assert.deepEqual(events.map((call) => call.params[1]), [
    'notification.inbox.created',
    'notification.inbox.updated'
  ]);
  assert.equal(events.every((call) => JSON.stringify(call.params[4]) === '["user-a"]'), true);
  assert.equal(JSON.stringify(events).includes('recipient_ciphertext'), false);
});

test('Postgres notification delivery transition journals a user-scoped safe projection', async () => {
  const pg = new RecordingPg((sql) => {
    if (/UPDATE ivekit_notification_deliveries/i.test(sql)) {
      return [deliveryRow({
        state: 'delivered', worker_id: '', attempt_count: 2,
        delivered_at: '2026-07-15T00:00:05.000Z'
      })];
    }
    if (/SELECT notification\.recipient_kind/i.test(sql)) {
      return [{ recipient_kind: 'user', recipient_ref: 'user-a' }];
    }
    return [];
  });
  const published: unknown[] = [];
  const store = new PostgresNotificationStore(pg, {
    publish_event: async (event) => {
      published.push(event);
    }
  });

  await store.finishDelivery({
    tenant_id: 'tenant-a', delivery_id: 'delivery-a', worker_id: 'worker-a',
    state: 'delivered', now: new Date('2026-07-15T00:00:05.000Z'),
    provider_request_id: 'private-provider-request',
    provider_message_id: 'private-provider-message',
    receipt_projection: { status: 'accepted' }
  });

  const event = pg.calls.find((call) => /INSERT INTO ivekit_tenant_events/i.test(call.text))!;
  assert.equal(event.params[1], 'notification.delivery.updated');
  assert.deepEqual(event.params[4], ['user-a']);
  const serialized = JSON.stringify(event.params);
  assert.equal(serialized.includes('private-provider-request'), false);
  assert.equal(serialized.includes('private-provider-message'), false);
  assert.equal(published.length, 1);
});

test('Postgres notification store resolves active endpoints and uses optimistic revisions', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_notification_endpoints/i.test(sql)) return [endpointRow()];
    if (/UPDATE ivekit_notification_endpoints/i.test(sql)) return [endpointRow({ revision: 2 })];
    if (/FROM ivekit_notification_endpoints endpoint/i.test(sql)) return [endpointRow()];
    return [];
  });
  const store = new PostgresNotificationStore(pg);
  assert.equal((await store.insertEndpoint(endpointRow())).endpoint.id, 'endpoint-a');
  assert.equal((await store.getEndpoint('tenant-a', 'endpoint-a'))?.provider_kind, 'webhook');
  assert.equal((await store.listActiveEndpoints('tenant-a', 'webhook')).length, 1);
  assert.equal((await store.updateEndpoint(endpointRow(), 1)).revision, 2);
  const list = pg.calls.find((call) => /status = 'active'/i.test(call.text))!;
  assert.match(list.text, /ORDER BY endpoint\.priority, endpoint\.id/i);
  const update = pg.calls.find((call) => /UPDATE ivekit_notification_endpoints/i.test(call.text))!;
  assert.match(update.text, /WHERE tenant_id = \$1 AND id = \$2 AND revision = \$\d+/i);

  await assert.rejects(
    new PostgresNotificationStore(new RecordingPg()).updateEndpoint(endpointRow(), 9),
    (error: unknown) => error instanceof NotificationError && error.code === 'revision_conflict'
  );
});

test('Postgres notification store persists immutable template versions and preference revisions', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_notification_templates/i.test(sql)) return [templateRow()];
    if (/INSERT INTO ivekit_notification_template_versions/i.test(sql)) return [templateVersionRow()];
    if (/UPDATE ivekit_notification_templates/i.test(sql)) return [templateRow({ draft_revision: 2 })];
    if (/FROM ivekit_notification_template_versions version/i.test(sql)) return [templateVersionRow()];
    if (/FROM ivekit_notification_templates template/i.test(sql)) return [templateRow()];
    if (/SELECT preference\.\*/i.test(sql)) return [preferenceRow()];
    if (/INSERT INTO ivekit_notification_preferences/i.test(sql)) return [preferenceRow()];
    return [];
  });
  const store = new PostgresNotificationStore(pg);
  const created = await store.createTemplate(templateRow(), templateVersionRow());
  assert.equal(created?.version.revision, 1);
  assert.equal((await store.getTemplate('tenant-a', 'template-a'))?.template_key, 'call.missed');
  assert.equal((await store.getTemplateByKey('tenant-a', 'call.missed'))?.id, 'template-a');
  assert.equal((await store.getTemplateVersion('tenant-a', 'template-a', 1, 'zh-CN'))?.locale, 'zh-CN');

  const appended = await store.appendTemplateVersion(
    templateRow({ draft_revision: 2 }), templateVersionRow({ revision: 2 }), 1
  );
  assert.equal(appended?.template.draft_revision, 2);
  const update = pg.calls.find((call) => /UPDATE ivekit_notification_templates/i.test(call.text))!;
  assert.match(update.text, /GREATEST\(draft_revision, COALESCE\(published_revision, 0\)\) = \$\d+/i);

  assert.equal((await store.listPreferences('tenant-a', 'user-a')).length, 1);
  assert.equal((await store.putPreference(preferenceRow(), 0))?.revision, 1);
  const preferencePut = pg.calls.find((call) => /INSERT INTO ivekit_notification_preferences/i.test(call.text))!;
  assert.match(preferencePut.text, /ON CONFLICT \(tenant_id, user_id, event_type, channel\) DO UPDATE/i);
  assert.match(preferencePut.text, /revision = \$\d+/i);
});

test('Postgres notification store appends receipts and reconciles only accepted or uncertain deliveries', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_notification_receipts/i.test(sql)) return [receiptRow()];
    if (/UPDATE ivekit_notification_deliveries/i.test(sql) && /receipt_status/i.test(sql)) {
      return [{ state: 'delivered' }];
    }
    if (/FROM ivekit_notification_deliveries delivery/i.test(sql)) return [deliveryRow()];
    return [];
  });
  const store = new PostgresNotificationStore(pg);
  assert.equal((await store.getDelivery('tenant-a', 'delivery-a'))?.id, 'delivery-a');
  const inserted = await store.insertReceipt(receiptRow());
  assert.equal(inserted?.created, true);
  assert.equal(await store.reconcileReceipt(receiptRow()), 'delivered');
  const reconciliation = pg.calls.find((call) =>
    /UPDATE ivekit_notification_deliveries/i.test(call.text) && /receipt_status/i.test(call.text))!;
  assert.match(reconciliation.text, /state IN \('accepted', 'retry_wait', 'uncertain'\)/i);
  assert.match(reconciliation.text, /worker_id = ''/i);
});

test('Postgres notification store atomically reserves endpoint quota and opens circuits on failures', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_notification_endpoint_runtime/i.test(sql)) return [];
    if (/UPDATE ivekit_notification_endpoint_runtime runtime/i.test(sql) && /minute_bucket/i.test(sql)) {
      return [{ circuit_state: 'closed', minute_used: 1, day_used: 1 }];
    }
    if (/UPDATE ivekit_notification_endpoint_runtime runtime/i.test(sql)
      && /consecutive_failures/i.test(sql)) {
      return [{ consecutive_failures: 5, circuit_state: 'open' }];
    }
    return [];
  });
  const store = new PostgresNotificationStore(pg);
  const reserved = await store.reserveEndpoint({
    endpoint: endpointRow({ quota_per_minute: 10, quota_per_day: 100 }),
    now: new Date('2026-07-15T08:00:00.000Z')
  });
  assert.equal(reserved.allowed, true);
  const quota = pg.calls.find((call) => /minute_bucket/i.test(call.text)
    && /UPDATE ivekit_notification_endpoint_runtime/i.test(call.text))!;
  assert.match(quota.text, /FOR UPDATE|UPDATE ivekit_notification_endpoint_runtime/i);
  assert.match(quota.text, /minute_used ELSE 0 END\) < \$\d+/i);
  assert.match(quota.text, /day_used ELSE 0 END\) < \$\d+/i);

  await store.recordEndpointResult({
    endpoint: endpointRow(), outcome: 'failure', now: new Date('2026-07-15T08:00:01.000Z')
  });
  const circuit = pg.calls.find((call) => /consecutive_failures/i.test(call.text)
    && /UPDATE ivekit_notification_endpoint_runtime/i.test(call.text))!;
  assert.match(circuit.text, /circuit_state = CASE/i);
  assert.match(circuit.text, /circuit_open_until/i);
});

test('Postgres notification health checks use SKIP LOCKED leases and fenced completion', async () => {
  const pg = new RecordingPg((sql) => {
    if (/opc_notification_health_tenant_ids/i.test(sql)) return [{ tenant_id: 'tenant-a' }];
    if (/WITH candidate AS/i.test(sql) && /health_lease_token_hash/i.test(sql)) {
      return [endpointRow()];
    }
    if (/WITH runtime_update AS/i.test(sql)) return [{ id: 'endpoint-a' }];
    return [];
  });
  const store = new PostgresNotificationStore(pg);
  const now = new Date('2026-07-15T08:00:00.000Z');
  const staleBefore = new Date('2026-07-15T07:55:00.000Z');
  const leaseTokenHash = 'a'.repeat(64);

  assert.deepEqual(await store.listHealthTenants(now, staleBefore, 10), ['tenant-a']);
  const claimed = await store.claimHealthEndpoints({
    tenant_id: 'tenant-a', worker_id: 'health-worker-a', lease_token_hash: leaseTokenHash,
    now, stale_before: staleBefore, lease_ms: 120_000, limit: 25
  });
  assert.equal(claimed[0]?.id, 'endpoint-a');
  const claim = pg.calls.find((call) => /WITH candidate AS/i.test(call.text)
    && /health_lease_token_hash/i.test(call.text))!;
  assert.match(claim.text, /FOR UPDATE OF runtime SKIP LOCKED/i);
  assert.match(claim.text, /health_worker_id = \$5/i);
  assert.match(claim.text, /health_lease_token_hash = \$6/i);

  await store.finishHealthProbe({
    endpoint: endpointRow(), worker_id: 'health-worker-a', lease_token_hash: leaseTokenHash,
    result: { outcome: 'healthy', code: 'health_ok', latency_ms: 12 }, now
  });
  const finish = pg.calls.find((call) => /WITH runtime_update AS/i.test(call.text))!;
  assert.match(finish.text, /runtime\.health_worker_id = \$3/i);
  assert.match(finish.text, /runtime\.health_lease_token_hash = \$4/i);
  assert.match(finish.text, /health_worker_id = '', health_lease_token_hash = ''/i);

  await assert.rejects(
    new PostgresNotificationStore(new RecordingPg()).finishHealthProbe({
      endpoint: endpointRow(), worker_id: 'health-worker-a', lease_token_hash: leaseTokenHash,
      result: { outcome: 'healthy', code: 'health_ok', latency_ms: 12 }, now
    }),
    (error: unknown) => error instanceof NotificationError && error.code === 'lease_lost'
  );
});

test('Postgres notification operations paginate bound filters and append manual retry history', async () => {
  const pg = new RecordingPg((sql) => {
    if (/SELECT endpoint\.\* FROM ivekit_notification_endpoints endpoint/i.test(sql)) {
      return [endpointRow(), endpointRow({ id: 'endpoint-b' })];
    }
    if (/WITH current AS/i.test(sql) && /manual_retry/i.test(sql)) {
      return [deliveryRow({ state: 'retry_wait', error_code: '', completed_at: null })];
    }
    if (/UPDATE ivekit_notification_templates template/i.test(sql)) {
      return [templateRow({ status: 'archived', updated_by: 'admin-a' })];
    }
    return [];
  });
  const store = new PostgresNotificationStore(pg);
  const first = await store.listEndpoints({ tenant_id: 'tenant-a', status: 'active', limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.next_cursor);
  await assert.rejects(() => store.listEndpoints({
    tenant_id: 'tenant-a', status: 'archived', limit: 1, cursor: first.next_cursor || undefined
  }), (error: unknown) => error instanceof NotificationError && error.code === 'validation_failed');

  const retried = await store.retryDelivery({
    tenant_id: 'tenant-a', delivery_id: 'delivery-a', actor: 'admin-a',
    expected_state: 'failed', allow_uncertain: false, operation_id: 'operation-a',
    now: new Date('2026-07-15T00:10:00.000Z')
  });
  assert.equal(retried?.state, 'retry_wait');
  const retry = pg.calls.find((call) => /WITH current AS/i.test(call.text))!;
  assert.match(retry.text, /INSERT INTO ivekit_notification_delivery_operations/i);
  assert.match(retry.text, /current\.state <> 'uncertain' OR \$7::boolean/i);
  assert.equal(retry.params[3], 'operation-a');

  const archived = await store.archiveTemplate({
    tenant_id: 'tenant-a', template_id: 'template-a', actor: 'admin-a', expected_revision: 1
  });
  assert.equal(archived?.status, 'archived');
});

function createRecord(): CreateNotificationRecord {
  return {
    notification: notificationRow(),
    deliveries: [
      deliveryRow(),
      deliveryRow({ id: 'delivery-b', channel: 'email', provider_idempotency_key: `notify_${'e'.repeat(64)}` })
    ]
  };
}

function notificationRow(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: 'notification-a', tenant_id: 'tenant-a', event_type: 'example.created',
    recipient_kind: 'user', recipient_ref: 'user-a', channels: ['in_app', 'email'],
    locale: 'zh-CN', template_id: null, template_revision: null,
    content_ciphertext: 'v1.nonce.tag.content', content_projection: { title: 'Notice' },
    priority: 'normal', force_delivery: false, business_ref_type: 'example',
    business_ref_id: 'example-a', requested_by: 'operator-a', correlation_id: 'request-a',
    idempotency_key: 'notification-create-a', payload_hash: 'a'.repeat(64), policy: {},
    state: 'pending', scheduled_at: '2026-07-15T00:00:00.000Z', retention_until: null,
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    completed_at: null, ...overrides
  };
}

function deliveryRow(overrides: Partial<NotificationDeliveryRecord> = {}): NotificationDeliveryRecord {
  return {
    id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a',
    channel: 'in_app', endpoint_id: null, provider_kind: 'unresolved', provider_profile_id: '',
    recipient_ciphertext: 'v1.nonce.tag.recipient', recipient_hmac: 'b'.repeat(64),
    recipient_redacted: 'u***-a', payload_ciphertext: 'v1.nonce.tag.content',
    payload_hash: 'c'.repeat(64), provider_idempotency_key: `notify_${'d'.repeat(64)}`,
    state: 'pending', attempt_count: 0, max_attempts: 5,
    next_attempt_at: '2026-07-15T00:00:00.000Z', lease_token_hash: '', lease_until: null,
    worker_id: '', provider_request_id: '', provider_message_id: '',
    provider_receipt_projection: {}, error_code: '', error_projection: {},
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    accepted_at: null, delivered_at: null, completed_at: null, ...overrides
  };
}

function inboxRow(overrides: Partial<NotificationInboxItem> = {}): NotificationInboxItem {
  return {
    id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a', user_id: 'user-a',
    projection: { title: 'Notice' }, priority: 'normal', read_at: null, archived_at: null,
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    ...overrides
  };
}

function endpointRow(overrides: Partial<NotificationEndpoint> = {}): NotificationEndpoint {
  return {
    id: 'endpoint-a', tenant_id: 'tenant-a', name: 'webhook', channel: 'webhook',
    provider_kind: 'webhook', status: 'active', endpoint_url: 'https://events.example.com/hook',
    secret_ref: '', signing_secret_ref: 'env://WEBHOOK_SECRET', event_allowlist: [], config: {},
    failover_group: 'default', priority: 100, quota_per_minute: null, quota_per_day: null,
    health_status: 'unknown', last_health_at: null, revision: 1, created_by: 'admin-a',
    idempotency_key: 'endpoint-create-a', payload_hash: 'e'.repeat(64),
    updated_by: 'admin-a', created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z', ...overrides
  };
}

function templateRow(overrides: Partial<NotificationTemplate> = {}): NotificationTemplate {
  return {
    id: 'template-a', tenant_id: 'tenant-a', template_key: 'call.missed',
    description: 'Missed call', status: 'draft', draft_revision: 1,
    published_revision: null, created_by: 'admin-a', updated_by: 'admin-a',
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    ...overrides
  };
}

function templateVersionRow(
  overrides: Partial<NotificationTemplateVersion> = {}
): NotificationTemplateVersion {
  return {
    tenant_id: 'tenant-a', template_id: 'template-a', revision: 1, locale: 'zh-CN',
    channels: ['in_app'], content: { title: 'Missed call' }, content_hash: 'f'.repeat(64),
    published: false, created_by: 'admin-a', created_at: '2026-07-15T00:00:00.000Z',
    published_at: null, ...overrides
  };
}

function preferenceRow(overrides: Partial<NotificationPreference> = {}): NotificationPreference {
  return {
    tenant_id: 'tenant-a', user_id: 'user-a', event_type: 'call.missed', channel: 'sms',
    enabled: true, locale: 'zh-CN', quiet_hours: {}, revision: 1,
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    ...overrides
  };
}

function receiptRow(overrides: Partial<NotificationReceipt> = {}): NotificationReceipt {
  return {
    id: 'receipt-a', tenant_id: 'tenant-a', delivery_id: 'delivery-a',
    provider_kind: 'sms_http', provider_event_id: 'provider-event-a',
    receipt_status: 'delivered', canonical_hash: '9'.repeat(64),
    projection: { provider_status: 'delivered' }, occurred_at: '2026-07-15T00:01:00.000Z',
    received_at: '2026-07-15T00:01:01.000Z', ...overrides
  };
}
