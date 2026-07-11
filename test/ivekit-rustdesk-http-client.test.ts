import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIveKitRustDeskHttpClient,
  IveKitRustDeskHttpError
} from '../src/agent-runtime/ivekit/index.js';

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

test('iveKit RustDesk HTTP client calls the reusable facade lifecycle', async () => {
  const calls: FetchCall[] = [];
  const responses = [
    { id_server: 'rustdesk-id.example.com' },
    {
      id: 'rdesk_1',
      rustdesk_id: '123456789',
      display_name: 'LED controller'
    },
    { id: 'rdesk_1', rustdesk_id: '123456789' },
    [{ id: 'rdesk_1', rustdesk_id: '123456789' }],
    { id: 'rdesk_1', runtime_status: 'online' },
    {
      id: 'tool_1',
      provider: 'rustdesk',
      external_id: 'rdgw_1',
      launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_1'
    },
    { external_id: 'rdgw_1', status: 'active' },
    { event: { id: 'evt_1', event_type: 'remote.rustdesk.control_action.performed' } },
    { events: [{ id: 'evt_1', event_type: 'remote.rustdesk.control_action.performed' }] },
    { id: 'rdesk_1', status: 'inactive' },
    null,
    {
      required: true,
      status: 'pending',
      command: {
        id: 'rdcmd_1',
        external_id: 'rdgw_1',
        status: 'pending',
        requested_reason: 'gateway_ended'
      }
    }
  ];
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    const headers = headersToRecord(init.headers);
    calls.push({
      url: String(input),
      method: init.method || 'GET',
      headers,
      body: init.body ? JSON.parse(String(init.body)) : null
    });
    const body = responses.shift();
    return jsonResponse(body === null ? 204 : 200, body);
  };
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com/root/',
    apiKey: 'opc-api-key',
    tenantId: 'tenant_led',
    userId: 'agent_led',
    fetch: fetchImpl
  });

  await client.getClientConfig();
  await client.registerDevice({
    business_ref: { type: 'service_order', id: 'SO-1' },
    rustdesk_id: '123456789',
    display_name: 'LED controller',
    metadata: { rack: 'A-01' }
  });
  await client.getDevice('rdesk_1');
  await client.listDevicesByBusinessRef({
    business_ref: { type: 'service_order', id: 'SO-1' },
    limit: 25
  });
  await client.heartbeatDevice('rdesk_1', {
    actor_identity: 'edge-led-1',
    runtime_status: 'online',
    metadata: { ip: '10.0.0.8' }
  });
  await client.startGatewaySession({
    remote_session_id: 'remote_1',
    device_id: 'rdesk_1',
    actor_identity: 'agent_led',
    permissions: ['view_screen', 'control_mouse_keyboard'],
    metadata: { source: 'led' }
  });
  await client.getGatewayLaunchPlan('rdgw_1');
  await client.recordGatewayEvent('rdgw_1', {
    event_type: 'remote.rustdesk.control_action.performed',
    actor_identity: 'agent_led',
    metadata: {
      operation_id: 'op_1',
      action: 'mouse.click',
      permission: 'control_mouse_keyboard'
    }
  });
  await client.listGatewayAuditEvents('rdgw_1', {
    since: '2026-07-06T00:00:00.000Z'
  });
  await client.deactivateDevice('rdesk_1');
  await client.endGatewaySession('rdgw_1', {
    actor_identity: 'agent_led'
  });
  const disconnectState = await client.getGatewayDisconnectState('rdgw_1');

  assert.deepEqual(
    calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`),
    [
      'GET /api/ivekit/rustdesk/client-config',
      'POST /api/ivekit/rustdesk/devices',
      'GET /api/ivekit/rustdesk/devices/rdesk_1',
      'GET /api/ivekit/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=SO-1&limit=25',
      'POST /api/ivekit/rustdesk/devices/rdesk_1/heartbeat',
      'POST /api/ivekit/rustdesk/gateway-sessions',
      'GET /api/ivekit/rustdesk/gateway-sessions/rdgw_1/launch',
      'POST /api/ivekit/rustdesk/gateway-sessions/rdgw_1/events',
      'GET /api/ivekit/rustdesk/gateway-sessions/rdgw_1/audit?since=2026-07-06T00%3A00%3A00.000Z',
      'POST /api/ivekit/rustdesk/devices/rdesk_1/deactivate',
      'DELETE /api/ivekit/rustdesk/gateway-sessions/rdgw_1',
      'GET /api/ivekit/rustdesk/gateway-sessions/rdgw_1/disconnect'
    ]
  );
  for (const call of calls) {
    assert.equal(call.headers['x-api-key'], 'opc-api-key');
    assert.equal(call.headers['x-tenant-id'], 'tenant_led');
    assert.equal(call.headers['x-user-id'], 'agent_led');
  }
  assert.deepEqual(calls[1].body, {
    business_ref: { type: 'service_order', id: 'SO-1' },
    rustdesk_id: '123456789',
    display_name: 'LED controller',
    metadata: { rack: 'A-01' }
  });
  assert.deepEqual(calls[10].body, { actor_identity: 'agent_led' });
  assert.equal(disconnectState.status, 'pending');
  assert.equal(disconnectState.command?.id, 'rdcmd_1');
  assert.equal(JSON.stringify(disconnectState).includes('claim_token'), false);
});

test('iveKit RustDesk HTTP client rejects bad configuration before calling fetch', async () => {
  assert.throws(
    () => createIveKitRustDeskHttpClient({ baseUrl: 'file:///tmp/opc', apiKey: 'k', tenantId: 't' }),
    /baseUrl must use http\(s\)/
  );
  assert.throws(
    () => createIveKitRustDeskHttpClient({ baseUrl: 'https://opc.example.com', apiKey: '', tenantId: 't' }),
    /exactly one of apiKey or accessToken is required/
  );
  assert.throws(
    () => createIveKitRustDeskHttpClient({
      baseUrl: 'https://opc.example.com',
      apiKey: 'server-key',
      accessToken: 'user-token',
      tenantId: 't'
    }),
    /exactly one of apiKey or accessToken is required/
  );
  assert.throws(
    () => createIveKitRustDeskHttpClient({ baseUrl: 'https://opc.example.com', apiKey: 'k', tenantId: '' }),
    /tenantId is required/
  );
});

test('iveKit RustDesk HTTP client keeps Bearer identity authoritative', async () => {
  let headers: Record<string, string> = {};
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-user-token',
    tenantId: 'tenant_led',
    userId: 'spoofed-user-id',
    fetch: async (_input, init = {}) => {
      headers = headersToRecord(init.headers);
      return jsonResponse(200, { id_server: 'rustdesk-id.example.com' });
    }
  });

  await client.getClientConfig();
  assert.equal(headers.authorization, 'Bearer short-lived-user-token');
  assert.equal(headers['x-tenant-id'], 'tenant_led');
  assert.equal(headers['x-user-id'], undefined);
  assert.equal(headers['x-api-key'], undefined);
});

test('iveKit RustDesk HTTP client exposes status, method, path, and upstream error', async () => {
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    apiKey: 'opc-api-key',
    tenantId: 'tenant_led',
    fetch: async () => jsonResponse(403, { error: 'active consent required' })
  });

  await assert.rejects(
    () =>
      client.startGatewaySession({
        remote_session_id: 'remote_1',
        device_id: 'rdesk_1',
        actor_identity: 'agent_led',
        permissions: ['view_screen']
      }),
    (error) => {
      assert.equal(error instanceof IveKitRustDeskHttpError, true);
      const httpError = error as IveKitRustDeskHttpError;
      assert.equal(httpError.status, 403);
      assert.equal(httpError.method, 'POST');
      assert.equal(httpError.path, '/api/ivekit/rustdesk/gateway-sessions');
      assert.match(httpError.message, /active consent required/);
      return true;
    }
  );
});

function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { 'content-type': 'application/json' }
  });
}
