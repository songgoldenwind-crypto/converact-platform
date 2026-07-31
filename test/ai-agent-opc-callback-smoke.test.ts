import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAiAgentOpcCallbackSmokeConfigFromEnv,
  runAiAgentOpcCallbackSmoke
} from '../scripts/ai-agent-opc-callback-smoke.js';

test('ai agent opc callback smoke validates legacy business dispatch with tenant context', async () => {
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body: unknown; headers: Headers }> = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const headers = new Headers(init.headers);
    calls.push({ method, path: url.pathname, query: url.searchParams, body, headers });

    if (url.pathname === '/api/livekit/rooms' && method === 'POST') {
      return jsonResponse({ room_name: body.room_name, tenant_id: body.tenant_id });
    }
    if (url.pathname === '/api/livekit/agent-dispatch' && method === 'POST') {
      return jsonResponse({ action_taken: 'no_seats_available' });
    }
    if (url.pathname === '/api/media/livekit/rooms/ai-callback-room/close' && method === 'POST') {
      return jsonResponse({ room_name: 'ai-callback-room', status: 'closed' });
    }
    return jsonResponse({ error: `unexpected ${method} ${url.pathname}` }, 500);
  };

  const result = await runAiAgentOpcCallbackSmoke(
    {
      baseUrl: 'http://opc.test',
      opcApiKey: 'opc-key',
      mediaApiToken: 'media-token',
      tenantId: 'tenant-smoke',
      roomName: 'ai-callback-room'
    },
    fetchImpl
  );

  assert.equal(result.roomName, 'ai-callback-room');
  assert.equal(result.actionTaken, 'no_seats_available');
  assert.deepEqual(result.steps.map((step) => step.name), [
    'create_legacy_room',
    'dispatch_transfer_to_human',
    'close_room'
  ]);

  const dispatchCall = calls.find((call) => call.path === '/api/livekit/agent-dispatch');
  assert.equal((dispatchCall?.body as { tenant_id?: string })?.tenant_id, 'tenant-smoke');
  assert.equal(dispatchCall?.headers.get('x-api-key'), 'opc-key');

  const cleanupCall = calls.find((call) => call.path.endsWith('/close'));
  assert.equal(cleanupCall?.query.get('tenant_id'), 'tenant-smoke');
  assert.equal(cleanupCall?.headers.get('authorization'), 'Bearer media-token');
});

test('ai agent opc callback smoke config requires base url api keys and tenant', () => {
  assert.throws(
    () => createAiAgentOpcCallbackSmokeConfigFromEnv({}),
    /CONVERACT_BASE_URL/
  );
  assert.throws(
    () => createAiAgentOpcCallbackSmokeConfigFromEnv({ CONVERACT_BASE_URL: 'http://localhost:3000' }),
    /CONVERACT_API_KEY/
  );
  assert.throws(
    () =>
      createAiAgentOpcCallbackSmokeConfigFromEnv({
        CONVERACT_BASE_URL: 'http://localhost:3000',
        CONVERACT_API_KEY: 'opc-key'
      }),
    /CONVERACT_MEDIA_API_TOKEN/
  );
  assert.throws(
    () =>
      createAiAgentOpcCallbackSmokeConfigFromEnv({
        CONVERACT_BASE_URL: 'http://localhost:3000',
        CONVERACT_API_KEY: 'opc-key',
        CONVERACT_MEDIA_API_TOKEN: 'media-token'
      }),
    /CONVERACT_AI_CALLBACK_SMOKE_TENANT_ID/
  );
});

test('ai agent opc callback smoke cleans up the legacy room when dispatch fails', async () => {
  const calls: Array<{ method: string; path: string; query: URLSearchParams; headers: Headers }> = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    calls.push({ method, path: url.pathname, query: url.searchParams, headers });

    if (url.pathname === '/api/livekit/rooms' && method === 'POST') {
      return jsonResponse({ room_name: 'ai-callback-fail-room', tenant_id: 'tenant-smoke' });
    }
    if (url.pathname === '/api/livekit/agent-dispatch' && method === 'POST') {
      return jsonResponse({ error: 'dispatch failed' }, 500);
    }
    if (url.pathname === '/api/media/livekit/rooms/ai-callback-fail-room/close' && method === 'POST') {
      return jsonResponse({ room_name: 'ai-callback-fail-room', status: 'closed' });
    }
    return jsonResponse({ error: `unexpected ${method} ${url.pathname}` }, 500);
  };

  await assert.rejects(
    () =>
      runAiAgentOpcCallbackSmoke(
        {
          baseUrl: 'http://opc.test',
          opcApiKey: 'opc-key',
          mediaApiToken: 'media-token',
          tenantId: 'tenant-smoke',
          roomName: 'ai-callback-fail-room'
        },
        fetchImpl
      ),
    /dispatch_transfer_to_human failed with 500/
  );

  const cleanupCall = calls.find((call) => call.path === '/api/media/livekit/rooms/ai-callback-fail-room/close');
  assert.equal(cleanupCall?.method, 'POST');
  assert.equal(cleanupCall?.query.get('tenant_id'), 'tenant-smoke');
  assert.equal(cleanupCall?.headers.get('authorization'), 'Bearer media-token');
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
