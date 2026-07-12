import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  RustDeskAccessPolicyStore
} from '../src/agent-runtime/collaboration/rustdesk-access-policy-store.js';
import {
  createCollaborationModule
} from '../src/agent-runtime/collaboration/index.js';
import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createIveKitModule } from '../src/agent-runtime/ivekit/module.js';
import type { RemoteGatewayClient } from '../src/agent-runtime/collaboration/remote-gateway-client.js';
import { RustDeskDeviceStore } from '../src/agent-runtime/collaboration/rustdesk-device-store.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';
import { signAccessToken, type AuthRole } from '../src/middleware/auth.js';
import { createIveKitRustDeskHttpClient } from '../sdk/ivekit/src/rustdesk-http-client.js';
import type {
  ConfigureIveKitRustDeskAccessPolicyInput,
  IveKitRustDeskAccessPolicyHttpClient,
  IveKitRustDeskHttpClient
} from '../src/agent-runtime/ivekit/index.js';

const compilePolicyInput: ConfigureIveKitRustDeskAccessPolicyInput = {
  mode: 'unattended_allowed',
  allowed_scopes: ['view_screen'] as const,
  business_ref: { type: 'service_order', id: 'compile-policy' },
  reason: 'Compile the additive policy contract'
};
const compileLegacyClient = (client: IveKitRustDeskAccessPolicyHttpClient): IveKitRustDeskHttpClient => client;
void compilePolicyInput;
void compileLegacyClient;

test('RustDesk access policy migration is append-only and protected by forced tenant RLS', () => {
  const migrationUrl = new URL('../src/migrations/039_rustdesk_access_policy.sql', import.meta.url);
  assert.equal(existsSync(migrationUrl), true, 'RustDesk access policy migration must exist');

  const migration = readFileSync(migrationUrl, 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rustdesk_access_policy_events \(/);
  assert.match(migration, /event_type TEXT NOT NULL[\s\S]*configured[\s\S]*revoked/);
  assert.match(migration, /mode TEXT NOT NULL[\s\S]*attended_only[\s\S]*unattended_allowed/);
  assert.match(migration, /allowed_scopes/);
  assert.match(migration, /approved_by TEXT NOT NULL/);
  assert.match(migration, /expires_at TIMESTAMPTZ/);
  assert.match(migration, /business_ref_type TEXT NOT NULL/);
  assert.match(migration, /business_ref_id TEXT NOT NULL/);
  assert.match(migration, /reason TEXT NOT NULL/);
  assert.match(migration, /supersedes_id TEXT/);
  assert.match(migration, /version INTEGER NOT NULL/);
  assert.match(migration, /idempotency_key TEXT NOT NULL/);
  assert.match(migration, /request_hash TEXT NOT NULL/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON rustdesk_access_policy_events/);
  assert.match(migration, /access policy history is immutable/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE POLICY tenant_isolation/);
  assert.match(migration, /opc_rls_bypass\(\) OR tenant_id = opc_current_tenant\(\)/);
  assert.doesNotMatch(migration, /password|credential_ref|credential-ref/i);
});

test('full schema includes the RustDesk access policy append-only history', () => {
  const migration = readFileSync(
    new URL('../src/migrations/039_rustdesk_access_policy.sql', import.meta.url),
    'utf8'
  );
  const schema = readFileSync(
    new URL('../src/migrations/005_full_schema.sql', import.meta.url),
    'utf8'
  );

  assert.match(schema, /CREATE TABLE IF NOT EXISTS rustdesk_access_policy_events \(/);
  assert.match(schema, /BEFORE UPDATE OR DELETE ON rustdesk_access_policy_events/);
  assert.equal(accessPolicyRlsBlock(schema), accessPolicyRlsBlock(migration));
  assert.doesNotMatch(schema, /rustdesk_access_policy[\s\S]{0,500}(password|credential_ref|credential-ref)/i);
});

test('RustDesk access policy store returns current state and ordered immutable history', async () => {
  const pg = new MemoryPg();
  const { tenantId, device } = await createDevice(pg, 'history');
  const store = new RustDeskAccessPolicyStore(pg);

  const first = await store.configurePolicy({
    tenant_id: tenantId,
    device_id: device.id,
    business_ref: { type: device.business_ref_type, id: device.business_ref_id },
    mode: 'unattended_allowed',
    allowed_scopes: ['control_mouse_keyboard', 'view_screen', 'view_screen'],
    approved_by: 'owner-history',
    reason: 'Allow bounded after-hours diagnostics',
    expires_at: '2026-07-14T00:00:00.000Z',
    idempotency_key: 'policy-history-1'
  });
  const second = await store.configurePolicy({
    tenant_id: tenantId,
    device_id: device.id,
    business_ref: { type: device.business_ref_type, id: device.business_ref_id },
    mode: 'attended_only',
    allowed_scopes: [],
    approved_by: 'admin-history',
    reason: 'Return the device to attended support',
    expires_at: null,
    idempotency_key: 'policy-history-2'
  });
  const current = await store.getCurrentPolicy({
    tenant_id: tenantId,
    device_id: device.id,
    now: new Date('2026-07-13T00:00:00.000Z')
  });
  const history = await store.listPolicyHistory({
    tenant_id: tenantId,
    device_id: device.id,
    now: new Date('2026-07-13T00:00:00.000Z')
  });

  assert.equal(first.replayed, false);
  assert.deepEqual(first.policy.allowed_scopes, ['control_mouse_keyboard', 'view_screen']);
  assert.equal(second.policy.version, 2);
  assert.equal(current.state, 'active');
  assert.equal(current.policy?.mode, 'attended_only');
  assert.deepEqual(history.events.map((event) => event.version), [1, 2]);
  assert.deepEqual(history.events.map((event) => event.state), ['superseded', 'active']);
  assert.deepEqual(history.events.map((event) => event.approved_by), ['owner-history', 'admin-history']);
  assert.doesNotMatch(
    JSON.stringify({ current, history }),
    /request_hash|idempotency_key|supersedes_id|password|secret|token|credential/i
  );
  assert.equal((await store.getCurrentPolicy({
    tenant_id: 'tenant-other',
    device_id: device.id
  })).state, 'not_configured');
});

test('RustDesk access policy store enforces idempotency and serializes concurrent versions', async () => {
  const pg = new MemoryPg();
  const { tenantId, device } = await createDevice(pg, 'idempotency');
  const store = new RustDeskAccessPolicyStore(pg);
  const base = {
    tenant_id: tenantId,
    device_id: device.id,
    business_ref: { type: device.business_ref_type, id: device.business_ref_id },
    mode: 'unattended_allowed' as const,
    allowed_scopes: ['view_screen', 'control_mouse_keyboard'] as const,
    approved_by: 'owner-idempotency',
    reason: 'Permit read-only unattended diagnosis',
    expires_at: '2026-07-20T00:00:00.000Z',
    idempotency_key: 'policy-idempotency-1'
  };

  const created = await store.configurePolicy(base);
  const replayed = await store.configurePolicy({
    ...base,
    allowed_scopes: ['control_mouse_keyboard', 'view_screen'],
    expires_at: '2026-07-20T08:00:00.000+08:00'
  });
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.policy, created.policy);
  await assert.rejects(
    () => store.configurePolicy({ ...base, reason: 'Different semantic request' }),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match(String(error), /idempotency key was already used/);
      return true;
    }
  );

  const concurrent = await Promise.all([
    store.configurePolicy({
      ...base,
      reason: 'First concurrent policy change',
      idempotency_key: 'policy-idempotency-2'
    }),
    store.configurePolicy({
      ...base,
      reason: 'Second concurrent policy change',
      idempotency_key: 'policy-idempotency-3'
    })
  ]);
  assert.deepEqual(concurrent.map((result) => result.policy.version).sort(), [2, 3]);
  assert.deepEqual(
    (await store.listPolicyHistory({ tenant_id: tenantId, device_id: device.id })).events.map((event) => event.version),
    [1, 2, 3]
  );
});

test('RustDesk access policy store derives expiry and revocation without mutating history', async () => {
  const pg = new MemoryPg();
  const { tenantId, device } = await createDevice(pg, 'lifecycle');
  const store = new RustDeskAccessPolicyStore(pg);
  await store.configurePolicy({
    tenant_id: tenantId,
    device_id: device.id,
    business_ref: { type: device.business_ref_type, id: device.business_ref_id },
    mode: 'unattended_allowed',
    allowed_scopes: ['view_screen'],
    approved_by: 'owner-lifecycle',
    reason: 'Temporary unattended support window',
    expires_at: '2026-07-13T00:00:00.000Z',
    idempotency_key: 'policy-lifecycle-1'
  });
  const expired = await store.getCurrentPolicy({
    tenant_id: tenantId,
    device_id: device.id,
    now: new Date('2026-07-13T00:00:00.000Z')
  });
  assert.equal(expired.state, 'expired');

  const revoked = await store.revokePolicy({
    tenant_id: tenantId,
    device_id: device.id,
    approved_by: 'admin-lifecycle',
    reason: 'Support window was closed by the customer',
    idempotency_key: 'policy-lifecycle-2'
  });
  assert.equal(revoked.policy.event_type, 'revoked');
  assert.equal(revoked.policy.version, 2);
  const current = await store.getCurrentPolicy({ tenant_id: tenantId, device_id: device.id });
  assert.equal(current.state, 'revoked');
  assert.deepEqual(
    (await store.listPolicyHistory({ tenant_id: tenantId, device_id: device.id })).events.map((event) => event.state),
    ['superseded', 'revoked']
  );
});

test('RustDesk access policy store projects PostgreSQL timestamp values as ISO strings', async () => {
  const pg = {
    async query() {
      return {
        rows: [{
          id: 'rdpol-pg-date',
          tenant_id: 'tenant-pg-date',
          device_id: 'rdesk-pg-date',
          event_type: 'configured',
          mode: 'unattended_allowed',
          allowed_scopes: ['view_screen'],
          business_ref_type: 'service_order',
          business_ref_id: 'order-pg-date',
          approved_by: 'owner-pg-date',
          reason: 'Verify PostgreSQL timestamp projection',
          expires_at: new Date('2026-07-20T00:00:00.000Z'),
          supersedes_id: null,
          version: 1,
          idempotency_key: 'policy-pg-date',
          request_hash: 'a'.repeat(64),
          created_at: new Date('2026-07-12T00:00:00.000Z')
        }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: []
      };
    }
  } as PgQueryable;

  const current = await new RustDeskAccessPolicyStore(pg).getCurrentPolicy({
    tenant_id: 'tenant-pg-date',
    device_id: 'rdesk-pg-date',
    now: new Date('2026-07-13T00:00:00.000Z')
  });
  assert.equal(current.policy?.created_at, '2026-07-12T00:00:00.000Z');
  assert.equal(current.policy?.expires_at, '2026-07-20T00:00:00.000Z');
});

test('RustDesk unattended authorization requires an active matching policy and policy scope subset', async () => {
  const pg = new MemoryPg();
  const { tenantId, device } = await createDevice(pg, 'authorization');
  const store = new RustDeskAccessPolicyStore(pg);
  const businessRef = { type: device.business_ref_type, id: device.business_ref_id };
  await assert.rejects(
    () => store.assertUnattendedAccess({
      tenant_id: tenantId,
      device_id: device.id,
      business_ref: businessRef,
      permissions: ['view_screen']
    }),
    /active unattended access policy required/
  );
  await store.configurePolicy({
    tenant_id: tenantId,
    device_id: device.id,
    business_ref: businessRef,
    mode: 'unattended_allowed',
    allowed_scopes: ['view_screen'],
    approved_by: 'owner-authorization',
    reason: 'Allow unattended read-only support',
    expires_at: '2026-07-20T00:00:00.000Z',
    idempotency_key: 'policy-authorization-1'
  });

  const policy = await store.assertUnattendedAccess({
    tenant_id: tenantId,
    device_id: device.id,
    business_ref: businessRef,
    permissions: ['view_screen'],
    now: new Date('2026-07-19T00:00:00.000Z')
  });
  assert.equal(policy.mode, 'unattended_allowed');
  await assert.rejects(
    () => store.assertUnattendedAccess({
      tenant_id: tenantId,
      device_id: device.id,
      business_ref: businessRef,
      permissions: ['control_mouse_keyboard'],
      now: new Date('2026-07-19T00:00:00.000Z')
    }),
    /policy does not cover requested remote permissions/
  );
  await assert.rejects(
    () => store.assertUnattendedAccess({
      tenant_id: tenantId,
      device_id: device.id,
      business_ref: { type: 'service_order', id: 'wrong-order' },
      permissions: ['view_screen'],
      now: new Date('2026-07-19T00:00:00.000Z')
    }),
    /active unattended access policy required/
  );
  await assert.rejects(
    () => store.assertUnattendedAccess({
      tenant_id: tenantId,
      device_id: device.id,
      business_ref: businessRef,
      permissions: ['view_screen'],
      now: new Date('2026-07-20T00:00:00.000Z')
    }),
    /active unattended access policy required/
  );
});

test('collaboration module exposes the single PostgreSQL RustDesk access policy store', () => {
  const module = createCollaborationModule({ pg: new MemoryPg() });
  assert.equal(module.rustdeskAccessPolicies instanceof RustDeskAccessPolicyStore, true);
});

test('RustDesk policy HTTP routes use JWT approver identity, idempotency, history, and cross-tenant 404', async () => {
  const previousSecret = process.env.OPC_JWT_SECRET;
  process.env.OPC_JWT_SECRET = 'rustdesk-policy-http-secret';
  const pg = new MemoryPg();
  const { tenantId, device } = await createDevice(pg, 'http');
  const ownerHeaders = jwtHeaders(tenantId, 'owner-http', 'owner');
  const body = {
    mode: 'unattended_allowed',
    allowed_scopes: ['view_screen'],
    business_ref: { type: device.business_ref_type, id: device.business_ref_id },
    expires_at: '2026-07-20T00:00:00.000Z',
    reason: 'Allow read-only unattended HTTP support'
  };
  try {
    const before = await policyRoute(pg, 'GET', device.id, '', null, ownerHeaders) as {
      data: { state: string }
    };
    assert.equal(before.data.state, 'not_configured');

    const created = await policyRoute(pg, 'PUT', device.id, '', body, {
      ...ownerHeaders,
      'idempotency-key': 'policy-http-1'
    }) as {
      status: number;
      data: { replayed: boolean; policy: { approved_by: string; version: number } };
    };
    assert.equal(created.status, 201);
    assert.equal(created.data.replayed, false);
    assert.equal(created.data.policy.approved_by, 'owner-http');

    const replayed = await policyRoute(pg, 'PUT', device.id, '', body, {
      ...ownerHeaders,
      'idempotency-key': 'policy-http-1'
    }) as typeof created;
    assert.equal(replayed.status, 200);
    assert.equal(replayed.data.replayed, true);
    assert.equal(replayed.data.policy.version, 1);

    await assert.rejects(
      () => policyRoute(pg, 'PUT', device.id, '', { ...body, reason: 'Changed input' }, {
        ...ownerHeaders,
        'idempotency-key': 'policy-http-1'
      }),
      (error) => {
        assert.equal((error as { status?: number }).status, 409);
        return true;
      }
    );

    const current = await policyRoute(pg, 'GET', device.id, '', null, ownerHeaders) as {
      data: { policy: { approved_by: string; allowed_scopes: string[] } }
    };
    assert.equal(current.data.policy.approved_by, 'owner-http');
    assert.deepEqual(current.data.policy.allowed_scopes, ['view_screen']);

    const history = await policyRoute(pg, 'GET', device.id, 'history', null, ownerHeaders) as {
      data: { events: Array<{ version: number; state: string }> }
    };
    assert.deepEqual(history.data.events.map((event) => event.version), [1]);

    const crossTenant = await policyRoute(
      pg,
      'GET',
      device.id,
      '',
      null,
      jwtHeaders('tenant-policy-other-http', 'owner-other', 'owner')
    );
    assert.deepEqual(crossTenant, {
      status: 404,
      data: { error: 'rustdesk device not found' }
    });

    const revoked = await policyRoute(pg, 'POST', device.id, 'revoke', {
      reason: 'Customer ended unattended access'
    }, {
      ...ownerHeaders,
      'idempotency-key': 'policy-http-2'
    }) as { status: number; data: { policy: { event_type: string; approved_by: string } } };
    assert.equal(revoked.status, 201);
    assert.equal(revoked.data.policy.event_type, 'revoked');
    assert.equal(revoked.data.policy.approved_by, 'owner-http');
  } finally {
    restoreEnv('OPC_JWT_SECRET', previousSecret);
  }
});

test('RustDesk policy HTTP rejects non-owner roles, system auth, missing reason/key, and sensitive fields', async () => {
  const previousSecret = process.env.OPC_JWT_SECRET;
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_JWT_SECRET = 'rustdesk-policy-http-auth-secret';
  process.env.OPC_API_KEY = 'rustdesk-policy-system-key';
  const pg = new MemoryPg();
  const { tenantId, device } = await createDevice(pg, 'http-auth');
  const validBody = {
    mode: 'unattended_allowed',
    allowed_scopes: ['view_screen'],
    business_ref: { type: device.business_ref_type, id: device.business_ref_id },
    expires_at: '2026-07-20T00:00:00.000Z',
    reason: 'Bounded policy reason'
  };
  try {
    for (const role of ['operator', 'viewer', 'system'] as const) {
      const denied = await policyRoute(pg, 'PUT', device.id, '', validBody, {
        ...jwtHeaders(tenantId, `${role}-http`, role),
        'idempotency-key': `policy-http-role-${role}`
      });
      assert.deepEqual(denied, {
        status: 403,
        data: { error: 'RustDesk access policy changes require an owner or admin JWT' }
      });
    }
    const systemDenied = await policyRoute(pg, 'PUT', device.id, '', validBody, {
      'x-api-key': 'rustdesk-policy-system-key',
      'x-tenant-id': tenantId,
      'x-user-id': 'impersonated-owner',
      'idempotency-key': 'policy-http-system'
    });
    assert.deepEqual(systemDenied, {
      status: 403,
      data: { error: 'RustDesk access policy changes require an owner or admin JWT' }
    });
    const legacySystemRead = await routeCollaborationApi(
      pg,
      'GET',
      `/api/ivekit/rustdesk/devices/${device.id}`,
      new URL(`http://localhost/api/ivekit/rustdesk/devices/${device.id}`),
      null,
      '',
      {
        'x-api-key': 'rustdesk-policy-system-key',
        'x-tenant-id': tenantId,
        'x-user-id': 'legacy-system-actor'
      }
    ) as { data: { id: string } };
    assert.equal(legacySystemRead.data.id, device.id);

    const adminCreated = await policyRoute(pg, 'PUT', device.id, '', validBody, {
      ...jwtHeaders(tenantId, 'admin-auth-http', 'admin'),
      'idempotency-key': 'policy-http-admin'
    }) as { status: number; data: { policy: { approved_by: string } } };
    assert.equal(adminCreated.status, 201);
    assert.equal(adminCreated.data.policy.approved_by, 'admin-auth-http');

    const ownerHeaders = jwtHeaders(tenantId, 'owner-auth-http', 'owner');
    const missingKey = await policyRoute(pg, 'PUT', device.id, '', validBody, ownerHeaders);
    assert.deepEqual(missingKey, {
      status: 400,
      data: { error: 'Idempotency-Key is required' }
    });
    const missingReason = await policyRoute(pg, 'PUT', device.id, '', {
      ...validBody,
      reason: '   '
    }, {
      ...ownerHeaders,
      'idempotency-key': 'policy-http-missing-reason'
    });
    assert.deepEqual(missingReason, {
      status: 400,
      data: { error: 'reason is required' }
    });
    await assert.rejects(
      () => policyRoute(pg, 'PUT', device.id, '', {
        ...validBody,
        reason: 'x'.repeat(1001)
      }, {
        ...ownerHeaders,
        'idempotency-key': 'policy-http-long-reason'
      }),
      /reason must be at most 1000 characters/
    );
    await assert.rejects(
      () => policyRoute(pg, 'PUT', device.id, '', validBody, {
        ...ownerHeaders,
        'idempotency-key': 'x'.repeat(201)
      }),
      /Idempotency-Key must be at most 200 characters/
    );

    for (const sensitive of [
      { unattended_password: 'do-not-store' },
      { provider_secret: 'do-not-store' },
      { launch_token: 'do-not-store' },
      { 'credential-ref': 'do-not-store' },
      { business_ref: { type: 'service_order', id: device.business_ref_id, nested_secret: 'do-not-store' } },
      { approved_by: 'spoofed-owner' },
      { actor_identity: 'spoofed-owner' }
    ]) {
      const rejected = await policyRoute(pg, 'PUT', device.id, '', {
        ...validBody,
        ...sensitive
      }, {
        ...ownerHeaders,
        'idempotency-key': `policy-http-sensitive-${Object.keys(sensitive)[0]}`
      });
      assert.equal((rejected as { status: number }).status, 400);
      assert.doesNotMatch(JSON.stringify(rejected), /do-not-store/);
    }
  } finally {
    restoreEnv('OPC_JWT_SECRET', previousSecret);
    restoreEnv('OPC_API_KEY', previousApiKey);
  }
});

test('unattended gateway launch requires matching active policy and consent while attended remains backward compatible', async () => {
  const previousSecret = process.env.OPC_JWT_SECRET;
  const previousLaunchSecret = process.env.OPC_RUSTDESK_LAUNCH_SECRET;
  const previousDisconnect = process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT;
  process.env.OPC_JWT_SECRET = 'rustdesk-policy-launch-auth-secret';
  process.env.OPC_RUSTDESK_LAUNCH_SECRET = 'rustdesk-policy-launch-url-secret';
  process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '0';
  const pg = new MemoryPg();
  const { tenantId, device } = await createDevice(pg, 'launch');
  const module = createCollaborationModule({ pg });
  const businessRef = {
    tenant_id: tenantId,
    type: device.business_ref_type,
    id: device.business_ref_id
  };
  const remote = await createRemoteWithConsent(pg, tenantId, 'launch', businessRef, [
    'view_screen',
    'control_mouse_keyboard'
  ]);
  const headers = jwtHeaders(tenantId, 'operator-launch', 'operator');
  const gatewayInput = {
    remote_session_id: remote.id,
    device_id: device.id,
    actor_identity: 'operator-launch',
    permissions: ['view_screen']
  };
  try {
    const attended = await gatewayRoute(pg, { ...gatewayInput }, headers) as {
      status: number;
      data: { metadata: Record<string, unknown> };
    };
    assert.equal(attended.status, 201, 'omitted access_mode must remain attended');
    assert.equal('access_mode' in attended.data.metadata, false);
    const invalidMode = await gatewayRoute(pg, {
      ...gatewayInput,
      access_mode: 'background'
    }, headers);
    assert.deepEqual(invalidMode, {
      status: 400,
      data: { error: 'access_mode must be attended or unattended' }
    });

    await assertPolicyDenial(() => gatewayRoute(pg, {
      ...gatewayInput,
      access_mode: 'unattended'
    }, headers));

    await module.rustdeskAccessPolicies.configurePolicy({
      tenant_id: tenantId,
      device_id: device.id,
      business_ref: businessRef,
      mode: 'unattended_allowed',
      allowed_scopes: ['view_screen', 'control_mouse_keyboard'],
      approved_by: 'owner-launch',
      reason: 'Allow unattended launch tests',
      expires_at: '2099-01-01T00:00:00.000Z',
      idempotency_key: 'policy-launch-1'
    });
    const unattended = await gatewayRoute(pg, {
      ...gatewayInput,
      access_mode: 'unattended'
    }, headers) as { status: number; data: { metadata: Record<string, unknown> } };
    assert.equal(unattended.status, 201);
    assert.equal(unattended.data.metadata.access_mode, 'unattended');

    await module.remote.revokeConsent({
      tenant_id: tenantId,
      remote_session_id: remote.id,
      actor_identity: 'customer-launch',
      scopes: ['view_screen', 'control_mouse_keyboard']
    });
    await assert.rejects(
      () => gatewayRoute(pg, {
        ...gatewayInput,
        access_mode: 'unattended'
      }, headers),
      /active consent required before starting remote tool session/
    );
    await module.remote.grantConsent({
      tenant_id: tenantId,
      remote_session_id: remote.id,
      actor_identity: 'customer-launch',
      scopes: ['view_screen'],
      expires_at: '2000-01-01T00:00:00.000Z'
    });
    await assert.rejects(
      () => gatewayRoute(pg, {
        ...gatewayInput,
        access_mode: 'unattended'
      }, headers),
      /active consent required before starting remote tool session/
    );

    await module.remote.grantConsent({
      tenant_id: tenantId,
      remote_session_id: remote.id,
      actor_identity: 'customer-launch',
      scopes: ['view_screen'],
      expires_at: '2099-01-01T00:00:00.000Z'
    });
    await assert.rejects(
      () => gatewayRoute(pg, {
        ...gatewayInput,
        access_mode: 'unattended',
        permissions: ['control_mouse_keyboard']
      }, headers),
      /active consent does not cover requested remote permissions/
    );

    await module.rustdeskAccessPolicies.configurePolicy({
      tenant_id: tenantId,
      device_id: device.id,
      business_ref: businessRef,
      mode: 'unattended_allowed',
      allowed_scopes: ['view_screen'],
      approved_by: 'owner-launch',
      reason: 'Narrow unattended launch permissions',
      expires_at: '2099-01-01T00:00:00.000Z',
      idempotency_key: 'policy-launch-2'
    });
    await assert.rejects(
      () => gatewayRoute(pg, {
        ...gatewayInput,
        access_mode: 'unattended',
        permissions: ['control_mouse_keyboard']
      }, headers),
      /access policy does not cover requested remote permissions/
    );

    await module.rustdeskAccessPolicies.revokePolicy({
      tenant_id: tenantId,
      device_id: device.id,
      approved_by: 'owner-launch',
      reason: 'Revoke unattended launch permission',
      idempotency_key: 'policy-launch-3'
    });
    await assertPolicyDenial(() => gatewayRoute(pg, {
      ...gatewayInput,
      access_mode: 'unattended'
    }, headers));
    const attendedAfterRevoke = await gatewayRoute(pg, {
      ...gatewayInput,
      access_mode: 'attended'
    }, headers) as { status: number };
    assert.equal(attendedAfterRevoke.status, 201);

    await module.rustdeskAccessPolicies.configurePolicy({
      tenant_id: tenantId,
      device_id: device.id,
      business_ref: businessRef,
      mode: 'attended_only',
      allowed_scopes: [],
      approved_by: 'owner-launch',
      reason: 'Supersede with attended-only policy',
      expires_at: null,
      idempotency_key: 'policy-launch-4'
    });
    await assertPolicyDenial(() => gatewayRoute(pg, {
      ...gatewayInput,
      access_mode: 'unattended'
    }, headers));

    await module.rustdeskAccessPolicies.configurePolicy({
      tenant_id: tenantId,
      device_id: device.id,
      business_ref: businessRef,
      mode: 'unattended_allowed',
      allowed_scopes: ['view_screen'],
      approved_by: 'owner-launch',
      reason: 'Expired unattended policy',
      expires_at: '2000-01-01T00:00:00.000Z',
      idempotency_key: 'policy-launch-5'
    });
    await assertPolicyDenial(() => gatewayRoute(pg, {
      ...gatewayInput,
      access_mode: 'unattended'
    }, headers));

    await module.rustdeskAccessPolicies.configurePolicy({
      tenant_id: tenantId,
      device_id: device.id,
      business_ref: businessRef,
      mode: 'unattended_allowed',
      allowed_scopes: ['view_screen'],
      approved_by: 'owner-launch',
      reason: 'Restore policy for binding checks',
      expires_at: '2099-01-01T00:00:00.000Z',
      idempotency_key: 'policy-launch-6'
    });
    const wrongBusinessRemote = await createRemoteWithConsent(pg, tenantId, 'wrong-business', {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order-policy-wrong-business'
    }, ['view_screen']);
    await assertPolicyDenial(() => gatewayRoute(pg, {
      ...gatewayInput,
      remote_session_id: wrongBusinessRemote.id,
      access_mode: 'unattended'
    }, headers));

    const secondDevice = await new RustDeskDeviceStore(pg).registerDevice({
      tenant_id: tenantId,
      business_ref: businessRef,
      rustdesk_id: 'rustdesk-policy-launch-second',
      display_name: 'Second policy launch device'
    });
    await assertPolicyDenial(() => gatewayRoute(pg, {
      ...gatewayInput,
      device_id: secondDevice.id,
      access_mode: 'unattended'
    }, headers));

    const crossTenant = await gatewayRoute(pg, {
      ...gatewayInput,
      access_mode: 'unattended'
    }, jwtHeaders('tenant-policy-launch-other', 'operator-other', 'operator'));
    assert.deepEqual(crossTenant, { status: 404, data: { error: 'remote session not found' } });
  } finally {
    restoreEnv('OPC_JWT_SECRET', previousSecret);
    restoreEnv('OPC_RUSTDESK_LAUNCH_SECRET', previousLaunchSecret);
    restoreEnv('OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT', previousDisconnect);
  }
});

test('in-process iveKit facade applies the same unattended policy gate', async () => {
  const pg = new MemoryPg();
  const { tenantId, device } = await createDevice(pg, 'module-launch');
  const businessRef = {
    tenant_id: tenantId,
    type: device.business_ref_type,
    id: device.business_ref_id
  };
  const remote = await createRemoteWithConsent(pg, tenantId, 'module-launch', businessRef, ['view_screen']);
  const createCalls: Array<Parameters<RemoteGatewayClient['createSession']>[0]> = [];
  const gateway: RemoteGatewayClient = {
    provider: 'rustdesk',
    async createSession(input) {
      createCalls.push(input);
      return {
        provider: 'rustdesk',
        external_id: `rdgw-policy-module-${createCalls.length}`,
        launch_url: `https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-policy-module-${createCalls.length}`,
        target: input.target,
        permissions: [...input.permissions],
        metadata: input.metadata || {}
      };
    },
    async endSession() {},
    async listAuditEvents() { return []; }
  };
  const iveKit = createIveKitModule({ db: {}, pg, remoteGateway: gateway });
  const launch = {
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'operator-module-launch',
    device_id: device.id,
    permissions: ['view_screen'] as const,
    access_mode: 'unattended' as const
  };

  await assertPolicyDenial(() => iveKit.rustdesk.startGatewaySession(launch));
  assert.equal(createCalls.length, 0);
  await createCollaborationModule({ pg }).rustdeskAccessPolicies.configurePolicy({
    tenant_id: tenantId,
    device_id: device.id,
    business_ref: businessRef,
    mode: 'unattended_allowed',
    allowed_scopes: ['view_screen'],
    approved_by: 'owner-module-launch',
    reason: 'Allow the in-process facade launch',
    expires_at: '2099-01-01T00:00:00.000Z',
    idempotency_key: 'policy-module-launch-1'
  });
  const tool = await iveKit.rustdesk.startGatewaySession(launch);
  assert.equal(tool.provider, 'rustdesk');
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0]?.metadata?.access_mode, 'unattended');
});

test('iveKit RustDesk SDK maps policy routes, idempotency, access mode, and allowlisted DTOs', async () => {
  const calls: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const activeEvent = unsafePolicyEvent({ state: 'active', version: 1 });
  const revokedEvent = unsafePolicyEvent({ event_type: 'revoked', state: 'revoked', version: 2 });
  const responses: unknown[] = [
    { device_id: 'rdesk-sdk-policy', state: 'active', policy: activeEvent, internal_column: 'drop-me' },
    { device_id: 'rdesk-sdk-policy', events: [activeEvent], internal_column: 'drop-me' },
    { policy: activeEvent, replayed: false, internal_column: 'drop-me' },
    { policy: revokedEvent, replayed: false, internal_column: 'drop-me' },
    {
      id: 'tool-sdk-policy',
      tenant_id: 'tenant-sdk-policy',
      remote_session_id: 'remote-sdk-policy',
      provider: 'rustdesk',
      external_id: 'rdgw-sdk-policy',
      launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-sdk-policy',
      status: 'active',
      started_by: 'operator-sdk-policy',
      started_at: '2026-07-12T00:00:00.000Z',
      ended_at: null,
      metadata: { access_mode: 'unattended' }
    }
  ];
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'owner-sdk-token',
    tenantId: 'tenant-sdk-policy',
    fetch: async (input, init = {}) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      calls.push({
        method: init.method || 'GET',
        path: `${new URL(String(input)).pathname}${new URL(String(input)).search}`,
        headers,
        body: init.body ? JSON.parse(String(init.body)) : null
      });
      return Response.json(responses.shift());
    }
  });

  const current = await client.getAccessPolicy('rdesk-sdk-policy');
  const history = await client.listAccessPolicyHistory('rdesk-sdk-policy');
  const configured = await client.configureAccessPolicy('rdesk-sdk-policy', {
    mode: 'unattended_allowed',
    allowed_scopes: ['view_screen'],
    business_ref: { type: 'service_order', id: 'order-sdk-policy' },
    expires_at: '2026-07-20T00:00:00.000Z',
    reason: 'Allow SDK unattended support'
  }, { idempotencyKey: 'policy-sdk-1' });
  const revoked = await client.revokeAccessPolicy('rdesk-sdk-policy', {
    reason: 'Revoke SDK unattended support'
  }, { idempotencyKey: 'policy-sdk-2' });
  await client.startGatewaySession({
    remote_session_id: 'remote-sdk-policy',
    device_id: 'rdesk-sdk-policy',
    actor_identity: 'operator-sdk-policy',
    permissions: ['view_screen'],
    access_mode: 'unattended'
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'GET /api/ivekit/rustdesk/devices/rdesk-sdk-policy/access-policy',
    'GET /api/ivekit/rustdesk/devices/rdesk-sdk-policy/access-policy/history',
    'PUT /api/ivekit/rustdesk/devices/rdesk-sdk-policy/access-policy',
    'POST /api/ivekit/rustdesk/devices/rdesk-sdk-policy/access-policy/revoke',
    'POST /api/ivekit/rustdesk/gateway-sessions'
  ]);
  assert.equal(calls[2]?.headers['idempotency-key'], 'policy-sdk-1');
  assert.equal(calls[3]?.headers['idempotency-key'], 'policy-sdk-2');
  assert.equal((calls[4]?.body as { access_mode?: string }).access_mode, 'unattended');
  assert.equal(current.policy?.approved_by, 'owner-sdk-policy');
  assert.equal(history.events[0]?.version, 1);
  assert.equal(configured.policy.state, 'active');
  assert.equal(revoked.policy.state, 'revoked');
  assert.doesNotMatch(
    JSON.stringify({ current, history, configured, revoked }),
    /request_hash|idempotency_key|supersedes_id|internal_column|drop-me|password|secret|token|credential/i
  );
});

test('iveKit RustDesk SDK rejects unsafe policy mutation fields before fetch', async () => {
  let fetchCalls = 0;
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://opc.example.com',
    accessToken: 'owner-sdk-token',
    tenantId: 'tenant-sdk-policy',
    fetch: async () => {
      fetchCalls += 1;
      return Response.json({});
    }
  });
  const base = {
    mode: 'unattended_allowed' as const,
    allowed_scopes: ['view_screen'] as const,
    business_ref: { type: 'service_order', id: 'order-sdk-policy' },
    reason: 'Allow SDK unattended support'
  };
  for (const unsafe of [
    { unattended_password: 'do-not-send' },
    { provider_secret: 'do-not-send' },
    { launch_token: 'do-not-send' },
    { credential_ref: 'do-not-send' },
    { approved_by: 'spoofed-owner' },
    { actor_identity: 'spoofed-owner' }
  ]) {
    await assert.rejects(
      () => client.configureAccessPolicy('rdesk-sdk-policy', {
        ...base,
        ...unsafe
      } as typeof base, { idempotencyKey: `unsafe-${Object.keys(unsafe)[0]}` }),
      /unsupported or sensitive RustDesk access policy field/
    );
  }
  await assert.rejects(
    () => client.configureAccessPolicy('rdesk-sdk-policy', base, { idempotencyKey: '' }),
    /idempotencyKey is required/
  );
  assert.equal(fetchCalls, 0);
});

async function createDevice(pg: MemoryPg, suffix: string) {
  const tenantId = `tenant_policy_${suffix}`;
  const device = await new RustDeskDeviceStore(pg).registerDevice({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: `order-policy-${suffix}`
    },
    rustdesk_id: `rustdesk-policy-${suffix}`,
    display_name: `Policy device ${suffix}`
  });
  return { tenantId, device };
}

function jwtHeaders(tenantId: string, userId: string, role: AuthRole) {
  return { authorization: `Bearer ${signAccessToken({ sub: userId, tid: tenantId, role })}` };
}

function policyRoute(
  pg: MemoryPg,
  method: string,
  deviceId: string,
  action: '' | 'history' | 'revoke',
  body: unknown,
  headers: Record<string, string>
) {
  const suffix = action ? `/${action}` : '';
  const path = `/api/ivekit/rustdesk/devices/${encodeURIComponent(deviceId)}/access-policy${suffix}`;
  return routeCollaborationApi(pg, method, path, new URL(`http://localhost${path}`), body, '', headers);
}

function gatewayRoute(
  pg: MemoryPg,
  body: unknown,
  headers: Record<string, string>
) {
  const path = '/api/ivekit/rustdesk/gateway-sessions';
  return routeCollaborationApi(pg, 'POST', path, new URL(`http://localhost${path}`), body, '', headers);
}

async function createRemoteWithConsent(
  pg: MemoryPg,
  tenantId: string,
  suffix: string,
  businessRef: { tenant_id: string; type: string; id: string },
  scopes: Array<'view_screen' | 'control_mouse_keyboard' | 'record_screen' | 'transfer_file' | 'clipboard'>
) {
  const module = createCollaborationModule({ pg });
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: `Policy launch ${suffix}`
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'rustdesk',
    started_by: `operator-${suffix}`
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: `customer-${suffix}`,
    scopes,
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  return remote;
}

async function assertPolicyDenial(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (error) => {
    assert.equal((error as { status?: number }).status, 403);
    assert.match(String(error), /active unattended access policy required/);
    return true;
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function unsafePolicyEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rdpol-sdk-policy',
    tenant_id: 'tenant-sdk-policy',
    device_id: 'rdesk-sdk-policy',
    event_type: 'configured',
    mode: 'unattended_allowed',
    allowed_scopes: ['view_screen'],
    business_ref: { type: 'service_order', id: 'order-sdk-policy', metadata: 'drop-me' },
    approved_by: 'owner-sdk-policy',
    reason: 'Allow SDK unattended support',
    expires_at: '2026-07-20T00:00:00.000Z',
    version: 1,
    state: 'active',
    created_at: '2026-07-12T00:00:00.000Z',
    request_hash: 'drop-me',
    idempotency_key: 'drop-me',
    supersedes_id: 'drop-me',
    unattended_password: 'drop-me',
    credential_ref: 'drop-me',
    ...overrides
  };
}

function accessPolicyRlsBlock(sql: string): string {
  return sql.match(
    /ALTER TABLE rustdesk_access_policy_events ENABLE ROW LEVEL SECURITY;[\s\S]*?WITH CHECK \(opc_rls_bypass\(\) OR tenant_id = opc_current_tenant\(\)\);/
  )?.[0] || '';
}
