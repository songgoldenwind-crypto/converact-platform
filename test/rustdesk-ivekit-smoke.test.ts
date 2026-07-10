import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createRustDeskIveKitSmokeConfigFromEnv,
  runRustDeskIveKitSmoke
} from '../scripts/rustdesk-ivekit-smoke.js';

const RUSTDESK_IVEKIT_SMOKE_SCOPES = [
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
];

test('rustdesk iveKit smoke config validates the LED facade inputs', () => {
  const config = createRustDeskIveKitSmokeConfigFromEnv({
    OPC_BASE_URL: 'https://opc.example.com/',
    OPC_API_KEY: 'opc-api-key',
    OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789'
  });

  assert.equal(config.baseUrl, 'https://opc.example.com');
  assert.equal(config.apiKey, 'opc-api-key');
  assert.equal(config.tenantId, 'tenant_led');
  assert.equal(config.rustdeskId, '123456789');
  assert.equal(config.businessRefType, 'service_order');
  assert.deepEqual(config.permissions, [
    'view_screen',
    'control_mouse_keyboard',
    'record_screen',
    'transfer_file',
    'clipboard'
  ]);

  assert.throws(
    () => createRustDeskIveKitSmokeConfigFromEnv({
      OPC_API_KEY: 'opc-api-key',
      OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789'
    }),
    /OPC_RUSTDESK_IVEKIT_BASE_URL, OPC_BASE_URL, OPC_COLLABORATION_BASE_URL, OPC_RUSTDESK_EDGE_BASE_URL, OPC_RUSTDESK_CONTROL_PLANE_BASE_URL, or OPC_REMOTE_GATEWAY_BASE_URL is required/
  );
  assert.throws(
    () => createRustDeskIveKitSmokeConfigFromEnv({
      OPC_BASE_URL: 'https://opc.example.com',
      OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789'
    }),
    /OPC_RUSTDESK_IVEKIT_API_KEY, OPC_COLLABORATION_API_KEY, or OPC_API_KEY is required/
  );
  assert.throws(
    () => createRustDeskIveKitSmokeConfigFromEnv({
      OPC_BASE_URL: 'https://opc.example.com',
      OPC_API_KEY: 'opc-api-key',
      OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789'
    }),
    /OPC_RUSTDESK_IVEKIT_TENANT_ID, OPC_REMOTE_GATEWAY_TENANT_ID, OPC_RUSTDESK_EDGE_TENANT_ID, or OPC_TENANT_ID is required/
  );
  assert.throws(
    () => createRustDeskIveKitSmokeConfigFromEnv({
      OPC_BASE_URL: 'https://opc.example.com',
      OPC_API_KEY: 'opc-api-key',
      OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led'
    }),
    /OPC_RUSTDESK_IVEKIT_RUSTDESK_ID, OPC_RUSTDESK_EDGE_RUSTDESK_ID, or OPC_REMOTE_GATEWAY_TARGET_ID is required/
  );
});

test('rustdesk iveKit smoke exercises the LED facade lifecycle', async () => {
  const calls: string[] = [];
  const postedEventTypes: string[] = [];
  const acceptedEventTypes: string[] = [];
  let ended = false;
  const launchUrl = signedLaunchUrl('rdgw_ivekit_smoke_1');
  const auditEvents: Array<Record<string, unknown>> = [
    {
      external_id: 'rdgw_ivekit_smoke_1',
      event_type: 'remote.gateway_session.created',
      actor_identity: 'agent_ivekit_rustdesk_smoke',
      target: '123456789',
      metadata: { rustdesk_id: '123456789' },
      occurred_at: '2026-07-04T09:00:00.000Z'
    }
  ];

  const result = await runRustDeskIveKitSmoke(
    createRustDeskIveKitSmokeConfigFromEnv({
      OPC_BASE_URL: 'https://opc.example.com',
      OPC_API_KEY: 'opc-api-key',
      OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
      OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-smoke-1',
      OPC_RUSTDESK_IVEKIT_DEVICE_DISPLAY_NAME: 'LED control PC'
    }),
    async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method || 'GET';
      calls.push(`${method} ${url.pathname}${url.search}`);

      if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
        return jsonResponse(201, { id: 'collab_ivekit_smoke_1' });
      }
      if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
        return jsonResponse(201, { id: 'remote_ivekit_smoke_1' });
      }
      if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_smoke_1/consent/grant') {
        return jsonResponse(201, { event_type: 'granted' });
      }
      if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
        return jsonResponse(200, {
          id_server: 'rustdesk-id.example.com',
          relay_server: 'rustdesk-relay.example.com',
          public_key_configured: true,
          public_key: 'public-key',
          server_key_fingerprint: 'sha256:publickeyfingerprint',
          manual_fields: {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            key: 'public-key'
          }
        });
      }
      if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
        return jsonResponse(201, {
          id: 'rdesk_ivekit_device_1',
          rustdesk_id: '123456789',
          display_name: 'LED control PC',
          status: 'active',
          runtime_status: 'unknown'
        });
      }
      if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices/rdesk_ivekit_device_1/heartbeat') {
        return jsonResponse(201, {
          id: 'rdesk_ivekit_device_1',
          rustdesk_id: '123456789',
          runtime_status: 'online',
          last_seen_at: '2026-07-04T09:00:01.000Z',
          last_seen_actor: 'agent_ivekit_rustdesk_smoke'
        });
      }
      if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
        return jsonResponse(200, [
          {
            id: 'rdesk_ivekit_device_1',
            rustdesk_id: '123456789',
            status: 'active'
          }
        ]);
      }
      if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
        return jsonResponse(201, {
          id: 'tool_ivekit_smoke_1',
          provider: 'rustdesk',
          external_id: 'rdgw_ivekit_smoke_1',
          launch_url: launchUrl,
          status: 'active',
          metadata: {
            rustdesk_id: '123456789',
            rustdesk_device_id: 'rdesk_ivekit_device_1',
            remote_session_id: 'remote_ivekit_smoke_1'
          }
        });
      }
      if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_smoke_1/launch') {
        return jsonResponse(200, {
          external_id: 'rdgw_ivekit_smoke_1',
          status: ended ? 'ended' : 'active',
          launch_url: ended ? '' : launchUrl,
          target: {
            type: 'device',
            id: '123456789',
            display_name: 'LED control PC'
          },
          permissions: RUSTDESK_IVEKIT_SMOKE_SCOPES,
          runtime: {
            rustdesk_id: '123456789',
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            public_key_configured: 'true',
            public_key_source: 'env'
          },
          client_config: {
            public_key_configured: true,
            public_key_source: 'env',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          },
          actions: {
            can_launch: !ended,
            open_url: ended ? '' : launchUrl,
            protocol_url: ended ? '' : 'rustdesk://connect/123456789?session=rdgw_ivekit_smoke_1'
          }
        });
      }
      if (method === 'GET' && url.pathname === '/remote/rustdesk/launch') {
        if (ended) return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
        return new Response('<title>RustDesk Remote Launch</title>rdgw_ivekit_smoke_1', { status: 200 });
      }
      if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_smoke_1/events') {
        const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
        postedEventTypes.push(String(body.event_type || ''));
        if (ended) {
          return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
        }
        const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? body.metadata as Record<string, unknown>
          : {};
        if (
          body.event_type === 'remote.rustdesk.clipboard.synced'
          && metadata.direction === 'sideways'
        ) {
          return jsonResponse(400, {
            error: 'RustDesk clipboard event metadata.direction must be one of agent_to_device, device_to_agent'
          });
        }
        acceptedEventTypes.push(String(body.event_type || ''));
        auditEvents.push({
          external_id: 'rdgw_ivekit_smoke_1',
          event_type: body.event_type,
          actor_identity: body.actor_identity,
          target: body.target,
          metadata: body.metadata || {},
          occurred_at: '2026-07-04T09:00:02.000Z'
        });
        return jsonResponse(201, { event: auditEvents.at(-1) });
      }
      if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_smoke_1/audit') {
        return jsonResponse(200, { events: auditEvents });
      }
      if (method === 'DELETE' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_smoke_1') {
        ended = true;
        auditEvents.push({
          external_id: 'rdgw_ivekit_smoke_1',
          event_type: 'remote.gateway_session.ended',
          actor_identity: 'agent_ivekit_rustdesk_smoke',
          target: '123456789',
          metadata: { rustdesk_id: '123456789' },
          occurred_at: '2026-07-04T09:00:03.000Z'
        });
        return new Response(null, { status: 204 });
      }
      if (method === 'GET' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_smoke_1/timeline') {
        return jsonResponse(200, {
          session: { id: 'remote_ivekit_smoke_1' },
          consent_events: [{ event_type: 'granted' }],
          tool_sessions: [{ id: 'tool_ivekit_smoke_1', provider: 'rustdesk', external_id: 'rdgw_ivekit_smoke_1', status: 'ended' }],
          audit_events: [
            { event_type: 'remote.rustdesk.control_action.performed' },
            { event_type: 'remote.rustdesk.file_transfer.started' },
            { event_type: 'remote.rustdesk.file_transfer.completed' },
            { event_type: 'remote.rustdesk.recording.started' },
            { event_type: 'remote.rustdesk.recording.stopped' },
            { event_type: 'remote.rustdesk.clipboard.synced' },
            { event_type: 'remote.gateway_session.ended' },
            { event_type: 'remote.tool_session.ended' }
          ],
          evidence: []
        });
      }

      return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
    }
  );

  assert.equal(result.collaborationSessionId, 'collab_ivekit_smoke_1');
  assert.equal(result.remoteSessionId, 'remote_ivekit_smoke_1');
  assert.equal(result.deviceId, 'rdesk_ivekit_device_1');
  assert.equal(result.externalId, 'rdgw_ivekit_smoke_1');
  assert.equal(result.launchPlan.canLaunch, true);
  assert.equal(result.endedLaunchPlan.canLaunch, false);
  assert.equal(result.launchPageChecked, true);
  assert.equal(result.endedLaunchUrlRejected, true);
  assert.equal(result.afterEndEventRejected, true);
  assert.deepEqual(result.operationEventTypes, [
    'remote.rustdesk.control_action.performed',
    'remote.rustdesk.file_transfer.started',
    'remote.rustdesk.file_transfer.completed',
    'remote.rustdesk.recording.started',
    'remote.rustdesk.recording.stopped',
    'remote.rustdesk.clipboard.synced'
  ]);
  assert.deepEqual(acceptedEventTypes, result.operationEventTypes);
  assert.deepEqual(postedEventTypes, [
    'remote.rustdesk.clipboard.synced',
    ...result.operationEventTypes,
    'remote.rustdesk.control_action.performed'
  ]);
  assert.equal(result.invalidEventRejected, true);
  assert.equal(result.timeline.auditEvents >= 8, true);
  assert.deepEqual(calls.slice(0, 5), [
    'POST /api/collaboration/sessions',
    'POST /api/collaboration/remote-assistance/sessions',
    'POST /api/collaboration/remote-assistance/remote_ivekit_smoke_1/consent/grant',
    'GET /api/ivekit/rustdesk/client-config',
    'POST /api/ivekit/rustdesk/devices'
  ]);
  assert.equal(calls.includes('DELETE /api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_smoke_1'), true);
});

test('rustdesk iveKit smoke rejects a public launch page that stays open after end', async () => {
  const externalId = 'rdgw_ivekit_ended_public_launch_open';
  const launchUrl = signedLaunchUrl(externalId);
  const calls: string[] = [];
  let ended = false;
  const auditEvents: Array<Record<string, unknown>> = [
    {
      external_id: externalId,
      event_type: 'remote.gateway_session.created',
      actor_identity: 'agent_ivekit_rustdesk_smoke',
      target: '123456789',
      metadata: { rustdesk_id: '123456789' },
      occurred_at: '2026-07-04T09:00:00.000Z'
    }
  ];

  await assert.rejects(
    () => runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-ended-public-launch-open'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: `${externalId}_collab` });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: `${externalId}_remote` });
        }
        if (method === 'POST' && url.pathname === `/api/collaboration/remote-assistance/${externalId}_remote/consent/grant`) {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
          return jsonResponse(201, {
            id: `${externalId}_device`,
            rustdesk_id: '123456789',
            display_name: 'RustDesk iveKit smoke device'
          });
        }
        if (method === 'POST' && url.pathname === `/api/ivekit/rustdesk/devices/${externalId}_device/heartbeat`) {
          return jsonResponse(201, { runtime_status: 'online' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
          return jsonResponse(200, [{ id: `${externalId}_device`, rustdesk_id: '123456789' }]);
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
          return jsonResponse(201, {
            id: `${externalId}_tool`,
            provider: 'rustdesk',
            external_id: externalId,
            launch_url: launchUrl,
            status: 'active'
          });
        }
        if (method === 'GET' && url.pathname === `/api/ivekit/rustdesk/gateway-sessions/${externalId}/launch`) {
          return jsonResponse(200, rustDeskIveKitLaunchPlanBody(externalId, launchUrl, {
            status: ended ? 'ended' : 'active',
            canLaunch: !ended
          }));
        }
        if (method === 'GET' && url.pathname === '/remote/rustdesk/launch') {
          return new Response(`<title>RustDesk Remote Launch</title>${externalId}`, { status: 200 });
        }
        if (method === 'POST' && url.pathname === `/api/ivekit/rustdesk/gateway-sessions/${externalId}/events`) {
          const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
          const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? body.metadata as Record<string, unknown>
            : {};
          if (ended) return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
          if (body.event_type === 'remote.rustdesk.clipboard.synced' && metadata.direction === 'sideways') {
            return jsonResponse(400, {
              error: 'RustDesk clipboard event metadata.direction must be one of agent_to_device, device_to_agent'
            });
          }
          auditEvents.push({
            external_id: externalId,
            event_type: body.event_type,
            actor_identity: body.actor_identity,
            target: body.target,
            metadata: body.metadata || {},
            occurred_at: '2026-07-04T09:00:02.000Z'
          });
          return jsonResponse(201, { event: auditEvents.at(-1) });
        }
        if (method === 'GET' && url.pathname === `/api/ivekit/rustdesk/gateway-sessions/${externalId}/audit`) {
          return jsonResponse(200, { events: auditEvents });
        }
        if (method === 'DELETE' && url.pathname === `/api/ivekit/rustdesk/gateway-sessions/${externalId}`) {
          ended = true;
          auditEvents.push({
            external_id: externalId,
            event_type: 'remote.gateway_session.ended',
            actor_identity: 'agent_ivekit_rustdesk_smoke',
            target: '123456789',
            metadata: { rustdesk_id: '123456789' },
            occurred_at: '2026-07-04T09:00:03.000Z'
          });
          return new Response(null, { status: 204 });
        }
        if (method === 'GET' && url.pathname === `/api/collaboration/remote-assistance/${externalId}_remote/timeline`) {
          return jsonResponse(200, {
            session: { id: `${externalId}_remote` },
            consent_events: [{ event_type: 'granted' }],
            tool_sessions: [{ id: `${externalId}_tool`, provider: 'rustdesk', external_id: externalId, status: 'ended' }],
            audit_events: [
              { event_type: 'remote.rustdesk.control_action.performed' },
              { event_type: 'remote.rustdesk.file_transfer.started' },
              { event_type: 'remote.rustdesk.file_transfer.completed' },
              { event_type: 'remote.rustdesk.recording.started' },
              { event_type: 'remote.rustdesk.recording.stopped' },
              { event_type: 'remote.rustdesk.clipboard.synced' },
              { event_type: 'remote.gateway_session.ended' },
              { event_type: 'remote.tool_session.ended' }
            ],
            evidence: []
          });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    ),
    /iveKit RustDesk ended launch URL must be rejected with 409/
  );

  assert.equal(calls.includes('GET /remote/rustdesk/launch?session_id=rdgw_ivekit_ended_public_launch_open&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z'), true);
});

test('rustdesk iveKit smoke rejects unsigned launch URLs and cleans the gateway session', async () => {
  const calls: string[] = [];
  let cleanupAttempted = false;

  await assert.rejects(
    runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-bad-launch'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_bad_launch' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_bad_launch' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_bad_launch/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
          return jsonResponse(201, {
            id: 'rdesk_ivekit_bad_launch_device',
            rustdesk_id: '123456789',
            display_name: 'RustDesk iveKit smoke device'
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices/rdesk_ivekit_bad_launch_device/heartbeat') {
          return jsonResponse(201, { runtime_status: 'online' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
          return jsonResponse(200, [{ id: 'rdesk_ivekit_bad_launch_device', rustdesk_id: '123456789' }]);
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
          return jsonResponse(201, {
            provider: 'rustdesk',
            external_id: 'rdgw_ivekit_bad_launch',
            launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_ivekit_bad_launch&token=launch-token',
            status: 'active'
          });
        }
        if (method === 'DELETE' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_bad_launch') {
          cleanupAttempted = true;
          return new Response(null, { status: 204 });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    ),
    /iveKit RustDesk launch_url token must be a 64 character hex HMAC/
  );

  assert.equal(cleanupAttempted, true);
  assert.equal(calls.includes('GET /api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_bad_launch/launch'), false);
});

test('rustdesk iveKit smoke rejects client config without an ID server before registering devices', async () => {
  const calls: string[] = [];

  await assert.rejects(
    runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-bad-client-config'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_bad_client_config' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_bad_client_config' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_bad_client_config/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key'
          });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    ),
    /RustDesk client config id_server is required/
  );

  assert.equal(calls.includes('POST /api/ivekit/rustdesk/devices'), false);
});

test('rustdesk iveKit smoke rejects client config without a manual key before registering devices', async () => {
  const calls: string[] = [];

  await assert.rejects(
    runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-bad-manual-key'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_bad_manual_key' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_bad_manual_key' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_bad_manual_key/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com'
            }
          });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    ),
    /RustDesk client config manual_fields.key is required/
  );

  assert.equal(calls.includes('POST /api/ivekit/rustdesk/devices'), false);
});

test('rustdesk iveKit smoke rejects client config whose public key is not configured before registering devices', async () => {
  const calls: string[] = [];

  await assert.rejects(
    runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-unconfigured-public-key'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_unconfigured_public_key' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_unconfigured_public_key' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_unconfigured_public_key/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: false,
            public_key: 'public-key',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    ),
    /RustDesk client config public key is not configured/
  );

  assert.equal(calls.includes('POST /api/ivekit/rustdesk/devices'), false);
});

test('rustdesk iveKit smoke rejects client config without a server key fingerprint before registering devices', async () => {
  const calls: string[] = [];

  await assert.rejects(
    runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-missing-fingerprint'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_missing_fingerprint' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_missing_fingerprint' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_missing_fingerprint/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    ),
    /RustDesk client config server_key_fingerprint is required/
  );

  assert.equal(calls.includes('POST /api/ivekit/rustdesk/devices'), false);
});

test('rustdesk iveKit smoke rejects launch plans whose open URL differs from the created launch URL', async () => {
  const calls: string[] = [];
  let cleanupAttempted = false;
  const launchUrl = signedLaunchUrl('rdgw_ivekit_bad_plan');
  let caught: unknown;

  try {
    await runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-bad-plan'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_bad_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_bad_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_bad_plan/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
          return jsonResponse(201, {
            id: 'rdesk_ivekit_bad_plan_device',
            rustdesk_id: '123456789',
            display_name: 'RustDesk iveKit smoke device'
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices/rdesk_ivekit_bad_plan_device/heartbeat') {
          return jsonResponse(201, { runtime_status: 'online' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
          return jsonResponse(200, [{ id: 'rdesk_ivekit_bad_plan_device', rustdesk_id: '123456789' }]);
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
          return jsonResponse(201, {
            provider: 'rustdesk',
            external_id: 'rdgw_ivekit_bad_plan',
            launch_url: launchUrl,
            status: 'active'
          });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_bad_plan/launch') {
          return jsonResponse(200, {
            external_id: 'rdgw_ivekit_bad_plan',
            status: 'active',
            launch_url: launchUrl,
            runtime: {
            rustdesk_id: '123456789',
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            server_key_fingerprint: 'sha256:publickeyfingerprint'
          },
            client_config: {
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                relay_server: 'rustdesk-relay.example.com',
                key: 'public-key'
              }
            },
            actions: {
              can_launch: true,
              open_url: signedLaunchUrl('rdgw_ivekit_bad_plan', 'b'),
              protocol_url: 'rustdesk://connect/123456789?session=rdgw_ivekit_bad_plan'
            }
          });
        }
        if (method === 'DELETE' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_bad_plan') {
          cleanupAttempted = true;
          return new Response(null, { status: 204 });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.match(errorMessage(caught), /RustDesk launch plan launch_url must match created session launch_url/);
  assert.equal(cleanupAttempted, true);
  assert.equal(calls.some((call) => call === 'POST /api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_bad_plan/events'), false);
});

test('rustdesk iveKit smoke rejects launch plans with client config drift before posting events', async () => {
  const calls: string[] = [];
  let cleanupAttempted = false;
  const launchUrl = signedLaunchUrl('rdgw_ivekit_drift_plan');
  let caught: unknown;

  try {
    await runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-drift-plan'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_drift_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_drift_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_drift_plan/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
          return jsonResponse(201, {
            id: 'rdesk_ivekit_drift_plan_device',
            rustdesk_id: '123456789',
            display_name: 'RustDesk iveKit smoke device'
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices/rdesk_ivekit_drift_plan_device/heartbeat') {
          return jsonResponse(201, { runtime_status: 'online' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
          return jsonResponse(200, [{ id: 'rdesk_ivekit_drift_plan_device', rustdesk_id: '123456789' }]);
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
          return jsonResponse(201, {
            provider: 'rustdesk',
            external_id: 'rdgw_ivekit_drift_plan',
            launch_url: launchUrl,
            status: 'active'
          });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_drift_plan/launch') {
          return jsonResponse(200, {
            external_id: 'rdgw_ivekit_drift_plan',
            status: 'active',
            launch_url: launchUrl,
            runtime: {
            rustdesk_id: '123456789',
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            server_key_fingerprint: 'sha256:publickeyfingerprint'
          },
            client_config: {
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                relay_server: 'rustdesk-relay.example.com',
                key: 'other-public-key'
              }
            },
            actions: {
              can_launch: true,
              open_url: launchUrl,
              protocol_url: 'rustdesk://connect/123456789?session=rdgw_ivekit_drift_plan'
            }
          });
        }
        if (method === 'DELETE' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_drift_plan') {
          cleanupAttempted = true;
          return new Response(null, { status: 204 });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.match(errorMessage(caught), /RustDesk launch plan client_config.manual_fields.key must match client config/);
  assert.equal(cleanupAttempted, true);
  assert.equal(calls.some((call) => call === 'POST /api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_drift_plan/events'), false);
});

test('rustdesk iveKit smoke rejects launch plans with server key fingerprint drift before posting events', async () => {
  const calls: string[] = [];
  let cleanupAttempted = false;
  const launchUrl = signedLaunchUrl('rdgw_ivekit_fingerprint_drift_plan');
  let caught: unknown;

  try {
    await runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-fingerprint-drift-plan'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_fingerprint_drift_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_fingerprint_drift_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_fingerprint_drift_plan/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
          return jsonResponse(201, {
            id: 'rdesk_ivekit_fingerprint_drift_plan_device',
            rustdesk_id: '123456789',
            display_name: 'RustDesk iveKit smoke device'
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices/rdesk_ivekit_fingerprint_drift_plan_device/heartbeat') {
          return jsonResponse(201, { runtime_status: 'online' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
          return jsonResponse(200, [{ id: 'rdesk_ivekit_fingerprint_drift_plan_device', rustdesk_id: '123456789' }]);
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
          return jsonResponse(201, {
            provider: 'rustdesk',
            external_id: 'rdgw_ivekit_fingerprint_drift_plan',
            launch_url: launchUrl,
            status: 'active'
          });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_fingerprint_drift_plan/launch') {
          return jsonResponse(200, {
            external_id: 'rdgw_ivekit_fingerprint_drift_plan',
            status: 'active',
            launch_url: launchUrl,
            runtime: {
              rustdesk_id: '123456789',
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              server_key_fingerprint: 'sha256:otherfingerprint'
            },
            client_config: {
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                relay_server: 'rustdesk-relay.example.com',
                key: 'public-key'
              }
            },
            actions: {
              can_launch: true,
              open_url: launchUrl,
              protocol_url: 'rustdesk://connect/123456789?session=rdgw_ivekit_fingerprint_drift_plan'
            }
          });
        }
        if (method === 'DELETE' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_fingerprint_drift_plan') {
          cleanupAttempted = true;
          return new Response(null, { status: 204 });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.match(errorMessage(caught), /RustDesk launch plan runtime server_key_fingerprint must match client config/);
  assert.equal(cleanupAttempted, true);
  assert.equal(calls.some((call) => call === 'POST /api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_fingerprint_drift_plan/events'), false);
});

test('rustdesk iveKit smoke rejects launch plans for another gateway session before posting events', async () => {
  const calls: string[] = [];
  let cleanupAttempted = false;
  const launchUrl = signedLaunchUrl('rdgw_ivekit_wrong_external_id_plan');
  let caught: unknown;

  try {
    await runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-wrong-external-id-plan'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_wrong_external_id_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_wrong_external_id_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_wrong_external_id_plan/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
          return jsonResponse(201, {
            id: 'rdesk_ivekit_wrong_external_id_plan_device',
            rustdesk_id: '123456789',
            display_name: 'RustDesk iveKit smoke device'
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices/rdesk_ivekit_wrong_external_id_plan_device/heartbeat') {
          return jsonResponse(201, { runtime_status: 'online' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
          return jsonResponse(200, [{ id: 'rdesk_ivekit_wrong_external_id_plan_device', rustdesk_id: '123456789' }]);
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
          return jsonResponse(201, {
            provider: 'rustdesk',
            external_id: 'rdgw_ivekit_wrong_external_id_plan',
            launch_url: launchUrl,
            status: 'active'
          });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_wrong_external_id_plan/launch') {
          return jsonResponse(200, {
            external_id: 'rdgw_ivekit_other_plan',
            status: 'active',
            launch_url: launchUrl,
            runtime: {
              rustdesk_id: '123456789',
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              server_key_fingerprint: 'sha256:publickeyfingerprint',
              public_key_configured: 'true',
              public_key_source: 'env'
            },
            client_config: {
              public_key_configured: true,
              public_key_source: 'env',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                relay_server: 'rustdesk-relay.example.com',
                key: 'public-key'
              }
            },
            actions: {
              can_launch: true,
              open_url: launchUrl,
              protocol_url: 'rustdesk://connect/123456789?session=rdgw_ivekit_wrong_external_id_plan'
            }
          });
        }
        if (method === 'DELETE' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_wrong_external_id_plan') {
          cleanupAttempted = true;
          return new Response(null, { status: 204 });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.match(errorMessage(caught), /RustDesk launch plan external_id must match gateway session/);
  assert.equal(cleanupAttempted, true);
  assert.equal(calls.some((call) => call === 'POST /api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_wrong_external_id_plan/events'), false);
});

test('rustdesk iveKit smoke rejects launch plans without an active status before posting events', async () => {
  const calls: string[] = [];
  let cleanupAttempted = false;
  const launchUrl = signedLaunchUrl('rdgw_ivekit_inactive_status_plan');
  let caught: unknown;

  try {
    await runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-inactive-status-plan'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_inactive_status_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_inactive_status_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_inactive_status_plan/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
          return jsonResponse(201, {
            id: 'rdesk_ivekit_inactive_status_plan_device',
            rustdesk_id: '123456789',
            display_name: 'RustDesk iveKit smoke device'
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices/rdesk_ivekit_inactive_status_plan_device/heartbeat') {
          return jsonResponse(201, { runtime_status: 'online' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
          return jsonResponse(200, [{ id: 'rdesk_ivekit_inactive_status_plan_device', rustdesk_id: '123456789' }]);
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
          return jsonResponse(201, {
            provider: 'rustdesk',
            external_id: 'rdgw_ivekit_inactive_status_plan',
            launch_url: launchUrl,
            status: 'active'
          });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_inactive_status_plan/launch') {
          return jsonResponse(200, {
            external_id: 'rdgw_ivekit_inactive_status_plan',
            status: 'pending',
            launch_url: launchUrl,
            runtime: {
              rustdesk_id: '123456789',
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              server_key_fingerprint: 'sha256:publickeyfingerprint',
              public_key_configured: 'true',
              public_key_source: 'env'
            },
            client_config: {
              public_key_configured: true,
              public_key_source: 'env',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                relay_server: 'rustdesk-relay.example.com',
                key: 'public-key'
              }
            },
            actions: {
              can_launch: true,
              open_url: launchUrl,
              protocol_url: 'rustdesk://connect/123456789?session=rdgw_ivekit_inactive_status_plan'
            }
          });
        }
        if (method === 'DELETE' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_inactive_status_plan') {
          cleanupAttempted = true;
          return new Response(null, { status: 204 });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.match(errorMessage(caught), /RustDesk active launch plan status must be active/);
  assert.equal(cleanupAttempted, true);
  assert.equal(calls.some((call) => call === 'POST /api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_inactive_status_plan/events'), false);
});

test('rustdesk iveKit smoke rejects launch plans without a runtime ID server before posting events', async () => {
  const externalId = 'rdgw_ivekit_missing_runtime_id_server_plan';
  const result = await expectRustDeskIveKitLaunchPlanRejection({
    externalId,
    launchPlan: () => ({
      runtime: {
        rustdesk_id: '123456789',
        relay_server: 'rustdesk-relay.example.com',
        server_key_fingerprint: 'sha256:publickeyfingerprint'
      }
    }),
    expected: /RustDesk launch plan runtime id_server is required/
  });

  assert.equal(result.cleanupAttempted, true);
  assert.equal(result.calls.some((call) => call === `POST /api/ivekit/rustdesk/gateway-sessions/${externalId}/events`), false);
});

test('rustdesk iveKit smoke rejects launch plans without the requested permissions before posting events', async () => {
  const externalId = 'rdgw_ivekit_missing_permissions_plan';
  const result = await expectRustDeskIveKitLaunchPlanRejection({
    externalId,
    launchPlan: () => ({
      permissions: ['view_screen']
    }),
    expected: /RustDesk launch plan permissions must include requested scope control_mouse_keyboard/
  });

  assert.equal(result.cleanupAttempted, true);
  assert.equal(result.calls.some((call) => call === `POST /api/ivekit/rustdesk/gateway-sessions/${externalId}/events`), false);
});

test('rustdesk iveKit smoke rejects launch plans whose public key is not configured before posting events', async () => {
  const externalId = 'rdgw_ivekit_launch_plan_public_key_unconfigured';
  const result = await expectRustDeskIveKitLaunchPlanRejection({
    externalId,
    launchPlan: () => ({
      runtime: {
        rustdesk_id: '123456789',
        id_server: 'rustdesk-id.example.com',
        relay_server: 'rustdesk-relay.example.com',
        server_key_fingerprint: 'sha256:publickeyfingerprint',
        public_key_configured: 'false',
        public_key_source: 'none'
      },
      client_config: {
        public_key_configured: false,
        public_key_source: 'none',
        manual_fields: {
          id_server: 'rustdesk-id.example.com',
          relay_server: 'rustdesk-relay.example.com',
          key: 'public-key'
        }
      }
    }),
    expected: /RustDesk launch plan client_config.public_key_configured must be true/
  });

  assert.equal(result.cleanupAttempted, true);
  assert.equal(result.calls.some((call) => call === `POST /api/ivekit/rustdesk/gateway-sessions/${externalId}/events`), false);
});

test('rustdesk iveKit smoke rejects launch plans for another target before posting events', async () => {
  const externalId = 'rdgw_ivekit_wrong_launch_plan_target';
  const result = await expectRustDeskIveKitLaunchPlanRejection({
    externalId,
    launchPlan: () => ({
      target: {
        type: 'device',
        id: '987654321',
        display_name: 'Another RustDesk device'
      }
    }),
    expected: /RustDesk launch plan target.id must match RustDesk target/
  });

  assert.equal(result.cleanupAttempted, true);
  assert.equal(result.calls.some((call) => call === `POST /api/ivekit/rustdesk/gateway-sessions/${externalId}/events`), false);
});

test('rustdesk iveKit smoke rejects active launch plans without a protocol URL before posting events', async () => {
  const externalId = 'rdgw_ivekit_missing_protocol_url_plan';
  const result = await expectRustDeskIveKitLaunchPlanRejection({
    externalId,
    launchPlan: (launchUrl) => ({
      actions: {
        can_launch: true,
        open_url: launchUrl,
        protocol_url: ''
      }
    }),
    expected: /RustDesk active launch plan protocol_url is required/
  });

  assert.equal(result.cleanupAttempted, true);
  assert.equal(result.calls.some((call) => call === `POST /api/ivekit/rustdesk/gateway-sessions/${externalId}/events`), false);
});

test('rustdesk iveKit smoke rejects active launch plans without the rustdesk protocol scheme before posting events', async () => {
  const externalId = 'rdgw_ivekit_bad_protocol_scheme_plan';
  const result = await expectRustDeskIveKitLaunchPlanRejection({
    externalId,
    launchPlan: (launchUrl) => ({
      actions: {
        can_launch: true,
        open_url: launchUrl,
        protocol_url: `https://opc.example.com/connect/123456789?session=${externalId}`
      }
    }),
    expected: /RustDesk active launch plan protocol_url must use the rustdesk scheme/
  });

  assert.equal(result.cleanupAttempted, true);
  assert.equal(result.calls.some((call) => call === `POST /api/ivekit/rustdesk/gateway-sessions/${externalId}/events`), false);
});

test('rustdesk iveKit smoke rejects protocol URLs for another RustDesk target before posting events', async () => {
  const externalId = 'rdgw_ivekit_wrong_protocol_target_plan';
  const result = await expectRustDeskIveKitLaunchPlanRejection({
    externalId,
    launchPlan: (launchUrl) => ({
      actions: {
        can_launch: true,
        open_url: launchUrl,
        protocol_url: `rustdesk://connect/987654321?session=${externalId}`
      }
    }),
    expected: /RustDesk active launch plan protocol_url must reference the RustDesk target/
  });

  assert.equal(result.cleanupAttempted, true);
  assert.equal(result.calls.some((call) => call === `POST /api/ivekit/rustdesk/gateway-sessions/${externalId}/events`), false);
});

test('rustdesk iveKit smoke rejects ended launch plans without an ended status', async () => {
  const calls: string[] = [];
  let ended = false;
  const launchUrl = signedLaunchUrl('rdgw_ivekit_bad_ended_status_plan');
  const auditEvents: Array<Record<string, unknown>> = [
    {
      external_id: 'rdgw_ivekit_bad_ended_status_plan',
      event_type: 'remote.gateway_session.created',
      actor_identity: 'agent_ivekit_rustdesk_smoke',
      target: '123456789',
      metadata: { rustdesk_id: '123456789' },
      occurred_at: '2026-07-04T09:00:00.000Z'
    }
  ];
  let caught: unknown;

  try {
    await runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: 'SO-ivekit-bad-ended-status-plan'
      }),
      async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: 'collab_ivekit_bad_ended_status_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: 'remote_ivekit_bad_ended_status_plan' });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_bad_ended_status_plan/consent/grant') {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
          return jsonResponse(201, {
            id: 'rdesk_ivekit_bad_ended_status_plan_device',
            rustdesk_id: '123456789',
            display_name: 'RustDesk iveKit smoke device'
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices/rdesk_ivekit_bad_ended_status_plan_device/heartbeat') {
          return jsonResponse(201, { runtime_status: 'online' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
          return jsonResponse(200, [{ id: 'rdesk_ivekit_bad_ended_status_plan_device', rustdesk_id: '123456789' }]);
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
          return jsonResponse(201, {
            provider: 'rustdesk',
            external_id: 'rdgw_ivekit_bad_ended_status_plan',
            launch_url: launchUrl,
            status: 'active'
          });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_bad_ended_status_plan/launch') {
          return jsonResponse(200, {
            external_id: 'rdgw_ivekit_bad_ended_status_plan',
            status: 'active',
            launch_url: launchUrl,
            target: {
              type: 'device',
              id: '123456789',
              display_name: 'RustDesk iveKit smoke device'
            },
            permissions: RUSTDESK_IVEKIT_SMOKE_SCOPES,
            runtime: {
              rustdesk_id: '123456789',
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              server_key_fingerprint: 'sha256:publickeyfingerprint',
              public_key_configured: 'true',
              public_key_source: 'env'
            },
            client_config: {
              public_key_configured: true,
              public_key_source: 'env',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                relay_server: 'rustdesk-relay.example.com',
                key: 'public-key'
              }
            },
            actions: {
              can_launch: !ended,
              open_url: ended ? '' : launchUrl,
              protocol_url: ended ? '' : 'rustdesk://connect/123456789?session=rdgw_ivekit_bad_ended_status_plan'
            }
          });
        }
        if (method === 'GET' && url.pathname === '/remote/rustdesk/launch') {
          return new Response('<title>RustDesk Remote Launch</title>rdgw_ivekit_bad_ended_status_plan', { status: 200 });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_bad_ended_status_plan/events') {
          const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
          const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? body.metadata as Record<string, unknown>
            : {};
          if (ended) {
            return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
          }
          if (body.event_type === 'remote.rustdesk.clipboard.synced' && metadata.direction === 'sideways') {
            return jsonResponse(400, {
              error: 'RustDesk clipboard event metadata.direction must be one of agent_to_device, device_to_agent'
            });
          }
          auditEvents.push({
            external_id: 'rdgw_ivekit_bad_ended_status_plan',
            event_type: body.event_type,
            actor_identity: body.actor_identity,
            target: body.target,
            metadata: body.metadata || {},
            occurred_at: '2026-07-04T09:00:02.000Z'
          });
          return jsonResponse(201, { event: auditEvents.at(-1) });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_bad_ended_status_plan/audit') {
          return jsonResponse(200, { events: auditEvents });
        }
        if (method === 'DELETE' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_ivekit_bad_ended_status_plan') {
          ended = true;
          auditEvents.push({
            external_id: 'rdgw_ivekit_bad_ended_status_plan',
            event_type: 'remote.gateway_session.ended',
            actor_identity: 'agent_ivekit_rustdesk_smoke',
            target: '123456789',
            metadata: { rustdesk_id: '123456789' },
            occurred_at: '2026-07-04T09:00:03.000Z'
          });
          return new Response(null, { status: 204 });
        }
        if (method === 'GET' && url.pathname === '/api/collaboration/remote-assistance/remote_ivekit_bad_ended_status_plan/timeline') {
          return jsonResponse(200, {
            session: { id: 'remote_ivekit_bad_ended_status_plan' },
            consent_events: [{ event_type: 'granted' }],
            tool_sessions: [{ id: 'tool_ivekit_bad_ended_status_plan', provider: 'rustdesk', external_id: 'rdgw_ivekit_bad_ended_status_plan', status: 'ended' }],
            audit_events: [
              { event_type: 'remote.rustdesk.control_action.performed' },
              { event_type: 'remote.rustdesk.file_transfer.started' },
              { event_type: 'remote.rustdesk.file_transfer.completed' },
              { event_type: 'remote.rustdesk.recording.started' },
              { event_type: 'remote.rustdesk.recording.stopped' },
              { event_type: 'remote.rustdesk.clipboard.synced' },
              { event_type: 'remote.gateway_session.ended' },
              { event_type: 'remote.tool_session.ended' }
            ],
            evidence: []
          });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.match(errorMessage(caught), /RustDesk ended launch plan status must be ended/);
  assert.equal(calls.includes('GET /api/collaboration/remote-assistance/remote_ivekit_bad_ended_status_plan/timeline'), false);
});

test('rustdesk iveKit smoke rejects ended launch plans with a protocol URL', async () => {
  const externalId = 'rdgw_ivekit_ended_protocol_url_plan';
  const result = await expectRustDeskIveKitEndedLaunchPlanRejection({
    externalId,
    endedLaunchPlan: (launchUrl) => ({
      actions: {
        can_launch: false,
        open_url: '',
        protocol_url: `rustdesk://connect/123456789?session=${externalId}`
      }
    }),
    expected: /RustDesk ended launch plan protocol_url must be empty/
  });

  assert.equal(result.ended, true);
  assert.equal(result.calls.includes(`GET /api/collaboration/remote-assistance/${externalId}_remote/timeline`), false);
});

test('rustdesk iveKit smoke rejects ended launch plans with a launch URL', async () => {
  const externalId = 'rdgw_ivekit_ended_launch_url_plan';
  const result = await expectRustDeskIveKitEndedLaunchPlanRejection({
    externalId,
    endedLaunchPlan: (launchUrl) => ({ launch_url: launchUrl }),
    expected: /RustDesk ended launch plan launch_url must be empty/
  });

  assert.equal(result.ended, true);
  assert.equal(result.calls.includes(`GET /api/collaboration/remote-assistance/${externalId}_remote/timeline`), false);
});

test('rustdesk iveKit smoke is wired into scripts and env examples', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:ivekit-smoke'], 'tsx scripts/rustdesk-ivekit-smoke.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const infraEnvExample = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  for (const content of [envExample, infraEnvExample]) {
    assert.match(content, /^OPC_RUSTDESK_IVEKIT_BASE_URL=/m);
    assert.match(content, /^OPC_RUSTDESK_IVEKIT_RUSTDESK_ID=/m);
    assert.match(content, /^OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID=/m);
  }
});

async function expectRustDeskIveKitLaunchPlanRejection(input: {
  externalId: string;
  launchPlan: (launchUrl: string) => Record<string, unknown>;
  expected: RegExp;
}): Promise<{ calls: string[]; cleanupAttempted: boolean }> {
  const calls: string[] = [];
  let cleanupAttempted = false;
  const launchUrl = signedLaunchUrl(input.externalId);
  const remoteSessionId = `${input.externalId}_remote`;
  const deviceId = `${input.externalId}_device`;
  const plan = {
    external_id: input.externalId,
    status: 'active',
    launch_url: launchUrl,
    target: {
      type: 'device',
      id: '123456789',
      display_name: 'RustDesk iveKit smoke device'
    },
    permissions: RUSTDESK_IVEKIT_SMOKE_SCOPES,
    runtime: {
      rustdesk_id: '123456789',
      id_server: 'rustdesk-id.example.com',
      relay_server: 'rustdesk-relay.example.com',
      server_key_fingerprint: 'sha256:publickeyfingerprint',
      public_key_configured: 'true',
      public_key_source: 'env'
    },
    client_config: {
      public_key_configured: true,
      public_key_source: 'env',
      manual_fields: {
        id_server: 'rustdesk-id.example.com',
        relay_server: 'rustdesk-relay.example.com',
        key: 'public-key'
      }
    },
    actions: {
      can_launch: true,
      open_url: launchUrl,
      protocol_url: `rustdesk://connect/123456789?session=${input.externalId}`
    },
    ...input.launchPlan(launchUrl)
  };

  await assert.rejects(
    runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: `${input.externalId}-business-ref`
      }),
      async (request, init = {}) => {
        const url = new URL(String(request));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: `${input.externalId}_collab` });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: remoteSessionId });
        }
        if (method === 'POST' && url.pathname === `/api/collaboration/remote-assistance/${remoteSessionId}/consent/grant`) {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
          return jsonResponse(201, {
            id: deviceId,
            rustdesk_id: '123456789',
            display_name: 'RustDesk iveKit smoke device'
          });
        }
        if (method === 'POST' && url.pathname === `/api/ivekit/rustdesk/devices/${deviceId}/heartbeat`) {
          return jsonResponse(201, { runtime_status: 'online' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
          return jsonResponse(200, [{ id: deviceId, rustdesk_id: '123456789' }]);
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
          return jsonResponse(201, {
            provider: 'rustdesk',
            external_id: input.externalId,
            launch_url: launchUrl,
            status: 'active'
          });
        }
        if (method === 'GET' && url.pathname === `/api/ivekit/rustdesk/gateway-sessions/${input.externalId}/launch`) {
          return jsonResponse(200, plan);
        }
        if (method === 'DELETE' && url.pathname === `/api/ivekit/rustdesk/gateway-sessions/${input.externalId}`) {
          cleanupAttempted = true;
          return new Response(null, { status: 204 });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    ),
    input.expected
  );

  return { calls, cleanupAttempted };
}

async function expectRustDeskIveKitEndedLaunchPlanRejection(input: {
  externalId: string;
  endedLaunchPlan: (launchUrl: string) => Record<string, unknown>;
  expected: RegExp;
}): Promise<{ calls: string[]; ended: boolean }> {
  const calls: string[] = [];
  const launchUrl = signedLaunchUrl(input.externalId);
  const remoteSessionId = `${input.externalId}_remote`;
  const deviceId = `${input.externalId}_device`;
  let ended = false;
  const auditEvents: Array<Record<string, unknown>> = [
    {
      external_id: input.externalId,
      event_type: 'remote.gateway_session.created',
      actor_identity: 'agent_ivekit_rustdesk_smoke',
      target: '123456789',
      metadata: { rustdesk_id: '123456789' },
      occurred_at: '2026-07-04T09:00:00.000Z'
    }
  ];

  const activePlan = {
    external_id: input.externalId,
    status: 'active',
    launch_url: launchUrl,
    target: {
      type: 'device',
      id: '123456789',
      display_name: 'RustDesk iveKit smoke device'
    },
    permissions: RUSTDESK_IVEKIT_SMOKE_SCOPES,
    runtime: {
      rustdesk_id: '123456789',
      id_server: 'rustdesk-id.example.com',
      relay_server: 'rustdesk-relay.example.com',
      server_key_fingerprint: 'sha256:publickeyfingerprint',
      public_key_configured: 'true',
      public_key_source: 'env'
    },
    client_config: {
      public_key_configured: true,
      public_key_source: 'env',
      manual_fields: {
        id_server: 'rustdesk-id.example.com',
        relay_server: 'rustdesk-relay.example.com',
        key: 'public-key'
      }
    },
    actions: {
      can_launch: true,
      open_url: launchUrl,
      protocol_url: `rustdesk://connect/123456789?session=${input.externalId}`
    }
  };
  const endedPlan = {
    ...activePlan,
    status: 'ended',
    launch_url: '',
    actions: {
      can_launch: false,
      open_url: '',
      protocol_url: ''
    },
    ...input.endedLaunchPlan(launchUrl)
  };

  await assert.rejects(
    runRustDeskIveKitSmoke(
      createRustDeskIveKitSmokeConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_API_KEY: 'opc-api-key',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_IVEKIT_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_IVEKIT_BUSINESS_REF_ID: `${input.externalId}-business-ref`
      }),
      async (request, init = {}) => {
        const url = new URL(String(request));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.pathname}${url.search}`);

        if (method === 'POST' && url.pathname === '/api/collaboration/sessions') {
          return jsonResponse(201, { id: `${input.externalId}_collab` });
        }
        if (method === 'POST' && url.pathname === '/api/collaboration/remote-assistance/sessions') {
          return jsonResponse(201, { id: remoteSessionId });
        }
        if (method === 'POST' && url.pathname === `/api/collaboration/remote-assistance/${remoteSessionId}/consent/grant`) {
          return jsonResponse(201, { event_type: 'granted' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/client-config') {
          return jsonResponse(200, {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            public_key_configured: true,
            public_key: 'public-key',
            server_key_fingerprint: 'sha256:publickeyfingerprint',
            manual_fields: {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              key: 'public-key'
            }
          });
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/devices') {
          return jsonResponse(201, {
            id: deviceId,
            rustdesk_id: '123456789',
            display_name: 'RustDesk iveKit smoke device'
          });
        }
        if (method === 'POST' && url.pathname === `/api/ivekit/rustdesk/devices/${deviceId}/heartbeat`) {
          return jsonResponse(201, { runtime_status: 'online' });
        }
        if (method === 'GET' && url.pathname === '/api/ivekit/rustdesk/devices/by-ref') {
          return jsonResponse(200, [{ id: deviceId, rustdesk_id: '123456789' }]);
        }
        if (method === 'POST' && url.pathname === '/api/ivekit/rustdesk/gateway-sessions') {
          return jsonResponse(201, {
            provider: 'rustdesk',
            external_id: input.externalId,
            launch_url: launchUrl,
            status: 'active'
          });
        }
        if (method === 'GET' && url.pathname === `/api/ivekit/rustdesk/gateway-sessions/${input.externalId}/launch`) {
          return jsonResponse(200, ended ? endedPlan : activePlan);
        }
        if (method === 'GET' && url.pathname === '/remote/rustdesk/launch') {
          return new Response(`<title>RustDesk Remote Launch</title>${input.externalId}`, { status: 200 });
        }
        if (method === 'POST' && url.pathname === `/api/ivekit/rustdesk/gateway-sessions/${input.externalId}/events`) {
          const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
          const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? body.metadata as Record<string, unknown>
            : {};
          if (ended) {
            return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
          }
          if (body.event_type === 'remote.rustdesk.clipboard.synced' && metadata.direction === 'sideways') {
            return jsonResponse(400, {
              error: 'RustDesk clipboard event metadata.direction must be one of agent_to_device, device_to_agent'
            });
          }
          auditEvents.push({
            external_id: input.externalId,
            event_type: body.event_type,
            actor_identity: body.actor_identity,
            target: body.target,
            metadata: body.metadata || {},
            occurred_at: '2026-07-04T09:00:02.000Z'
          });
          return jsonResponse(201, { event: auditEvents.at(-1) });
        }
        if (method === 'GET' && url.pathname === `/api/ivekit/rustdesk/gateway-sessions/${input.externalId}/audit`) {
          return jsonResponse(200, { events: auditEvents });
        }
        if (method === 'DELETE' && url.pathname === `/api/ivekit/rustdesk/gateway-sessions/${input.externalId}`) {
          ended = true;
          auditEvents.push({
            external_id: input.externalId,
            event_type: 'remote.gateway_session.ended',
            actor_identity: 'agent_ivekit_rustdesk_smoke',
            target: '123456789',
            metadata: { rustdesk_id: '123456789' },
            occurred_at: '2026-07-04T09:00:03.000Z'
          });
          return new Response(null, { status: 204 });
        }
        if (method === 'GET' && url.pathname === `/api/collaboration/remote-assistance/${remoteSessionId}/timeline`) {
          return jsonResponse(200, {
            session: { id: remoteSessionId },
            consent_events: [{ event_type: 'granted' }],
            tool_sessions: [{ id: `${input.externalId}_tool`, provider: 'rustdesk', external_id: input.externalId, status: 'ended' }],
            audit_events: [
              { event_type: 'remote.rustdesk.control_action.performed' },
              { event_type: 'remote.rustdesk.file_transfer.started' },
              { event_type: 'remote.rustdesk.file_transfer.completed' },
              { event_type: 'remote.rustdesk.recording.started' },
              { event_type: 'remote.rustdesk.recording.stopped' },
              { event_type: 'remote.rustdesk.clipboard.synced' },
              { event_type: 'remote.gateway_session.ended' },
              { event_type: 'remote.tool_session.ended' }
            ],
            evidence: []
          });
        }

        return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
      }
    ),
    input.expected
  );

  return { calls, ended };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function signedLaunchUrl(externalId: string, tokenChar = 'a'): string {
  return `https://opc.example.com/remote/rustdesk/launch?session_id=${externalId}&token=${tokenChar.repeat(64)}&expires_at=2099-01-01T00:00:00.000Z`;
}

function rustDeskIveKitLaunchPlanBody(
  externalId: string,
  launchUrl: string,
  options: { status?: string; canLaunch?: boolean } = {}
): Record<string, unknown> {
  const status = options.status || 'active';
  const canLaunch = options.canLaunch ?? true;
  return {
    external_id: externalId,
    status,
    launch_url: canLaunch ? launchUrl : '',
    target: {
      type: 'device',
      id: '123456789',
      display_name: 'RustDesk iveKit smoke device'
    },
    permissions: RUSTDESK_IVEKIT_SMOKE_SCOPES,
    runtime: {
      rustdesk_id: '123456789',
      id_server: 'rustdesk-id.example.com',
      relay_server: 'rustdesk-relay.example.com',
      server_key_fingerprint: 'sha256:publickeyfingerprint',
      public_key_configured: 'true',
      public_key_source: 'env'
    },
    client_config: {
      public_key_configured: true,
      public_key_source: 'env',
      manual_fields: {
        id_server: 'rustdesk-id.example.com',
        relay_server: 'rustdesk-relay.example.com',
        key: 'public-key'
      }
    },
    actions: {
      can_launch: canLaunch,
      open_url: canLaunch ? launchUrl : '',
      protocol_url: canLaunch ? `rustdesk://connect/123456789?session=${externalId}` : ''
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
