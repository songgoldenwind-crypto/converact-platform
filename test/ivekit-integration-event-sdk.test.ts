import assert from 'node:assert/strict';
import test from 'node:test';

import { createIveKitHttpSdk } from '../sdk/converact/src/http-sdk.js';

test('iveKit SDK exposes event catalog and webhook subscription administration', async () => {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const responses = [
    { schema_version: 1, families: [] },
    { created: true, subscription: subscription() },
    { items: [subscription()], next_cursor: null },
    { subscription: subscription() },
    { subscription: subscription({ status: 'paused', revision: 2 }) },
    { subscription: subscription({ status: 'archived', revision: 3 }) }
  ];
  const client = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com', tenantId: 'tenant-1', apiKey: 'server-key',
    fetch: async (input, init = {}) => {
      calls.push({
        url: String(input), method: init.method || 'GET', headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null
      });
      return Response.json(responses.shift());
    }
  });

  assert.equal((await client.events.getCatalog()).schema_version, 1);
  await client.events.createWebhookSubscription({
    endpoint_id: 'endpoint-1', name: 'LED events', event_patterns: ['notification.*']
  }, { idempotencyKey: 'create-led-events' });
  await client.events.listWebhookSubscriptions({ status: 'active', limit: 25 });
  await client.events.getWebhookSubscription('subscription-1');
  await client.events.updateWebhookSubscription('subscription-1', {
    expected_revision: 1, status: 'paused'
  }, { idempotencyKey: 'pause-led-events' });
  await client.events.archiveWebhookSubscription('subscription-1', {
    expected_revision: 2
  }, { idempotencyKey: 'archive-led-events' });

  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    'GET /api/ivekit/events/catalog',
    'POST /api/ivekit/events/webhook-subscriptions',
    'GET /api/ivekit/events/webhook-subscriptions',
    'GET /api/ivekit/events/webhook-subscriptions/subscription-1',
    'PUT /api/ivekit/events/webhook-subscriptions/subscription-1',
    'POST /api/ivekit/events/webhook-subscriptions/subscription-1/archive'
  ]);
  assert.equal(calls[1].headers.get('idempotency-key'), 'create-led-events');
  assert.equal(calls[4].headers.get('idempotency-key'), 'pause-led-events');
  assert.equal(calls[5].headers.get('idempotency-key'), 'archive-led-events');
  assert.equal(new URL(calls[2].url).search, '?status=active&limit=25');
});

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'subscription-1', endpoint_id: 'endpoint-1', name: 'LED events',
    event_patterns: ['notification.*'], status: 'active', last_event_id: '0',
    next_attempt_at: '2026-07-15T20:00:00.000Z', attempt_count: 0, error_code: '',
    revision: 1, created_by: 'admin-1', updated_by: 'admin-1',
    created_at: '2026-07-15T20:00:00.000Z', updated_at: '2026-07-15T20:00:00.000Z',
    ...overrides
  };
}
