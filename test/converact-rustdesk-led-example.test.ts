import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { ConveractFabricRustDeskHttpClient } from '../src/agent-runtime/converact/index.js';
import {
  createConveractFabricRustDeskLedExampleConfigFromEnv,
  runConveractFabricRustDeskLedExample
} from '../scripts/converact-rustdesk-led-example.js';

test('Converact Fabric RustDesk LED example config maps focused env and defaults', () => {
  const config = createConveractFabricRustDeskLedExampleConfigFromEnv({
    CONVERACT_RUSTDESK_LED_EXAMPLE_BASE_URL: 'https://converact.example.com/',
    CONVERACT_RUSTDESK_LED_EXAMPLE_API_KEY: 'led-api-key',
    CONVERACT_RUSTDESK_LED_EXAMPLE_TENANT_ID: 'tenant_led',
    CONVERACT_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID: 'remote_led_1',
    CONVERACT_RUSTDESK_LED_EXAMPLE_RUSTDESK_ID: '987654321',
    CONVERACT_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_TYPE: 'led_order',
    CONVERACT_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_ID: 'LED-1',
    CONVERACT_RUSTDESK_LED_EXAMPLE_DEVICE_DISPLAY_NAME: 'LED controller',
    CONVERACT_RUSTDESK_LED_EXAMPLE_ACTOR_IDENTITY: 'agent_led',
    CONVERACT_RUSTDESK_LED_EXAMPLE_PERMISSIONS: 'view_screen,control_mouse_keyboard,clipboard',
    CONVERACT_RUSTDESK_LED_EXAMPLE_POST_AUDIT_PROBE: '1',
    CONVERACT_RUSTDESK_LED_EXAMPLE_END_SESSION: '1'
  });

  assert.equal(config.baseUrl, 'https://converact.example.com');
  assert.equal(config.apiKey, 'led-api-key');
  assert.equal(config.tenantId, 'tenant_led');
  assert.equal(config.remoteSessionId, 'remote_led_1');
  assert.equal(config.rustdeskId, '987654321');
  assert.equal(config.businessRef.type, 'led_order');
  assert.equal(config.businessRef.id, 'LED-1');
  assert.equal(config.deviceDisplayName, 'LED controller');
  assert.equal(config.actorIdentity, 'agent_led');
  assert.deepEqual(config.permissions, ['view_screen', 'control_mouse_keyboard', 'clipboard']);
  assert.equal(config.postAuditProbe, true);
  assert.equal(config.endSession, true);
});

test('Converact Fabric RustDesk LED example accepts the current shared Fabric env', () => {
  const config = createConveractFabricRustDeskLedExampleConfigFromEnv({
    CONVERACT_RUSTDESK_FABRIC_BASE_URL: 'https://fabric.converact.example.com/',
    CONVERACT_RUSTDESK_FABRIC_API_KEY: 'fabric-api-key',
    CONVERACT_RUSTDESK_FABRIC_TENANT_ID: 'tenant_fabric',
    CONVERACT_RUSTDESK_FABRIC_REMOTE_SESSION_ID: 'remote_fabric_1',
    CONVERACT_RUSTDESK_FABRIC_RUSTDESK_ID: '123456789',
    CONVERACT_RUSTDESK_FABRIC_CONSENT_SCOPES: 'view_screen',
  });

  assert.equal(config.baseUrl, 'https://fabric.converact.example.com');
  assert.equal(config.apiKey, 'fabric-api-key');
  assert.equal(config.tenantId, 'tenant_fabric');
  assert.equal(config.remoteSessionId, 'remote_fabric_1');
  assert.equal(config.rustdeskId, '123456789');
  assert.deepEqual(config.permissions, ['view_screen']);
});

test('Converact Fabric RustDesk LED example registers a RustDesk runtime id and leaves launch active by default', async () => {
  const calls: string[] = [];
  const client = fakeClient(calls);

  const result = await runConveractFabricRustDeskLedExample({
    baseUrl: 'https://converact.example.com',
    apiKey: 'led-api-key',
    tenantId: 'tenant_led',
    remoteSessionId: 'remote_led_1',
    rustdeskId: '987654321',
    businessRef: { type: 'service_order', id: 'SO-1', display_name: 'SO-1' },
    deviceDisplayName: 'LED controller',
    actorIdentity: 'agent_led',
    permissions: ['view_screen', 'control_mouse_keyboard'],
    postAuditProbe: false,
    endSession: false
  }, client);

  assert.deepEqual(calls, [
    'getClientConfig',
    'registerDevice:987654321',
    'heartbeatDevice:rdesk_1:online',
    'startGatewaySession:remote_led_1:rdesk_1',
    'getGatewayLaunchPlan:rdgw_1',
    'listGatewayAuditEvents:rdgw_1'
  ]);
  assert.equal(result.deviceId, 'rdesk_1');
  assert.equal(result.externalId, 'rdgw_1');
  assert.equal(result.launchUrl, 'https://converact.example.com/remote/rustdesk/launch?session_id=rdgw_1&token=abc&expires_at=2026-07-06T00%3A15%3A00.000Z');
  assert.equal(result.protocolUrl, 'rustdesk://connect/987654321?session=rdgw_1');
  assert.equal(result.auditEvents, 1);
  assert.equal(result.auditProbePosted, false);
  assert.equal(result.ended, false);
});

test('Converact Fabric RustDesk LED example can reuse a registered device, post an audit probe, and end session', async () => {
  const calls: string[] = [];
  const client = fakeClient(calls);

  const result = await runConveractFabricRustDeskLedExample({
    baseUrl: 'https://converact.example.com',
    apiKey: 'led-api-key',
    tenantId: 'tenant_led',
    remoteSessionId: 'remote_led_1',
    deviceId: 'rdesk_existing',
    businessRef: { type: 'service_order', id: 'SO-1' },
    deviceDisplayName: 'LED controller',
    actorIdentity: 'agent_led',
    permissions: ['view_screen', 'control_mouse_keyboard', 'clipboard'],
    postAuditProbe: true,
    endSession: true
  }, client);

  assert.deepEqual(calls, [
    'getClientConfig',
    'getDevice:rdesk_existing',
    'heartbeatDevice:rdesk_existing:online',
    'startGatewaySession:remote_led_1:rdesk_existing',
    'getGatewayLaunchPlan:rdgw_1',
    'recordGatewayEvent:rdgw_1:remote.rustdesk.control_action.performed',
    'listGatewayAuditEvents:rdgw_1',
    'endGatewaySession:rdgw_1'
  ]);
  assert.equal(result.deviceId, 'rdesk_existing');
  assert.equal(result.auditProbePosted, true);
  assert.equal(result.ended, true);
});

test('Converact Fabric RustDesk LED example is exposed as a runnable handoff script with env samples', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['rustdesk:led-example'], 'tsx scripts/converact-rustdesk-led-example.ts');

  const rootEnv = readFileSync('.env.example', 'utf8');
  assert.match(rootEnv, /CONVERACT_RUSTDESK_LED_EXAMPLE_BASE_URL=/);
  assert.match(rootEnv, /CONVERACT_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID=/);
  assert.match(rootEnv, /CONVERACT_RUSTDESK_LED_EXAMPLE_DEVICE_ID=/);

  const productionEnv = readFileSync('infra/env.example', 'utf8');
  assert.match(productionEnv, /CONVERACT_RUSTDESK_LED_EXAMPLE_BASE_URL=/);
  assert.match(productionEnv, /CONVERACT_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID=/);
  assert.match(productionEnv, /CONVERACT_RUSTDESK_LED_EXAMPLE_DEVICE_ID=/);
});

function fakeClient(calls: string[]): ConveractFabricRustDeskHttpClient {
  return {
    async getClientProfile() {
      throw new Error('not used');
    },
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
      return {
        id: 'rdesk_1',
        tenant_id: 'tenant_led',
        business_ref_type: input.business_ref.type,
        business_ref_id: input.business_ref.id,
        rustdesk_id: input.rustdesk_id,
        display_name: input.display_name,
        status: 'active',
        runtime_status: 'online',
        last_seen_at: '2026-07-06T00:00:00.000Z',
        last_seen_actor: 'agent_led',
        metadata: {},
        created_at: '2026-07-06T00:00:00.000Z',
        updated_at: '2026-07-06T00:00:00.000Z',
        deactivated_at: null
      };
    },
    async getDevice(deviceId) {
      calls.push(`getDevice:${deviceId}`);
      return {
        id: deviceId,
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
        deactivated_at: null
      };
    },
    async listDevicesByBusinessRef() {
      return [];
    },
    async heartbeatDevice(deviceId, input) {
      calls.push(`heartbeatDevice:${deviceId}:${input.runtime_status}`);
      return {
        id: deviceId,
        tenant_id: 'tenant_led',
        business_ref_type: 'service_order',
        business_ref_id: 'SO-1',
        rustdesk_id: '987654321',
        display_name: 'LED controller',
        status: 'active',
        runtime_status: input.runtime_status || 'online',
        last_seen_at: '2026-07-06T00:00:00.000Z',
        last_seen_actor: input.actor_identity,
        metadata: {},
        created_at: '2026-07-06T00:00:00.000Z',
        updated_at: '2026-07-06T00:00:00.000Z',
        deactivated_at: null
      };
    },
    async deactivateDevice() {
      throw new Error('not used by LED example');
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
        launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rdgw_1&token=abc&expires_at=2026-07-06T00%3A15%3A00.000Z',
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
        launch_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rdgw_1&token=abc&expires_at=2026-07-06T00%3A15%3A00.000Z',
        target: { id: '987654321', type: 'device', display_name: 'LED controller' },
        permissions: ['view_screen', 'control_mouse_keyboard', 'clipboard'],
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
          open_url: 'https://converact.example.com/remote/rustdesk/launch?session_id=rdgw_1&token=abc&expires_at=2026-07-06T00%3A15%3A00.000Z',
          protocol_url: 'rustdesk://connect/987654321?session=rdgw_1'
        },
        metadata: {},
        created_at: '2026-07-06T00:00:00.000Z',
        ended_at: null
      };
    },
    async recordGatewayEvent(externalId, input) {
      calls.push(`recordGatewayEvent:${externalId}:${input.event_type}`);
      return {
        id: 'evt_probe',
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
        id: 'evt_created',
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
    async authorizeEmergencyFallback() {
      throw new Error('not used by LED example');
    },
    async getGatewayDisconnectState(externalId) {
      calls.push(`getGatewayDisconnectState:${externalId}`);
      return {
        required: true,
        status: 'unavailable',
        command: null
      };
    }
  };
}
