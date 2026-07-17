import assert from 'node:assert/strict';
import test from 'node:test';

import { createIveKitHttpSdk } from '../sdk/ivekit/src/http-sdk.js';
import { createIveKitClient } from '../sdk/ivekit/src/index.js';

test('iveKit SDK exposes notification creation inbox templates preferences and endpoints', () => {
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example/', tenantId: 'tenant-a', apiKey: 'key-a',
    fetch: async () => new Response('{}', { status: 200 })
  });
  for (const method of [
    'getCapabilities', 'create', 'get', 'listInbox', 'countUnread', 'mutateInbox',
    'createEndpoint', 'getEndpoint', 'listEndpoints', 'updateEndpoint', 'testEndpoint',
    'archiveEndpoint', 'createTemplate', 'getTemplate', 'listTemplates',
    'listTemplateVersions', 'updateTemplate', 'publishTemplate', 'archiveTemplate',
    'getDelivery', 'listDeliveries', 'retryDelivery',
    'listPreferences', 'putPreference'
  ]) assert.equal(
    typeof sdk.notifications[method as keyof typeof sdk.notifications], 'function', method
  );
  assert.equal(typeof createIveKitClient({
    baseUrl: 'https://ivekit.example/', tenantId: 'tenant-a', accessToken: 'token-a',
    fetch: async () => new Response('{}', { status: 200 })
  }).notifications.create, 'function');
});

test('iveKit notification SDK preserves encoded paths, actor scope and idempotency headers', async () => {
  const calls: Array<{ url: string; method: string; headers: Headers; body: any }> = [];
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example/', tenantId: 'tenant-a', apiKey: 'key-a', userId: 'admin-a',
    fetch: async (request, init = {}) => {
      calls.push({
        url: String(request), method: init.method || 'GET', headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  await sdk.notifications.create({
    event_type: 'call.missed', recipient: { kind: 'user', ref: 'user-a' },
    targets: [{ channel: 'in_app', recipient: 'user-a' }], content: { title: 'Missed' },
    business_ref: { type: 'call', id: 'call-a' }
  }, { idempotencyKey: 'notification-a' });
  await sdk.notifications.mutateInbox('item/a', 'archive');
  await sdk.notifications.updateTemplate('template/a', {
    expected_revision: 1, locale: 'zh-CN', channels: ['in_app'], content: { title: '通知' }
  });
  await sdk.notifications.putPreference('call/missed', 'sms', {
    enabled: false, expected_revision: 0
  });
  await sdk.notifications.listEndpoints({
    channel: 'webhook', status: 'active', limit: 10, cursor: 'cursor/a'
  });
  await sdk.notifications.testEndpoint('endpoint/a', {
    event_type: 'endpoint.test', recipient: 'https://receiver.example.com/hook',
    content: { ping: true }
  }, { idempotencyKey: 'endpoint-test-a' });
  await sdk.notifications.archiveEndpoint('endpoint/a', 4);
  await sdk.notifications.listTemplates({ status: 'published', limit: 20 });
  await sdk.notifications.getTemplate('template/a');
  await sdk.notifications.listTemplateVersions('template/a', { locale: 'zh-CN', limit: 5 });
  await sdk.notifications.archiveTemplate('template/a', 3);
  await sdk.notifications.listDeliveries({
    notification_id: 'notification/a', channel: 'sms', state: 'failed', limit: 25
  });
  await sdk.notifications.getDelivery('delivery/a');
  await sdk.notifications.retryDelivery('delivery/a', {
    expected_state: 'failed', allow_uncertain: false
  });

  assert.equal(calls[0]!.headers.get('idempotency-key'), 'notification-a');
  assert.equal(calls[0]!.headers.get('x-tenant-id'), 'tenant-a');
  assert.match(calls[1]!.url, /inbox\/item%2Fa\/archive$/);
  assert.match(calls[2]!.url, /templates\/template%2Fa$/);
  assert.equal(calls[2]!.method, 'PUT');
  assert.match(calls[3]!.url, /preferences\/call%2Fmissed\/sms$/);
  const endpointList = calls.find((call) => call.url.includes('/endpoints?'))!;
  assert.match(endpointList.url, /channel=webhook/);
  assert.match(endpointList.url, /cursor=cursor%2Fa/);
  const endpointTest = calls.find((call) => call.url.endsWith('/endpoints/endpoint%2Fa/test'))!;
  assert.equal(endpointTest.headers.get('idempotency-key'), 'endpoint-test-a');
  const endpointArchive = calls.find((call) => call.url.endsWith('/endpoints/endpoint%2Fa/archive'))!;
  assert.deepEqual(endpointArchive.body, { expected_revision: 4 });
  const versions = calls.find((call) => call.url.includes('/templates/template%2Fa/versions?'))!;
  assert.match(versions.url, /locale=zh-CN/);
  const deliveryList = calls.find((call) => call.url.includes('/deliveries?'))!;
  assert.match(deliveryList.url, /notification_id=notification%2Fa/);
  const retry = calls.find((call) => call.url.endsWith('/deliveries/delivery%2Fa/retry'))!;
  assert.deepEqual(retry.body, { expected_state: 'failed', allow_uncertain: false });
});
