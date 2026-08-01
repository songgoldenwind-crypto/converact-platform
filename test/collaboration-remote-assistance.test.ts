import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import type {
  RemoteGatewayAuditEvent,
  RemoteGatewayClient,
  RemoteGatewayCreateInput,
  RemoteGatewayEndInput
} from '../src/agent-runtime/collaboration/remote-gateway-client.js';
import type { RemoteGatewaySessionInput } from '../src/agent-runtime/collaboration/remote-gateway-adapter.js';
import { MemoryPg } from '../src/db-pg.js';

test('collaboration module binds conversations to arbitrary business refs', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_collab_pg';
  const module = createCollaborationModule({ pg });

  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order_led_1' },
    title: 'LED remote support'
  });
  await module.sessions.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'customer_1',
    role: 'customer',
    display_name: 'Customer'
  });
  const message = await module.sessions.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer_1',
    message_type: 'text',
    body: 'Please call me at 555-123-4567 outside app'
  });

  const policy = await module.sessions.scanPolicy({
    tenant_id: tenantId,
    session_id: session.id,
    message_id: message.id,
    text: message.body
  });

  assert.equal(session.business_ref_type, 'service_order');
  assert.equal(session.business_ref_id, 'order_led_1');
  assert.equal(policy.matched, true);
  assert.equal(policy.events.length, 2);
  assert.equal((await module.sessions.listTimeline(session.id)).length, 2);
});

test('remote assistance requires consent before starting an external tool session', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_remote_pg';
  const module = createCollaborationModule({ pg });
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'call_session', id: 'call_1' },
    title: 'Converact support call'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: session.business_ref,
    mode: 'third_party_remote_tool',
    adapter_provider: 'external_link',
    started_by: 'agent_1'
  });

  await assert.rejects(
    () =>
      module.remote.startToolSession({
        tenant_id: tenantId,
        remote_session_id: remote.id,
        actor_identity: 'agent_1',
        provider: 'anydesk',
        external_id: '123 456 789'
      }),
    /active consent required/
  );

  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer_1',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const tool = await module.remote.startToolSession({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'agent_1',
    provider: 'anydesk',
    external_id: '123 456 789'
  });

  const auditCount = Number(
    (await pg.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM remote_audit_events WHERE remote_session_id = $1',
      [remote.id]
    )).rows[0]?.count || 0
  );
  assert.equal(tool.provider, 'anydesk');
  assert.equal(tool.status, 'active');
  assert.equal(auditCount >= 3, true);
});

test('remote assistance revoking consent ends active tool sessions', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_remote_revoke_pg';
  const module = createCollaborationModule({ pg });
  const businessRef = { tenant_id: tenantId, type: 'support_ticket', id: 'ticket_revoke' };
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: 'Revoke remote support'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'third_party_remote_tool',
    started_by: 'agent_revoke'
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer_revoke',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const activeTool = await module.remote.startToolSession({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'agent_revoke',
    provider: 'anydesk',
    external_id: 'ad-revoke-1'
  });

  await module.remote.revokeConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer_revoke',
    scopes: ['view_screen', 'control_mouse_keyboard']
  });

  const endedTool = await module.remote.getToolSession(activeTool.id);
  const toolSessions = await module.remote.listToolSessions(remote.id);
  const auditEvents = await module.remote.listAuditEvents({
    tenant_id: tenantId,
    remote_session_id: remote.id
  });
  const evidence = await module.remote.listEvidence({
    tenant_id: tenantId,
    business_ref: businessRef
  });

  assert.equal(endedTool?.status, 'ended');
  assert.deepEqual(toolSessions.map((tool) => tool.status), ['ended']);
  assert.equal(auditEvents.some((event) => event.event_type === 'remote.consent.revoked'), true);
  assert.equal(auditEvents.some((event) => event.event_type === 'remote.tool_session.ended'), true);
  assert.equal(evidence.some((record) => record.kind === 'consent_revocation'), true);
  await assert.rejects(
    () =>
      module.remote.startToolSession({
        tenant_id: tenantId,
        remote_session_id: remote.id,
        actor_identity: 'agent_revoke',
        provider: 'anydesk',
        external_id: 'ad-revoke-2'
      }),
    /active consent required/
  );
});

test('collaboration and remote assistance can be resolved by business ref and closed', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_lifecycle_pg';
  const businessRef = {
    tenant_id: tenantId,
    type: 'service_order',
    id: 'order_led_lifecycle',
    display_name: 'LED service order'
  };
  const module = createCollaborationModule({ pg });

  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: 'LED lifecycle support'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'third_party_remote_tool',
    started_by: 'agent_2'
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer_2',
    scopes: ['view_screen'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const tool = await module.remote.startToolSession({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'agent_2',
    provider: 'teamviewer',
    external_id: '987 654 321'
  });

  const sessionsForOrder = await module.sessions.listByBusinessRef({
    tenant_id: tenantId,
    business_ref: businessRef
  });
  const remotesForOrder = await module.remote.listByBusinessRef({
    tenant_id: tenantId,
    business_ref: businessRef
  });
  const endedRemote = await module.remote.endSession({
    remote_session_id: remote.id,
    actor_identity: 'agent_2'
  });
  const closedSession = await new CollaborationStore(pg).closeSession(session.id);
  const endedTool = await module.remote.getToolSession(tool.id);
  const auditCount = Number(
    (await pg.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM remote_audit_events WHERE remote_session_id = $1',
      [remote.id]
    )).rows[0]?.count || 0
  );

  assert.equal(sessionsForOrder.length, 1);
  assert.equal(sessionsForOrder[0]?.id, session.id);
  assert.equal(remotesForOrder.length, 1);
  assert.equal(remotesForOrder[0]?.id, remote.id);
  assert.equal(endedRemote?.status, 'ended');
  assert.equal(endedRemote?.ended_at != null, true);
  assert.equal(closedSession?.status, 'closed');
  assert.equal(closedSession?.closed_at != null, true);
  assert.equal(endedTool?.status, 'ended');
  assert.equal(auditCount >= 5, true);
});

test('remote assistance exposes consent, tool, audit, and evidence timelines', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_audit_pg';
  const module = createCollaborationModule({ pg });
  const businessRef = { tenant_id: tenantId, type: 'support_ticket', id: 'ticket_audit_1' };
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: 'Audit support'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'third_party_remote_tool',
    started_by: 'agent_audit'
  });

  await module.remote.requestConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'agent_audit',
    scopes: ['view_screen']
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer_audit',
    scopes: ['view_screen'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const tool = await module.remote.startToolSession({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'agent_audit',
    provider: 'external_link',
    launch_url: 'https://remote.example/session/1'
  });
  await module.remote.endToolSession(tool.id);
  await module.remote.recordEvidence({
    tenant_id: tenantId,
    business_ref: businessRef,
    session_id: remote.id,
    kind: 'remote_control_log',
    storage_url: 's3://converact-audit/ticket_audit_1/log.json',
    checksum: 'sha256:remote-log',
    created_by: 'agent_audit'
  });

  const consentEvents = await module.remote.listConsentEvents(remote.id);
  const toolSessions = await module.remote.listToolSessions(remote.id);
  const auditEvents = await module.remote.listAuditEvents({
    tenant_id: tenantId,
    remote_session_id: remote.id
  });
  const evidence = await module.remote.listEvidence({
    tenant_id: tenantId,
    business_ref: businessRef
  });

  assert.deepEqual(consentEvents.map((event) => event.event_type), ['requested', 'granted']);
  assert.equal(toolSessions.length, 1);
  assert.equal(toolSessions[0]?.status, 'ended');
  assert.equal(auditEvents.some((event) => event.event_type === 'remote.tool_session.started'), true);
  assert.equal(auditEvents.some((event) => event.event_type === 'remote.tool_session.ended'), true);
  assert.equal(evidence.some((record) => record.kind === 'consent_grant'), true);
  assert.equal(evidence.some((record) => record.kind === 'remote_control_log'), true);
});

test('remote gateway adapters normalize MeshCentral and Guacamole sessions for tool launch', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_gateway_pg';
  const module = createCollaborationModule({ pg });
  const businessRef = { tenant_id: tenantId, type: 'service_order', id: 'order_gateway_1' };
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: 'Gateway support'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'meshcentral',
    started_by: 'agent_gateway'
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer_gateway',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });

  const meshGateway = {
    provider: 'meshcentral',
    external_id: 'mesh-node-1',
    launch_url: 'https://mesh.example/app/device/mesh-node-1',
    target: { type: 'device', id: 'device_led_1', display_name: 'LED controller' },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    metadata: { mesh_id: 'mesh-group-1' }
  } as const;
  const meshLaunch = module.remoteGateways.normalizeRemoteGatewaySession(meshGateway);
  const guacamoleLaunch = module.remoteGateways.normalizeRemoteGatewaySession({
    provider: 'guacamole',
    external_id: 'conn-1',
    launch_url: 'https://guac.example/#/client/conn-1',
    target: { type: 'connection', id: 'rdp-led-1' },
    permissions: ['view_screen']
  });
  const tool = await module.remote.startGatewayToolSession({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'agent_gateway',
    gateway: meshGateway
  });

  assert.equal(meshLaunch.provider, 'meshcentral');
  assert.equal(meshLaunch.metadata.gateway_provider, 'meshcentral');
  assert.equal(meshLaunch.metadata.target_id, 'device_led_1');
  assert.equal(guacamoleLaunch.provider, 'guacamole');
  assert.equal(guacamoleLaunch.metadata.target_type, 'connection');
  assert.equal(tool.provider, 'meshcentral');
  assert.equal(tool.launch_url, 'https://mesh.example/app/device/mesh-node-1');
  assert.equal(tool.metadata.gateway_provider, 'meshcentral');
  assert.deepEqual(tool.metadata.permissions, ['view_screen', 'control_mouse_keyboard']);
});

test('remote gateway adapters normalize RustDesk sessions for tool launch', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_rustdesk_gateway_pg';
  const module = createCollaborationModule({ pg });
  const businessRef = { tenant_id: tenantId, type: 'service_order', id: 'order_rustdesk_gateway_1' };
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: 'RustDesk gateway support'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'rustdesk',
    started_by: 'agent_rustdesk_gateway'
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer_rustdesk_gateway',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });

  const rustdeskGateway = {
    provider: 'rustdesk',
    external_id: 'rustdesk-session-1',
    launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
    target: { type: 'device', id: 'rustdesk-device-1', display_name: 'LED RustDesk controller' },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    metadata: { rustdesk_id: '123456789', id_server: 'rustdesk-id.example.com' }
  } as unknown as RemoteGatewaySessionInput;
  const rustdeskLaunch = module.remoteGateways.normalizeRemoteGatewaySession(rustdeskGateway);
  const tool = await module.remote.startGatewayToolSession({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'agent_rustdesk_gateway',
    gateway: rustdeskGateway
  });

  assert.equal(rustdeskLaunch.provider, 'rustdesk');
  assert.equal(rustdeskLaunch.metadata.gateway_provider, 'rustdesk');
  assert.equal(rustdeskLaunch.metadata.target_id, 'rustdesk-device-1');
  assert.equal(rustdeskLaunch.metadata.rustdesk_id, '123456789');
  assert.equal(tool.provider, 'rustdesk');
  assert.equal(tool.launch_url, 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z');
  assert.equal(tool.metadata.gateway_provider, 'rustdesk');
});

test('remote gateway client creates, audits, and releases external sessions', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_gateway_client_pg';
  const module = createCollaborationModule({ pg });
  const businessRef = { tenant_id: tenantId, type: 'service_order', id: 'order_gateway_client_1' };
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: 'Gateway client support'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'meshcentral',
    started_by: 'agent_gateway_client'
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer_gateway_client',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const client = module.remoteGateways.createInMemoryRemoteGatewayClient({
    provider: 'meshcentral',
    base_url: 'https://mesh.example'
  });

  const tool = await module.remote.startGatewayClientSession({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'agent_gateway_client',
    client,
    target: { type: 'device', id: 'device_led_2', display_name: 'LED controller 2' },
    permissions: ['view_screen', 'control_mouse_keyboard']
  });
  await client.appendAuditEvent({
    external_id: tool.external_id,
    event_type: 'gateway.input.mouse.click',
    actor_identity: 'agent_gateway_client',
    metadata: { x: 10, y: 20 }
  });
  const synced = await module.remote.syncGatewayAuditEvents({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'system',
    client,
    external_id: tool.external_id
  });
  const ended = await module.remote.endGatewayClientSession({
    tool_session_id: tool.id,
    actor_identity: 'agent_gateway_client',
    client
  });
  const auditEvents = await module.remote.listAuditEvents({
    tenant_id: tenantId,
    remote_session_id: remote.id
  });

  assert.equal(tool.provider, 'meshcentral');
  assert.equal(tool.metadata.gateway_provider, 'meshcentral');
  assert.equal(tool.metadata.target_id, 'device_led_2');
  assert.equal(tool.launch_url, 'https://mesh.example/remote/meshcentral/device/device_led_2');
  assert.equal(synced.length >= 2, true);
  assert.equal(ended?.status, 'ended');
  assert.equal(client.getSession(tool.external_id)?.status, 'ended');
  assert.equal(auditEvents.some((event) => event.event_type === 'remote.gateway_session.created'), true);
  assert.equal(auditEvents.some((event) => event.event_type === 'gateway.input.mouse.click'), true);
  assert.equal(auditEvents.some((event) => event.event_type === 'remote.gateway_session.ended'), true);
});

test('remote gateway sync rejects RustDesk audit events for another target', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_rustdesk_gateway_sync_target_pg';
  const module = createCollaborationModule({ pg });
  const businessRef = { tenant_id: tenantId, type: 'service_order', id: 'order_rustdesk_sync_target_1' };
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: 'RustDesk gateway target support'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'rustdesk',
    started_by: 'agent_rustdesk_sync_target'
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer_rustdesk_sync_target',
    scopes: ['view_screen', 'record_screen'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const gateway = {
    provider: 'rustdesk',
    external_id: 'rustdesk-sync-target-1',
    launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-sync-target-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
    target: { type: 'device', id: '123456789', display_name: 'LED RustDesk controller' },
    permissions: ['view_screen', 'record_screen'],
    metadata: { rustdesk_id: '123456789' }
  } as unknown as RemoteGatewaySessionInput;
  const tool = await module.remote.startGatewayToolSession({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'agent_rustdesk_sync_target',
    gateway
  });
  const client = new StaticRustDeskAuditClient([
    {
      external_id: tool.external_id,
      event_type: 'remote.rustdesk.recording.started',
      actor_identity: 'rustdesk-recorder',
      target: '987654321',
      metadata: {
        recording_id: 'egress-rustdesk-sync-target-mismatch',
        evidence_type: 'screen_recording'
      },
      occurred_at: '2026-07-03T01:00:00.000Z'
    }
  ]);

  await assert.rejects(
    () =>
      module.remote.syncGatewayAuditEvents({
        tenant_id: tenantId,
        remote_session_id: remote.id,
        actor_identity: 'system',
        client,
        external_id: tool.external_id
      }),
    /RustDesk gateway audit event target must match tool session target/
  );
  const auditEvents = await module.remote.listAuditEvents({
    tenant_id: tenantId,
    remote_session_id: remote.id
  });
  assert.equal(
    auditEvents.some((event) => event.event_type === 'remote.rustdesk.recording.started'),
    false
  );
});

test('remote gateway client session does not create upstream session before consent', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_gateway_no_consent_pg';
  const module = createCollaborationModule({ pg });
  const businessRef = { tenant_id: tenantId, type: 'service_order', id: 'order_gateway_no_consent_1' };
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: 'Gateway support without consent'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'meshcentral',
    started_by: 'agent_gateway_no_consent'
  });
  const client = new CountingRemoteGatewayClient();

  await assert.rejects(
    () =>
      module.remote.startGatewayClientSession({
        tenant_id: tenantId,
        remote_session_id: remote.id,
        actor_identity: 'agent_gateway_no_consent',
        client,
        target: { type: 'device', id: 'device_no_consent' },
        permissions: ['view_screen']
      }),
    /active consent required/
  );

  assert.equal(client.createCalls, 0);
});

test('remote gateway in-memory client creates and ends RustDesk sessions', async () => {
  const client = moduleFactory().remoteGateways.createInMemoryRemoteGatewayClient({
    provider: 'rustdesk',
    base_url: 'https://converact.example.com'
  });

  const descriptor = await client.createSession({
    target: { type: 'device', id: 'rustdesk-device-2', display_name: 'LED RustDesk controller 2' },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    actor_identity: 'agent_rustdesk_client',
    metadata: { rustdesk_id: '987654321' }
  });
  await client.endSession({
    external_id: descriptor.external_id,
    actor_identity: 'agent_rustdesk_client'
  });

  assert.equal(descriptor.provider, 'rustdesk');
  assert.equal(descriptor.launch_url, 'https://converact.example.com/remote/rustdesk/device/rustdesk-device-2');
  assert.equal(client.getSession(descriptor.external_id)?.status, 'ended');
});

test('remote gateway in-memory client rejects invalid lifecycle inputs', async () => {
  const client = moduleFactory().remoteGateways.createInMemoryRemoteGatewayClient({
    provider: 'rustdesk',
    base_url: 'https://converact.example.com'
  });
  const descriptor = await client.createSession({
    target: { type: 'device', id: 'rustdesk-device-invalid-inputs' },
    permissions: ['view_screen'],
    actor_identity: 'agent_rustdesk_client'
  });

  await assert.rejects(
    () => client.endSession({ external_id: '  ', actor_identity: 'agent_rustdesk_client' }),
    /external_id is required/
  );
  assert.equal(client.getSession(descriptor.external_id)?.status, 'active');

  await assert.rejects(
    () => client.endSession({ external_id: descriptor.external_id, actor_identity: '  ' }),
    /actor_identity is required/
  );
  assert.equal(client.getSession(descriptor.external_id)?.status, 'active');

  await assert.rejects(
    () => client.listAuditEvents({ external_id: '  ' }),
    /external_id is required/
  );

  await assert.rejects(
    () => client.listAuditEvents({ external_id: descriptor.external_id, since: 'not-a-date' }),
    /since must be an ISO timestamp/
  );
});

test('remote gateway in-memory client rejects invalid create inputs', async () => {
  const client = moduleFactory().remoteGateways.createInMemoryRemoteGatewayClient({
    provider: 'rustdesk',
    base_url: 'https://converact.example.com'
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '  ' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk_client'
      }),
    /target id is required/
  );
  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: 'rustdesk-device-invalid-create' },
        permissions: [],
        actor_identity: 'agent_rustdesk_client'
      }),
    /permissions required/
  );
  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: 'rustdesk-device-invalid-create' },
        permissions: ['view_screen'],
        actor_identity: '  '
      }),
    /actor_identity is required/
  );
});

test('MeshCentral HTTP gateway client maps remote sessions and audit events', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, init });
    if (requestUrl.endsWith('/api/opc/meshcentral/sessions') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          external_id: 'mesh-session-http-1',
          launch_url: 'https://mesh.example/app/device/device_http_1',
          metadata: { mesh_id: 'mesh-group-http' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl.includes('/api/opc/meshcentral/sessions/mesh-session-http-1/audit')) {
      return new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'meshcentral.desktop.connected',
              actor_identity: 'agent_http',
              target: 'mesh-session-http-1',
              metadata: { protocol: 'webrtc' },
              occurred_at: '2026-06-30T00:00:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl.endsWith('/api/opc/meshcentral/sessions/mesh-session-http-1') && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
  };
  const client = moduleFactory().remoteGateways.createMeshCentralGatewayClient({
    base_url: 'https://mesh.example/',
    api_token: 'mesh-token',
    fetch: fetchMock
  });

  const descriptor = await client.createSession({
    target: { type: 'device', id: 'device_http_1', display_name: 'HTTP LED controller' },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    actor_identity: 'agent_http',
    metadata: { tenant_id: 'tenant_http' }
  });
  const events = await client.listAuditEvents({
    external_id: descriptor.external_id,
    since: '2026-06-29T00:00:00.000Z'
  });
  await client.endSession({
    external_id: descriptor.external_id,
    actor_identity: 'agent_http'
  });

  assert.equal(descriptor.provider, 'meshcentral');
  assert.equal(descriptor.external_id, 'mesh-session-http-1');
  assert.equal(descriptor.launch_url, 'https://mesh.example/app/device/device_http_1');
  assert.equal(descriptor.metadata?.mesh_id, 'mesh-group-http');
  assert.equal(events[0]?.event_type, 'meshcentral.desktop.connected');
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, 'https://mesh.example/api/opc/meshcentral/sessions');
  assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>).authorization, 'Bearer mesh-token');
  assert.equal(
    JSON.parse(String(calls[0]?.init?.body)).target.id,
    'device_http_1'
  );
  assert.equal(
    calls[1]?.url,
    'https://mesh.example/api/opc/meshcentral/sessions/mesh-session-http-1/audit?since=2026-06-29T00%3A00%3A00.000Z'
  );
  assert.equal(calls[2]?.init?.method, 'DELETE');
});

test('MeshCentral HTTP gateway client surfaces upstream errors', async () => {
  const client = moduleFactory().remoteGateways.createMeshCentralGatewayClient({
    base_url: 'https://mesh.example',
    api_token: 'mesh-token',
    fetch: async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: 'device_denied' },
        permissions: ['view_screen'],
        actor_identity: 'agent_denied'
      }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 403);
      assert.match((error as Error).message, /MeshCentral gateway request failed/);
      return true;
    }
  );
});

test('Guacamole HTTP gateway client maps remote sessions and audit events', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, init });
    if (requestUrl.endsWith('/api/opc/guacamole/sessions') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          external_id: 'guac-session-http-1',
          launch_url: 'https://guac.example/#/client/conn-http-1',
          metadata: { connection_id: 'conn-http-1', protocol: 'rdp' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl.includes('/api/opc/guacamole/sessions/guac-session-http-1/audit')) {
      return new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'guacamole.tunnel.connected',
              actor_identity: 'agent_guac',
              target: 'guac-session-http-1',
              metadata: { protocol: 'rdp' },
              occurred_at: '2026-06-30T01:00:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl.endsWith('/api/opc/guacamole/sessions/guac-session-http-1') && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
  };
  const client = moduleFactory().remoteGateways.createGuacamoleGatewayClient({
    base_url: 'https://guac.example/',
    api_token: 'guac-token',
    fetch: fetchMock
  });

  const descriptor = await client.createSession({
    target: { type: 'connection', id: 'conn-http-1', display_name: 'RDP LED controller' },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    actor_identity: 'agent_guac',
    metadata: { tenant_id: 'tenant_guac_http' }
  });
  const events = await client.listAuditEvents({
    external_id: descriptor.external_id
  });
  await client.endSession({
    external_id: descriptor.external_id,
    actor_identity: 'agent_guac'
  });

  assert.equal(descriptor.provider, 'guacamole');
  assert.equal(descriptor.external_id, 'guac-session-http-1');
  assert.equal(descriptor.launch_url, 'https://guac.example/#/client/conn-http-1');
  assert.equal(descriptor.metadata?.connection_id, 'conn-http-1');
  assert.equal(events[0]?.event_type, 'guacamole.tunnel.connected');
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, 'https://guac.example/api/opc/guacamole/sessions');
  assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>).authorization, 'Bearer guac-token');
  assert.equal(
    JSON.parse(String(calls[0]?.init?.body)).target.type,
    'connection'
  );
  assert.equal(calls[1]?.url, 'https://guac.example/api/opc/guacamole/sessions/guac-session-http-1/audit');
  assert.equal(calls[2]?.init?.method, 'DELETE');
});

test('RustDesk HTTP gateway client maps remote sessions and audit events', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, init });
    if (requestUrl.endsWith('/api/opc/rustdesk/sessions') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          external_id: 'rustdesk-session-http-1',
          launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-http-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
          metadata: {
            rustdesk_id: '123456789',
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl.includes('/api/opc/rustdesk/sessions/rustdesk-session-http-1/audit')) {
      return new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'rustdesk.session.connected',
              actor_identity: 'agent_rustdesk',
              target: 'rustdesk-session-http-1',
              metadata: { rustdesk_id: '123456789' },
              occurred_at: '2026-07-03T00:00:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (requestUrl.endsWith('/api/opc/rustdesk/sessions/rustdesk-session-http-1') && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
  };
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: fetchMock
  });

  const descriptor = await client.createSession({
    target: { type: 'device', id: '123456789', display_name: 'RustDesk LED controller' },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    actor_identity: 'agent_rustdesk',
    metadata: { tenant_id: 'tenant_rustdesk_http' }
  });
  const events = await client.listAuditEvents({
    external_id: descriptor.external_id
  });
  await client.endSession({
    external_id: descriptor.external_id,
    actor_identity: 'agent_rustdesk'
  });

  assert.equal(descriptor.provider, 'rustdesk');
  assert.equal(descriptor.external_id, 'rustdesk-session-http-1');
  assert.equal(descriptor.launch_url, 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-http-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z');
  assert.equal(descriptor.metadata?.rustdesk_id, '123456789');
  assert.equal(events[0]?.event_type, 'rustdesk.session.connected');
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, 'https://converact.example.com/api/opc/rustdesk/sessions');
  assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>).authorization, 'Bearer rustdesk-token');
  assert.equal(
    JSON.parse(String(calls[0]?.init?.body)).target.id,
    '123456789'
  );
  assert.equal(calls[1]?.url, 'https://converact.example.com/api/opc/rustdesk/sessions/rustdesk-session-http-1/audit');
  assert.equal(calls[2]?.init?.method, 'DELETE');
});

test('RustDesk HTTP gateway client includes control-plane error details', async () => {
  const fetchMock = async (): Promise<Response> =>
    new Response(JSON.stringify({ error: 'permissions required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: fetchMock
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789', display_name: 'RustDesk LED controller' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk',
        metadata: { tenant_id: 'tenant_rustdesk_http_error' }
      }),
    /RustDesk gateway request failed: 400 permissions required/
  );
});

test('RustDesk HTTP gateway client rejects invalid gateway configuration', () => {
  assert.throws(
    () =>
      moduleFactory().remoteGateways.createRustDeskGatewayClient({
        base_url: '  ',
        api_token: 'rustdesk-token'
      }),
    /base_url is required/
  );
  assert.throws(
    () =>
      moduleFactory().remoteGateways.createRustDeskGatewayClient({
        base_url: 'not-a-url',
        api_token: 'rustdesk-token'
      }),
    /base_url must be http\(s\)/
  );
  assert.throws(
    () =>
      moduleFactory().remoteGateways.createRustDeskGatewayClient({
        base_url: 'https://converact.example.com',
        api_token: '  '
      }),
    /api_token is required/
  );
});

test('RustDesk HTTP gateway client rejects invalid create inputs before network calls', async () => {
  let requestCount = 0;
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ error: 'unexpected request' }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '  ' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk'
      }),
    /target id is required/
  );
  assert.equal(requestCount, 0);

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789' },
        permissions: [],
        actor_identity: 'agent_rustdesk'
      }),
    /permissions required/
  );
  assert.equal(requestCount, 0);

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        actor_identity: '  '
      }),
    /actor_identity is required/
  );
  assert.equal(requestCount, 0);
});

test('RustDesk HTTP gateway client rejects invalid lifecycle inputs before network calls', async () => {
  let requestCount = 0;
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ events: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await assert.rejects(
    () => client.endSession({ external_id: '  ', actor_identity: 'agent_rustdesk' }),
    /external_id is required/
  );
  assert.equal(requestCount, 0);

  await assert.rejects(
    () => client.endSession({ external_id: 'rustdesk-session-http-inputs', actor_identity: '  ' }),
    /actor_identity is required/
  );
  assert.equal(requestCount, 0);

  await assert.rejects(
    () => client.listAuditEvents({ external_id: '  ' }),
    /external_id is required/
  );
  assert.equal(requestCount, 0);

  await assert.rejects(
    () => client.listAuditEvents({ external_id: 'rustdesk-session-http-inputs', since: 'not-a-date' }),
    /since must be an ISO timestamp/
  );
  assert.equal(requestCount, 0);
});

test('RustDesk HTTP gateway client rejects incomplete create responses', async () => {
  const createClient = (body: Record<string, unknown>) =>
    moduleFactory().remoteGateways.createRustDeskGatewayClient({
      base_url: 'https://converact.example.com/',
      api_token: 'rustdesk-token',
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status: 201,
          headers: { 'content-type': 'application/json' }
        })
    });
  const input = {
    target: { type: 'device', id: '123456789', display_name: 'RustDesk LED controller' },
    permissions: ['view_screen'] as const,
    actor_identity: 'agent_rustdesk',
    metadata: { tenant_id: 'tenant_rustdesk_http_incomplete' }
  };

  await assert.rejects(
    () =>
      createClient({
        launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-http-incomplete'
      }).createSession(input),
    /RustDesk gateway response missing external_id/
  );
  await assert.rejects(
    () =>
      createClient({
        external_id: 'rustdesk-session-http-incomplete'
      }).createSession(input),
    /RustDesk gateway response missing launch_url/
  );
});

test('RustDesk HTTP gateway client rejects launch URLs without tokens', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          external_id: 'rustdesk-session-http-token-missing',
          launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-http-token-missing'
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' }
        }
      )
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk'
      }),
    /RustDesk gateway launch_url token is required/
  );
});

test('RustDesk HTTP gateway client rejects launch URLs without expiry timestamps', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          external_id: 'rustdesk-session-http-expiry-missing',
          launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-http-expiry-missing&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' }
        }
      )
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk'
      }),
    /RustDesk gateway launch_url expires_at is required/
  );
});

test('RustDesk HTTP gateway client rejects expired launch URLs', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          external_id: 'rustdesk-session-http-expired',
          launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-http-expired&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2000-01-01T00:00:00.000Z'
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' }
        }
      )
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk'
      }),
    /RustDesk gateway launch_url expires_at must be a future ISO timestamp/
  );
});

test('RustDesk HTTP gateway client rejects malformed launch tokens', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          external_id: 'rustdesk-session-http-token-malformed',
          launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-http-token-malformed&token=launch-token&expires_at=2099-01-01T00:00:00.000Z'
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' }
        }
      )
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk'
      }),
    /RustDesk gateway launch_url token must be a 64 character hex HMAC/
  );
});

test('RustDesk HTTP gateway client rejects launch URLs for another session', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          external_id: 'rustdesk-session-http-expected',
          launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-http-other&token=launch-token'
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' }
        }
      )
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk'
      }),
    /RustDesk gateway launch_url session_id must match external_id/
  );
});

test('RustDesk HTTP gateway client rejects launch URLs for the wrong path', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          external_id: 'rustdesk-session-http-wrong-path',
          launch_url: 'https://converact.example.com/remote/other/launch?session_id=rustdesk-session-http-wrong-path&token=launch-token'
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' }
        }
      )
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk'
      }),
    /RustDesk gateway launch_url path must be \/remote\/rustdesk\/launch/
  );
});

test('RustDesk HTTP gateway client rejects launch URLs without HTTP protocols', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          external_id: 'rustdesk-session-http-wrong-protocol',
          launch_url: 'ftp://converact.example.com/remote/rustdesk/launch?session_id=rustdesk-session-http-wrong-protocol&token=launch-token'
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' }
        }
      )
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk'
      }),
    /RustDesk gateway launch_url must be http\(s\)/
  );
});

test('RustDesk HTTP gateway client rejects malformed audit responses', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(JSON.stringify({ events: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  });

  await assert.rejects(
    () =>
      client.listAuditEvents({
        external_id: 'rustdesk-session-http-bad-audit'
      }),
    /RustDesk gateway audit response events must be an array/
  );
});

test('RustDesk HTTP gateway client rejects audit events without event types', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              actor_identity: 'agent_rustdesk',
              target: 'rustdesk-session-http-bad-event',
              metadata: { operation_id: 'op_1' },
              occurred_at: '2026-07-04T00:00:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  });

  await assert.rejects(
    () =>
      client.listAuditEvents({
        external_id: 'rustdesk-session-http-bad-event'
      }),
    /RustDesk gateway audit event missing event_type/
  );
});

test('RustDesk HTTP gateway client rejects audit events without timestamps', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'rustdesk.control.action',
              actor_identity: 'agent_rustdesk',
              target: 'rustdesk-session-http-bad-event',
              metadata: { operation_id: 'op_2' }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  });

  await assert.rejects(
    () =>
      client.listAuditEvents({
        external_id: 'rustdesk-session-http-bad-event'
      }),
    /RustDesk gateway audit event missing occurred_at/
  );
});

test('RustDesk HTTP gateway client rejects audit events without actors', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'rustdesk.control.action',
              target: 'rustdesk-session-http-bad-event',
              metadata: { operation_id: 'op_actor', action: 'click', permission: 'control_mouse_keyboard' },
              occurred_at: '2026-07-04T00:00:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  });

  await assert.rejects(
    () =>
      client.listAuditEvents({
        external_id: 'rustdesk-session-http-bad-event'
      }),
    /RustDesk gateway audit event missing actor_identity/
  );
});

test('RustDesk HTTP gateway client rejects audit events with invalid timestamps', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'rustdesk.control.action',
              actor_identity: 'agent_rustdesk',
              target: 'rustdesk-session-http-bad-event',
              metadata: { operation_id: 'op_2b' },
              occurred_at: 'not-a-date'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  });

  await assert.rejects(
    () =>
      client.listAuditEvents({
        external_id: 'rustdesk-session-http-bad-event'
      }),
    /RustDesk gateway audit event invalid occurred_at/
  );
});

test('RustDesk HTTP gateway client rejects audit events from another session', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              external_id: 'rustdesk-session-http-other',
              event_type: 'rustdesk.control.action',
              actor_identity: 'agent_rustdesk',
              target: 'rustdesk-session-http-other',
              metadata: { operation_id: 'op_other', action: 'click', permission: 'control_mouse_keyboard' },
              occurred_at: '2026-07-04T00:00:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  });

  await assert.rejects(
    () =>
      client.listAuditEvents({
        external_id: 'rustdesk-session-http-bad-event'
      }),
    /RustDesk gateway audit event external_id must match requested session/
  );
});

test('RustDesk HTTP gateway client rejects audit events with non-object metadata', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              event_type: 'rustdesk.control.action',
              actor_identity: 'agent_rustdesk',
              target: 'rustdesk-session-http-bad-event',
              metadata: ['operation_id', 'op_3'],
              occurred_at: '2026-07-04T00:00:00.000Z'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  });

  await assert.rejects(
    () =>
      client.listAuditEvents({
        external_id: 'rustdesk-session-http-bad-event'
      }),
    /RustDesk gateway audit event metadata must be an object/
  );
});

test('RustDesk HTTP gateway client rejects invalid JSON success responses', async () => {
  const client = moduleFactory().remoteGateways.createRustDeskGatewayClient({
    base_url: 'https://converact.example.com/',
    api_token: 'rustdesk-token',
    fetch: async () =>
      new Response('<html>gateway booting</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
  });

  await assert.rejects(
    () =>
      client.createSession({
        target: { type: 'device', id: '123456789', display_name: 'RustDesk LED controller' },
        permissions: ['view_screen'],
        actor_identity: 'agent_rustdesk',
        metadata: { tenant_id: 'tenant_rustdesk_http_invalid_json' }
      }),
    /RustDesk gateway response invalid JSON/
  );
});

test('Guacamole HTTP gateway client plugs into remote assistance workflow', async () => {
  const pg = new MemoryPg();
  const module = createCollaborationModule({ pg });
  const tenantId = 'tenant_guac_workflow';
  const businessRef = { tenant_id: tenantId, type: 'support_ticket', id: 'ticket_guac_workflow' };
  const session = await module.sessions.openSession({
    tenant_id: tenantId,
    business_ref: businessRef,
    title: 'Guacamole workflow'
  });
  const remote = await module.remote.createSession({
    tenant_id: tenantId,
    collaboration_session_id: session.id,
    business_ref: businessRef,
    mode: 'remote_desktop_gateway',
    adapter_provider: 'guacamole',
    started_by: 'agent_guac_workflow'
  });
  await module.remote.grantConsent({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'customer_guac_workflow',
    scopes: ['view_screen', 'control_mouse_keyboard'],
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const client = module.remoteGateways.createGuacamoleGatewayClient({
    base_url: 'https://guac.example',
    api_token: 'guac-token',
    fetch: async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/api/opc/guacamole/sessions') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            external_id: 'guac-workflow-1',
            launch_url: 'https://guac.example/#/client/guac-workflow-1',
            metadata: { protocol: 'rdp' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (requestUrl.endsWith('/api/opc/guacamole/sessions/guac-workflow-1/audit')) {
        return new Response(
          JSON.stringify({
            events: [
              {
                event_type: 'guacamole.clipboard.used',
                actor_identity: 'agent_guac_workflow',
                target: 'guac-workflow-1',
                metadata: { direction: 'write' },
                occurred_at: '2026-06-30T02:00:00.000Z'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (requestUrl.endsWith('/api/opc/guacamole/sessions/guac-workflow-1') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
    }
  });

  const tool = await module.remote.startGatewayClientSession({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'agent_guac_workflow',
    client,
    target: { type: 'connection', id: 'conn-guac-workflow' },
    permissions: ['view_screen', 'control_mouse_keyboard']
  });
  const synced = await module.remote.syncGatewayAuditEvents({
    tenant_id: tenantId,
    remote_session_id: remote.id,
    actor_identity: 'system',
    client,
    external_id: tool.external_id
  });
  const ended = await module.remote.endGatewayClientSession({
    tool_session_id: tool.id,
    actor_identity: 'agent_guac_workflow',
    client
  });

  assert.equal(tool.provider, 'guacamole');
  assert.equal(tool.launch_url, 'https://guac.example/#/client/guac-workflow-1');
  assert.equal(tool.metadata.gateway_provider, 'guacamole');
  assert.equal(synced.some((event) => event.event_type === 'guacamole.clipboard.used'), true);
  assert.equal(ended?.status, 'ended');
});

function moduleFactory() {
  return createCollaborationModule({ pg: new MemoryPg() });
}

class CountingRemoteGatewayClient implements RemoteGatewayClient {
  readonly provider = 'meshcentral';
  createCalls = 0;

  async createSession(input: RemoteGatewayCreateInput): Promise<RemoteGatewaySessionInput> {
    this.createCalls += 1;
    return {
      provider: this.provider,
      external_id: `counting-${this.createCalls}`,
      launch_url: `https://mesh.example/remote/${input.target.id}`,
      target: input.target,
      permissions: input.permissions,
      metadata: input.metadata
    };
  }

  async endSession(_input: RemoteGatewayEndInput): Promise<void> {}

  async listAuditEvents(): Promise<RemoteGatewayAuditEvent[]> {
    return [];
  }
}

class StaticRustDeskAuditClient implements RemoteGatewayClient {
  readonly provider = 'rustdesk';

  constructor(private readonly events: RemoteGatewayAuditEvent[]) {}

  async createSession(input: RemoteGatewayCreateInput): Promise<RemoteGatewaySessionInput> {
    return {
      provider: this.provider,
      external_id: 'static-rustdesk-session',
      launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=static-rustdesk-session&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
      target: input.target,
      permissions: input.permissions,
      metadata: input.metadata
    };
  }

  async endSession(_input: RemoteGatewayEndInput): Promise<void> {}

  async listAuditEvents(): Promise<RemoteGatewayAuditEvent[]> {
    return this.events;
  }
}
