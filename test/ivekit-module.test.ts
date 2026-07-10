import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { createIveKitModule } from '../src/agent-runtime/ivekit/index.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import type { RemoteGatewayClient } from '../src/agent-runtime/collaboration/remote-gateway-client.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { createTenant } from '../src/platform/tenant-core.js';

test('createIveKitModule exposes the reusable first-version facades', () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const iveKit = createIveKitModule({ db, pg });

  assert.equal(typeof iveKit.sessions.open, 'function');
  assert.equal(typeof iveKit.sessions.getByBusinessRef, 'function');
  assert.equal(typeof iveKit.media.createRoom, 'function');
  assert.equal(typeof iveKit.media.issueJoinPlan, 'function');
  assert.equal(typeof iveKit.collaboration.postMessage, 'function');
  assert.equal(typeof iveKit.collaboration.addTranslation, 'function');
  assert.equal(typeof iveKit.remote.create, 'function');
  assert.equal(typeof iveKit.remote.createWebAssistJoin, 'function');
  assert.equal(typeof iveKit.remote.verifyWebAssistJoin, 'function');
  assert.equal(typeof iveKit.remote.recordAssistEvent, 'function');
  assert.equal(typeof iveKit.evidence.record, 'function');
  assert.equal(typeof iveKit.remote.endExternalTool, 'function');
  assert.equal(typeof iveKit.remote.end, 'function');
  assert.equal(typeof iveKit.rustdesk.registerDevice, 'function');
  assert.equal(typeof iveKit.rustdesk.listDevicesByBusinessRef, 'function');
  assert.equal(typeof iveKit.rustdesk.getClientConfig, 'function');
  assert.equal(typeof iveKit.rustdesk.getGatewayLaunchPlan, 'function');
  assert.equal(typeof iveKit.rustdesk.startGatewaySession, 'function');
  assert.equal(typeof iveKit.rustdesk.recordGatewayEvent, 'function');
  assert.equal(typeof iveKit.rustdesk.listGatewayAuditEvents, 'function');
  assert.equal(typeof iveKit.rustdesk.listGatewaySessions, 'function');
  assert.equal(typeof iveKit.rustdesk.endGatewaySession, 'function');
  assert.equal(typeof iveKit.rustdesk.heartbeatDevice, 'function');
  assert.equal(typeof iveKit.rustdesk.deactivateDevice, 'function');

  db.close();
});

test('sessions.open creates a LED service order video and Web Assist bundle', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'LED Customer' });
  const tenantId = tenant.id;
  const iveKit = createIveKitModule({ db, pg });

  const bundle = await iveKit.sessions.open({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_led_1001',
      display_name: 'LED order #1001'
    },
    participants: [
      { identity: 'buyer_1001', role: 'customer', display_name: 'Buyer' },
      { identity: 'engineer_42', role: 'engineer', display_name: 'Engineer' }
    ],
    media: {
      enabled: true,
      kind: 'video',
      customer_identity: 'buyer_1001',
      agent_identity: 'engineer_42',
      create_customer_join_path: true
    },
    remote_assistance: {
      enabled: true,
      mode: 'web_remote_assist',
      adapter_provider: 'ivekit_web',
      started_by: 'engineer_42'
    }
  });

  assert.equal(bundle.business_ref.type, 'service_order');
  assert.equal(bundle.business_ref.id, 'order_led_1001');
  assert.match(bundle.collaboration_session_id, /^collab_/);
  assert.match(bundle.media_room_name, new RegExp(`^${tenantId}-`));
  assert.match(bundle.customer_join_path || '', /^\/video\?/);
  assert.match(bundle.remote_session_id || '', /^remote_/);
  assert.match(bundle.remote_assist_request_path || '', /^\/remote-assist\?/);
  const remote = await createCollaborationModule({ pg }).remote.getSession(bundle.remote_session_id!);
  assert.equal(remote?.metadata.media_room_name, bundle.media_room_name);

  const sessions = await iveKit.sessions.getByBusinessRef({
    tenant_id: tenantId,
    business_ref: bundle.business_ref
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].collaboration_session_id, bundle.collaboration_session_id);

  db.close();
});

test('remote.createWebAssistJoin requires active consent and returns a short lived join path', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'Web Assist Tenant' });
  const tenantId = tenant.id;
  const iveKit = createIveKitModule({ db, pg });

  const bundle = await iveKit.sessions.open({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_remote_1002'
    },
    participants: [
      { identity: 'buyer_1002', role: 'customer' },
      { identity: 'engineer_42', role: 'engineer' }
    ],
    remote_assistance: {
      enabled: true,
      mode: 'web_remote_assist',
      adapter_provider: 'ivekit_web',
      started_by: 'engineer_42'
    }
  });

  await assert.rejects(
    () =>
      iveKit.remote.createWebAssistJoin({
        tenant_id: tenantId,
        remote_session_id: bundle.remote_session_id!,
        actor_identity: 'engineer_42',
        role: 'engineer'
      }),
    /active consent required/
  );

  await iveKit.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1002',
    scopes: ['view_screen'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });

  const join = await iveKit.remote.createWebAssistJoin({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42',
    role: 'engineer',
    expires_in_ms: 60_000
  });

  assert.equal(join.remote_session_id, bundle.remote_session_id);
  assert.equal(join.role, 'engineer');
  assert.match(join.join_path, /^\/remote-assist\/session\?/);
  assert.match(join.join_path, /remote_session_id=/);
  assert.match(join.join_path, /token=/);
  assert.ok(new Date(join.expires_at).getTime() > Date.now());

  const audit = await iveKit.remote.listAuditEvents({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!
  });
  assert.equal(audit.some((event) => event.event_type === 'remote.web_assist.join_issued'), true);

  db.close();
});

test('remote.verifyWebAssistJoin accepts issued tokens and rejects tampered or expired tokens', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'Web Assist Token Tenant' });
  const tenantId = tenant.id;
  const iveKit = createIveKitModule({
    db,
    pg,
    media: {
      livekit: {
        url: null,
        apiKey: null,
        apiSecret: 'web-assist-test-secret',
        sipBridgeTarget: '',
        webhookApiKey: null
      }
    }
  });

  const bundle = await iveKit.sessions.open({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_remote_token_1005'
    },
    participants: [
      { identity: 'buyer_1005', role: 'customer' },
      { identity: 'engineer_42', role: 'engineer' }
    ],
    remote_assistance: {
      enabled: true,
      mode: 'web_remote_assist',
      adapter_provider: 'ivekit_web',
      started_by: 'engineer_42'
    }
  });

  await iveKit.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1005',
    scopes: ['view_screen'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });

  const join = await iveKit.remote.createWebAssistJoin({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42',
    role: 'engineer',
    expires_in_ms: 60_000
  });
  const token = new URL(`http://localhost${join.join_path}`).searchParams.get('token')!;

  const verified = await iveKit.remote.verifyWebAssistJoin({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    token
  });

  assert.equal(verified.tenant_id, tenantId);
  assert.equal(verified.remote_session_id, bundle.remote_session_id);
  assert.equal(verified.actor_identity, 'engineer_42');
  assert.equal(verified.role, 'engineer');

  await assert.rejects(
    () =>
      iveKit.remote.verifyWebAssistJoin({
        tenant_id: tenantId,
        remote_session_id: bundle.remote_session_id!,
        token: token.replace(/\.$/, '') + 'x'
      }),
    /invalid Web Assist token/
  );

  await assert.rejects(
    () =>
      iveKit.remote.verifyWebAssistJoin({
        tenant_id: tenantId,
        remote_session_id: bundle.remote_session_id!,
        token,
        now: new Date(new Date(join.expires_at).getTime() + 1)
      }),
    /expired Web Assist token/
  );

  db.close();
});

test('remote.recordAssistEvent stores Web Assist events and stops after consent revocation', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'Web Assist Events Tenant' });
  const tenantId = tenant.id;
  const iveKit = createIveKitModule({ db, pg });

  const bundle = await iveKit.sessions.open({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_remote_1003'
    },
    participants: [
      { identity: 'buyer_1003', role: 'customer' },
      { identity: 'engineer_42', role: 'engineer' }
    ],
    remote_assistance: {
      enabled: true,
      mode: 'web_remote_assist',
      adapter_provider: 'ivekit_web',
      started_by: 'engineer_42'
    }
  });

  await iveKit.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1003',
    scopes: ['view_screen'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });

  const pointer = await iveKit.remote.recordAssistEvent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42',
    event_type: 'pointer.move',
    payload: { x: 120, y: 48 }
  });

  assert.equal(pointer.remote_session_id, bundle.remote_session_id);
  assert.equal(pointer.event_type, 'pointer.move');
  assert.deepEqual(pointer.payload, { x: 120, y: 48 });

  await iveKit.remote.revokeConsent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1003',
    scopes: ['view_screen']
  });

  await assert.rejects(
    () =>
      iveKit.remote.recordAssistEvent({
        tenant_id: tenantId,
        remote_session_id: bundle.remote_session_id!,
        actor_identity: 'engineer_42',
        event_type: 'annotation.draw',
        payload: { path: [[1, 1]] }
      }),
    /active consent required/
  );

  db.close();
});

test('iveKit facade types expose attachment messages and inline control events', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'Facade Contract Tenant' });
  const tenantId = tenant.id;
  const iveKit = createIveKitModule({ db, pg });

  const bundle = await iveKit.sessions.open({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_facade_contract_1007'
    },
    remote_assistance: {
      enabled: true,
      mode: 'web_remote_assist',
      adapter_provider: 'ivekit_web',
      started_by: 'engineer_42'
    }
  });

  const message = await iveKit.collaboration.postMessage({
    tenant_id: tenantId,
    session_id: bundle.collaboration_session_id,
    sender_identity: 'buyer_1007',
    message_type: 'file',
    body: 'see attachment',
    attachments: [
      {
        kind: 'image',
        storage_url: 's3://ivekit-chat/order_facade_contract_1007/photo.png',
        filename: 'photo.png',
        content_type: 'image/png',
        size_bytes: 2048,
        checksum: 'sha256:facade-contract',
        processing_status: 'ready',
        metadata: { ocr_text: 'contact me through platform only' }
      }
    ]
  });

  assert.equal(message.attachments?.length, 1);
  assert.equal(message.attachments?.[0].filename, 'photo.png');

  await iveKit.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1007',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });

  const action = await iveKit.remote.recordAssistEvent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42',
    event_type: 'control.action',
    payload: { action_id: 'ctrl_1', kind: 'click', x_pct: 25, y_pct: 40 }
  });
  const result = await iveKit.remote.recordAssistEvent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1007',
    event_type: 'control.result',
    payload: { action_id: 'ctrl_1', ok: true }
  });

  assert.equal(action.event_type, 'control.action');
  assert.equal(result.event_type, 'control.result');

  db.close();
});

test('remote facade can explicitly end external tools and remote sessions', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'Remote End Tenant' });
  const tenantId = tenant.id;
  const iveKit = createIveKitModule({ db, pg });

  const bundle = await iveKit.sessions.open({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_remote_end_1006'
    },
    remote_assistance: {
      enabled: true,
      mode: 'third_party_remote_tool',
      adapter_provider: 'rustdesk',
      started_by: 'engineer_42'
    }
  });

  await iveKit.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1006',
    scopes: ['view_screen'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });

  const firstTool = await iveKit.remote.startExternalTool({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42',
    provider: 'rustdesk',
    external_id: 'rd-facade-end-1',
    launch_url: 'https://remote.example/rd-facade-end-1'
  });
  assert.equal(firstTool.status, 'active');

  const endedTool = await iveKit.remote.endExternalTool({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    tool_session_id: firstTool.id,
    actor_identity: 'engineer_42'
  });
  assert.equal(endedTool?.id, firstTool.id);
  assert.equal(endedTool?.status, 'ended');

  const secondTool = await iveKit.remote.startExternalTool({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42',
    provider: 'rustdesk',
    external_id: 'rd-facade-end-2',
    launch_url: 'https://remote.example/rd-facade-end-2'
  });
  assert.equal(secondTool.status, 'active');

  const endedRemote = await iveKit.remote.end({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42'
  });
  assert.equal(endedRemote?.id, bundle.remote_session_id);
  assert.equal(endedRemote?.status, 'ended');

  const audit = await iveKit.remote.listAuditEvents({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!
  });
  assert.equal(audit.some((event) => event.event_type === 'remote.tool_session.ended'), true);
  assert.equal(audit.some((event) => event.event_type === 'remote.session.ended'), true);

  db.close();
});

test('remote facade ends RustDesk upstream gateway sessions when ending a tool', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'RustDesk Facade End Tenant' });
  const tenantId = tenant.id;
  const gateway = new RecordingGatewayClient('rustdesk');
  const iveKit = createIveKitModule({ db, pg, remoteGateway: gateway });

  const bundle = await iveKit.sessions.open({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_rustdesk_facade_end_1008'
    },
    remote_assistance: {
      enabled: true,
      mode: 'remote_desktop_gateway',
      adapter_provider: 'rustdesk',
      started_by: 'engineer_42'
    }
  });

  await iveKit.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1008',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });

  const tool = await iveKit.remote.startExternalTool({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42',
    provider: 'rustdesk',
    external_id: 'rdgw-facade-end-1',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-facade-end-1',
    metadata: { gateway_provider: 'rustdesk' }
  });

  const ended = await iveKit.remote.endExternalTool({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    tool_session_id: tool.id,
    actor_identity: 'engineer_42'
  });

  assert.equal(ended?.status, 'ended');
  assert.deepEqual(gateway.endCalls, [
    { external_id: 'rdgw-facade-end-1', actor_identity: 'engineer_42', reason: 'tool_ended' }
  ]);
  assert.deepEqual(gateway.auditCalls, [{ external_id: 'rdgw-facade-end-1', since: undefined }]);

  db.close();
});

test('remote facade revoke closes a local RustDesk gateway and queues physical disconnect', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'RustDesk Local Revoke Tenant' });
  const tenantId = tenant.id;
  const iveKit = createIveKitModule({ db, pg });
  const collaboration = createCollaborationModule({ pg });
  const bundle = await iveKit.sessions.open({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_rustdesk_local_revoke_1012'
    },
    remote_assistance: {
      enabled: true,
      mode: 'remote_desktop_gateway',
      adapter_provider: 'rustdesk',
      started_by: 'engineer_42'
    }
  });
  await iveKit.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1012',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const device = await iveKit.rustdesk.registerDevice({
    tenant_id: tenantId,
    business_ref: bundle.business_ref,
    rustdesk_id: '101210121',
    display_name: 'Local revoke target'
  });
  const gateway = await new RustDeskGatewaySessionStore(pg).createSession({
    tenant_id: tenantId,
    target: { type: 'device', id: device.rustdesk_id },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    actor_identity: 'engineer_42',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=local-revoke',
    metadata: {
      rustdesk_device_id: device.id,
      rustdesk_id: device.rustdesk_id
    }
  });
  await iveKit.remote.startExternalTool({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42',
    provider: 'rustdesk',
    external_id: gateway.external_id,
    launch_url: gateway.launch_url,
    metadata: {
      gateway_provider: 'rustdesk',
      target_id: device.rustdesk_id,
      rustdesk_id: device.rustdesk_id,
      rustdesk_device_id: device.id,
      permissions: ['view_screen', 'control_mouse_keyboard']
    }
  });

  const revoked = await iveKit.remote.revokeConsent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1012',
    scopes: ['view_screen', 'control_mouse_keyboard']
  });
  const endedGateway = await new RustDeskGatewaySessionStore(pg).getSession(gateway.external_id);
  const command = await collaboration.rustdeskCommands.getByExternalId({
    tenant_id: tenantId,
    external_id: gateway.external_id
  });

  assert.equal(endedGateway?.status, 'ended');
  assert.equal(command?.status, 'pending');
  assert.equal(command?.requested_reason, 'consent_revoked');
  assert.equal(revoked.physical_disconnect?.status, 'pending');
  db.close();
});

test('remote facade ends active RustDesk upstream gateway sessions when ending a remote session', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'RustDesk Facade Remote End Tenant' });
  const tenantId = tenant.id;
  const gateway = new RecordingGatewayClient('rustdesk');
  const iveKit = createIveKitModule({ db, pg, remoteGateway: gateway });

  const bundle = await iveKit.sessions.open({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_rustdesk_facade_remote_end_1009'
    },
    remote_assistance: {
      enabled: true,
      mode: 'remote_desktop_gateway',
      adapter_provider: 'rustdesk',
      started_by: 'engineer_42'
    }
  });

  await iveKit.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'buyer_1009',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });

  await iveKit.remote.startExternalTool({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42',
    provider: 'rustdesk',
    external_id: 'rdgw-facade-remote-end-1',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-facade-remote-end-1',
    metadata: { gateway_provider: 'rustdesk' }
  });

  const ended = await iveKit.remote.end({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!,
    actor_identity: 'engineer_42'
  });

  assert.equal(ended?.status, 'ended');
  assert.deepEqual(gateway.endCalls, [
    { external_id: 'rdgw-facade-remote-end-1', actor_identity: 'engineer_42', reason: 'remote_session_ended' }
  ]);

  const audit = await iveKit.remote.listAuditEvents({
    tenant_id: tenantId,
    remote_session_id: bundle.remote_session_id!
  });
  assert.equal(audit.some((event) => event.event_type === 'remote.gateway_session.ended'), true);
  assert.equal(audit.some((event) => event.event_type === 'remote.tool_session.ended'), true);
  assert.equal(audit.some((event) => event.event_type === 'remote.session.ended'), true);

  db.close();
});

test('rustdesk facade requires a fresh online heartbeat before starting registered device sessions when enabled', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'RustDesk Online Gate Tenant' });
  const tenantId = tenant.id;
  const gateway = new RecordingGatewayClient('rustdesk');
  const iveKit = createIveKitModule({ db, pg, remoteGateway: gateway });
  const previousRequireOnline = process.env.OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE;
  const previousRequirePhysicalDisconnect = process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT;
  const previousOnlineTtlMs = process.env.OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS;
  process.env.OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE = '1';
  process.env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT = '1';
  process.env.OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS = '600000';

  try {
    const businessRef = {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_rustdesk_online_gate_1011'
    };
    const bundle = await iveKit.sessions.open({
      tenant_id: tenantId,
      business_ref: businessRef,
      remote_assistance: {
        enabled: true,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk',
        started_by: 'engineer_42'
      }
    });
    const device = await iveKit.rustdesk.registerDevice({
      tenant_id: tenantId,
      business_ref: businessRef,
      rustdesk_id: '987654321',
      display_name: 'LED online gate PC'
    });
    await iveKit.remote.grantConsent({
      tenant_id: tenantId,
      remote_session_id: bundle.remote_session_id!,
      actor_identity: 'buyer_1011',
      scopes: ['view_screen'],
      expires_at: '2099-01-01T00:00:00.000Z'
    });

    await assert.rejects(
      () => iveKit.rustdesk.startGatewaySession({
        tenant_id: tenantId,
        remote_session_id: bundle.remote_session_id!,
        actor_identity: 'engineer_42',
        device_id: device.id,
        permissions: ['view_screen']
      }),
      /rustdesk device is not online/
    );
    assert.equal(gateway.createCalls.length, 0);

    await iveKit.rustdesk.heartbeatDevice({
      tenant_id: tenantId,
      device_id: device.id,
      actor_identity: 'rustdesk-edge-agent',
      runtime_status: 'online',
      seen_at: new Date().toISOString()
    });

    await assert.rejects(
      () => iveKit.rustdesk.startGatewaySession({
        tenant_id: tenantId,
        remote_session_id: bundle.remote_session_id!,
        actor_identity: 'engineer_42',
        device_id: device.id,
        permissions: ['view_screen']
      }),
      /rustdesk device is not disconnect capable/
    );
    assert.equal(gateway.createCalls.length, 0);

    await iveKit.rustdesk.heartbeatDevice({
      tenant_id: tenantId,
      device_id: device.id,
      actor_identity: 'rustdesk-edge-agent',
      runtime_status: 'online',
      seen_at: new Date().toISOString(),
      metadata: {
        disconnect_command_capable: true,
        edge_instance_id: 'edge-ivekit-module'
      }
    });

    const tool = await iveKit.rustdesk.startGatewaySession({
      tenant_id: tenantId,
      remote_session_id: bundle.remote_session_id!,
      actor_identity: 'engineer_42',
      device_id: device.id,
      permissions: ['view_screen']
    });
    assert.equal(tool.provider, 'rustdesk');
    assert.equal(gateway.createCalls.length, 1);
  } finally {
    setOptionalEnv('OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE', previousRequireOnline);
    setOptionalEnv('OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT', previousRequirePhysicalDisconnect);
    setOptionalEnv('OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS', previousOnlineTtlMs);
    db.close();
  }
});

test('rustdesk facade registers devices and starts gateway sessions by registered device', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'RustDesk Facade Tenant' });
  const tenantId = tenant.id;
  const gateway = new RecordingGatewayClient('rustdesk');
  const iveKit = createIveKitModule({ db, pg, remoteGateway: gateway });
  const previousPublicKey = process.env.OPC_RUSTDESK_PUBLIC_KEY;
  const previousIdServer = process.env.OPC_RUSTDESK_ID_SERVER;
  const previousRelayServer = process.env.OPC_RUSTDESK_RELAY_SERVER;
  const previousProtocolTemplate = process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE;
  process.env.OPC_RUSTDESK_PUBLIC_KEY = 'rustdesk-public-key';
  process.env.OPC_RUSTDESK_ID_SERVER = 'id.ivekit.example';
  process.env.OPC_RUSTDESK_RELAY_SERVER = 'relay.ivekit.example';
  process.env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE = 'rustdesk://connect/{rustdesk_id}?session={external_id}';

  try {
    const businessRef = {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order_rustdesk_facade_1010'
    };
    const bundle = await iveKit.sessions.open({
      tenant_id: tenantId,
      business_ref: businessRef,
      remote_assistance: {
        enabled: true,
        mode: 'remote_desktop_gateway',
        adapter_provider: 'rustdesk',
        started_by: 'engineer_42'
      }
    });

    const device = await iveKit.rustdesk.registerDevice({
      tenant_id: tenantId,
      business_ref: businessRef,
      rustdesk_id: '123456789',
      display_name: 'LED control PC',
      metadata: { site: 'showroom' }
    });
    assert.match(device.id, /^rdesk_/);

    const devices = await iveKit.rustdesk.listDevicesByBusinessRef({
      tenant_id: tenantId,
      business_ref: businessRef
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, device.id);

    const heartbeat = await iveKit.rustdesk.heartbeatDevice({
      tenant_id: tenantId,
      device_id: device.id,
      actor_identity: 'rustdesk-edge-agent',
      runtime_status: 'online',
      seen_at: '2026-07-04T01:00:00.000Z',
      metadata: {
        client_version: '1.2.3',
        os: 'windows'
      }
    });
    assert.equal(heartbeat?.runtime_status, 'online');
    assert.equal(heartbeat?.last_seen_actor, 'rustdesk-edge-agent');
    const lastHeartbeat = heartbeat?.metadata.last_heartbeat as Record<string, unknown> | undefined;
    assert.equal(lastHeartbeat?.client_version, '1.2.3');

    const clientConfig = await iveKit.rustdesk.getClientConfig();
    assert.equal(clientConfig.public_key, 'rustdesk-public-key');
    assert.equal(clientConfig.id_server, 'id.ivekit.example');
    assert.equal(clientConfig.manual_fields.relay_server, 'relay.ivekit.example');

    await iveKit.remote.grantConsent({
      tenant_id: tenantId,
      remote_session_id: bundle.remote_session_id!,
      actor_identity: 'buyer_1010',
      scopes: ['view_screen', 'control_mouse_keyboard', 'record_screen'],
      expires_at: '2099-01-01T00:00:00.000Z'
    });

    const tool = await iveKit.rustdesk.startGatewaySession({
      tenant_id: tenantId,
      remote_session_id: bundle.remote_session_id!,
      actor_identity: 'engineer_42',
      device_id: device.id,
      permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen'],
      metadata: { source: 'led' }
    });

    assert.equal(tool.provider, 'rustdesk');
    assert.equal(tool.metadata.gateway_provider, 'rustdesk');
    assert.equal(tool.metadata.target_id, device.id);
    assert.equal(tool.metadata.rustdesk_id, '123456789');
    assert.equal(tool.metadata.rustdesk_device_id, device.id);
    assert.deepEqual(gateway.createCalls, [
      {
        target: { type: 'device', id: '123456789', display_name: 'LED control PC' },
        permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen'],
        actor_identity: 'engineer_42',
        metadata: {
          source: 'led',
          remote_session_id: bundle.remote_session_id,
          collaboration_session_id: bundle.collaboration_session_id,
          rustdesk_target_mode: 'registered_device',
          target_id: device.id,
          rustdesk_id: '123456789',
          rustdesk_device_id: device.id,
          target_display_name: 'LED control PC'
        }
      }
    ]);

    const controlPlaneStore = new RustDeskGatewaySessionStore(pg);
    await controlPlaneStore.createSession({
      external_id: tool.external_id,
      tenant_id: tenantId,
      target: {
        type: 'device',
        id: '123456789',
        display_name: 'LED control PC'
      },
      permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen'],
      actor_identity: 'engineer_42',
      launch_url: tool.launch_url,
      metadata: {
        ...(gateway.createCalls[0]?.metadata || {}),
        rustdesk_id: '123456789'
      }
    });
    const gatewaySessions = await iveKit.rustdesk.listGatewaySessions({
      tenant_id: tenantId,
      status: 'active'
    });
    assert.deepEqual(gatewaySessions.map((session) => session.external_id), [tool.external_id]);
    assert.equal(gatewaySessions[0]?.target.id, '123456789');

    const launchPlan = await iveKit.rustdesk.getGatewayLaunchPlan({
      tenant_id: tenantId,
      external_id: tool.external_id
    });
    assert.equal(launchPlan.external_id, tool.external_id);
    assert.equal(launchPlan.status, 'active');
    assert.equal(launchPlan.runtime.rustdesk_id, '123456789');
    assert.equal(launchPlan.runtime.id_server, 'id.ivekit.example');
    assert.equal(launchPlan.runtime.relay_server, 'relay.ivekit.example');
    assert.deepEqual(launchPlan.client_config.manual_fields, {
      id_server: 'id.ivekit.example',
      relay_server: 'relay.ivekit.example',
      key: 'rustdesk-public-key'
    });
    assert.equal(launchPlan.client_config.public_key_configured, true);
    assert.equal(launchPlan.actions.can_launch, true);
    assert.equal(launchPlan.actions.open_url, tool.launch_url);
    assert.equal(
      launchPlan.actions.protocol_url,
      `rustdesk://connect/123456789?session=${encodeURIComponent(tool.external_id)}`
    );
    await assert.rejects(
      () => iveKit.rustdesk.getGatewayLaunchPlan({
        tenant_id: 'tenant_other_rustdesk_facade',
        external_id: tool.external_id
      }),
      /rustdesk gateway session not found/
    );
    await assert.rejects(
      () => iveKit.rustdesk.recordGatewayEvent({
        tenant_id: tenantId,
        external_id: tool.external_id,
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: 'engineer_42',
        target: '123456789',
        idempotency_key: 'recording-invalid-rustdesk-1',
        metadata: { recording_id: 'egress-rustdesk-1' },
        occurred_at: '2026-07-03T00:59:00.000Z'
      }),
      /RustDesk recording event metadata.evidence_type is required/
    );
    await assert.rejects(
      () => iveKit.rustdesk.recordGatewayEvent({
        tenant_id: tenantId,
        external_id: tool.external_id,
        event_type: 'remote.rustdesk.file_transfer.started',
        actor_identity: 'engineer_42',
        target: '123456789',
        idempotency_key: 'file-ungranted-rustdesk-1',
        metadata: { transfer_id: 'file-ungranted-rustdesk-1', direction: 'upload' },
        occurred_at: '2026-07-03T00:59:30.000Z'
      }),
      /RustDesk file transfer event requires transfer_file permission/
    );
    await assert.rejects(
      () => iveKit.rustdesk.recordGatewayEvent({
        tenant_id: tenantId,
        external_id: tool.external_id,
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: 'engineer_42',
        target: '123456789',
        idempotency_key: 'recording-invalid-time-rustdesk-1',
        metadata: { recording_id: 'egress-rustdesk-invalid-time', evidence_type: 'screen_recording' },
        occurred_at: 'not-a-date'
      }),
      /occurred_at must be an ISO timestamp/
    );

    const recordedEvent = await iveKit.rustdesk.recordGatewayEvent({
      tenant_id: tenantId,
      external_id: tool.external_id,
      event_type: 'remote.rustdesk.recording.started',
      actor_identity: 'engineer_42',
      target: '123456789',
      idempotency_key: 'recording-started-egress-rustdesk-1',
      metadata: { recording_id: 'egress-rustdesk-1', evidence_type: 'screen_recording' },
      occurred_at: '2026-07-03T01:00:00.000Z'
    });
    const retriedRecordedEvent = await iveKit.rustdesk.recordGatewayEvent({
      tenant_id: tenantId,
      external_id: tool.external_id,
      event_type: 'remote.rustdesk.recording.started',
      actor_identity: 'engineer_42',
      target: '123456789',
      idempotency_key: 'recording-started-egress-rustdesk-1',
      metadata: {
        recording_id: 'egress-rustdesk-1',
        evidence_type: 'screen_recording',
        retry_attempt: 1
      },
      occurred_at: '2026-07-03T01:00:00.000Z'
    });
    assert.equal(recordedEvent?.event_type, 'remote.rustdesk.recording.started');
    assert.equal(recordedEvent?.metadata.recording_id, 'egress-rustdesk-1');
    assert.equal(recordedEvent?.metadata.evidence_type, 'screen_recording');
    assert.equal(recordedEvent?.metadata.idempotency_key, 'recording-started-egress-rustdesk-1');
    assert.deepEqual(retriedRecordedEvent, recordedEvent);
    const timelineAfterEvent = await iveKit.remote.listAuditEvents({
      tenant_id: tenantId,
      remote_session_id: bundle.remote_session_id!
    });
    assert.equal(
      timelineAfterEvent.some((event) => event.event_type === 'remote.rustdesk.recording.started'),
      true
    );

    const gatewayAudit = await iveKit.rustdesk.listGatewayAuditEvents({
      tenant_id: tenantId,
      external_id: tool.external_id
    });
    assert.deepEqual(gatewayAudit.map((event) => event.event_type), [
      'remote.gateway_session.created',
      'remote.rustdesk.recording.started'
    ]);
    await assert.rejects(
      () => iveKit.rustdesk.listGatewayAuditEvents({
        tenant_id: tenantId,
        external_id: tool.external_id,
        since: 'not-a-date'
      }),
      /since must be an ISO timestamp/
    );
    await assert.rejects(
      () => iveKit.rustdesk.endGatewaySession({
        tenant_id: 'tenant_other_rustdesk_facade',
        external_id: tool.external_id,
        actor_identity: 'engineer_42'
      }),
      /rustdesk gateway session not found/
    );
    const endedGatewaySession = await iveKit.rustdesk.endGatewaySession({
      tenant_id: tenantId,
      external_id: tool.external_id,
      actor_identity: 'engineer_42'
    });
    assert.equal(endedGatewaySession.status, 'ended');
    const disconnectCommand = await createCollaborationModule({ pg }).rustdeskCommands.getByExternalId({
      tenant_id: tenantId,
      external_id: tool.external_id
    });
    assert.equal(disconnectCommand?.status, 'pending');
    assert.equal(disconnectCommand?.requested_reason, 'gateway_ended');
    const launchAfterEnd = await iveKit.rustdesk.getGatewayLaunchPlan({
      tenant_id: tenantId,
      external_id: tool.external_id
    });
    assert.equal(launchAfterEnd.actions.can_launch, false);
    const timelineAfterEnd = await iveKit.remote.listAuditEvents({
      tenant_id: tenantId,
      remote_session_id: bundle.remote_session_id!
    });
    assert.equal(
      timelineAfterEnd.some((event) => event.event_type === 'remote.gateway_session.ended'),
      true
    );
    assert.equal(
      timelineAfterEnd.some((event) => event.event_type === 'remote.tool_session.ended'),
      true
    );
    const toolSessionsAfterEnd = await createCollaborationModule({ pg }).remote.listToolSessions(bundle.remote_session_id!);
    assert.equal(
      toolSessionsAfterEnd.find((session) => session.external_id === tool.external_id)?.status,
      'ended'
    );
    await assert.rejects(
      () => iveKit.rustdesk.recordGatewayEvent({
        tenant_id: tenantId,
        external_id: tool.external_id,
        event_type: 'remote.rustdesk.file_transfer.started',
        actor_identity: 'engineer_42',
        target: '123456789',
        idempotency_key: 'file-after-end-rustdesk-1',
        metadata: { transfer_id: 'file-after-end-rustdesk-1', direction: 'upload' },
        occurred_at: '2026-07-03T01:05:00.000Z'
      }),
      /RustDesk gateway session is not active/
    );

    const deactivated = await iveKit.rustdesk.deactivateDevice({
      tenant_id: tenantId,
      device_id: device.id
    });
    assert.equal(deactivated?.status, 'inactive');
  } finally {
    setOptionalEnv('OPC_RUSTDESK_PUBLIC_KEY', previousPublicKey);
    setOptionalEnv('OPC_RUSTDESK_ID_SERVER', previousIdServer);
    setOptionalEnv('OPC_RUSTDESK_RELAY_SERVER', previousRelayServer);
    setOptionalEnv('OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE', previousProtocolTemplate);
    db.close();
  }
});

test('evidence facade records and lists reusable media evidence', async () => {
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenant = createTenant(db, { name: 'Evidence Tenant' });
  const tenantId = tenant.id;
  const iveKit = createIveKitModule({ db, pg });
  const businessRef = {
    tenant_id: tenantId,
    type: 'service_order',
    id: 'order_evidence_1004'
  };

  const evidence = await iveKit.evidence.record({
    tenant_id: tenantId,
    business_ref: businessRef,
    session_id: 'remote_session_1004',
    kind: 'screen_recording',
    storage_url: 's3://ivekit-evidence/order_evidence_1004.webm',
    checksum: 'sha256:test',
    created_by: 'engineer_42',
    metadata: { duration_ms: 1234 }
  });

  assert.match(evidence.id, /^evid_/);
  assert.equal(evidence.business_ref.id, businessRef.id);
  assert.equal(evidence.kind, 'screen_recording');

  const byBusiness = await iveKit.evidence.listByBusinessRef({
    tenant_id: tenantId,
    business_ref: businessRef
  });
  assert.equal(byBusiness.length, 1);
  assert.equal(byBusiness[0].id, evidence.id);

  const bySession = await iveKit.evidence.listBySession({
    tenant_id: tenantId,
    session_id: 'remote_session_1004'
  });
  assert.equal(bySession.length, 1);
  assert.equal(bySession[0].id, evidence.id);

  db.close();
});

class RecordingGatewayClient implements RemoteGatewayClient {
  readonly createCalls: Array<Parameters<RemoteGatewayClient['createSession']>[0]> = [];
  readonly endCalls: Array<{ external_id: string; actor_identity: string; reason?: string }> = [];
  readonly auditCalls: Array<{ external_id: string; since?: string }> = [];
  private createSequence = 0;

  constructor(readonly provider: RemoteGatewayClient['provider']) {}

  async createSession(input: Parameters<RemoteGatewayClient['createSession']>[0]): Promise<Awaited<ReturnType<RemoteGatewayClient['createSession']>>> {
    this.createCalls.push(input);
    this.createSequence += 1;
    return {
      provider: this.provider,
      external_id: `rdgw-recording-${this.createSequence}`,
      launch_url: `https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-recording-${this.createSequence}`,
      target: input.target,
      permissions: [...input.permissions],
      metadata: input.metadata || {}
    };
  }

  async endSession(input: Parameters<RemoteGatewayClient['endSession']>[0]): Promise<void> {
    this.endCalls.push({
      external_id: input.external_id,
      actor_identity: input.actor_identity,
      reason: input.reason
    });
  }

  async listAuditEvents(input: Parameters<RemoteGatewayClient['listAuditEvents']>[0]): Promise<Awaited<ReturnType<RemoteGatewayClient['listAuditEvents']>>> {
    this.auditCalls.push({
      external_id: input.external_id,
      since: input.since
    });
    return [
      {
        external_id: input.external_id,
        event_type: 'remote.gateway_session.ended',
        actor_identity: 'engineer_42',
        target: input.external_id,
        metadata: { gateway_provider: this.provider },
        occurred_at: '2026-07-03T00:00:00.000Z'
      }
    ];
  }
}

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
