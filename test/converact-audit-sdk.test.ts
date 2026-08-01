import assert from 'node:assert/strict';
import test from 'node:test';

import { createConveractFabricHttpSdk } from '../sdk/converact/src/http-sdk.js';
import { createConveractFabricClient } from '../sdk/converact/src/index.js';

test('Converact Fabric SDK exposes tenant audit query and JSONL export', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const sdk = createConveractFabricHttpSdk({
    baseUrl: 'https://converact.example/', tenantId: 'tenant-a', apiKey: 'key-a', userId: 'admin-a',
    fetch: async (request, init = {}) => {
      calls.push({ url: String(request), method: init.method || 'GET' });
      const isExport = String(request).includes('/export');
      return new Response(isExport ? '{"id":"audit-a"}\n' : '{"items":[],"next_cursor":null}', {
        status: 200,
        headers: { 'content-type': isExport ? 'application/x-ndjson' : 'application/json' }
      });
    }
  });

  assert.deepEqual(await sdk.audit.listEvents({
    action: 'notification.created', resource_type: 'notification', limit: 20
  }), { items: [], next_cursor: null });
  const exported = await sdk.audit.exportJsonl({ resource_id: 'notification/a', max_events: 200 });
  assert.equal(new TextDecoder().decode(exported.bytes), '{"id":"audit-a"}\n');
  assert.match(calls[0]!.url, /action=notification.created/);
  assert.match(calls[1]!.url, /resource_id=notification%2Fa/);
  assert.match(calls[1]!.url, /max_events=200/);
  assert.equal(typeof createConveractFabricClient({
    baseUrl: 'https://converact.example/', tenantId: 'tenant-a', accessToken: 'token-a',
    fetch: async () => new Response('{}', { status: 200 })
  }).audit.listEvents, 'function');
});
