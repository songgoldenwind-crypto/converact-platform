import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { RustDeskControlLockStore } from '../src/agent-runtime/collaboration/rustdesk-control-lock-store.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { createIveKitRustDeskHttpClient } from '../sdk/ivekit/src/rustdesk-http-client.js';

test('RustDesk control ownership migration defines leases confirmations and immutable events', () => {
  const migrationUrl = new URL('../src/migrations/040_rustdesk_control_ownership.sql', import.meta.url);
  assert.equal(existsSync(migrationUrl), true, 'RustDesk control ownership migration must exist');

  const migration = readFileSync(migrationUrl, 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rustdesk_control_locks \(/);
  assert.match(migration, /PRIMARY KEY \(tenant_id, external_id\)/);
  assert.match(migration, /owner_identity TEXT NOT NULL/);
  assert.match(migration, /lease_expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(migration, /version INTEGER NOT NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rustdesk_secondary_confirmations \(/);
  assert.match(migration, /operation TEXT NOT NULL/);
  assert.match(migration, /consumed_at TIMESTAMPTZ/);
  assert.match(migration, /audit_linked_at TIMESTAMPTZ/);
  assert.match(migration, /audit_event_id TEXT/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rustdesk_control_events \(/);
  assert.match(migration, /event_type TEXT NOT NULL/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /opc_rls_bypass\(\) OR tenant_id = opc_current_tenant\(\)/g);
  assert.doesNotMatch(migration, /password|credential_ref|credential-ref/i);
});

test('full schema includes RustDesk control ownership tables without early RLS helpers', () => {
  const schema = readFileSync(new URL('../src/migrations/005_full_schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rustdesk_control_locks \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rustdesk_secondary_confirmations \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rustdesk_control_events \(/);
  assert.doesNotMatch(
    schema,
    /ALTER TABLE rustdesk_control_locks ENABLE ROW LEVEL SECURITY;[\s\S]*opc_current_tenant\(\)/
  );
});

async function fixture(name: string, metadata: Record<string, unknown> = {}) {
  const pg = new MemoryPg();
  const tenantId = `tenant_control_${name}`;
  const sessions = new RustDeskGatewaySessionStore(pg);
  const session = await sessions.createSession({
    tenant_id: tenantId,
    target: { type: 'device', id: `device-${name}` },
    permissions: ['view_screen', 'control_mouse_keyboard', 'transfer_file', 'clipboard'],
    actor_identity: 'agent-a',
    launch_url: `https://opc.example.test/rustdesk/${name}`,
    metadata
  });
  return { pg, sessions, session, tenantId, locks: new RustDeskControlLockStore(pg) };
}

test('RustDesk control lock allows one owner and rejects stale heartbeat or challenge replay', async () => {
  const { locks, session, tenantId } = await fixture('exclusive');
  const now = '2026-07-12T03:00:00.000Z';
  const firstConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'control_mouse_keyboard', now
  });
  const acquired = await locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    confirmation_id: firstConfirmation.id, lease_ms: 30_000, now
  });
  assert.equal(acquired.status, 'owned');
  assert.equal(acquired.owner_identity, 'agent-a');

  await assert.rejects(() => locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    confirmation_id: firstConfirmation.id, now
  }), /fresh secondary confirmation required/);
  await assert.rejects(() => locks.heartbeat({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    version: acquired.version - 1, now: '2026-07-12T03:00:01.000Z'
  }), /stale control ownership version/);

  const clipboardConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'clipboard', now
  });
  await locks.confirmOperation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'clipboard', confirmation_id: clipboardConfirmation.id, version: acquired.version, now
  });
  await assert.rejects(() => locks.confirmOperation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'clipboard', confirmation_id: clipboardConfirmation.id, version: acquired.version, now
  }), /fresh secondary confirmation required/);

  const otherConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-b',
    operation: 'control_mouse_keyboard', now
  });
  await assert.rejects(() => locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-b',
    confirmation_id: otherConfirmation.id, now
  }), /already owned/);
});

test('RustDesk control lock expires and transfers atomically with fresh confirmation', async () => {
  const { locks, session, tenantId } = await fixture('transfer');
  const now = '2026-07-12T04:00:00.000Z';
  const acquireConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'control_mouse_keyboard', now
  });
  const acquired = await locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    confirmation_id: acquireConfirmation.id, lease_ms: 5_000, now
  });
  const transferConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'control_transfer', now
  });
  const transferred = await locks.transfer({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    to_identity: 'agent-b', confirmation_id: transferConfirmation.id, version: acquired.version,
    lease_ms: 5_000, now: '2026-07-12T04:00:01.000Z'
  });
  assert.equal(transferred.owner_identity, 'agent-b');
  assert.equal(transferred.version, acquired.version + 1);

  const expired = await locks.getOwnership({
    tenant_id: tenantId, external_id: session.external_id, now: '2026-07-12T04:00:07.000Z'
  });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.owner_identity, null);
  assert.equal(expired.version, transferred.version + 1);
  const reacquireConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-c',
    operation: 'control_mouse_keyboard', now: '2026-07-12T04:00:07.000Z'
  });
  const reacquired = await locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-c',
    confirmation_id: reacquireConfirmation.id, now: '2026-07-12T04:00:07.000Z'
  });
  assert.equal(reacquired.owner_identity, 'agent-c');
  assert.equal(reacquired.version, expired.version + 1);
});

test('RustDesk terminal gateway session rejects confirmations and lock changes', async () => {
  const { locks, sessions, session, tenantId } = await fixture('terminal');
  await sessions.endSession({ external_id: session.external_id, actor_identity: 'agent-a' });
  await assert.rejects(() => locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'control_mouse_keyboard'
  }), /gateway session is terminal/);
});

test('control-enforced gateway events atomically consume the matching secondary confirmation', async () => {
  const { locks, sessions, session, tenantId } = await fixture('event-confirmation', {
    control_enforcement_version: 1
  });
  const now = new Date().toISOString();
  const acquireConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'control_mouse_keyboard', now
  });
  const ownership = await locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    confirmation_id: acquireConfirmation.id, now
  });
  await assert.rejects(() => sessions.appendAuditEvent({
    external_id: session.external_id,
    event_type: 'remote.rustdesk.file_transfer.started',
    actor_identity: 'agent-a',
    metadata: { transfer_id: 'transfer-1', direction: 'upload' },
    occurred_at: now
  }), /operation_grant_id/);

  const backdated = new Date(Date.now() - 10 * 60_000).toISOString();
  const expiredConfirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'transfer_file', now: backdated
  });
  const expiredAuthorization = await locks.confirmOperation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'transfer_file', confirmation_id: expiredConfirmation.id,
    version: ownership.version, now: backdated
  });
  await assert.rejects(() => sessions.appendAuditEvent({
    external_id: session.external_id,
    event_type: 'remote.rustdesk.file_transfer.started',
    actor_identity: 'agent-a',
    metadata: {
      transfer_id: 'transfer-expired', direction: 'upload',
      operation_grant_id: expiredAuthorization.id, control_version: ownership.version
    },
    occurred_at: backdated
  }), /fresh operation authorization required/);

  const confirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'transfer_file', now
  });
  const authorization = await locks.confirmOperation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'transfer_file', confirmation_id: confirmation.id, version: ownership.version, now
  });
  const event = await sessions.appendAuditEvent({
    external_id: session.external_id,
    event_type: 'remote.rustdesk.file_transfer.started',
    actor_identity: 'agent-a',
    metadata: {
      transfer_id: 'transfer-1', direction: 'upload',
      operation_grant_id: authorization.id, control_version: ownership.version
    },
    occurred_at: now
  });
  assert.equal(event?.event_type, 'remote.rustdesk.file_transfer.started');
  await assert.rejects(() => sessions.appendAuditEvent({
    external_id: session.external_id,
    event_type: 'remote.rustdesk.file_transfer.started',
    actor_identity: 'agent-a',
    metadata: {
      transfer_id: 'transfer-2', direction: 'upload',
      operation_grant_id: authorization.id, control_version: ownership.version
    },
    occurred_at: now
  }), /fresh operation authorization required/);
});

test('sensitive native observations require the current control owner and version', async () => {
  const { locks, sessions, session, tenantId } = await fixture('observed-owner', {
    control_enforcement_version: 1
  });
  const now = new Date().toISOString();
  const confirmation = await locks.issueConfirmation({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    operation: 'control_mouse_keyboard', now
  });
  const ownership = await locks.acquire({
    tenant_id: tenantId, external_id: session.external_id, actor_identity: 'agent-a',
    confirmation_id: confirmation.id, now
  });
  const metadata = {
    operation_id: 'control-observed-1', operation: 'control_mouse_keyboard',
    status: 'observed_succeeded', observer: 'native_client', observed_at: now,
    evidence_refs: [{ type: 'audit', ref: 'evidence:control-1', sha256: `sha256:${'a'.repeat(64)}` }],
    control_version: ownership.version
  };
  await assert.rejects(() => sessions.appendAuditEvent({
    external_id: session.external_id, event_type: 'remote.rustdesk.operation.observed',
    actor_identity: 'agent-b', metadata
  }), /active control owner required/);
  await assert.rejects(() => sessions.appendAuditEvent({
    external_id: session.external_id, event_type: 'remote.rustdesk.operation.observed',
    actor_identity: 'agent-a', metadata: { ...metadata, control_version: ownership.version + 1 }
  }), /stale control ownership version/);
  const event = await sessions.appendAuditEvent({
    external_id: session.external_id, event_type: 'remote.rustdesk.operation.observed',
    actor_identity: 'agent-a', metadata
  });
  assert.equal(event?.metadata.operation_id, 'control-observed-1');
});

test('RustDesk control HTTP requires active participants and binds actor to JWT identity', async () => {
  const previousSecret = process.env.OPC_JWT_SECRET;
  process.env.OPC_JWT_SECRET = 'rustdesk-control-http-test-secret-32-bytes';
  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant_control_http';
    const module = createCollaborationModule({ pg });
    const collaboration = await module.sessions.openSession({
      tenant_id: tenantId,
      business_ref: { tenant_id: tenantId, type: 'service_order', id: 'control-http' }
    });
    await module.sessions.addParticipant({ tenant_id: tenantId, session_id: collaboration.id, identity: 'agent-a', role: 'agent' });
    await module.sessions.addParticipant({ tenant_id: tenantId, session_id: collaboration.id, identity: 'agent-b', role: 'supervisor' });
    await module.sessions.addParticipant({ tenant_id: tenantId, session_id: collaboration.id, identity: 'observer', role: 'customer' });
    const remote = await module.remote.createSession({
      tenant_id: tenantId, collaboration_session_id: collaboration.id,
      business_ref: collaboration.business_ref, mode: 'remote_desktop_gateway',
      adapter_provider: 'rustdesk', started_by: 'agent-a'
    });
    await module.remote.grantConsent({
      tenant_id: tenantId, remote_session_id: remote.id, actor_identity: 'customer',
      scopes: ['view_screen', 'control_mouse_keyboard']
    });
    const gateway = await new RustDeskGatewaySessionStore(pg).createSession({
      tenant_id: tenantId, target: { type: 'device', id: 'http-device' },
      permissions: ['view_screen', 'control_mouse_keyboard'], actor_identity: 'agent-a',
      launch_url: 'https://opc.example.test/rustdesk/control-http'
    });
    await module.remote.startGatewayToolSession({
      tenant_id: tenantId, remote_session_id: remote.id, actor_identity: 'agent-a', gateway: {
        provider: 'rustdesk', external_id: gateway.external_id, launch_url: gateway.launch_url,
        target: gateway.target, permissions: gateway.permissions, metadata: gateway.metadata
      }
    });
    const headers = { authorization: `Bearer ${signAccessToken({ sub: 'agent-a', tid: tenantId, role: 'operator' })}` };
    const base = `/api/ivekit/rustdesk/gateway-sessions/${gateway.external_id}/control`;
    const confirmationResponse = await routeCollaborationApi(
      pg, 'POST', `${base}/confirmations`, new URL(`http://localhost${base}/confirmations`),
      { operation: 'control_mouse_keyboard', actor_identity: 'spoofed' }, '', headers
    );
    const confirmationHttp = confirmationResponse as { status?: number; data: unknown };
    assert.equal(confirmationHttp.status, 201);
    const confirmation = confirmationHttp.data as { id: string; actor_identity: string };
    assert.equal(confirmation.actor_identity, 'agent-a');
    const acquireResponse = await routeCollaborationApi(
      pg, 'POST', `${base}/acquire`, new URL(`http://localhost${base}/acquire`),
      { confirmation_id: confirmation.id }, '', headers
    );
    assert.equal(((acquireResponse as { data: unknown }).data as { owner_identity: string }).owner_identity, 'agent-a');

    const unattendedGateway = await new RustDeskGatewaySessionStore(pg).createSession({
      tenant_id: tenantId, target: { type: 'device', id: 'unattended-device' },
      permissions: ['view_screen'], actor_identity: 'agent-a',
      launch_url: 'https://opc.example.test/rustdesk/unattended', metadata: { access_mode: 'unattended' }
    });
    await pg.query(
      `INSERT INTO remote_tool_sessions
        (id, tenant_id, remote_session_id, provider, external_id, launch_url, started_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['tool-unattended', tenantId, remote.id, 'rustdesk', unattendedGateway.external_id,
        unattendedGateway.launch_url, 'agent-a', '{}']
    );
    const launchPath = `/api/ivekit/rustdesk/gateway-sessions/${unattendedGateway.external_id}/launch`;
    const launchDenied = await routeCollaborationApi(
      pg, 'GET', launchPath, new URL(`http://localhost${launchPath}`), undefined, '', headers
    );
    assert.equal((launchDenied as { status?: number }).status, 403);
    const observerHeaders = {
      authorization: `Bearer ${signAccessToken({ sub: 'observer', tid: tenantId, role: 'viewer' })}`
    };
    const observerRead = await routeCollaborationApi(
      pg, 'GET', base, new URL(`http://localhost${base}`), undefined, '', observerHeaders
    );
    assert.equal((observerRead as { status?: number }).status, undefined);
    const observerControl = await routeCollaborationApi(
      pg, 'POST', `${base}/confirmations`, new URL(`http://localhost${base}/confirmations`),
      { operation: 'control_mouse_keyboard' }, '', observerHeaders
    );
    assert.equal((observerControl as { status?: number }).status, 403);
    await module.sessions.leaveParticipant({ tenant_id: tenantId, session_id: collaboration.id, identity: 'agent-a' });
    const denied = await routeCollaborationApi(
      pg, 'GET', base, new URL(`http://localhost${base}`), undefined, '', headers
    );
    assert.equal((denied as { status?: number }).status, 403);
  } finally {
    if (previousSecret === undefined) delete process.env.OPC_JWT_SECRET;
    else process.env.OPC_JWT_SECRET = previousSecret;
  }
});

test('iveKit RustDesk SDK maps the complete control ownership lifecycle', async () => {
  const calls: string[] = [];
  const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' }
  });
  const ownership = {
    status: 'owned', owner_identity: 'agent-a', lease_expires_at: '2026-07-12T05:01:00.000Z',
    version: 1, updated_at: '2026-07-12T05:00:00.000Z'
  };
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://ivekit.example.test', tenantId: 'tenant-sdk-control', apiKey: 'sdk-key',
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${init?.method} ${path}`);
      if (path.endsWith('/confirmations')) return response({
        id: 'confirm-1', external_id: 'gateway-1', actor_identity: 'agent-a',
        operation: 'control_mouse_keyboard', expires_at: '2026-07-12T05:02:00.000Z',
        consumed_at: null, created_at: '2026-07-12T05:00:00.000Z'
      }, 201);
      if (path.endsWith('/operations')) return response({
        id: 'authorization-1', external_id: 'gateway-1', actor_identity: 'agent-a',
        operation: 'clipboard', control_version: 3,
        expires_at: '2026-07-12T05:02:00.000Z', authorized_at: '2026-07-12T05:00:00.000Z'
      }, 201);
      return response(ownership);
    }
  });
  const confirmation = await client.issueControlConfirmation('gateway-1', { operation: 'control_mouse_keyboard' });
  await client.getControlOwnership('gateway-1');
  await client.acquireControl('gateway-1', { confirmation_id: confirmation.id });
  await client.heartbeatControl('gateway-1', { version: 1 });
  await client.releaseControl('gateway-1', { version: 2 });
  await client.transferControl('gateway-1', { version: 2, to_identity: 'agent-b', confirmation_id: 'confirm-2' });
  const authorization = await client.confirmOperation(
    'gateway-1', { operation: 'clipboard', confirmation_id: 'confirm-3', version: 3 }
  );
  assert.equal(authorization.id, 'authorization-1');
  assert.deepEqual(calls, [
    'POST /api/ivekit/rustdesk/gateway-sessions/gateway-1/control/confirmations',
    'GET /api/ivekit/rustdesk/gateway-sessions/gateway-1/control',
    'POST /api/ivekit/rustdesk/gateway-sessions/gateway-1/control/acquire',
    'POST /api/ivekit/rustdesk/gateway-sessions/gateway-1/control/heartbeat',
    'POST /api/ivekit/rustdesk/gateway-sessions/gateway-1/control/release',
    'POST /api/ivekit/rustdesk/gateway-sessions/gateway-1/control/transfer',
    'POST /api/ivekit/rustdesk/gateway-sessions/gateway-1/control/operations'
  ]);
});
