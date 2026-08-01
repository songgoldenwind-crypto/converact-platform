import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  integrationEventWebhookWorkerConfig,
  projectConveractFabricIntegrationEvent,
  runConveractFabricEventWebhookBatch
} from '../src/agent-runtime/converact/integration-events/worker.js';
import { startConveractFabricApplication } from '../src/agent-runtime/converact/application.js';
import { converactFabricRuntimeComponents } from '../src/agent-runtime/converact/operations/runtime-heartbeat.js';
import { MemoryPg } from '../src/db-pg.js';
import { integrationEventMetricDefinitions } from '../src/agent-runtime/converact/integration-events/metrics.js';
import type {
  ConveractFabricEventWebhookSubscription,
  ConveractFabricStoredIntegrationEvent
} from '../src/agent-runtime/converact/integration-events/types.js';

test('event webhook batch projects matching events and advances over filtered events', async () => {
  const completed: string[] = [];
  const projected: string[] = [];
  const repository = repositoryFixture({
    completeClaim: async (input: any) => {
      completed.push(input.last_event_id);
      return subscription({ last_event_id: input.last_event_id });
    }
  });

  const summary = await runConveractFabricEventWebhookBatch({
    repository,
    config: config(),
    worker_id: 'worker-1',
    now: new Date('2026-07-15T20:00:00.000Z'),
    project: async (_subscription, event) => { projected.push(event.id); }
  });

  assert.deepEqual(projected, ['41']);
  assert.deepEqual(completed, ['42']);
  assert.deepEqual(summary, {
    tenants: 1, claimed: 1, scanned: 2, projected: 1, filtered: 1,
    failed: 0, lease_lost: 0, oldest_event_age_seconds: 0
  });
});

test('event webhook batch releases a failed claim with bounded retry', async () => {
  const failed: any[] = [];
  const repository = repositoryFixture({
    failClaim: async (input: any) => {
      failed.push(input);
      return subscription();
    }
  });
  const summary = await runConveractFabricEventWebhookBatch({
    repository, config: config(), worker_id: 'worker-1',
    now: new Date('2026-07-15T20:00:00.000Z'),
    project: async () => { throw Object.assign(new Error('private detail'), { code: 'provider_down' }); }
  });
  assert.equal(summary.failed, 1);
  assert.equal(failed[0].error_code, 'provider_down');
  assert.equal(failed[0].retry_at.toISOString(), '2026-07-15T20:00:05.000Z');
});

test('integration event projection is versioned and extracts only explicit business refs', () => {
  const envelope = projectConveractFabricIntegrationEvent(event({
    payload: { business_ref: { type: 'service_order', id: 'SO-1' }, secret: 'not-added-by-projector' }
  }));
  assert.equal(envelope.schema_version, 1);
  assert.deepEqual(envelope.business_ref, { type: 'service_order', id: 'SO-1' });
  assert.deepEqual(envelope.visibility, { scope: 'tenant', ref_id: '', audience_user_ids: [] });
  assert.equal((envelope.data as any).secret, 'not-added-by-projector');
  assert.equal(projectConveractFabricIntegrationEvent(event({ payload: { business_ref: { type: '', id: 'SO-1' } } })).business_ref, null);
});

test('event webhook worker is opt-in and requires the notification delivery runtime', () => {
  assert.equal(integrationEventWebhookWorkerConfig({}).enabled, false);
  assert.throws(() => integrationEventWebhookWorkerConfig({
    CONVERACT_FABRIC_EVENT_WEBHOOK_WORKER_ENABLED: '1'
  }), /notification delivery/i);
  assert.equal(integrationEventWebhookWorkerConfig({
    CONVERACT_FABRIC_EVENT_WEBHOOK_WORKER_ENABLED: '1',
    CONVERACT_FABRIC_NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    CONVERACT_FABRIC_NOTIFICATION_HMAC_KEY: Buffer.alloc(32, 2).toString('base64'),
    CONVERACT_FABRIC_NOTIFICATION_WORKER_ENABLED: '1'
  }).enabled, true);
});

test('application owns event webhook lifecycle after notification delivery', async () => {
  const events: string[] = [];
  const env = {
    CONVERACT_FABRIC_EVENT_WEBHOOK_WORKER_ENABLED: '1',
    CONVERACT_FABRIC_NOTIFICATION_WORKER_ENABLED: '1',
    CONVERACT_FABRIC_NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    CONVERACT_FABRIC_NOTIFICATION_HMAC_KEY: Buffer.alloc(32, 2).toString('base64')
  };
  const application = startConveractFabricApplication({
    pg: new MemoryPg(), env,
    adapters: {
      startNotification: () => {
        events.push('start:notification');
        return { async stop() { events.push('stop:notification'); } };
      },
      startEventWebhook: () => {
        events.push('start:event-webhook');
        return { async stop() { events.push('stop:event-webhook'); } };
      }
    }
  });
  await application.stop();
  assert.deepEqual(events, [
    'start:notification', 'start:event-webhook',
    'stop:event-webhook', 'stop:notification'
  ]);
  assert.ok(converactFabricRuntimeComponents(env).includes('event_webhook_worker'));
});

test('event webhook metrics expose only bounded result labels', () => {
  assert.deepEqual(integrationEventMetricDefinitions, [
    { name: 'opc_ivekit_event_webhook_operations_total', labels: ['result'] },
    { name: 'opc_ivekit_event_webhook_oldest_event_age_seconds', labels: [] }
  ]);
});

test('event webhook worker configuration is present in every delivery surface', () => {
  for (const file of [
    '.env.example', 'infra/env.example', 'infra/converact/env.example',
    'services/converact-service/env.example'
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /^CONVERACT_FABRIC_EVENT_WEBHOOK_WORKER_ENABLED=0$/m, file);
    assert.match(source, /^CONVERACT_FABRIC_EVENT_WEBHOOK_LEASE_MS=120000$/m, file);
    assert.match(source, /^CONVERACT_FABRIC_RATE_LIMIT_EVENT_WEBHOOK_ACTOR_PER_MINUTE=30$/m, file);
  }
  for (const file of [
    'infra/docker-compose.production.yml', 'infra/converact/docker-compose.yml',
    'services/converact-service/docker-compose.yml',
    'services/converact-service/helm/converact/values.yaml'
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /CONVERACT_FABRIC_EVENT_WEBHOOK_WORKER_ENABLED/, file);
    assert.match(source, /CONVERACT_FABRIC_EVENT_WEBHOOK_EVENT_BATCH_SIZE/, file);
    assert.match(source, /CONVERACT_FABRIC_RATE_LIMIT_EVENT_WEBHOOK_SOURCE_IP_PER_MINUTE/, file);
  }
});

function repositoryFixture(overrides: Record<string, unknown> = {}): any {
  return {
    listWorkerTenants: async () => ['tenant-1'],
    claimDue: async () => [subscription()],
    listEvents: async () => [event(), event({ id: '42', event_type: 'ivekit.media.call.updated' })],
    completeClaim: async () => subscription({ last_event_id: '42' }),
    failClaim: async () => subscription(),
    ...overrides
  };
}

function config() {
  return {
    enabled: true, interval_ms: 5_000, tenant_limit: 10, subscription_limit: 5,
    event_batch_size: 20, lease_ms: 60_000, retry_delays_ms: [5_000, 30_000]
  };
}

function subscription(overrides: Partial<ConveractFabricEventWebhookSubscription> = {}): ConveractFabricEventWebhookSubscription {
  return {
    id: 'subscription-1', tenant_id: 'tenant-1', endpoint_id: 'endpoint-1', name: 'LED events',
    event_patterns: ['notification.*'], status: 'active', last_event_id: '40',
    next_attempt_at: '2026-07-15T20:00:00.000Z', attempt_count: 1,
    error_code: '', lease_token_hash: 'b'.repeat(64),
    lease_until: '2026-07-15T20:01:00.000Z', worker_id: 'worker-1', revision: 1,
    idempotency_key: 'create-led-events', payload_hash: 'a'.repeat(64),
    created_by: 'admin-1', updated_by: 'admin-1', created_at: '2026-07-15T20:00:00.000Z',
    updated_at: '2026-07-15T20:00:00.000Z', ...overrides
  };
}

function event(overrides: Partial<ConveractFabricStoredIntegrationEvent> = {}): ConveractFabricStoredIntegrationEvent {
  return {
    id: '41', tenant_id: 'tenant-1', event_type: 'notification.created',
    visibility_scope: 'tenant', visibility_ref_id: '', audience_user_ids: [],
    payload: { notification_id: 'notification-1' }, occurred_at: '2026-07-15T20:00:01.000Z',
    expires_at: '2026-07-16T20:00:01.000Z', ...overrides
  };
}
