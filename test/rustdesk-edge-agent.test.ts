import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { MemoryPg } from '../src/db-pg.js';
import {
  createRustDeskEdgeAgentConfigFromEnv,
  type RustDeskEdgeAgentConfig,
  runRustDeskEdgeAgentCommandOnce,
  runRustDeskEdgeAgentOffline,
  runRustDeskEdgeAgentOnce,
  runRustDeskNativeEvidenceCorrelationOnce
} from '../scripts/rustdesk-edge-agent.js';

test('rustdesk edge agent config validates required deployment inputs', () => {
  const config = createRustDeskEdgeAgentConfigFromEnv({
    OPC_BASE_URL: 'https://opc.example.com/',
    OPC_COLLABORATION_API_KEY: 'collaboration-key',
    OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
    OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
    OPC_RUSTDESK_EDGE_DEVICE_DISPLAY_NAME: 'LED control PC',
    OPC_RUSTDESK_EDGE_CLIENT_VERSION: '1.3.0',
    OPC_RUSTDESK_EDGE_OS: 'windows',
    OPC_RUSTDESK_EDGE_METADATA_JSON: '{"site_id":"shenzhen-store-7","agent_instance":"edge-agent-01"}',
    OPC_RUSTDESK_EDGE_HEARTBEAT_INTERVAL_MS: '45000',
    OPC_RUSTDESK_EDGE_OFFLINE_ON_EXIT: '1',
    OPC_RUSTDESK_EDGE_INSTANCE_ID: 'edge-store-a-01',
    OPC_RUSTDESK_EDGE_COMMAND_TOKEN: 'signed-edge-command-token',
    OPC_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS: '2500',
    OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS: '40000',
    OPC_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS: '15000',
    OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE: '/opt/opc/bin/disconnect-rustdesk-session',
    OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON: '["--mode","session","--controller","{controller_rustdesk_id}"]',
    OPC_RUSTDESK_EDGE_RESTART_EXECUTABLE: '/opt/opc/bin/restart-rustdesk-service',
    OPC_RUSTDESK_EDGE_RESTART_ARGS_JSON: '["--service","rustdesk"]',
    OPC_RUSTDESK_EDGE_SPOOL_DIR: '/var/lib/opc/rustdesk-edge-spool'
  });

  assert.equal(config.baseUrl, 'https://opc.example.com');
  assert.equal(config.apiKey, 'collaboration-key');
  assert.equal(config.tenantId, 'tenant_led');
  assert.equal(config.businessRef.type, 'service_order');
  assert.equal(config.businessRef.id, 'SO-10001');
  assert.equal(config.rustdeskId, '123456789');
  assert.equal(config.displayName, 'LED control PC');
  assert.equal(config.heartbeatIntervalMs, 45_000);
  assert.equal(config.offlineOnExit, true);
  assert.equal(config.edgeInstanceId, 'edge-store-a-01');
  assert.equal(config.commandToken, 'signed-edge-command-token');
  assert.equal(config.commandPollIntervalMs, 2_500);
  assert.equal(config.commandLeaseMs, 40_000);
  assert.equal(config.commandTimeoutMs, 15_000);
  assert.deepEqual(config.disconnectAdapter, {
    executable: '/opt/opc/bin/disconnect-rustdesk-session',
    args: ['--mode', 'session', '--controller', '{controller_rustdesk_id}']
  });
  assert.deepEqual(config.restartAdapter, {
    executable: '/opt/opc/bin/restart-rustdesk-service',
    args: ['--service', 'rustdesk']
  });
  assert.equal(config.disconnectCommandCapable, true);
  assert.equal(config.spoolDir, '/var/lib/opc/rustdesk-edge-spool');
  assert.equal(config.metadata.client_version, '1.3.0');
  assert.equal(config.metadata.os, 'windows');
  assert.equal(config.metadata.site_id, 'shenzhen-store-7');
  assert.equal(config.metadata.agent_instance, 'edge-agent-01');

  assert.throws(
    () => createRustDeskEdgeAgentConfigFromEnv({}),
    /OPC_RUSTDESK_EDGE_BASE_URL or OPC_BASE_URL is required/
  );
  assert.throws(
    () =>
      createRustDeskEdgeAgentConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_COLLABORATION_API_KEY: 'collaboration-key',
        OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001'
      }),
    /OPC_RUSTDESK_EDGE_RUSTDESK_ID or RUSTDESK_ID is required/
  );
  assert.throws(
    () =>
      createRustDeskEdgeAgentConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_COLLABORATION_API_KEY: 'collaboration-key',
        OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
        OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_EDGE_METADATA_JSON: '[]'
      }),
    /OPC_RUSTDESK_EDGE_METADATA_JSON must be a JSON object/
  );
  assert.throws(
    () =>
      createRustDeskEdgeAgentConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_COLLABORATION_API_KEY: 'collaboration-key',
        OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
        OPC_RUSTDESK_EDGE_RUSTDESK_ID_FILE: '/tmp/opc-missing-rustdesk-id'
      }),
    /OPC_RUSTDESK_EDGE_RUSTDESK_ID_FILE cannot be read: \/tmp\/opc-missing-rustdesk-id/
  );
  assert.throws(
    () =>
      createRustDeskEdgeAgentConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_COLLABORATION_API_KEY: 'collaboration-key',
        OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
        OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_EDGE_HEARTBEAT_INTERVAL_MS: 'soon'
      }),
    /OPC_RUSTDESK_EDGE_HEARTBEAT_INTERVAL_MS must be a number >= 10000/
  );
  assert.throws(
    () =>
      createRustDeskEdgeAgentConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_COLLABORATION_API_KEY: 'collaboration-key',
        OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
        OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_EDGE_HEARTBEAT_INTERVAL_MS: '9999'
      }),
    /OPC_RUSTDESK_EDGE_HEARTBEAT_INTERVAL_MS must be a number >= 10000/
  );
  assert.throws(
    () =>
      createRustDeskEdgeAgentConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_COLLABORATION_API_KEY: 'collaboration-key',
        OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
        OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
        OPC_RUSTDESK_EDGE_RUNTIME_STATUS: 'ready'
      }),
    /OPC_RUSTDESK_EDGE_RUNTIME_STATUS must be online or offline/
  );
  assert.throws(
    () =>
      createRustDeskEdgeAgentConfigFromEnv({
        OPC_RUSTDESK_EDGE_BASE_URL: 'ftp://opc.example.com',
        OPC_COLLABORATION_API_KEY: 'collaboration-key',
        OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
        OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789'
      }),
    /OPC_RUSTDESK_EDGE_BASE_URL must use http\(s\)/
  );
  assert.throws(
    () =>
      createRustDeskEdgeAgentConfigFromEnv({
        OPC_BASE_URL: 'rustdesk://opc.example.com',
        OPC_COLLABORATION_API_KEY: 'collaboration-key',
        OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
        OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789'
      }),
    /OPC_BASE_URL must use http\(s\)/
  );
  assert.throws(
    () => createRustDeskEdgeAgentConfigFromEnv({
      OPC_BASE_URL: 'https://opc.example.com',
      OPC_COLLABORATION_API_KEY: 'collaboration-key',
      OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
      OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
      OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE: '/opt/opc/bin/disconnect',
      OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON: '{"mode":"session"}'
    }),
    /OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON must be a JSON string array/
  );
  assert.throws(
    () => createRustDeskEdgeAgentConfigFromEnv({
      OPC_BASE_URL: 'https://opc.example.com',
      OPC_COLLABORATION_API_KEY: 'collaboration-key',
      OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
      OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
      OPC_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS: '249'
    }),
    /OPC_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS must be a number >= 250/
  );
  assert.throws(
    () => createRustDeskEdgeAgentConfigFromEnv({
      OPC_BASE_URL: 'https://opc.example.com',
      OPC_COLLABORATION_API_KEY: 'collaboration-key',
      OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
      OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
      OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS: '10000',
      OPC_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS: '10000'
    }),
    /must cover primary and fallback timeouts plus reporting margin/
  );
  assert.throws(
    () => createRustDeskEdgeAgentConfigFromEnv({
      OPC_BASE_URL: 'https://opc.example.com',
      OPC_COLLABORATION_API_KEY: 'collaboration-key',
      OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
      OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
      OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS: '30000',
      OPC_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS: '15000'
    }),
    /must cover primary and fallback timeouts plus reporting margin/
  );
  assert.throws(
    () => createRustDeskEdgeAgentConfigFromEnv({
      OPC_BASE_URL: 'https://opc.example.com',
      OPC_COLLABORATION_API_KEY: 'collaboration-key',
      OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
      OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
      OPC_RUSTDESK_EDGE_COMMAND_TOKEN: 'signed-edge-command-token',
      OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE: 'disconnect-rustdesk-session'
    }),
    /OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE must be an absolute path/
  );
  assert.throws(
    () => createRustDeskEdgeAgentConfigFromEnv({
      OPC_BASE_URL: 'https://opc.example.com',
      OPC_COLLABORATION_API_KEY: 'collaboration-key',
      OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
      OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
      OPC_RUSTDESK_EDGE_COMMAND_TOKEN: 'signed-edge-command-token',
      OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE: '/opt/opc/bin/disconnect',
      OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON: '["--value={server_command}"]'
    }),
    /contains unsupported RustDesk adapter placeholder: \{server_command\}/
  );
});

test('rustdesk edge agent can use one device-bound token file for every edge route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-device-token-'));
  const tokenFile = join(dir, 'edge-token');
  const token = 'device-bound-edge-token-material-1234567890';
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });

  const config = createRustDeskEdgeAgentConfigFromEnv({
    OPC_RUSTDESK_EDGE_BASE_URL: 'https://ivekit.example.com',
    OPC_RUSTDESK_EDGE_DEVICE_TOKEN_FILE: tokenFile,
    OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
    OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
    OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON: '[]',
    OPC_RUSTDESK_EDGE_SPOOL_DIR: 'C:\\ProgramData\\iveKit\\RustDesk\\spool',
    OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR: 'C:\\ProgramData\\iveKit\\RustDesk\\observations\\inbox',
    OPC_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR: 'C:\\ProgramData\\iveKit\\RustDesk\\observations\\spool',
    OPC_RUSTDESK_EDGE_OBSERVATION_POLL_INTERVAL_MS: '1500'
  });

  assert.equal(config.apiKey, token);
  assert.equal(config.commandToken, token);
  assert.equal(config.deviceTokenFile, tokenFile);
  assert.equal(config.observationInputDir, 'C:\\ProgramData\\iveKit\\RustDesk\\observations\\inbox');
  assert.equal(config.observationSpoolDir, 'C:\\ProgramData\\iveKit\\RustDesk\\observations\\spool');
  assert.equal(config.observationPollIntervalMs, 1_500);
  assert.throws(
    () => createRustDeskEdgeAgentConfigFromEnv({
      OPC_RUSTDESK_EDGE_BASE_URL: 'https://ivekit.example.com',
      OPC_RUSTDESK_EDGE_DEVICE_TOKEN_FILE: tokenFile,
      OPC_RUSTDESK_EDGE_API_KEY: 'platform-key-must-not-be-combined',
      OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
      OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789'
    }),
    /must not be combined with legacy API or command credentials/
  );
  assert.throws(
    () => createRustDeskEdgeAgentConfigFromEnv({
      OPC_RUSTDESK_EDGE_BASE_URL: 'https://ivekit.example.com',
      OPC_RUSTDESK_EDGE_DEVICE_TOKEN_FILE: tokenFile,
      OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
      OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
      OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
      OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR: 'C:\\ProgramData\\iveKit\\RustDesk\\observations\\inbox'
    }),
    /observation input and spool directories must be configured together/
  );
});

test('rustdesk edge agent device token mode uses the dedicated heartbeat without generic discovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-device-heartbeat-'));
  const tokenFile = join(dir, 'edge-token');
  writeFileSync(tokenFile, 'device-bound-edge-token-material-abcdefghijklmno\n', { mode: 0o600 });
  const config = createRustDeskEdgeAgentConfigFromEnv({
    OPC_RUSTDESK_EDGE_BASE_URL: 'https://ivekit.example.com',
    OPC_RUSTDESK_EDGE_DEVICE_TOKEN_FILE: tokenFile,
    OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'led_device',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'LED-10001',
    OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
    OPC_RUSTDESK_EDGE_INSTANCE_ID: 'windows-edge-01',
    OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR: join(dir, 'inbox'),
    OPC_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR: join(dir, 'spool'),
    OPC_RUSTDESK_EDGE_OBSERVATION_POLL_INTERVAL_MS: '2000',
    OPC_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR: join(dir, 'evidence-inbox'),
    OPC_RUSTDESK_EDGE_EVIDENCE_SPOOL_DIR: join(dir, 'evidence-spool'),
    OPC_RUSTDESK_EDGE_EVIDENCE_POLL_INTERVAL_MS: '2500',
    OPC_RUSTDESK_NATIVE_EVIDENCE_CANDIDATE_DIR: join(dir, 'native-candidates'),
    OPC_RUSTDESK_NATIVE_EVIDENCE_EVENT_DIR: join(dir, 'native-events'),
    OPC_RUSTDESK_NATIVE_EVIDENCE_SPOOL_DIR: join(dir, 'native-spool'),
    OPC_RUSTDESK_NATIVE_FILE_ROOTS_JSON: JSON.stringify([join(dir, 'native-files')]),
    OPC_RUSTDESK_NATIVE_RECORDING_ROOTS_JSON: JSON.stringify([join(dir, 'native-recordings')]),
    OPC_RUSTDESK_EDGE_CLIENT_VERSION: '1.4.7',
    OPC_RUSTDESK_EDGE_OS: 'windows'
  });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const result = await runRustDeskEdgeAgentOnce(config, async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({
      id: 'rdesk-device-1',
      rustdesk_id: '123456789',
      runtime_status: 'online',
      last_seen_at: '2026-07-15T06:00:00.000Z'
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  });

  assert.equal(result.deviceId, 'rdesk-device-1');
  assert.equal(result.registered, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://ivekit.example.com/api/ivekit/rustdesk/edge/heartbeat');
  assert.equal((requests[0].init?.headers as Record<string, string>)['x-rustdesk-edge-token'], config.commandToken);
  const body = JSON.parse(String(requests[0].init?.body));
  assert.equal(body.metadata.observation_capable, true);
  assert.equal(body.metadata.evidence_upload_capable, true);
  assert.equal(body.metadata.native_evidence_capable, true);
  assert.equal(body.metadata.evidence_poll_interval_ms, 2500);
  assert.equal(body.metadata.client_version, '1.4.7');
  assert.equal(body.metadata.os, 'windows');
});

test('rustdesk edge agent fetches device-bound context before correlating a native candidate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-native-correlation-agent-'));
  const tokenFile = join(dir, 'edge-token');
  const source = join(dir, 'native-files', 'transfer.bin');
  const candidateDir = join(dir, 'native-candidates');
  const eventDir = join(dir, 'native-events');
  writeFileSync(tokenFile, 'device-bound-edge-token-material-abcdefghijklmno\n', { mode: 0o600 });
  const { mkdirSync, readdirSync } = await import('node:fs');
  for (const path of [join(dir, 'native-files'), join(dir, 'native-recordings'), candidateDir, eventDir]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(source, 'candidate bytes');
  writeFileSync(join(candidateDir, 'candidate.json'), `${JSON.stringify({
    schema_version: 1,
    native_candidate_id: 'candidate-edge-1',
    root_class: 'file',
    source_path: source,
    filename: 'transfer.bin',
    size_bytes: 15,
    observed_unix_ms: Date.parse('2026-07-16T00:01:00.000Z'),
    controller_rustdesk_ids: ['135792468']
  })}\n`);
  const config = createRustDeskEdgeAgentConfigFromEnv({
    OPC_RUSTDESK_EDGE_BASE_URL: 'https://ivekit.example.com',
    OPC_RUSTDESK_EDGE_DEVICE_TOKEN_FILE: tokenFile,
    OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'led_device',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'LED-10001',
    OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
    OPC_RUSTDESK_EDGE_INSTANCE_ID: 'windows-edge-01',
    OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR: join(dir, 'observations-inbox'),
    OPC_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR: join(dir, 'observations-spool'),
    OPC_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR: join(dir, 'evidence-inbox'),
    OPC_RUSTDESK_EDGE_EVIDENCE_SPOOL_DIR: join(dir, 'evidence-spool'),
    OPC_RUSTDESK_NATIVE_EVIDENCE_CANDIDATE_DIR: candidateDir,
    OPC_RUSTDESK_NATIVE_EVIDENCE_EVENT_DIR: eventDir,
    OPC_RUSTDESK_NATIVE_EVIDENCE_SPOOL_DIR: join(dir, 'native-spool'),
    OPC_RUSTDESK_NATIVE_FILE_ROOTS_JSON: JSON.stringify([join(dir, 'native-files')]),
    OPC_RUSTDESK_NATIVE_RECORDING_ROOTS_JSON: JSON.stringify([join(dir, 'native-recordings')])
  });
  let request: { url: string; headers: Record<string, string> } | null = null;
  const result = await runRustDeskNativeEvidenceCorrelationOnce(config, 'rddev-edge-1', async (input, init) => {
    request = { url: String(input), headers: init?.headers as Record<string, string> };
    return new Response(JSON.stringify({
      schema_version: 1,
      device_id: 'rddev-edge-1',
      rustdesk_id: '123456789',
      generated_at: '2026-07-16T00:01:00.000Z',
      expires_at: '2099-07-16T00:02:00.000Z',
      bindings: [{
        kind: 'file',
        external_id: 'rdgw-edge-1',
        controller_rustdesk_id: '135792468',
        operation_id: 'transfer-edge-1',
        authorization_scope: 'operation',
        authorization_id: 'rdop-edge-1',
        direction: 'upload',
        control_version: 7,
        started_at: '2026-07-16T00:00:00.000Z',
        valid_until: '2099-07-16T00:15:00.000Z',
        file_name: 'transfer.bin'
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  assert.deepEqual(result, { correlated: 1, waiting: 0, quarantined: 0 });
  assert.equal(request?.url, 'https://ivekit.example.com/api/ivekit/rustdesk/devices/rddev-edge-1/evidence-context');
  assert.equal(request?.headers['x-rustdesk-edge-token'], config.commandToken);
  assert.equal(readdirSync(eventDir).filter((name) => name.endsWith('.json')).length, 1);
});

test('rustdesk edge agent rejects blank RustDesk ID files', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-edge-id-'));
  const rustdeskIdFile = join(dataDir, 'rustdesk-id.txt');
  writeFileSync(rustdeskIdFile, '\n  \n');

  assert.throws(
    () =>
      createRustDeskEdgeAgentConfigFromEnv({
        OPC_BASE_URL: 'https://opc.example.com',
        OPC_COLLABORATION_API_KEY: 'collaboration-key',
        OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
        OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-10001',
        OPC_RUSTDESK_EDGE_RUSTDESK_ID_FILE: rustdeskIdFile
      }),
    new RegExp(`OPC_RUSTDESK_EDGE_RUSTDESK_ID_FILE is empty: ${escapeRegExp(rustdeskIdFile)}`)
  );
});

test('rustdesk edge agent posts an offline heartbeat for an existing device', async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const result = await runRustDeskEdgeAgentOffline(
    {
      baseUrl: 'https://opc.example.com',
      apiKey: 'collaboration-key',
      tenantId: 'tenant_led',
      businessRef: { type: 'service_order', id: 'SO-10001' },
      rustdeskId: '123456789',
      displayName: 'LED control PC',
      actorIdentity: 'rustdesk-edge-agent',
      runtimeStatus: 'online',
      heartbeatIntervalMs: 60_000,
      offlineOnExit: true,
      metadata: { client_version: '1.3.0', os: 'windows' },
      seenAt: '2026-07-04T10:10:00.000Z'
    },
    async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ method: init.method || 'GET', path: `${url.pathname}${url.search}`, body });
      if (url.pathname === '/api/collaboration/rustdesk/devices/by-ref') {
        return jsonResponse(200, {
          data: [
            {
              id: 'rdesk_existing_1',
              status: 'active',
              rustdesk_id: '123456789',
              display_name: 'LED control PC'
            }
          ]
        });
      }
      if (url.pathname === '/api/collaboration/rustdesk/devices/rdesk_existing_1/heartbeat') {
        return jsonResponse(201, {
          data: {
            id: 'rdesk_existing_1',
            rustdesk_id: '123456789',
            runtime_status: 'offline',
            last_seen_at: '2026-07-04T10:10:00.000Z'
          }
        });
      }
      return jsonResponse(500, { error: 'unexpected request' });
    }
  );

  assert.deepEqual(result, {
    deviceId: 'rdesk_existing_1',
    rustdeskId: '123456789',
    registered: false,
    runtimeStatus: 'offline',
    lastSeenAt: '2026-07-04T10:10:00.000Z'
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'GET /api/collaboration/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=SO-10001&limit=50',
    'POST /api/collaboration/rustdesk/devices/rdesk_existing_1/heartbeat'
  ]);
  assert.deepEqual(calls[1]?.body, {
    actor_identity: 'rustdesk-edge-agent',
    runtime_status: 'offline',
    seen_at: '2026-07-04T10:10:00.000Z',
    metadata: {
      client_version: '1.3.0',
      os: 'windows',
        offline_reason: 'agent_exit',
        disconnect_command_capable: false,
        native_control_protocol: 'ivekit-rustdesk-native-control-v1',
        edge_instance_id: 'rustdesk-edge-agent',
      command_poll_interval_ms: 2_000
    }
  });
});

test('rustdesk edge agent reuses an existing registered device and posts heartbeat', async () => {
  const calls: Array<{
    method: string;
    path: string;
    body: Record<string, unknown> | null;
    authorization: string;
    edgeToken: string;
  }> = [];
  const result = await runRustDeskEdgeAgentOnce(
    {
      baseUrl: 'https://opc.example.com',
      apiKey: 'collaboration-key',
      tenantId: 'tenant_led',
      businessRef: { type: 'service_order', id: 'SO-10001' },
      rustdeskId: '123456789',
      displayName: 'LED control PC',
      actorIdentity: 'rustdesk-edge-agent',
      runtimeStatus: 'online',
      heartbeatIntervalMs: 60_000,
      edgeInstanceId: 'edge-heartbeat-capable',
      commandToken: 'signed-edge-heartbeat-token',
      commandPollIntervalMs: 2_500,
      commandLeaseMs: 40_000,
      commandTimeoutMs: 15_000,
      disconnectCommandCapable: true,
      metadata: { client_version: '1.3.0', os: 'windows' },
      seenAt: '2026-07-04T10:00:00.000Z'
    },
    async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({
        method: init.method || 'GET',
        path: `${url.pathname}${url.search}`,
        body,
        authorization: String((init.headers as Record<string, string>)?.authorization || ''),
        edgeToken: String((init.headers as Record<string, string>)?.['x-rustdesk-edge-token'] || '')
      });
      if (url.pathname === '/api/collaboration/rustdesk/devices/by-ref') {
        return jsonResponse(200, {
          data: [
            {
              id: 'rdesk_existing_1',
              status: 'active',
              rustdesk_id: '123456789',
              display_name: 'LED control PC'
            }
          ]
        });
      }
      if (url.pathname === '/api/collaboration/rustdesk/devices/rdesk_existing_1/heartbeat') {
        return jsonResponse(201, {
          data: {
            id: 'rdesk_existing_1',
            rustdesk_id: '123456789',
            runtime_status: 'online',
            last_seen_at: '2026-07-04T10:00:00.000Z'
          }
        });
      }
      return jsonResponse(500, { error: 'unexpected request' });
    }
  );

  assert.deepEqual(result, {
    deviceId: 'rdesk_existing_1',
    rustdeskId: '123456789',
    registered: false,
    runtimeStatus: 'online',
    lastSeenAt: '2026-07-04T10:00:00.000Z'
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'GET /api/collaboration/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=SO-10001&limit=50',
    'POST /api/collaboration/rustdesk/devices/rdesk_existing_1/heartbeat'
  ]);
  assert.equal(calls[0]?.authorization, 'Bearer collaboration-key');
  assert.equal(calls[1]?.edgeToken, 'signed-edge-heartbeat-token');
  assert.deepEqual(calls[1]?.body, {
    actor_identity: 'rustdesk-edge-agent',
    runtime_status: 'online',
    seen_at: '2026-07-04T10:00:00.000Z',
    metadata: {
      client_version: '1.3.0',
        os: 'windows',
        disconnect_command_capable: true,
        native_control_protocol: 'ivekit-rustdesk-native-control-v1',
        edge_instance_id: 'edge-heartbeat-capable',
      command_poll_interval_ms: 2_500
    }
  });
});

test('rustdesk edge agent includes OPC error details when heartbeat is rejected', async () => {
  await assert.rejects(
    () =>
      runRustDeskEdgeAgentOnce(
        {
          baseUrl: 'https://opc.example.com',
          apiKey: 'collaboration-key',
          tenantId: 'tenant_led',
          businessRef: { type: 'service_order', id: 'SO-10001' },
          rustdeskId: '123456789',
          displayName: 'LED control PC',
          actorIdentity: 'rustdesk-edge-agent',
          runtimeStatus: 'online',
          heartbeatIntervalMs: 60_000,
          metadata: { client_version: '1.3.0' }
        },
        async (input) => {
          const url = new URL(String(input));
          if (url.pathname === '/api/collaboration/rustdesk/devices/by-ref') {
            return jsonResponse(200, {
              data: [
                {
                  id: 'rdesk_existing_1',
                  status: 'active',
                  rustdesk_id: '123456789',
                  display_name: 'LED control PC'
                }
              ]
            });
          }
          return jsonResponse(409, { error: 'rustdesk device heartbeat tenant mismatch' });
        }
      ),
    /RustDesk edge agent request failed: POST \/api\/collaboration\/rustdesk\/devices\/rdesk_existing_1\/heartbeat 409 rustdesk device heartbeat tenant mismatch/
  );
});

test('rustdesk edge agent registers a missing device before heartbeat', async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const result = await runRustDeskEdgeAgentOnce(
    {
      baseUrl: 'https://opc.example.com',
      apiKey: 'collaboration-key',
      tenantId: 'tenant_led',
      businessRef: { type: 'service_order', id: 'SO-10002' },
      rustdeskId: '987654321',
      displayName: 'LED backup PC',
      actorIdentity: 'rustdesk-edge-agent',
      runtimeStatus: 'online',
      heartbeatIntervalMs: 60_000,
      metadata: { client_version: '1.3.0' },
      seenAt: '2026-07-04T10:05:00.000Z'
    },
    async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ method: init.method || 'GET', path: `${url.pathname}${url.search}`, body });
      if (url.pathname === '/api/collaboration/rustdesk/devices/by-ref') {
        return jsonResponse(200, { data: [] });
      }
      if (url.pathname === '/api/collaboration/rustdesk/devices') {
        return jsonResponse(201, {
          data: {
            id: 'rdesk_created_1',
            rustdesk_id: '987654321',
            display_name: 'LED backup PC'
          }
        });
      }
      if (url.pathname === '/api/collaboration/rustdesk/devices/rdesk_created_1/heartbeat') {
        return jsonResponse(201, {
          data: {
            id: 'rdesk_created_1',
            rustdesk_id: '987654321',
            runtime_status: 'online',
            last_seen_at: '2026-07-04T10:05:00.000Z'
          }
        });
      }
      return jsonResponse(500, { error: 'unexpected request' });
    }
  );

  assert.equal(result.registered, true);
  assert.equal(result.deviceId, 'rdesk_created_1');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'GET /api/collaboration/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=SO-10002&limit=50',
    'POST /api/collaboration/rustdesk/devices',
    'POST /api/collaboration/rustdesk/devices/rdesk_created_1/heartbeat'
  ]);
  assert.deepEqual(calls[1]?.body, {
    business_ref: {
      type: 'service_order',
      id: 'SO-10002'
    },
    rustdesk_id: '987654321',
    display_name: 'LED backup PC',
    metadata: {
      source: 'rustdesk-edge-agent',
      client_version: '1.3.0'
    }
  });
});

test('rustdesk edge agent command once advertises capability and executes claimed work', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const config: RustDeskEdgeAgentConfig = {
    baseUrl: 'https://opc.example.com',
    apiKey: 'edge-agent-api-key',
    tenantId: 'tenant_edge_command_once',
    businessRef: { type: 'service_order', id: 'SO-EDGE-COMMAND-ONCE' },
    rustdeskId: '1123581321',
    displayName: 'LED edge command PC',
    actorIdentity: 'rustdesk-edge-agent',
    runtimeStatus: 'online',
    heartbeatIntervalMs: 60_000,
    metadata: { client_version: '1.0.0', os: process.platform },
    edgeInstanceId: 'edge-command-once',
    commandToken: 'signed-edge-command-token-once',
    commandPollIntervalMs: 2_000,
    commandLeaseMs: 30_000,
    commandTimeoutMs: 2_000,
    disconnectAdapter: {
      executable: process.execPath,
      args: ['-e', 'process.exit(0)']
    },
    restartAdapter: null,
    disconnectCommandCapable: true
  };
  const result = await runRustDeskEdgeAgentCommandOnce(
    config,
    'rdesk_edge_command_once',
    async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ path: url.pathname, body });
      if (url.pathname.endsWith('/commands/claim')) {
        return jsonResponse(201, {
          command: {
            id: 'rdcmd_edge_command_once',
            command_type: 'disconnect_session',
            external_id: 'rdgw_edge_command_once',
            target_id: 'rdesk_edge_command_once',
            rustdesk_id: '1123581321',
            requested_reason: 'gateway_ended',
            attempt: 1,
            lease_expires_at: '2099-01-01T00:00:00.000Z'
          },
          claim_token: 'claim-token-edge-command-once'
        });
      }
      return jsonResponse(201, { command: { status: 'succeeded' } });
    }
  );

  assert.equal(result, 'executed');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/ivekit/rustdesk/devices/rdesk_edge_command_once/commands/claim',
    '/api/ivekit/rustdesk/devices/rdesk_edge_command_once/commands/rdcmd_edge_command_once/result'
  ]);
  assert.equal(calls[0]?.body.edge_instance_id, 'edge-command-once');
  assert.equal(calls[0]?.body.lease_ms, 30_000);
  assert.equal(calls[1]?.body.execution_method, 'session_adapter');
});

test('rustdesk edge agent interoperates with the collaboration device API', async () => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'edge-agent-api-key';
  const pg = new MemoryPg();
  const config: RustDeskEdgeAgentConfig = {
    baseUrl: 'http://opc.local',
    apiKey: 'edge-agent-api-key',
    tenantId: 'tenant_edge_agent_api',
    businessRef: { type: 'service_order', id: 'SO-EDGE-1' },
    rustdeskId: '1122334455',
    displayName: 'LED edge PC',
    actorIdentity: 'rustdesk-edge-agent',
    runtimeStatus: 'online',
    heartbeatIntervalMs: 60_000,
    offlineOnExit: false,
    metadata: { client_version: '1.3.0', os: 'windows' },
    seenAt: '2026-07-04T11:00:00.000Z'
  };

  try {
    const first = await runRustDeskEdgeAgentOnce(config, routeFetch(pg));
    const second = await runRustDeskEdgeAgentOnce({
      ...config,
      seenAt: '2026-07-04T11:01:00.000Z'
    }, routeFetch(pg));
    const offline = await runRustDeskEdgeAgentOffline({
      ...config,
      seenAt: '2026-07-04T11:02:00.000Z'
    }, routeFetch(pg));

    assert.equal(first.registered, true);
    assert.equal(first.rustdeskId, '1122334455');
    assert.equal(first.runtimeStatus, 'online');
    assert.equal(first.lastSeenAt, '2026-07-04T11:00:00.000Z');
    assert.equal(second.registered, false);
    assert.equal(second.deviceId, first.deviceId);
    assert.equal(second.lastSeenAt, '2026-07-04T11:01:00.000Z');
    assert.equal(offline.registered, false);
    assert.equal(offline.deviceId, first.deviceId);
    assert.equal(offline.runtimeStatus, 'offline');
    assert.equal(offline.lastSeenAt, '2026-07-04T11:02:00.000Z');
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPC_API_KEY;
    } else {
      process.env.OPC_API_KEY = previousApiKey;
    }
  }
});

test('rustdesk edge agent is wired into scripts and env examples', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:edge-agent'], 'tsx scripts/rustdesk-edge-agent.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const key of [
    'OPC_RUSTDESK_EDGE_BASE_URL=',
    'OPC_RUSTDESK_EDGE_API_KEY=',
    'OPC_RUSTDESK_EDGE_COMMAND_TOKEN=',
    'OPC_RUSTDESK_EDGE_COMMAND_TOKEN_FILE=',
    'OPC_RUSTDESK_EDGE_TENANT_ID=',
    'OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE=',
    'OPC_RUSTDESK_EDGE_BUSINESS_REF_ID=',
    'OPC_RUSTDESK_EDGE_RUSTDESK_ID=',
    'OPC_RUSTDESK_EDGE_METADATA_JSON=',
    'OPC_RUSTDESK_EDGE_DEVICE_DISPLAY_NAME=',
    'OPC_RUSTDESK_EDGE_HEARTBEAT_INTERVAL_MS=',
    'OPC_RUSTDESK_NATIVE_EVIDENCE_CANDIDATE_DIR=',
    'OPC_RUSTDESK_NATIVE_EVIDENCE_EVENT_DIR=',
    'OPC_RUSTDESK_NATIVE_EVIDENCE_SPOOL_DIR=',
    'OPC_RUSTDESK_NATIVE_FILE_ROOTS_JSON=',
    'OPC_RUSTDESK_NATIVE_RECORDING_ROOTS_JSON=',
    'OPC_RUSTDESK_EDGE_ONCE=',
    'OPC_RUSTDESK_EDGE_OFFLINE_ON_EXIT='
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, 'm'));
  }
  for (const key of [
    'OPC_RUSTDESK_SESSION_DISCONNECT_HOOK=',
    'OPC_RUSTDESK_SERVICE_NAME=',
    'OPC_RUSTDESK_LAUNCHD_LABEL='
  ]) assert.match(envExample, new RegExp(`^${key}`, 'm'));
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function routeFetch(pg: MemoryPg): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const rawBody = init.body ? String(init.body) : '';
    const body = rawBody ? JSON.parse(rawBody) : null;
    const result = await routeCollaborationApi(
      pg,
      init.method || 'GET',
      url.pathname,
      url,
      body,
      rawBody,
      headersRecord(init.headers)
    ) as { status?: number; data?: unknown } | undefined;
    if (!result) return jsonResponse(404, { error: 'not found' });
    return jsonResponse(result.status || 200, result.data);
  }) as typeof fetch;
}

function headersRecord(headers: RequestInit['headers'] | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
