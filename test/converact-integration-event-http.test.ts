import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  routeConveractFabricEventApi,
  type ConveractFabricEventHttpModule
} from '../src/agent-runtime/converact/event-http.js';
import { signAccessToken } from '../src/middleware/auth.js';

test('event HTTP exposes the catalog and admin subscription lifecycle', async () => {
  process.env.CONVERACT_JWT_SECRET = 'converact-integration-events-secret';
  const calls: Array<{ name: string; input: any }> = [];
  const limits: any[] = [];
  const audits: any[] = [];
  const module = moduleFixture(calls);
  const headers = authHeaders('admin');
  const options: any = {
    module,
    rateLimiter: { check: async (input: any) => {
      limits.push(input);
      return { allowed: true, retry_after_seconds: 0, denied_scope: null };
    } },
    audit: { append: async (input: any) => {
      audits.push(input);
      return { event: {}, created: true };
    } }
  };

  const catalog = await routeConveractFabricEventApi(
    null, 'GET', '/api/ivekit/events/catalog',
    new URL('http://localhost/api/ivekit/events/catalog'), headers, undefined, options
  ) as any;
  assert.equal(catalog.data.schema_version, 1);
  assert.equal(catalog.data.families.length, 8);

  const created = await routeConveractFabricEventApi(
    null, 'POST', '/api/ivekit/events/webhook-subscriptions',
    new URL('http://localhost/api/ivekit/events/webhook-subscriptions'),
    { ...headers, 'idempotency-key': 'create-led-hook' },
    { endpoint_id: 'endpoint-1', name: 'LED', event_patterns: ['notification.*'] }, options
  ) as any;
  assert.equal(created.status, 201);
  assert.equal(calls[0].input.tenant_id, 'tenant-1');
  assert.equal(calls[0].input.actor, 'user-1');
  assert.equal(calls[0].input.idempotency_key, 'create-led-hook');

  const updated = await routeConveractFabricEventApi(
    null, 'PUT', '/api/ivekit/events/webhook-subscriptions/subscription-1',
    new URL('http://localhost/api/ivekit/events/webhook-subscriptions/subscription-1'),
    { ...headers, 'idempotency-key': 'update-led-hook' },
    { expected_revision: 1, event_patterns: ['ivekit.media.*'], status: 'paused' }, options
  ) as any;
  assert.equal(updated.data.subscription.status, 'paused');

  const archived = await routeConveractFabricEventApi(
    null, 'POST', '/api/ivekit/events/webhook-subscriptions/subscription-1/archive',
    new URL('http://localhost/api/ivekit/events/webhook-subscriptions/subscription-1/archive'),
    { ...headers, 'idempotency-key': 'archive-led-hook' },
    { expected_revision: 2 }, options
  ) as any;
  assert.equal(archived.data.subscription.status, 'archived');
  assert.deepEqual(limits.map((entry) => entry.route_group), [
    'event.webhook_subscription.mutate',
    'event.webhook_subscription.mutate',
    'event.webhook_subscription.mutate'
  ]);
  assert.deepEqual(audits.map((entry) => entry.action), [
    'event.webhook_subscription.create',
    'event.webhook_subscription.update',
    'event.webhook_subscription.archive'
  ]);
  assert.equal(audits.every((entry) => entry.metadata.signing_secret === undefined), true);
});

test('event subscription administration denies non-admin identities', async () => {
  process.env.CONVERACT_JWT_SECRET = 'converact-integration-events-secret';
  await assert.rejects(() => routeConveractFabricEventApi(
    null, 'GET', '/api/ivekit/events/webhook-subscriptions',
    new URL('http://localhost/api/ivekit/events/webhook-subscriptions'),
    authHeaders('operator'), undefined, { module: moduleFixture([]) }
  ), (error: any) => error.status === 403);
});

test('Converact embedded HTTP entrypoint forwards safe event administration context', () => {
  const source = readFileSync('src/http.ts', 'utf8');
  assert.match(source, /routeConveractFabricEventApi\(pg, method, path, url, headers, body\)/);
  assert.match(source, /'x-opc-source-ip': req\.socket\.remoteAddress \|\| ''/);
  assert.match(source, /'retry-after': retryAfterSeconds/);
});

function moduleFixture(calls: Array<{ name: string; input: any }>): ConveractFabricEventHttpModule {
  return {
    createSubscription: async (input) => {
      calls.push({ name: 'create', input });
      return { subscription: subscription(), created: true };
    },
    getSubscription: async () => subscription(),
    listSubscriptions: async () => ({ items: [subscription()], next_cursor: null }),
    updateSubscription: async (input) => {
      calls.push({ name: 'update', input });
      return subscription({ status: input.patch.status || 'active', revision: 2 });
    },
    archiveSubscription: async (input) => {
      calls.push({ name: 'archive', input });
      return subscription({ status: 'archived', revision: 3 });
    }
  };
}

function subscription(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'subscription-1', tenant_id: 'tenant-1', endpoint_id: 'endpoint-1', name: 'LED',
    event_patterns: ['notification.*'], status: 'active', last_event_id: '0',
    next_attempt_at: '2026-07-15T20:00:00.000Z', attempt_count: 0, error_code: '',
    revision: 1, created_by: 'user-1', updated_by: 'user-1',
    created_at: '2026-07-15T20:00:00.000Z', updated_at: '2026-07-15T20:00:00.000Z',
    ...overrides
  };
}

function authHeaders(role: 'admin' | 'operator'): Record<string, string> {
  const token = signAccessToken({ sub: 'user-1', tid: 'tenant-1', role });
  return { authorization: `Bearer ${token}` };
}
