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
    baseUrl: 'https://opc.example.com/',
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
  for (const baseUrl of [
    'https://url-user:url-password@opc.example.com',
    'https://opc.example.com?token=query-secret',
    'https://opc.example.com#fragment-secret'
  ]) {
    assert.throws(
      () => createIveKitRustDeskHttpClient({ baseUrl, apiKey: 'k', tenantId: 't' }),
      (error) => {
        assert.match(String(error), /baseUrl must not include credentials, query, or fragment/);
        assert.doesNotMatch(String(error), /url-user|url-password|query-secret|fragment-secret/);
        return true;
      }
    );
  }
  assert.throws(
    () => createIveKitRustDeskHttpClient({ baseUrl: 'https://opc.example.com/ivekit/', apiKey: 'k', tenantId: 't' }),
    /baseUrl must not include a path/
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

test('iveKit RustDesk HTTP client applies the configured request timeout', async () => {
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    apiKey: 'opc-api-key',
    tenantId: 'tenant_led',
    timeoutMs: 100,
    fetch: async (_input, init = {}) => await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });

  await assert.rejects(
    () => client.getClientConfig(),
    (error) => {
      assert.equal(error instanceof IveKitRustDeskHttpError, true);
      const timeout = error as IveKitRustDeskHttpError;
      assert.equal(timeout.status, 0);
      assert.equal(timeout.method, 'GET');
      assert.equal(timeout.path, '/api/ivekit/rustdesk/client-config');
      assert.match(timeout.message, /timed out after 100ms/);
      return true;
    }
  );
});

test('iveKit RustDesk HTTP client projects terminal evidence from every device response path', async () => {
  const unsafeEvidence = {
    operation_id: 'terminal-operation-1',
    operation: 'view_screen',
    status: 'observed_succeeded',
    observer: 'qa',
    observed_at: '2026-07-12T12:00:00.000Z',
    evidence_refs: [{
      type: 'qa_report',
      ref: 'evidence://run-1/terminal-1',
      sha256: 'a'.repeat(64),
      token: 'reference-token'
    }],
    metadata: {
      external_id: 'rdgw_1',
      provider_operation_id: 'native-view-1',
      clipboard_text: 'terminal clipboard secret',
      token: 'metadata-token',
      arbitrary: 'drop-me'
    },
    credential: 'top-level-credential'
  };
  const device = (id: string) => ({
    id,
    rustdesk_id: '123456789',
    terminal_profile: {
      device_id: id,
      rustdesk_id: '123456789',
      observed: [unsafeEvidence]
    }
  });
  const responses = [
    device('registered'),
    device('fetched'),
    [device('listed')],
    device('heartbeat'),
    device('deactivated')
  ];
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant_led',
    fetch: async () => jsonResponse(200, responses.shift())
  });

  const devices = [
    await client.registerDevice({
      business_ref: { type: 'service_order', id: 'SO-1' },
      rustdesk_id: '123456789',
      display_name: 'LED controller'
    }),
    await client.getDevice('rdesk_1'),
    ...(await client.listDevicesByBusinessRef({
      business_ref: { type: 'service_order', id: 'SO-1' }
    })),
    await client.heartbeatDevice('rdesk_1', { actor_identity: 'edge-led-1' }),
    await client.deactivateDevice('rdesk_1')
  ];

  assert.equal(devices.length, 5);
  for (const projected of devices) {
    assert.doesNotMatch(
      JSON.stringify(projected),
      /clipboard_text|terminal clipboard secret|metadata-token|reference-token|top-level-credential|arbitrary|drop-me/
    );
    assert.deepEqual(projected.terminal_profile?.observed[0].metadata, {
      external_id: 'rdgw_1',
      provider_operation_id: 'native-view-1'
    });
  }
});

test('iveKit RustDesk HTTP client fails closed on invalid terminal evidence', async () => {
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant_led',
    fetch: async () => jsonResponse(200, {
      id: 'rdesk_1',
      terminal_profile: {
        observed: [{
          operation_id: 'terminal-operation-1',
          operation: 'view_screen',
          status: 'observed_succeeded',
          observer: 'none',
          observed_at: '2026-07-12T12:00:00.000Z',
          evidence_refs: [{ type: 'qa_report', ref: 'evidence://run-1/view-1', sha256: 'a'.repeat(64) }],
          metadata: { token: 'must-not-leak' }
        }]
      }
    })
  });

  await assert.rejects(
    () => client.getDevice('rdesk_1'),
    (error) => {
      assert.match(String(error), /invalid RustDesk operation evidence/);
      assert.doesNotMatch(String(error), /must-not-leak/);
      return true;
    }
  );
});

test('iveKit RustDesk HTTP client projects operation evidence onto browser-safe keys', async () => {
  const observed = {
    operation_id: 'operation-1',
    operation: 'clipboard',
    status: 'observed_succeeded',
    observer: 'qa',
    observed_at: '2026-07-12T12:00:00.000Z',
    evidence_refs: [{
      type: 'qa_report',
      ref: 'evidence://run-1/clipboard-1',
      sha256: 'a'.repeat(64),
      token: 'evidence-ref-token'
    }],
    metadata: {
      operation_id: 'operation-1',
      external_id: 'rdgw_1',
      direction: 'agent_to_device',
      byte_count: 24,
      checksum_sha256: 'b'.repeat(64),
      status_detail: 'operator_verified',
      clipboard_text: 'sensitive clipboard text',
      token: 'metadata-token',
      arbitrary: 'drop-me'
    },
    credential: 'top-level-credential'
  };
  const disconnectObserved = {
    ...observed,
    operation_id: 'disconnect-1',
    operation: 'session_disconnect',
    metadata: {
      external_id: 'rdgw_1',
      reason: 'operator_verified',
      token: 'disconnect-token'
    }
  };
  const responses = [
    {
      id: 'tool_1',
      operation_evidence: [observed],
      disconnect_state: {
        required: true,
        status: 'succeeded',
        command: { id: 'rdcmd_1', status: 'succeeded' },
        observation_status: 'observed_disconnected',
        observed: disconnectObserved
      }
    },
    { external_id: 'rdgw_1', operation_evidence: [observed] },
    {
      required: true,
      status: 'succeeded',
      command: { id: 'rdcmd_1', status: 'succeeded' },
      observation_status: 'observed_disconnected',
      observed: disconnectObserved
    }
  ];
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant_led',
    fetch: async () => jsonResponse(200, responses.shift())
  });

  const session = await client.startGatewaySession({
    remote_session_id: 'remote_1',
    device_id: 'rdesk_1',
    actor_identity: 'agent_led',
    permissions: ['view_screen']
  });
  const launch = await client.getGatewayLaunchPlan('rdgw_1');
  const disconnect = await client.getGatewayDisconnectState('rdgw_1');

  for (const value of [session, launch, disconnect]) {
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(serialized, /clipboard_text|sensitive clipboard text|metadata-token|disconnect-token|evidence-ref-token|top-level-credential|arbitrary|drop-me/);
  }
  assert.deepEqual(session.operation_evidence?.[0].metadata, {
    external_id: 'rdgw_1',
    direction: 'agent_to_device',
    byte_count: 24,
    checksum_sha256: 'b'.repeat(64),
    status_detail: 'operator_verified'
  });
  assert.deepEqual(session.operation_evidence?.[0].evidence_refs[0], {
    type: 'qa_report',
    ref: 'evidence://run-1/clipboard-1',
    sha256: 'a'.repeat(64)
  });
  assert.deepEqual(session.disconnect_state?.observed?.metadata, {
    external_id: 'rdgw_1',
    reason: 'operator_verified'
  });
});

test('iveKit RustDesk HTTP client fails closed on invalid evidence and disconnect provenance', async () => {
  const invalidPayloads = [
    {
      id: 'tool_1',
      operation_evidence: [{
        operation_id: 'operation-1',
        operation: 'view_screen',
        status: 'observed_succeeded',
        observer: 'none',
        observed_at: '2026-07-12T12:00:00.000Z',
        evidence_refs: [{ type: 'qa_report', ref: 'evidence://run-1/view-1', sha256: 'a'.repeat(64) }],
        metadata: { token: 'must-not-leak' }
      }]
    },
    {
      external_id: 'rdgw_1',
      operation_evidence: [{
        operation_id: 'operation-2',
        operation: 'view_screen',
        status: 'observed_succeeded',
        observer: 'qa',
        observed_at: '2026-07-12T12:00:00.000Z',
        evidence_refs: [{ type: '', ref: '', sha256: 'bad' }],
        metadata: {}
      }]
    },
    {
      required: true,
      status: 'succeeded',
      command: { id: 'rdcmd_1', status: 'failed' },
      observation_status: 'observed_disconnected',
      observed: {
        operation_id: 'operation-3',
        operation: 'view_screen',
        status: 'observed_succeeded',
        observer: 'qa',
        observed_at: '2026-07-12T12:00:00.000Z',
        evidence_refs: [{ type: 'qa_report', ref: 'evidence://run-1/disconnect-1', sha256: 'a'.repeat(64) }],
        metadata: {}
      }
    }
  ];
  const clientFor = (payload: unknown) => createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant_led',
    fetch: async () => jsonResponse(200, payload)
  });

  await assert.rejects(
    () => clientFor(invalidPayloads[0]).startGatewaySession({
      remote_session_id: 'remote_1',
      device_id: 'rdesk_1',
      actor_identity: 'agent_led',
      permissions: ['view_screen']
    }),
    (error) => {
      assert.match(String(error), /invalid RustDesk operation evidence/);
      assert.doesNotMatch(String(error), /must-not-leak/);
      return true;
    }
  );
  await assert.rejects(
    () => clientFor(invalidPayloads[1]).getGatewayLaunchPlan('rdgw_1'),
    /invalid RustDesk operation evidence/
  );
  await assert.rejects(
    () => clientFor(invalidPayloads[2]).getGatewayDisconnectState('rdgw_1'),
    /invalid RustDesk disconnect state/
  );
});

test('iveKit RustDesk HTTP client enforces non-contradictory disconnect observations', async () => {
  const observed = (status: 'observed_succeeded' | 'observed_failed') => ({
    operation_id: `disconnect-${status}`,
    operation: 'session_disconnect',
    status,
    observer: 'qa',
    observed_at: '2026-07-12T12:00:00.000Z',
    evidence_refs: [{ type: 'qa_report', ref: `evidence://run-1/${status}`, sha256: 'a'.repeat(64) }],
    metadata: {}
  });
  const notObserved = {
    operation_id: 'disconnect-not-observed',
    operation: 'session_disconnect',
    status: 'not_observed',
    observer: 'none',
    observed_at: null,
    evidence_refs: [],
    metadata: {}
  };
  const state = (observation_status: string, evidence: unknown) => ({
    required: true,
    status: 'succeeded',
    command: { id: 'rdcmd_1', status: 'succeeded' },
    observation_status,
    observed: evidence
  });

  for (const payload of [
    state('observed_disconnected', observed('observed_succeeded')),
    state('observed_connected', observed('observed_failed')),
    state('not_observed', notObserved)
  ]) {
    const client = createIveKitRustDeskHttpClient({
      baseUrl: 'https://opc.example.com',
      accessToken: 'short-lived-browser-token',
      tenantId: 'tenant_led',
      fetch: async () => jsonResponse(200, payload)
    });
    await client.getGatewayDisconnectState('rdgw_1');
  }

  for (const payload of [
    state('observed_disconnected', observed('observed_failed')),
    state('observed_connected', observed('observed_succeeded')),
    state('not_observed', observed('observed_succeeded'))
  ]) {
    const client = createIveKitRustDeskHttpClient({
      baseUrl: 'https://opc.example.com',
      accessToken: 'short-lived-browser-token',
      tenantId: 'tenant_led',
      fetch: async () => jsonResponse(200, payload)
    });
    await assert.rejects(
      () => client.getGatewayDisconnectState('rdgw_1'),
      /invalid RustDesk disconnect state/
    );
  }
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
