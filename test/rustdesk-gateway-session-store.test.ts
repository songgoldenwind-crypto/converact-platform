import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { MemoryPg } from '../src/db-pg.js';

test('RustDeskGatewaySessionStore rejects empty and unsupported permission scopes', async () => {
  const store = new RustDeskGatewaySessionStore(new MemoryPg());
  const tenantId = 'tenant_rustdesk_store_permissions';

  await assert.rejects(
    () =>
      store.createSession({
        tenant_id: tenantId,
        target: { type: 'device', id: '123456789' },
        permissions: [],
        actor_identity: 'engineer_42',
        launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-store-permissions&token=launch-token'
      }),
    /permissions required/
  );

  await assert.rejects(
    () =>
      store.createSession({
        tenant_id: tenantId,
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen', 'root_shell' as 'view_screen'],
        actor_identity: 'engineer_42',
        launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-store-permissions&token=launch-token'
      }),
    /unsupported RustDesk permission scope: root_shell/
  );

  const sessions = await store.listSessions({ tenant_id: tenantId, status: 'active' });
  assert.deepEqual(sessions, []);
});

test('RustDeskGatewaySessionStore rejects invalid core session fields', async () => {
  const store = new RustDeskGatewaySessionStore(new MemoryPg());
  const tenantId = 'tenant_rustdesk_store_core_fields';
  const validInput: Parameters<RustDeskGatewaySessionStore['createSession']>[0] = {
    tenant_id: tenantId,
    target: { type: 'device', id: '123456789' },
    permissions: ['view_screen'],
    actor_identity: 'engineer_42',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-store-core&token=launch-token'
  };

  await assert.rejects(
    () => store.createSession({ ...validInput, tenant_id: '  ' }),
    /tenant_id is required/
  );
  await assert.rejects(
    () => store.createSession({ ...validInput, external_id: '  ' }),
    /external_id is required/
  );
  await assert.rejects(
    () => store.createSession({ ...validInput, target: { type: 'device', id: '  ' } }),
    /target id is required/
  );
  await assert.rejects(
    () => store.createSession({ ...validInput, actor_identity: '  ' }),
    /actor_identity is required/
  );
  await assert.rejects(
    () => store.createSession({ ...validInput, launch_url: 'rustdesk://123456789' }),
    /launch_url must be http\(s\)/
  );
  await assert.rejects(
    () => store.createSession({ ...validInput, launch_url: 'not-a-url' }),
    /launch_url must be http\(s\)/
  );

  const sessions = await store.listSessions({ tenant_id: tenantId, status: 'active' });
  assert.deepEqual(sessions, []);
});

test('RustDeskGatewaySessionStore recursively rejects secret-bearing metadata before persistence', async () => {
  const pg = new MemoryPg();
  const store = new RustDeskGatewaySessionStore(pg);
  const validInput: Parameters<RustDeskGatewaySessionStore['createSession']>[0] = {
    tenant_id: 'tenant_rustdesk_store_secret_boundary',
    target: { type: 'device', id: '123456789' },
    permissions: ['view_screen'],
    actor_identity: 'engineer_42',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-store-secret&token=launch-token'
  };
  const unsafeMetadata = [
    { nested: [{ unattended_password: 'do-not-store' }] },
    { Nested: { CredentialRef: 'secret://rustdesk/one' } },
    { provider: { clientsecretref: 'secret://rustdesk/two' } },
    { provider: { auth_token: 'do-not-store' } },
    { material: '-----BEGIN PRIVATE KEY-----\ndo-not-store\n-----END PRIVATE KEY-----' },
    { callback_url: 'https://operator:do-not-store@rustdesk.example.com/session' },
    { callback_url: 'https://rustdesk.example.com/session?access_token=do-not-store' }
  ];

  for (const metadata of unsafeMetadata) {
    await assert.rejects(
      () => store.createSession({ ...validInput, metadata }),
      /RustDesk gateway metadata contains sensitive material/
    );
  }

  const session = await store.createSession({
    ...validInput,
    metadata: { source: 'ivekit', site: 'showroom-7' }
  });
  await assert.rejects(
    () => store.appendAuditEvent({
      external_id: session.external_id,
      event_type: 'remote.rustdesk.smoke.probe',
      actor_identity: 'edge-agent',
      metadata: { nested: [{ launchToken: 'do-not-store' }] }
    }),
    /RustDesk gateway metadata contains sensitive material/
  );

  assert.equal(session.metadata.source, 'ivekit');
  assert.equal(session.metadata.site, 'showroom-7');
  assert.match(String(session.metadata.ivekit_native_session_id), /^[1-9][0-9]{0,18}$/);
  assert.equal((await store.listSessions({ tenant_id: validInput.tenant_id })).length, 1);
  assert.equal((await store.listAuditEvents({ external_id: session.external_id }))?.length, 1);
});

test('RustDeskGatewaySessionStore rejects invalid list session filters', async () => {
  const store = new RustDeskGatewaySessionStore(new MemoryPg());

  await assert.rejects(
    () => store.listSessions({ tenant_id: '  ' }),
    /tenant_id is required/
  );
  await assert.rejects(
    () => store.listSessions({ tenant_id: 'tenant_rustdesk_store_list', limit: 0 }),
    /limit must be an integer from 1 to 200/
  );
  await assert.rejects(
    () => store.listSessions({ tenant_id: 'tenant_rustdesk_store_list', limit: 201 }),
    /limit must be an integer from 1 to 200/
  );
  await assert.rejects(
    () => store.listSessions({ tenant_id: 'tenant_rustdesk_store_list', limit: Number.NaN }),
    /limit must be an integer from 1 to 200/
  );
});

test('RustDeskGatewaySessionStore rejects invalid lifecycle identifiers and actors', async () => {
  const store = new RustDeskGatewaySessionStore(new MemoryPg());
  const session = await store.createSession({
    tenant_id: 'tenant_rustdesk_store_lifecycle',
    target: { type: 'device', id: '123456789' },
    permissions: ['view_screen'],
    actor_identity: 'engineer_42',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-store-lifecycle&token=launch-token'
  });

  await assert.rejects(
    () => store.getSession('  '),
    /external_id is required/
  );
  await assert.rejects(
    () => store.endSession({ external_id: '  ', actor_identity: 'engineer_42' }),
    /external_id is required/
  );
  await assert.rejects(
    () => store.endSession({ external_id: session.external_id, actor_identity: '  ' }),
    /actor_identity is required/
  );
  await assert.rejects(
    () => store.listAuditEvents({ external_id: '  ' }),
    /external_id is required/
  );
  await assert.rejects(
    () =>
      store.appendAuditEvent({
        external_id: '  ',
        event_type: 'remote.rustdesk.smoke.probe',
        actor_identity: 'engineer_42'
      }),
    /external_id is required/
  );
  await assert.rejects(
    () =>
      store.appendAuditEvent({
        external_id: session.external_id,
        event_type: '  ',
        actor_identity: 'engineer_42'
      }),
    /event_type is required/
  );
  await assert.rejects(
    () =>
      store.appendAuditEvent({
        external_id: session.external_id,
        event_type: 'remote.rustdesk.smoke.probe',
        actor_identity: '  '
      }),
    /actor_identity is required/
  );

  const events = await store.listAuditEvents({ external_id: session.external_id });
  assert.equal(events?.length, 1);
  assert.equal(events?.[0]?.event_type, 'remote.gateway_session.created');
});

test('RustDeskGatewaySessionStore rejects known operation events with incomplete metadata', async () => {
  const store = new RustDeskGatewaySessionStore(new MemoryPg());
  const session = await store.createSession({
    tenant_id: 'tenant_rustdesk_store_event_metadata',
    target: { type: 'device', id: '123456789' },
    permissions: ['view_screen', 'record_screen', 'transfer_file', 'clipboard'],
    actor_identity: 'engineer_42',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-store-event-metadata&token=launch-token'
  });

  await assert.rejects(
    () =>
      store.appendAuditEvent({
        external_id: session.external_id,
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: 'rustdesk-recorder',
        metadata: { evidence_type: 'screen_recording' }
      }),
    /RustDesk recording event metadata.recording_id is required/
  );

  const events = await store.listAuditEvents({ external_id: session.external_id });
  assert.equal(events?.length, 1);
  assert.equal(events?.[0]?.event_type, 'remote.gateway_session.created');
});

test('RustDeskGatewaySessionStore rejects known operation events with invalid metadata values', async () => {
  const store = new RustDeskGatewaySessionStore(new MemoryPg());
  const session = await store.createSession({
    tenant_id: 'tenant_rustdesk_store_event_metadata_values',
    target: { type: 'device', id: '123456789' },
    permissions: ['view_screen', 'record_screen', 'transfer_file', 'clipboard'],
    actor_identity: 'engineer_42',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-store-event-metadata-values&token=launch-token'
  });

  await assert.rejects(
    () =>
      store.appendAuditEvent({
        external_id: session.external_id,
        event_type: 'remote.rustdesk.clipboard.synced',
        actor_identity: 'rustdesk-clipboard-agent',
        metadata: { clipboard_id: 'clipboard-invalid-direction', direction: 'sideways' }
      }),
    /RustDesk clipboard event metadata.direction must be one of agent_to_device, device_to_agent/
  );

  await assert.rejects(
    () =>
      store.appendAuditEvent({
        external_id: session.external_id,
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: 'rustdesk-recorder',
        metadata: { recording_id: 'recording-invalid-evidence', evidence_type: 'video_file' }
      }),
    /RustDesk recording event metadata.evidence_type must be one of screen_recording/
  );

  await assert.rejects(
    () =>
      store.appendAuditEvent({
        external_id: session.external_id,
        event_type: 'remote.rustdesk.file_transfer.started',
        actor_identity: 'rustdesk-file-agent',
        metadata: { transfer_id: 'transfer-invalid-direction', direction: 'sideways' }
      }),
    /RustDesk file transfer event metadata.direction must be one of upload, download/
  );

  const events = await store.listAuditEvents({ external_id: session.external_id });
  assert.equal(events?.length, 1);
  assert.equal(events?.[0]?.event_type, 'remote.gateway_session.created');
});

test('RustDeskGatewaySessionStore rejects events targeting another RustDesk device', async () => {
  const store = new RustDeskGatewaySessionStore(new MemoryPg());
  const session = await store.createSession({
    tenant_id: 'tenant_rustdesk_store_event_target',
    target: { type: 'device', id: '123456789' },
    permissions: ['view_screen', 'record_screen'],
    actor_identity: 'engineer_42',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-store-event-target&token=launch-token'
  });

  await assert.rejects(
    () =>
      store.appendAuditEvent({
        external_id: session.external_id,
        event_type: 'remote.rustdesk.recording.started',
        actor_identity: 'rustdesk-recorder',
        target: '987654321',
        metadata: {
          recording_id: 'egress-target-mismatch',
          evidence_type: 'screen_recording'
        }
      }),
    /RustDesk event target must match gateway session target/
  );

  const events = await store.listAuditEvents({ external_id: session.external_id });
  assert.equal(events?.length, 1);
  assert.equal(events?.[0]?.event_type, 'remote.gateway_session.created');
});

test('RustDeskGatewaySessionStore accepts the runtime RustDesk id recorded on the session', async () => {
  const store = new RustDeskGatewaySessionStore(new MemoryPg());
  const session = await store.createSession({
    tenant_id: 'tenant_rustdesk_store_event_runtime_target',
    target: { type: 'device', id: 'device-inventory-1' },
    permissions: ['view_screen', 'record_screen'],
    actor_identity: 'engineer_42',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw-store-event-runtime-target&token=launch-token',
    metadata: {
      rustdesk_id: '123456789',
      target_id: 'device-inventory-1'
    }
  });

  const event = await store.appendAuditEvent({
    external_id: session.external_id,
    event_type: 'remote.rustdesk.recording.started',
    actor_identity: 'rustdesk-recorder',
    target: '123456789',
    metadata: {
      recording_id: 'egress-runtime-target',
      evidence_type: 'screen_recording'
    }
  });

  assert.equal(event?.target, '123456789');
});
