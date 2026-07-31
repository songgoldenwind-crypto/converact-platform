import assert from 'node:assert/strict';
import test from 'node:test';

import {
  notificationHealthWorkerConfig,
  probeNotificationEndpoint,
  runNotificationHealthBatch,
  type NotificationEndpoint,
  type NotificationEndpointHealthRepository,
  type NotificationEndpointProbeResult,
  type NotificationSecretResolver
} from '../src/agent-runtime/converact/notifications/index.js';

const secrets: NotificationSecretResolver = {
  async resolve() { return 'provider-credential-1234567890'; }
};

test('HTTP endpoint health probe authenticates, blocks SSRF and classifies provider status', async () => {
  let authorization = '';
  const healthy = await probeNotificationEndpoint(endpoint({
    channel: 'sms', provider_kind: 'sms_http', secret_ref: 'env://SMS_TOKEN'
  }), {
    secrets,
    resolveAddress: async () => ['8.8.8.8'],
    fetch: async (_url, init) => {
      authorization = String((init?.headers as Record<string, string>).authorization || '');
      return new Response(null, { status: 204 });
    }
  });
  assert.equal(healthy.outcome, 'healthy');
  assert.equal(authorization, 'Bearer provider-credential-1234567890');

  let fetched = false;
  const unsafe = await probeNotificationEndpoint(endpoint(), {
    secrets,
    resolveAddress: async () => ['127.0.0.1'],
    fetch: async () => {
      fetched = true;
      return new Response(null, { status: 204 });
    }
  });
  assert.deepEqual({ outcome: unsafe.outcome, code: unsafe.code }, {
    outcome: 'unhealthy', code: 'health_destination_unsafe'
  });
  assert.equal(fetched, false);

  const rejected = await probeNotificationEndpoint(endpoint(), {
    secrets,
    resolveAddress: async () => ['8.8.8.8'],
    fetch: async () => new Response('', { status: 503 })
  });
  assert.equal(rejected.outcome, 'unhealthy');
  assert.equal(rejected.code, 'health_provider_5xx');
});

test('SMTP health probe verifies credentials without sending a message', async () => {
  let captured = '';
  const result = await probeNotificationEndpoint(endpoint({
    channel: 'email', provider_kind: 'smtp', endpoint_url: '',
    secret_ref: 'env://SMTP_PASSWORD',
    config: {
      host: 'smtp.example.com', port: 587, user: 'mailer', from: 'mail@example.com',
      require_tls: true
    }
  }), {
    secrets,
    smtpVerify: async (_endpoint, credential) => {
      captured = credential;
      return true;
    }
  });
  assert.equal(result.outcome, 'healthy');
  assert.equal(captured, 'provider-credential-1234567890');
});

test('health batch uses leases, records every outcome and counts fencing losses', async () => {
  const finished: NotificationEndpointProbeResult[] = [];
  const repository: NotificationEndpointHealthRepository = {
    async listHealthTenants() { return ['tenant-a']; },
    async claimHealthEndpoints(input) {
      assert.match(input.lease_token_hash, /^[a-f0-9]{64}$/);
      return [endpoint(), endpoint({ id: 'endpoint-b' })];
    },
    async finishHealthProbe(input) { finished.push(input.result); }
  };
  const result = await runNotificationHealthBatch({
    repository,
    worker_id: 'worker-a',
    now: new Date('2026-07-15T00:00:00.000Z'),
    config: {
      enabled: true, interval_ms: 60_000, stale_ms: 300_000, lease_ms: 120_000,
      tenant_limit: 10, batch_size: 10, concurrency: 2
    },
    probe: async (value) => value.id === 'endpoint-a'
      ? { outcome: 'healthy', code: 'health_ok', latency_ms: 10 }
      : { outcome: 'degraded', code: 'health_request_failed', latency_ms: 20 }
  });
  assert.deepEqual(result, {
    tenants: 1, claimed: 2, healthy: 1, degraded: 1, unhealthy: 0, lease_lost: 0
  });
  assert.equal(finished.length, 2);
});

test('health worker configuration is explicit and bounded', () => {
  assert.equal(notificationHealthWorkerConfig({}).enabled, false);
  const config = notificationHealthWorkerConfig({
    OPC_IVEKIT_NOTIFICATION_HEALTH_WORKER_ENABLED: '1',
    OPC_IVEKIT_NOTIFICATION_HEALTH_BATCH_SIZE: '17',
    OPC_IVEKIT_NOTIFICATION_HEALTH_CONCURRENCY: '3'
  });
  assert.equal(config.enabled, true);
  assert.equal(config.batch_size, 17);
  assert.equal(config.concurrency, 3);
  assert.throws(() => notificationHealthWorkerConfig({
    OPC_IVEKIT_NOTIFICATION_HEALTH_CONCURRENCY: '100'
  }));
});

function endpoint(overrides: Partial<NotificationEndpoint> = {}): NotificationEndpoint {
  return {
    id: 'endpoint-a', tenant_id: 'tenant-a', name: 'Webhook', channel: 'webhook',
    provider_kind: 'webhook', status: 'active', endpoint_url: 'https://notify.example.com/health',
    secret_ref: '', signing_secret_ref: 'env://WEBHOOK_SECRET', event_allowlist: [], config: {},
    failover_group: 'default', priority: 100, quota_per_minute: null, quota_per_day: null,
    health_status: 'unknown', last_health_at: null, revision: 1,
    idempotency_key: 'endpoint-a', payload_hash: 'a'.repeat(64),
    created_by: 'admin-a', updated_by: 'admin-a', created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z', ...overrides
  };
}
