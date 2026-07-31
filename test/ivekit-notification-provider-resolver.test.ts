import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EnvNotificationSecretResolver,
  InAppNotificationProvider,
  NotificationError,
  createNotificationProviderResolver,
  type NotificationDeliveryRecord,
  type NotificationEndpoint,
  type NotificationEndpointRepository,
  type NotificationRecord
} from '../src/agent-runtime/converact/notifications/index.js';

class Endpoints implements NotificationEndpointRepository {
  constructor(readonly items: NotificationEndpoint[]) {}
  async getEndpoint(tenantId: string, endpointId: string): Promise<NotificationEndpoint | null> {
    return this.items.find((item) => item.tenant_id === tenantId && item.id === endpointId) || null;
  }
  async listActiveEndpoints(tenantId: string, channel: 'webhook' | 'email' | 'sms') {
    return this.items.filter((item) => item.tenant_id === tenantId && item.channel === channel
      && item.status === 'active').sort((left, right) => left.priority - right.priority);
  }
}

const inbox = { async upsertInboxItem(item: any) { return item; } };

test('notification provider resolver routes in-app without an external endpoint', async () => {
  const resolve = createNotificationProviderResolver({
    endpoints: new Endpoints([]), inbox,
    secrets: { async resolve() { throw new Error('must not resolve'); } }
  });
  const provider = await resolve(deliveryRow({ channel: 'in_app', endpoint_id: null }),
    notificationRow({ channels: ['in_app'] }));
  assert.equal(provider instanceof InAppNotificationProvider, true);
});

test('notification provider resolver binds endpoint, channel and secret purpose', async () => {
  const purposes: string[] = [];
  const resolve = createNotificationProviderResolver({
    endpoints: new Endpoints([
      endpointRow({ provider_kind: 'webhook', channel: 'webhook', signing_secret_ref: 'env://HOOK' }),
      endpointRow({ id: 'sms-a', name: 'sms', provider_kind: 'sms_http', channel: 'sms',
        endpoint_url: 'https://sms.example.com/send', secret_ref: 'env://SMS' })
    ]),
    inbox,
    secrets: {
      async resolve(_ref, purpose) {
        purposes.push(purpose);
        return purpose === 'webhook_signing' ? 's'.repeat(32) : 't'.repeat(32);
      }
    },
    resolveAddress: async () => ['93.184.216.34']
  });

  const webhook = await resolve(deliveryRow(), notificationRow());
  assert.equal(webhook.kind, 'webhook');
  assert.equal(webhook.profile_id, 'endpoint-a');
  const sms = await resolve(deliveryRow({ id: 'sms-delivery', channel: 'sms', endpoint_id: 'sms-a' }),
    notificationRow({ channels: ['sms'] }));
  assert.equal(sms.kind, 'sms_http');
  assert.deepEqual(purposes, ['webhook_signing', 'provider_credential']);
});

test('notification provider resolver fails closed for missing, paused or mismatched endpoints', async () => {
  const base = {
    inbox,
    secrets: { async resolve() { return 's'.repeat(32); } }
  };
  await assert.rejects(
    createNotificationProviderResolver({ ...base, endpoints: new Endpoints([]) })(deliveryRow(), notificationRow()),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'provider_unavailable' && error.retryable
  );
  await assert.rejects(
    createNotificationProviderResolver({
      ...base, endpoints: new Endpoints([endpointRow({ status: 'paused' })])
    })(deliveryRow(), notificationRow()),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'provider_unavailable'
  );
  await assert.rejects(
    createNotificationProviderResolver({
      ...base, endpoints: new Endpoints([endpointRow({ channel: 'email', provider_kind: 'email_http' })])
    })(deliveryRow(), notificationRow()),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'validation_failed'
  );
});

test('environment notification secrets require an explicit purpose allowlist', async () => {
  const resolver = new EnvNotificationSecretResolver({
    env: { HOOK_SECRET: 'secret-value', EXTRA_SECRET: 'must-not-read' },
    allowlist: { webhook_signing: ['HOOK_SECRET'] }
  });
  assert.equal(await resolver.resolve('env://HOOK_SECRET', 'webhook_signing'), 'secret-value');
  await assert.rejects(
    resolver.resolve('env://EXTRA_SECRET', 'webhook_signing'),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'secret_ref_invalid'
  );
});

function endpointRow(overrides: Partial<NotificationEndpoint> = {}): NotificationEndpoint {
  return {
    id: 'endpoint-a', tenant_id: 'tenant-a', name: 'webhook', channel: 'webhook',
    provider_kind: 'webhook', status: 'active', endpoint_url: 'https://events.example.com/hook',
    secret_ref: '', signing_secret_ref: 'env://HOOK', event_allowlist: [], config: {},
    failover_group: 'default', priority: 100, quota_per_minute: null, quota_per_day: null,
    health_status: 'healthy', last_health_at: null, revision: 1, created_by: 'admin-a',
    idempotency_key: 'endpoint-create-a', payload_hash: 'e'.repeat(64),
    updated_by: 'admin-a', created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z', ...overrides
  };
}

function notificationRow(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: 'notification-a', tenant_id: 'tenant-a', event_type: 'example.created',
    recipient_kind: 'endpoint', recipient_ref: 'endpoint-a', channels: ['webhook'], locale: 'zh-CN',
    template_id: null, template_revision: null, content_ciphertext: 'ciphertext',
    content_projection: {}, priority: 'normal', force_delivery: false,
    business_ref_type: 'example', business_ref_id: 'example-a', requested_by: 'system',
    correlation_id: '', idempotency_key: 'notification-a', payload_hash: 'a'.repeat(64), policy: {},
    state: 'pending', scheduled_at: '2026-07-15T00:00:00.000Z', retention_until: null,
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    completed_at: null, ...overrides
  };
}

function deliveryRow(overrides: Partial<NotificationDeliveryRecord> = {}): NotificationDeliveryRecord {
  return {
    id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a', channel: 'webhook',
    endpoint_id: 'endpoint-a', provider_kind: 'unresolved', provider_profile_id: '',
    recipient_ciphertext: 'ciphertext', recipient_hmac: 'b'.repeat(64),
    recipient_redacted: 'https://events.example.com', payload_ciphertext: 'ciphertext',
    payload_hash: 'c'.repeat(64), provider_idempotency_key: `notify_${'d'.repeat(64)}`,
    state: 'processing', attempt_count: 1, max_attempts: 5, next_attempt_at: null,
    lease_token_hash: 'e'.repeat(64), lease_until: '2026-07-15T00:00:30.000Z', worker_id: 'worker-a',
    provider_request_id: '', provider_message_id: '', provider_receipt_projection: {}, error_code: '',
    error_projection: {}, created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z', accepted_at: null, delivered_at: null,
    completed_at: null, ...overrides
  };
}
