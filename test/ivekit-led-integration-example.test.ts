import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runIveKitLedExample } from '../scripts/ivekit-led-integration-example.js';

test('iveKit LED example executes the reusable media and chat sequence without exposing credentials', async () => {
  const calls: Array<{ method: string; path: string; headers: Headers; body: unknown }> = [];
  const responses = [
    { id: 'collab_led_1' },
    { id: 'participant_1', identity: 'agent_led' },
    { id: 'room_led_1', room_name: 'led-room-1' },
    { mode: 'webrtc', token: { token: 'secret-livekit-token' } },
    { message: { id: 'message_led_1' } }
  ];
  const result = await runIveKitLedExample({
    baseUrl: 'https://opc.example.com',
    apiKey: 'secret-opc-key',
    tenantId: 'tenant_led',
    userId: 'agent_led',
    businessRefType: 'service_order',
    businessRefId: 'SO-1001',
    roomName: 'led-room-1',
    fetch: async (input: string | URL, init: RequestInit = {}) => {
      calls.push({
        method: init.method || 'GET',
        path: `${new URL(String(input)).pathname}${new URL(String(input)).search}`,
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null
      });
      return new Response(JSON.stringify(responses.shift()), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'POST /api/ivekit/chat/sessions',
    'POST /api/ivekit/chat/sessions/collab_led_1/participants',
    'POST /api/ivekit/media/rooms',
    'POST /api/ivekit/media/rooms/led-room-1/join',
    'POST /api/ivekit/chat/sessions/collab_led_1/messages'
  ]);
  assert.equal(calls[4]?.headers.get('idempotency-key'), 'led:service_order:SO-1001:integration-probe');
  assert.deepEqual(result, {
    tenant_id: 'tenant_led',
    collaboration_session_id: 'collab_led_1',
    room_id: 'room_led_1',
    room_name: 'led-room-1',
    join_channel: 'webrtc',
    message_id: 'message_led_1',
    rustdesk: null
  });
  assert.equal(JSON.stringify(result).includes('secret-opc-key'), false);
  assert.equal(JSON.stringify(result).includes('secret-livekit-token'), false);
});
