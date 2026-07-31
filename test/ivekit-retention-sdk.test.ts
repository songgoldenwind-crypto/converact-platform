import assert from 'node:assert/strict';
import test from 'node:test';

import { createIveKitHttpSdk } from '../sdk/converact/src/http-sdk.js';
import { createIveKitClient } from '../sdk/converact/src/index.js';

test('iveKit SDK exposes retention policies and legal holds with encoded paths', async () => {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example/', tenantId: 'tenant-a', apiKey: 'key-a', userId: 'admin-a',
    fetch: async (request, init = {}) => {
      calls.push({ url: String(request), method: init.method || 'GET', headers: new Headers(init.headers) });
      if (String(request).includes('/legal-holds')) {
        return new Response('{"legal_hold":{},"created":true}', { status: 200 });
      }
      return new Response('{"policy":{}}', { status: 200 });
    }
  });
  await sdk.retention.putPolicy('audit', {
    enabled: true, retention_days: 365, batch_size: 100,
    interval_seconds: 3600, expected_revision: 0
  });
  await sdk.retention.placeLegalHold({
    category: 'audit', resource_type: 'audit_event', resource_id: 'audit/a',
    reason_code: 'legal_case'
  }, { idempotencyKey: 'hold-a' });
  await sdk.retention.releaseLegalHold('hold/a');
  assert.match(calls[0]!.url, /policies\/audit$/);
  assert.equal(calls[1]!.headers.get('idempotency-key'), 'hold-a');
  assert.match(calls[2]!.url, /legal-holds\/hold%2Fa\/release$/);
  assert.equal(typeof createIveKitClient({
    baseUrl: 'https://ivekit.example/', tenantId: 'tenant-a', accessToken: 'token-a',
    fetch: async () => new Response('{}', { status: 200 })
  }).retention.listPolicies, 'function');
});
