import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import type { RemoteGatewayClient } from '../src/agent-runtime/collaboration/remote-gateway-client.js';
import { RustDeskDeviceStore } from '../src/agent-runtime/collaboration/rustdesk-device-store.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { createConveractFabricRustDeskHttpClient } from '../sdk/converact/src/rustdesk-http-client.js';

test('Converact Fabric API docs keep the legacy control plane attended-only', () => {
  const docs = readFileSync(new URL('../docs/converact-openapi.md', import.meta.url), 'utf8');
  assert.match(docs, /\/api\/opc\/rustdesk\/sessions[^\n]*attended-only/i);
  assert.match(docs, /unattended[^\n]*\/api\/ivekit\/rustdesk\/gateway-sessions/i);
});

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
    metadata: { source: 'converact' }
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

  await fixture.module.rustdeskAccessPolicies.configurePolicy({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    business_ref: {
      type: fixture.device.business_ref_type,
      id: fixture.device.business_ref_id
    },
    mode: 'unattended_allowed',
    allowed_scopes: ['view_screen'],
    approved_by: 'owner-shared',
    reason: 'Allow the dedicated unattended regression path',
    expires_at: '2099-01-01T00:00:00.000Z',
    idempotency_key: 'policy-shared-dedicated-1'
  });
  const unattended = await fixture.module.remote.startGatewayClientSession(input);
  assert.equal(unattended.provider, 'rustdesk');
  assert.equal(createCalls, 2);
});

test('direct attended RustDesk client start requires the consent permission subset before upstream', async () => {
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'direct-client-subset');
  let createCalls = 0;
  const client = recordingRustDeskClient(() => { createCalls += 1; });

  await assert.rejects(
    () => fixture.module.remote.startGatewayClientSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'operator-direct-client-subset',
      client,
      target: { type: 'device', id: fixture.device.rustdesk_id },
      permissions: ['control_mouse_keyboard'],
      access_mode: 'attended',
      device_id: fixture.device.id
    }),
    /active consent does not cover requested remote permissions/
  );
  assert.equal(createCalls, 0);
  assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 0);
});

test('public RustDesk gateway tool start is attended-only and enforces consent scopes before persistence', async () => {
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'direct-gateway-tool');
  const gateway = {
    provider: 'rustdesk' as const,
    external_id: 'rdgw-direct-gateway-tool',
    launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rdgw-direct-gateway-tool',
    target: { type: 'device', id: fixture.device.rustdesk_id },
    permissions: ['view_screen'] as const,
    metadata: { source: 'direct-test' }
  };

  await assert.rejects(
    () => fixture.module.remote.startGatewayToolSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'operator-direct-gateway-tool',
      gateway: {
        ...gateway,
        metadata: { access_mode: 'unattended' }
      }
    }),
    /direct RustDesk gateway tool start is attended-only/
  );
  const topLevelAliasGateway = Object.assign({}, gateway, { access_mode: 'unattended' });
  await assert.rejects(
    () => fixture.module.remote.startGatewayToolSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'operator-direct-gateway-tool',
      gateway: topLevelAliasGateway
    }),
    /direct RustDesk gateway tool start is attended-only/
  );
  await assert.rejects(
    () => fixture.module.remote.startGatewayToolSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'operator-direct-gateway-tool',
      gateway: {
        ...gateway,
        metadata: { mode: ' UNATTENDED ' }
      }
    }),
    /direct RustDesk gateway tool start is attended-only/
  );
  await assert.rejects(
    () => fixture.module.remote.startGatewayToolSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'operator-direct-gateway-tool',
      gateway: {
        ...gateway,
        permissions: ['control_mouse_keyboard']
      }
    }),
    /active consent does not cover requested remote permissions/
  );
  assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 0);

  const attended = await fixture.module.remote.startGatewayToolSession({
    tenant_id: fixture.tenantId,
    remote_session_id: fixture.remoteId,
    actor_identity: 'operator-direct-gateway-tool',
    gateway
  });
  assert.equal(attended.provider, 'rustdesk');
  assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 1);
});

test('legacy RustDesk tools gateway rejects unattended launch before the HTTP upstream call', async () => {
  const previous = gatewayEnv();
  process.env.CONVERACT_API_KEY = 'rustdesk-security-api-key';
  process.env.CONVERACT_REMOTE_GATEWAY_PROVIDER = 'rustdesk';
  process.env.CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL = 'https://rustdesk-gateway.example.com';
  process.env.CONVERACT_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
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

test('RustDesk control plane rejects unattended and nested metadata aliases before store writes', async () => {
  const previous = gatewayEnv();
  process.env.CONVERACT_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.CONVERACT_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
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
      data: { error: 'unattended RustDesk creation requires the policy-aware Converact Fabric route' }
    });

    const alias = await routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
      ...base,
      metadata: { tenant_id: base.tenant_id, nested: { accessMode: 'unattended' } }
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

test('RustDesk control plane preserves the minimal legacy attended create contract', async () => {
  const previous = gatewayEnv();
  process.env.CONVERACT_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.CONVERACT_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
  const pg = new MemoryPg();
  const path = '/api/opc/rustdesk/sessions';

  try {
    const response = await routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
      tenant_id: 'tenant-control-attended-security',
      target: { type: 'device', id: '123456789' },
      permissions: ['view_screen'],
      actor_identity: 'control-plane-agent'
    }, '', { authorization: 'Bearer rustdesk-control-token' });
    assert.equal((response as { status: number }).status, 201);
    const sessions = await new RustDeskGatewaySessionStore(pg).listSessions({
      tenant_id: 'tenant-control-attended-security',
      status: 'active'
    });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.actor_identity, 'control-plane-agent');
  } finally {
    restoreGatewayEnv(previous);
  }
});

test('RustDesk control plane rejects explicit unattended even with valid policy and consent', async () => {
  const previous = gatewayEnv();
  process.env.CONVERACT_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.CONVERACT_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'control-unattended');
  await fixture.module.rustdeskAccessPolicies.configurePolicy({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    business_ref: {
      type: fixture.device.business_ref_type,
      id: fixture.device.business_ref_id
    },
    mode: 'unattended_allowed',
    allowed_scopes: ['view_screen'],
    approved_by: 'owner-control-unattended',
    reason: 'Prove the legacy control plane remains attended-only',
    expires_at: '2099-01-01T00:00:00.000Z',
    idempotency_key: 'policy-control-unattended-1'
  });
  const path = '/api/opc/rustdesk/sessions';

  try {
    const response = await routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      device_id: fixture.device.id,
      access_mode: 'unattended',
      target: { type: 'device', id: fixture.device.rustdesk_id },
      permissions: ['view_screen'],
      actor_identity: 'control-plane-agent'
    }, '', { authorization: 'Bearer rustdesk-control-token' });
    assert.deepEqual(response, {
      status: 403,
      data: { error: 'unattended RustDesk creation requires the policy-aware Converact Fabric route' }
    });
    assert.equal((await new RustDeskGatewaySessionStore(pg).listSessions({
      tenant_id: fixture.tenantId,
      status: 'active'
    })).length, 0);
  } finally {
    restoreGatewayEnv(previous);
  }
});

test('Converact Fabric RustDesk ingress rejects metadata mode aliases and nested secrets before store writes', async () => {
  const previous = gatewayEnv();
  process.env.CONVERACT_API_KEY = 'rustdesk-security-api-key';
  process.env.CONVERACT_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'converact-ingress');
  const path = '/api/ivekit/rustdesk/gateway-sessions';
  const headers = {
    'x-api-key': 'rustdesk-security-api-key',
    'x-tenant-id': fixture.tenantId,
    'x-user-id': 'operator-converact-ingress'
  };
  const base = {
    remote_session_id: fixture.remoteId,
    device_id: fixture.device.id,
    actor_identity: 'operator-converact-ingress',
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

test('generic direct RustDesk tool persistence is rejected even with safe metadata', async () => {
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'generic-tool');

  await assert.rejects(
    () => fixture.module.remote.startToolSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'operator-generic-tool',
      provider: 'rustdesk',
      external_id: 'rdgw-generic-tool',
      launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rdgw-generic-tool',
      metadata: { source: 'generic-tool-reviewer-probe' }
    }),
    /use the dedicated RustDesk gateway path/
  );
  assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 0);
});

test('generic HTTP RustDesk tool creation is rejected before persistence', async () => {
  const previous = gatewayEnv();
  process.env.CONVERACT_API_KEY = 'rustdesk-security-api-key';
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'generic-http');
  const path = `/api/collaboration/remote-assistance/${fixture.remoteId}/tools`;

  try {
    await assert.rejects(
      () => routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
        actor_identity: 'operator-generic-http',
        provider: 'rustdesk',
        external_id: 'rdgw-generic-http',
        launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rdgw-generic-http',
        metadata: { access_mode: 'attended' }
      }, '', {
        'x-api-key': 'rustdesk-security-api-key',
        'x-tenant-id': fixture.tenantId,
        'x-user-id': 'operator-generic-http'
      }),
      /use the dedicated RustDesk gateway path/
    );
    assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 0);
  } finally {
    restoreGatewayEnv(previous);
  }
});

test('direct RustDesk gateway metadata rejects excessive depth before persistence', async () => {
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'metadata-depth-direct');

  await assert.rejects(
    () => fixture.module.remote.startGatewayToolSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'operator-metadata-depth-direct',
      gateway: directGateway(fixture.device.rustdesk_id, deepMetadata(40))
    }),
    controlledMetadataError(413, /depth limit/)
  );
  assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 0);
});

test('direct RustDesk gateway metadata rejects excessive node count before persistence', async () => {
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'metadata-nodes-direct');
  const metadata = Object.fromEntries(
    Array.from({ length: 10_001 }, (_, index) => [`safe_${index}`, index])
  );

  await assert.rejects(
    () => fixture.module.remote.startGatewayToolSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'operator-metadata-nodes-direct',
      gateway: directGateway(fixture.device.rustdesk_id, metadata)
    }),
    controlledMetadataError(413, /node limit/)
  );
  assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 0);
});

test('direct RustDesk gateway metadata rejects cyclic input before persistence', async () => {
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'metadata-cycle-direct');
  const cyclic: Record<string, unknown> = { source: 'direct-cycle' };
  cyclic.self = cyclic;

  await assert.rejects(
    () => fixture.module.remote.startGatewayToolSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'operator-metadata-cycle-direct',
      gateway: directGateway(fixture.device.rustdesk_id, cyclic)
    }),
    controlledMetadataError(400, /cyclic input/)
  );
  assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 0);
});

test('RustDesk control plane rejects excessive metadata depth before store writes', async () => {
  await assertControlPlaneMetadataRejected(deepMetadata(40), 413, /depth limit/, 'depth');
});

test('RustDesk control plane rejects cyclic metadata before store writes', async () => {
  const cyclic: Record<string, unknown> = { source: 'http-cycle' };
  cyclic.self = cyclic;
  await assertControlPlaneMetadataRejected(cyclic, 400, /cyclic input/, 'cycle');
});

test('JWT collaboration routes reject body actor spoofing before audit or gateway writes', async () => {
  const previous = gatewayEnv();
  const previousJwtSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = 'rustdesk-jwt-actor-secret';
  process.env.CONVERACT_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
  const pg = new MemoryPg();
  const fixture = await remoteFixture(pg, 'jwt-actor');
  const headers = {
    authorization: `Bearer ${signAccessToken({
      sub: 'operator-jwt-actor',
      tid: fixture.tenantId,
      role: 'operator'
    })}`
  };
  const auditPath = `/api/collaboration/remote-assistance/${fixture.remoteId}/audit`;
  const gatewayPath = '/api/ivekit/rustdesk/gateway-sessions';
  const auditCount = (await fixture.module.remote.listAuditEvents({
    tenant_id: fixture.tenantId,
    remote_session_id: fixture.remoteId
  })).length;

  try {
    await assert.rejects(
      () => routeCollaborationApi(pg, 'POST', auditPath, new URL(`http://localhost${auditPath}`), {
        actor_identity: 'spoofed-auditor',
        event_type: 'remote.jwt.spoofed'
      }, '', headers),
      jwtActorConflict
    );
    await assert.rejects(
      () => routeCollaborationApi(pg, 'POST', gatewayPath, new URL(`http://localhost${gatewayPath}`), {
        remote_session_id: fixture.remoteId,
        device_id: fixture.device.id,
        actor_identity: 'spoofed-gateway-operator',
        permissions: ['view_screen'],
        access_mode: 'attended'
      }, '', headers),
      jwtActorConflict
    );
    assert.equal((await fixture.module.remote.listAuditEvents({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId
    })).length, auditCount);
    assert.equal((await fixture.module.remote.listToolSessions(fixture.remoteId)).length, 0);
    assert.equal((await new RustDeskGatewaySessionStore(pg).listSessions({
      tenant_id: fixture.tenantId,
      status: 'active'
    })).length, 0);
  } finally {
    restoreGatewayEnv(previous);
    restoreEnv('CONVERACT_JWT_SECRET', previousJwtSecret);
  }
});

test('Converact Fabric SDK allowlists RustDesk session and launch metadata', async () => {
  const responses: unknown[] = [
    {
      id: 'tool-security-sdk',
      tenant_id: 'tenant-security-sdk',
      remote_session_id: 'remote-security-sdk',
      provider: 'rustdesk',
      external_id: 'rdgw-security-sdk',
      launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rdgw-security-sdk',
      status: 'active',
      started_by: 'operator-security-sdk',
      started_at: '2026-07-12T00:00:00.000Z',
      ended_at: null,
      internal_column: 'drop-top-level',
      unattended_password: 'do-not-return-top-level',
      metadata: {
        source: 'converact',
        rustdesk_device_id: 'rdesk-security-sdk',
        internal_trace: 'drop-me',
        nested: { token: 'do-not-return' }
      }
    },
    {
      external_id: 'rdgw-security-sdk',
      status: 'active',
      launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rdgw-security-sdk',
      target: { type: 'device', id: '123456789' },
      permissions: ['view_screen'],
      runtime: { rustdesk_id: '123456789' },
      client_config: {},
      actions: { can_launch: true, open_url: 'https://converact.example.com/remote/rustdesk/launch', protocol_url: '' },
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
  const client = createConveractFabricRustDeskHttpClient({
    baseUrl: 'https://converact.example.com',
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
    source: 'converact',
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
        launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rdgw-shared-security',
        target: input.target,
        permissions: [...input.permissions],
        metadata: input.metadata
      };
    },
    async endSession() {},
    async listAuditEvents() { return []; }
  };
}

function directGateway(rustdeskId: string, metadata: Record<string, unknown>) {
  return {
    provider: 'rustdesk' as const,
    external_id: `rdgw-${rustdeskId}`,
    launch_url: `https://converact.example.com/remote/rustdesk/launch?session_id=rdgw-${rustdeskId}`,
    target: { type: 'device', id: rustdeskId },
    permissions: ['view_screen'] as const,
    metadata
  };
}

function deepMetadata(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  for (let index = 0; index < depth; index += 1) {
    const child: Record<string, unknown> = {};
    current.child = child;
    current = child;
  }
  current.source = 'deep-metadata';
  return root;
}

function controlledMetadataError(status: number, message: RegExp) {
  return (error: unknown) => {
    assert.equal((error as { status?: number }).status, status);
    assert.match(String(error), message);
    return true;
  };
}

function jwtActorConflict(error: unknown): boolean {
  assert.equal((error as { status?: number }).status, 403);
  assert.match(String(error), /actor_identity must match authenticated identity/);
  return true;
}

async function assertControlPlaneMetadataRejected(
  metadata: Record<string, unknown>,
  status: number,
  message: RegExp,
  suffix: string
): Promise<void> {
  const previous = gatewayEnv();
  process.env.CONVERACT_RUSTDESK_API_TOKEN = 'rustdesk-control-token';
  process.env.CONVERACT_RUSTDESK_LAUNCH_SECRET = 'rustdesk-launch-secret';
  process.env.CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
  const pg = new MemoryPg();
  const tenantId = `tenant-control-metadata-${suffix}`;
  const path = '/api/opc/rustdesk/sessions';
  try {
    await assert.rejects(
      () => routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), {
        tenant_id: tenantId,
        target: { type: 'device', id: `rustdesk-control-metadata-${suffix}` },
        permissions: ['view_screen'],
        actor_identity: 'control-plane-agent',
        metadata
      }, '', { authorization: 'Bearer rustdesk-control-token' }),
      controlledMetadataError(status, message)
    );
    assert.equal((await new RustDeskGatewaySessionStore(pg).listSessions({
      tenant_id: tenantId,
      status: 'active'
    })).length, 0);
  } finally {
    restoreGatewayEnv(previous);
  }
}

function gatewayEnv() {
  return {
    apiKey: process.env.CONVERACT_API_KEY,
    provider: process.env.CONVERACT_REMOTE_GATEWAY_PROVIDER,
    baseUrl: process.env.CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL,
    token: process.env.CONVERACT_RUSTDESK_API_TOKEN,
    launchSecret: process.env.CONVERACT_RUSTDESK_LAUNCH_SECRET,
    physicalDisconnect: process.env.CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT
  };
}

function restoreGatewayEnv(previous: ReturnType<typeof gatewayEnv>): void {
  restoreEnv('CONVERACT_API_KEY', previous.apiKey);
  restoreEnv('CONVERACT_REMOTE_GATEWAY_PROVIDER', previous.provider);
  restoreEnv('CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL', previous.baseUrl);
  restoreEnv('CONVERACT_RUSTDESK_API_TOKEN', previous.token);
  restoreEnv('CONVERACT_RUSTDESK_LAUNCH_SECRET', previous.launchSecret);
  restoreEnv('CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT', previous.physicalDisconnect);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
