import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createRustDeskReadinessConfigFromEnv,
  runRustDeskReadiness,
  runRustDeskReadinessFromEnv,
  writeRustDeskReadinessReport
} from '../scripts/rustdesk-readiness.js';

test('rustdesk readiness builds a strict RustDesk gateway check and can derive the target from the edge agent', () => {
  const config = createRustDeskReadinessConfigFromEnv({
    OPC_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com/',
    OPC_RUSTDESK_API_TOKEN: 'rustdesk-token',
    OPC_COLLABORATION_API_KEY: 'collaboration-key',
    OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT: '1',
    OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT: '1',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
    OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
    OPC_RUSTDESK_EDGE_DEVICE_DISPLAY_NAME: 'LED control PC',
    OPC_RUSTDESK_EDGE_COMMAND_TOKEN: 'signed-readiness-edge-token',
    OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE: process.execPath,
    OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON: '["-e","process.exit(0)"]',
    OPC_RUSTDESK_EDGE_SPOOL_DIR: join(
      mkdtempSync(join(tmpdir(), 'opc-rustdesk-readiness-config-')),
      'spool'
    )
  });

  assert.equal(config.runEdgeAgent, true);
  assert.equal(config.checkPhysicalDisconnect, true);
  assert.equal(config.remoteGateway.provider, 'rustdesk');
  assert.equal(config.remoteGateway.baseUrl, 'https://opc.example.com');
  assert.equal(config.remoteGateway.apiToken, 'rustdesk-token');
  assert.equal(config.remoteGateway.target.id, '__edge_agent_device__');
  assert.equal(config.remoteGateway.rustdeskCheckDeviceOnline, true);
  assert.equal(config.remoteGateway.rustdeskCheckOperationAudit, true);
  assert.equal(config.remoteGateway.rustdeskRequireProtocolUrl, true);
  assert.equal(config.remoteGateway.rustdeskCheckServerPorts, true);
  assert.equal(config.remoteGateway.checkLaunchUrl, true);
  assert.equal(config.edgeAgent?.baseUrl, 'https://opc.example.com');
  assert.equal(config.edgeAgent?.apiKey, 'collaboration-key');

  assert.throws(
    () =>
      createRustDeskReadinessConfigFromEnv({
        OPC_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com',
        OPC_RUSTDESK_API_TOKEN: 'rustdesk-token',
        OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led'
      }),
    /OPC_REMOTE_GATEWAY_TARGET_ID is required/
  );
});

test('rustdesk readiness keeps strict defaults even when smoke defaults are injected', () => {
  const config = createRustDeskReadinessConfigFromEnv({
    OPC_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com/',
    OPC_RUSTDESK_API_TOKEN: 'rustdesk-token',
    OPC_COLLABORATION_API_KEY: 'collaboration-key',
    OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
    OPC_REMOTE_GATEWAY_TARGET_ID: 'rdesk-device-1',
    OPC_RUSTDESK_CHECK_DEVICE_ONLINE: '0',
    OPC_RUSTDESK_CHECK_OPERATION_AUDIT: '0',
    OPC_RUSTDESK_CHECK_SERVER_PORTS: '0',
    OPC_RUSTDESK_REQUIRE_PROTOCOL_URL: '0',
    OPC_REMOTE_GATEWAY_CHECK_LAUNCH_URL: '0'
  });

  assert.equal(config.remoteGateway.rustdeskCheckDeviceOnline, true);
  assert.equal(config.remoteGateway.rustdeskCheckOperationAudit, true);
  assert.equal(config.remoteGateway.rustdeskCheckServerPorts, true);
  assert.equal(config.remoteGateway.rustdeskRequireProtocolUrl, true);
  assert.equal(config.remoteGateway.checkLaunchUrl, true);

  const relaxed = createRustDeskReadinessConfigFromEnv({
    OPC_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com/',
    OPC_RUSTDESK_API_TOKEN: 'rustdesk-token',
    OPC_REMOTE_GATEWAY_TARGET_ID: '123456789',
    OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE: '0',
    OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT: '0',
    OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS: '0',
    OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL: '0',
    OPC_RUSTDESK_READINESS_CHECK_LAUNCH_URL: '0'
  });

  assert.equal(relaxed.remoteGateway.rustdeskCheckDeviceOnline, false);
  assert.equal(relaxed.remoteGateway.rustdeskCheckOperationAudit, false);
  assert.equal(relaxed.remoteGateway.rustdeskCheckServerPorts, false);
  assert.equal(relaxed.remoteGateway.rustdeskRequireProtocolUrl, false);
  assert.equal(relaxed.remoteGateway.checkLaunchUrl, false);
});

test('rustdesk readiness from env runs deployment preflight before network checks', async () => {
  let fetchCalled = false;

  await assert.rejects(
    () =>
      runRustDeskReadinessFromEnv(
        {
          OPC_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
          OPC_RUSTDESK_LAUNCH_SECRET: 'launch-secret'
        },
        async () => {
          fetchCalled = true;
          return jsonResponse(500, {});
        }
      ),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.match((error as Error).message, /RustDesk deployment preflight failed/);
      const preflight = (error as { preflight?: { ok: boolean; checks: Array<{ id: string; status: string }> } }).preflight;
      assert.equal(preflight?.ok, false);
      assert.equal(preflight?.checks.some((check) => check.id === 'control_plane_base_url' && check.status === 'fail'), true);
      assert.equal(JSON.stringify(preflight).includes('rustdesk-secret-token'), false);
      return true;
    }
  );

  assert.equal(fetchCalled, false);
});

test('rustdesk readiness reuses the edge tenant for the remote gateway online check', () => {
  const config = createRustDeskReadinessConfigFromEnv({
    OPC_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com/',
    OPC_RUSTDESK_API_TOKEN: 'rustdesk-token',
    OPC_COLLABORATION_API_KEY: 'collaboration-key',
    OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT: '1',
    OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_from_edge',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
    OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
    OPC_RUSTDESK_EDGE_DEVICE_DISPLAY_NAME: 'LED control PC'
  });

  assert.equal(config.edgeAgent?.tenantId, 'tenant_from_edge');
  assert.equal(config.remoteGateway.tenantId, 'tenant_from_edge');
  assert.equal(config.remoteGateway.target.id, '__edge_agent_device__');
});

test('rustdesk readiness runs edge heartbeat before the strict gateway smoke', async () => {
  const calls: string[] = [];
  const auditEvents: Array<Record<string, unknown>> = [
    {
      external_id: 'rdgw_readiness_1',
      event_type: 'remote.gateway_session.created',
      actor_identity: 'agent_rustdesk_readiness',
      target: '123456789',
      metadata: { rustdesk_id: '123456789' },
      occurred_at: '2026-07-04T08:00:00.000Z'
    }
  ];
  let ended = false;
  let commandStatus = 'pending';
  let commandResult: Record<string, unknown> = {};

  const result = await runRustDeskReadiness(
    createRustDeskReadinessConfigFromEnv({
      OPC_RUSTDESK_CONTROL_PLANE_BASE_URL: 'https://opc.example.com/',
      OPC_RUSTDESK_API_TOKEN: 'rustdesk-token',
      OPC_COLLABORATION_API_KEY: 'collaboration-key',
      OPC_REMOTE_GATEWAY_TENANT_ID: 'tenant_led',
      OPC_REMOTE_GATEWAY_ACTOR_IDENTITY: 'agent_rustdesk_readiness',
      OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT: '1',
      OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT: '1',
      OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS: '0',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
      OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
      OPC_RUSTDESK_EDGE_DEVICE_DISPLAY_NAME: 'LED control PC',
      OPC_RUSTDESK_EDGE_ACTOR_IDENTITY: 'rustdesk-edge-agent',
      OPC_RUSTDESK_EDGE_INSTANCE_ID: 'edge-readiness-1',
      OPC_RUSTDESK_EDGE_COMMAND_TOKEN: 'signed-readiness-edge-token',
      OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE: process.execPath,
      OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON: JSON.stringify([
        '-e',
        "process.stdout.write('readiness-disconnected'); process.exit(0)"
      ]),
      OPC_RUSTDESK_EDGE_SPOOL_DIR: join(
        mkdtempSync(join(tmpdir(), 'opc-rustdesk-readiness-run-')),
        'spool'
      )
    }),
    async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method || 'GET';
      calls.push(`${method} ${url.pathname}${url.search}`);

      if (method === 'GET' && url.pathname === '/api/collaboration/rustdesk/devices/by-ref') {
        return jsonResponse(200, {
          data: [
            {
              id: 'rdesk-device-1',
              status: 'active',
              rustdesk_id: '123456789',
              display_name: 'LED control PC'
            }
          ]
        });
      }
      if (method === 'POST' && url.pathname === '/api/collaboration/rustdesk/devices/rdesk-device-1/heartbeat') {
        const body = JSON.parse(String(init.body || '{}')) as {
          metadata?: Record<string, unknown>;
        };
        assert.equal(body.metadata?.disconnect_command_capable, true);
        assert.equal(body.metadata?.edge_instance_id, 'edge-readiness-1');
        return jsonResponse(201, {
          data: {
            id: 'rdesk-device-1',
            rustdesk_id: '123456789',
            runtime_status: 'online',
            last_seen_at: new Date().toISOString()
          }
        });
      }
      if (method === 'GET' && url.pathname === '/api/opc/rustdesk/client-config') {
        return jsonResponse(200, {
          api_server: 'https://rustdesk-api.example.com',
          id_server: 'rustdesk-id.example.com',
          relay_server: 'rustdesk-relay.example.com',
          public_key: 'public-key',
          public_key_configured: true,
          public_key_source: 'file',
          server_key_fingerprint: 'sha256:public-key-fingerprint',
          manual_fields: {
            api_server: 'https://rustdesk-api.example.com',
            id_server: 'rustdesk-id.example.com',
            relay_server: 'rustdesk-relay.example.com',
            key: 'public-key'
          }
        });
      }
      if (method === 'GET' && url.pathname === '/api/collaboration/rustdesk/devices/rdesk-device-1') {
        return jsonResponse(200, {
          data: {
            id: 'rdesk-device-1',
            status: 'active',
            rustdesk_id: '123456789',
            display_name: 'LED control PC',
            runtime_status: 'online',
            last_seen_at: new Date().toISOString(),
            last_seen_actor: 'rustdesk-edge-agent',
            business_ref_type: 'service_order',
            business_ref_id: 'SO-10001'
          }
        });
      }
      if (method === 'POST' && url.pathname === '/api/opc/rustdesk/sessions') {
        return jsonResponse(201, {
          external_id: 'rdgw_readiness_1',
          launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_readiness_1&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z',
          target: { type: 'device', id: '123456789' },
          permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
          metadata: { rustdesk_id: '123456789', target_id: 'rdesk-device-1' }
        });
      }
      if (method === 'GET' && url.pathname === '/api/opc/rustdesk/sessions/rdgw_readiness_1/launch') {
        return jsonResponse(200, rustDeskLaunchPlanBody('rdgw_readiness_1', {
          status: ended ? 'ended' : 'active',
          canLaunch: !ended
        }));
      }
      if (method === 'GET' && url.pathname === '/api/opc/rustdesk/sessions') {
        const status = url.searchParams.get('status');
        return jsonResponse(200, {
          sessions: status === 'ended' && !ended
            ? []
            : [{ external_id: 'rdgw_readiness_1', status }]
        });
      }
      if (method === 'GET' && url.pathname === '/remote/rustdesk/launch') {
        if (ended) return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
        return new Response('<title>RustDesk Remote Launch</title>rdgw_readiness_1', { status: 200 });
      }
      if (method === 'POST' && url.pathname === '/api/opc/rustdesk/sessions/rdgw_readiness_1/events') {
        const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
        if (ended && String(body.event_type || '') === 'remote.rustdesk.file_transfer.started') {
          return jsonResponse(409, { error: 'RustDesk gateway session is not active' });
        }
        if (!auditEvents.some((event) => event.idempotency_key === body.idempotency_key)) {
          auditEvents.push({
            external_id: 'rdgw_readiness_1',
            event_type: body.event_type,
            actor_identity: body.actor_identity,
            target: body.target,
            idempotency_key: body.idempotency_key,
            metadata: body.metadata || {},
            occurred_at: '2026-07-04T08:00:01.000Z'
          });
        }
        return jsonResponse(201, { event: auditEvents.at(-1) });
      }
      if (method === 'GET' && url.pathname === '/api/opc/rustdesk/sessions/rdgw_readiness_1/audit') {
        return jsonResponse(200, { events: auditEvents });
      }
      if (method === 'DELETE' && url.pathname === '/api/opc/rustdesk/sessions/rdgw_readiness_1') {
        if (!ended) {
          ended = true;
          auditEvents.push({
            external_id: 'rdgw_readiness_1',
            event_type: 'remote.gateway_session.ended',
            actor_identity: 'agent_rustdesk_readiness',
            target: '123456789',
            metadata: { rustdesk_id: '123456789' },
            occurred_at: '2026-07-04T08:00:02.000Z'
          });
        }
        return new Response(null, { status: 204 });
      }
      if (
        method === 'POST' &&
        url.pathname === '/api/ivekit/rustdesk/devices/rdesk-device-1/commands/claim'
      ) {
        return jsonResponse(201, {
          command: {
            id: 'rdcmd_readiness_1',
            command_type: 'disconnect_session',
            external_id: 'rdgw_readiness_1',
            target_id: 'rdesk-device-1',
            rustdesk_id: '123456789',
            requested_reason: 'gateway_ended',
            attempt: 1,
            lease_expires_at: '2099-01-01T00:00:00.000Z'
          },
          claim_token: 'readiness-claim-token'
        });
      }
      if (
        method === 'POST' &&
        url.pathname === '/api/ivekit/rustdesk/devices/rdesk-device-1/commands/rdcmd_readiness_1/result'
      ) {
        commandResult = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
        commandStatus = String(commandResult.status || '');
        return jsonResponse(201, { command: { id: 'rdcmd_readiness_1', status: commandStatus } });
      }
      if (
        method === 'GET' &&
        url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_readiness_1/disconnect'
      ) {
        return jsonResponse(200, {
          required: true,
          status: commandStatus,
          command: {
            id: 'rdcmd_readiness_1',
            tenant_id: 'tenant_led',
            device_id: 'rdesk-device-1',
            external_id: 'rdgw_readiness_1',
            command_type: 'disconnect_session',
            status: commandStatus,
            requested_by: 'agent_rustdesk_readiness',
            requested_reason: 'gateway_ended',
            attempt_count: 1,
            max_attempts: 3,
            claimed_by: 'edge-readiness-1',
            lease_expires_at: null,
            next_attempt_at: null,
            execution_method: commandResult.execution_method,
            exit_code: commandResult.exit_code,
            duration_ms: commandResult.duration_ms,
            stdout_bytes: commandResult.stdout_bytes,
            stderr_bytes: commandResult.stderr_bytes,
            stdout_sha256: commandResult.stdout_sha256,
            stderr_sha256: commandResult.stderr_sha256,
            result_metadata: commandResult.metadata,
            requested_at: '2026-07-04T08:00:02.000Z',
            started_at: '2026-07-04T08:00:03.000Z',
            completed_at: '2026-07-04T08:00:04.000Z',
            updated_at: '2026-07-04T08:00:04.000Z'
          }
        });
      }
      if (
        method === 'GET' &&
        url.pathname === '/api/ivekit/rustdesk/gateway-sessions/rdgw_readiness_1/audit'
      ) {
        const base = {
          external_id: 'rdgw_readiness_1',
          actor_identity: 'edge-readiness-1',
          target: 'rdesk-device-1',
          occurred_at: '2026-07-04T08:00:04.000Z'
        };
        return jsonResponse(200, {
          events: [
            {
              ...base,
              event_type: 'remote.rustdesk.disconnect.requested',
              metadata: { command_id: 'rdcmd_readiness_1', device_id: 'rdesk-device-1' }
            },
            {
              ...base,
              event_type: 'remote.rustdesk.disconnect.claimed',
              metadata: { command_id: 'rdcmd_readiness_1', device_id: 'rdesk-device-1' }
            },
            {
              ...base,
              event_type: 'remote.rustdesk.disconnect.succeeded',
              metadata: { command_id: 'rdcmd_readiness_1', device_id: 'rdesk-device-1' }
            }
          ]
        });
      }

      return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}${url.search}` });
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.edgeAgent?.deviceId, 'rdesk-device-1');
  assert.equal(result.remoteGateway.externalId, 'rdgw_readiness_1');
  assert.equal(result.remoteGateway.rustdeskEndedEventRejected, true);
  assert.equal(result.remoteGateway.rustdeskEndedEventAuditClean, true);
  assert.equal(result.remoteGateway.rustdeskRegisteredDevice?.deviceId, 'rdesk-device-1');
  assert.deepEqual(result.physicalDisconnect, {
    externalId: 'rdgw_readiness_1',
    commandId: 'rdcmd_readiness_1',
    status: 'succeeded',
    executionMethod: 'session_adapter',
    edgeInstanceId: 'edge-readiness-1',
    operatorObservedDisconnect: false
  });
  assert.deepEqual(result.steps.map((step) => step.name), [
    'edge-agent',
    'remote-gateway',
    'physical-disconnect'
  ]);
  assert.deepEqual(calls.slice(0, 2), [
    'GET /api/collaboration/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=SO-10001&limit=50',
    'POST /api/collaboration/rustdesk/devices/rdesk-device-1/heartbeat'
  ]);
  assert.equal(calls.includes('GET /api/collaboration/rustdesk/devices/rdesk-device-1'), true);
  assert.equal(
    calls.includes('GET /api/ivekit/rustdesk/gateway-sessions/rdgw_readiness_1/audit'),
    true
  );

  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-readiness-report-'));
  const outputFile = join(dir, 'rustdesk-readiness.json');
  const writeResult = writeRustDeskReadinessReport(outputFile, result);
  assert.equal(writeResult.outputFile, outputFile);
  assert.equal(writeResult.ok, true);
  assert.equal(writeResult.steps, 3);

  const payload = JSON.parse(readFileSync(outputFile, 'utf8'));
  assert.equal(payload.ok, true);
  assert.equal(payload.remoteGateway.externalId, 'rdgw_readiness_1');
  assert.equal(payload.physicalDisconnect.operatorObservedDisconnect, false);
  assert.equal(JSON.stringify(payload).includes('rustdesk-token'), false);
});

test('rustdesk readiness is wired into package scripts and env examples', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:readiness'], 'tsx scripts/rustdesk-readiness.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const infraEnvExample = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  for (const content of [envExample, infraEnvExample]) {
    assert.match(content, /^OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT=/m);
    assert.match(content, /^OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE=1/m);
    assert.match(content, /^OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT=1/m);
    assert.match(content, /^OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS=1/m);
    assert.match(content, /^OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL=1/m);
    assert.match(content, /^OPC_RUSTDESK_READINESS_CHECK_LAUNCH_URL=1/m);
    assert.match(content, /^OPC_RUSTDESK_READINESS_REPORT_FILE=/m);
  }
});

test('rustdesk readiness CLI writes a preflight failure report artifact without network checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-readiness-cli-'));
  const outputFile = join(dir, 'rustdesk-readiness.json');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rustdesk-readiness.ts'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPC_RUSTDESK_READINESS_REPORT_FILE: outputFile,
      OPC_RUSTDESK_API_TOKEN: 'rustdesk-secret-token',
      OPC_RUSTDESK_LAUNCH_SECRET: 'launch-secret'
    }
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(readFileSync(outputFile, 'utf8'));
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'RustDesk deployment preflight failed');
  assert.equal(payload.preflight.ok, false);
  assert.equal(payload.preflight.checks.some((check: { id: string; status: string }) => check.id === 'control_plane_base_url' && check.status === 'fail'), true);
  assert.equal(JSON.stringify(payload).includes('rustdesk-secret-token'), false);
  assert.equal(JSON.stringify(payload).includes('launch-secret'), false);
  assert.equal(JSON.parse(result.stderr).reportFile.outputFile, outputFile);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function rustDeskLaunchPlanBody(
  externalId: string,
  options: { canLaunch: boolean; status: string }
) {
  const launchUrl = `https://opc.example.com/remote/rustdesk/launch?session_id=${externalId}&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=2099-01-01T00:00:00.000Z`;
  return {
    external_id: externalId,
    status: options.status,
    launch_url: options.canLaunch ? launchUrl : '',
    target: { type: 'device', id: '123456789' },
    permissions: ['view_screen', 'control_mouse_keyboard', 'record_screen', 'transfer_file', 'clipboard'],
    runtime: {
      rustdesk_id: '123456789',
      api_server: 'https://rustdesk-api.example.com',
      id_server: 'rustdesk-id.example.com',
      relay_server: 'rustdesk-relay.example.com',
      server_key_fingerprint: 'sha256:public-key-fingerprint',
      public_key_configured: true,
      public_key_source: 'file'
    },
    client_config: {
      public_key_configured: true,
      public_key_source: 'file',
      manual_fields: {
        id_server: 'rustdesk-id.example.com',
        relay_server: 'rustdesk-relay.example.com',
        api_server: 'https://rustdesk-api.example.com',
        key: 'public-key'
      }
    },
    actions: {
      can_launch: options.canLaunch,
      open_url: options.canLaunch ? launchUrl : '',
      protocol_url: options.canLaunch ? `rustdesk://connect/123456789?server=rustdesk-id.example.com&external_id=${externalId}` : ''
    },
    metadata: { rustdesk_id: '123456789' }
  };
}
