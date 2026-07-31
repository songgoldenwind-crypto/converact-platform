import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLiveKitMediaSmokeConfigFromEnv,
  runLiveKitMediaSmoke
} from '../scripts/livekit-media-smoke.js';

test('livekit media smoke drives the reusable media API with tenant-scoped resource calls', async () => {
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }> = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, query: url.searchParams, body });

    if (url.pathname === '/api/media/livekit/rooms' && method === 'POST') {
      return jsonResponse({ room_name: body.room_name, tenant_id: body.tenant_id, status: 'created' });
    }
    if (url.pathname === '/api/media/livekit/token' && method === 'GET') {
      return jsonResponse({ token: 'direct-token', room_name: url.searchParams.get('room_name') });
    }
    if (url.pathname === '/api/media/livekit/agent-dispatch' && method === 'POST') {
      return jsonResponse({ room_name: body.room_name, agent_name: body.agent_name, dispatched: false });
    }
    if (url.pathname === '/api/media/livekit/join' && method === 'GET' && url.searchParams.get('identity') === 'agent_smoke') {
      return jsonResponse({ mode: 'webrtc', token: 'agent-token' });
    }
    if (url.pathname === '/api/media/livekit/join' && method === 'GET' && url.searchParams.get('identity') === 'customer_smoke') {
      if (url.searchParams.get('room_name') === 'smoke-room' && url.searchParams.get('role') === 'customer') {
        return jsonResponse({ mode: 'webrtc', token: 'customer-token', joinPath: '/video?room=smoke-room' });
      }
    }
    if (url.pathname === '/api/media/livekit/recordings/start' && method === 'POST') {
      return jsonResponse({ id: 'recording-1', egress_id: 'egress-1', tenant_id: body.tenant_id });
    }
    if (url.pathname === '/api/media/livekit/recordings/recording-1' && method === 'GET') {
      return jsonResponse({ id: 'recording-1', tenant_id: url.searchParams.get('tenant_id') });
    }
    if (url.pathname === '/api/media/livekit/recordings/egress-1/stop' && method === 'POST') {
      return jsonResponse({ id: 'recording-1', egress_id: 'egress-1' });
    }
    if (url.pathname === '/api/media/livekit/rooms/smoke-room/participants' && method === 'GET') {
      return jsonResponse([]);
    }
    if (url.pathname === '/api/media/livekit/rooms/smoke-room/close' && method === 'POST') {
      return jsonResponse({ room_name: 'smoke-room', status: 'closed' });
    }
    if (url.pathname === '/api/media/livekit/join' && method === 'GET' && url.searchParams.get('identity') === 'customer_after_close') {
      return jsonResponse({ error: 'media room is closed' }, 409);
    }
    if (url.pathname === '/api/media/livekit/join' && method === 'GET' && url.searchParams.get('identity') === 'customer_after_close') {
      return jsonResponse({ error: 'media room is closed' }, 409);
    }
    return jsonResponse({ error: `unexpected ${method} ${url.pathname}` }, 500);
  };

  const result = await runLiveKitMediaSmoke(
    {
      baseUrl: 'http://opc.test',
      mediaApiToken: 'media-token',
      tenantId: 'tenant-smoke',
      roomName: 'smoke-room'
    },
    fetchImpl
  );

  assert.equal(result.roomName, 'smoke-room');
  assert.equal(result.recordingId, 'recording-1');
  assert.equal(result.egressId, 'egress-1');
  assert.equal(result.customerJoinPath, '/video?room=smoke-room');
  assert.deepEqual(result.steps.map((step) => step.name), [
    'create_room',
    'issue_token',
    'agent_dispatch',
    'agent_join',
    'customer_join',
    'start_recording',
    'fetch_recording',
    'stop_recording',
    'list_participants',
    'close_room',
    'closed_room_rejects_join'
  ]);

  const tenantScopedResourceCalls = calls.filter((call) =>
    call.path.includes('/rooms/smoke-room') || call.path.includes('/recordings/recording-1') || call.path.includes('/recordings/egress-1')
  );
  assert.equal(tenantScopedResourceCalls.length, 4);
  for (const call of tenantScopedResourceCalls) {
    assert.equal(call.query.get('tenant_id'), 'tenant-smoke');
  }
  const tokenCall = calls.find((call) => call.path === '/api/media/livekit/token');
  assert.equal(tokenCall?.query.get('tenant_id'), 'tenant-smoke');
  const dispatchCall = calls.find((call) => call.path === '/api/media/livekit/agent-dispatch');
  assert.equal((dispatchCall?.body as { tenant_id?: string })?.tenant_id, 'tenant-smoke');
});

test('livekit media smoke config requires a base URL token and tenant id', () => {
  assert.throws(
    () => createLiveKitMediaSmokeConfigFromEnv({}),
    /CONVERACT_BASE_URL/
  );
  assert.throws(
    () => createLiveKitMediaSmokeConfigFromEnv({ CONVERACT_BASE_URL: 'http://localhost:3000' }),
    /CONVERACT_MEDIA_API_TOKEN/
  );
  assert.throws(
    () =>
      createLiveKitMediaSmokeConfigFromEnv({
        CONVERACT_BASE_URL: 'http://localhost:3000',
        CONVERACT_MEDIA_API_TOKEN: 'token'
      }),
    /CONVERACT_MEDIA_SMOKE_TENANT_ID/
  );
});

test('livekit media smoke can wait for a readable recording object and export bytes', async () => {
  let objectChecks = 0;
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;

    if (url.pathname === '/api/media/livekit/rooms' && method === 'POST') {
      return jsonResponse({ room_name: body.room_name, tenant_id: body.tenant_id });
    }
    if (url.pathname === '/api/media/livekit/token') return jsonResponse({ token: 'token' });
    if (url.pathname === '/api/media/livekit/agent-dispatch') return jsonResponse({ dispatched: false });
    if (url.pathname === '/api/media/livekit/join') {
      return jsonResponse({ token: 'join-token', joinPath: '/video?room=smoke-room' });
    }
    if (url.pathname === '/api/media/livekit/recordings/start') {
      return jsonResponse({ id: 'recording-1', egress_id: 'egress-1' });
    }
    if (url.pathname === '/api/media/livekit/recordings/recording-1' && method === 'GET') {
      return jsonResponse({ id: 'recording-1' });
    }
    if (url.pathname === '/api/media/livekit/recordings/egress-1/stop') {
      return jsonResponse({ id: 'recording-1' });
    }
    if (url.pathname === '/api/media/livekit/recordings/recording-1/object') {
      objectChecks += 1;
      return jsonResponse(objectChecks === 1
        ? { status: 'not_found', readable: false }
        : { status: 'readable', readable: true, size_bytes: 16, checksum: 'sha256:test' });
    }
    if (url.pathname === '/api/media/livekit/recordings/recording-1/export') {
      return new Response(Buffer.from('recording-bytes'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' }
      });
    }
    if (url.pathname === '/api/media/livekit/rooms/smoke-room/participants') return jsonResponse([]);
    return jsonResponse({ error: `unexpected ${method} ${url.pathname}` }, 500);
  };

  const result = await runLiveKitMediaSmoke(
    {
      baseUrl: 'http://opc.test',
      mediaApiToken: 'media-token',
      tenantId: 'tenant-smoke',
      roomName: 'smoke-room',
      closeRoomOnExit: false,
      verifyRecordingObject: true,
      recordingObjectTimeoutMs: 100,
      recordingObjectPollIntervalMs: 1
    },
    fetchImpl
  );

  assert.equal(objectChecks, 2);
  assert.equal(result.recordingObjectStatus, 'readable');
  assert.equal(result.recordingExportBytes, Buffer.byteLength('recording-bytes'));
  assert.deepEqual(
    result.steps.slice(-3).map((step) => step.name),
    ['check_recording_object', 'export_recording', 'list_participants']
  );
});

test('livekit media smoke can keep the room open for a chained browser smoke', async () => {
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }> = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, query: url.searchParams, body });

    if (url.pathname === '/api/media/livekit/rooms' && method === 'POST') {
      return jsonResponse({ room_name: body.room_name, tenant_id: body.tenant_id, status: 'created' });
    }
    if (url.pathname === '/api/media/livekit/token' && method === 'GET') {
      return jsonResponse({ token: 'direct-token' });
    }
    if (url.pathname === '/api/media/livekit/agent-dispatch' && method === 'POST') {
      return jsonResponse({ dispatched: false });
    }
    if (url.pathname === '/api/media/livekit/join' && method === 'GET') {
      return jsonResponse({ mode: 'webrtc', token: 'join-token', joinPath: '/video?room=smoke-room' });
    }
    if (url.pathname === '/api/media/livekit/recordings/start' && method === 'POST') {
      return jsonResponse({ id: 'recording-1', egress_id: 'egress-1' });
    }
    if (url.pathname === '/api/media/livekit/recordings/recording-1' && method === 'GET') {
      return jsonResponse({ id: 'recording-1' });
    }
    if (url.pathname === '/api/media/livekit/recordings/egress-1/stop' && method === 'POST') {
      return jsonResponse({ id: 'recording-1', egress_id: 'egress-1' });
    }
    if (url.pathname === '/api/media/livekit/rooms/smoke-room/participants' && method === 'GET') {
      return jsonResponse([]);
    }
    return jsonResponse({ error: `unexpected ${method} ${url.pathname}` }, 500);
  };

  const config = createLiveKitMediaSmokeConfigFromEnv({
    CONVERACT_BASE_URL: 'http://opc.test',
    CONVERACT_MEDIA_API_TOKEN: 'media-token',
    CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-smoke',
    CONVERACT_MEDIA_SMOKE_ROOM_NAME: 'smoke-room',
    CONVERACT_MEDIA_SMOKE_KEEP_ROOM_OPEN: '1'
  });
  const result = await runLiveKitMediaSmoke(config, fetchImpl);

  assert.equal(result.closeRoomOnExit, false);
  assert.equal(result.customerJoinPath, '/video?room=smoke-room');
  assert.ok(!result.steps.some((step) => step.name === 'close_room'));
  assert.ok(!result.steps.some((step) => step.name === 'closed_room_rejects_join'));
  assert.ok(!calls.some((call) => call.path.endsWith('/close')));
});

test('livekit media smoke rejects dev tokens when configured LiveKit is required', async () => {
  const calls: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, query: url.searchParams });

    if (url.pathname === '/api/media/livekit/rooms' && method === 'POST') {
      return jsonResponse({ room_name: body.room_name, tenant_id: body.tenant_id, status: 'created' });
    }
    if (url.pathname === '/api/media/livekit/token' && method === 'GET') {
      return jsonResponse({
        token: 'dev-token:smoke-room:agent_token_smoke:agent',
        room_name: 'smoke-room',
        configured: false
      });
    }
    if (url.pathname === '/api/media/livekit/rooms/smoke-room/close' && method === 'POST') {
      return jsonResponse({ room_name: 'smoke-room', status: 'closed' });
    }
    if (url.pathname === '/api/media/livekit/join' && method === 'GET' && url.searchParams.get('identity') === 'customer_after_close') {
      return jsonResponse({ error: 'media room is closed' }, 409);
    }
    return jsonResponse({ error: `unexpected ${method} ${url.pathname}` }, 500);
  };

  await assert.rejects(
    () =>
      runLiveKitMediaSmoke(
        {
          baseUrl: 'http://opc.test',
          mediaApiToken: 'media-token',
          tenantId: 'tenant-smoke',
          roomName: 'smoke-room',
          requireConfiguredLiveKit: true
        },
        fetchImpl
      ),
    /issue_token returned an unconfigured LiveKit token/
  );
  const closeCall = calls.find((call) => call.path === '/api/media/livekit/rooms/smoke-room/close');
  assert.equal(closeCall?.method, 'POST');
  assert.equal(closeCall?.query.get('tenant_id'), 'tenant-smoke');
});

test('livekit media smoke rejects unsigned customer join paths when invite signing is configured', async () => {
  const calls: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, query: url.searchParams });

    if (url.pathname === '/api/media/livekit/rooms' && method === 'POST') {
      return jsonResponse({ room_name: body.room_name, tenant_id: body.tenant_id, status: 'created' });
    }
    if (url.pathname === '/api/media/livekit/token' && method === 'GET') {
      return jsonResponse({ token: 'real-token', configured: true });
    }
    if (url.pathname === '/api/media/livekit/agent-dispatch' && method === 'POST') {
      return jsonResponse({ dispatched: false });
    }
    if (url.pathname === '/api/media/livekit/join' && method === 'GET' && url.searchParams.get('identity') === 'agent_smoke') {
      return jsonResponse({ mode: 'webrtc', token: { token: 'agent-token', configured: true } });
    }
    if (url.pathname === '/api/media/livekit/join' && method === 'GET' && url.searchParams.get('identity') === 'customer_smoke') {
      return jsonResponse({
        mode: 'webrtc',
        token: { token: 'customer-token', configured: true },
        joinPath: '/video?room=smoke-room&tenant_id=tenant-smoke'
      });
    }
    if (url.pathname === '/api/media/livekit/recordings/start' && method === 'POST') {
      return jsonResponse({ id: 'recording-1', egress_id: 'egress-1' });
    }
    if (url.pathname === '/api/media/livekit/recordings/recording-1' && method === 'GET') {
      return jsonResponse({ id: 'recording-1' });
    }
    if (url.pathname === '/api/media/livekit/recordings/egress-1/stop' && method === 'POST') {
      return jsonResponse({ id: 'recording-1', egress_id: 'egress-1' });
    }
    if (url.pathname === '/api/media/livekit/rooms/smoke-room/participants' && method === 'GET') {
      return jsonResponse([]);
    }
    if (url.pathname === '/api/media/livekit/rooms/smoke-room/close' && method === 'POST') {
      return jsonResponse({ room_name: 'smoke-room', status: 'closed' });
    }
    if (url.pathname === '/api/media/livekit/join' && method === 'GET' && url.searchParams.get('identity') === 'customer_after_close') {
      return jsonResponse({ error: 'media room is closed' }, 409);
    }
    return jsonResponse({ error: `unexpected ${method} ${url.pathname}` }, 500);
  };

  const config = createLiveKitMediaSmokeConfigFromEnv({
    CONVERACT_BASE_URL: 'http://opc.test',
    CONVERACT_MEDIA_API_TOKEN: 'media-token',
    CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-smoke',
    CONVERACT_MEDIA_SMOKE_ROOM_NAME: 'smoke-room',
    CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret'
  });

  await assert.rejects(
    () => runLiveKitMediaSmoke(config, fetchImpl),
    /customer_join did not return a signed customer join path/
  );
  const closeCall = calls.find((call) => call.path === '/api/media/livekit/rooms/smoke-room/close');
  assert.equal(closeCall?.method, 'POST');
  assert.equal(closeCall?.query.get('tenant_id'), 'tenant-smoke');
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
