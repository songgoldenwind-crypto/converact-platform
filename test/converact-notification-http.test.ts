import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NotificationError,
  routeConveractFabricNotificationApi,
  type CreateNotificationEndpointInput,
  type CreateNotificationInput,
  type NotificationEndpoint,
  type NotificationHttpModule,
  type NotificationInboxMutationInput,
  type ReceiveNotificationReceiptInput,
  type PutNotificationPreferenceInput,
  type CreateNotificationTemplateInput,
  type UpdateNotificationEndpointInput
} from '../src/agent-runtime/converact/notifications/index.js';

const operatorHeaders = {
  'x-tenant-id': 'tenant-a', 'x-user-id': 'operator-a', 'x-role': 'operator',
  'idempotency-key': 'notification-http-a'
};
const adminHeaders = {
  'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a', 'x-role': 'admin',
  'idempotency-key': 'endpoint-http-a'
};

test('notification HTTP creates tenant-bound notifications and strips encrypted internals', async () => {
  let captured: CreateNotificationInput | null = null;
  const result = await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications', new URL('http://localhost/api/ivekit/notifications'),
    {
      event_type: 'example.created', recipient: { kind: 'user', ref: 'user-a' },
      targets: [{ channel: 'in_app', recipient: 'user-a' }],
      content: { title: 'Notice' }, content_projection: { title: 'Notice' },
      business_ref: { type: 'example', id: 'example-a' }
    }, operatorHeaders, {
      module: moduleStub({
        async createNotification(input) {
          captured = input;
          return notificationResult();
        }
      })
    }
  );

  assert.equal(captured?.tenant_id, 'tenant-a');
  assert.equal(captured?.requested_by, 'operator-a');
  assert.equal(captured?.idempotency_key, 'notification-http-a');
  assert.equal(JSON.stringify(result).includes('content-ciphertext'), false);
  assert.equal(JSON.stringify(result).includes('recipient-ciphertext'), false);
  assert.equal(JSON.stringify(result).includes('recipient-hmac'), false);
  assert.equal((result as any).data.deliveries[0].recipient_redacted, 'u***-a');
});

test('notification HTTP reserves force delivery for administrative capabilities', async () => {
  const body = {
    event_type: 'security.alert', recipient: { kind: 'user', ref: 'user-a' },
    targets: [{ channel: 'in_app', recipient: 'user-a' }], content: { title: 'Alert' },
    business_ref: { type: 'audit', id: 'audit-a' }, force_delivery: true
  };
  await assert.rejects(
    routeConveractFabricNotificationApi(
      null, 'POST', '/api/ivekit/notifications',
      new URL('http://localhost/api/ivekit/notifications'), body, operatorHeaders,
      { module: moduleStub() }
    ),
    (error: unknown) => error instanceof NotificationError && error.code === 'compliance_denied'
  );
  const result = await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications',
    new URL('http://localhost/api/ivekit/notifications'), body, adminHeaders,
    { module: moduleStub() }
  );
  assert.equal((result as any).status, 201);
});

test('notification HTTP binds inbox access to the authenticated user', async () => {
  let mutated: NotificationInboxMutationInput | null = null;
  const module = moduleStub({
    async listInbox(input) {
      assert.equal(input.user_id, 'viewer-a');
      return { items: [], next_cursor: null };
    },
    async countUnread(_tenant, user) {
      assert.equal(user, 'viewer-a');
      return 3;
    },
    async mutateInbox(input) {
      mutated = input;
      return {
        id: input.item_id, tenant_id: input.tenant_id, notification_id: 'notification-a',
        user_id: input.user_id, projection: {}, priority: 'normal',
        read_at: input.now.toISOString(), archived_at: null,
        created_at: input.now.toISOString(), updated_at: input.now.toISOString()
      };
    }
  });
  const headers = { 'x-tenant-id': 'tenant-a', 'x-user-id': 'viewer-a', 'x-role': 'viewer' };

  assert.deepEqual((await routeConveractFabricNotificationApi(
    null, 'GET', '/api/ivekit/notifications/inbox',
    new URL('http://localhost/api/ivekit/notifications/inbox?user_id=other-user'),
    null, headers, { module }
  ) as any).data, { items: [], next_cursor: null });
  assert.deepEqual((await routeConveractFabricNotificationApi(
    null, 'GET', '/api/ivekit/notifications/inbox/unread-count',
    new URL('http://localhost/api/ivekit/notifications/inbox/unread-count'),
    null, headers, { module }
  ) as any).data, { unread_count: 3 });
  await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications/inbox/item-a/read',
    new URL('http://localhost/api/ivekit/notifications/inbox/item-a/read'),
    {}, headers, { module }
  );
  assert.equal(mutated?.user_id, 'viewer-a');
  assert.equal(mutated?.action, 'read');
});

test('notification HTTP endpoint management requires admin and never returns secret references', async () => {
  let captured: CreateNotificationEndpointInput | null = null;
  let updated: UpdateNotificationEndpointInput | null = null;
  const endpoint = endpointRow();
  const module = moduleStub({
    async createEndpoint(input) {
      captured = input;
      return { endpoint, created: true };
    },
    async updateEndpoint(input) {
      updated = input;
      return { ...endpoint, status: 'paused', revision: 2 };
    }
  });
  const body = {
    name: 'Webhook', channel: 'webhook', provider_kind: 'webhook',
    endpoint_url: 'https://events.example.com/hook', signing_secret_ref: 'env://HOOK_SECRET'
  };
  const result = await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications/endpoints',
    new URL('http://localhost/api/ivekit/notifications/endpoints'),
    body, adminHeaders, { module }
  );
  assert.equal(captured?.tenant_id, 'tenant-a');
  assert.equal(captured?.actor, 'admin-a');
  assert.equal(captured?.idempotency_key, 'endpoint-http-a');
  assert.equal(JSON.stringify(result).includes('HOOK_SECRET'), false);
  assert.equal((result as any).data.endpoint.signing_secret_configured, true);

  await routeConveractFabricNotificationApi(
    null, 'PUT', '/api/ivekit/notifications/endpoints/endpoint-a',
    new URL('http://localhost/api/ivekit/notifications/endpoints/endpoint-a'),
    { expected_revision: 1, patch: { status: 'paused', tenant_id: 'other', id: 'other' } },
    adminHeaders, { module }
  );
  assert.deepEqual(updated?.patch, { status: 'paused' });

  await assert.rejects(
    routeConveractFabricNotificationApi(
      null, 'POST', '/api/ivekit/notifications/endpoints',
      new URL('http://localhost/api/ivekit/notifications/endpoints'),
      body, operatorHeaders, { module }
    ),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'compliance_denied'
  );
});

test('notification HTTP exposes admin template revisions and user-scoped preferences', async () => {
  let createdTemplate: CreateNotificationTemplateInput | null = null;
  let preference: PutNotificationPreferenceInput | null = null;
  const module = moduleStub({
    async createTemplate(input) {
      createdTemplate = input;
      return templateSnapshot();
    },
    async listPreferences(_tenantId, userId) {
      assert.equal(userId, 'viewer-a');
      return [];
    },
    async putPreference(input) {
      preference = input;
      return preferenceRow();
    }
  });

  const created = await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications/templates',
    new URL('http://localhost/api/ivekit/notifications/templates'),
    {
      template_key: 'call.missed', locale: 'zh-CN', channels: ['in_app'],
      content: { title: '未接来电' }
    }, adminHeaders, { module }
  );
  assert.equal(createdTemplate?.tenant_id, 'tenant-a');
  assert.equal(createdTemplate?.actor, 'admin-a');
  assert.equal((created as any).status, 201);

  const viewerHeaders = { 'x-tenant-id': 'tenant-a', 'x-user-id': 'viewer-a', 'x-role': 'viewer' };
  await routeConveractFabricNotificationApi(
    null, 'GET', '/api/ivekit/notifications/preferences',
    new URL('http://localhost/api/ivekit/notifications/preferences?user_id=other'),
    null, viewerHeaders, { module }
  );
  await routeConveractFabricNotificationApi(
    null, 'PUT', '/api/ivekit/notifications/preferences/call.missed/sms',
    new URL('http://localhost/api/ivekit/notifications/preferences/call.missed/sms'),
    { enabled: false, locale: 'zh-CN', quiet_hours: {}, expected_revision: 0 },
    viewerHeaders, { module }
  );
  assert.equal(preference?.tenant_id, 'tenant-a');
  assert.equal(preference?.user_id, 'viewer-a');
  assert.equal(preference?.event_type, 'call.missed');
  assert.equal(preference?.channel, 'sms');
});

test('notification HTTP lists operational resources without encrypted fields and binds filters', async () => {
  const delivery = notificationResult().deliveries[0];
  const calls: Record<string, any> = {};
  const module = moduleStub({
    async listEndpoints(input) {
      calls.endpoint = input;
      return { items: [endpointRow()], next_cursor: 'endpoint-next' };
    },
    async listTemplates(input) {
      calls.template = input;
      return { items: [templateSnapshot().template], next_cursor: null };
    },
    async listTemplateVersions(input) {
      calls.version = input;
      return { items: [templateSnapshot().version], next_cursor: null };
    },
    async listDeliveries(input) {
      calls.delivery = input;
      return { items: [delivery], next_cursor: 'delivery-next' };
    }
  });
  const endpoints = await routeConveractFabricNotificationApi(
    null, 'GET', '/api/ivekit/notifications/endpoints',
    new URL('http://localhost/api/ivekit/notifications/endpoints?channel=webhook&status=active&limit=25'),
    null, adminHeaders, { module }
  );
  assert.equal(calls.endpoint.tenant_id, 'tenant-a');
  assert.equal(calls.endpoint.channel, 'webhook');
  assert.equal(JSON.stringify(endpoints).includes('HOOK_SECRET'), false);

  await routeConveractFabricNotificationApi(
    null, 'GET', '/api/ivekit/notifications/templates',
    new URL('http://localhost/api/ivekit/notifications/templates?status=draft'),
    null, adminHeaders, { module }
  );
  await routeConveractFabricNotificationApi(
    null, 'GET', '/api/ivekit/notifications/templates/template-a/versions',
    new URL('http://localhost/api/ivekit/notifications/templates/template-a/versions?locale=zh-CN'),
    null, adminHeaders, { module }
  );
  assert.equal(calls.template.status, 'draft');
  assert.equal(calls.version.template_id, 'template-a');

  const deliveries = await routeConveractFabricNotificationApi(
    null, 'GET', '/api/ivekit/notifications/deliveries',
    new URL('http://localhost/api/ivekit/notifications/deliveries?state=failed&endpoint_id=endpoint-a'),
    null, adminHeaders, { module }
  );
  assert.equal(calls.delivery.state, 'failed');
  assert.equal((deliveries as any).data.next_cursor, 'delivery-next');
  assert.equal(JSON.stringify(deliveries).includes('recipient-ciphertext'), false);
  assert.equal(JSON.stringify(deliveries).includes('payload-ciphertext'), false);
});

test('notification HTTP retries, archives and tests endpoints through audited module operations', async () => {
  const calls: Record<string, any> = {};
  const module = moduleStub({
    async retryDelivery(input) {
      calls.retry = input;
      return { ...notificationResult().deliveries[0], state: 'retry_wait', error_code: '' };
    },
    async getEndpoint() { return endpointRow(); },
    async updateEndpoint(input) {
      calls.archiveEndpoint = input;
      return { ...endpointRow(), status: 'archived', revision: 2 };
    },
    async createNotification(input) {
      calls.testNotification = input;
      return notificationResult();
    },
    async archiveTemplate(input) {
      calls.archiveTemplate = input;
      return { ...templateSnapshot().template, status: 'archived' };
    }
  });

  await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications/deliveries/delivery-a/retry',
    new URL('http://localhost/api/ivekit/notifications/deliveries/delivery-a/retry'),
    { expected_state: 'uncertain', allow_uncertain: true }, adminHeaders, { module, audit: null }
  );
  assert.equal(calls.retry.expected_state, 'uncertain');
  assert.equal(calls.retry.allow_uncertain, true);

  await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications/endpoints/endpoint-a/archive',
    new URL('http://localhost/api/ivekit/notifications/endpoints/endpoint-a/archive'),
    { expected_revision: 1 }, adminHeaders, { module, audit: null }
  );
  assert.deepEqual(calls.archiveEndpoint.patch, { status: 'archived' });

  await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications/endpoints/endpoint-a/test',
    new URL('http://localhost/api/ivekit/notifications/endpoints/endpoint-a/test'),
    { event_type: 'endpoint.test', recipient: 'test@example.com', content: { title: 'Test' } },
    adminHeaders, { module, audit: null }
  );
  assert.equal(calls.testNotification.recipient.ref, 'endpoint-a');
  assert.equal(calls.testNotification.targets[0].endpoint_id, 'endpoint-a');
  assert.equal(calls.testNotification.max_attempts, 1);

  await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications/templates/template-a/archive',
    new URL('http://localhost/api/ivekit/notifications/templates/template-a/archive'),
    { expected_revision: 1 }, adminHeaders, { module, audit: null }
  );
  assert.equal(calls.archiveTemplate.template_id, 'template-a');
});

test('notification HTTP accepts signed provider receipts without user authentication', async () => {
  let captured: ReceiveNotificationReceiptInput | null = null;
  const module = moduleStub({
    async receiveReceipt(input) {
      captured = input;
      return {
        receipt: {
          id: 'receipt-a', tenant_id: input.tenant_id, delivery_id: 'delivery-a',
          provider_kind: 'sms_http', provider_event_id: 'event-a', receipt_status: 'delivered',
          canonical_hash: 'a'.repeat(64), projection: {}, occurred_at: null,
          received_at: '2026-07-15T08:00:00.000Z'
        },
        created: true,
        reconciliation: 'delivered'
      };
    }
  });
  const result = await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications/provider-receipts/endpoint-a',
    new URL('http://localhost/api/ivekit/notifications/provider-receipts/endpoint-a'),
    { provider_event_id: 'event-a', delivery_id: 'delivery-a', status: 'delivered' },
    {
      'x-tenant-id': 'tenant-a', 'x-opc-timestamp': '1784102400',
      'x-opc-signature': `sha256=${'a'.repeat(64)}`
    }, { module }
  );
  assert.equal(captured?.tenant_id, 'tenant-a');
  assert.equal(captured?.endpoint_id, 'endpoint-a');
  assert.equal((result as any).data.reconciliation, 'delivered');
  assert.equal(JSON.stringify(result).includes('canonical_hash'), false);
});

test('notification HTTP records successful critical mutations without content or recipients', async () => {
  const audits: any[] = [];
  await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications',
    new URL('http://localhost/api/ivekit/notifications'),
    {
      event_type: 'call.missed', recipient: { kind: 'user', ref: 'private-user' },
      targets: [{ channel: 'sms', recipient: '+8613800138000' }],
      content: { title: 'private message', token: 'must-not-leak' },
      business_ref: { type: 'call', id: 'call-a' }
    }, {
      ...adminHeaders,
      'x-opc-request-id': 'request-a',
      'x-opc-source-ip': '203.0.113.10'
    }, {
      module: moduleStub(),
      audit: {
        async append(input) {
          audits.push(input);
          return { event: { id: 'audit-a', ...input }, created: true } as any;
        }
      }
    }
  );

  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'notification.create');
  assert.equal(audits[0].request_id, 'request-a');
  assert.equal(audits[0].source_ip, '203.0.113.10');
  assert.equal(JSON.stringify(audits[0]).includes('private message'), false);
  assert.equal(JSON.stringify(audits[0]).includes('+8613800138000'), false);
  assert.equal(JSON.stringify(audits[0]).includes('must-not-leak'), false);
});

test('notification HTTP applies tenant actor source and recipient distributed limits', async () => {
  const checks: any[] = [];
  await routeConveractFabricNotificationApi(
    null, 'POST', '/api/ivekit/notifications',
    new URL('http://localhost/api/ivekit/notifications'),
    {
      event_type: 'call.missed', recipient: { kind: 'user', ref: 'user-a' },
      targets: [
        { channel: 'sms', recipient: '+8613800138000' },
        { channel: 'email', recipient: 'private@example.com' }
      ],
      content: { title: 'Missed' }, business_ref: { type: 'call', id: 'call-a' }
    }, { ...adminHeaders, 'x-opc-source-ip': '203.0.113.10' }, {
      module: moduleStub(),
      rateLimiter: {
        async check(input) {
          checks.push(input);
          return { allowed: true, retry_after_seconds: 0, denied_scope: null };
        }
      }
    }
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].route_group, 'notification.create');
  assert.deepEqual(
    checks[0].dimensions.map((item: any) => item.scope_type),
    ['tenant', 'actor', 'source_ip', 'recipient', 'recipient', 'recipient']
  );
  assert.equal(checks[0].dimensions[2].key, '203.0.113.10');
});

function moduleStub(overrides: Partial<NotificationHttpModule> = {}): NotificationHttpModule {
  return {
    async createNotification() { return notificationResult(); },
    async getNotification() { return null; },
    async listInbox() { return { items: [], next_cursor: null }; },
    async countUnread() { return 0; },
    async mutateInbox() { return null; },
    async createEndpoint() { return { endpoint: endpointRow(), created: true }; },
    async getEndpoint() { return null; },
    async listEndpoints() { return { items: [], next_cursor: null }; },
    async updateEndpoint() { return endpointRow(); },
    async createTemplate() { return templateSnapshot(); },
    async updateTemplate() { return templateSnapshot(); },
    async publishTemplate() { return templateSnapshot(); },
    async getTemplate() { return null; },
    async listTemplates() { return { items: [], next_cursor: null }; },
    async listTemplateVersions() { return { items: [], next_cursor: null }; },
    async archiveTemplate() { return templateSnapshot().template; },
    async getDelivery() { return null; },
    async listDeliveries() { return { items: [], next_cursor: null }; },
    async retryDelivery() { return notificationResult().deliveries[0]; },
    async listPreferences() { return []; },
    async putPreference() { return preferenceRow(); },
    async receiveReceipt() { throw new Error('not implemented'); },
    ...overrides
  };
}

function templateSnapshot(): any {
  return {
    template: {
      id: 'template-a', tenant_id: 'tenant-a', template_key: 'call.missed', description: '',
      status: 'draft', draft_revision: 1, published_revision: null,
      created_by: 'admin-a', updated_by: 'admin-a', created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z'
    },
    version: {
      tenant_id: 'tenant-a', template_id: 'template-a', revision: 1, locale: 'zh-CN',
      channels: ['in_app'], content: { title: '未接来电' }, content_hash: 'f'.repeat(64),
      published: false, created_by: 'admin-a', created_at: '2026-07-15T00:00:00.000Z',
      published_at: null
    }
  };
}

function preferenceRow(): any {
  return {
    tenant_id: 'tenant-a', user_id: 'viewer-a', event_type: 'call.missed', channel: 'sms',
    enabled: false, locale: 'zh-CN', quiet_hours: {}, revision: 1,
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z'
  };
}

function notificationResult(): any {
  return {
    created: true,
    notification: {
      id: 'notification-a', tenant_id: 'tenant-a', event_type: 'example.created',
      recipient_kind: 'user', recipient_ref: 'user-a', channels: ['in_app'], locale: '',
      template_id: null, template_revision: null, content_ciphertext: 'content-ciphertext',
      content_projection: { title: 'Notice' }, priority: 'normal', force_delivery: false,
      business_ref_type: 'example', business_ref_id: 'example-a', requested_by: 'operator-a',
      correlation_id: '', idempotency_key: 'notification-http-a', payload_hash: 'a'.repeat(64),
      policy: {}, state: 'pending', scheduled_at: '2026-07-15T00:00:00.000Z',
      retention_until: null, created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z', completed_at: null
    },
    deliveries: [{
      id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a', channel: 'in_app',
      endpoint_id: null, provider_kind: 'unresolved', provider_profile_id: '',
      recipient_ciphertext: 'recipient-ciphertext', recipient_hmac: 'recipient-hmac',
      recipient_redacted: 'u***-a', payload_ciphertext: 'payload-ciphertext', payload_hash: 'hash',
      provider_idempotency_key: 'provider-key', state: 'pending', attempt_count: 0, max_attempts: 5,
      next_attempt_at: null, lease_token_hash: 'lease-hash', lease_until: null, worker_id: '',
      provider_request_id: '', provider_message_id: '', provider_receipt_projection: {},
      error_code: '', error_projection: {}, created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z', accepted_at: null, delivered_at: null, completed_at: null
    }]
  };
}

function endpointRow(): NotificationEndpoint {
  return {
    id: 'endpoint-a', tenant_id: 'tenant-a', name: 'Webhook', channel: 'webhook',
    provider_kind: 'webhook', status: 'active', endpoint_url: 'https://events.example.com/hook',
    secret_ref: '', signing_secret_ref: 'env://HOOK_SECRET', event_allowlist: [], config: {},
    failover_group: 'default', priority: 100, quota_per_minute: null, quota_per_day: null,
    health_status: 'unknown', last_health_at: null, revision: 1,
    idempotency_key: 'endpoint-http-a', payload_hash: 'e'.repeat(64),
    created_by: 'admin-a', updated_by: 'admin-a', created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z'
  };
}
