import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  IveKitRustDeskHttpClient,
  RecordIveKitRustDeskGatewayEventInput,
  RegisterIveKitRustDeskDeviceInput
} from '../src/agent-runtime/ivekit/index.js';
import type { RustDeskDevice } from '../src/agent-runtime/collaboration/rustdesk-device-store.js';
import {
  createIveKitRustDeskLedSdk
} from '../src/agent-runtime/ivekit/index.js';

test('iveKit RustDesk LED SDK reuses a registered device and starts a launchable session', async () => {
  const calls: string[] = [];
  const sdk = createIveKitRustDeskLedSdk({
    tenantId: 'tenant_led',
    client: fakeLedClient(calls, {
      devicesByRef: [rustDeskDevice({ id: 'rdesk_existing', rustdesk_id: '987654321' })]
    })
  });

  const result = await sdk.startSession({
    remoteSessionId: 'remote_led_1',
    rustdeskId: '987654321',
    businessRef: { type: 'service_order', id: 'SO-1', display_name: 'SO-1' },
    deviceDisplayName: 'LED controller',
    actorIdentity: 'agent_led',
    permissions: ['view_screen', 'control_mouse_keyboard'],
    metadata: { source: 'led-service' }
  });

  assert.deepEqual(calls, [
    'getClientConfig',
    'listDevicesByBusinessRef:service_order:SO-1',
    'heartbeatDevice:rdesk_existing:online',
    'startGatewaySession:remote_led_1:rdesk_existing',
    'getGatewayLaunchPlan:rdgw_1'
  ]);
  assert.equal(result.device.id, 'rdesk_existing');
  assert.equal(result.gatewaySession.external_id, 'rdgw_1');
  assert.equal(result.launch.openUrl, 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_1&token=abc&expires_at=2026-07-06T00%3A15%3A00.000Z');
  assert.equal(result.launch.protocolUrl, 'rustdesk://connect/987654321?session=rdgw_1');
  assert.equal(result.clientConfig.manual_fields.key, 'public-key');
});

test('iveKit RustDesk LED SDK registers a device when no matching business device exists', async () => {
  const calls: string[] = [];
  const registered: RegisterIveKitRustDeskDeviceInput[] = [];
  const sdk = createIveKitRustDeskLedSdk({
    tenantId: 'tenant_led',
    source: 'led-sdk-test',
    client: fakeLedClient(calls, { devicesByRef: [], registered })
  });

  const device = await sdk.ensureDevice({
    rustdeskId: '123456789',
    businessRef: { type: 'service_order', id: 'SO-2' },
    deviceDisplayName: 'LED controller 2',
    actorIdentity: 'agent_led'
  });

  assert.deepEqual(calls, [
    'listDevicesByBusinessRef:service_order:SO-2',
    'registerDevice:123456789',
    'heartbeatDevice:rdesk_1:online'
  ]);
  assert.equal(device.id, 'rdesk_1');
  assert.deepEqual(registered[0].business_ref, {
    tenant_id: 'tenant_led',
    type: 'service_order',
    id: 'SO-2',
    metadata: { source: 'led-sdk-test' }
  });
  assert.deepEqual(registered[0].metadata, { source: 'led-sdk-test' });
});

test('iveKit RustDesk LED SDK exposes audit and end helpers', async () => {
  const calls: string[] = [];
  const sdk = createIveKitRustDeskLedSdk({
    tenantId: 'tenant_led',
    client: fakeLedClient(calls)
  });

  await sdk.recordGatewayEvent('rdgw_1', {
    event_type: 'remote.rustdesk.clipboard.synced',
    actor_identity: 'agent_led',
    target: '987654321',
    metadata: {
      clipboard_id: 'clip_1',
      direction: 'agent_to_device'
    }
  });
  const events = await sdk.listGatewayAuditEvents('rdgw_1');
  await sdk.endGatewaySession('rdgw_1', { actor_identity: 'agent_led' });
  const disconnectState = await sdk.getGatewayDisconnectState('rdgw_1');

  assert.deepEqual(calls, [
    'recordGatewayEvent:rdgw_1:remote.rustdesk.clipboard.synced',
    'listGatewayAuditEvents:rdgw_1',
    'endGatewaySession:rdgw_1',
    'getGatewayDisconnectState:rdgw_1'
  ]);
  assert.equal(events.length, 1);
  assert.equal(disconnectState.status, 'pending');
  assert.equal(disconnectState.command?.id, 'rdcmd_1');
});

test('iveKit RustDesk LED SDK standardizes typed operation audit helpers', async () => {
  const calls: string[] = [];
  const events: RecordIveKitRustDeskGatewayEventInput[] = [];
  const sdk = createIveKitRustDeskLedSdk({
    tenantId: 'tenant_led',
    client: fakeLedClient(calls, { events })
  });

  await sdk.recordControlAction('rdgw_1', {
    actorIdentity: 'agent_led',
    target: '987654321',
    operationId: 'op_mouse_1',
    action: 'mouse.click',
    permission: 'control_mouse_keyboard'
  });
  await sdk.recordFileTransfer('rdgw_1', {
    actorIdentity: 'agent_led',
    target: '987654321',
    transferId: 'file_1',
    status: 'completed',
    direction: 'upload',
    fileName: 'playlist.json',
    fileSizeBytes: 2048
  });
  await sdk.recordScreenRecording('rdgw_1', {
    actorIdentity: 'agent_led',
    target: '987654321',
    recordingId: 'rec_1',
    status: 'stopped',
    storageUrl: 's3://opc-rustdesk/tenant_led/rec_1.mp4',
    durationMs: 1200
  });
  await sdk.recordClipboardSync('rdgw_1', {
    actorIdentity: 'agent_led',
    target: '987654321',
    clipboardId: 'clip_1',
    direction: 'agent_to_device',
    contentKind: 'text'
  });

  assert.deepEqual(calls, [
    'recordGatewayEvent:rdgw_1:remote.rustdesk.control_action.performed',
    'recordGatewayEvent:rdgw_1:remote.rustdesk.file_transfer.completed',
    'recordGatewayEvent:rdgw_1:remote.rustdesk.recording.stopped',
    'recordGatewayEvent:rdgw_1:remote.rustdesk.clipboard.synced'
  ]);
  assert.deepEqual(events.map((event) => event.idempotency_key), [
    'rustdesk-control:op_mouse_1',
    'rustdesk-file-transfer:file_1:completed',
    'rustdesk-recording:rec_1:stopped',
    'rustdesk-clipboard:clip_1:agent_to_device'
  ]);
  assert.deepEqual(events.map((event) => event.metadata), [
    {
      operation_id: 'op_mouse_1',
      action: 'mouse.click',
      permission: 'control_mouse_keyboard'
    },
    {
      transfer_id: 'file_1',
      direction: 'upload',
      file_name: 'playlist.json',
      file_size_bytes: 2048
    },
    {
      recording_id: 'rec_1',
      evidence_type: 'screen_recording',
      storage_url: 's3://opc-rustdesk/tenant_led/rec_1.mp4',
      duration_ms: 1200
    },
    {
      clipboard_id: 'clip_1',
      direction: 'agent_to_device',
      content_kind: 'text'
    }
  ]);
});

function fakeLedClient(
  calls: string[],
  options: {
    devicesByRef?: RustDeskDevice[];
    registered?: RegisterIveKitRustDeskDeviceInput[];
    events?: RecordIveKitRustDeskGatewayEventInput[];
  } = {}
): IveKitRustDeskHttpClient {
  return {
    async getClientConfig() {
      calls.push('getClientConfig');
      return {
        provider: 'rustdesk',
        id_server: 'rustdesk.example.com',
        relay_server: 'rustdesk.example.com',
        api_server: '',
        public_key: 'public-key',
        public_key_source: 'env',
        public_key_file: '',
        public_key_configured: true,
        server_key_fingerprint: 'sha256:abc',
        manual_fields: {
          id_server: 'rustdesk.example.com',
          relay_server: 'rustdesk.example.com',
          key: 'public-key'
        }
      };
    },
    async registerDevice(input) {
      calls.push(`registerDevice:${input.rustdesk_id}`);
      options.registered?.push(input);
      return rustDeskDevice({
        id: 'rdesk_1',
        rustdesk_id: input.rustdesk_id,
        business_ref_type: input.business_ref.type,
        business_ref_id: input.business_ref.id,
        display_name: input.display_name
      });
    },
    async getDevice(deviceId) {
      calls.push(`getDevice:${deviceId}`);
      return rustDeskDevice({ id: deviceId, rustdesk_id: '987654321' });
    },
    async listDevicesByBusinessRef(input) {
      calls.push(`listDevicesByBusinessRef:${input.business_ref.type}:${input.business_ref.id}`);
      return options.devicesByRef || [];
    },
    async heartbeatDevice(deviceId, input) {
      calls.push(`heartbeatDevice:${deviceId}:${input.runtime_status}`);
      return rustDeskDevice({ id: deviceId, rustdesk_id: '987654321', runtime_status: input.runtime_status || 'online' });
    },
    async deactivateDevice() {
      throw new Error('not used by LED SDK');
    },
    async startGatewaySession(input) {
      calls.push(`startGatewaySession:${input.remote_session_id}:${input.device_id}`);
      return {
        id: 'tool_1',
        tenant_id: 'tenant_led',
        remote_session_id: input.remote_session_id,
        provider: 'rustdesk',
        tool_type: 'remote_desktop_gateway',
        status: 'active',
        external_id: 'rdgw_1',
        launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_1&token=abc&expires_at=2026-07-06T00%3A15%3A00.000Z',
        metadata: {},
        started_by: 'agent_led',
        started_at: '2026-07-06T00:00:00.000Z',
        ended_at: null,
        created_at: '2026-07-06T00:00:00.000Z',
        updated_at: '2026-07-06T00:00:00.000Z'
      };
    },
    async getGatewayLaunchPlan(externalId) {
      calls.push(`getGatewayLaunchPlan:${externalId}`);
      return {
        external_id: externalId,
        status: 'active',
        launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_1&token=abc&expires_at=2026-07-06T00%3A15%3A00.000Z',
        target: { id: '987654321', type: 'device', display_name: 'LED controller' },
        permissions: ['view_screen', 'control_mouse_keyboard'],
        runtime: {
          rustdesk_id: '987654321',
          id_server: 'rustdesk.example.com',
          relay_server: 'rustdesk.example.com',
          api_server: '',
          public_key_configured: 'true',
          public_key_source: 'env',
          server_key_fingerprint: 'sha256:abc'
        },
        client_config: {
          id_server: 'rustdesk.example.com',
          relay_server: 'rustdesk.example.com',
          public_key: 'public-key',
          public_key_configured: true,
          public_key_source: 'env',
          server_key_fingerprint: 'sha256:abc',
          manual_fields: {
            id_server: 'rustdesk.example.com',
            relay_server: 'rustdesk.example.com',
            key: 'public-key'
          }
        },
        actions: {
          can_launch: true,
          open_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_1&token=abc&expires_at=2026-07-06T00%3A15%3A00.000Z',
          protocol_url: 'rustdesk://connect/987654321?session=rdgw_1'
        },
        metadata: {},
        created_at: '2026-07-06T00:00:00.000Z',
        ended_at: null
      };
    },
    async recordGatewayEvent(externalId, input) {
      calls.push(`recordGatewayEvent:${externalId}:${input.event_type}`);
      options.events?.push(input);
      return {
        id: 'evt_1',
        external_id: externalId,
        event_type: input.event_type,
        actor_identity: input.actor_identity,
        target: input.target || '',
        metadata: input.metadata || {},
        occurred_at: '2026-07-06T00:00:00.000Z'
      };
    },
    async listGatewayAuditEvents(externalId) {
      calls.push(`listGatewayAuditEvents:${externalId}`);
      return [{
        id: 'evt_1',
        external_id: externalId,
        event_type: 'remote.gateway_session.created',
        actor_identity: 'agent_led',
        target: '987654321',
        metadata: {},
        occurred_at: '2026-07-06T00:00:00.000Z'
      }];
    },
    async endGatewaySession(externalId) {
      calls.push(`endGatewaySession:${externalId}`);
    },
    async getGatewayDisconnectState(externalId) {
      calls.push(`getGatewayDisconnectState:${externalId}`);
      return {
        required: true,
        status: 'pending',
        command: {
          id: 'rdcmd_1',
          tenant_id: 'tenant_led',
          device_id: 'rdesk_1',
          external_id: externalId,
          command_type: 'disconnect_session',
          status: 'pending',
          requested_by: 'agent_led',
          requested_reason: 'gateway_ended',
          attempt_count: 0,
          max_attempts: 3,
          claimed_by: '',
          lease_expires_at: null,
          next_attempt_at: null,
          execution_method: null,
          exit_code: null,
          duration_ms: null,
          stdout_bytes: null,
          stderr_bytes: null,
          stdout_sha256: '',
          stderr_sha256: '',
          result_metadata: {},
          requested_at: '2026-07-06T00:00:00.000Z',
          started_at: null,
          completed_at: null,
          updated_at: '2026-07-06T00:00:00.000Z'
        }
      };
    }
  };
}

function rustDeskDevice(overrides: Partial<RustDeskDevice> = {}): RustDeskDevice {
  return {
    id: 'rdesk_1',
    tenant_id: 'tenant_led',
    business_ref_type: 'service_order',
    business_ref_id: 'SO-1',
    rustdesk_id: '987654321',
    display_name: 'LED controller',
    status: 'active',
    runtime_status: 'online',
    last_seen_at: '2026-07-06T00:00:00.000Z',
    last_seen_actor: 'agent_led',
    metadata: {},
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    deactivated_at: null,
    ...overrides
  };
}
