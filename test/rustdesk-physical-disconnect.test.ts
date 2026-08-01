import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertRustDeskPhysicalDisconnectCapableIfRequired } from '../src/agent-runtime/collaboration/rustdesk-device-online.js';
import { RustDeskDeviceStore } from '../src/agent-runtime/collaboration/rustdesk-device-store.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { RustDeskPhysicalDisconnectService } from '../src/agent-runtime/collaboration/rustdesk-physical-disconnect.js';
import { createRustDeskGatewayClient } from '../src/agent-runtime/collaboration/remote-gateway-client.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';

async function physicalDisconnectFixture(tenantId = 'tenant_rustdesk_physical_disconnect') {
  const pg = new MemoryPg();
  const devices = new RustDeskDeviceStore(pg);
  const sessions = new RustDeskGatewaySessionStore(pg);
  const service = new RustDeskPhysicalDisconnectService(pg);
  const device = await devices.registerDevice({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'SO-RUSTDESK-PHYSICAL-1'
    },
    rustdesk_id: '556677889',
    display_name: 'LED physical disconnect target'
  });
  const session = await sessions.createSession({
    tenant_id: tenantId,
    target: {
      type: 'device',
      id: device.rustdesk_id,
      display_name: device.display_name
    },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    actor_identity: 'agent-physical-disconnect',
    launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=physical-disconnect',
    metadata: {
      rustdesk_target_mode: 'registered_device',
      rustdesk_device_id: device.id,
      rustdesk_id: device.rustdesk_id
    }
  });
  return { pg, devices, sessions, service, device, session, tenantId };
}

test('RustDeskPhysicalDisconnectService ends once and reuses one disconnect command', async () => {
  const fixture = await physicalDisconnectFixture();
  const first = await fixture.service.endGatewaySession({
    tenant_id: fixture.tenantId,
    external_id: fixture.session.external_id,
    actor_identity: 'customer-physical-disconnect',
    requested_reason: 'consent_revoked'
  });
  const repeated = await fixture.service.endGatewaySession({
    tenant_id: fixture.tenantId,
    external_id: fixture.session.external_id,
    actor_identity: 'agent-retry',
    requested_reason: 'gateway_ended'
  });

  assert.equal(first.session.status, 'ended');
  assert.equal(first.session.ended_by, 'customer-physical-disconnect');
  assert.equal(first.command?.status, 'pending');
  assert.deepEqual(first.physical_disconnect, {
    required: true,
    command_id: first.command?.id,
    status: 'pending'
  });
  assert.equal(repeated.command?.id, first.command?.id);
  assert.equal(repeated.command?.requested_by, 'customer-physical-disconnect');
  assert.equal(repeated.command?.requested_reason, 'consent_revoked');
  assert.equal(repeated.session.ended_by, 'customer-physical-disconnect');

  const events = await fixture.sessions.listAuditEvents({ external_id: fixture.session.external_id });
  assert.equal(
    events?.filter((event) => event.event_type === 'remote.rustdesk.disconnect.requested').length,
    1
  );
});

test('RustDeskPhysicalDisconnectService records unavailable for raw-id sessions', async () => {
  const pg = new MemoryPg();
  const sessions = new RustDeskGatewaySessionStore(pg);
  const service = new RustDeskPhysicalDisconnectService(pg);
  const session = await sessions.createSession({
    tenant_id: 'tenant_rustdesk_physical_raw',
    target: { type: 'device', id: '998877665' },
    permissions: ['view_screen'],
    actor_identity: 'agent-physical-raw',
    launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=physical-raw',
    metadata: {
      rustdesk_target_mode: 'raw_id',
      rustdesk_id: '998877665'
    }
  });

  const result = await service.endGatewaySession({
    tenant_id: session.tenant_id,
    external_id: session.external_id,
    actor_identity: 'customer-physical-raw',
    requested_reason: 'gateway_ended'
  });
  const repeated = await service.endGatewaySession({
    tenant_id: session.tenant_id,
    external_id: session.external_id,
    actor_identity: 'customer-physical-raw',
    requested_reason: 'gateway_ended'
  });
  const events = await sessions.listAuditEvents({ external_id: session.external_id });

  assert.equal(result.session.status, 'ended');
  assert.equal(result.command, null);
  assert.deepEqual(result.physical_disconnect, { required: true, status: 'unavailable' });
  assert.deepEqual(repeated.physical_disconnect, { required: true, status: 'unavailable' });
  assert.equal(
    events?.filter((event) => event.event_type === 'remote.rustdesk.disconnect.unavailable').length,
    1
  );
});

test('RustDeskPhysicalDisconnectService keeps authorization ended when enqueue fails', async () => {
  const fixture = await physicalDisconnectFixture('tenant_rustdesk_physical_enqueue_failure');
  const failingPg: PgQueryable = {
    query(text, params) {
      if (text.replace(/\s+/g, ' ').trim().startsWith('INSERT INTO rustdesk_device_commands')) {
        throw new Error('simulated command queue outage');
      }
      return fixture.pg.query(text, params);
    }
  };
  const service = new RustDeskPhysicalDisconnectService(failingPg);

  await assert.rejects(
    () => service.endGatewaySession({
      tenant_id: fixture.tenantId,
      external_id: fixture.session.external_id,
      actor_identity: 'customer-enqueue-failure',
      requested_reason: 'consent_revoked'
    }),
    /simulated command queue outage/
  );

  const ended = await fixture.sessions.getSession(fixture.session.external_id);
  assert.equal(ended?.status, 'ended');
  assert.equal(ended?.ended_by, 'customer-enqueue-failure');
});

test('RustDeskPhysicalDisconnectService hides cross-tenant gateway sessions', async () => {
  const fixture = await physicalDisconnectFixture('tenant_rustdesk_physical_scope');

  await assert.rejects(
    () => fixture.service.endGatewaySession({
      tenant_id: 'tenant_rustdesk_physical_scope_other',
      external_id: fixture.session.external_id,
      actor_identity: 'other-tenant-agent',
      requested_reason: 'gateway_ended'
    }),
    /rustdesk gateway session not found/
  );
  assert.equal((await fixture.sessions.getSession(fixture.session.external_id))?.status, 'active');
});

test('strict RustDesk physical disconnect requires a fresh capability heartbeat', async () => {
  const fixture = await physicalDisconnectFixture('tenant_rustdesk_physical_capability');
  const strictEnv = {
    CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT: '1',
    CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS: '300000'
  };

  assert.doesNotThrow(() => assertRustDeskPhysicalDisconnectCapableIfRequired(
    fixture.device,
    { CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT: '0' },
    Date.parse('2026-07-10T14:00:00.000Z')
  ));
  assert.throws(
    () => assertRustDeskPhysicalDisconnectCapableIfRequired(
      fixture.device,
      strictEnv,
      Date.parse('2026-07-10T14:00:00.000Z')
    ),
    /rustdesk device is not online/
  );

  const heartbeatWithoutCapability = (await fixture.devices.heartbeatDevice({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    actor_identity: 'edge-capability-test',
    runtime_status: 'online',
    seen_at: '2026-07-10T14:00:00.000Z',
    metadata: { disconnect_command_capable: false }
  }))!;
  assert.throws(
    () => assertRustDeskPhysicalDisconnectCapableIfRequired(
      heartbeatWithoutCapability,
      strictEnv,
      Date.parse('2026-07-10T14:01:00.000Z')
    ),
    /rustdesk device is not disconnect capable/
  );

  const capableHeartbeat = (await fixture.devices.heartbeatDevice({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    actor_identity: 'edge-capability-test',
    runtime_status: 'online',
    seen_at: '2026-07-10T14:02:00.000Z',
    metadata: {
      disconnect_command_capable: true,
      edge_instance_id: 'edge-capability-test'
    }
  }))!;
  assert.doesNotThrow(() => assertRustDeskPhysicalDisconnectCapableIfRequired(
    capableHeartbeat,
    strictEnv,
    Date.parse('2026-07-10T14:03:00.000Z')
  ));
  assert.throws(
    () => assertRustDeskPhysicalDisconnectCapableIfRequired(
      capableHeartbeat,
      strictEnv,
      Date.parse('2026-07-10T14:08:00.001Z')
    ),
    /rustdesk device online heartbeat is stale/
  );
});

test('RustDesk gateway HTTP client forwards the typed disconnect reason', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const client = createRustDeskGatewayClient({
    base_url: 'https://converact.example.com',
    api_token: 'rustdesk-control-plane-token',
    fetch: async (_input, init = {}) => {
      requestBody = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      return new Response(null, { status: 204 });
    }
  });

  await client.endSession({
    external_id: 'rdgw_reason_test',
    actor_identity: 'customer-reason-test',
    reason: 'tool_ended'
  });

  assert.deepEqual(requestBody, {
    actor_identity: 'customer-reason-test',
    reason: 'tool_ended'
  });
});
