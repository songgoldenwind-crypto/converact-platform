import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createConveractFabricHttpSdk } from '../sdk/converact/src/http-sdk.js';

test('Converact Fabric SDK exposes the complete IVR control plane with tenant auth and idempotency', async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(input), method: init.method || 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null
    });
    const path = new URL(String(input)).pathname;
    const body = path.endsWith('/versions') ? { items: [{ version: 1 }] }
      : path.endsWith('/publish') ? { replayed: false, flow: {}, version: {} }
        : path === '/api/ivekit/ivr/sessions' && init.method === 'GET' ? { items: [] }
          : { id: 'flow-a' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const sdk = createConveractFabricHttpSdk({
    baseUrl: 'https://converact.example/', tenantId: 'tenant-a', apiKey: 'api-key', fetch: fetchImpl
  });
  for (const method of [
    'listFlows', 'createFlow', 'getFlow', 'updateFlow', 'listVersions', 'validateFlow',
    'publishFlow', 'rollbackFlow', 'simulate', 'listSessions', 'startSession',
    'getSession', 'advanceSession', 'listAudioAssets', 'createAudioAsset', 'getAudioAsset',
    'updateAudioAsset', 'listTimeGroups', 'createTimeGroup', 'getTimeGroup', 'updateTimeGroup',
    'listRegionGroups', 'createRegionGroup', 'getRegionGroup', 'updateRegionGroup',
    'listRingGroups', 'createRingGroup', 'getRingGroup', 'updateRingGroup',
    'getSettings', 'updateSettings'
  ]) assert.equal(typeof sdk.ivr[method as keyof typeof sdk.ivr], 'function', method);

  await sdk.ivr.listVersions('flow/a');
  await sdk.ivr.publishFlow('flow-a', 2, { idempotencyKey: 'publish-key-a' });
  await sdk.ivr.listSessions({ limit: 25 });
  await sdk.ivr.updateAudioAsset('audio/a', { expected_revision: 2, name: 'Welcome' });
  await sdk.ivr.updateSettings({ expected_revision: 0, max_steps: 700 });
  assert.match(calls[0]!.url, /flow%2Fa\/versions$/);
  assert.equal(calls[1]!.headers['idempotency-key'], 'publish-key-a');
  assert.equal(calls[2]!.headers['x-tenant-id'], 'tenant-a');
  assert.match(calls[2]!.url, /limit=25/);
  assert.match(calls[3]!.url, /audio-assets\/audio%2Fa$/);
  assert.deepEqual(calls[4]!.body, { expected_revision: 0, max_steps: 700 });
});
