import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import type { RemoteConsentScope } from '../src/agent-runtime/collaboration/types.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { createRustDeskEdgeCommandToken } from '../src/agent-runtime/collaboration/rustdesk-edge-auth.js';
import { createWebAssistJoinPath } from '../src/agent-runtime/ivekit/remote-assist-token.js';
import { MemoryPg } from '../src/db-pg.js';

const API_KEY = 'test-collaboration-http-key';
const RUSTDESK_PUBLIC_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

function authHeaders(tenantId: string, userId = 'agent-http'): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function route(
  pg: MemoryPg,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = authHeaders('tenant_collab_http'),
  rawBody: string | Buffer = ''
) {
  return routeCollaborationApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    rawBody,
    headers
  );
}

test('collaboration HTTP exposes remote assistance consent tool audit and evidence flow', async () => {
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'opc-collaboration-http-'));
  const pg = new MemoryPg();
  const tenantId = 'tenant_collab_http';

  const sessionResult = (await route(
    pg,
    'POST',
    '/api/collaboration/sessions',
    {
      title: 'LED repair support',
      business_ref: {
        type: 'service_order',
        id: 'order-http-1',
        display_name: 'LED order #1',
        metadata: { customer_name: 'Aki' }
      }
    },
    authHeaders(tenantId)
  )) as { status: number; data: { id: string; business_ref: { tenant_id: string } } };
  assert.equal(sessionResult.status, 201);
  assert.equal(sessionResult.data.business_ref.tenant_id, tenantId);

  const remoteResult = (await route(
    pg,
    'POST',
    '/api/collaboration/remote-assistance/sessions',
    {
      collaboration_session_id: sessionResult.data.id,
      mode: 'third_party_remote_tool',
      adapter_provider: 'anydesk'
    },
    authHeaders(tenantId)
  )) as { status: number; data: { id: string; status: string; business_ref: { id: string } } };
  assert.equal(remoteResult.status, 201);
  assert.equal(remoteResult.data.business_ref.id, 'order-http-1');

  await assert.rejects(
    () =>
      route(
        pg,
        'POST',
        `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools`,
        { provider: 'anydesk', external_id: 'ad-1', launch_url: 'https://remote.example/ad-1' },
        authHeaders(tenantId)
      ),
    /active consent required/
  );

  await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/request`,
    { scopes: ['view_screen', 'control_mouse_keyboard', 'record_screen'] },
    authHeaders(tenantId)
  );
  await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
    {
      actor_identity: 'customer-http',
      scopes: ['view_screen', 'control_mouse_keyboard', 'record_screen'],
      expires_at: '2099-01-01T00:00:00.000Z'
    },
    authHeaders(tenantId)
  );

  const toolResult = (await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools`,
    { provider: 'anydesk', external_id: 'ad-1', launch_url: 'https://remote.example/ad-1' },
    authHeaders(tenantId)
  )) as { status: number; data: { provider: string; status: string } };
  assert.equal(toolResult.status, 201);
  assert.equal(toolResult.data.provider, 'anydesk');

  const uploadPath =
    `/api/collaboration/remote-assistance/${remoteResult.data.id}` +
    '/evidence/upload?kind=screen_recording&filename=remote-session.webm&retention_until=2099-01-01T00%3A00%3A00.000Z';
  const uploadResult = (await route(
    pg,
    'POST',
    uploadPath,
    null,
    { ...authHeaders(tenantId), 'content-type': 'video/webm' },
    Buffer.from('webm-screen-recording')
  )) as { status: number; data: { kind: string; storage_url: string; checksum: string } };
  assert.equal(uploadResult.status, 201);
  assert.equal(uploadResult.data.kind, 'screen_recording');
  assert.match(uploadResult.data.storage_url, /^\/api\/collaboration\/media\//);
  assert.match(uploadResult.data.checksum, /^sha256:/);

  await assert.rejects(
    () => route(pg, 'GET', uploadResult.data.storage_url, null, {}),
    /authentication required|missing or invalid Authorization header/
  );

  const crossTenantMedia = await route(
    pg,
    'GET',
    uploadResult.data.storage_url,
    null,
    authHeaders('tenant_collab_other')
  );
  assert.deepEqual(crossTenantMedia, { status: 404, data: { error: 'not found' } });

  const ownerMedia = (await route(
    pg,
    'GET',
    uploadResult.data.storage_url,
    null,
    authHeaders(tenantId)
  )) as { contentType: string; data: Buffer };
  assert.equal(ownerMedia.contentType, 'application/octet-stream');
  assert.equal(ownerMedia.data.toString(), 'webm-screen-recording');

  const timeline = (await route(
    pg,
    'GET',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
    null,
    authHeaders(tenantId)
  )) as {
    data: {
      session: { id: string };
      consent_events: Array<{ event_type: string }>;
      tool_sessions: Array<{ provider: string }>;
      audit_events: Array<{ event_type: string }>;
      evidence: Array<{ kind: string }>;
    };
  };
  assert.equal(timeline.data.session.id, remoteResult.data.id);
  assert.deepEqual(timeline.data.consent_events.map((event) => event.event_type), ['requested', 'granted']);
  assert.equal(timeline.data.tool_sessions[0]?.provider, 'anydesk');
  assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.evidence.recorded'), true);
  assert.equal(timeline.data.evidence.some((record) => record.kind === 'screen_recording'), true);

  await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/revoke`,
    {
      actor_identity: 'customer-http',
      scopes: ['view_screen', 'control_mouse_keyboard', 'record_screen']
    },
    authHeaders(tenantId)
  );
  const timelineAfterRevoke = (await route(
    pg,
    'GET',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
    null,
    authHeaders(tenantId)
  )) as {
    data: {
      consent_events: Array<{ event_type: string }>;
      tool_sessions: Array<{ status: string }>;
      audit_events: Array<{ event_type: string }>;
    };
  };
  assert.deepEqual(timelineAfterRevoke.data.consent_events.map((event) => event.event_type), [
    'requested',
    'granted',
    'revoked'
  ]);
  assert.equal(timelineAfterRevoke.data.tool_sessions[0]?.status, 'ended');
  assert.equal(timelineAfterRevoke.data.audit_events.some((event) => event.event_type === 'remote.tool_session.ended'), true);
});

test('collaboration HTTP keeps remote assistance sessions tenant scoped', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantA = 'tenant_collab_a';
  const tenantB = 'tenant_collab_b';

  const sessionResult = (await route(
    pg,
    'POST',
    '/api/collaboration/sessions',
    { business_ref: { type: 'support_ticket', id: 'ticket-1' } },
    authHeaders(tenantA)
  )) as { data: { id: string } };
  const remoteResult = (await route(
    pg,
    'POST',
    '/api/collaboration/remote-assistance/sessions',
    { collaboration_session_id: sessionResult.data.id, mode: 'screen_share' },
    authHeaders(tenantA)
  )) as { data: { id: string } };

  const result = await route(
    pg,
    'GET',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
    null,
    authHeaders(tenantB)
  );
  assert.deepEqual(result, { status: 404, data: { error: 'remote session not found' } });
});

test('collaboration HTTP rejects unsupported remote consent scopes before storing consent events', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantId = 'tenant_collab_consent_scope_guard';
  const sessionResult = (await route(
    pg,
    'POST',
    '/api/collaboration/sessions',
    { business_ref: { type: 'service_order', id: 'order-consent-scope-guard' } },
    authHeaders(tenantId)
  )) as { data: { id: string } };
  const remoteResult = (await route(
    pg,
    'POST',
    '/api/collaboration/remote-assistance/sessions',
    {
      collaboration_session_id: sessionResult.data.id,
      mode: 'remote_desktop_gateway',
      adapter_provider: 'anydesk'
    },
    authHeaders(tenantId)
  )) as { data: { id: string } };

  const result = await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
    {
      actor_identity: 'customer-consent-scope-guard',
      scopes: ['view_screen', 'root_shell'],
      expires_at: '2099-01-01T00:00:00.000Z'
    },
    authHeaders(tenantId)
  );
  const timeline = (await route(
    pg,
    'GET',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
    null,
    authHeaders(tenantId)
  )) as { data: { consent_events: Array<{ event_type: string }> } };

  assert.deepEqual(result, { status: 400, data: { error: 'unsupported remote consent scope: root_shell' } });
  assert.deepEqual(timeline.data.consent_events, []);
});

test('collaboration HTTP manages RustDesk devices by tenant and business ref', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantId = 'tenant_rustdesk_devices_http';
  const otherTenantId = 'tenant_rustdesk_devices_http_other';

  const registered = (await route(
    pg,
    'POST',
    '/api/collaboration/rustdesk/devices',
    {
      business_ref: { type: 'service_order', id: 'order-rustdesk-device-http' },
      rustdesk_id: '123456789',
      display_name: 'LED controller HTTP',
      metadata: { id_server: 'rustdesk-id.example.com' }
    },
    authHeaders(tenantId)
  )) as {
    status: number;
    data: { id: string; rustdesk_id: string; display_name: string; metadata: Record<string, unknown> };
  };
  const byRef = (await route(
    pg,
    'GET',
    '/api/collaboration/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=order-rustdesk-device-http',
    null,
    authHeaders(tenantId)
  )) as { data: Array<{ id: string; rustdesk_id: string }> };
  const fetched = (await route(
    pg,
    'GET',
    `/api/collaboration/rustdesk/devices/${registered.data.id}`,
    null,
    authHeaders(tenantId)
  )) as { data: { id: string; rustdesk_id: string; runtime_status: string; last_seen_at: string | null } };
  const heartbeat = (await route(
    pg,
    'POST',
    `/api/collaboration/rustdesk/devices/${registered.data.id}/heartbeat`,
    {
      actor_identity: 'rustdesk-edge-agent',
      runtime_status: 'online',
      seen_at: '2026-07-04T01:00:00.000Z',
      metadata: {
        client_version: '1.2.3',
        os: 'windows'
      }
    },
    authHeaders(tenantId)
  )) as {
    status: number;
    data: {
      runtime_status: string;
      last_seen_at: string | null;
      last_seen_actor: string;
      metadata: Record<string, unknown>;
    };
  };
  const crossTenantHeartbeat = await route(
    pg,
    'POST',
    `/api/collaboration/rustdesk/devices/${registered.data.id}/heartbeat`,
    { actor_identity: 'other-agent', runtime_status: 'online' },
    authHeaders(otherTenantId)
  );
  const crossTenantFetch = await route(
    pg,
    'GET',
    `/api/collaboration/rustdesk/devices/${registered.data.id}`,
    null,
    authHeaders(otherTenantId)
  );
  const deactivated = (await route(
    pg,
    'POST',
    `/api/collaboration/rustdesk/devices/${registered.data.id}/deactivate`,
    null,
    authHeaders(tenantId)
  )) as { status: number; data: { status: string; deactivated_at: string } };
  const byRefAfterDeactivate = (await route(
    pg,
    'GET',
    '/api/collaboration/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=order-rustdesk-device-http',
    null,
    authHeaders(tenantId)
  )) as { data: unknown[] };

  assert.equal(registered.status, 201);
  assert.equal(registered.data.rustdesk_id, '123456789');
  assert.equal(registered.data.display_name, 'LED controller HTTP');
  assert.equal(registered.data.metadata.id_server, 'rustdesk-id.example.com');
  assert.equal(byRef.data.length, 1);
  assert.equal(byRef.data[0]?.id, registered.data.id);
  assert.equal(fetched.data.id, registered.data.id);
  assert.equal(fetched.data.runtime_status, 'unknown');
  assert.equal(fetched.data.last_seen_at, null);
  assert.equal(heartbeat.status, 201);
  assert.equal(heartbeat.data.runtime_status, 'online');
  assert.equal(heartbeat.data.last_seen_at, '2026-07-04T01:00:00.000Z');
  assert.equal(heartbeat.data.last_seen_actor, 'rustdesk-edge-agent');
  assert.deepEqual(heartbeat.data.metadata.last_heartbeat, {
    actor_identity: 'rustdesk-edge-agent',
    client_version: '1.2.3',
    os: 'windows',
    runtime_status: 'online',
    seen_at: '2026-07-04T01:00:00.000Z'
  });
  assert.deepEqual(crossTenantHeartbeat, { status: 404, data: { error: 'rustdesk device not found' } });
  assert.deepEqual(crossTenantFetch, { status: 404, data: { error: 'rustdesk device not found' } });
  assert.equal(deactivated.status, 201);
  assert.equal(deactivated.data.status, 'inactive');
  assert.equal(typeof deactivated.data.deactivated_at, 'string');
  assert.deepEqual(byRefAfterDeactivate.data, []);
});

test('collaboration HTTP exposes an iveKit RustDesk facade for LED integration', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousEnv = {
    baseUrl: process.env.OPC_BASE_URL,
    launchSecret: process.env.OPC_RUSTDESK_LAUNCH_SECRET,
    publicKey: process.env.OPC_RUSTDESK_PUBLIC_KEY,
    idServer: process.env.OPC_RUSTDESK_ID_SERVER,
    relayServer: process.env.OPC_RUSTDESK_RELAY_SERVER,
    protocolTemplate: process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE,
    requirePhysicalDisconnect: process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT,
    edgeTokenSecret: process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET
  };
  process.env.OPC_BASE_URL = 'https://opc.example.com';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'ivekit-rustdesk-launch-secret';
  process.env.OPC_RUSTDESK_PUBLIC_KEY = RUSTDESK_PUBLIC_KEY;
  process.env.OPC_RUSTDESK_ID_SERVER = 'rustdesk-id.example.com';
  process.env.OPC_RUSTDESK_RELAY_SERVER = 'rustdesk-relay.example.com';
  process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE = 'rustdesk://connect/{rustdesk_id}?session={external_id}';
  process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '1';
  process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET = 'ivekit-http-edge-token-secret-at-least-32-bytes';

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_ivekit_rustdesk_http';
    const businessRef = { type: 'service_order', id: 'SO-ivekit-rustdesk-http' };
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: businessRef },
      authHeaders(tenantId)
    )) as { status: number; data: { id: string } };
    assert.equal(sessionResult.status, 201);
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk'
      },
      authHeaders(tenantId)
    )) as { status: number; data: { id: string } };
    assert.equal(remoteResult.status, 201);
    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-ivekit-rustdesk-http',
        scopes: ['view_screen', 'control_mouse_keyboard', 'record_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );

    const registered = (await route(
      pg,
      'POST',
      '/api/ivekit/rustdesk/devices',
      {
        business_ref: businessRef,
        rustdesk_id: '123456789',
        display_name: 'LED controller via iveKit',
        metadata: { rack: 'A-01' }
      },
      authHeaders(tenantId)
    )) as { status: number; data: { id: string; rustdesk_id: string; metadata: Record<string, unknown> } };
    assert.equal(registered.status, 201);
    assert.equal(registered.data.rustdesk_id, '123456789');
    assert.equal(registered.data.metadata.rack, 'A-01');

    const byRef = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/devices/by-ref?business_ref_type=${businessRef.type}&business_ref_id=${businessRef.id}`,
      null,
      authHeaders(tenantId)
    )) as { data: Array<{ id: string }> };
    assert.equal(byRef.data[0]?.id, registered.data.id);

    const clientConfig = (await route(
      pg,
      'GET',
      '/api/ivekit/rustdesk/client-config',
      null,
      authHeaders(tenantId)
    )) as { data: { manual_fields: { id_server: string; relay_server: string; key: string } } };
    assert.deepEqual(clientConfig.data.manual_fields, {
      id_server: 'rustdesk-id.example.com',
      relay_server: 'rustdesk-relay.example.com',
      key: RUSTDESK_PUBLIC_KEY
    });

    const gatewaySessionInput = {
      remote_session_id: remoteResult.data.id,
      device_id: registered.data.id,
      actor_identity: 'agent-ivekit-rustdesk-http',
      permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen'],
      metadata: { source: 'led-http-facade' }
    };
    await assert.rejects(
      () => route(
        pg,
        'POST',
        '/api/ivekit/rustdesk/gateway-sessions',
        gatewaySessionInput,
        authHeaders(tenantId)
      ),
      /rustdesk device is not online/
    );
    await route(
      pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${registered.data.id}/heartbeat`,
      {
        actor_identity: 'rustdesk-edge-agent',
        runtime_status: 'online',
        seen_at: new Date().toISOString(),
        metadata: { disconnect_command_capable: false }
      },
      authHeaders(tenantId)
    );
    await assert.rejects(
      () => route(
        pg,
        'POST',
        '/api/ivekit/rustdesk/gateway-sessions',
        gatewaySessionInput,
        authHeaders(tenantId)
      ),
      /rustdesk device is not disconnect capable/
    );
    const capableHeartbeatBody = {
      actor_identity: 'body-cannot-assert-edge-identity',
      runtime_status: 'online',
      seen_at: new Date().toISOString(),
      metadata: {
        disconnect_command_capable: true,
        edge_instance_id: 'body-cannot-assert-edge-identity'
      }
    };
    await assert.rejects(
      () => route(
        pg,
        'POST',
        `/api/ivekit/rustdesk/devices/${registered.data.id}/heartbeat`,
        capableHeartbeatBody,
        authHeaders(tenantId)
      ),
      /RustDesk edge command token is required for capable heartbeat/
    );
    const heartbeatToken = createRustDeskEdgeCommandToken({
      tenant_id: tenantId,
      rustdesk_id: '123456789',
      edge_instance_id: 'edge-ivekit-rustdesk-http',
      expires_at: '2099-01-01T00:00:00.000Z'
    }, process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET);
    await route(
      pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${registered.data.id}/heartbeat`,
      capableHeartbeatBody,
      {
        ...authHeaders(tenantId),
        'x-rustdesk-edge-token': heartbeatToken
      }
    );

    const tool = (await route(
      pg,
      'POST',
      '/api/ivekit/rustdesk/gateway-sessions',
      gatewaySessionInput,
      authHeaders(tenantId)
    )) as {
      status: number;
      data: {
        provider: string;
        external_id: string;
        launch_url: string;
        metadata: Record<string, unknown>;
      };
    };
    assert.equal(tool.status, 201);
    assert.equal(tool.data.provider, 'rustdesk');
    assert.match(tool.data.launch_url, /^https:\/\/opc\.example\.com\/remote\/rustdesk\/launch/);
    assert.equal(tool.data.metadata.rustdesk_id, '123456789');
    assert.equal(tool.data.metadata.rustdesk_device_id, registered.data.id);

    const launchPlan = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/launch`,
      null,
      authHeaders(tenantId)
    )) as { data: { status: string; runtime: { rustdesk_id: string }; actions: { can_launch: boolean; protocol_url: string } } };
    assert.equal(launchPlan.data.status, 'active');
    assert.equal(launchPlan.data.runtime.rustdesk_id, '123456789');
    assert.equal(launchPlan.data.actions.can_launch, true);
    assert.equal(
      launchPlan.data.actions.protocol_url,
      `rustdesk://connect/123456789?session=${encodeURIComponent(tool.data.external_id)}`
    );

    const initialAudit = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/audit`,
      null,
      authHeaders(tenantId)
    )) as { data: { events: Array<{ event_type: string; actor_identity: string }> } };
    assert.equal(initialAudit.data.events[0]?.event_type, 'remote.gateway_session.created');
    assert.equal(initialAudit.data.events[0]?.actor_identity, 'agent-ivekit-rustdesk-http');

    const operationEvent = (await route(
      pg,
      'POST',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.control_action.performed',
        actor_identity: 'agent-ivekit-rustdesk-http',
        target: '123456789',
        idempotency_key: 'ivekit-rustdesk-operation-1',
        occurred_at: '2026-07-04T02:00:00.000Z',
        metadata: {
          operation_id: 'op-ivekit-1',
          action: 'mouse.click',
          permission: 'control_mouse_keyboard'
        }
      },
      authHeaders(tenantId)
    )) as {
      status: number;
      data: { event: { event_type: string; metadata: Record<string, unknown>; occurred_at: string } };
    };
    assert.equal(operationEvent.status, 201);
    assert.equal(operationEvent.data.event.event_type, 'remote.rustdesk.control_action.performed');
    assert.equal(operationEvent.data.event.metadata.operation_id, 'op-ivekit-1');
    assert.equal(operationEvent.data.event.occurred_at, '2026-07-04T02:00:00.000Z');

    const auditWithOperation = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/audit`,
      null,
      authHeaders(tenantId)
    )) as { data: { events: Array<{ event_type: string; actor_identity: string }> } };
    assert.deepEqual(auditWithOperation.data.events.map((event) => event.event_type), [
      'remote.gateway_session.created',
      'remote.rustdesk.control_action.performed'
    ]);

    const ended = await route(
      pg,
      'DELETE',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}`,
      { actor_identity: 'agent-ivekit-rustdesk-http' },
      authHeaders(tenantId)
    );
    assert.deepEqual(ended, { status: 204, data: null });

    const disconnectAfterEnd = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/disconnect`,
      null,
      authHeaders(tenantId)
    )) as { data: { status: string; command: { requested_reason: string } } };
    assert.equal(disconnectAfterEnd.data.status, 'pending');
    assert.equal(disconnectAfterEnd.data.command.requested_reason, 'gateway_ended');

    const launchAfterEnd = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/launch`,
      null,
      authHeaders(tenantId)
    )) as { data: { status: string; actions: { can_launch: boolean; protocol_url: string } } };
    assert.equal(launchAfterEnd.data.status, 'ended');
    assert.equal(launchAfterEnd.data.actions.can_launch, false);
    assert.equal(launchAfterEnd.data.actions.protocol_url, '');

    const timelineAfterEnd = (await route(
      pg,
      'GET',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
      null,
      authHeaders(tenantId)
    )) as { data: { tool_sessions: Array<{ external_id: string; status: string }>; audit_events: Array<{ event_type: string }> } };
    assert.equal(
      timelineAfterEnd.data.tool_sessions.find((session) => session.external_id === tool.data.external_id)?.status,
      'ended'
    );
    assert.equal(
      timelineAfterEnd.data.audit_events.some((event) => event.event_type === 'remote.rustdesk.control_action.performed'),
      true
    );
    assert.equal(
      timelineAfterEnd.data.audit_events.some((event) => event.event_type === 'remote.gateway_session.ended'),
      true
    );
    assert.equal(
      timelineAfterEnd.data.audit_events.some((event) => event.event_type === 'remote.tool_session.ended'),
      true
    );

    const eventAfterEnd = await route(
      pg,
      'POST',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.control_action.performed',
        actor_identity: 'agent-ivekit-rustdesk-http',
        metadata: {
          operation_id: 'op-ivekit-after-end',
          action: 'mouse.click',
          permission: 'control_mouse_keyboard'
        }
      },
      authHeaders(tenantId)
    );
    assert.deepEqual(eventAfterEnd, { status: 409, data: { error: 'RustDesk gateway session is not active' } });

    const crossTenantLaunch = await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/launch`,
      null,
      authHeaders('tenant_ivekit_rustdesk_other')
    );
    assert.deepEqual(crossTenantLaunch, { status: 404, data: { error: 'rustdesk gateway session not found' } });
  } finally {
    restoreEnv('OPC_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_RUSTDESK_LAUNCH_SECRET', previousEnv.launchSecret);
    restoreEnv('OPC_RUSTDESK_PUBLIC_KEY', previousEnv.publicKey);
    restoreEnv('OPC_RUSTDESK_ID_SERVER', previousEnv.idServer);
    restoreEnv('OPC_RUSTDESK_RELAY_SERVER', previousEnv.relayServer);
    restoreEnv('OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE', previousEnv.protocolTemplate);
    restoreEnv('OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT', previousEnv.requirePhysicalDisconnect);
    restoreEnv('OPC_RUSTDESK_EDGE_TOKEN_SECRET', previousEnv.edgeTokenSecret);
  }
});

test('collaboration HTTP remote end closes local iveKit RustDesk gateway sessions without external gateway env', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousEnv = {
    baseUrl: process.env.OPC_BASE_URL,
    launchSecret: process.env.OPC_RUSTDESK_LAUNCH_SECRET,
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    gatewayBaseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    gatewayToken: process.env.OPC_REMOTE_GATEWAY_API_TOKEN,
    rustdeskBaseUrl: process.env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL,
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN
  };
  process.env.OPC_BASE_URL = 'https://opc.example.com';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'ivekit-rustdesk-local-end-secret';
  delete process.env.OPC_REMOTE_GATEWAY_PROVIDER;
  delete process.env.OPC_REMOTE_GATEWAY_BASE_URL;
  delete process.env.OPC_REMOTE_GATEWAY_API_TOKEN;
  delete process.env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL;
  delete process.env.OPC_RUSTDESK_API_TOKEN;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_ivekit_rustdesk_local_end_http';
    const businessRef = { type: 'service_order', id: 'SO-ivekit-rustdesk-local-end-http' };
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: businessRef },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-local-rustdesk-end',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );
    const registered = (await route(
      pg,
      'POST',
      '/api/ivekit/rustdesk/devices',
      {
        business_ref: businessRef,
        rustdesk_id: '223344556',
        display_name: 'LED local RustDesk end PC'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const tool = (await route(
      pg,
      'POST',
      '/api/ivekit/rustdesk/gateway-sessions',
      {
        remote_session_id: remoteResult.data.id,
        device_id: registered.data.id,
        actor_identity: 'agent-local-rustdesk-end',
        permissions: ['view_screen']
      },
      authHeaders(tenantId)
    )) as { data: { external_id: string } };

    const endedRemote = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/end`,
      { actor_identity: 'agent-local-rustdesk-end' },
      authHeaders(tenantId)
    )) as {
      status: number;
      data: { status: string; physical_disconnect?: { status: string; command_id?: string } };
    };
    const disconnectAfterRemoteEnd = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/disconnect`,
      null,
      authHeaders(tenantId)
    )) as { data: { status: string; command: { requested_reason: string } } };
    const launchAfterEnd = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/launch`,
      null,
      authHeaders(tenantId)
    )) as { data: { status: string; actions: { can_launch: boolean } } };
    const timeline = (await route(
      pg,
      'GET',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
      null,
      authHeaders(tenantId)
    )) as { data: { tool_sessions: Array<{ external_id: string; status: string }>; audit_events: Array<{ event_type: string }> } };

    assert.equal(endedRemote.status, 201);
    assert.equal(endedRemote.data.status, 'ended');
    assert.equal(endedRemote.data.physical_disconnect?.status, 'pending');
    assert.equal(disconnectAfterRemoteEnd.data.status, 'pending');
    assert.equal(disconnectAfterRemoteEnd.data.command.requested_reason, 'remote_session_ended');
    assert.equal(launchAfterEnd.data.status, 'ended');
    assert.equal(launchAfterEnd.data.actions.can_launch, false);
    assert.equal(
      timeline.data.tool_sessions.find((session) => session.external_id === tool.data.external_id)?.status,
      'ended'
    );
    assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.gateway_session.ended'), true);
    assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.tool_session.ended'), true);
  } finally {
    restoreEnv('OPC_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_RUSTDESK_LAUNCH_SECRET', previousEnv.launchSecret);
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.gatewayBaseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.gatewayToken);
    restoreEnv('OPC_RUSTDESK_CONTROL_PLANE_BASE_URL', previousEnv.rustdeskBaseUrl);
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
  }
});

test('collaboration HTTP consent revoke closes local iveKit RustDesk gateway sessions without external gateway env', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousEnv = {
    baseUrl: process.env.OPC_BASE_URL,
    launchSecret: process.env.OPC_RUSTDESK_LAUNCH_SECRET,
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    gatewayBaseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    gatewayToken: process.env.OPC_REMOTE_GATEWAY_API_TOKEN,
    rustdeskBaseUrl: process.env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL,
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN
  };
  process.env.OPC_BASE_URL = 'https://opc.example.com';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'ivekit-rustdesk-local-revoke-secret';
  delete process.env.OPC_REMOTE_GATEWAY_PROVIDER;
  delete process.env.OPC_REMOTE_GATEWAY_BASE_URL;
  delete process.env.OPC_REMOTE_GATEWAY_API_TOKEN;
  delete process.env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL;
  delete process.env.OPC_RUSTDESK_API_TOKEN;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_ivekit_rustdesk_local_revoke_http';
    const businessRef = { type: 'service_order', id: 'SO-ivekit-rustdesk-local-revoke-http' };
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: businessRef },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-local-rustdesk-revoke',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );
    const registered = (await route(
      pg,
      'POST',
      '/api/ivekit/rustdesk/devices',
      {
        business_ref: businessRef,
        rustdesk_id: '334455667',
        display_name: 'LED local RustDesk revoke PC'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const tool = (await route(
      pg,
      'POST',
      '/api/ivekit/rustdesk/gateway-sessions',
      {
        remote_session_id: remoteResult.data.id,
        device_id: registered.data.id,
        actor_identity: 'agent-local-rustdesk-revoke',
        permissions: ['view_screen']
      },
      authHeaders(tenantId)
    )) as { data: { external_id: string } };

    const revoked = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/revoke`,
      {
        actor_identity: 'customer-local-rustdesk-revoke',
        scopes: ['view_screen']
      },
      authHeaders(tenantId)
    )) as {
      status: number;
      data: { event_type: string; physical_disconnect?: { status: string; command_id?: string } };
    };
    const disconnectAfterRevoke = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/disconnect`,
      null,
      authHeaders(tenantId)
    )) as { data: { status: string; command: { requested_reason: string } } };
    const launchAfterRevoke = (await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/gateway-sessions/${tool.data.external_id}/launch`,
      null,
      authHeaders(tenantId)
    )) as { data: { status: string; actions: { can_launch: boolean } } };
    const timeline = (await route(
      pg,
      'GET',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
      null,
      authHeaders(tenantId)
    )) as { data: { tool_sessions: Array<{ external_id: string; status: string }>; audit_events: Array<{ event_type: string }> } };

    assert.equal(revoked.status, 201);
    assert.equal(revoked.data.event_type, 'revoked');
    assert.equal(revoked.data.physical_disconnect?.status, 'pending');
    assert.equal(disconnectAfterRevoke.data.status, 'pending');
    assert.equal(disconnectAfterRevoke.data.command.requested_reason, 'consent_revoked');
    assert.equal(launchAfterRevoke.data.status, 'ended');
    assert.equal(launchAfterRevoke.data.actions.can_launch, false);
    assert.equal(
      timeline.data.tool_sessions.find((session) => session.external_id === tool.data.external_id)?.status,
      'ended'
    );
    assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.gateway_session.ended'), true);
    assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.tool_session.ended'), true);
  } finally {
    restoreEnv('OPC_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_RUSTDESK_LAUNCH_SECRET', previousEnv.launchSecret);
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.gatewayBaseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.gatewayToken);
    restoreEnv('OPC_RUSTDESK_CONTROL_PLANE_BASE_URL', previousEnv.rustdeskBaseUrl);
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
  }
});

test('collaboration HTTP can explicitly end remote tool and assistance sessions', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantId = 'tenant_collab_end_http';

  const sessionResult = (await route(
    pg,
    'POST',
    '/api/collaboration/sessions',
    { business_ref: { type: 'service_order', id: 'order-end-http' } },
    authHeaders(tenantId)
  )) as { data: { id: string } };
  const remoteResult = (await route(
    pg,
    'POST',
    '/api/collaboration/remote-assistance/sessions',
    {
      collaboration_session_id: sessionResult.data.id,
      mode: 'third_party_remote_tool',
      adapter_provider: 'rustdesk'
    },
    authHeaders(tenantId)
  )) as { data: { id: string } };
  await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
    {
      actor_identity: 'customer-end-http',
      scopes: ['view_screen'],
      expires_at: '2099-01-01T00:00:00.000Z'
    },
    authHeaders(tenantId)
  );

  const toolResult = (await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools`,
    {
      actor_identity: 'agent-end-http',
      provider: 'anydesk',
      external_id: 'ad-end-http-1',
      launch_url: 'https://remote.example/ad-end-http-1'
    },
    authHeaders(tenantId)
  )) as { data: { id: string; status: string } };
  assert.equal(toolResult.data.status, 'active');

  const endedTool = (await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/end`,
    {
      actor_identity: 'agent-end-http',
      tool_session_id: toolResult.data.id
    },
    authHeaders(tenantId)
  )) as { status: number; data: { id: string; status: string } };
  assert.equal(endedTool.status, 201);
  assert.equal(endedTool.data.id, toolResult.data.id);
  assert.equal(endedTool.data.status, 'ended');

  const activeTool = (await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools`,
    {
      actor_identity: 'agent-end-http',
      provider: 'anydesk',
      external_id: 'ad-end-http-2',
      launch_url: 'https://remote.example/ad-end-http-2'
    },
    authHeaders(tenantId)
  )) as { data: { id: string; status: string } };
  assert.equal(activeTool.data.status, 'active');

  const endedRemote = (await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/end`,
    { actor_identity: 'agent-end-http' },
    authHeaders(tenantId)
  )) as { status: number; data: { id: string; status: string } };
  assert.equal(endedRemote.status, 201);
  assert.equal(endedRemote.data.id, remoteResult.data.id);
  assert.equal(endedRemote.data.status, 'ended');

  const timeline = (await route(
    pg,
    'GET',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
    null,
    authHeaders(tenantId)
  )) as {
    data: {
      session: { status: string };
      tool_sessions: Array<{ id: string; status: string }>;
      audit_events: Array<{ event_type: string }>;
    };
  };
  assert.equal(timeline.data.session.status, 'ended');
  assert.equal(timeline.data.tool_sessions.find((tool) => tool.id === activeTool.data.id)?.status, 'ended');
  assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.tool_session.ended'), true);
  assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.session.ended'), true);
});

test('collaboration HTTP verifies Web Assist join tokens without API auth', async () => {
  process.env.OPC_API_KEY = API_KEY;
  process.env.IVEKIT_WEB_ASSIST_SECRET = 'collaboration-web-assist-secret';
  const pg = new MemoryPg();
  const tenantId = 'tenant_web_assist_http';

  const sessionResult = (await route(
    pg,
    'POST',
    '/api/collaboration/sessions',
    {
      title: 'Web Assist token session',
      business_ref: { type: 'service_order', id: 'order-web-assist-http' }
    },
    authHeaders(tenantId)
  )) as { status: number; data: { id: string } };

  const remoteResult = (await route(
    pg,
    'POST',
    '/api/collaboration/remote-assistance/sessions',
    {
      collaboration_session_id: sessionResult.data.id,
      mode: 'web_remote_assist',
      adapter_provider: 'ivekit_web'
    },
    authHeaders(tenantId)
  )) as { status: number; data: { id: string } };

  const joinPath = createWebAssistJoinPath({
    tenant_id: tenantId,
    remote_session_id: remoteResult.data.id,
    actor_identity: 'engineer-http',
    role: 'engineer',
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const token = new URL(`http://localhost${joinPath}`).searchParams.get('token')!;

  const verified = (await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/web-assist/verify`,
    { tenant_id: tenantId, token },
    {}
  )) as {
    data: {
      tenant_id: string;
      remote_session_id: string;
      actor_identity: string;
      role: string;
    };
  };

  assert.equal(verified.data.tenant_id, tenantId);
  assert.equal(verified.data.remote_session_id, remoteResult.data.id);
  assert.equal(verified.data.actor_identity, 'engineer-http');
  assert.equal(verified.data.role, 'engineer');

  await assert.rejects(
    () =>
      route(
        pg,
        'POST',
        `/api/collaboration/remote-assistance/${remoteResult.data.id}/web-assist/verify`,
        { tenant_id: tenantId, token: `${token}x` },
        {}
      ),
    /invalid Web Assist token/
  );
});

test('collaboration HTTP records denied remote consent and keeps tools blocked', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantId = 'tenant_collab_deny';

  const sessionResult = (await route(
    pg,
    'POST',
    '/api/collaboration/sessions',
    { business_ref: { type: 'support_ticket', id: 'ticket-deny' } },
    authHeaders(tenantId)
  )) as { data: { id: string } };
  const remoteResult = (await route(
    pg,
    'POST',
    '/api/collaboration/remote-assistance/sessions',
    { collaboration_session_id: sessionResult.data.id, mode: 'platform_remote_control' },
    authHeaders(tenantId)
  )) as { data: { id: string } };

  await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/request`,
    { scopes: ['view_screen', 'control_mouse_keyboard'] },
    authHeaders(tenantId)
  );
  const denied = (await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/deny`,
    { actor_identity: 'customer-deny', scopes: ['view_screen', 'control_mouse_keyboard'] },
    authHeaders(tenantId)
  )) as { status: number; data: { event_type: string } };
  assert.equal(denied.status, 201);
  assert.equal(denied.data.event_type, 'denied');

  await assert.rejects(
    () =>
      route(
        pg,
        'POST',
        `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools`,
        { provider: 'anydesk', external_id: 'blocked' },
        authHeaders(tenantId)
      ),
    /active consent required/
  );

  const timeline = (await route(
    pg,
    'GET',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
    null,
    authHeaders(tenantId)
  )) as { data: { consent_events: Array<{ event_type: string }>; audit_events: Array<{ event_type: string }> } };
  assert.deepEqual(timeline.data.consent_events.map((event) => event.event_type), ['requested', 'denied']);
  assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.consent.denied'), true);
});

test('collaboration HTTP can start a configured remote gateway tool session', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    token: process.env.OPC_REMOTE_GATEWAY_API_TOKEN
  };
  process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'meshcentral';
  process.env.OPC_REMOTE_GATEWAY_BASE_URL = 'https://mesh.example';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'mesh-token';
  const gatewayCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = String(input);
    gatewayCalls.push({ url: requestUrl, init });
    if (requestUrl === 'https://mesh.example/api/opc/meshcentral/sessions' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          external_id: 'mesh-http-gateway-1',
          launch_url: 'https://mesh.example/control/mesh-http-gateway-1',
          target: { type: 'device', id: 'device-http-gateway', display_name: 'HTTP gateway device' },
          permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
          metadata: { node_id: 'device-http-gateway' }
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ error: 'unexpected gateway request' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_collab_gateway_http';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-gateway-http' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'meshcentral'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-gateway-http',
        scopes: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );
    const tool = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/gateway`,
      {
        actor_identity: 'agent-gateway-http',
        target: { type: 'device', id: 'device-http-gateway', display_name: 'HTTP gateway device' },
        permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
        metadata: { source: 'http-test' }
      },
      authHeaders(tenantId)
    )) as {
      status: number;
      data: { provider: string; external_id: string; launch_url: string; metadata: Record<string, unknown> };
    };

    assert.equal(tool.status, 201);
    assert.equal(tool.data.provider, 'meshcentral');
    assert.equal(tool.data.external_id, 'mesh-http-gateway-1');
    assert.equal(tool.data.launch_url, 'https://mesh.example/control/mesh-http-gateway-1');
    assert.equal(tool.data.metadata.gateway_provider, 'meshcentral');
    assert.equal(tool.data.metadata.target_id, 'device-http-gateway');
    assert.equal(gatewayCalls.length, 1);
    assert.equal((gatewayCalls[0]?.init?.headers as Record<string, string>).authorization, 'Bearer mesh-token');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP can sync configured remote gateway audit into timeline', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    token: process.env.OPC_REMOTE_GATEWAY_API_TOKEN
  };
  process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'meshcentral';
  process.env.OPC_REMOTE_GATEWAY_BASE_URL = 'https://mesh.example';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'mesh-token';
  const gatewayCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = String(input);
    gatewayCalls.push({ url: requestUrl, init });
    if (requestUrl === 'https://mesh.example/api/opc/meshcentral/sessions' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          external_id: 'mesh-http-audit-1',
          launch_url: 'https://mesh.example/control/mesh-http-audit-1',
          target: { type: 'device', id: 'device-http-audit' },
          permissions: ['view_screen'],
          metadata: {}
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl === 'https://mesh.example/api/opc/meshcentral/sessions/mesh-http-audit-1/audit?since=2026-06-30T00%3A00%3A00.000Z') {
      return new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'meshcentral.mouse.click',
              actor_identity: 'agent-gateway-http',
              target: 'device-http-audit',
              metadata: { button: 'left' },
              occurred_at: '2026-06-30T00:01:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ error: 'unexpected gateway request' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_collab_gateway_audit_http';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-gateway-audit-http' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'meshcentral'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-gateway-http',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );
    const tool = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/gateway`,
      {
        actor_identity: 'agent-gateway-http',
        target: { type: 'device', id: 'device-http-audit' },
        permissions: ['view_screen']
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    const otherSessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-gateway-audit-http-other' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const otherRemoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: otherSessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'meshcentral'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const wrongRemoteSync = await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${otherRemoteResult.data.id}/audit/gateway-sync`,
      {
        actor_identity: 'agent-gateway-http',
        tool_session_id: tool.data.id
      },
      authHeaders(tenantId)
    );
    assert.deepEqual(wrongRemoteSync, { status: 404, data: { error: 'remote tool session not found' } });

    const synced = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/audit/gateway-sync`,
      {
        actor_identity: 'agent-gateway-http',
        tool_session_id: tool.data.id,
        since: '2026-06-30T00:00:00.000Z'
      },
      authHeaders(tenantId)
    )) as { status: number; data: { synced: number; events: Array<{ event_type: string; metadata: Record<string, unknown> }> } };

    assert.equal(synced.status, 201);
    assert.equal(synced.data.synced, 1);
    assert.equal(synced.data.events[0]?.event_type, 'meshcentral.mouse.click');
    assert.equal(synced.data.events[0]?.metadata.gateway_provider, 'meshcentral');
    assert.equal(synced.data.events[0]?.metadata.gateway_external_id, 'mesh-http-audit-1');
    const timeline = (await route(
      pg,
      'GET',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
      null,
      authHeaders(tenantId)
    )) as { data: { audit_events: Array<{ event_type: string }> } };
    assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'meshcentral.mouse.click'), true);
    assert.equal(gatewayCalls.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP revoke ends configured remote gateway upstream session', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    token: process.env.OPC_REMOTE_GATEWAY_API_TOKEN
  };
  process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'meshcentral';
  process.env.OPC_REMOTE_GATEWAY_BASE_URL = 'https://mesh.example';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'mesh-token';
  const gatewayCalls: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = String(input);
    gatewayCalls.push({ url: requestUrl, method: init?.method });
    if (requestUrl === 'https://mesh.example/api/opc/meshcentral/sessions' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          external_id: 'mesh-http-revoke-1',
          launch_url: 'https://mesh.example/control/mesh-http-revoke-1',
          target: { type: 'device', id: 'device-http-revoke' },
          permissions: ['view_screen'],
          metadata: {}
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl === 'https://mesh.example/api/opc/meshcentral/sessions/mesh-http-revoke-1' && init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (requestUrl === 'https://mesh.example/api/opc/meshcentral/sessions/mesh-http-revoke-1/audit' && init?.method === 'GET') {
      return new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'remote.gateway_session.ended',
              actor_identity: 'customer-gateway-http',
              target: 'mesh-http-revoke-1',
              metadata: { reason: 'consent_revoked' },
              occurred_at: '2026-06-30T00:02:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ error: 'unexpected gateway request' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_collab_gateway_revoke_http';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-gateway-revoke-http' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'meshcentral'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-gateway-http',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );
    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/gateway`,
      {
        actor_identity: 'agent-gateway-http',
        target: { type: 'device', id: 'device-http-revoke' },
        permissions: ['view_screen']
      },
      authHeaders(tenantId)
    );

    const revoked = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/revoke`,
      {
        actor_identity: 'customer-gateway-http',
        scopes: ['view_screen']
      },
      authHeaders(tenantId)
    )) as { status: number; data: { event_type: string } };

    assert.equal(revoked.status, 201);
    assert.equal(revoked.data.event_type, 'revoked');
    assert.equal(
      gatewayCalls.some((call) => call.url === 'https://mesh.example/api/opc/meshcentral/sessions/mesh-http-revoke-1' && call.method === 'DELETE'),
      true
    );
    const timeline = (await route(
      pg,
      'GET',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
      null,
      authHeaders(tenantId)
    )) as { data: { audit_events: Array<{ event_type: string }> } };
    assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.gateway_session.ended'), true);
    assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.tool_session.ended'), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP can start sync and revoke a configured RustDesk gateway session', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    token: process.env.OPC_REMOTE_GATEWAY_API_TOKEN
  };
  process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'rustdesk';
  process.env.OPC_REMOTE_GATEWAY_BASE_URL = 'https://opc.example.com';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'rustdesk-token';
  const gatewayCalls: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = String(input);
    gatewayCalls.push({ url: requestUrl, method: init?.method });
    if (requestUrl === 'https://opc.example.com/api/opc/rustdesk/sessions' && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          external_id: 'rustdesk-http-session-1',
          launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rustdesk-http-session-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
          target: { type: 'device', id: '123456789', display_name: 'RustDesk LED controller' },
          permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
          metadata: { rustdesk_id: '123456789', id_server: 'rustdesk-id.example.com' }
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl === 'https://opc.example.com/api/opc/rustdesk/sessions/rustdesk-http-session-1/audit?since=2026-07-03T00%3A00%3A00.000Z') {
      return new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'remote.rustdesk.control_action.performed',
              actor_identity: 'agent-rustdesk-http',
              target: '123456789',
              metadata: {
                idempotency_key: 'control-action-rustdesk-http-1',
                operation_id: 'control-action-rustdesk-http-1',
                action: 'mouse_click',
                permission: 'control_mouse_keyboard',
                button: 'left'
              },
              occurred_at: '2026-07-03T00:01:00.000Z'
            },
            {
              event_type: 'remote.rustdesk.file_transfer.started',
              actor_identity: 'agent-rustdesk-http',
              target: '123456789',
              metadata: {
                idempotency_key: 'file-transfer-rustdesk-http-1',
                transfer_id: 'transfer-rustdesk-http-1',
                direction: 'upload'
              },
              occurred_at: '2026-07-03T00:01:01.000Z'
            },
            {
              event_type: 'remote.rustdesk.recording.started',
              actor_identity: 'agent-rustdesk-http',
              target: '123456789',
              metadata: {
                idempotency_key: 'recording-rustdesk-http-1',
                recording_id: 'recording-rustdesk-http-1',
                evidence_type: 'screen_recording'
              },
              occurred_at: '2026-07-03T00:01:02.000Z'
            },
            {
              event_type: 'remote.rustdesk.clipboard.synced',
              actor_identity: 'agent-rustdesk-http',
              target: '123456789',
              metadata: {
                idempotency_key: 'clipboard-rustdesk-http-1',
                clipboard_id: 'clipboard-rustdesk-http-1',
                direction: 'agent_to_device',
                format: 'text'
              },
              occurred_at: '2026-07-03T00:01:03.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl === 'https://opc.example.com/api/opc/rustdesk/sessions/rustdesk-http-session-1/audit?since=2026-07-04T00%3A00%3A00.000Z') {
      return new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'remote.rustdesk.clipboard.synced',
              actor_identity: 'agent-rustdesk-http',
              target: '123456789',
              metadata: {
                idempotency_key: 'clipboard-rustdesk-http-invalid',
                direction: 'agent_to_device'
              },
              occurred_at: '2026-07-04T00:01:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl === 'https://opc.example.com/api/opc/rustdesk/sessions/rustdesk-http-session-1' && init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (requestUrl === 'https://opc.example.com/api/opc/rustdesk/sessions/rustdesk-http-session-1/audit' && init?.method === 'GET') {
      return new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'remote.gateway_session.ended',
              actor_identity: 'customer-rustdesk-http',
              target: 'rustdesk-http-session-1',
              metadata: { reason: 'consent_revoked' },
              occurred_at: '2026-07-03T00:02:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ error: 'unexpected gateway request' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_collab_rustdesk_http';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-rustdesk-http' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-rustdesk-http',
        scopes: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );
    const tool = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/gateway`,
      {
        actor_identity: 'agent-rustdesk-http',
        target: { type: 'device', id: '123456789', display_name: 'RustDesk LED controller' },
        permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
        metadata: { source: 'rustdesk-http-test', rustdesk_target_mode: 'raw_id' }
      },
      authHeaders(tenantId)
    )) as {
      status: number;
      data: { id: string; provider: string; external_id: string; launch_url: string; metadata: Record<string, unknown> };
    };
    await assert.rejects(
      () =>
        route(
          pg,
          'POST',
          `/api/collaboration/remote-assistance/${remoteResult.data.id}/audit/gateway-sync`,
          {
            actor_identity: 'agent-rustdesk-http',
            tool_session_id: tool.data.id,
            since: '2026-07-04T00:00:00.000Z'
          },
          authHeaders(tenantId)
        ),
      /RustDesk clipboard event metadata.clipboard_id is required/
    );
    const synced = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/audit/gateway-sync`,
      {
        actor_identity: 'agent-rustdesk-http',
        tool_session_id: tool.data.id,
        since: '2026-07-03T00:00:00.000Z'
      },
      authHeaders(tenantId)
    )) as { status: number; data: { synced: number; events: Array<{ event_type: string; metadata: Record<string, unknown> }> } };
    const syncedRetry = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/audit/gateway-sync`,
      {
        actor_identity: 'agent-rustdesk-http',
        tool_session_id: tool.data.id,
        since: '2026-07-03T00:00:00.000Z'
      },
      authHeaders(tenantId)
    )) as { status: number; data: { synced: number; events: Array<{ event_type: string; metadata: Record<string, unknown> }> } };
    const revoked = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/revoke`,
      {
        actor_identity: 'customer-rustdesk-http',
        scopes: ['view_screen']
      },
      authHeaders(tenantId)
    )) as { status: number; data: { event_type: string } };

    assert.equal(tool.status, 201);
    assert.equal(tool.data.provider, 'rustdesk');
    assert.equal(tool.data.external_id, 'rustdesk-http-session-1');
    assert.equal(tool.data.launch_url, 'https://opc.example.com/remote/rustdesk/launch?session_id=rustdesk-http-session-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z');
    assert.equal(tool.data.metadata.gateway_provider, 'rustdesk');
    assert.equal(tool.data.metadata.rustdesk_id, '123456789');
    assert.equal(synced.status, 201);
    assert.equal(synced.data.synced, 4);
    assert.deepEqual(synced.data.events.map((event) => event.event_type), [
      'remote.rustdesk.control_action.performed',
      'remote.rustdesk.file_transfer.started',
      'remote.rustdesk.recording.started',
      'remote.rustdesk.clipboard.synced'
    ]);
    assert.equal(synced.data.events[0]?.metadata.gateway_provider, 'rustdesk');
    assert.equal(syncedRetry.status, 201);
    assert.equal(syncedRetry.data.synced, 0);
    assert.deepEqual(syncedRetry.data.events, []);
    assert.equal(revoked.status, 201);
    assert.equal(
      gatewayCalls.some((call) => call.url === 'https://opc.example.com/api/opc/rustdesk/sessions/rustdesk-http-session-1' && call.method === 'DELETE'),
      true
    );
    const timeline = (await route(
      pg,
      'GET',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
      null,
      authHeaders(tenantId)
    )) as { data: { audit_events: Array<{ event_type: string }> } };
    const rustdeskOperationEvents = timeline.data.audit_events.filter((event) =>
      event.event_type.startsWith('remote.rustdesk.')
    );
    assert.deepEqual(rustdeskOperationEvents.map((event) => event.event_type), [
      'remote.rustdesk.control_action.performed',
      'remote.rustdesk.file_transfer.started',
      'remote.rustdesk.recording.started',
      'remote.rustdesk.clipboard.synced'
    ]);
    assert.equal(timeline.data.audit_events.some((event) => event.event_type === 'remote.gateway_session.ended'), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP rejects RustDesk gateway sync events outside session permissions', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    token: process.env.OPC_REMOTE_GATEWAY_API_TOKEN
  };
  process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'rustdesk';
  process.env.OPC_REMOTE_GATEWAY_BASE_URL = 'https://opc.example.com';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'rustdesk-token';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = String(input);
    if (requestUrl === 'https://opc.example.com/api/opc/rustdesk/sessions' && init?.method === 'POST') {
      return jsonResponse(201, {
        external_id: 'rustdesk-http-session-ungranted-1',
        launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rustdesk-http-session-ungranted-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
        target: { type: 'device', id: '123456789', display_name: 'RustDesk LED controller' },
        permissions: ['view_screen'],
        metadata: { rustdesk_id: '123456789' }
      });
    }
    if (requestUrl === 'https://opc.example.com/api/opc/rustdesk/sessions/rustdesk-http-session-ungranted-1/audit?since=2026-07-03T00%3A00%3A00.000Z') {
      return jsonResponse(200, {
        events: [
          {
            event_type: 'remote.rustdesk.file_transfer.completed',
            actor_identity: 'agent-rustdesk-http',
            target: '123456789',
            metadata: {
              idempotency_key: 'file-transfer-rustdesk-ungranted-completed-1',
              transfer_id: 'transfer-rustdesk-ungranted-1',
              direction: 'upload'
            },
            occurred_at: '2026-07-03T00:01:01.000Z'
          }
        ]
      });
    }
    return jsonResponse(500, { error: 'unexpected gateway request' });
  }) as typeof fetch;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_collab_rustdesk_sync_permissions';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-rustdesk-sync-permissions' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-rustdesk-http',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );
    const tool = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/gateway`,
      {
        actor_identity: 'agent-rustdesk-http',
        target: { type: 'device', id: '123456789', display_name: 'RustDesk LED controller' },
        permissions: ['view_screen'],
        metadata: { source: 'rustdesk-http-permission-test', rustdesk_target_mode: 'raw_id' }
      },
      authHeaders(tenantId)
    )) as { status: number; data: { id: string } };

    assert.equal(tool.status, 201);
    await assert.rejects(
      () =>
        route(
          pg,
          'POST',
          `/api/collaboration/remote-assistance/${remoteResult.data.id}/audit/gateway-sync`,
          {
            actor_identity: 'agent-rustdesk-http',
            tool_session_id: tool.data.id,
            since: '2026-07-03T00:00:00.000Z'
          },
          authHeaders(tenantId)
        ),
      /RustDesk file transfer event requires transfer_file permission/
    );
    const timeline = (await route(
      pg,
      'GET',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
      null,
      authHeaders(tenantId)
    )) as { data: { audit_events: Array<{ event_type: string }> } };
    assert.equal(
      timeline.data.audit_events.some((event) => event.event_type === 'remote.rustdesk.file_transfer.completed'),
      false
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP resolves registered RustDesk devices before starting gateway sessions', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    token: process.env.OPC_REMOTE_GATEWAY_API_TOKEN
  };
  process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'rustdesk';
  process.env.OPC_REMOTE_GATEWAY_BASE_URL = 'https://opc.example.com';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'rustdesk-token';
  const gatewayBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    gatewayBodies.push(body);
    return new Response(
      JSON.stringify({
        external_id: 'rustdesk-registered-device-session-1',
        launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rustdesk-registered-device-session-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
        target: { type: 'device', id: '123456789', display_name: 'LED registered RustDesk controller' },
        permissions: ['view_screen', 'control_mouse_keyboard'],
        metadata: { rustdesk_id: '123456789' }
      }),
      { status: 201, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_collab_rustdesk_registered_gateway';
    const registered = (await route(
      pg,
      'POST',
      '/api/collaboration/rustdesk/devices',
      {
        business_ref: { type: 'service_order', id: 'order-rustdesk-registered-gateway' },
        rustdesk_id: '123456789',
        display_name: 'LED registered RustDesk controller'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-rustdesk-registered-gateway' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-rustdesk-registered',
        scopes: ['view_screen', 'control_mouse_keyboard'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );
    const tool = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/gateway`,
      {
        actor_identity: 'agent-rustdesk-registered',
        target: { type: 'device', id: registered.data.id },
        permissions: ['view_screen', 'control_mouse_keyboard']
      },
      authHeaders(tenantId)
    )) as { status: number; data: { provider: string; metadata: Record<string, unknown> } };

    assert.equal(tool.status, 201);
    assert.equal(tool.data.provider, 'rustdesk');
    assert.equal((gatewayBodies[0]?.target as { id?: string } | undefined)?.id, '123456789');
    assert.equal(tool.data.metadata.target_id, registered.data.id);
    assert.equal(tool.data.metadata.rustdesk_id, '123456789');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP requires online heartbeat for registered RustDesk gateway targets when enabled', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    token: process.env.OPC_REMOTE_GATEWAY_API_TOKEN,
    requireOnline: process.env.OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE,
    onlineTtlMs: process.env.OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS
  };
  process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'rustdesk';
  process.env.OPC_REMOTE_GATEWAY_BASE_URL = 'https://opc.example.com';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'rustdesk-token';
  process.env.OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE = '1';
  process.env.OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS = '600000';
  let gatewayCalls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    gatewayCalls += 1;
    return jsonResponse(201, {
      external_id: 'rustdesk-offline-device-session',
      launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rustdesk-offline-device-session&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
      target: { type: 'device', id: '123456789' },
      permissions: ['view_screen'],
      metadata: { rustdesk_id: '123456789' }
    });
  }) as typeof fetch;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_collab_rustdesk_require_online';
    const registered = (await route(
      pg,
      'POST',
      '/api/collaboration/rustdesk/devices',
      {
        business_ref: { type: 'service_order', id: 'order-rustdesk-require-online' },
        rustdesk_id: '123456789',
        display_name: 'LED RustDesk controller'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-rustdesk-require-online' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-rustdesk-online-required',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );

    await assert.rejects(
      () =>
        route(
          pg,
          'POST',
          `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/gateway`,
          {
            actor_identity: 'agent-rustdesk-online-required',
            target: { type: 'device', id: registered.data.id },
            permissions: ['view_screen']
          },
          authHeaders(tenantId)
        ),
      /rustdesk device is not online/
    );
    assert.equal(gatewayCalls, 0);

    await route(
      pg,
      'POST',
      `/api/collaboration/rustdesk/devices/${registered.data.id}/heartbeat`,
      {
        actor_identity: 'rustdesk-edge-agent',
        runtime_status: 'online',
        seen_at: new Date().toISOString()
      },
      authHeaders(tenantId)
    );
    process.env.OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS = 'soon';

    await assert.rejects(
      () =>
        route(
          pg,
          'POST',
          `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/gateway`,
          {
            actor_identity: 'agent-rustdesk-online-required',
            target: { type: 'device', id: registered.data.id },
            permissions: ['view_screen']
          },
          authHeaders(tenantId)
        ),
      /OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS must be a number >= 100/
    );
    assert.equal(gatewayCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.token);
    restoreEnv('OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE', previousEnv.requireOnline);
    restoreEnv('OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS', previousEnv.onlineTtlMs);
  }
});

test('collaboration HTTP rejects unsupported gateway permission scopes before calling gateway', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    token: process.env.OPC_REMOTE_GATEWAY_API_TOKEN
  };
  process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'rustdesk';
  process.env.OPC_REMOTE_GATEWAY_BASE_URL = 'https://opc.example.com';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'rustdesk-token';
  let gatewayCalls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    gatewayCalls += 1;
    return jsonResponse(201, {
      external_id: 'rustdesk-invalid-permission-session',
      launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rustdesk-invalid-permission-session&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
      target: { type: 'device', id: '123456789' },
      permissions: ['view_screen', 'root_shell'],
      metadata: { rustdesk_id: '123456789' }
    });
  }) as typeof fetch;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_collab_rustdesk_invalid_gateway_scope';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-rustdesk-invalid-gateway-scope' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-rustdesk-invalid-scope',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );
    const result = await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/gateway`,
      {
        actor_identity: 'agent-rustdesk-invalid-scope',
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen', 'root_shell'],
        metadata: { rustdesk_target_mode: 'raw_id' }
      },
      authHeaders(tenantId)
    );

    assert.deepEqual(result, { status: 400, data: { error: 'unsupported remote gateway permission scope: root_shell' } });
    assert.equal(gatewayCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP rejects RustDesk gateway permissions outside active consent scopes', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    token: process.env.OPC_REMOTE_GATEWAY_API_TOKEN
  };
  process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'rustdesk';
  process.env.OPC_REMOTE_GATEWAY_BASE_URL = 'https://opc.example.com';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'rustdesk-token';
  let gatewayCalls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    gatewayCalls += 1;
    return jsonResponse(201, {
      external_id: 'rustdesk-ungranted-permission-session',
      launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rustdesk-ungranted-permission-session&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
      target: { type: 'device', id: '123456789' },
      permissions: ['control_mouse_keyboard'],
      metadata: { rustdesk_id: '123456789' }
    });
  }) as typeof fetch;

  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_collab_rustdesk_ungranted_gateway_scope';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-rustdesk-ungranted-gateway-scope' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remoteResult = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: sessionResult.data.id,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
      {
        actor_identity: 'customer-rustdesk-view-only',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );
    await assert.rejects(
      () =>
        route(
          pg,
          'POST',
          `/api/collaboration/remote-assistance/${remoteResult.data.id}/tools/gateway`,
          {
            actor_identity: 'agent-rustdesk-control-without-consent',
            target: { type: 'device', id: '123456789' },
            permissions: ['control_mouse_keyboard'],
            metadata: { rustdesk_target_mode: 'raw_id' }
          },
          authHeaders(tenantId)
        ),
      /active consent does not cover requested remote permissions/
    );

    assert.equal(gatewayCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP defaults gateway provider to RustDesk and prefers RustDesk control-plane env', async () => {
  const previousEnv = {
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_REMOTE_GATEWAY_BASE_URL,
    rustdeskBaseUrl: process.env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL,
    remoteToken: process.env.OPC_REMOTE_GATEWAY_API_TOKEN,
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN
  };
  delete process.env.OPC_REMOTE_GATEWAY_PROVIDER;
  delete process.env.OPC_REMOTE_GATEWAY_BASE_URL;
  process.env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL = 'https://opc-rustdesk.example.com';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'remote-gateway-token';
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-specific-token';

  const calls: Array<{ url: string; authorization: string }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(input);
    calls.push({
      url: requestUrl,
      authorization: String((init?.headers as Record<string, string> | undefined)?.authorization || '')
    });
    if (requestUrl === 'https://opc-rustdesk.example.com/api/opc/rustdesk/sessions' && init?.method === 'POST') {
      return jsonResponse(201, {
        external_id: 'rustdesk-specific-env-session',
        launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rustdesk-specific-env-session&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        metadata: { rustdesk_id: '123456789' }
      });
    }
    return jsonResponse(404, { error: 'unexpected request' });
  }) as typeof fetch;

  try {
    process.env.OPC_API_KEY = API_KEY;
    const pg = new MemoryPg();
    const tenantId = 'tenant_rustdesk_specific_env';
    const session = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-rustdesk-specific-env' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const remote = (await route(
      pg,
      'POST',
      '/api/collaboration/remote-assistance/sessions',
      {
        collaboration_session_id: session.data.id,
        mode: 'third_party_remote_tool',
        adapter_provider: 'rustdesk'
      },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remote.data.id}/consent/grant`,
      {
        actor_identity: 'customer-rustdesk-env',
        scopes: ['view_screen'],
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      authHeaders(tenantId)
    );

    const tool = (await route(
      pg,
      'POST',
      `/api/collaboration/remote-assistance/${remote.data.id}/tools/gateway`,
      {
        actor_identity: 'agent-rustdesk-env',
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        metadata: { rustdesk_target_mode: 'raw_id' }
      },
      authHeaders(tenantId)
    )) as { status: number; data: { external_id: string } };

    assert.equal(tool.status, 201);
    assert.equal(tool.data.external_id, 'rustdesk-specific-env-session');
    assert.equal(calls[0]?.url, 'https://opc-rustdesk.example.com/api/opc/rustdesk/sessions');
    assert.equal(calls[0]?.authorization, 'Bearer rustdesk-specific-token');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previousEnv.provider);
    restoreEnv('OPC_REMOTE_GATEWAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('OPC_RUSTDESK_CONTROL_PLANE_BASE_URL', previousEnv.rustdeskBaseUrl);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.remoteToken);
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
  }
});

test('collaboration HTTP exposes RustDesk control-plane session routes', async () => {
  const previousEnv = {
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN,
    remoteGatewayToken: process.env.OPC_REMOTE_GATEWAY_API_TOKEN,
    launchBaseUrl: process.env.OPC_RUSTDESK_LAUNCH_BASE_URL,
    protocolTemplate: process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE,
    idServer: process.env.OPC_RUSTDESK_ID_SERVER,
    relayServer: process.env.OPC_RUSTDESK_RELAY_SERVER,
    apiServer: process.env.OPC_RUSTDESK_API_SERVER,
    publicKey: process.env.OPC_RUSTDESK_PUBLIC_KEY,
    serverKey: process.env.OPC_RUSTDESK_SERVER_KEY
  };
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'different-remote-gateway-token';
  process.env.OPC_RUSTDESK_LAUNCH_BASE_URL = 'https://opc.example.com';
  process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE = 'rustdesk://connect/{rustdesk_id}?session={external_id}';
  process.env.OPC_RUSTDESK_ID_SERVER = 'rustdesk-id.example.com';
  process.env.OPC_RUSTDESK_RELAY_SERVER = 'rustdesk-relay.example.com';
  process.env.OPC_RUSTDESK_API_SERVER = 'https://rustdesk-api.example.com';
  process.env.OPC_RUSTDESK_PUBLIC_KEY = RUSTDESK_PUBLIC_KEY;
  process.env.OPC_RUSTDESK_SERVER_KEY = 'rustdesk-server-key-secret';

  try {
    const pg = new MemoryPg();
    const controlRemoteId = await createAttendedControlPlaneRemote(
      pg,
      'tenant_rustdesk_control_plane',
      'SO-10001',
      ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard']
    );
    const unauthorized = await route(
      pg,
      'POST',
      '/api/opc/rustdesk/sessions',
      {
        target: { type: 'device', id: '123456789', display_name: 'LED controller' },
        permissions: ['view_screen'],
        actor_identity: 'agent-control-plane'
      },
      { authorization: 'Bearer wrong-token' }
    );
    const invalidPermissions = await route(
      pg,
      'POST',
      '/api/opc/rustdesk/sessions',
      {
        target: { type: 'device', id: '123456789', display_name: 'LED controller' },
        permissions: ['view_screen', 'root_shell'],
        actor_identity: 'agent-control-plane'
      },
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const created = (await route(
      pg,
      'POST',
      '/api/opc/rustdesk/sessions',
      {
        target: { type: 'device', id: '123456789', display_name: 'LED controller' },
        permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
        actor_identity: 'agent-control-plane',
        remote_session_id: controlRemoteId,
        metadata: {
          tenant_id: 'tenant_rustdesk_control_plane',
          rustdesk_device_id: 'rdesk-device-1',
          business_ref_type: 'service_order',
          business_ref_id: 'SO-10001'
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    )) as {
      status: number;
      data: {
        external_id: string;
        launch_url: string;
        target: { id: string };
        permissions: string[];
        metadata: Record<string, unknown>;
      };
    };
    const launchPlan = (await route(
      pg,
      'GET',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/launch`,
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    )) as {
      data: {
        external_id: string;
        status: string;
        runtime: {
          rustdesk_id: string;
          id_server: string;
          relay_server: string;
          api_server: string;
          server_key_fingerprint: string;
        };
        client_config: {
          manual_fields: {
            id_server: string;
            relay_server: string;
            api_server?: string;
            key: string;
          };
          public_key_configured: boolean;
          public_key_source: string;
        };
        actions: { can_launch: boolean; open_url: string; protocol_url: string };
      };
    };
    const launchPage = (await route(
      pg,
      'GET',
      new URL(created.data.launch_url).pathname + new URL(created.data.launch_url).search,
      null,
      {}
    )) as { html: string };
    const unsignedLaunchPage = await route(
      pg,
      'GET',
      `/remote/rustdesk/launch?session_id=${encodeURIComponent(created.data.external_id)}`,
      null,
      {}
    );
    const malformedLaunchPage = await route(
      pg,
      'GET',
      `/remote/rustdesk/launch?session_id=${encodeURIComponent(created.data.external_id)}&token=${encodeURIComponent('ā'.repeat(64))}`,
      null,
      {}
    );
    const auditBeforeEnd = (await route(
      pg,
      'GET',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/audit`,
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    )) as { data: { events: Array<{ event_type: string; metadata: Record<string, unknown>; occurred_at: string }> } };
    const fileTransferOccurredAt = new Date(
      new Date(auditBeforeEnd.data.events[0]!.occurred_at).getTime() + 1000
    ).toISOString();
    const controlActionOccurredAt = new Date(
      new Date(auditBeforeEnd.data.events[0]!.occurred_at).getTime() + 2000
    ).toISOString();
    const recordingOccurredAt = new Date(
      new Date(auditBeforeEnd.data.events[0]!.occurred_at).getTime() + 3000
    ).toISOString();
    const clipboardOccurredAt = new Date(
      new Date(auditBeforeEnd.data.events[0]!.occurred_at).getTime() + 4000
    ).toISOString();
    const invalidControlActionEvent = await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.control_action.performed',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'control-action-invalid-1',
        metadata: {
          action: 'mouse_click',
          permission: 'control_mouse_keyboard'
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const invalidGatewayEvent = await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.file_transfer.started',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'file-transfer-invalid-1',
        metadata: {
          direction: 'upload',
          file_name: 'firmware.bin'
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const invalidRecordingEvent = await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'recording-invalid-1',
        metadata: {
          recording_id: 'recording-1'
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const invalidClipboardEvent = await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.clipboard.synced',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'clipboard-invalid-1',
        metadata: {
          direction: 'agent_to_device'
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const gatewayEvent = (await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.file_transfer.started',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'file-transfer-started-1',
        occurred_at: fileTransferOccurredAt,
        metadata: {
          transfer_id: 'transfer-1',
          direction: 'upload',
          file_name: 'firmware.bin',
          bytes: 2048
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    )) as {
      status: number;
      data: {
        event: {
          event_type: string;
          actor_identity: string;
          target: string;
          metadata: Record<string, unknown>;
          occurred_at: string;
        };
      };
    };
    const retriedGatewayEvent = (await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.file_transfer.started',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'file-transfer-started-1',
        occurred_at: fileTransferOccurredAt,
        metadata: {
          transfer_id: 'transfer-1',
          direction: 'upload',
          file_name: 'firmware.bin',
          bytes: 2048,
          retry_attempt: 1
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    )) as {
      status: number;
      data: {
        event: {
          event_type: string;
          metadata: Record<string, unknown>;
          occurred_at: string;
        };
      };
    };
    const controlActionEvent = (await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.control_action.performed',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'control-action-1',
        occurred_at: controlActionOccurredAt,
        metadata: {
          operation_id: 'operation-1',
          action: 'mouse_click',
          permission: 'control_mouse_keyboard'
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    )) as {
      status: number;
      data: {
        event: {
          event_type: string;
          metadata: Record<string, unknown>;
        };
      };
    };
    const recordingEvent = (await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'recording-started-1',
        occurred_at: recordingOccurredAt,
        metadata: {
          recording_id: 'recording-1',
          evidence_type: 'screen_recording'
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    )) as {
      status: number;
      data: {
        event: {
          event_type: string;
          metadata: Record<string, unknown>;
        };
      };
    };
    const clipboardEvent = (await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.clipboard.synced',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'clipboard-synced-1',
        occurred_at: clipboardOccurredAt,
        metadata: {
          clipboard_id: 'clipboard-1',
          direction: 'agent_to_device',
          format: 'text'
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    )) as {
      status: number;
      data: {
        event: {
          event_type: string;
          metadata: Record<string, unknown>;
        };
      };
    };
    const auditAfterGatewayEvent = (await route(
      pg,
      'GET',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/audit`,
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    )) as { data: { events: Array<{ event_type: string; metadata: Record<string, unknown>; occurred_at: string }> } };
    const auditSinceCreated = (await route(
      pg,
      'GET',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/audit?since=${encodeURIComponent(auditBeforeEnd.data.events[0]!.occurred_at)}`,
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    )) as { data: { events: Array<{ event_type: string; actor_identity: string; metadata: Record<string, unknown> }> } };
    const ended = (await route(
      pg,
      'DELETE',
      `/api/opc/rustdesk/sessions/${created.data.external_id}`,
      { actor_identity: 'agent-control-plane' },
      { authorization: 'Bearer rustdesk-control-token' }
    )) as { status: number };
    const retriedEnd = (await route(
      pg,
      'DELETE',
      `/api/opc/rustdesk/sessions/${created.data.external_id}`,
      { actor_identity: 'cleanup-worker' },
      { authorization: 'Bearer rustdesk-control-token' }
    )) as { status: number };
    const launchPageAfterEnd = await route(
      pg,
      'GET',
      new URL(created.data.launch_url).pathname + new URL(created.data.launch_url).search,
      null,
      {}
    );
    const launchPlanAfterEnd = (await route(
      pg,
      'GET',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/launch`,
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    )) as {
      data: {
        status: string;
        actions: { can_launch: boolean; open_url: string; protocol_url: string };
      };
    };
    const auditAfterEnd = (await route(
      pg,
      'GET',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/audit`,
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    )) as { data: { events: Array<{ event_type: string; actor_identity: string; metadata: Record<string, unknown> }> } };
    const eventAfterEnd = await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.file_transfer.started',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'file-transfer-after-end-1',
        metadata: {
          transfer_id: 'transfer-after-end-1',
          direction: 'upload'
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    );

    assert.deepEqual(unauthorized, { status: 401, data: { error: 'invalid RustDesk gateway token' } });
    assert.deepEqual(invalidPermissions, { status: 400, data: { error: 'unsupported RustDesk permission scope: root_shell' } });
    assert.equal(created.status, 201);
    assert.match(created.data.external_id, /^rdgw_/);
    const launchUrl = new URL(created.data.launch_url);
    assert.equal(launchUrl.origin, 'https://opc.example.com');
    assert.equal(launchUrl.pathname, '/remote/rustdesk/launch');
    assert.equal(launchUrl.searchParams.get('session_id'), created.data.external_id);
    assert.match(launchUrl.searchParams.get('token') || '', /^[a-f0-9]{64}$/);
    assert.equal(created.data.target.id, '123456789');
    assert.deepEqual(created.data.permissions, [
      'view_screen',
      'control_mouse_keyboard',
      'record_screen',
      'transfer_file',
      'clipboard'
    ]);
    assert.equal(created.data.metadata.rustdesk_id, '123456789');
    assert.equal(created.data.metadata.id_server, 'rustdesk-id.example.com');
    assert.equal(created.data.metadata.relay_server, 'rustdesk-relay.example.com');
    assert.equal(created.data.metadata.api_server, 'https://rustdesk-api.example.com');
    assert.match(String(created.data.metadata.server_key_fingerprint), /^sha256:/);
    assert.equal(launchPlan.data.external_id, created.data.external_id);
    assert.equal(launchPlan.data.status, 'active');
    assert.equal(launchPlan.data.runtime.rustdesk_id, '123456789');
    assert.equal(launchPlan.data.runtime.id_server, 'rustdesk-id.example.com');
    assert.equal(launchPlan.data.runtime.relay_server, 'rustdesk-relay.example.com');
    assert.equal(launchPlan.data.runtime.api_server, 'https://rustdesk-api.example.com');
    assert.equal(launchPlan.data.runtime.server_key_fingerprint, created.data.metadata.server_key_fingerprint);
    assert.deepEqual(launchPlan.data.client_config.manual_fields, {
      id_server: 'rustdesk-id.example.com',
      relay_server: 'rustdesk-relay.example.com',
      api_server: 'https://rustdesk-api.example.com',
      key: RUSTDESK_PUBLIC_KEY
    });
    assert.equal(launchPlan.data.client_config.public_key_configured, true);
    assert.equal(launchPlan.data.client_config.public_key_source, 'env');
    assert.equal(launchPlan.data.actions.can_launch, true);
    assert.equal(launchPlan.data.actions.open_url, created.data.launch_url);
    assert.equal(
      launchPlan.data.actions.protocol_url,
      `rustdesk://connect/123456789?session=${encodeURIComponent(created.data.external_id)}`
    );
    assert.match(launchPage.html, /RustDesk Remote Launch/);
    assert.match(launchPage.html, new RegExp(created.data.external_id));
    assert.match(launchPage.html, new RegExp(RUSTDESK_PUBLIC_KEY));
    assert.doesNotMatch(launchPage.html, /rustdesk-server-key-secret/);
    assert.deepEqual(unsignedLaunchPage, { status: 401, data: { error: 'invalid RustDesk launch token' } });
    assert.deepEqual(malformedLaunchPage, { status: 401, data: { error: 'invalid RustDesk launch token' } });
    assert.deepEqual(auditBeforeEnd.data.events.map((event) => event.event_type), ['remote.gateway_session.created']);
    assert.equal(auditBeforeEnd.data.events[0]?.metadata.rustdesk_device_id, 'rdesk-device-1');
    assert.deepEqual(invalidControlActionEvent, {
      status: 400,
      data: { error: 'RustDesk control action event metadata.operation_id is required' }
    });
    assert.deepEqual(invalidGatewayEvent, {
      status: 400,
      data: { error: 'RustDesk file transfer event metadata.transfer_id is required' }
    });
    assert.deepEqual(invalidRecordingEvent, {
      status: 400,
      data: { error: 'RustDesk recording event metadata.evidence_type is required' }
    });
    assert.deepEqual(invalidClipboardEvent, {
      status: 400,
      data: { error: 'RustDesk clipboard event metadata.clipboard_id is required' }
    });
    assert.equal(gatewayEvent.status, 201);
    assert.equal(gatewayEvent.data.event.event_type, 'remote.rustdesk.file_transfer.started');
    assert.equal(gatewayEvent.data.event.actor_identity, 'agent-control-plane');
    assert.equal(gatewayEvent.data.event.target, '123456789');
    assert.equal(gatewayEvent.data.event.metadata.transfer_id, 'transfer-1');
    assert.equal(gatewayEvent.data.event.metadata.file_name, 'firmware.bin');
    assert.equal(gatewayEvent.data.event.metadata.idempotency_key, 'file-transfer-started-1');
    assert.equal(gatewayEvent.data.event.occurred_at, fileTransferOccurredAt);
    assert.equal(retriedGatewayEvent.status, 201);
    assert.deepEqual(retriedGatewayEvent.data.event, gatewayEvent.data.event);
    assert.equal(controlActionEvent.status, 201);
    assert.equal(controlActionEvent.data.event.event_type, 'remote.rustdesk.control_action.performed');
    assert.equal(controlActionEvent.data.event.metadata.operation_id, 'operation-1');
    assert.equal(recordingEvent.status, 201);
    assert.equal(recordingEvent.data.event.event_type, 'remote.rustdesk.recording.started');
    assert.equal(recordingEvent.data.event.metadata.evidence_type, 'screen_recording');
    assert.equal(clipboardEvent.status, 201);
    assert.equal(clipboardEvent.data.event.event_type, 'remote.rustdesk.clipboard.synced');
    assert.equal(clipboardEvent.data.event.metadata.clipboard_id, 'clipboard-1');
    assert.deepEqual(auditAfterGatewayEvent.data.events.map((event) => event.event_type), [
      'remote.gateway_session.created',
      'remote.rustdesk.file_transfer.started',
      'remote.rustdesk.control_action.performed',
      'remote.rustdesk.recording.started',
      'remote.rustdesk.clipboard.synced'
    ]);
    assert.deepEqual(auditSinceCreated.data.events.map((event) => event.event_type), [
      'remote.rustdesk.file_transfer.started',
      'remote.rustdesk.control_action.performed',
      'remote.rustdesk.recording.started',
      'remote.rustdesk.clipboard.synced'
    ]);
    assert.equal(ended.status, 204);
    assert.equal(retriedEnd.status, 204);
    assert.deepEqual(launchPageAfterEnd, { status: 409, data: { error: 'RustDesk gateway session is not active' } });
    assert.equal(launchPlanAfterEnd.data.status, 'ended');
    assert.deepEqual(launchPlanAfterEnd.data.actions, {
      can_launch: false,
      open_url: '',
      protocol_url: ''
    });
    assert.deepEqual(auditAfterEnd.data.events.map((event) => event.event_type), [
      'remote.gateway_session.created',
      'remote.rustdesk.disconnect.unavailable',
      'remote.rustdesk.file_transfer.started',
      'remote.rustdesk.control_action.performed',
      'remote.rustdesk.recording.started',
      'remote.rustdesk.clipboard.synced',
      'remote.gateway_session.ended'
    ]);
    assert.equal(auditAfterEnd.data.events.at(-1)?.actor_identity, 'agent-control-plane');
    assert.deepEqual(eventAfterEnd, { status: 409, data: { error: 'RustDesk gateway session is not active' } });
  } finally {
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.remoteGatewayToken);
    restoreEnv('OPC_RUSTDESK_LAUNCH_BASE_URL', previousEnv.launchBaseUrl);
    restoreEnv('OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE', previousEnv.protocolTemplate);
    restoreEnv('OPC_RUSTDESK_ID_SERVER', previousEnv.idServer);
    restoreEnv('OPC_RUSTDESK_RELAY_SERVER', previousEnv.relayServer);
    restoreEnv('OPC_RUSTDESK_API_SERVER', previousEnv.apiServer);
    restoreEnv('OPC_RUSTDESK_PUBLIC_KEY', previousEnv.publicKey);
    restoreEnv('OPC_RUSTDESK_SERVER_KEY', previousEnv.serverKey);
  }
});

test('collaboration HTTP requires RustDesk control-plane actor identities', async () => {
  const previousEnv = {
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN,
    launchBaseUrl: process.env.OPC_RUSTDESK_LAUNCH_BASE_URL
  };
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.OPC_RUSTDESK_LAUNCH_BASE_URL = 'https://opc.example.com';

  try {
    const pg = new MemoryPg();
    const remoteSessionId = await createAttendedControlPlaneRemote(
      pg,
      'tenant_rustdesk_actor_required',
      '123456789',
      ['view_screen']
    );
    const missingCreateActor = await route(
      pg,
      'POST',
      '/api/opc/rustdesk/sessions',
      {
        target: { type: 'device', id: '123456789', display_name: 'LED controller' },
        permissions: ['view_screen'],
        actor_identity: '  ',
        metadata: { tenant_id: 'tenant_rustdesk_actor_required' }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const created = (await route(
      pg,
      'POST',
      '/api/opc/rustdesk/sessions',
      {
        target: { type: 'device', id: '123456789', display_name: 'LED controller' },
        permissions: ['view_screen'],
        actor_identity: 'agent-control-plane-required',
        remote_session_id: remoteSessionId,
        metadata: { tenant_id: 'tenant_rustdesk_actor_required' }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    )) as { status: number; data: { external_id: string } };
    const missingEventActor = await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.smoke.probe',
        actor_identity: '  ',
        target: '123456789',
        idempotency_key: 'missing-actor-event-1',
        metadata: { source: 'test' }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const missingEndActor = await route(
      pg,
      'DELETE',
      `/api/opc/rustdesk/sessions/${created.data.external_id}`,
      { actor_identity: '  ' },
      { authorization: 'Bearer rustdesk-control-token' }
    );

    assert.deepEqual(missingCreateActor, { status: 400, data: { error: 'actor_identity is required' } });
    assert.equal(created.status, 201);
    assert.deepEqual(missingEventActor, { status: 400, data: { error: 'actor_identity is required' } });
    assert.deepEqual(missingEndActor, { status: 400, data: { error: 'actor_identity is required' } });
  } finally {
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
    restoreEnv('OPC_RUSTDESK_LAUNCH_BASE_URL', previousEnv.launchBaseUrl);
  }
});

test('collaboration HTTP rejects RustDesk operation events outside session permissions', async () => {
  const previousEnv = {
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN,
    launchBaseUrl: process.env.OPC_RUSTDESK_LAUNCH_BASE_URL
  };
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.OPC_RUSTDESK_LAUNCH_BASE_URL = 'https://opc.example.com';

  try {
    const pg = new MemoryPg();
    const remoteSessionId = await createAttendedControlPlaneRemote(
      pg,
      'tenant_rustdesk_permissions',
      '123456789',
      ['view_screen']
    );
    const created = (await route(
      pg,
      'POST',
      '/api/opc/rustdesk/sessions',
      {
        target: { type: 'device', id: '123456789', display_name: 'LED controller' },
        permissions: ['view_screen'],
        actor_identity: 'agent-control-plane',
        remote_session_id: remoteSessionId,
        metadata: { tenant_id: 'tenant_rustdesk_permissions' }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    )) as { status: number; data: { external_id: string } };
    const denied = await route(
      pg,
      'POST',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/events`,
      {
        event_type: 'remote.rustdesk.file_transfer.completed',
        actor_identity: 'agent-control-plane',
        target: '123456789',
        idempotency_key: 'file-transfer-completed-ungranted-1',
        metadata: {
          transfer_id: 'file-transfer-ungranted-1',
          direction: 'upload'
        }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const audit = (await route(
      pg,
      'GET',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/audit`,
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    )) as { data: { events: Array<{ event_type: string }> } };

    assert.equal(created.status, 201);
    assert.deepEqual(denied, {
      status: 403,
      data: { error: 'RustDesk file transfer event requires transfer_file permission' }
    });
    assert.deepEqual(audit.data.events.map((event) => event.event_type), ['remote.gateway_session.created']);
  } finally {
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
    restoreEnv('OPC_RUSTDESK_LAUNCH_BASE_URL', previousEnv.launchBaseUrl);
  }
});

test('collaboration HTTP lists RustDesk control-plane sessions by tenant and status', async () => {
  const previousEnv = {
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN,
    launchBaseUrl: process.env.OPC_RUSTDESK_LAUNCH_BASE_URL
  };
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.OPC_RUSTDESK_LAUNCH_BASE_URL = 'https://opc.example.com';

  try {
    const pg = new MemoryPg();
    const createSession = async (tenantId: string, targetId: string) => {
      const remoteSessionId = await createAttendedControlPlaneRemote(
        pg,
        tenantId,
        targetId,
        ['view_screen']
      );
      return route(pg, 'POST', '/api/opc/rustdesk/sessions', {
        target: { type: 'device', id: targetId, display_name: `Device ${targetId}` },
        permissions: ['view_screen'],
        actor_identity: 'agent-control-plane',
        remote_session_id: remoteSessionId,
        metadata: { tenant_id: tenantId, business_ref_type: 'service_order', business_ref_id: targetId }
      }, { authorization: 'Bearer rustdesk-control-token' }) as Promise<{
        status: number;
        data: { external_id: string; target: { id: string } };
      }>;
    };

    const first = await createSession('tenant_rustdesk_list', '100001');
    const second = await createSession('tenant_rustdesk_list', '100002');
    await createSession('tenant_rustdesk_other', '200001');
    await route(
      pg,
      'DELETE',
      `/api/opc/rustdesk/sessions/${first.data.external_id}`,
      { actor_identity: 'agent-control-plane' },
      { authorization: 'Bearer rustdesk-control-token' }
    );

    const active = await route(
      pg,
      'GET',
      '/api/opc/rustdesk/sessions?tenant_id=tenant_rustdesk_list&status=active',
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    ) as { data: { sessions: Array<{ external_id: string; status: string; target: { id: string } }> } };
    const ended = await route(
      pg,
      'GET',
      '/api/opc/rustdesk/sessions?tenant_id=tenant_rustdesk_list&status=ended',
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    ) as { data: { sessions: Array<{ external_id: string; status: string; target: { id: string } }> } };
    const missingTenant = await route(
      pg,
      'GET',
      '/api/opc/rustdesk/sessions',
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    );

    assert.deepEqual(active.data.sessions.map((session) => session.external_id), [second.data.external_id]);
    assert.equal(active.data.sessions[0]?.status, 'active');
    assert.deepEqual(ended.data.sessions.map((session) => session.external_id), [first.data.external_id]);
    assert.equal(ended.data.sessions[0]?.status, 'ended');
    assert.deepEqual(missingTenant, { status: 400, data: { error: 'tenant_id is required' } });
  } finally {
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
    restoreEnv('OPC_RUSTDESK_LAUNCH_BASE_URL', previousEnv.launchBaseUrl);
  }
});

test('collaboration HTTP rejects invalid RustDesk control-plane query params', async () => {
  const previousEnv = {
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN,
    launchBaseUrl: process.env.OPC_RUSTDESK_LAUNCH_BASE_URL
  };
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.OPC_RUSTDESK_LAUNCH_BASE_URL = 'https://opc.example.com';

  try {
    const pg = new MemoryPg();
    const remoteSessionId = await createAttendedControlPlaneRemote(
      pg,
      'tenant_rustdesk_query_params',
      '123456789',
      ['view_screen']
    );
    const created = await route(
      pg,
      'POST',
      '/api/opc/rustdesk/sessions',
      {
        target: { type: 'device', id: '123456789', display_name: 'Device 123456789' },
        permissions: ['view_screen'],
        actor_identity: 'agent-control-plane',
        remote_session_id: remoteSessionId,
        metadata: { tenant_id: 'tenant_rustdesk_query_params' }
      },
      { authorization: 'Bearer rustdesk-control-token' }
    ) as { data: { external_id: string } };

    const invalidLimit = await route(
      pg,
      'GET',
      '/api/opc/rustdesk/sessions?tenant_id=tenant_rustdesk_query_params&limit=abc',
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const decimalLimit = await route(
      pg,
      'GET',
      '/api/opc/rustdesk/sessions?tenant_id=tenant_rustdesk_query_params&limit=1.5',
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const zeroLimit = await route(
      pg,
      'GET',
      '/api/opc/rustdesk/sessions?tenant_id=tenant_rustdesk_query_params&limit=0',
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const tooLargeLimit = await route(
      pg,
      'GET',
      '/api/opc/rustdesk/sessions?tenant_id=tenant_rustdesk_query_params&limit=201',
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    );
    const invalidSince = await route(
      pg,
      'GET',
      `/api/opc/rustdesk/sessions/${created.data.external_id}/audit?since=not-a-date`,
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    );

    const limitError = { status: 400, data: { error: 'limit must be an integer from 1 to 200' } };
    assert.deepEqual(invalidLimit, limitError);
    assert.deepEqual(decimalLimit, limitError);
    assert.deepEqual(zeroLimit, limitError);
    assert.deepEqual(tooLargeLimit, limitError);
    assert.deepEqual(invalidSince, { status: 400, data: { error: 'since must be an ISO timestamp' } });
  } finally {
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
    restoreEnv('OPC_RUSTDESK_LAUNCH_BASE_URL', previousEnv.launchBaseUrl);
  }
});

test('collaboration HTTP exposes RustDesk client config from public key file', async () => {
  const previousEnv = {
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN,
    remoteGatewayToken: process.env.OPC_REMOTE_GATEWAY_API_TOKEN,
    idServer: process.env.OPC_RUSTDESK_ID_SERVER,
    relayServer: process.env.OPC_RUSTDESK_RELAY_SERVER,
    publicKey: process.env.OPC_RUSTDESK_PUBLIC_KEY,
    publicKeyFile: process.env.OPC_RUSTDESK_PUBLIC_KEY_FILE,
    serverKey: process.env.OPC_RUSTDESK_SERVER_KEY
  };
  const rustdeskDataDir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-data-'));
  const publicKeyFile = join(rustdeskDataDir, 'id_ed25519.pub');
  writeFileSync(publicKeyFile, RUSTDESK_PUBLIC_KEY);
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.OPC_REMOTE_GATEWAY_API_TOKEN = 'different-remote-gateway-token';
  process.env.OPC_RUSTDESK_ID_SERVER = 'rustdesk-id.example.com';
  process.env.OPC_RUSTDESK_RELAY_SERVER = 'rustdesk-relay.example.com';
  delete process.env.OPC_RUSTDESK_PUBLIC_KEY;
  process.env.OPC_RUSTDESK_PUBLIC_KEY_FILE = publicKeyFile;
  process.env.OPC_RUSTDESK_SERVER_KEY = 'do-not-expose-this-private-value';

  try {
    const pg = new MemoryPg();
    const clientConfig = (await route(
      pg,
      'GET',
      '/api/opc/rustdesk/client-config',
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    )) as {
      data: {
        id_server: string;
        relay_server: string;
        public_key: string;
        public_key_source: string;
        public_key_configured: boolean;
        server_key_fingerprint: string;
        manual_fields: { id_server: string; relay_server: string; key: string };
      };
    };

    assert.equal(clientConfig.data.id_server, 'rustdesk-id.example.com');
    assert.equal(clientConfig.data.relay_server, 'rustdesk-relay.example.com');
    assert.equal(clientConfig.data.public_key, RUSTDESK_PUBLIC_KEY);
    assert.equal(clientConfig.data.public_key_source, 'file');
    assert.equal(clientConfig.data.public_key_configured, true);
    assert.match(clientConfig.data.server_key_fingerprint, /^sha256:/);
    assert.deepEqual(clientConfig.data.manual_fields, {
      id_server: 'rustdesk-id.example.com',
      relay_server: 'rustdesk-relay.example.com',
      key: RUSTDESK_PUBLIC_KEY
    });
    assert.notEqual(clientConfig.data.public_key, 'do-not-expose-this-private-value');
  } finally {
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
    restoreEnv('OPC_REMOTE_GATEWAY_API_TOKEN', previousEnv.remoteGatewayToken);
    restoreEnv('OPC_RUSTDESK_ID_SERVER', previousEnv.idServer);
    restoreEnv('OPC_RUSTDESK_RELAY_SERVER', previousEnv.relayServer);
    restoreEnv('OPC_RUSTDESK_PUBLIC_KEY', previousEnv.publicKey);
    restoreEnv('OPC_RUSTDESK_PUBLIC_KEY_FILE', previousEnv.publicKeyFile);
    restoreEnv('OPC_RUSTDESK_SERVER_KEY', previousEnv.serverKey);
  }
});

test('collaboration HTTP rejects blank RustDesk public key files', async () => {
  const previousEnv = {
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN,
    publicKey: process.env.OPC_RUSTDESK_PUBLIC_KEY,
    publicKeyFile: process.env.OPC_RUSTDESK_PUBLIC_KEY_FILE
  };
  const rustdeskDataDir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-blank-key-'));
  const publicKeyFile = join(rustdeskDataDir, 'id_ed25519.pub');
  writeFileSync(publicKeyFile, '\n  \n');
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  delete process.env.OPC_RUSTDESK_PUBLIC_KEY;
  process.env.OPC_RUSTDESK_PUBLIC_KEY_FILE = publicKeyFile;

  try {
    const pg = new MemoryPg();
    const clientConfig = await route(
      pg,
      'GET',
      '/api/opc/rustdesk/client-config',
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    );

    assert.deepEqual(clientConfig, {
      status: 500,
      data: { error: `RustDesk public key file is empty: ${publicKeyFile}` }
    });
  } finally {
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
    restoreEnv('OPC_RUSTDESK_PUBLIC_KEY', previousEnv.publicKey);
    restoreEnv('OPC_RUSTDESK_PUBLIC_KEY_FILE', previousEnv.publicKeyFile);
  }
});

test('collaboration HTTP rejects RustDesk API server without HTTP protocols', async () => {
  const previousEnv = {
    rustdeskToken: process.env.OPC_RUSTDESK_API_TOKEN,
    apiServer: process.env.OPC_RUSTDESK_API_SERVER,
    publicKey: process.env.OPC_RUSTDESK_PUBLIC_KEY,
    publicKeyFile: process.env.OPC_RUSTDESK_PUBLIC_KEY_FILE
  };
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.OPC_RUSTDESK_API_SERVER = 'ftp://rustdesk-api.example.com';
  process.env.OPC_RUSTDESK_PUBLIC_KEY = RUSTDESK_PUBLIC_KEY;
  delete process.env.OPC_RUSTDESK_PUBLIC_KEY_FILE;

  try {
    const pg = new MemoryPg();
    const clientConfig = await route(
      pg,
      'GET',
      '/api/opc/rustdesk/client-config',
      null,
      { authorization: 'Bearer rustdesk-control-token' }
    );

    assert.deepEqual(clientConfig, {
      status: 500,
      data: { error: 'RustDesk API server must use http(s)' }
    });
  } finally {
    restoreEnv('OPC_RUSTDESK_API_TOKEN', previousEnv.rustdeskToken);
    restoreEnv('OPC_RUSTDESK_API_SERVER', previousEnv.apiServer);
    restoreEnv('OPC_RUSTDESK_PUBLIC_KEY', previousEnv.publicKey);
    restoreEnv('OPC_RUSTDESK_PUBLIC_KEY_FILE', previousEnv.publicKeyFile);
  }
});

test('collaboration HTTP rejects iveKit RustDesk client config API server without HTTP protocols', async () => {
  const previousEnv = {
    apiKey: process.env.OPC_API_KEY,
    apiServer: process.env.OPC_RUSTDESK_API_SERVER,
    publicKey: process.env.OPC_RUSTDESK_PUBLIC_KEY,
    publicKeyFile: process.env.OPC_RUSTDESK_PUBLIC_KEY_FILE
  };
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_RUSTDESK_API_SERVER = 'ftp://rustdesk-api.example.com';
  process.env.OPC_RUSTDESK_PUBLIC_KEY = RUSTDESK_PUBLIC_KEY;
  delete process.env.OPC_RUSTDESK_PUBLIC_KEY_FILE;

  try {
    const pg = new MemoryPg();
    const clientConfig = await route(
      pg,
      'GET',
      '/api/ivekit/rustdesk/client-config',
      null,
      authHeaders('tenant_ivekit_bad_api_server')
    );

    assert.deepEqual(clientConfig, {
      status: 500,
      data: { error: 'RustDesk API server must use http(s)' }
    });
  } finally {
    restoreEnv('OPC_API_KEY', previousEnv.apiKey);
    restoreEnv('OPC_RUSTDESK_API_SERVER', previousEnv.apiServer);
    restoreEnv('OPC_RUSTDESK_PUBLIC_KEY', previousEnv.publicKey);
    restoreEnv('OPC_RUSTDESK_PUBLIC_KEY_FILE', previousEnv.publicKeyFile);
  }
});

test('collaboration HTTP sends text chat messages and scans policy automatically', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantId = 'tenant_chat_http';

  const sessionResult = (await route(
    pg,
    'POST',
    '/api/collaboration/sessions',
    { business_ref: { type: 'service_order', id: 'order-chat-http' } },
    authHeaders(tenantId)
  )) as { status: number; data: { id: string } };
  assert.equal(sessionResult.status, 201);

  const participantResult = (await route(
    pg,
    'POST',
    `/api/collaboration/sessions/${sessionResult.data.id}/participants`,
    { identity: 'customer_1', role: 'customer', display_name: 'Customer' },
    authHeaders(tenantId)
  )) as { status: number; data: { identity: string } };
  assert.equal(participantResult.status, 201);
  assert.equal(participantResult.data.identity, 'customer_1');

  const bindResult = (await route(
    pg,
    'POST',
    `/api/collaboration/sessions/${sessionResult.data.id}/chat/bind`,
    {},
    authHeaders(tenantId)
  )) as { status: number; data: { provider: string; provider_topic_id: string } };
  assert.equal(bindResult.status, 201);
  assert.equal(bindResult.data.provider, 'local');

  const messageResult = (await route(
    pg,
    'POST',
    `/api/collaboration/sessions/${sessionResult.data.id}/messages`,
    { sender_identity: 'customer_1', body: 'call me at 555-123-4567 outside app' },
    authHeaders(tenantId)
  )) as {
    status: number;
    data: {
      message: { body: string; metadata: Record<string, unknown> };
      policy: { matched: boolean; events: unknown[] };
    };
  };
  assert.equal(messageResult.status, 201);
  assert.equal(messageResult.data.message.body, 'call me at 555-123-4567 outside app');
  assert.equal(messageResult.data.message.metadata.provider_sync_status, 'skipped');
  assert.equal(messageResult.data.policy.matched, true);
  assert.equal(messageResult.data.policy.events.length, 2);

  const chat = (await route(
    pg,
    'GET',
    `/api/collaboration/sessions/${sessionResult.data.id}/chat`,
    null,
    authHeaders(tenantId)
  )) as { data: { messages: Array<{ body: string }>; policy_events: unknown[] } };
  assert.equal(chat.data.messages.length, 1);
  assert.equal(chat.data.policy_events.length, 2);
});

test('collaboration HTTP marks participants left and revokes Tinode access', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const tinode = await startFakeTinodeServerForHttp();
  const previousEnv = {
    baseUrl: process.env.TINODE_BASE_URL,
    wsUrl: process.env.TINODE_WS_URL,
    apiKey: process.env.TINODE_API_KEY,
    token: process.env.TINODE_AUTH_TOKEN
  };
  try {
    process.env.TINODE_BASE_URL = tinode.url.replace(/^ws:/, 'http:').replace('/v0/channels', '');
    process.env.TINODE_WS_URL = tinode.url;
    process.env.TINODE_API_KEY = 'tinode-http-api-key';
    process.env.TINODE_AUTH_TOKEN = 'tinode-http-token';
    const pg = new MemoryPg();
    const tenantId = 'tenant_chat_leave_http';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-chat-leave-http' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    const bindResult = (await route(
      pg,
      'POST',
      `/api/collaboration/sessions/${sessionResult.data.id}/chat/bind`,
      {},
      authHeaders(tenantId)
    )) as { data: { provider_topic_id: string } };
    await route(
      pg,
      'POST',
      `/api/collaboration/sessions/${sessionResult.data.id}/participants`,
      {
        identity: 'customer-leave-http',
        role: 'customer',
        display_name: 'Customer Leave',
        provider_user_id: 'usrCustomerLeaveHttp'
      },
      authHeaders(tenantId)
    );

    const left = (await route(
      pg,
      'POST',
      `/api/collaboration/sessions/${sessionResult.data.id}/participants/leave`,
      {
        identity: 'customer-leave-http',
        provider_user_id: 'usrCustomerLeaveHttp'
      },
      authHeaders(tenantId)
    )) as { status: number; data: { identity: string; left_at: string | null } };

    assert.equal(left.status, 201);
    assert.equal(left.data.identity, 'customer-leave-http');
    assert.ok(left.data.left_at);
    assert.equal(
      tinode.packets.some((packet) =>
        packet.set?.topic === bindResult.data.provider_topic_id &&
        packet.set?.sub?.user === 'usrCustomerLeaveHttp' &&
        packet.set?.sub?.mode === 'N'
      ),
      true
    );

    const chat = (await route(
      pg,
      'GET',
      `/api/collaboration/sessions/${sessionResult.data.id}/chat`,
      null,
      authHeaders(tenantId)
    )) as { data: { participants: Array<{ identity: string; left_at: string | null }> } };
    assert.ok(chat.data.participants.find((participant) => participant.identity === 'customer-leave-http')?.left_at);
  } finally {
    await tinode.close();
    restoreEnv('TINODE_BASE_URL', previousEnv.baseUrl);
    restoreEnv('TINODE_WS_URL', previousEnv.wsUrl);
    restoreEnv('TINODE_API_KEY', previousEnv.apiKey);
    restoreEnv('TINODE_AUTH_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP stores attachment messages and scans extracted attachment text', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const previousEnv = {
    baseUrl: process.env.TINODE_BASE_URL,
    wsUrl: process.env.TINODE_WS_URL,
    apiKey: process.env.TINODE_API_KEY,
    token: process.env.TINODE_AUTH_TOKEN
  };
  delete process.env.TINODE_BASE_URL;
  delete process.env.TINODE_WS_URL;
  delete process.env.TINODE_API_KEY;
  delete process.env.TINODE_AUTH_TOKEN;
  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_chat_attachment_http';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-chat-attachment-http' } },
      authHeaders(tenantId)
    )) as { status: number; data: { id: string } };
    assert.equal(sessionResult.status, 201);

    const messageResult = (await route(
      pg,
      'POST',
      `/api/collaboration/sessions/${sessionResult.data.id}/messages`,
      {
        sender_identity: 'customer_attachment',
        message_type: 'image',
        attachments: [
          {
            kind: 'image',
            storage_url: 's3://opc-chat/tenant_chat_attachment_http/order-photo.png',
            filename: 'order-photo.png',
            content_type: 'image/png',
            size_bytes: 2048,
            checksum: 'sha256:order-photo',
            metadata: { ocr_text: '请加我微信 led_private_001，手机号 555-456-7890' }
          }
        ]
      },
      authHeaders(tenantId)
    )) as {
      status: number;
      data: {
        message: {
          message_type: string;
          body: string;
          attachments: Array<{
            kind: string;
            storage_url: string;
            filename: string;
            processing_status: string;
            metadata: Record<string, unknown>;
          }>;
        };
        policy: { matched: boolean; events: Array<{ policy_type: string }> };
      };
    };

    assert.equal(messageResult.status, 201);
    assert.equal(messageResult.data.message.message_type, 'image');
    assert.equal(messageResult.data.message.body, '');
    assert.equal(messageResult.data.message.attachments.length, 1);
    assert.equal(messageResult.data.message.attachments[0]?.kind, 'image');
    assert.equal(messageResult.data.message.attachments[0]?.filename, 'order-photo.png');
    assert.equal(messageResult.data.message.attachments[0]?.processing_status, 'ready');
    assert.equal(messageResult.data.policy.matched, true);
    assert.equal(messageResult.data.policy.events.some((event) => event.policy_type === 'phone_number'), true);
    assert.equal(messageResult.data.policy.events.some((event) => event.policy_type === 'wechat'), true);

    const chat = (await route(
      pg,
      'GET',
      `/api/collaboration/sessions/${sessionResult.data.id}/chat`,
      null,
      authHeaders(tenantId)
    )) as {
      data: {
        messages: Array<{
          message_type: string;
          attachments: Array<{ storage_url: string; metadata: Record<string, unknown> }>;
        }>;
        policy_events: Array<{ policy_type: string }>;
      };
    };
    assert.equal(chat.data.messages.length, 1);
    assert.equal(chat.data.messages[0]?.attachments[0]?.storage_url, 's3://opc-chat/tenant_chat_attachment_http/order-photo.png');
    assert.equal(chat.data.messages[0]?.attachments[0]?.metadata.ocr_text, '请加我微信 led_private_001，手机号 555-456-7890');
    assert.equal(chat.data.policy_events.some((event) => event.policy_type === 'phone_number'), true);
  } finally {
    restoreEnv('TINODE_BASE_URL', previousEnv.baseUrl);
    restoreEnv('TINODE_WS_URL', previousEnv.wsUrl);
    restoreEnv('TINODE_API_KEY', previousEnv.apiKey);
    restoreEnv('TINODE_AUTH_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP reuses existing Tinode topic binding when sending messages', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const tinode = await startFakeTinodeServerForHttp();
  const previousEnv = {
    baseUrl: process.env.TINODE_BASE_URL,
    wsUrl: process.env.TINODE_WS_URL,
    apiKey: process.env.TINODE_API_KEY,
    token: process.env.TINODE_AUTH_TOKEN
  };
  try {
    process.env.TINODE_BASE_URL = tinode.url.replace(/^ws:/, 'http:').replace('/v0/channels', '');
    process.env.TINODE_WS_URL = tinode.url;
    process.env.TINODE_API_KEY = 'tinode-http-api-key';
    process.env.TINODE_AUTH_TOKEN = 'tinode-http-token';
    const pg = new MemoryPg();
    const tenantId = 'tenant_chat_tinode_http';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-chat-tinode-http' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    const bindResult = (await route(
      pg,
      'POST',
      `/api/collaboration/sessions/${sessionResult.data.id}/chat/bind`,
      {},
      authHeaders(tenantId)
    )) as { status: number; data: { provider: string; provider_topic_id: string } };
    assert.equal(bindResult.status, 201);
    assert.equal(bindResult.data.provider, 'tinode');

    const messageResult = (await route(
      pg,
      'POST',
      `/api/collaboration/sessions/${sessionResult.data.id}/messages`,
      { sender_identity: 'agent-http', body: 'hello through tinode' },
      authHeaders(tenantId)
    )) as { status: number; data: { message: { metadata: Record<string, unknown> } } };

    assert.equal(messageResult.status, 201);
    assert.equal(messageResult.data.message.metadata.provider_sync_status, 'published');
    assert.equal(tinode.packets.filter((packet) => packet.sub?.topic === 'new').length, 1);
    assert.equal(
      tinode.packets.some((packet) => packet.pub?.topic === bindResult.data.provider_topic_id && packet.pub?.content === 'hello through tinode'),
      true
    );
  } finally {
    await tinode.close();
    restoreEnv('TINODE_BASE_URL', previousEnv.baseUrl);
    restoreEnv('TINODE_WS_URL', previousEnv.wsUrl);
    restoreEnv('TINODE_API_KEY', previousEnv.apiKey);
    restoreEnv('TINODE_AUTH_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP syncs Tinode participant access when adding participants', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const tinode = await startFakeTinodeServerForHttp();
  const previousEnv = {
    baseUrl: process.env.TINODE_BASE_URL,
    wsUrl: process.env.TINODE_WS_URL,
    apiKey: process.env.TINODE_API_KEY,
    token: process.env.TINODE_AUTH_TOKEN
  };
  try {
    process.env.TINODE_BASE_URL = tinode.url.replace(/^ws:/, 'http:').replace('/v0/channels', '');
    process.env.TINODE_WS_URL = tinode.url;
    process.env.TINODE_API_KEY = 'tinode-http-api-key';
    process.env.TINODE_AUTH_TOKEN = 'tinode-http-token';
    const pg = new MemoryPg();
    const tenantId = 'tenant_chat_tinode_participant';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-chat-tinode-participant' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };

    const bindResult = (await route(
      pg,
      'POST',
      `/api/collaboration/sessions/${sessionResult.data.id}/chat/bind`,
      {},
      authHeaders(tenantId)
    )) as { data: { provider_topic_id: string } };

    const participantResult = (await route(
      pg,
      'POST',
      `/api/collaboration/sessions/${sessionResult.data.id}/participants`,
      {
        identity: 'customer-http',
        role: 'customer',
        display_name: 'Customer HTTP',
        provider_user_id: 'usrCustomerHttp'
      },
      authHeaders(tenantId)
    )) as { status: number; data: { identity: string } };

    assert.equal(participantResult.status, 201);
    assert.equal(participantResult.data.identity, 'customer-http');
    assert.equal(
      tinode.packets.some((packet) =>
        packet.set?.topic === bindResult.data.provider_topic_id &&
        packet.set?.sub?.user === 'usrCustomerHttp' &&
        packet.set?.sub?.mode === 'JRP'
      ),
      true
    );
  } finally {
    await tinode.close();
    restoreEnv('TINODE_BASE_URL', previousEnv.baseUrl);
    restoreEnv('TINODE_WS_URL', previousEnv.wsUrl);
    restoreEnv('TINODE_API_KEY', previousEnv.apiKey);
    restoreEnv('TINODE_AUTH_TOKEN', previousEnv.token);
  }
});

test('collaboration HTTP returns Tinode client join plan without leaking server secrets', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const tinode = await startFakeTinodeServerForHttp();
  const previousEnv = {
    baseUrl: process.env.TINODE_BASE_URL,
    wsUrl: process.env.TINODE_WS_URL,
    publicWsUrl: process.env.TINODE_PUBLIC_WS_URL,
    apiKey: process.env.TINODE_API_KEY,
    token: process.env.TINODE_AUTH_TOKEN,
    userPasswordSecret: process.env.TINODE_USER_PASSWORD_SECRET
  };
  try {
    process.env.TINODE_BASE_URL = tinode.url.replace(/^ws:/, 'http:').replace('/v0/channels', '');
    process.env.TINODE_WS_URL = tinode.url;
    process.env.TINODE_PUBLIC_WS_URL = 'wss://chat.example.com/v0/channels';
    process.env.TINODE_API_KEY = 'tinode-http-api-key';
    process.env.TINODE_AUTH_TOKEN = 'tinode-http-token';
    process.env.TINODE_USER_PASSWORD_SECRET = 'tinode-user-secret';
    const pg = new MemoryPg();
    const tenantId = 'tenant_chat_tinode_client_plan';
    const sessionResult = (await route(
      pg,
      'POST',
      '/api/collaboration/sessions',
      { business_ref: { type: 'service_order', id: 'order-chat-client-plan' } },
      authHeaders(tenantId)
    )) as { data: { id: string } };
    await new CollaborationStore(pg).addParticipant({
      tenant_id: tenantId,
      session_id: sessionResult.data.id,
      identity: 'customer-client',
      role: 'customer',
      display_name: 'Customer Client'
    });

    const planResult = (await route(
      pg,
      'POST',
      `/api/collaboration/sessions/${sessionResult.data.id}/chat/client-plan`,
      {
        identity: 'customer-client',
        role: 'customer',
        display_name: 'Customer Client'
      },
      authHeaders(tenantId)
    )) as {
      status: number;
      data: {
        provider: string;
        provider_topic_id: string;
        provider_user_id: string;
        auth_token: string;
        ws_url: string;
        api_key: string;
      };
    };

    assert.equal(planResult.status, 201);
    assert.equal(planResult.data.provider, 'tinode');
    assert.equal(planResult.data.provider_topic_id, 'grpHttpTinodeTopic');
    assert.equal(planResult.data.provider_user_id, 'usrHttpCreatedCustomer');
    assert.equal(planResult.data.auth_token, 'token-http-created-customer');
    assert.equal(planResult.data.ws_url, 'wss://chat.example.com/v0/channels?apikey=tinode-http-api-key');
    assert.equal(planResult.data.api_key, 'tinode-http-api-key');
    assert.equal(JSON.stringify(planResult.data).includes('tinode-http-token'), false);
    assert.equal(JSON.stringify(planResult.data).includes('tinode-user-secret'), false);
    assert.equal(tinode.packets.some((packet) => packet.acc?.scheme === 'basic' && packet.acc?.login === true), true);
    assert.equal(
      tinode.packets.some((packet) =>
        packet.set?.topic === planResult.data.provider_topic_id &&
        packet.set?.sub?.user === 'usrHttpCreatedCustomer' &&
        packet.set?.sub?.mode === 'JRP'
      ),
      true
    );
  } finally {
    await tinode.close();
    restoreEnv('TINODE_BASE_URL', previousEnv.baseUrl);
    restoreEnv('TINODE_WS_URL', previousEnv.wsUrl);
    restoreEnv('TINODE_PUBLIC_WS_URL', previousEnv.publicWsUrl);
    restoreEnv('TINODE_API_KEY', previousEnv.apiKey);
    restoreEnv('TINODE_AUTH_TOKEN', previousEnv.token);
    restoreEnv('TINODE_USER_PASSWORD_SECRET', previousEnv.userPasswordSecret);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function createAttendedControlPlaneRemote(
  pg: MemoryPg,
  tenantId: string,
  businessRefId: string,
  scopes: readonly RemoteConsentScope[]
): Promise<string> {
  const module = createCollaborationModule({ pg });
  const businessRef = { tenant_id: tenantId, type: 'service_order', id: businessRefId };
  const collaboration = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: `Control-plane ${businessRefId}`
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: collaboration.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'rustdesk',
    started_by: 'control-plane-test'
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'control-plane-customer',
    scopes: [...scopes],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  return remote.id;
}

async function startFakeTinodeServerForHttp(): Promise<{
  url: string;
  packets: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const packets: Array<Record<string, any>> = [];
  let accountAttempted = false;
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/v0/channels' });
  wss.on('connection', (ws, req) => {
    assert.equal(req.url?.includes('apikey=tinode-http-api-key'), true);
    ws.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      packets.push(packet);
      if (packet.hi) {
        ws.send(JSON.stringify({ ctrl: { id: packet.hi.id, code: 200, text: 'ok', params: { ver: '0.22' } } }));
      } else if (packet.login) {
        if (packet.login.scheme === 'basic' && !accountAttempted) {
          ws.send(JSON.stringify({ ctrl: { id: packet.login.id, code: 401, text: 'auth failed' } }));
          return;
        }
        ws.send(JSON.stringify({ ctrl: { id: packet.login.id, code: 200, text: 'ok', params: { user: 'usrHttp' } } }));
      } else if (packet.acc) {
        accountAttempted = true;
        ws.send(JSON.stringify({
          ctrl: {
            id: packet.acc.id,
            code: 200,
            text: 'ok',
            params: { user: 'usrHttpCreatedCustomer', token: 'token-http-created-customer' }
          }
        }));
      } else if (packet.sub?.topic === 'new') {
        ws.send(JSON.stringify({ ctrl: { id: packet.sub.id, topic: 'grpHttpTinodeTopic', code: 200, text: 'ok' } }));
      } else if (packet.sub) {
        ws.send(JSON.stringify({ ctrl: { id: packet.sub.id, topic: packet.sub.topic, code: 200, text: 'ok' } }));
      } else if (packet.set) {
        ws.send(JSON.stringify({ ctrl: { id: packet.set.id, topic: packet.set.topic, code: 200, text: 'ok' } }));
      } else if (packet.pub) {
        ws.send(JSON.stringify({
          ctrl: {
            id: packet.pub.id,
            topic: packet.pub.topic,
            code: 200,
            text: 'ok',
            params: { seq: 77 }
          }
        }));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `ws://127.0.0.1:${address.port}/v0/channels`,
    packets,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
