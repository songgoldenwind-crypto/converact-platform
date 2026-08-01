import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConveractFabricEventWebhookSubscriptionService,
  type ConveractFabricEventWebhookSubscriptionRepository
} from '../src/agent-runtime/converact/integration-events/subscription-service.js';
import type { ConveractFabricEventWebhookSubscription } from '../src/agent-runtime/converact/integration-events/types.js';
import type { NotificationEndpoint } from '../src/agent-runtime/converact/notifications/types.js';

test('event webhook subscription binds a webhook endpoint and normalizes patterns', async () => {
  const repository = new MemorySubscriptionRepository();
  const service = new ConveractFabricEventWebhookSubscriptionService({
    repository,
    endpoints: { getEndpoint: async () => webhookEndpoint() },
    id: () => 'subscription-1',
    now: () => new Date('2026-07-15T20:00:00.000Z')
  });
  const result = await service.create({
    tenant_id: 'tenant-1', actor: 'admin-1', endpoint_id: 'endpoint-1',
    name: 'LED backend', event_patterns: ['notification.*', 'ivekit.media.call.updated', 'notification.*'],
    idempotency_key: 'create-led-hook'
  });

  assert.equal(result.created, true);
  assert.deepEqual(result.subscription.event_patterns, ['ivekit.media.call.updated', 'notification.*']);
  assert.equal(result.subscription.status, 'active');
  assert.equal(result.subscription.last_event_id, '0');
  assert.match(result.subscription.payload_hash, /^[a-f0-9]{64}$/);
});

test('event webhook subscription rejects incompatible notification endpoints', async () => {
  const repository = new MemorySubscriptionRepository();
  const create = (endpoint: NotificationEndpoint | null) => new ConveractFabricEventWebhookSubscriptionService({
    repository,
    endpoints: { getEndpoint: async () => endpoint }
  }).create({
    tenant_id: 'tenant-1', actor: 'admin-1', endpoint_id: 'endpoint-1',
    name: 'LED backend', event_patterns: ['notification.*'], idempotency_key: 'create-led-hook'
  });

  await assert.rejects(() => create(null), (error: any) => error.status === 404);
  await assert.rejects(() => create({ ...webhookEndpoint(), channel: 'email' }), /webhook endpoint/i);
  await assert.rejects(() => create({
    ...webhookEndpoint(), event_allowlist: ['notification.created']
  }), /event allowlist/i);
});

class MemorySubscriptionRepository implements ConveractFabricEventWebhookSubscriptionRepository {
  item: ConveractFabricEventWebhookSubscription | null = null;

  async insert(subscription: ConveractFabricEventWebhookSubscription) {
    this.item = subscription;
    return { subscription, created: true };
  }

  async get() { return this.item; }
  async list() { return { items: this.item ? [this.item] : [], next_cursor: null }; }
  async update(subscription: ConveractFabricEventWebhookSubscription) {
    this.item = subscription;
    return subscription;
  }
}

function webhookEndpoint(): NotificationEndpoint {
  return {
    id: 'endpoint-1', tenant_id: 'tenant-1', name: 'LED events', channel: 'webhook',
    provider_kind: 'webhook', status: 'active', endpoint_url: 'https://led.example.com/converact-events',
    secret_ref: '', signing_secret_ref: 'env://LED_WEBHOOK_SECRET', event_allowlist: [], config: {},
    failover_group: 'default', priority: 100, quota_per_minute: null, quota_per_day: null,
    health_status: 'healthy', last_health_at: '2026-07-15T19:00:00.000Z', revision: 1,
    idempotency_key: 'endpoint-create', payload_hash: 'a'.repeat(64), created_by: 'admin-1',
    updated_by: 'admin-1', created_at: '2026-07-15T19:00:00.000Z',
    updated_at: '2026-07-15T19:00:00.000Z'
  };
}
