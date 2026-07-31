import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NotificationEndpointService,
  NotificationError,
  type NotificationEndpoint,
  type NotificationEndpointAdminRepository,
  type NotificationEndpointCreateResult
} from '../src/agent-runtime/converact/notifications/index.js';

class EndpointRepository implements NotificationEndpointAdminRepository {
  readonly items: NotificationEndpoint[] = [];
  async getEndpoint(tenantId: string, endpointId: string) {
    return this.items.find((item) => item.tenant_id === tenantId && item.id === endpointId) || null;
  }
  async listActiveEndpoints(tenantId: string, channel: 'webhook' | 'email' | 'sms') {
    return this.items.filter((item) => item.tenant_id === tenantId && item.channel === channel);
  }
  async insertEndpoint(endpoint: NotificationEndpoint): Promise<NotificationEndpointCreateResult> {
    const found = this.items.find((item) => item.tenant_id === endpoint.tenant_id
      && item.idempotency_key === endpoint.idempotency_key);
    if (found) {
      if (found.payload_hash !== endpoint.payload_hash) {
        throw new NotificationError({ code: 'idempotency_conflict', status: 409 });
      }
      return { endpoint: found, created: false };
    }
    this.items.push(endpoint);
    return { endpoint, created: true };
  }
  async updateEndpoint(endpoint: NotificationEndpoint, expectedRevision: number) {
    const index = this.items.findIndex((item) => item.tenant_id === endpoint.tenant_id
      && item.id === endpoint.id && item.revision === expectedRevision);
    if (index < 0) throw new NotificationError({ code: 'revision_conflict', status: 409 });
    this.items[index] = { ...endpoint, revision: expectedRevision + 1 };
    return this.items[index];
  }
}

function service(repository = new EndpointRepository()) {
  let id = 0;
  return {
    repository,
    service: new NotificationEndpointService({
      repository,
      id: () => `endpoint-${++id}`,
      now: () => new Date('2026-07-15T00:00:00.000Z')
    })
  };
}

test('notification endpoint service creates idempotent webhook and HTTP provider profiles', async () => {
  const { service: endpoints, repository } = service();
  const input = {
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Security webhook',
    channel: 'webhook' as const, provider_kind: 'webhook' as const,
    endpoint_url: 'https://events.example.com/ivekit', signing_secret_ref: 'env://HOOK_SECRET',
    event_allowlist: ['security.alert'], idempotency_key: 'endpoint-security-webhook'
  };
  const first = await endpoints.create(input);
  const replay = await endpoints.create(input);

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(repository.items.length, 1);
  assert.equal(first.endpoint.channel, 'webhook');
  assert.equal(first.endpoint.status, 'active');
  assert.match(first.endpoint.payload_hash, /^[a-f0-9]{64}$/);
});

test('notification endpoint service rejects channel mismatches, unsafe config secrets and insecure URLs', async () => {
  const { service: endpoints } = service();
  const base = {
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'Provider',
    channel: 'sms' as const, provider_kind: 'sms_http' as const,
    endpoint_url: 'https://sms.example.com/send', secret_ref: 'env://SMS_TOKEN',
    idempotency_key: 'endpoint-sms'
  };
  await assert.rejects(
    endpoints.create({ ...base, provider_kind: 'email_http' }),
    (error: unknown) => error instanceof NotificationError && error.code === 'validation_failed'
  );
  await assert.rejects(
    endpoints.create({ ...base, config: { token: 'plaintext-secret' } }),
    (error: unknown) => error instanceof NotificationError && error.code === 'validation_failed'
  );
  await assert.rejects(
    endpoints.create({ ...base, endpoint_url: 'http://sms.example.com/send' }),
    (error: unknown) => error instanceof NotificationError && error.code === 'validation_failed'
  );
});

test('notification endpoint service updates with revision fencing and reopens health after config changes', async () => {
  const { service: endpoints } = service();
  const created = await endpoints.create({
    tenant_id: 'tenant-a', actor: 'admin-a', name: 'SMTP', channel: 'email',
    provider_kind: 'smtp', secret_ref: 'env://SMTP_PASSWORD',
    config: { host: 'smtp.example.com', port: 587, user: 'mailer', from: 'notice@example.com', require_tls: true },
    idempotency_key: 'endpoint-smtp'
  });
  const updated = await endpoints.update({
    tenant_id: 'tenant-a', endpoint_id: created.endpoint.id, actor: 'admin-b', expected_revision: 1,
    patch: { config: { host: 'smtp2.example.com', port: 587, user: 'mailer', from: 'notice@example.com', require_tls: true } }
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.health_status, 'unknown');
  assert.equal(updated.last_health_at, null);
  assert.equal(updated.updated_by, 'admin-b');
});
