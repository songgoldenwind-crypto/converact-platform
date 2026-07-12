import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import type { RemoteGatewayClient } from '../src/agent-runtime/collaboration/remote-gateway-client.js';
import { RustDeskDeviceStore } from '../src/agent-runtime/collaboration/rustdesk-device-store.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { MemoryPg } from '../src/db-pg.js';
import { createIveKitRustDeskHttpClient } from '../sdk/ivekit/src/rustdesk-http-client.js';

test('shared RustDesk creator rejects unattended launch before the upstream call', async () => {
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'shared');
  let createCalls = 0;
  const client = recordingRustDeskClient(() => { createCalls += 1; });
  const input = {
    tenant_id: fixture.tenantId,
    remote_session_id: fixture.remoteId,
    actor_identity: 'operator-shared',
    client,
    target: { type: 'device', id: fixture.device.rustdesk_id },
    permissions: ['view_screen'] as const,
    access_mode: 'unattended' as const,
    device_id: fixture.device.id,
    metadata: { source: 'ivekit' }
  };

  await assert.rejects(
    () => fixture.module.remote.startGatewayClientSession(input),
    /active unattended access policy required/
  );
  assert.equal(createCalls, 0);

  const attended = await fixture.module.remote.startGatewayClientSession({
    ...input,
    access_mode: 'attended'
  });
  assert.equal(attended.provider, 'rustdesk');
  assert.equal(createCalls, 1);
});

test('legacy RustDesk tools gateway rejects unattended launch before the HTTP upstream call', async () => {
  const previous = gatewayEnv();
  process.env.OPC_API_KEY = 'rustdesk-security-api-key';
  process.env.OPC_REMOTE_GATEWAY_PROVIDER = 'rustdesk';
  process.env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL = 'https://rustdesk-gateway.example.com';
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({
      external_id: 'rdgw-legacy-security',
      launch_url: 'https://rustdesk-gateway.example.com/remote/rustdesk/launch?session_id=rdgw-legacy-security'
    });
  };

  try {
    const pg = new MemoryPg();
    const fixture = await remoteFixture(pg, 'legacy');
    const path = `/api/collaboration/remote-assistance/${fixture.remoteId}/tools/gateway`;
    const response = routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
      actor_identity: 'operator-legacy',
      target: { type: 'device', id: fixture.device.id },
      permissions: ['view_screen'],
      access_mode: 'unattended',
      metadata: { source: 'legacy' }
    }, '', {
      'x-api-key': 'rustdesk-security-api-key',
      'x-tenant-id': fixture.tenantId,
      'x-user-id': 'operator-legacy'
    });

    await assert.rejects(() => response, /active unattended access policy required/);
    assert.equal(upstreamCalls, 0);
    assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 0);

    const secretResponse = routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
      actor_identity: 'operator-legacy',
      target: { type: 'device', id: fixture.device.id },
      permissions: ['view_screen'],
      nested: [{ PrivateKey: 'do-not-send' }],
      metadata: { source: 'legacy' }
    }, '', {
      'x-api-key': 'rustdesk-security-api-key',
      'x-tenant-id': fixture.tenantId,
      'x-user-id': 'operator-legacy'
    });
    await assert.rejects(
      () => secretResponse,
      /RustDesk gateway metadata contains sensitive material/
    );
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreGatewayEnv(previous);
  }
});

test('RustDesk control plane rejects unattended and metadata aliases before store writes', async () => {
  const previous = gatewayEnv();
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
  const pg = new MemoryPg();
  const path = '/api/opc/rustdesk/sessions';
  const base = {
    tenant_id: 'tenant-control-security',
    target: { type: 'device', id: '123456789' },
    permissions: ['view_screen'],
    actor_identity: 'control-plane-agent'
  };

  try {
    const unattended = await routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
      ...base,
      access_mode: 'unattended'
    }, '', { authorization: 'Bearer rustdesk-control-token' });
    assert.deepEqual(unattended, {
      status: 403,
      data: { error: 'unattended RustDesk creation requires the policy-aware iveKit route' }
    });

    const alias = await routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
      ...base,
      metadata: { tenant_id: base.tenant_id, access_mode: 'unattended' }
    }, '', { authorization: 'Bearer rustdesk-control-token' });
    assert.deepEqual(alias, {
      status: 400,
      data: { error: 'RustDesk access_mode must be a top-level field' }
    });
    await assert.rejects(
      () => routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
        ...base,
        nested: [{ apiKey: 'do-not-store' }]
      }, '', { authorization: 'Bearer rustdesk-control-token' }),
      /RustDesk gateway metadata contains sensitive material/
    );
    assert.equal((await new RustDeskGatewaySessionStore(pg).listSessions({
      tenant_id: base.tenant_id,
      status: 'active'
    })).length, 0);
  } finally {
    restoreGatewayEnv(previous);
  }
});

test('RustDesk control plane rejects attended creation without remote consent context', async () => {
  const previous = gatewayEnv();
  process.env.OPC_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
  const pg = new MemoryPg();
  const path = '/api/opc/rustdesk/sessions';

  try {
    const response = await routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
      tenant_id: 'tenant-control-attended-security',
      target: { type: 'device', id: '123456789' },
      permissions: ['view_screen'],
      actor_identity: 'control-plane-agent'
    }, '', { authorization: 'Bearer rustdesk-control-token' });
    assert.deepEqual(response, {
      status: 400,
      data: { error: 'remote_session_id is required' }
    });
    assert.equal((await new RustDeskGatewaySessionStore(pg).listSessions({
      tenant_id: 'tenant-control-attended-security',
      status: 'active'
    })).length, 0);
  } finally {
    restoreGatewayEnv(previous);
  }
});

test('iveKit RustDesk ingress rejects metadata mode aliases and nested secrets before store writes', async () => {
  const previous = gatewayEnv();
  process.env.OPC_API_KEY = 'rustdesk-security-api-key';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'ivekit-ingress');
  const path = '/api/ivekit/rustdesk/gateway-sessions';
  const headers = {
    'x-api-key': 'rustdesk-security-api-key',
    'x-tenant-id': fixture.tenantId,
    'x-user-id': 'operator-ivekit-ingress'
  };
  const base = {
    remote_session_id: fixture.remoteId,
    device_id: fixture.device.id,
    actor_identity: 'operator-ivekit-ingress',
    permissions: ['view_screen']
  };

  try {
    const alias = await routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
      ...base,
      metadata: { access_mode: 'unattended' }
    }, '', headers);
    assert.deepEqual(alias, {
      status: 400,
      data: { error: 'RustDesk access_mode must be a top-level field' }
    });
    await assert.rejects(
      () => routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
        ...base,
        nested: [{ unattendedPassword: 'do-not-store' }]
      }, '', headers),
      /RustDesk gateway metadata contains sensitive material/
    );
    assert.equal((await new RustDeskGatewaySessionStore(pg).listSessions({
      tenant_id: fixture.tenantId,
      status: 'active'
    })).length, 0);
  } finally {
    restoreGatewayEnv(previous);
  }
});

test('generic RustDesk tool persistence rejects nested secret metadata', async () => {
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'generic-tool');

  await assert.rejects(
    () => fixture.module.remote.startToolSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'operator-generic-tool',
      provider: 'rustdesk',
      external_id: 'rdgw-generic-tool',
      launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-generic-tool',
      metadata: { nested: [{ credential_ref: 'secret://rustdesk/generic' }] }
    }),
    /RustDesk gateway metadata contains sensitive material/
  );
  assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 0);
});

test('iveKit SDK allowlists RustDesk session and launch metadata', async () => {
  const responses: unknown[] = [
    {
      id: 'tool-security-sdk',
      tenant_id: 'tenant-security-sdk',
      remote_session_id: 'remote-security-sdk',
      provider: 'rustdesk',
      external_id: 'rdgw-security-sdk',
      launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-security-sdk',
      status: 'active',
      started_by: 'operator-security-sdk',
      started_at: '2026-07-12T00:00:00.000Z',
      ended_at: null,
      internal_column: 'drop-top-level',
      unattended_password: 'do-not-return-top-level',
      metadata: {
        source: 'ivekit',
        rustdesk_device_id: 'rdesk-security-sdk',
        internal_trace: 'drop-me',
        nested: { token: 'do-not-return' }
      }
    },
    {
      external_id: 'rdgw-security-sdk',
      status: 'active',
      launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-security-sdk',
      target: { type: 'device', id: '123456789' },
      permissions: ['view_screen'],
      runtime: { rustdesk_id: '123456789' },
      client_config: {},
      actions: { can_launch: true, open_url: 'https://opc.example.com/remote/rustdesk/launch', protocol_url: '' },
      metadata: {
        site: 'showroom-7',
        access_mode: 'attended',
        internal_column: 'drop-me',
        credential_ref: 'do-not-return'
      },
      created_at: '2026-07-12T00:00:00.000Z',
      ended_at: null,
      internal_column: 'drop-top-level-plan',
      credential_ref: 'do-not-return-top-level-plan'
    }
  ];
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'sdk-token',
    tenantId: 'tenant-security-sdk',
    fetch: async () => Response.json(responses.shift())
  });

  const session = await client.startGatewaySession({
    remote_session_id: 'remote-security-sdk',
    device_id: 'rdesk-security-sdk',
    actor_identity: 'operator-security-sdk',
    permissions: ['view_screen']
  });
  const plan = await client.getGatewayLaunchPlan('rdgw-security-sdk');

  assert.deepEqual(session.metadata, {
    source: 'ivekit',
    rustdesk_device_id: 'rdesk-security-sdk'
  });
  assert.deepEqual(plan.metadata, { site: 'showroom-7', access_mode: 'attended' });
  assert.doesNotMatch(
    JSON.stringify({ session, plan }),
    /drop-me|drop-top-level|do-not-return|credential_ref|unattended_password|token/
  );
});

async function remoteFixture(pg: MemoryPg, suffix: string) {
  const tenantId = `tenant_rustdesk_security_${suffix}`;
  const businessRef = { tenant_id: tenantId, type: 'service_order', id: `order-${suffix}` };
  const module = createCollaborationModule({ pg });
  const collaboration = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: `RustDesk security ${suffix}`
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: collaboration.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'rustdesk',
    started_by: `operator-${suffix}`
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: `customer-${suffix}`,
    scopes: ['view_screen'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const device = await new RustDeskDeviceStore(pg).registerDevice({
    tenant_id: tenantId,
    business_ref: businessRef,
    rustdesk_id: `rustdesk-security-${suffix}`,
    display_name: `RustDesk security ${suffix}`
  });
  return { tenantId, remoteId: remote.id, device, module };
}

function recordingRustDeskClient(onCreate: () => void): RemoteGatewayClient {
  return {
    provider: 'rustdesk',
    async createSession(input) {
      onCreate();
      return {
        provider: 'rustdesk',
        external_id: 'rdgw-shared-security',
        launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-shared-security',
        target: input.target,
        permissions: [...input.permissions],
        metadata: input.metadata
      };
    },
    async endSession() {},
    async listAuditEvents() { return []; }
  };
}

function gatewayEnv() {
  return {
    apiKey: process.env.OPC_API_KEY,
    provider: process.env.OPC_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL,
    token: process.env.OPC_RUSTDESK_API_TOKEN,
    launchSecret: process.env.OPC_RUSTDESK_LAUNCH_SECRET,
    physicalDisconnect: process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT
  };
}

function restoreGatewayEnv(previous: ReturnType<typeof gatewayEnv>): void {
  restoreEnv('OPC_API_KEY', previous.apiKey);
  restoreEnv('OPC_REMOTE_GATEWAY_PROVIDER', previous.provider);
  restoreEnv('OPC_RUSTDESK_CONTROL_PLANE_BASE_URL', previous.baseUrl);
  restoreEnv('OPC_RUSTDESK_API_TOKEN', previous.token);
  restoreEnv('OPC_RUSTDESK_LAUNCH_SECRET', previous.launchSecret);
  restoreEnv('OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT', previous.physicalDisconnect);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
