import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIveKitHttpSdk } from '../sdk/ivekit/src/http-sdk.js';
import { createIveKitClient } from '../sdk/ivekit/src/index.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

test('iveKit SDK exposes the complete Voice control plane', () => {
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example/',
    tenantId: 'tenant-a',
    apiKey: 'api-key',
    fetch: async () => new Response('{}', { status: 200 })
  });

  for (const method of [
    'getCapabilities',
    'listProfiles', 'createProfile', 'getProfile', 'updateProfile', 'preflightProfile',
    'listTrunks', 'createTrunk', 'getTrunk', 'updateTrunk', 'applyTrunk', 'testTrunk',
    'listDids', 'createDid', 'getDid', 'updateDid', 'applyDid',
    'listExtensions', 'createExtension', 'getExtension', 'updateExtension', 'applyExtension',
    'createExtensionSession',
    'listRoutes', 'createRoute', 'getRoute', 'updateRoute', 'validateRoute',
    'listRouteVersions', 'publishRoute',
    'listCalls', 'createOutboundCall', 'getCall', 'enqueueCallAction',
    'createLiveKitBridge', 'listCallEvents', 'listCallRecordings', 'listCallBridges',
    'listCallParticipants',
    'getPolicy', 'updatePolicy', 'listConsents', 'createConsent', 'listRecordings'
  ]) {
    assert.equal(typeof sdk.voice[method as keyof typeof sdk.voice], 'function', method);
  }
});

test('iveKit Voice client preserves paths, filters, request bodies, and idempotency keys', async () => {
  const calls: CapturedRequest[] = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method || 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null
    });
    const path = new URL(String(input)).pathname;
    const data = path.endsWith('/session')
      ? {
          session_id: 'session-a', extension_id: 'extension/a', transport: 'wss',
          websocket_url: 'wss://pbx.example/ws', address_of_record: 'sip:1001@pbx.example',
          authorization_username: 'session-a', authorization_password: 'ephemeral-secret',
          expires_at: '2099-07-13T09:05:00.000Z', register_expires_seconds: 300,
          ice_servers: [], capabilities: {
            incoming: true, outgoing: true, dtmf: true, hold: true, transfer: false,
            audio_input: true, audio_output: true
          }
        }
      : path.endsWith('/versions') || path.endsWith('/events') ||
        path.endsWith('/recordings') || path.endsWith('/bridges') ||
        path.endsWith('/participants') || path === '/api/ivekit/voice/calls'
        ? { items: [], next_cursor: null }
        : {};
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example/',
    tenantId: 'tenant-a',
    apiKey: 'api-key',
    userId: 'operator-a',
    fetch: fetchImpl
  });

  await sdk.voice.getProfile('profile/a');
  await sdk.voice.listCalls({
    cursor: 'cursor-a',
    limit: 25,
    state: 'active',
    business_ref: { type: 'service_order', id: 'order-1001' }
  });
  await sdk.voice.createOutboundCall({
    profile_id: 'profile-a',
    from: { kind: 'extension', value: '1001' },
    to: { kind: 'e164', value: '+8613800138000' },
    business_ref: { type: 'service_order', id: 'order-1001' },
    metadata: { source: 'webphone' }
  }, { idempotencyKey: 'outbound-key-a' });
  await sdk.voice.enqueueCallAction('call/a', {
    action: 'dtmf',
    payload: { digits: '123#' }
  }, { idempotencyKey: 'dtmf-key-a' });
  await sdk.voice.publishRoute('route/a', { revision: 3 }, { idempotencyKey: 'publish-key-a' });
  await sdk.voice.createExtensionSession('extension/a', { idempotencyKey: 'session-key-a' });
  await sdk.voice.listRecordings({ call_id: 'call-a', status: 'available', limit: 10 });

  assert.match(calls[0]!.url, /profiles\/profile%2Fa$/);
  assert.match(calls[1]!.url, /cursor=cursor-a/);
  assert.match(calls[1]!.url, /limit=25/);
  assert.match(calls[1]!.url, /state=active/);
  assert.match(calls[1]!.url, /business_ref_type=service_order/);
  assert.match(calls[1]!.url, /business_ref_id=order-1001/);
  assert.equal(calls[2]!.headers['idempotency-key'], 'outbound-key-a');
  assert.equal(calls[2]!.headers['x-tenant-id'], 'tenant-a');
  assert.equal(calls[2]!.headers['x-user-id'], 'operator-a');
  assert.deepEqual(calls[3]!.body, { action: 'dtmf', payload: { digits: '123#' } });
  assert.match(calls[3]!.url, /calls\/call%2Fa\/actions$/);
  assert.equal(calls[3]!.headers['idempotency-key'], 'dtmf-key-a');
  assert.deepEqual(calls[4]!.body, { revision: 3 });
  assert.equal(calls[4]!.headers['idempotency-key'], 'publish-key-a');
  assert.match(calls[5]!.url, /extensions\/extension%2Fa\/session$/);
  assert.equal(calls[5]!.headers['idempotency-key'], 'session-key-a');
  assert.match(calls[6]!.url, /call_id=call-a/);
  assert.match(calls[6]!.url, /status=available/);
});

test('unified iveKit client includes Voice without coupling RustDesk lifecycle', () => {
  const sdk = createIveKitClient({
    baseUrl: 'https://ivekit.example/',
    tenantId: 'tenant-a',
    accessToken: 'short-lived-token',
    fetch: async () => new Response('{}', { status: 200 })
  });

  assert.equal(typeof sdk.voice.createOutboundCall, 'function');
  assert.equal(typeof sdk.rustdesk.startSession, 'function');
});
