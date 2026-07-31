import { resolveConveractEnv } from '../src/config/converact-env.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import type { RemoteGatewayClient } from '../src/agent-runtime/collaboration/remote-gateway-client.js';
import { MemoryPg } from '../src/db-pg.js';
import { createIveKitModule } from '../src/agent-runtime/converact/module.js';
import {
  createIveKitRustDeskHttpClient,
  projectRustDeskAuthorizationCode
} from '../sdk/converact/src/rustdesk-http-client.js';

const API_KEY = 'rustdesk-authorization-integration-api-key';
const AUTHORIZATION_SECRET = 'rustdesk-authorization-integration-secret-at-least-32-bytes';

test('iveKit authorization-code API binds an active engineer and strict attended launch consumes once', async () => {
  const previous = configureEnvironment();
  try {
    const pg = new MemoryPg();
    const fixture = await createFixture(pg, 'http');

    const created = await route(pg, 'POST', '/api/ivekit/rustdesk/authorization-codes', {
      remote_session_id: fixture.remoteId,
      device_id: fixture.deviceId,
      scopes: ['view_screen', 'control_mouse_keyboard'],
      ttl_seconds: 300
    }, headers(fixture.tenantId, 'customer-http', { 'idempotency-key': 'authorization-http-1' })) as {
      status: number;
      data: { authorization: { id: string; status: string }; code: string; replayed: boolean };
    };
    assert.equal(created.status, 201);
    assert.match(created.data.code, /^\d{8}$/);
    assert.equal(created.data.authorization.status, 'pending');

    const replayed = await route(pg, 'POST', '/api/ivekit/rustdesk/authorization-codes', {
      remote_session_id: fixture.remoteId,
      device_id: fixture.deviceId,
      scopes: ['control_mouse_keyboard', 'view_screen'],
      ttl_seconds: 300
    }, headers(fixture.tenantId, 'customer-http', { 'idempotency-key': 'authorization-http-1' })) as {
      status?: number;
      data: { code: string | null; replayed: boolean };
    };
    assert.equal(replayed.status, undefined);
    assert.equal(replayed.data.replayed, true);
    assert.equal(replayed.data.code, null);

    const verified = await route(
      pg,
      'POST',
      `/api/ivekit/rustdesk/authorization-codes/${created.data.authorization.id}/verify`,
      { code: created.data.code },
      headers(fixture.tenantId, 'engineer-http')
    ) as { data: { status: string; verified_by: string } };
    assert.equal(verified.data.status, 'verified');
    assert.equal(verified.data.verified_by, 'engineer-http');

    const missingCode = await route(pg, 'POST', '/api/ivekit/rustdesk/gateway-sessions', {
      remote_session_id: fixture.remoteId,
      device_id: fixture.deviceId,
      permissions: ['view_screen'],
      access_mode: 'attended'
    }, headers(fixture.tenantId, 'engineer-http')) as { status: number; data: { error: string } };
    assert.equal(missingCode.status, 403);
    assert.match(missingCode.data.error, /authorization code required/i);

    const launched = await route(pg, 'POST', '/api/ivekit/rustdesk/gateway-sessions', {
      remote_session_id: fixture.remoteId,
      device_id: fixture.deviceId,
      permissions: ['view_screen', 'control_mouse_keyboard'],
      access_mode: 'attended',
      authorization_id: created.data.authorization.id
    }, headers(fixture.tenantId, 'engineer-http')) as {
      status: number;
      data: { external_id: string };
    };
    assert.equal(launched.status, 201);
    assert.ok(launched.data.external_id);

    const status = await route(
      pg,
      'GET',
      `/api/ivekit/rustdesk/authorization-codes/${created.data.authorization.id}`,
      null,
      headers(fixture.tenantId, 'customer-http')
    ) as { data: { status: string; consumed_external_id: string } };
    assert.equal(status.data.status, 'consumed');
    assert.equal(status.data.consumed_external_id, launched.data.external_id);

    await assert.rejects(() => route(pg, 'POST', '/api/ivekit/rustdesk/gateway-sessions', {
      remote_session_id: fixture.remoteId,
      device_id: fixture.deviceId,
      permissions: ['view_screen', 'control_mouse_keyboard'],
      access_mode: 'attended',
      authorization_id: created.data.authorization.id
    }, headers(fixture.tenantId, 'engineer-http')), /required or unavailable/i);
  } finally {
    restoreEnvironment(previous);
  }
});

test('strict attended activation does not consume a verified code when authorization changes upstream', async () => {
  const previous = configureEnvironment();
  try {
    const pg = new MemoryPg();
    const fixture = await createFixture(pg, 'rollback');
    const module = createCollaborationModule({ pg });
    const created = await module.rustdeskAuthorizationCodes.create({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      device_id: fixture.deviceId,
      scopes: ['view_screen'],
      requested_by: 'customer-rollback',
      idempotency_key: 'authorization-rollback-1'
    });
    await module.rustdeskAuthorizationCodes.verify({
      tenant_id: fixture.tenantId,
      authorization_id: created.authorization.id,
      code: created.code!,
      verified_by: 'engineer-rollback'
    });

    let ended = false;
    const client: RemoteGatewayClient = {
      provider: 'rustdesk',
      async createSession(input) {
        await module.remote.revokeConsent({
          tenant_id: fixture.tenantId,
          remote_session_id: fixture.remoteId,
          actor_identity: 'customer-rollback',
          scopes: ['view_screen']
        });
        return {
          provider: 'rustdesk',
          external_id: 'rdgw-authorization-rollback',
          launch_url: 'https://opc.example.test/remote/rustdesk/launch',
          target: input.target,
          permissions: [...input.permissions],
          metadata: input.metadata
        };
      },
      async endSession() {
        ended = true;
      },
      async listAuditEvents() {
        return [];
      }
    };

    await assert.rejects(() => module.remote.startGatewayClientSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'engineer-rollback',
      client,
      target: { type: 'device', id: fixture.rustdeskId },
      permissions: ['view_screen'],
      access_mode: 'attended',
      device_id: fixture.deviceId,
      authorization_id: created.authorization.id
    }), /gateway authorization changed/i);
    assert.equal(ended, true);
    assert.equal((await module.rustdeskAuthorizationCodes.get({
      tenant_id: fixture.tenantId,
      authorization_id: created.authorization.id
    }))?.status, 'verified');
  } finally {
    restoreEnvironment(previous);
  }
});

test('strict attended launch claims once before concurrent upstream creation', async () => {
  const previous = configureEnvironment();
  try {
    const pg = new MemoryPg();
    const fixture = await createFixture(pg, 'concurrent-claim');
    const module = createCollaborationModule({ pg });
    const created = await module.rustdeskAuthorizationCodes.create({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      device_id: fixture.deviceId,
      scopes: ['view_screen'],
      requested_by: 'customer-concurrent-claim',
      idempotency_key: 'authorization-concurrent-claim-1'
    });
    await module.rustdeskAuthorizationCodes.verify({
      tenant_id: fixture.tenantId,
      authorization_id: created.authorization.id,
      code: created.code!,
      verified_by: 'engineer-concurrent-claim'
    });

    let createCalls = 0;
    const client: RemoteGatewayClient = {
      provider: 'rustdesk',
      async createSession(input) {
        createCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          provider: 'rustdesk',
          external_id: `rdgw-concurrent-${createCalls}`,
          launch_url: 'https://opc.example.test/remote/rustdesk/launch',
          target: input.target,
          permissions: [...input.permissions],
          metadata: input.metadata
        };
      },
      async endSession() {},
      async listAuditEvents() { return []; }
    };
    const launch = () => module.remote.startGatewayClientSession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'engineer-concurrent-claim',
      client,
      target: { type: 'device' as const, id: fixture.rustdeskId },
      permissions: ['view_screen'] as const,
      access_mode: 'attended' as const,
      device_id: fixture.deviceId,
      authorization_id: created.authorization.id
    });

    const results = await Promise.allSettled([launch(), launch()]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(createCalls, 1, 'the losing request must fail before contacting RustDesk');
  } finally {
    restoreEnvironment(previous);
  }
});

test('iveKit RustDesk SDK exposes sanitized authorization-code create, get, and verify contracts', async () => {
  const calls: Array<{ method: string; path: string; headers: Headers; body: unknown }> = [];
  const authorization = authorizationDto('sdk');
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://ivekit.example.test',
    tenantId: authorization.tenant_id,
    apiKey: 'sdk-authorization-key',
    userId: 'engineer-sdk',
    async fetch(input, init) {
      const url = new URL(String(input));
      calls.push({
        method: String(init?.method || 'GET'),
        path: url.pathname,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : null
      });
      const isCreate = url.pathname.endsWith('/authorization-codes');
      const isVerify = url.pathname.endsWith('/verify');
      const payload = isCreate
        ? { authorization, code: '12345678', replayed: false }
        : isVerify
          ? { ...authorization, status: 'verified', verified_by: 'engineer-sdk', verified_at: authorization.updated_at }
          : authorization;
      return new Response(JSON.stringify(payload), {
        status: isCreate ? 201 : 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const created = await client.requestAuthorizationCode({
    remote_session_id: authorization.remote_session_id,
    device_id: authorization.device_id,
    scopes: ['view_screen'],
    ttl_seconds: 300,
    max_attempts: 5
  }, { idempotencyKey: 'sdk-authorization-1' });
  assert.equal(created.code, '12345678');
  assert.equal(calls[0].headers.get('idempotency-key'), 'sdk-authorization-1');
  assert.deepEqual(calls[0].body, {
    remote_session_id: authorization.remote_session_id,
    device_id: authorization.device_id,
    scopes: ['view_screen'],
    ttl_seconds: 300,
    max_attempts: 5
  });
  assert.deepEqual(await client.getAuthorizationCode(authorization.id), authorization);
  assert.equal((await client.verifyAuthorizationCode(authorization.id, { code: '12345678' })).status, 'verified');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'POST /api/ivekit/rustdesk/authorization-codes',
    `GET /api/ivekit/rustdesk/authorization-codes/${authorization.id}`,
    `POST /api/ivekit/rustdesk/authorization-codes/${authorization.id}/verify`
  ]);
  assert.throws(
    () => projectRustDeskAuthorizationCode({ ...authorization, code_hmac: 'secret' }),
    /code_hmac/
  );
});

test('in-process iveKit facade exposes the same authorization exchange and atomic gateway consumption', async () => {
  const previous = configureEnvironment();
  try {
    const pg = new MemoryPg();
    const fixture = await createFixture(pg, 'facade');
    const gateway: RemoteGatewayClient = {
      provider: 'rustdesk',
      async createSession(input) {
        return {
          provider: 'rustdesk',
          external_id: 'rdgw-authorization-facade',
          launch_url: 'https://opc.example.test/remote/rustdesk/launch',
          target: input.target,
          permissions: [...input.permissions],
          metadata: input.metadata
        };
      },
      async endSession() {},
      async listAuditEvents() { return []; }
    };
    const ivekit = createIveKitModule({ db: null, pg, remoteGateway: gateway });
    const requested = await ivekit.rustdesk.requestAuthorizationCode({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      device_id: fixture.deviceId,
      scopes: ['view_screen'],
      requested_by: 'customer-facade',
      idempotency_key: 'authorization-facade-1'
    });
    const verified = await ivekit.rustdesk.verifyAuthorizationCode({
      tenant_id: fixture.tenantId,
      authorization_id: requested.authorization.id,
      code: requested.code!,
      verified_by: 'engineer-facade'
    });
    assert.equal(verified.status, 'verified');
    const tool = await ivekit.rustdesk.startGatewaySession({
      tenant_id: fixture.tenantId,
      remote_session_id: fixture.remoteId,
      actor_identity: 'engineer-facade',
      device_id: fixture.deviceId,
      permissions: ['view_screen'],
      access_mode: 'attended',
      authorization_id: requested.authorization.id
    });
    assert.equal(tool.external_id, 'rdgw-authorization-facade');
    assert.equal((await ivekit.rustdesk.getAuthorizationCode({
      tenant_id: fixture.tenantId,
      authorization_id: requested.authorization.id
    }))?.status, 'consumed');
  } finally {
    restoreEnvironment(previous);
  }
});

test('RustDesk authorization-code deployment contract uses external secrets and an explicit strict switch', () => {
  const rootEnv = readFileSync('.env.example', 'utf8');
  const productionEnv = readFileSync('infra/env.example', 'utf8');
  const standaloneEnv = readFileSync('infra/converact/env.example', 'utf8');
  const productionCompose = readFileSync('infra/docker-compose.production.yml', 'utf8');
  const standaloneCompose = readFileSync('infra/converact/docker-compose.yml', 'utf8');
  const serviceCompose = readFileSync('services/converact-service/docker-compose.yml', 'utf8');
  const helmDeployment = readFileSync('infra/k8s/templates/opc-deployment.yaml', 'utf8');
  const helmSecrets = readFileSync('infra/k8s/templates/secrets.yaml', 'utf8');

  for (const env of [rootEnv, productionEnv]) {
    assert.match(env, /^CONVERACT_RUSTDESK_AUTHORIZATION_CODE_SECRET=$/m);
    assert.match(env, /^CONVERACT_RUSTDESK_REQUIRE_AUTHORIZATION_CODE=0$/m);
  }
  assert.match(standaloneEnv, /^CONVERACT_RUSTDESK_AUTHORIZATION_CODE_SECRET=replace_with_/m);
  assert.match(standaloneEnv, /^CONVERACT_RUSTDESK_REQUIRE_AUTHORIZATION_CODE=1$/m);
  assert.match(productionCompose, /CONVERACT_RUSTDESK_AUTHORIZATION_CODE_SECRET: \$\{CONVERACT_RUSTDESK_AUTHORIZATION_CODE_SECRET:-\}/);
  assert.match(standaloneCompose, /CONVERACT_RUSTDESK_AUTHORIZATION_CODE_SECRET: \$\{CONVERACT_RUSTDESK_AUTHORIZATION_CODE_SECRET:\?/);
  assert.match(serviceCompose, /CONVERACT_RUSTDESK_REQUIRE_AUTHORIZATION_CODE: \$\{CONVERACT_RUSTDESK_REQUIRE_AUTHORIZATION_CODE:-0\}/);
  assert.match(helmDeployment, /name: CONVERACT_RUSTDESK_AUTHORIZATION_CODE_SECRET[\s\S]*key: rustdesk-authorization-code-secret/);
  assert.match(helmSecrets, /rustdesk-authorization-code-secret:/);
});

async function createFixture(pg: MemoryPg, suffix: string) {
  const tenantId = `tenant-authorization-${suffix}`;
  const module = createCollaborationModule({ pg });
  const businessRef = { tenant_id: tenantId, type: 'service_order', id: `order-${suffix}` };
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: `Authorization ${suffix}`
  });
  for (const participant of [
    { identity: `customer-${suffix}`, role: 'customer' as const },
    { identity: `engineer-${suffix}`, role: 'engineer' as const }
  ]) {
    await module.sessions.addParticipant({
      tenant_id: tenantId,
      session_id: session.id,
      ...participant
    });
  }
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'rustdesk',
    started_by: `engineer-${suffix}`
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: `customer-${suffix}`,
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const rustdeskId = `rustdesk-authorization-${suffix}`;
  const device = await module.rustdeskDevices.registerDevice({
    tenant_id: tenantId,
    business_ref: businessRef,
    rustdesk_id: rustdeskId,
    display_name: `Authorization device ${suffix}`
  });
  return { tenantId, remoteId: remote.id, deviceId: device.id, rustdeskId };
}

function route(
  pg: MemoryPg,
  method: string,
  path: string,
  body: unknown,
  requestHeaders: Record<string, string>
) {
  return routeCollaborationApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    requestHeaders
  );
}

function headers(tenantId: string, userId: string, extra: Record<string, string> = {}) {
  return {
    'x-api-key': API_KEY,
    'x-tenant-id': tenantId,
    'x-user-id': userId,
    ...extra
  };
}

function configureEnvironment(): Record<string, string | undefined> {
  const keys = [
    'CONVERACT_API_KEY',
    'CONVERACT_BASE_URL',
    'CONVERACT_RUSTDESK_AUTHORIZATION_CODE_SECRET',
    'CONVERACT_RUSTDESK_REQUIRE_AUTHORIZATION_CODE',
    'CONVERACT_RUSTDESK_LAUNCH_SECRET',
    'CONVERACT_RUSTDESK_PUBLIC_KEY',
    'CONVERACT_RUSTDESK_ID_SERVER',
    'CONVERACT_RUSTDESK_RELAY_SERVER',
    'CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE'
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, resolveConveractEnv(process.env, key)]));
  process.env.CONVERACT_API_KEY = API_KEY;
  process.env.CONVERACT_BASE_URL = 'https://opc.example.test';
  process.env.CONVERACT_RUSTDESK_AUTHORIZATION_CODE_SECRET = AUTHORIZATION_SECRET;
  process.env.CONVERACT_RUSTDESK_REQUIRE_AUTHORIZATION_CODE = '1';
  process.env.CONVERACT_RUSTDESK_LAUNCH_SECRET = 'rustdesk-authorization-launch-secret';
  process.env.CONVERACT_RUSTDESK_PUBLIC_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
  process.env.CONVERACT_RUSTDESK_ID_SERVER = 'rustdesk-id.example.test';
  process.env.CONVERACT_RUSTDESK_RELAY_SERVER = 'rustdesk-relay.example.test';
  process.env.CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE = 'rustdesk://connect/{rustdesk_id}?session={external_id}';
  return previous;
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function authorizationDto(suffix: string) {
  return {
    id: `rdauth-${suffix}`,
    tenant_id: `tenant-${suffix}`,
    remote_session_id: `remote-${suffix}`,
    device_id: `rddev-${suffix}`,
    scopes: ['view_screen'] as const,
    requested_by: `customer-${suffix}`,
    requested_at: '2026-07-15T01:00:00.000Z',
    expires_at: '2026-07-15T01:05:00.000Z',
    max_attempts: 5,
    attempt_count: 0,
    status: 'pending' as const,
    verified_by: null,
    verified_at: null,
    consumed_external_id: null,
    consumed_at: null,
    updated_at: '2026-07-15T01:00:00.000Z'
  };
}
