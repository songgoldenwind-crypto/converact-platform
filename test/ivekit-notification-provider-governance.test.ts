import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NotificationError,
  createNotificationProviderResolver,
  type NotificationDeliveryProvider,
  type NotificationEndpoint,
  type NotificationEndpointGovernanceRepository
} from '../src/agent-runtime/ivekit/notifications/index.js';

test('notification resolver skips circuit-open endpoints and uses the next healthy priority', async () => {
  const primary = endpointRow({ id: 'primary', priority: 10 });
  const fallback = endpointRow({ id: 'fallback', priority: 20 });
  const governed: string[] = [];
  const resolver = createNotificationProviderResolver({
    endpoints: endpoints([primary, fallback]),
    inbox: { async upsertInboxItem(item) { return item; } },
    secrets: { async resolve() { return 'token'; } },
    governance: {
      async reserveEndpoint(input) {
        return input.endpoint.id === 'primary'
          ? { allowed: false as const, reason: 'circuit_open' as const, retry_at: null }
          : { allowed: true as const, reason: null, retry_at: null };
      },
      async recordEndpointResult(input) { governed.push(`${input.endpoint.id}:${input.outcome}`); }
    },
    controlledFactory: async (endpoint) => provider(endpoint.id, 'delivered')
  });

  const selected = await resolver(deliveryRow(), notificationRow());
  assert.equal(selected.profile_id, 'fallback');
  assert.equal((await selected.deliver({
    delivery: deliveryRow(), notification: notificationRow(), recipient: 'user@example.com', payload: {}
  })).status, 'delivered');
  assert.deepEqual(governed, ['fallback:success']);
});

test('notification resolver reports quota exhaustion and records uncertain provider failures', async () => {
  const endpoint = endpointRow();
  const outcomes: string[] = [];
  const governance: NotificationEndpointGovernanceRepository = {
    async reserveEndpoint() {
      return { allowed: true, reason: null, retry_at: null };
    },
    async recordEndpointResult(input) { outcomes.push(input.outcome); }
  };
  const resolver = createNotificationProviderResolver({
    endpoints: endpoints([endpoint]),
    inbox: { async upsertInboxItem(item) { return item; } },
    secrets: { async resolve() { return 'token'; } },
    governance,
    controlledFactory: async (resolved) => provider(resolved.id, 'uncertain')
  });
  const selected = await resolver(deliveryRow(), notificationRow());
  await selected.deliver({
    delivery: deliveryRow(), notification: notificationRow(), recipient: 'user@example.com', payload: {}
  });
  assert.deepEqual(outcomes, ['failure']);

  governance.reserveEndpoint = async () => ({
    allowed: false, reason: 'quota_exhausted', retry_at: '2026-07-15T08:01:00.000Z'
  });
  await assert.rejects(
    resolver(deliveryRow(), notificationRow()),
    (error: unknown) => error instanceof NotificationError && error.code === 'quota_exhausted'
  );
});

test('notification resolver allows governance to half-open probe a stale unhealthy endpoint', async () => {
  const endpoint = endpointRow({ health_status: 'unhealthy' });
  const resolver = createNotificationProviderResolver({
    endpoints: endpoints([endpoint]),
    inbox: { async upsertInboxItem(item) { return item; } },
    secrets: { async resolve() { return 'token'; } },
    governance: {
      async reserveEndpoint() { return { allowed: true, reason: null, retry_at: null }; },
      async recordEndpointResult() {}
    },
    controlledFactory: async (resolved) => provider(resolved.id, 'delivered')
  });
  assert.equal((await resolver(deliveryRow(), notificationRow())).profile_id, endpoint.id);
});

function endpoints(items: NotificationEndpoint[]) {
  return {
    async getEndpoint(_tenantId: string, endpointId: string) {
      return items.find((item) => item.id === endpointId) || null;
    },
    async listActiveEndpoints() { return items; }
  };
}

function provider(profileId: string, status: 'delivered' | 'uncertain'): NotificationDeliveryProvider {
  return {
    kind: 'controlled', channel: 'email', profile_id: profileId,
    async deliver() { return { status }; }
  };
}

function endpointRow(overrides: Partial<NotificationEndpoint> = {}): NotificationEndpoint {
  return {
    id: 'endpoint-a', tenant_id: 'tenant-a', name: 'Email', channel: 'email',
    provider_kind: 'controlled', status: 'active', endpoint_url: '', secret_ref: '',
    signing_secret_ref: '', event_allowlist: [], config: {}, failover_group: 'default',
    priority: 100, quota_per_minute: null, quota_per_day: null, health_status: 'healthy',
    last_health_at: null, revision: 1, idempotency_key: 'endpoint-a', payload_hash: 'a'.repeat(64),
    created_by: 'admin-a', updated_by: 'admin-a', created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z', ...overrides
  };
}

function notificationRow(): any {
  return {
    id: 'notification-a', tenant_id: 'tenant-a', event_type: 'call.missed', channels: ['email']
  };
}

function deliveryRow(): any {
  return {
    id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a',
    channel: 'email', endpoint_id: null
  };
}
