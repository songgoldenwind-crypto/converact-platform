import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { RustDeskControlLockStore } from '../src/agent-runtime/collaboration/rustdesk-control-lock-store.js';
import { RustDeskDeviceStore } from '../src/agent-runtime/collaboration/rustdesk-device-store.js';
import { createRustDeskEdgeCommandToken } from '../src/agent-runtime/collaboration/rustdesk-edge-auth.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { MemoryPg } from '../src/db-pg.js';

const EDGE_SECRET = 'rustdesk-observation-http-edge-secret-32-bytes';

async function route(
  pg: MemoryPg,
  method: string,
  path: string,
  body: unknown,
  token?: string
) {
  return routeCollaborationApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    token ? { 'x-rustdesk-edge-token': token } : {}
  );
}

function edgeToken(tenantId: string, rustdeskId: string, edgeInstanceId: string): string {
  return createRustDeskEdgeCommandToken({
    tenant_id: tenantId,
    rustdesk_id: rustdeskId,
    edge_instance_id: edgeInstanceId,
    issued_at: '2026-07-15T00:00:00.000Z',
    expires_at: '2099-07-15T00:00:00.000Z'
  }, EDGE_SECRET);
}

async function fixture(owner?: {
  interaction_id: string;
  reservation_id: string;
  owner_epoch: string;
}) {
  const pg = new MemoryPg();
  const tenantId = 'tenant_edge_observation';
  const devices = new RustDeskDeviceStore(pg);
  const device = await devices.registerDevice({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'led_device',
      id: 'LED-OBS-1001'
    },
    rustdesk_id: '246813579',
    display_name: 'LED observation target'
  });
  const sessions = new RustDeskGatewaySessionStore(pg);
  const session = await sessions.createSession({
    tenant_id: tenantId,
    target: { type: 'device', id: device.rustdesk_id },
    permissions: [
      'view_screen',
      'control_mouse_keyboard',
      'transfer_file',
      'clipboard',
      'record_screen'
    ],
    actor_identity: 'agent-observer-owner',
    launch_url: 'https://fabric.converact.example.com/rustdesk/observation-session',
    metadata: {
      rustdesk_device_id: device.id,
      rustdesk_id: device.rustdesk_id,
      control_enforcement_version: 1,
      ...(owner
        ? {
            remote_session_id: owner.interaction_id,
            ivekit_reservation_id: owner.reservation_id,
            ivekit_owner_epoch: owner.owner_epoch
          }
        : {})
    }
  });
  const locks = new RustDeskControlLockStore(pg);
  const confirmation = await locks.issueConfirmation({
    tenant_id: tenantId,
    external_id: session.external_id,
    actor_identity: 'agent-observer-owner',
    operation: 'control_mouse_keyboard'
  });
  const ownership = await locks.acquire({
    tenant_id: tenantId,
    external_id: session.external_id,
    actor_identity: 'agent-observer-owner',
    confirmation_id: confirmation.id,
    lease_ms: 120_000
  });
  return { pg, tenantId, device, session, sessions, ownership };
}

test('device observations are fenced by the gateway placement owner', async () => {
  const previous = process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET;
  process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET = EDGE_SECRET;
  const owner = {
    interaction_id: 'remote-session-observation-owner-1',
    reservation_id: 'reservation-observation-owner-1',
    owner_epoch: '61'
  };
  const value = await fixture(owner);
  const token = edgeToken(value.tenantId, value.device.rustdesk_id, 'windows-edge-owner-01');
  const path = `/api/ivekit/rustdesk/devices/${value.device.id}/observations`;
  const observation = {
    external_id: value.session.external_id,
    operation_id: 'screen-owner-fence-1',
    operation: 'view_screen',
    status: 'observed_succeeded',
    observer: 'native_client',
    source_adapter: 'rustdesk_log',
    observed_at: new Date().toISOString(),
    evidence_refs: [{
      type: 'native_log',
      ref: 'evidence://rustdesk/screen-owner-fence-1',
      sha256: `sha256:${'a'.repeat(64)}`
    }],
    ...owner
  };

  try {
    await assert.rejects(
      () => route(value.pg, 'POST', path, {
        observations: [{ ...observation, owner_epoch: '62' }]
      }, token),
      /rustdesk_owner_binding_mismatch/
    );
    const accepted = await route(value.pg, 'POST', path, {
      observations: [observation]
    }, token) as { status: number };
    assert.equal(accepted.status, 201);
  } finally {
    if (previous === undefined) delete process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET;
    else process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET = previous;
  }
});

test('device token heartbeat resolves only a pre-registered matching business device', async () => {
  const previous = process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET;
  process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET = EDGE_SECRET;
  const value = await fixture();
  const token = edgeToken(value.tenantId, value.device.rustdesk_id, 'windows-edge-01');

  try {
    const response = await route(value.pg, 'POST', '/api/ivekit/rustdesk/edge/heartbeat', {
      business_ref: { type: 'led_device', id: 'LED-OBS-1001' },
      runtime_status: 'online',
      seen_at: '2026-07-15T05:00:00.000Z',
      metadata: {
        disconnect_command_capable: true,
        observation_capable: true,
        evidence_upload_capable: true,
        evidence_poll_interval_ms: 2_500,
        os: 'windows',
        client_version: '1.4.9'
      }
    }, token) as { status: number; data: { id: string; last_seen_actor: string; runtime_status: string } };
    assert.equal(response.status, 201);
    assert.equal(response.data.id, value.device.id);
    assert.equal(response.data.last_seen_actor, 'windows-edge-01');
    assert.equal(response.data.runtime_status, 'online');

    const notFound = await route(value.pg, 'POST', '/api/ivekit/rustdesk/edge/heartbeat', {
      business_ref: { type: 'led_device', id: 'LED-OTHER' },
      runtime_status: 'online'
    }, token);
    assert.deepEqual(notFound, { status: 404, data: { error: 'rustdesk device not found' } });
    assert.deepEqual(
      await route(value.pg, 'POST', '/api/ivekit/rustdesk/edge/heartbeat', {}, undefined),
      { status: 401, data: { error: 'RustDesk edge token is required' } }
    );
  } finally {
    if (previous === undefined) delete process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET;
    else process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET = previous;
  }
});

test('device observation batch is idempotent and binds sensitive operations to the current controller', async () => {
  const previous = process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET;
  process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET = EDGE_SECRET;
  const value = await fixture();
  const token = edgeToken(value.tenantId, value.device.rustdesk_id, 'windows-edge-01');
  const observedAt = new Date().toISOString();
  const body = {
    observations: [
      {
        external_id: value.session.external_id,
        operation_id: 'screen-view-1',
        operation: 'view_screen',
        status: 'observed_succeeded',
        observer: 'native_client',
        source_adapter: 'rustdesk_log',
        observed_at: observedAt,
        evidence_refs: [{
          type: 'native_log',
          ref: 'evidence://rustdesk/screen-view-1',
          sha256: `sha256:${'a'.repeat(64)}`
        }],
        display_id: 'display-1'
      },
      {
        external_id: value.session.external_id,
        operation_id: 'control-1',
        operation: 'control_mouse_keyboard',
        status: 'observed_succeeded',
        observer: 'edge_adapter',
        source_adapter: 'companion_hook',
        observed_at: observedAt,
        evidence_refs: [{
          type: 'native_log',
          ref: 'evidence://rustdesk/control-1',
          sha256: `sha256:${'b'.repeat(64)}`
        }],
        control_version: value.ownership.version,
        duration_ms: 420
      }
    ]
  };

  try {
    const response = await route(
      value.pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${value.device.id}/observations`,
      body,
      token
    ) as { status: number; data: { events: Array<{ actor_identity: string; metadata: Record<string, unknown> }> } };
    assert.equal(response.status, 201);
    assert.equal(response.data.events.length, 2);
    assert.equal(response.data.events[0].actor_identity, 'windows-edge-01');
    assert.equal(response.data.events[1].actor_identity, 'agent-observer-owner');
    assert.equal(response.data.events[1].metadata.edge_instance_id, 'windows-edge-01');

    await route(
      value.pg,
      'POST',
      `/api/ivekit/rustdesk/devices/${value.device.id}/observations`,
      body,
      token
    );
    const audit = await value.sessions.listAuditEvents({ external_id: value.session.external_id });
    assert.equal(
      audit?.filter((event) => event.event_type === 'remote.rustdesk.operation.observed').length,
      2
    );
  } finally {
    if (previous === undefined) delete process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET;
    else process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET = previous;
  }
});

test('device observations reject device drift, stale control, secrets, and ended sessions', async () => {
  const previous = process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET;
  process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET = EDGE_SECRET;
  const value = await fixture();
  const path = `/api/ivekit/rustdesk/devices/${value.device.id}/observations`;
  const base = {
    external_id: value.session.external_id,
    operation_id: 'control-rejected',
    operation: 'control_mouse_keyboard',
    status: 'observed_succeeded',
    observer: 'edge_adapter',
    source_adapter: 'companion_hook',
    observed_at: new Date().toISOString(),
    evidence_refs: [{
      type: 'native_log',
      ref: 'evidence://rustdesk/control-rejected',
      sha256: `sha256:${'c'.repeat(64)}`
    }],
    control_version: value.ownership.version
  };

  try {
    assert.deepEqual(
      await route(value.pg, 'POST', path, { observations: [base] }, edgeToken(
        value.tenantId,
        '999999999',
        'wrong-device'
      )),
      { status: 404, data: { error: 'rustdesk device not found' } }
    );
    await assert.rejects(
      () => route(value.pg, 'POST', path, {
        observations: [{ ...base, control_version: value.ownership.version - 1 }]
      }, edgeToken(value.tenantId, value.device.rustdesk_id, 'windows-edge-01')),
      /stale control ownership version/
    );
    await assert.rejects(
      () => route(value.pg, 'POST', path, {
        observations: [{ ...base, clipboard_content: 'must never reach audit' }]
      }, edgeToken(value.tenantId, value.device.rustdesk_id, 'windows-edge-01')),
      /unsupported RustDesk edge observation field: clipboard_content/
    );
    await assert.rejects(
      () => route(value.pg, 'POST', path, {
        observations: [{
          ...base,
          operation_id: 'transfer-without-security',
          operation: 'transfer_file',
          direction: 'upload'
        }]
      }, edgeToken(value.tenantId, value.device.rustdesk_id, 'windows-edge-01')),
      /transfer_file observation evidence_security is required/
    );

    await value.sessions.endSession({
      external_id: value.session.external_id,
      actor_identity: 'customer-ended'
    });
    await assert.rejects(
      () => route(value.pg, 'POST', path, { observations: [base] }, edgeToken(
        value.tenantId,
        value.device.rustdesk_id,
        'windows-edge-01'
      )),
      /RustDesk gateway session is not active/
    );
  } finally {
    if (previous === undefined) delete process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET;
    else process.env.CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET = previous;
  }
});
