import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { RustDeskDeviceStore } from '../src/agent-runtime/collaboration/rustdesk-device-store.js';
import { createRustDeskEdgeCommandToken } from '../src/agent-runtime/collaboration/rustdesk-edge-auth.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { RustDeskPhysicalDisconnectService } from '../src/agent-runtime/collaboration/rustdesk-physical-disconnect.js';
import { MemoryPg } from '../src/db-pg.js';
import type { PgQueryable } from '../src/db-pg.js';

const API_KEY = 'rustdesk-device-command-http-key';
const EDGE_TOKEN_SECRET = 'rustdesk-device-command-http-edge-secret-32-bytes';

function authHeaders(tenantId: string, userId = 'rustdesk-edge-http'): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

function edgeHeaders(token: string): Record<string, string> {
  return { 'x-rustdesk-edge-token': token };
}

async function route(
  pg: MemoryPg,
  method: string,
  path: string,
  body: unknown,
  tenantId: string,
  headers: Record<string, string> = authHeaders(tenantId)
) {
  return routeCollaborationApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers
  );
}

function commandToken(input: {
  tenantId: string;
  rustdeskId: string;
  edgeInstanceId: string;
}): string {
  return createRustDeskEdgeCommandToken({
    tenant_id: input.tenantId,
    rustdesk_id: input.rustdeskId,
    edge_instance_id: input.edgeInstanceId,
    issued_at: '2026-07-10T00:00:00.000Z',
    expires_at: '2099-07-10T00:00:00.000Z'
  }, EDGE_TOKEN_SECRET);
}

async function commandHttpFixture() {
  const pg = new MemoryPg();
  const tenantId = 'tenant_rustdesk_command_http';
  const devices = new RustDeskDeviceStore(pg);
  const sessions = new RustDeskGatewaySessionStore(pg);
  const service = new RustDeskPhysicalDisconnectService(pg);
  const device = await devices.registerDevice({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'SO-RUSTDESK-COMMAND-HTTP'
    },
    rustdesk_id: '135792468',
    display_name: 'LED command HTTP target'
  });
  const session = await sessions.createSession({
    tenant_id: tenantId,
    target: { type: 'device', id: device.rustdesk_id },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    actor_identity: 'agent-command-http',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=command-http',
    metadata: {
      rustdesk_target_mode: 'registered_device',
      rustdesk_device_id: device.id,
      rustdesk_id: device.rustdesk_id
    }
  });
  const ended = await service.endGatewaySession({
    tenant_id: tenantId,
    external_id: session.external_id,
    actor_identity: 'customer-command-http',
    requested_reason: 'consent_revoked'
  });
  return { pg, tenantId, device, session, command: ended.command! };
}

test('iveKit RustDesk command HTTP claims, reports progress, completes, and reads status', async () => {
  const previousApiKey = process.env.OPC_API_KEY;
  const previousEdgeSecret = process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET;
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET = EDGE_TOKEN_SECRET;
  const fixture = await commandHttpFixture();
  const token = commandToken({
    tenantId: fixture.tenantId,
    rustdeskId: fixture.device.rustdesk_id,
    edgeInstanceId: 'edge-command-http-1'
  });

  try {
    const genericClaim = await route(
      fixture.pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${fixture.device.id}/commands/claim`,
      { edge_instance_id: 'generic-app-spoof', lease_ms: 30_000 },
      fixture.tenantId
    );
    assert.deepEqual(genericClaim, {
      status: 401,
      data: { error: 'RustDesk edge command token is required' }
    });

    const claim = (await route(
      fixture.pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${fixture.device.id}/commands/claim`,
      { edge_instance_id: 'body-cannot-override-edge', lease_ms: 30_000 },
      fixture.tenantId,
      edgeHeaders(token)
    )) as {
      status: number;
      data: {
        command: {
          id: string;
          command_type: string;
          external_id: string;
          target_id: string;
          rustdesk_id: string;
          requested_reason: string;
          attempt: number;
        };
        claim_token: string;
      };
    };
    assert.equal(claim.status, 201);
    assert.equal(claim.data.command.id, fixture.command.id);
    assert.equal(claim.data.command.command_type, 'disconnect_session');
    assert.equal(claim.data.command.external_id, fixture.session.external_id);
    assert.equal(claim.data.command.target_id, fixture.device.id);
    assert.equal(claim.data.command.rustdesk_id, fixture.device.rustdesk_id);
    assert.equal(claim.data.command.requested_reason, 'consent_revoked');
    assert.equal(claim.data.command.attempt, 1);
    assert.equal(typeof claim.data.claim_token, 'string');

    const recovery = (await route(
      fixture.pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${fixture.device.id}/commands/${fixture.command.id}/recover`,
      { state: 'executed', attempt: 1, lease_ms: 30_000 },
      fixture.tenantId,
      edgeHeaders(token)
    )) as {
      status: number;
      data: { action: string; claim_token: string; command: { attempt_count: number } };
    };
    assert.equal(recovery.status, 201);
    assert.equal(recovery.data.action, 'resume_report');
    assert.equal(recovery.data.command.attempt_count, 1);
    assert.notEqual(recovery.data.claim_token, claim.data.claim_token);

    const progress = (await route(
      fixture.pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${fixture.device.id}/commands/${fixture.command.id}/progress`,
      {
        claim_token: recovery.data.claim_token,
        progress: 'fallback_started',
        metadata: { collateral_sessions_may_disconnect: true }
      },
      fixture.tenantId,
      edgeHeaders(token)
    )) as { status: number; data: { command: { status: string } } };
    assert.equal(progress.status, 201);
    assert.equal(progress.data.command.status, 'claimed');
    assert.equal((progress.data.command as { claimed_by?: string }).claimed_by, 'edge-command-http-1');

    const completed = (await route(
      fixture.pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${fixture.device.id}/commands/${fixture.command.id}/result`,
      {
        claim_token: recovery.data.claim_token,
        status: 'succeeded',
        execution_method: 'service_restart',
        exit_code: 0,
        duration_ms: 842,
        stdout_bytes: 0,
        stderr_bytes: 0,
        metadata: {
          collateral_sessions_may_disconnect: true,
          edge_agent_version: '1.0.0',
          edge_instance_id: 'edge-command-http-1'
        }
      },
      fixture.tenantId,
      edgeHeaders(token)
    )) as { status: number; data: { command: { id: string; status: string; result_metadata: Record<string, unknown> } } };
    assert.equal(completed.status, 201);
    assert.equal(completed.data.command.status, 'succeeded');
    assert.equal(completed.data.command.result_metadata.edge_instance_id, 'edge-command-http-1');

    const state = (await route(
      fixture.pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${fixture.session.external_id}/disconnect`,
      null,
      fixture.tenantId
    )) as { data: { required: boolean; status: string; command: Record<string, unknown> } };
    assert.equal(state.data.required, true);
    assert.equal(state.data.status, 'succeeded');
    assert.equal(state.data.command.id, fixture.command.id);
    assert.equal(JSON.stringify(state).includes('claim_token'), false);

    const noWork = (await route(
      fixture.pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${fixture.device.id}/commands/claim`,
      { edge_instance_id: 'edge-command-http-1', lease_ms: 30_000 },
      fixture.tenantId,
      edgeHeaders(token)
    )) as { status: number; data: null };
    assert.deepEqual(noWork, { status: 204, data: null });
  } finally {
    if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousApiKey;
    if (previousEdgeSecret === undefined) delete process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET;
    else process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET = previousEdgeSecret;
  }
});

test('iveKit RustDesk command HTTP hides commands across tenant and device scope', async () => {
  const previousApiKey = process.env.OPC_API_KEY;
  const previousEdgeSecret = process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET;
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET = EDGE_TOKEN_SECRET;
  const fixture = await commandHttpFixture();

  try {
    const mismatchedDeviceClaim = await route(
      fixture.pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${fixture.device.id}/commands/claim`,
      { lease_ms: 30_000 },
      fixture.tenantId,
      edgeHeaders(commandToken({
        tenantId: fixture.tenantId,
        rustdeskId: '999999999',
        edgeInstanceId: 'edge-command-http-wrong-device'
      }))
    );
    assert.deepEqual(mismatchedDeviceClaim, {
      status: 404,
      data: { error: 'rustdesk device not found' }
    });

    const crossTenantState = await route(
      fixture.pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${fixture.session.external_id}/disconnect`,
      null,
      'tenant_rustdesk_command_http_other'
    );
    const crossTenantClaim = await route(
      fixture.pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${fixture.device.id}/commands/claim`,
      { edge_instance_id: 'edge-command-http-other', lease_ms: 30_000 },
      'tenant_rustdesk_command_http_other',
      edgeHeaders(commandToken({
        tenantId: 'tenant_rustdesk_command_http_other',
        rustdeskId: fixture.device.rustdesk_id,
        edgeInstanceId: 'edge-command-http-other'
      }))
    );

    assert.deepEqual(crossTenantState, { status: 404, data: { error: 'rustdesk gateway session not found' } });
    assert.deepEqual(crossTenantClaim, { status: 404, data: { error: 'rustdesk device not found' } });
  } finally {
    if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousApiKey;
    if (previousEdgeSecret === undefined) delete process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET;
    else process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET = previousEdgeSecret;
  }
});

test('collaboration RustDesk tool end queues a tool_ended physical disconnect', async () => {
  const previousEnv = {
    apiKey: process.env.OPC_API_KEY,
    baseUrl: process.env.OPC_BASE_URL,
    launchSecret: process.env.OPC_RUSTDESK_LAUNCH_SECRET,
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    gatewayBaseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    gatewayToken: process.env.OPC_REMOTE_GATEWAY_API_TOKEN,
    rustdeskBaseUrl: process.env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL,
    requirePhysicalDisconnect: process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT
  };
  const previousFetch = globalThis.fetch;
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_BASE_URL = 'https://opc.example.com';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'rustdesk-tool-end-command-secret';
  delete process.env.OPC_REMOTE_GATEWAY_PROVIDER;
  delete process.env.OPC_REMOTE_GATEWAY_BASE_URL;
  delete process.env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL;
  const pg = new MemoryPg();
  const tenantId = 'tenant_rustdesk_tool_end_command';

  try {
    const collaboration = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'SO-RUSTDESK-TOOL-END' } },
      tenantId
    )) as { data: { id: string } };
    const remote = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: collaboration.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk'
      },
      tenantId
    )) as { data: { id: string } };
    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remote.data.id}/consent/grant`,
      {
        actor_identity: 'customer-rustdesk-tool-end',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      tenantId
    );
    const device = (await route(
      pg,
      'POST',
      '/api/ivekit/rustdesk/devices',
      {
        business_ref: { type: 'service_order', id: 'SO-RUSTDESK-TOOL-END' },
        rustdesk_id: '246813579',
        display_name: 'LED tool end target'
      },
      tenantId
    )) as { data: { id: string } };
    const tool = (await route(
      pg,
      'POST',
      '/api/ivekit/rustdesk/gateway-sessions',
      {
        remote_session_id: remote.data.id,
        device_id: device.data.id,
        actor_identity: 'agent-rustdesk-tool-end',
        permissions: ['view_screen']
      },
      tenantId
    )) as { data: { id: string; external_id: string } };

    const ended = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remote.data.id}/tools/end`,
      {
        tool_session_id: tool.data.id,
        actor_identity: 'agent-rustdesk-tool-end'
      },
      tenantId
    )) as {
      status: number;
      data: { status: string; physical_disconnect?: { status: string; command_id?: string } };
    };
    const state = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/disconnect`,
      null,
      tenantId
    )) as { data: { status: string; command: { requested_reason: string } } };

    assert.equal(ended.status, 201);
    assert.equal(ended.data.status, 'ended');
    assert.equal(ended.data.physical_disconnect?.status, 'pending');
    assert.equal(state.data.status, 'pending');
    assert.equal(state.data.command.requested_reason, 'tool_ended');

    process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '1';
    process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'rustdesk';
    process.env.OPC_REMOTE_GATEWAY_BASE_URL = 'https://opc-upstream.example.com';
    process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'rustdesk-upstream-token';
    let upstreamCalls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ error: 'unexpected upstream call' }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;
    await assert.rejects(
      () => route(
        pg,
        'POST',
        `/api/collaboration/remote-assistance/${remote.data.id}/tools/gateway`,
        {
          actor_identity: 'agent-rustdesk-raw-strict',
          target: { type: 'device', id: '975318642' },
          permissions: ['view_screen'],
          metadata: { rustdesk_target_mode: 'raw_id' }
        },
        tenantId
      ),
      /rustdesk physical disconnect requires a registered device/
    );
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_API_KEY', previousEnv.apiKey);
    restoreEnv('OPC_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_RUSTDESK_LAUNCH_SECRET', previousEnv.launchSecret);
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.gatewayBaseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.gatewayToken);
    restoreEnv('OPC_RUSTDESK_CONTROL_PLANE_BASE_URL', previousEnv.rustdeskBaseUrl);
    restoreEnv('OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT', previousEnv.requirePhysicalDisconnect);
  }
});

test('RustDesk control plane strict mode requires a capable registered device and queues direct end', async () => {
  const previousEnv = {
    apiKey: process.env.OPC_API_KEY,
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN,
    launchSecret: process.env.OPC_RUSTDESK_LAUNCH_SECRET,
    launchBaseUrl: process.env.OPC_RUSTDESK_LAUNCH_BASE_URL,
    requirePhysicalDisconnect: process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT,
    onlineTtlMs: process.env.OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS
  };
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-plane-strict-token';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'rustdesk-control-plane-strict-secret';
  process.env.OPC_RUSTDESK_LAUNCH_BASE_URL = 'https://opc.example.com';
  process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '1';
  process.env.OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS = '300000';
  const pg = new MemoryPg();
  const tenantId = 'tenant_rustdesk_control_plane_strict';
  const devices = new RustDeskDeviceStore(pg);
  const device = await devices.registerDevice({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'SO-RUSTDESK-CONTROL-STRICT'
    },
    rustdesk_id: '864209753',
    display_name: 'LED control-plane strict target'
  });
  await devices.heartbeatDevice({
    tenant_id: tenantId,
    device_id: device.id,
    actor_identity: 'edge-control-plane-strict',
    runtime_status: 'online',
    seen_at: new Date().toISOString(),
    metadata: {
      disconnect_command_capable: true,
      edge_instance_id: 'edge-control-plane-strict'
    }
  });
  const module = createCollaborationModule({ pg });
  const businessRef = {
    tenant_id: tenantId,
    type: device.business_ref_type,
    id: device.business_ref_id
  };
  const collaboration = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: 'RustDesk control-plane strict'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: collaboration.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'rustdesk',
    started_by: 'agent-control-plane-strict'
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer-control-plane-strict',
    scopes: ['view_screen'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const controlPlaneRoute = (
    method: string,
    path: string,
    body: unknown
  ) => routeCollaborationApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    { authorization: 'Bearer rustdesk-control-plane-strict-token' }
  );

  try {
    await assert.rejects(
      () => controlPlaneRoute('POST', '/api/opc/rustdesk/sessions', {
        tenant_id: tenantId,
        remote_session_id: remote.id,
        actor_identity: 'agent-control-plane-raw',
        target: { type: 'device', id: '864209753' },
        permissions: ['view_screen'],
        metadata: { rustdesk_target_mode: 'raw_id' }
      }),
      /rustdesk physical disconnect requires a registered device/
    );

    const created = (await controlPlaneRoute('POST', '/api/opc/rustdesk/sessions', {
      tenant_id: tenantId,
      remote_session_id: remote.id,
      actor_identity: 'agent-control-plane-strict',
      target: { type: 'device', id: device.rustdesk_id },
      permissions: ['view_screen'],
      metadata: {
        tenant_id: tenantId,
        rustdesk_target_mode: 'registered_device',
        rustdesk_device_id: device.id,
        rustdesk_id: device.rustdesk_id
      }
    })) as { status: number; data: { external_id: string } };
    assert.equal(created.status, 201);

    const ended = await controlPlaneRoute(
      'DELETE',
      `/api/opc/rustdesk/sessions/${created.data.external_id}`,
      { actor_identity: 'agent-control-plane-strict', reason: 'gateway_ended' }
    );
    const state = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${created.data.external_id}/disconnect`,
      null,
      tenantId
    )) as { data: { status: string; command: { device_id: string; requested_reason: string } } };

    assert.deepEqual(ended, { status: 204, data: null });
    assert.equal(state.data.status, 'pending');
    assert.equal(state.data.command.device_id, device.id);
    assert.equal(state.data.command.requested_reason, 'gateway_ended');
  } finally {
    restoreEnv('OPC_API_KEY', previousEnv.apiKey);
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
    restoreEnv('OPC_RUSTDESK_LAUNCH_SECRET', previousEnv.launchSecret);
    restoreEnv('OPC_RUSTDESK_LAUNCH_BASE_URL', previousEnv.launchBaseUrl);
    restoreEnv('OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT', previousEnv.requirePhysicalDisconnect);
    restoreEnv('OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS', previousEnv.onlineTtlMs);
  }
});

test('RustDesk control plane enters the resolved session tenant transaction', async () => {
  const previousToken = process.env.OPC_RUSTDESK_API_TOKEN;
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-plane-rls-token';
  const session = {
    external_id: 'rdgw-rls-1',
    tenant_id: 'tenant-rustdesk-rls',
    status: 'active',
    target_type: 'device',
    target_id: '123456789',
    target_display_name: 'RLS target',
    permissions: JSON.stringify(['view_screen']),
    actor_identity: 'agent-rls',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-rls-1',
    metadata: '{}',
    created_at: '2026-07-11T00:00:00.000Z',
    ended_at: null,
    ended_by: ''
  };
  const transactionQueries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      transactionQueries.push({ sql, params });
      if (sql.includes('FROM rustdesk_gateway_sessions')) return { rows: [session], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pg = {
    async query(sql: string) {
      if (sql.includes('opc_rustdesk_session_by_external_id')) return { rows: [session], rowCount: 1 };
      throw new Error('unscoped RustDesk table query');
    },
    async connect() {
      return client;
    }
  } as unknown as PgQueryable;

  try {
    const result = await routeCollaborationApi(
      pg,
      'GET',
      '/api/opc/rustdesk/sessions/rdgw-rls-1/launch',
      new URL('http://localhost/api/opc/rustdesk/sessions/rdgw-rls-1/launch'),
      null,
      '',
      { authorization: 'Bearer rustdesk-control-plane-rls-token' }
    ) as { data: { external_id: string } };

    assert.equal(result.data.external_id, 'rdgw-rls-1');
    const tenantQuery = transactionQueries.find((entry) => entry.sql.includes("set_config('app.current_tenant'"));
    assert.deepEqual(tenantQuery?.params, ['tenant-rustdesk-rls']);
  } finally {
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousToken);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
