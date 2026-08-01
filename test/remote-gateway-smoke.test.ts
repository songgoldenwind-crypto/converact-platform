import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { test } from 'node:test';

import {
  createRemoteGatewaySmokeConfigFromEnv,
  runRemoteGatewaySmoke
} from '../scripts/remote-gateway-smoke.js';
import type { RemoteConsentScope } from '../src/agent-runtime/collaboration/types.js';

test('remote gateway smoke config defaults to RustDesk and validates gateway inputs', () => {
  const defaultRustDesk = createRemoteGatewaySmokeConfigFromEnv({
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
    CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1'
  });
  assert.equal(defaultRustDesk.provider, 'rustdesk');
  assert.equal(defaultRustDesk.baseUrl, 'http://converact.local');
  assert.equal(defaultRustDesk.apiToken, 'rustdesk-token');
  assert.deepEqual(defaultRustDesk.permissions, [
    'view_screen',
    'control_mouse_keyboard',
    'record_screen',
    'transfer_file',
    'clipboard'
  ]);
  const edgeTenantRustDesk = createRemoteGatewaySmokeConfigFromEnv({
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
    CONVERACT_COLLABORATION_API_KEY: 'collaboration-key',
    CONVERACT_RUSTDESK_EDGE_TENANT_ID: 'tenant_from_edge',
    CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rdesk-device-1',
    CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE: '1'
  });
  assert.equal(edgeTenantRustDesk.tenantId, 'tenant_from_edge');

  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_REMOTE_GATEWAY_PROVIDER: 'meshcentral',
        CONVERACT_REMOTE_GATEWAY_API_TOKEN: 'gateway-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1'
      }),
    /CONVERACT_REMOTE_GATEWAY_BASE_URL is required/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_REMOTE_GATEWAY_PROVIDER: 'meshcentral',
        CONVERACT_REMOTE_GATEWAY_BASE_URL: 'http://mesh.local',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1'
      }),
    /CONVERACT_REMOTE_GATEWAY_API_TOKEN is required/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_REMOTE_GATEWAY_PROVIDER: 'meshcentral',
        CONVERACT_REMOTE_GATEWAY_BASE_URL: 'http://mesh.local',
        CONVERACT_REMOTE_GATEWAY_API_TOKEN: 'gateway-token'
      }),
    /CONVERACT_REMOTE_GATEWAY_TARGET_ID is required/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_REMOTE_GATEWAY_PROVIDER: 'unknown',
        CONVERACT_REMOTE_GATEWAY_BASE_URL: 'http://mesh.local',
        CONVERACT_REMOTE_GATEWAY_API_TOKEN: 'gateway-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1'
      }),
    /CONVERACT_REMOTE_GATEWAY_PROVIDER must be meshcentral, guacamole, or rustdesk/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rdesk-device-1',
        CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE: '1'
      }),
    /CONVERACT_REMOTE_GATEWAY_TENANT_ID, CONVERACT_RUSTDESK_EDGE_TENANT_ID, or CONVERACT_TENANT_ID is required when CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE=1/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rdesk-device-1',
        CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE: '1'
      }),
    /CONVERACT_API_KEY or CONVERACT_COLLABORATION_API_KEY is required when CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE=1/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1',
        CONVERACT_RUSTDESK_CHECK_TCP_PORTS: '21115,not-a-port'
      }),
    /CONVERACT_RUSTDESK_CHECK_TCP_PORTS contains invalid TCP port: not-a-port/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1',
        CONVERACT_RUSTDESK_CHECK_UDP_PORTS: '21116,nope'
      }),
    /CONVERACT_RUSTDESK_CHECK_UDP_PORTS contains invalid UDP port: nope/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'ftp://converact.local',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1'
      }),
    /CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL must use http\(s\)/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_REMOTE_GATEWAY_PROVIDER: 'meshcentral',
        CONVERACT_REMOTE_GATEWAY_BASE_URL: 'ftp://mesh.local',
        CONVERACT_REMOTE_GATEWAY_API_TOKEN: 'gateway-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1'
      }),
    /CONVERACT_REMOTE_GATEWAY_BASE_URL must use http\(s\)/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1',
        CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS: 'abc'
      }),
    /CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS must be a number >= 100/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1',
        CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS: '99'
      }),
    /CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS must be a number >= 100/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1',
        CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS: 'soon'
      }),
    /CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS must be a number >= 100/
  );
  assert.throws(
    () =>
      createRemoteGatewaySmokeConfigFromEnv({
        CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
        CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
        CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1',
        CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS: '0'
      }),
    /CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS must be a number >= 100/
  );
});

test('remote gateway smoke uses RustDesk control-plane env fallbacks', () => {
  const config = createRemoteGatewaySmokeConfigFromEnv({
    CONVERACT_REMOTE_GATEWAY_PROVIDER: 'rustdesk',
    CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://converact-rustdesk.example.com',
    CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
    CONVERACT_REMOTE_GATEWAY_API_TOKEN: 'remote-token',
    CONVERACT_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    CONVERACT_REMOTE_GATEWAY_TARGET_ID: '123456789',
    CONVERACT_REMOTE_GATEWAY_CHECK_LAUNCH_URL: '1',
    CONVERACT_RUSTDESK_REQUIRE_PROTOCOL_URL: 'yes',
    CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE: 'yes',
    CONVERACT_RUSTDESK_CHECK_OPERATION_AUDIT: 'yes',
    CONVERACT_API_KEY: 'converact-api-key'
  });

  assert.equal(config.provider, 'rustdesk');
  assert.equal(config.baseUrl, 'https://converact-rustdesk.example.com');
  assert.equal(config.apiToken, 'rustdesk-token');
  assert.equal(config.tenantId, 'tenant_led');
  assert.equal(config.target.id, '123456789');
  assert.equal(config.checkLaunchUrl, true);
  assert.equal((config as { rustdeskRequireProtocolUrl?: boolean }).rustdeskRequireProtocolUrl, true);
  assert.equal((config as { rustdeskCheckDeviceOnline?: boolean }).rustdeskCheckDeviceOnline, true);
  assert.equal((config as { rustdeskCheckOperationAudit?: boolean }).rustdeskCheckOperationAudit, true);
  assert.equal((config as { collaborationApiKey?: string }).collaborationApiKey, 'converact-api-key');
});

test('remote gateway smoke is wired into package scripts and env example', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['smoke:remote-gateway'], 'tsx scripts/remote-gateway-smoke.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(
    envExample,
    /^CONVERACT_REMOTE_GATEWAY_CONSENT_SCOPES=view_screen,control_mouse_keyboard,record_screen,transfer_file,clipboard$/m
  );
  for (const key of [
    'CONVERACT_REMOTE_GATEWAY_PROVIDER=',
    'CONVERACT_REMOTE_GATEWAY_BASE_URL=',
    'CONVERACT_REMOTE_GATEWAY_API_TOKEN=',
    'CONVERACT_COLLABORATION_API_KEY=',
    'CONVERACT_REMOTE_GATEWAY_TENANT_ID=',
    'CONVERACT_REMOTE_GATEWAY_TARGET_TYPE=',
    'CONVERACT_REMOTE_GATEWAY_TARGET_ID=',
    'CONVERACT_REMOTE_GATEWAY_CHECK_LAUNCH_URL=',
    'CONVERACT_REMOTE_GATEWAY_CONSENT_SCOPES=',
    'CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL=',
    'CONVERACT_RUSTDESK_ID_SERVER=',
    'CONVERACT_RUSTDESK_RELAY_SERVER=',
    'CONVERACT_RUSTDESK_API_SERVER=',
    'CONVERACT_RUSTDESK_PUBLIC_KEY=',
    'CONVERACT_RUSTDESK_PUBLIC_KEY_FILE=',
    'CONVERACT_RUSTDESK_SERVER_KEY=',
    'CONVERACT_RUSTDESK_LAUNCH_BASE_URL=',
    'CONVERACT_RUSTDESK_LAUNCH_SECRET=',
    'CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE=',
    'CONVERACT_RUSTDESK_REQUIRE_PROTOCOL_URL=',
    'CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE=',
    'CONVERACT_RUSTDESK_CHECK_OPERATION_AUDIT=',
    'CONVERACT_RUSTDESK_API_TOKEN=',
    'CONVERACT_RUSTDESK_CHECK_SERVER_PORTS=',
    'CONVERACT_RUSTDESK_CHECK_HOST=',
    'CONVERACT_RUSTDESK_CHECK_TCP_PORTS=',
    'CONVERACT_RUSTDESK_CHECK_UDP_PORTS=',
    'CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS='
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, 'm'));
  }
});

test('remote gateway smoke optionally checks RustDesk runtime TCP and UDP ports', async () => {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  const udpServer = createSocket('udp4');
  const udpMessageReceived = new Promise<void>((resolve) => {
    udpServer.once('message', () => resolve());
  });
  await new Promise<void>((resolve) => udpServer.bind(0, '127.0.0.1', resolve));
  const udpAddress = udpServer.address();
  assert(udpAddress && typeof udpAddress === 'object');
  const udpPort = udpAddress.port;

  try {
    const config = createRemoteGatewaySmokeConfigFromEnv({
      CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact.local',
      CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
      CONVERACT_REMOTE_GATEWAY_TARGET_ID: '123456789',
      CONVERACT_RUSTDESK_CHECK_SERVER_PORTS: '1',
      CONVERACT_RUSTDESK_ID_SERVER: '127.0.0.1',
      CONVERACT_RUSTDESK_CHECK_TCP_PORTS: String(port),
      CONVERACT_RUSTDESK_CHECK_UDP_PORTS: String(udpPort),
      CONVERACT_RUSTDESK_CHECK_OPERATION_AUDIT: '0',
      CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS: '250'
    });
    let ended = false;
    let postedAuditEvent = false;
    const result = await runRemoteGatewaySmoke(config, async (input, init = {}) => {
      const url = String(input);
      const method = init.method || 'GET';
      const { pathname } = new URL(url);

      if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
        return jsonResponse(200, {
          id_server: '127.0.0.1',
          relay_server: '127.0.0.1',
          public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'file',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
            id_server: '127.0.0.1',
            relay_server: '127.0.0.1',
            key: 'public-key'
          }
        });
      }
      if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
        return jsonResponse(201, {
          external_id: 'rustdesk-port-check-session',
          launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-port-check-session&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen'],
          metadata: { rustdesk_id: '123456789' }
        });
      }
      if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-port-check-session/launch') {
        return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-port-check-session', {
          idServer: '127.0.0.1',
          relayServer: '127.0.0.1',
          ...(ended ? { status: 'ended', canLaunch: false } : {})
        }));
      }
      if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-port-check-session/events') {
        const body = JSON.parse(String(init.body || '{}')) as { event_type?: string };
        if (ended && String(body.event_type || '') === 'remote.rustdesk.file_transfer.started') {
          return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
        }
        postedAuditEvent = true;
        return jsonResponse(201, {
          event: {
            external_id: 'rustdesk-port-check-session',
            event_type: 'remote.rustdesk.smoke.probe',
            actor_identity: 'agent_gateway_smoke',
            target: '123456789',
            metadata: { source: 'remote-gateway-smoke' },
            occurred_at: '2026-07-03T00:00:00.500Z'
          }
        });
      }
      if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-port-check-session/audit') {
        return jsonResponse(200, {
          events: [
            {
              external_id: 'rustdesk-port-check-session',
              event_type: 'remote.gateway_session.created',
              actor_identity: 'agent_gateway_smoke',
              target: '123456789',
              metadata: { rustdesk_id: '123456789' },
              occurred_at: '2026-07-03T00:00:00.000Z'
            },
            ...(postedAuditEvent
              ? [
                {
                  external_id: 'rustdesk-port-check-session',
                  event_type: 'remote.rustdesk.smoke.probe',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { source: 'remote-gateway-smoke' },
                  occurred_at: '2026-07-03T00:00:00.500Z'
                }
              ]
              : []),
            ...(ended
              ? [
                {
                  external_id: 'rustdesk-port-check-session',
                  event_type: 'remote.gateway_session.ended',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { rustdesk_id: '123456789' },
                  occurred_at: '2026-07-03T00:00:01.000Z'
                }
              ]
              : [])
          ]
        });
      }
      if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-port-check-session') {
        ended = true;
        return new Response(null, { status: 204 });
      }

      return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
    });

    assert.deepEqual(result.rustdeskRuntimePorts, {
      host: '127.0.0.1',
      checked: [port],
      udpChecked: [udpPort]
    });
    assert.equal(result.steps.some((step) => step.name === `rustdesk_tcp_port_${port}` && step.status === 200), true);
    assert.equal(result.steps.some((step) => step.name === `rustdesk_udp_port_${udpPort}` && step.status === 200), true);
    assert.equal(result.steps.some((step) => step.name === 'rustdesk_launch_plan' && step.status === 200), true);
    await Promise.race([
      udpMessageReceived,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('UDP probe was not received')), 250))
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    udpServer.close();
  }
});

test('remote gateway smoke rejects RustDesk client config without a top-level public key', async () => {
  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        rustDeskSuccessfulSmokeFetch({
          public_key: undefined
        })
      ),
    /RustDesk client config public_key is required/
  );
});

test('remote gateway smoke reports unreadable RustDesk public key files', async () => {
  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        rustDeskSuccessfulSmokeFetch({
          public_key: '',
          public_key_configured: false,
          public_key_file: '/etc/rustdesk/id_ed25519.pub',
          server_key_fingerprint: ''
        })
      ),
    /RustDesk client config public key file cannot be read: \/etc\/rustdesk\/id_ed25519\.pub/
  );
});

test('remote gateway smoke rejects RustDesk client config without a server key fingerprint', async () => {
  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        rustDeskSuccessfulSmokeFetch({
          server_key_fingerprint: undefined
        })
      ),
    /RustDesk client config server_key_fingerprint is required/
  );
});

test('remote gateway smoke rejects RustDesk client config without manual key field', async () => {
  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'file',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                relay_server: 'rustdesk-relay.example.com'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-manual-key-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-manual-key-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-manual-key-1/audit') {
            return jsonResponse(200, { events: [] });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-manual-key-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk client config manual_fields.key is required/
  );
});

test('remote gateway smoke rejects RustDesk client config without manual id server field', async () => {
  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'file',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                relay_server: 'rustdesk-relay.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-manual-id-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-manual-id-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-manual-id-1/audit') {
            return jsonResponse(200, { events: [] });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-manual-id-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk client config manual_fields.id_server is required/
  );
});

test('remote gateway smoke rejects RustDesk client config with mismatched manual id server', async () => {
  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'file',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'wrong-id.example.com',
                relay_server: 'rustdesk-relay.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-manual-id-mismatch-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-manual-id-mismatch-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-manual-id-mismatch-1/audit') {
            return jsonResponse(200, { events: [] });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-manual-id-mismatch-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk client config manual_fields.id_server must match id_server/
  );
});

test('remote gateway smoke rejects RustDesk client config with mismatched manual relay server', async () => {
  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'file',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                relay_server: 'wrong-relay.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-manual-relay-mismatch-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-manual-relay-mismatch-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-manual-relay-mismatch-1/audit') {
            return jsonResponse(200, { events: [] });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-manual-relay-mismatch-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk client config manual_fields.relay_server must match relay_server/
  );
});

test('remote gateway smoke rejects RustDesk client config with mismatched manual key', async () => {
  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              public_key: 'actual-public-key',
              public_key_configured: true,
              public_key_source: 'file',
              server_key_fingerprint: 'sha256:actual-public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                relay_server: 'rustdesk-relay.example.com',
                key: 'wrong-public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-manual-key-mismatch-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-manual-key-mismatch-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-manual-key-mismatch-1/audit') {
            return jsonResponse(200, { events: [] });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-manual-key-mismatch-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk client config manual_fields.key must match public_key/
  );
});

test('remote gateway smoke rejects RustDesk client config with mismatched manual API server', async () => {
  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              relay_server: 'rustdesk-relay.example.com',
              api_server: 'https://rustdesk-api.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'file',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                relay_server: 'rustdesk-relay.example.com',
                api_server: 'https://wrong-api.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-manual-api-mismatch-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-manual-api-mismatch-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk client config manual_fields.api_server must match api_server/
  );
});

test('remote gateway smoke creates audits and ends a MeshCentral session', async () => {
  const calls: Array<{ method: string; url: string; body?: unknown; authorization?: string }> = [];
  let ended = false;

  const result = await runRemoteGatewaySmoke(
    {
      provider: 'meshcentral',
      baseUrl: 'http://mesh.local',
      apiToken: 'gateway-token',
      actorIdentity: 'agent_gateway_smoke',
      target: {
        type: 'device',
        id: 'device-1',
        display_name: 'Smoke device'
      },
      permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard']
    },
    async (input, init = {}) => {
      const url = String(input);
      const method = init.method || 'GET';
      const authorization = (init.headers as Record<string, string> | undefined)?.authorization;
      calls.push({
        method,
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        authorization
      });
      const { pathname } = new URL(url);

      if (method === 'POST' && pathname === '/api/opc/meshcentral/sessions') {
        return jsonResponse(201, {
          external_id: 'mesh-session-1',
          launch_url: 'https://mesh.local/control/mesh-session-1',
          target: { type: 'device', id: 'device-1', display_name: 'Smoke device' },
          permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
          metadata: { node_id: 'device-1' }
        });
      }
      if (method === 'GET' && pathname === '/api/opc/meshcentral/sessions/mesh-session-1/audit') {
        return jsonResponse(200, {
          events: [
            {
              external_id: 'mesh-session-1',
              event_type: 'remote.gateway_session.created',
              actor_identity: 'agent_gateway_smoke',
              target: 'device-1',
              metadata: { node_id: 'device-1' },
              occurred_at: '2026-06-30T00:00:00.000Z'
            },
            ...(ended
              ? [
                {
                  external_id: 'mesh-session-1',
                  event_type: 'remote.gateway_session.ended',
                  actor_identity: 'agent_gateway_smoke',
                  target: 'device-1',
                  metadata: { node_id: 'device-1' },
                  occurred_at: '2026-06-30T00:00:01.000Z'
                }
              ]
              : [])
          ]
        });
      }
      if (method === 'DELETE' && pathname === '/api/opc/meshcentral/sessions/mesh-session-1') {
        ended = true;
        return new Response(null, { status: 204 });
      }

      return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
    }
  );

  assert.equal(result.provider, 'meshcentral');
  assert.equal(result.externalId, 'mesh-session-1');
  assert.equal(result.launchUrl, 'https://mesh.local/control/mesh-session-1');
  assert.equal(result.auditEvents, 2);
  assert.deepEqual(
    result.steps.map((step) => `${step.name}:${step.status}`),
    ['create_gateway_session:201', 'list_gateway_audit:200', 'end_gateway_session:204', 'list_gateway_audit_after_end:200']
  );
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    'POST /api/opc/meshcentral/sessions',
    'GET /api/opc/meshcentral/sessions/mesh-session-1/audit',
    'DELETE /api/opc/meshcentral/sessions/mesh-session-1',
    'GET /api/opc/meshcentral/sessions/mesh-session-1/audit'
  ]);
  assert.equal(calls[0]?.authorization, 'Bearer gateway-token');
  assert.deepEqual(calls[0]?.body, {
    target: { type: 'device', id: 'device-1', display_name: 'Smoke device' },
    permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
    actor_identity: 'agent_gateway_smoke',
    metadata: { source: 'remote-gateway-smoke' }
  });
});

test('remote gateway smoke creates audits and ends a RustDesk session', async () => {
  const calls: Array<{ method: string; url: string; body?: unknown; authorization?: string }> = [];
  let ended = false;
  const postedAuditEvents = new Map<string, Record<string, unknown>>();

  const result = await runRemoteGatewaySmoke(
    {
      provider: 'rustdesk',
      baseUrl: 'http://converact.local',
      apiToken: 'rustdesk-token',
      tenantId: 'tenant_led',
      collaborationApiKey: 'converact-api-key',
      rustdeskCheckDeviceOnline: true,
      rustdeskCheckOperationAudit: true,
      actorIdentity: 'agent_gateway_smoke',
      target: {
        type: 'device',
        id: 'rdesk-device-1',
        display_name: 'RustDesk smoke device'
      },
      permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard']
    },
    async (input, init = {}) => {
      const url = String(input);
      const method = init.method || 'GET';
      const authorization = (init.headers as Record<string, string> | undefined)?.authorization;
      calls.push({
        method,
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        authorization
      });
      const { pathname } = new URL(url);

      if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
        return jsonResponse(200, {
          id_server: 'rustdesk-id.example.com',
          relay_server: 'rustdesk-relay.example.com',
          public_key_configured: true,
          public_key: 'public-key',
          public_key_source: 'file',
          server_key_fingerprint: 'sha256:public-key-fingerprint',
          manual_fields: {
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            key: 'public-key'
          }
        });
      }
      if (method === 'GET' && pathname === '/api/collaboration/rustdesk/devices/rdesk-device-1') {
        return jsonResponse(200, {
          id: 'rdesk-device-1',
          tenant_id: 'tenant_led',
          business_ref_type: 'service_order',
          business_ref_id: 'order-rustdesk-smoke',
          rustdesk_id: '123456789',
          display_name: 'RustDesk smoke device',
          status: 'active',
          runtime_status: 'online',
          last_seen_at: '2099-07-04T00:00:00.000Z',
          last_seen_actor: 'rustdesk-edge-agent',
          metadata: {}
        });
      }
      if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
        return jsonResponse(201, {
          external_id: 'rustdesk-session-1',
          launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
          target: { type: 'device', id: '123456789', display_name: 'RustDesk smoke device' },
          permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
          metadata: { rustdesk_id: '123456789' }
        });
      }
      if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-1/launch') {
        return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-1', {
          idServer: 'rustdesk-id.example.com',
          relayServer: 'rustdesk-relay.example.com',
          ...(ended ? { status: 'ended', canLaunch: false } : {})
        }));
      }
      if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions') {
        const search = new URL(url).searchParams;
        const status = search.get('status');
        assert.equal(search.get('tenant_id'), 'tenant_led');
        return jsonResponse(200, {
          sessions: status === 'ended'
            ? [
              {
                external_id: 'rustdesk-session-1',
                status: 'ended',
                tenant_id: 'tenant_led'
              }
            ]
            : [
              {
                external_id: 'rustdesk-session-1',
                status: 'active',
                tenant_id: 'tenant_led'
              }
            ]
        });
      }
      if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-1/events') {
        const body = JSON.parse(String(init.body || '{}')) as { event_type?: string; target?: string; metadata?: Record<string, unknown> };
        const eventType = String(body.event_type || '');
        if (ended && eventType === 'remote.rustdesk.file_transfer.started') {
          return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
        }
        postedAuditEvents.set(eventType, body.metadata || { source: 'remote-gateway-smoke' });
        return jsonResponse(201, {
          event: {
            external_id: 'rustdesk-session-1',
            event_type: eventType,
            actor_identity: 'agent_gateway_smoke',
            target: body.target || 'rdesk-device-1',
            metadata: body.metadata || { source: 'remote-gateway-smoke' },
            occurred_at: '2026-07-03T00:00:00.500Z'
          }
        });
      }
      if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-1/audit') {
        return jsonResponse(200, {
          events: [
            {
              external_id: 'rustdesk-session-1',
              event_type: 'remote.gateway_session.created',
              actor_identity: 'agent_gateway_smoke',
              target: '123456789',
              metadata: { rustdesk_id: '123456789' },
              occurred_at: '2026-07-03T00:00:00.000Z'
            },
            ...Array.from(postedAuditEvents.entries()).map(([eventType, metadata], index) => ({
              external_id: 'rustdesk-session-1',
              event_type: eventType,
              actor_identity: 'agent_gateway_smoke',
              target: 'rdesk-device-1',
              metadata,
              occurred_at: `2026-07-03T00:00:00.${500 + index}Z`
            })),
            ...(ended
              ? [
                {
                  external_id: 'rustdesk-session-1',
                  event_type: 'remote.gateway_session.ended',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { rustdesk_id: '123456789' },
                  occurred_at: '2026-07-03T00:00:01.000Z'
                }
              ]
              : [])
          ]
        });
      }
      if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-1') {
        ended = true;
        return new Response(null, { status: 204 });
      }

      return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
    }
  );

  assert.equal(result.provider, 'rustdesk');
  assert.equal(result.externalId, 'rustdesk-session-1');
  assert.equal(result.launchUrl, 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z');
  assert.equal(result.auditEvents, 9);
  assert.deepEqual(result.rustdeskClientConfig, {
    apiServer: '',
    idServer: 'rustdesk-id.example.com',
    manualKey: 'public-key',
    relayServer: 'rustdesk-relay.example.com',
    publicKeyConfigured: true,
    publicKeySource: 'file',
    serverKeyFingerprint: 'sha256:public-key-fingerprint'
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'GET /api/collaboration/rustdesk/devices/rdesk-device-1',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-1/launch',
    'GET /api/opc/rustdesk/sessions',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-1/events',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-1/audit',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-1',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-1/audit',
    'GET /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-1/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-1',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-1/events',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-1/audit'
  ]);
  assert.equal(calls[0]?.authorization, 'Bearer rustdesk-token');
  assert.equal(calls[1]?.authorization, 'Bearer rustdesk-token');
  assert.deepEqual(calls[2]?.body, {
    target: { type: 'device', id: '123456789', display_name: 'RustDesk smoke device' },
    permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
    actor_identity: 'agent_gateway_smoke',
    metadata: {
      source: 'remote-gateway-smoke',
      tenant_id: 'tenant_led',
      rustdesk_target_mode: 'registered_device',
      rustdesk_device_id: 'rdesk-device-1',
      rustdesk_id: '123456789',
      target_id: 'rdesk-device-1',
      target_display_name: 'RustDesk smoke device',
      rustdesk_device_runtime_status: 'online',
      rustdesk_device_last_seen_at: '2099-07-04T00:00:00.000Z',
      rustdesk_device_last_seen_actor: 'rustdesk-edge-agent',
      business_ref_type: 'service_order',
      business_ref_id: 'order-rustdesk-smoke'
    }
  });
  assert.deepEqual(calls[5]?.body, {
    event_type: 'remote.rustdesk.smoke.probe',
    actor_identity: 'agent_gateway_smoke',
    target: 'rdesk-device-1',
    idempotency_key: 'remote-gateway-smoke:rustdesk-session-1:probe',
    metadata: { source: 'remote-gateway-smoke' }
  });
  assert.deepEqual(calls[6]?.body, calls[5]?.body);
  assert.deepEqual(calls.slice(7, 13).map((call) => (call.body as { event_type?: string }).event_type), [
    'remote.rustdesk.control_action.performed',
    'remote.rustdesk.file_transfer.started',
    'remote.rustdesk.file_transfer.completed',
    'remote.rustdesk.recording.started',
    'remote.rustdesk.recording.stopped',
    'remote.rustdesk.clipboard.synced'
  ]);
  assert.deepEqual(result.rustdeskOperationProbe, {
    eventTypes: [
      'remote.rustdesk.control_action.performed',
      'remote.rustdesk.file_transfer.started',
      'remote.rustdesk.file_transfer.completed',
      'remote.rustdesk.recording.started',
      'remote.rustdesk.recording.stopped',
      'remote.rustdesk.clipboard.synced'
    ]
  });
  assert.deepEqual(result.rustdeskRegisteredDevice, {
    deviceId: 'rdesk-device-1',
    rustdeskId: '123456789',
    displayName: 'RustDesk smoke device',
    runtimeStatus: 'online',
    lastSeenAt: '2099-07-04T00:00:00.000Z',
    lastSeenActor: 'rustdesk-edge-agent',
    businessRefType: 'service_order',
    businessRefId: 'order-rustdesk-smoke'
  });
  assert.deepEqual(result.rustdeskSessionList, {
    tenantId: 'tenant_led',
    activeFound: true,
    endedFound: true
  });
  assert.deepEqual(result.rustdeskEndedLaunchPlan, {
    status: 'ended',
    canLaunch: false
  });
  assert.equal(result.rustdeskEndRetried, true);
  assert.equal(result.rustdeskEndedEventRejected, true);
  assert.equal(result.rustdeskEndedEventAuditClean, true);
  assert.deepEqual(calls.at(-2)?.body, {
    event_type: 'remote.rustdesk.file_transfer.started',
    actor_identity: 'agent_gateway_smoke',
    target: 'rdesk-device-1',
    idempotency_key: 'remote-gateway-smoke:rustdesk-session-1:after-end-file-transfer',
    metadata: {
      source: 'remote-gateway-smoke',
      transfer_id: 'smoke-after-end-transfer-rustdesk-session-1',
      direction: 'upload'
    }
  });
  assert.equal(new URL(calls.at(-1)?.url || '').pathname, '/api/opc/rustdesk/sessions/rustdesk-session-1/audit');
});

test('remote gateway smoke cleans RustDesk sessions with invalid launch URLs', async () => {
  const cases = [
    {
      externalId: 'rustdesk-session-missing-launch-token-1',
      launchUrl: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-missing-launch-token-1',
      message: /RustDesk gateway launch_url token is required/
    },
    {
      externalId: 'rustdesk-session-malformed-launch-token-1',
      launchUrl: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-malformed-launch-token-1&token=launch-token&expires_at=2099-01-01T00:00:00.000Z',
      message: /RustDesk gateway launch_url token must be a 64 character hex HMAC/
    },
    {
      externalId: 'rustdesk-session-wrong-launch-path-1',
      launchUrl: 'https://converact.local/remote/other/launch?session_id=rustdesk-session-wrong-launch-path-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
      message: /RustDesk gateway launch_url path must be \/remote\/rustdesk\/launch/
    },
    {
      externalId: 'rustdesk-session-wrong-launch-protocol-1',
      launchUrl: 'ftp://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-wrong-launch-protocol-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
      message: /RustDesk gateway launch_url must be http\(s\)/
    }
  ];

  for (const scenario of cases) {
    const calls: Array<{ method: string; pathname: string }> = [];

    await assert.rejects(
      () =>
        runRemoteGatewaySmoke(
          {
            provider: 'rustdesk',
            baseUrl: 'http://converact.local',
            apiToken: 'rustdesk-token',
            actorIdentity: 'agent_gateway_smoke',
            target: { type: 'device', id: '123456789' },
            permissions: ['view_screen']
          },
          async (input, init = {}) => {
            const method = init.method || 'GET';
            const { pathname } = new URL(String(input));
            calls.push({ method, pathname });
            if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
              return jsonResponse(200, {
                id_server: 'rustdesk-id.example.com',
                public_key: 'public-key',
                public_key_configured: true,
                public_key_source: 'file',
                server_key_fingerprint: 'sha256:public-key-fingerprint',
                manual_fields: {
                  id_server: 'rustdesk-id.example.com',
                  key: 'public-key'
                }
              });
            }
            if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
              return jsonResponse(201, {
                external_id: scenario.externalId,
                launch_url: scenario.launchUrl,
                target: { type: 'device', id: '123456789' },
                permissions: ['view_screen'],
                metadata: { rustdesk_id: '123456789' }
              });
            }
            if (method === 'DELETE' && pathname === `/api/opc/rustdesk/sessions/${scenario.externalId}`) {
              return new Response(null, { status: 204 });
            }
            return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
          }
        ),
      scenario.message
    );

    assert.equal(
      calls.some((call) => call.method === 'DELETE' && call.pathname === `/api/opc/rustdesk/sessions/${scenario.externalId}`),
      true
    );
  }
});

test('remote gateway smoke rejects duplicated RustDesk audit probe events and cleans the session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];
  let ended = false;

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-duplicate-probe-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-duplicate-probe-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-duplicate-probe-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-duplicate-probe-1', {
              idServer: 'rustdesk-id.example.com'
            }));
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-duplicate-probe-1/events') {
            return jsonResponse(201, {
              event: {
                external_id: 'rustdesk-session-duplicate-probe-1',
                event_type: 'remote.rustdesk.smoke.probe',
                actor_identity: 'agent_gateway_smoke',
                target: '123456789',
                metadata: {
                  source: 'remote-gateway-smoke',
                  idempotency_key: 'remote-gateway-smoke:rustdesk-session-duplicate-probe-1:probe'
                },
                occurred_at: '2026-07-03T00:00:00.500Z'
              }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-duplicate-probe-1/audit') {
            return jsonResponse(200, {
              events: [
                {
                  external_id: 'rustdesk-session-duplicate-probe-1',
                  event_type: 'remote.gateway_session.created',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { rustdesk_id: '123456789' },
                  occurred_at: '2026-07-03T00:00:00.000Z'
                },
                {
                  external_id: 'rustdesk-session-duplicate-probe-1',
                  event_type: 'remote.rustdesk.smoke.probe',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { idempotency_key: 'remote-gateway-smoke:rustdesk-session-duplicate-probe-1:probe' },
                  occurred_at: '2026-07-03T00:00:00.500Z'
                },
                {
                  external_id: 'rustdesk-session-duplicate-probe-1',
                  event_type: 'remote.rustdesk.smoke.probe',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { idempotency_key: 'remote-gateway-smoke:rustdesk-session-duplicate-probe-1:probe' },
                  occurred_at: '2026-07-03T00:00:00.600Z'
                }
              ].concat(ended
                ? [
                  {
                    external_id: 'rustdesk-session-duplicate-probe-1',
                    event_type: 'remote.gateway_session.ended',
                    actor_identity: 'agent_gateway_smoke',
                    target: '123456789',
                    metadata: { rustdesk_id: '123456789' },
                    occurred_at: '2026-07-03T00:00:01.000Z'
                  }
                ]
                : [])
            });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-duplicate-probe-1') {
            ended = true;
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk smoke probe audit event must be idempotent/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-duplicate-probe-1/launch',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-duplicate-probe-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-duplicate-probe-1/events',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-duplicate-probe-1/audit',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-duplicate-probe-1'
  ]);
});

test('remote gateway smoke rejects empty audit events and cleans the RustDesk session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-empty-audit-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-empty-audit-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-empty-audit-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-empty-audit-1', {
              idServer: 'rustdesk-id.example.com'
            }));
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-empty-audit-1/events') {
            return jsonResponse(201, {
              event: {
                external_id: 'rustdesk-session-empty-audit-1',
                event_type: 'remote.rustdesk.smoke.probe',
                actor_identity: 'agent_gateway_smoke',
                target: '123456789',
                metadata: { source: 'remote-gateway-smoke' },
                occurred_at: '2026-07-03T00:00:00.500Z'
              }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-empty-audit-1/audit') {
            return jsonResponse(200, { events: [] });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-empty-audit-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /remote gateway audit events are required/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-empty-audit-1/launch',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-empty-audit-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-empty-audit-1/events',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-empty-audit-1/audit',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-empty-audit-1'
  ]);
});

test('remote gateway smoke rejects audit events from another session and cleans the RustDesk session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-wrong-audit-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-wrong-audit-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-wrong-audit-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-wrong-audit-1', {
              idServer: 'rustdesk-id.example.com'
            }));
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-wrong-audit-1/events') {
            return jsonResponse(201, {
              event: {
                external_id: 'rustdesk-session-wrong-audit-1',
                event_type: 'remote.rustdesk.smoke.probe',
                actor_identity: 'agent_gateway_smoke',
                target: '123456789',
                metadata: { source: 'remote-gateway-smoke' },
                occurred_at: '2026-07-03T00:00:00.500Z'
              }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-wrong-audit-1/audit') {
            return jsonResponse(200, {
              events: [
                {
                  external_id: 'rustdesk-session-other-1',
                  event_type: 'remote.gateway_session.created',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { rustdesk_id: '123456789' },
                  occurred_at: '2026-07-03T00:00:00.000Z'
                }
              ]
            });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-wrong-audit-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk gateway audit event external_id must match requested session/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-wrong-audit-1/launch',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-wrong-audit-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-wrong-audit-1/events',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-wrong-audit-1/audit',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-wrong-audit-1'
  ]);
});

test('remote gateway smoke rejects missing ended audit event after ending the RustDesk session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];
  let postedAuditEvent = false;

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-missing-ended-audit-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-missing-ended-audit-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-missing-ended-audit-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-missing-ended-audit-1', {
              idServer: 'rustdesk-id.example.com'
            }));
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-missing-ended-audit-1/events') {
            postedAuditEvent = true;
            return jsonResponse(201, {
              event: {
                external_id: 'rustdesk-session-missing-ended-audit-1',
                event_type: 'remote.rustdesk.smoke.probe',
                actor_identity: 'agent_gateway_smoke',
                target: '123456789',
                metadata: { source: 'remote-gateway-smoke' },
                occurred_at: '2026-07-03T00:00:00.500Z'
              }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-missing-ended-audit-1/audit') {
            return jsonResponse(200, {
              events: [
                {
                  external_id: 'rustdesk-session-missing-ended-audit-1',
                  event_type: 'remote.gateway_session.created',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { rustdesk_id: '123456789' },
                  occurred_at: '2026-07-03T00:00:00.000Z'
                },
                ...(postedAuditEvent
                  ? [
                    {
                      external_id: 'rustdesk-session-missing-ended-audit-1',
                      event_type: 'remote.rustdesk.smoke.probe',
                      actor_identity: 'agent_gateway_smoke',
                      target: '123456789',
                      metadata: { source: 'remote-gateway-smoke' },
                      occurred_at: '2026-07-03T00:00:00.500Z'
                    }
                  ]
                  : [])
              ]
            });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-missing-ended-audit-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /remote gateway audit must include the ended session event/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-missing-ended-audit-1/launch',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-missing-ended-audit-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-missing-ended-audit-1/events',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-missing-ended-audit-1/audit',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-missing-ended-audit-1',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-missing-ended-audit-1/audit'
  ]);
});

test('remote gateway smoke rejects a RustDesk launch plan with mismatched API server and cleans the session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              api_server: 'https://rustdesk-api.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                api_server: 'https://rustdesk-api.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-launch-api-mismatch-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-launch-api-mismatch-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-api-mismatch-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-launch-api-mismatch-1', {
              apiServer: 'https://wrong-api.example.com',
              idServer: 'rustdesk-id.example.com'
            }));
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-api-mismatch-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk launch plan runtime api_server must match client config/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-api-mismatch-1/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-launch-api-mismatch-1'
  ]);
});

test('remote gateway smoke rejects a RustDesk launch plan with mismatched server key fingerprint and cleans the session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];
  let ended = false;

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'file',
              server_key_fingerprint: 'sha256:client-config-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-launch-fingerprint-mismatch-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-launch-fingerprint-mismatch-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-fingerprint-mismatch-1/launch') {
            if (ended) {
              return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-launch-fingerprint-mismatch-1', {
                canLaunch: false,
                idServer: 'rustdesk-id.example.com',
                serverKeyFingerprint: 'sha256:wrong-fingerprint',
                status: 'ended'
              }));
            }
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-launch-fingerprint-mismatch-1', {
              idServer: 'rustdesk-id.example.com',
              serverKeyFingerprint: 'sha256:wrong-fingerprint'
            }));
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-fingerprint-mismatch-1/events') {
            const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
            return jsonResponse(201, {
              event: {
                external_id: 'rustdesk-session-launch-fingerprint-mismatch-1',
                event_type: body.event_type,
                actor_identity: body.actor_identity,
                target: body.target,
                metadata: body.metadata || {},
                occurred_at: '2026-07-04T00:00:00.000Z'
              }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-fingerprint-mismatch-1/audit') {
            return jsonResponse(200, {
              events: [
                {
                  external_id: 'rustdesk-session-launch-fingerprint-mismatch-1',
                  event_type: 'remote.gateway_session.created',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: {},
                  occurred_at: '2026-07-04T00:00:00.000Z'
                },
                {
                  external_id: 'rustdesk-session-launch-fingerprint-mismatch-1',
                  event_type: 'remote.rustdesk.smoke.probe',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: {},
                  occurred_at: '2026-07-04T00:00:01.000Z'
                },
                ...(ended
                  ? [
                    {
                      external_id: 'rustdesk-session-launch-fingerprint-mismatch-1',
                      event_type: 'remote.gateway_session.ended',
                      actor_identity: 'agent_gateway_smoke',
                      target: '123456789',
                      metadata: {},
                      occurred_at: '2026-07-04T00:00:02.000Z'
                    }
                  ]
                  : [])
              ]
            });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-fingerprint-mismatch-1') {
            ended = true;
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk launch plan runtime server_key_fingerprint must match client config/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-fingerprint-mismatch-1/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-launch-fingerprint-mismatch-1'
  ]);
});

test('remote gateway smoke rejects a RustDesk launch plan without client config manual fields and cleans the session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];
  let ended = false;
  let postedAuditEvent = false;

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-launch-client-config-missing-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-launch-client-config-missing-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-client-config-missing-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-launch-client-config-missing-1', {
              idServer: 'rustdesk-id.example.com',
              ...(ended ? { status: 'ended', canLaunch: false } : {}),
              omitClientConfig: true
            }));
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-client-config-missing-1/events') {
            postedAuditEvent = true;
            const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
            return jsonResponse(201, {
              event: {
                external_id: 'rustdesk-session-launch-client-config-missing-1',
                event_type: body.event_type,
                actor_identity: body.actor_identity,
                target: body.target,
                metadata: body.metadata || {},
                occurred_at: '2026-07-04T08:00:01.000Z'
              }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-client-config-missing-1/audit') {
            return jsonResponse(200, {
              events: [
                {
                  external_id: 'rustdesk-session-launch-client-config-missing-1',
                  event_type: 'remote.gateway_session.created',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { rustdesk_id: '123456789' },
                  occurred_at: '2026-07-04T08:00:00.000Z'
                },
                ...(postedAuditEvent
                  ? [
                    {
                      external_id: 'rustdesk-session-launch-client-config-missing-1',
                      event_type: 'remote.rustdesk.smoke.probe',
                      actor_identity: 'agent_gateway_smoke',
                      target: '123456789',
                      metadata: { source: 'remote-gateway-smoke' },
                      occurred_at: '2026-07-04T08:00:01.000Z'
                    }
                  ]
                  : []),
                ...(ended
                  ? [
                    {
                      external_id: 'rustdesk-session-launch-client-config-missing-1',
                      event_type: 'remote.gateway_session.ended',
                      actor_identity: 'agent_gateway_smoke',
                      target: '123456789',
                      metadata: { rustdesk_id: '123456789' },
                      occurred_at: '2026-07-04T08:00:02.000Z'
                    }
                  ]
                  : [])
              ]
            });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-client-config-missing-1') {
            ended = true;
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk launch plan client_config.manual_fields.id_server is required/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-client-config-missing-1/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-launch-client-config-missing-1'
  ]);
});

test('remote gateway smoke rejects a RustDesk launch plan for another target and cleans the session', async () => {
  const result = await expectRustDeskLaunchPlanRejection({
    externalId: 'rustdesk-session-launch-target-mismatch-1',
    launchPlan: (externalId) => rustDeskLaunchPlanBody(externalId, {
      targetId: '987654321'
    }),
    expected: /RustDesk launch plan target.id must match target id/
  });

  assert.deepEqual(result.calls, [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-target-mismatch-1/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-launch-target-mismatch-1'
  ]);
});

test('remote gateway smoke rejects a RustDesk launch plan without requested permissions and cleans the session', async () => {
  const result = await expectRustDeskLaunchPlanRejection({
    externalId: 'rustdesk-session-launch-permissions-missing-1',
    permissions: ['view_screen', 'control_mouse_keyboard'],
    launchPlan: (externalId) => rustDeskLaunchPlanBody(externalId, {
      permissions: ['view_screen']
    }),
    expected: /RustDesk launch plan permissions must include requested scope control_mouse_keyboard/
  });

  assert.deepEqual(result.calls, [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-permissions-missing-1/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-launch-permissions-missing-1'
  ]);
});

test('remote gateway smoke rejects a RustDesk launch plan whose public key is not configured and cleans the session', async () => {
  const result = await expectRustDeskLaunchPlanRejection({
    externalId: 'rustdesk-session-launch-public-key-missing-1',
    launchPlan: (externalId) => rustDeskLaunchPlanBody(externalId, {
      clientPublicKeyConfigured: false,
      runtimePublicKeyConfigured: false
    }),
    expected: /RustDesk launch plan public key must be configured/
  });

  assert.deepEqual(result.calls, [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-public-key-missing-1/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-launch-public-key-missing-1'
  ]);
});

test('remote gateway smoke requires a RustDesk protocol URL when enabled and cleans the session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen'],
          rustdeskRequireProtocolUrl: true
        } as Parameters<typeof runRemoteGatewaySmoke>[0],
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-protocol-missing-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-protocol-missing-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-protocol-missing-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-protocol-missing-1', {
              idServer: 'rustdesk-id.example.com'
            }));
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-protocol-missing-1/audit') {
            return jsonResponse(200, { events: [] });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-protocol-missing-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk launch plan protocol_url is required/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-protocol-missing-1/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-protocol-missing-1'
  ]);
});

test('remote gateway smoke rejects a RustDesk protocol URL for a different target and cleans the session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen'],
          rustdeskRequireProtocolUrl: true
        } as Parameters<typeof runRemoteGatewaySmoke>[0],
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-protocol-wrong-target-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-protocol-wrong-target-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-protocol-wrong-target-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-protocol-wrong-target-1', {
              idServer: 'rustdesk-id.example.com',
              protocolUrl: 'rustdesk://connect/987654321?session=rustdesk-session-protocol-wrong-target-1'
            }));
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-protocol-wrong-target-1/audit') {
            return jsonResponse(200, { events: [] });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-protocol-wrong-target-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk launch plan protocol_url must reference the target RustDesk ID/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-protocol-wrong-target-1/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-protocol-wrong-target-1'
  ]);
});

test('remote gateway smoke rejects a RustDesk protocol URL without the rustdesk scheme and cleans the session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen'],
          rustdeskRequireProtocolUrl: true
        } as Parameters<typeof runRemoteGatewaySmoke>[0],
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-protocol-wrong-scheme-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-protocol-wrong-scheme-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-protocol-wrong-scheme-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-protocol-wrong-scheme-1', {
              idServer: 'rustdesk-id.example.com',
              protocolUrl: 'https://converact.local/connect/123456789?session=rustdesk-session-protocol-wrong-scheme-1'
            }));
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-protocol-wrong-scheme-1/audit') {
            return jsonResponse(200, { events: [] });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-protocol-wrong-scheme-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk launch plan protocol_url must use the rustdesk scheme/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-protocol-wrong-scheme-1/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-protocol-wrong-scheme-1'
  ]);
});

test('remote gateway smoke checks RustDesk launch page when enabled', async () => {
  const calls: Array<{ method: string; url: string; authorization?: string }> = [];
  const auditProbeBodies: Array<Record<string, unknown>> = [];
  let ended = false;
  let postedAuditEvent = false;

  const result = await runRemoteGatewaySmoke(
    {
      provider: 'rustdesk',
      baseUrl: 'http://converact.local',
      apiToken: 'rustdesk-token',
      actorIdentity: 'agent_gateway_smoke',
      target: { type: 'device', id: '123456789' },
      permissions: ['view_screen'],
      checkLaunchUrl: true
    },
    async (input, init = {}) => {
      const url = String(input);
      const method = init.method || 'GET';
      const authorization = (init.headers as Record<string, string> | undefined)?.authorization;
      calls.push({ method, url, authorization });
      const { pathname } = new URL(url);

      if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
        return jsonResponse(200, {
          id_server: 'rustdesk-id.example.com',
          public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
            id_server: 'rustdesk-id.example.com',
            key: 'public-key'
          }
        });
      }
      if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
        return jsonResponse(201, {
          external_id: 'rustdesk-session-launch-1',
          launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-launch-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen'],
          metadata: { rustdesk_id: '123456789' }
        });
      }
      if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-1/launch') {
        return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-launch-1', {
          idServer: 'rustdesk-id.example.com',
          ...(ended ? { status: 'ended', canLaunch: false } : {})
        }));
      }
      if (method === 'GET' && pathname === '/remote/rustdesk/launch') {
        if (ended) return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
        return new Response(
          '<!doctype html><title>RustDesk Remote Launch</title><main>rustdesk-session-launch-1</main>',
          {
            status: 200,
            headers: { 'content-type': 'text/html' }
          }
        );
      }
      if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-1/events') {
        const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
        if (ended && String(body.event_type || '') === 'remote.rustdesk.file_transfer.started') {
          return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
        }
        postedAuditEvent = true;
        auditProbeBodies.push(body);
        return jsonResponse(201, {
          event: {
            external_id: 'rustdesk-session-launch-1',
            event_type: 'remote.rustdesk.smoke.probe',
            actor_identity: 'agent_gateway_smoke',
            target: '123456789',
            metadata: { source: 'remote-gateway-smoke' },
            occurred_at: '2026-07-03T00:00:00.500Z'
          }
        });
      }
      if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-1/audit') {
        return jsonResponse(200, {
          events: [
            {
              external_id: 'rustdesk-session-launch-1',
              event_type: 'remote.gateway_session.created',
              actor_identity: 'agent_gateway_smoke',
              target: '123456789',
              metadata: { rustdesk_id: '123456789' },
              occurred_at: '2026-07-03T00:00:00.000Z'
            },
            ...(postedAuditEvent
              ? [
                {
                  external_id: 'rustdesk-session-launch-1',
                  event_type: 'remote.rustdesk.smoke.probe',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { source: 'remote-gateway-smoke' },
                  occurred_at: '2026-07-03T00:00:00.500Z'
                }
              ]
              : []),
            ...(ended
              ? [
                {
                  external_id: 'rustdesk-session-launch-1',
                  event_type: 'remote.gateway_session.ended',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { rustdesk_id: '123456789' },
                  occurred_at: '2026-07-03T00:00:01.000Z'
                }
              ]
              : [])
          ]
        });
      }
      if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-launch-1') {
        ended = true;
        return new Response(null, { status: 204 });
      }

      return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
    }
  );

  assert.equal(result.launchChecked, true);
  assert.deepEqual(
    result.steps.map((step) => `${step.name}:${step.status}`),
    [
      'rustdesk_client_config:200',
      'create_gateway_session:201',
      'rustdesk_launch_plan:200',
      'check_launch_url:200',
      'rustdesk_audit_probe:201',
      'rustdesk_audit_probe_retry:201',
      'list_gateway_audit:200',
      'end_gateway_session:204',
      'list_gateway_audit_after_end:200',
      'rustdesk_ended_launch_plan:200',
      'rustdesk_ended_launch_url:409',
      'rustdesk_end_gateway_session_retry:204',
      'rustdesk_ended_event_rejected:409',
      'rustdesk_ended_event_audit_clean:200'
    ]
  );
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-1/launch',
    'GET /remote/rustdesk/launch',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-launch-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-launch-1/events',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-1/audit',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-launch-1',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-1/audit',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-1/launch',
    'GET /remote/rustdesk/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-launch-1',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-launch-1/events',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-launch-1/audit'
  ]);
  assert.equal(calls[0]?.authorization, 'Bearer rustdesk-token');
  assert.equal(calls[3]?.authorization, undefined);
  assert.equal(calls[4]?.authorization, 'Bearer rustdesk-token');
  assert.equal(auditProbeBodies.length, 2);
  assert.equal(auditProbeBodies[0]?.idempotency_key, auditProbeBodies[1]?.idempotency_key);
  assert.deepEqual(result.rustdeskEndedLaunchPlan, {
    status: 'ended',
    canLaunch: false
  });
  assert.equal(result.rustdeskEndedLaunchUrlRejected, true);
  assert.equal(result.rustdeskEndRetried, true);
  assert.equal(result.rustdeskEndedEventRejected, true);
  assert.equal(result.rustdeskEndedEventAuditClean, true);
});

test('remote gateway smoke rejects a RustDesk launch page that stays open after end', async () => {
  const externalId = 'rustdesk-session-ended-launch-page-open-1';
  const launchUrl = `https://converact.local/remote/rustdesk/launch?session_id=${externalId}&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z`;
  const calls: string[] = [];
  let ended = false;
  let postedAuditEvent = false;

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen'],
          checkLaunchUrl: true
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push(`${method} ${pathname}`);

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: externalId,
              launch_url: launchUrl,
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === `/api/opc/rustdesk/sessions/${externalId}/launch`) {
            return jsonResponse(200, rustDeskLaunchPlanBody(externalId, {
              idServer: 'rustdesk-id.example.com',
              ...(ended ? { status: 'ended', canLaunch: false } : {})
            }));
          }
          if (method === 'GET' && pathname === '/remote/rustdesk/launch') {
            return new Response(
              '<!doctype html><title>RustDesk Remote Launch</title><main>rustdesk-session-ended-launch-page-open-1</main>',
              {
                status: 200,
                headers: { 'content-type': 'text/html' }
              }
            );
          }
          if (method === 'POST' && pathname === `/api/opc/rustdesk/sessions/${externalId}/events`) {
            const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
            if (ended && String(body.event_type || '') === 'remote.rustdesk.file_transfer.started') {
              return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
            }
            postedAuditEvent = true;
            return jsonResponse(201, {
              event: {
                external_id: externalId,
                event_type: body.event_type,
                actor_identity: body.actor_identity,
                target: body.target,
                metadata: body.metadata || {},
                occurred_at: '2026-07-04T08:00:01.000Z'
              }
            });
          }
          if (method === 'GET' && pathname === `/api/opc/rustdesk/sessions/${externalId}/audit`) {
            return jsonResponse(200, {
              events: [
                {
                  external_id: externalId,
                  event_type: 'remote.gateway_session.created',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { rustdesk_id: '123456789' },
                  occurred_at: '2026-07-04T08:00:00.000Z'
                },
                ...(postedAuditEvent
                  ? [
                    {
                      external_id: externalId,
                      event_type: 'remote.rustdesk.smoke.probe',
                      actor_identity: 'agent_gateway_smoke',
                      target: '123456789',
                      metadata: { source: 'remote-gateway-smoke' },
                      occurred_at: '2026-07-04T08:00:01.000Z'
                    }
                  ]
                  : []),
                ...(ended
                  ? [
                    {
                      external_id: externalId,
                      event_type: 'remote.gateway_session.ended',
                      actor_identity: 'agent_gateway_smoke',
                      target: '123456789',
                      metadata: { rustdesk_id: '123456789' },
                      occurred_at: '2026-07-04T08:00:02.000Z'
                    }
                  ]
                  : [])
              ]
            });
          }
          if (method === 'DELETE' && pathname === `/api/opc/rustdesk/sessions/${externalId}`) {
            ended = true;
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk ended launch URL must be rejected with 409/
  );

  assert.deepEqual(calls, [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    `GET /api/opc/rustdesk/sessions/${externalId}/launch`,
    'GET /remote/rustdesk/launch',
    `POST /api/opc/rustdesk/sessions/${externalId}/events`,
    `POST /api/opc/rustdesk/sessions/${externalId}/events`,
    `GET /api/opc/rustdesk/sessions/${externalId}/audit`,
    `DELETE /api/opc/rustdesk/sessions/${externalId}`,
    `GET /api/opc/rustdesk/sessions/${externalId}/audit`,
    `GET /api/opc/rustdesk/sessions/${externalId}/launch`,
    'GET /remote/rustdesk/launch'
  ]);
});

test('remote gateway smoke rejects RustDesk ended launch plans with a launch URL', async () => {
  const externalId = 'rustdesk-session-ended-launch-url-1';
  const launchUrl = `https://converact.local/remote/rustdesk/launch?session_id=${externalId}&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z`;
  const calls: string[] = [];
  let ended = false;
  let postedAuditEvent = false;

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen'],
          rustdeskCheckOperationAudit: false
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push(`${method} ${pathname}`);

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: externalId,
              launch_url: launchUrl,
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === `/api/opc/rustdesk/sessions/${externalId}/launch`) {
            return jsonResponse(200, {
              ...rustDeskLaunchPlanBody(externalId, {
                idServer: 'rustdesk-id.example.com',
                ...(ended ? { status: 'ended', canLaunch: false } : {})
              }),
              ...(ended ? { launch_url: launchUrl } : {})
            });
          }
          if (method === 'POST' && pathname === `/api/opc/rustdesk/sessions/${externalId}/events`) {
            const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
            if (ended) {
              return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
            }
            postedAuditEvent = true;
            return jsonResponse(201, {
              event: {
                external_id: externalId,
                event_type: body.event_type,
                actor_identity: body.actor_identity,
                target: body.target,
                metadata: body.metadata || {},
                occurred_at: '2026-07-04T00:00:01.000Z'
              }
            });
          }
          if (method === 'GET' && pathname === `/api/opc/rustdesk/sessions/${externalId}/audit`) {
            return jsonResponse(200, {
              events: [
                {
                  external_id: externalId,
                  event_type: 'remote.gateway_session.created',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { rustdesk_id: '123456789' },
                  occurred_at: '2026-07-04T00:00:00.000Z'
                },
                ...(postedAuditEvent
                  ? [
                    {
                      external_id: externalId,
                      event_type: 'remote.rustdesk.smoke.probe',
                      actor_identity: 'agent_gateway_smoke',
                      target: '123456789',
                      metadata: { source: 'remote-gateway-smoke' },
                      occurred_at: '2026-07-04T00:00:01.000Z'
                    }
                  ]
                  : []),
                ...(ended
                  ? [
                    {
                      external_id: externalId,
                      event_type: 'remote.gateway_session.ended',
                      actor_identity: 'agent_gateway_smoke',
                      target: '123456789',
                      metadata: { rustdesk_id: '123456789' },
                      occurred_at: '2026-07-04T00:00:02.000Z'
                    }
                  ]
                  : [])
              ]
            });
          }
          if (method === 'DELETE' && pathname === `/api/opc/rustdesk/sessions/${externalId}`) {
            ended = true;
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk ended launch plan launch_url must be empty/
  );

  assert.equal(ended, true);
  assert.equal(calls.includes(`POST /api/opc/rustdesk/sessions/${externalId}/events`), true);
  assert.equal(calls.filter((call) => call === `DELETE /api/opc/rustdesk/sessions/${externalId}`).length, 1);
});

test('remote gateway smoke rejects a RustDesk launch page with unrelated content and cleans the session', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen'],
          checkLaunchUrl: true
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-wrong-page-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-wrong-page-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-wrong-page-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-wrong-page-1', {
              idServer: 'rustdesk-id.example.com'
            }));
          }
          if (method === 'GET' && pathname === '/remote/rustdesk/launch') {
            return new Response('<!doctype html><title>Default reverse proxy page</title>', {
              status: 200,
              headers: { 'content-type': 'text/html' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-wrong-page-1/audit') {
            return jsonResponse(200, { events: [] });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-wrong-page-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk launch page did not contain the expected launch content/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-wrong-page-1/launch',
    'GET /remote/rustdesk/launch',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-wrong-page-1'
  ]);
});

test('remote gateway smoke ends an active RustDesk session when later validation fails', async () => {
  const calls: Array<{ method: string; pathname: string }> = [];

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen']
        },
        async (input, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(input));
          calls.push({ method, pathname });

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: 'rustdesk-session-cleanup-1',
              launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-cleanup-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
              target: { type: 'device', id: '123456789' },
              permissions: ['view_screen'],
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-cleanup-1/launch') {
            return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-cleanup-1', {
              idServer: 'rustdesk-id.example.com'
            }));
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-cleanup-1/events') {
            return jsonResponse(201, {
              event: {
                external_id: 'rustdesk-session-cleanup-1',
                event_type: 'remote.rustdesk.smoke.probe',
                actor_identity: 'agent_gateway_smoke',
                target: '123456789',
                metadata: { source: 'remote-gateway-smoke' },
                occurred_at: '2026-07-03T00:00:00.500Z'
              }
            });
          }
          if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-cleanup-1/audit') {
            return jsonResponse(500, { error: 'audit unavailable' });
          }
          if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-cleanup-1') {
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    /RustDesk gateway request failed: 500/
  );

  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /api/opc/rustdesk/client-config',
    'POST /api/opc/rustdesk/sessions',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-cleanup-1/launch',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-cleanup-1/events',
    'POST /api/opc/rustdesk/sessions/rustdesk-session-cleanup-1/events',
    'GET /api/opc/rustdesk/sessions/rustdesk-session-cleanup-1/audit',
    'DELETE /api/opc/rustdesk/sessions/rustdesk-session-cleanup-1'
  ]);
});

test('remote gateway smoke rejects a gateway response without a launch URL', async () => {
  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'guacamole',
          baseUrl: 'http://guac.local',
          apiToken: 'gateway-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'connection', id: 'conn-1' },
          permissions: ['view_screen']
        },
        async () => jsonResponse(201, { external_id: 'guac-session-1', launch_url: '' })
      ),
    /Guacamole gateway response missing launch_url/
  );
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function rustDeskSuccessfulSmokeFetch(
  clientConfigOverrides: Record<string, unknown> = {}
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  let ended = false;
  return async (input, init = {}) => {
    const method = init.method || 'GET';
    const { pathname } = new URL(String(input));
    if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
      return jsonResponse(200, {
        id_server: 'rustdesk-id.example.com',
        relay_server: 'rustdesk-relay.example.com',
        public_key: 'public-key',
        public_key_configured: true,
        public_key_source: 'file',
        server_key_fingerprint: 'sha256:public-key-fingerprint',
        manual_fields: {
          id_server: 'rustdesk-id.example.com',
          relay_server: 'rustdesk-relay.example.com',
          key: 'public-key'
        },
        ...clientConfigOverrides
      });
    }
    if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
      return jsonResponse(201, {
        external_id: 'rustdesk-session-client-config-contract-1',
        launch_url: 'https://converact.local/remote/rustdesk/launch?session_id=rustdesk-session-client-config-contract-1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
        target: { type: 'device', id: '123456789' },
        permissions: ['view_screen'],
        metadata: { rustdesk_id: '123456789' }
      });
    }
    if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-client-config-contract-1/launch') {
      return jsonResponse(200, rustDeskLaunchPlanBody('rustdesk-session-client-config-contract-1', {
        canLaunch: !ended,
        relayServer: 'rustdesk-relay.example.com',
        status: ended ? 'ended' : 'active'
      }));
    }
    if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-client-config-contract-1/events') {
      const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
      return jsonResponse(201, {
        event: {
          external_id: 'rustdesk-session-client-config-contract-1',
          event_type: body.event_type,
          actor_identity: body.actor_identity,
          target: body.target,
          metadata: body.metadata || {},
          occurred_at: '2026-07-04T00:00:00.000Z'
        }
      });
    }
    if (method === 'GET' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-client-config-contract-1/audit') {
      return jsonResponse(200, {
        events: [
          {
            external_id: 'rustdesk-session-client-config-contract-1',
            event_type: 'remote.gateway_session.created',
            actor_identity: 'agent_gateway_smoke',
            target: '123456789',
            metadata: {},
            occurred_at: '2026-07-04T00:00:00.000Z'
          },
          {
            external_id: 'rustdesk-session-client-config-contract-1',
            event_type: 'remote.rustdesk.smoke.probe',
            actor_identity: 'agent_gateway_smoke',
            target: '123456789',
            metadata: {},
            occurred_at: '2026-07-04T00:00:01.000Z'
          },
          ...(ended
            ? [
              {
                external_id: 'rustdesk-session-client-config-contract-1',
                event_type: 'remote.gateway_session.ended',
                actor_identity: 'agent_gateway_smoke',
                target: '123456789',
                metadata: {},
                occurred_at: '2026-07-04T00:00:02.000Z'
              }
            ]
            : [])
        ]
      });
    }
    if (method === 'DELETE' && pathname === '/api/opc/rustdesk/sessions/rustdesk-session-client-config-contract-1') {
      ended = true;
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
  };
}

async function expectRustDeskLaunchPlanRejection(input: {
  externalId: string;
  permissions?: RemoteConsentScope[];
  launchPlan: (externalId: string) => Record<string, unknown>;
  expected: RegExp;
}): Promise<{ calls: string[] }> {
  const calls: string[] = [];
  const permissions = input.permissions || ['view_screen'];
  const launchUrl = `https://converact.local/remote/rustdesk/launch?session_id=${input.externalId}&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z`;
  let ended = false;
  let postedProbe = false;

  await assert.rejects(
    () =>
      runRemoteGatewaySmoke(
        {
          provider: 'rustdesk',
          baseUrl: 'http://converact.local',
          apiToken: 'rustdesk-token',
          actorIdentity: 'agent_gateway_smoke',
          target: { type: 'device', id: '123456789' },
          permissions,
          rustdeskCheckOperationAudit: false
        },
        async (request, init = {}) => {
          const method = init.method || 'GET';
          const { pathname } = new URL(String(request));
          calls.push(`${method} ${pathname}`);

          if (method === 'GET' && pathname === '/api/opc/rustdesk/client-config') {
            return jsonResponse(200, {
              id_server: 'rustdesk-id.example.com',
              public_key_configured: true,
              public_key: 'public-key',
              public_key_source: 'file',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
                id_server: 'rustdesk-id.example.com',
                key: 'public-key'
              }
            });
          }
          if (method === 'POST' && pathname === '/api/opc/rustdesk/sessions') {
            return jsonResponse(201, {
              external_id: input.externalId,
              launch_url: launchUrl,
              target: { type: 'device', id: '123456789' },
              permissions,
              metadata: { rustdesk_id: '123456789' }
            });
          }
          if (method === 'GET' && pathname === `/api/opc/rustdesk/sessions/${input.externalId}/launch`) {
            return jsonResponse(200, ended
              ? rustDeskLaunchPlanBody(input.externalId, { canLaunch: false, status: 'ended' })
              : input.launchPlan(input.externalId));
          }
          if (method === 'POST' && pathname === `/api/opc/rustdesk/sessions/${input.externalId}/events`) {
            const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
            if (ended) {
              return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
            }
            postedProbe = true;
            return jsonResponse(201, {
              event: {
                external_id: input.externalId,
                event_type: body.event_type,
                actor_identity: body.actor_identity,
                target: body.target,
                metadata: body.metadata || {},
                occurred_at: '2026-07-04T00:00:01.000Z'
              }
            });
          }
          if (method === 'GET' && pathname === `/api/opc/rustdesk/sessions/${input.externalId}/audit`) {
            return jsonResponse(200, {
              events: [
                {
                  external_id: input.externalId,
                  event_type: 'remote.gateway_session.created',
                  actor_identity: 'agent_gateway_smoke',
                  target: '123456789',
                  metadata: { rustdesk_id: '123456789' },
                  occurred_at: '2026-07-04T00:00:00.000Z'
                },
                ...(postedProbe
                  ? [
                    {
                      external_id: input.externalId,
                      event_type: 'remote.rustdesk.smoke.probe',
                      actor_identity: 'agent_gateway_smoke',
                      target: '123456789',
                      metadata: { source: 'remote-gateway-smoke' },
                      occurred_at: '2026-07-04T00:00:01.000Z'
                    }
                  ]
                  : []),
                ...(ended
                  ? [
                    {
                      external_id: input.externalId,
                      event_type: 'remote.gateway_session.ended',
                      actor_identity: 'agent_gateway_smoke',
                      target: '123456789',
                      metadata: { rustdesk_id: '123456789' },
                      occurred_at: '2026-07-04T00:00:02.000Z'
                    }
                  ]
                  : [])
              ]
            });
          }
          if (method === 'DELETE' && pathname === `/api/opc/rustdesk/sessions/${input.externalId}`) {
            ended = true;
            return new Response(null, { status: 204 });
          }

          return jsonResponse(404, { error: `unexpected ${method} ${pathname}` });
        }
      ),
    input.expected
  );

  return { calls };
}

function rustDeskLaunchPlanBody(
  externalId: string,
  options: {
    apiServer?: string;
    canLaunch?: boolean;
    clientPublicKeyConfigured?: boolean;
    idServer?: string;
    omitClientConfig?: boolean;
    permissions?: RemoteConsentScope[];
    protocolUrl?: string;
    relayServer?: string;
    runtimePublicKeyConfigured?: boolean | string;
    rustdeskId?: string;
    serverKeyFingerprint?: string;
    status?: string;
    targetId?: string;
  } = {}
) {
  const canLaunch = options.canLaunch ?? true;
  const rustdeskId = options.rustdeskId || '123456789';
  const targetId = options.targetId || rustdeskId;
  const launchUrl = `https://converact.local/remote/rustdesk/launch?session_id=${externalId}&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z`;
  const body = {
    external_id: externalId,
    status: options.status || 'active',
    launch_url: canLaunch ? launchUrl : '',
    target: { type: 'device', id: targetId },
    permissions: options.permissions || [
      'view_screen',
      'control_mouse_keyboard',
      'record_screen',
      'transfer_file',
      'clipboard'
    ],
    runtime: {
      rustdesk_id: rustdeskId,
      api_server: options.apiServer || '',
      id_server: options.idServer || 'rustdesk-id.example.com',
      relay_server: options.relayServer || '',
      server_key_fingerprint: options.serverKeyFingerprint || 'sha256:public-key-fingerprint',
      public_key_configured: options.runtimePublicKeyConfigured ?? 'true',
      public_key_source: 'file'
    },
    actions: {
      can_launch: canLaunch,
      open_url: canLaunch ? launchUrl : '',
      protocol_url: options.protocolUrl || ''
    },
    metadata: { rustdesk_id: rustdeskId }
  };
  return options.omitClientConfig
    ? body
    : {
      ...body,
      client_config: {
        public_key_configured: options.clientPublicKeyConfigured ?? true,
              public_key: 'public-key',
              public_key_source: 'env',
              server_key_fingerprint: 'sha256:public-key-fingerprint',
              manual_fields: {
          id_server: options.idServer || 'rustdesk-id.example.com',
          ...(options.relayServer ? { relay_server: options.relayServer } : {}),
          ...(options.apiServer ? { api_server: options.apiServer } : {}),
          key: 'public-key'
        }
      }
    };
}
