import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createConveractFabricRustDeskHttpClient } from '../sdk/converact/src/rustdesk-http-client.js';

const typesSource = readFileSync('sdk/converact/src/types.ts', 'utf8');
const clientSource = readFileSync('sdk/converact/src/rustdesk-http-client.ts', 'utf8');

test('RustDesk terminal DTOs keep configured, available, granted, and observed states distinct', () => {
  for (const dto of [
    'RustDeskTerminalProfile',
    'RustDeskTerminalPlatform',
    'RustDeskTerminalArchitecture',
    'RustDeskClientVersion',
    'RustDeskConfiguredFields',
    'RustDeskRuntimeCapabilities',
    'RustDeskPermissionScopes',
    'RustDeskControlOwnership',
    'RustDeskDisconnectState',
    'RustDeskOperationEvidence',
    'RustDeskOperationEvidenceMetadata'
  ]) {
    assert.match(typesSource, new RegExp(`export (?:interface|type) ${dto}\\b`));
  }

  const profile = interfaceBody(typesSource, 'RustDeskTerminalProfile');
  assert.match(profile, /configured:\s*RustDeskConfiguredFields/);
  assert.match(profile, /available:\s*RustDeskRuntimeCapabilities/);
  assert.match(profile, /granted:\s*RustDeskPermissionScopes/);
  assert.match(profile, /observed:\s*RustDeskOperationEvidence\[\]/);

  const configured = interfaceBody(typesSource, 'RustDeskConfiguredFields');
  for (const field of [
    'id_server_configured',
    'relay_server_configured',
    'api_server_configured',
    'public_key_configured'
  ]) {
    assert.match(configured, new RegExp(`${field}:\\s*boolean`));
  }
  assert.doesNotMatch(configured, /api_key|private_key|signing_secret|password|credential/);

  assert.match(typesSource, /export type RustDeskOperationEvidence\s*=/);
  const evidenceMetadata = interfaceBody(typesSource, 'RustDeskOperationEvidenceMetadata');
  for (const field of [
    'external_id',
    'provider_operation_id',
    'provider_session_id',
    'direction',
    'display_id',
    'byte_count',
    'checksum_sha256',
    'duration_ms',
    'reason',
    'status_detail'
  ]) {
    assert.match(evidenceMetadata, new RegExp(`${field}\\?`));
  }
  assert.doesNotMatch(evidenceMetadata, /^\s*operation_id\?/m);
  assert.doesNotMatch(evidenceMetadata, /Record<|\[key:|clipboard_(?:content|text)|file_(?:content|path)|keystrokes|screen_pixels|token|credential|password/);
});

test('RustDesk HTTP client preserves the lifecycle and adds policy and control ownership methods', () => {
  const client = createConveractFabricRustDeskHttpClient({
    baseUrl: 'https://converact.example.test',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant-led',
    fetch: async () => new Response('{}', { status: 200 })
  });

  assert.deepEqual(Object.keys(client).sort(), [
    'acquireControl',
    'authorizeEmergencyFallback',
    'configureAccessPolicy',
    'confirmOperation',
    'deactivateDevice',
    'endGatewaySession',
    'getAccessPolicy',
    'getAuthorizationCode',
    'getClientConfig',
    'getClientProfile',
    'getControlOwnership',
    'getDevice',
    'getGatewayDisconnectState',
    'getGatewayLaunchPlan',
    'heartbeatControl',
    'heartbeatDevice',
    'issueControlConfirmation',
    'listAccessPolicyHistory',
    'listDevicesByBusinessRef',
    'listGatewayAuditEvents',
    'recordGatewayEvent',
    'registerDevice',
    'releaseControl',
    'requestAuthorizationCode',
    'revokeAccessPolicy',
    'startGatewaySession',
    'transferControl',
    'verifyAuthorizationCode'
  ]);
  const legacyDisconnect = interfaceBody(clientSource, 'ConveractFabricRustDeskGatewayDisconnectState');
  assert.match(legacyDisconnect, /required:\s*true/);
  assert.match(legacyDisconnect, /status:\s*RustDeskDeviceCommandStatus \| 'unavailable'/);
  assert.match(legacyDisconnect, /command:\s*RustDeskDeviceCommand \| null/);
  assert.match(
    clientSource,
    /getGatewayDisconnectState\(externalId: string\): Promise<RustDeskDisconnectState>/
  );
});

test('RustDesk type contract uses the reproducible root TypeScript compiler', () => {
  const typeContractTest = readFileSync('test/rustdesk-terminal-type-contract.test.ts', 'utf8');
  const compilerPath = typeContractTest.match(/['"]([^'"]*node_modules\/typescript\/bin\/tsc)['"]/)?.[1];

  assert.equal(compilerPath, 'node_modules/typescript/bin/tsc');
  assert.doesNotMatch(typeContractTest, /['"]sdk\/converact\/node_modules\/typescript\/bin\/tsc['"]/);
});

test('RustDesk client matrix pins OSS versions and platform limitations without claiming real acceptance', () => {
  const matrixPath = 'docs/rustdesk-client-version-matrix.md';
  assert.equal(existsSync(matrixPath), true, `${matrixPath} must exist`);
  const matrix = readFileSync(matrixPath, 'utf8');

  assert.match(matrix, /1\.1\.16@73523b31cfd25d77dee862e6fc9f5e1fb5e485ef/);
  assert.match(matrix, /1\.4\.9@6c578292e8ebbbec708b76986ba8c4bc7c509747/);
  assert.match(matrix, /releases\/tag\/1\.1\.16/);
  assert.match(matrix, /releases\/tag\/1\.4\.9/);
  assert.doesNotMatch(matrix, /rustdesk-server:latest/);
  for (const envPath of ['.env.example', 'infra/env.example', 'infra/converact/env.example']) {
    const env = readFileSync(envPath, 'utf8');
    assert.match(env, /^RUSTDESK_SERVER_IMAGE_TAG=1\.1\.16$/m, envPath);
    assert.doesNotMatch(env, /^RUSTDESK_SERVER_IMAGE_TAG=(?:latest|1\.1\.14)$/m, envPath);
  }
  const localCompose = readFileSync('docker-compose.callcenter.yml', 'utf8');
  assert.match(localCompose, /rustdesk\/rustdesk-server:\$\{RUSTDESK_SERVER_IMAGE_TAG:-1\.1\.16\}/);
  assert.doesNotMatch(localCompose, /RUSTDESK_SERVER_IMAGE_TAG:-latest/);

  const productionCompose = readFileSync('infra/docker-compose.production.yml', 'utf8');
  assert.match(
    productionCompose,
    /image: \$\{RUSTDESK_SERVER_IMAGE:\?RUSTDESK_SERVER_IMAGE immutable digest reference is required\}/
  );
  assert.doesNotMatch(productionCompose, /rustdesk\/rustdesk-server:/);

  for (const envPath of ['infra/env.example', 'infra/converact/env.example']) {
    const env = readFileSync(envPath, 'utf8');
    assert.match(
      env,
      /^RUSTDESK_SERVER_IMAGE=ghcr\.io\/songgoldenwind-crypto\/converact-rustdesk-server:1\.1\.16-ivekit\.1-73523b31@sha256:[a-f0-9]{64}$/m,
      envPath
    );
  }
  for (const expected of ['Windows', 'macOS', 'Linux', 'x86_64', 'aarch64', 'Wayland', 'not_run']) {
    assert.match(matrix, new RegExp(expected));
  }
  assert.match(matrix, /configured[\s\S]*available[\s\S]*granted[\s\S]*observed/);

  const detailedDesign = readFileSync('docs/converact-fabric-video-im-capability-design.md', 'utf8');
  assert.match(detailedDesign, /RUSTDESK_SERVER_IMAGE_TAG=1\.1\.16/);
  assert.doesNotMatch(detailedDesign, /RUSTDESK_SERVER_IMAGE_TAG=latest/);
});

test('RustDesk public docs link the frozen matrix and explain capability truth states', () => {
  for (const path of ['docs/converact-openapi.md', 'docs/converact-fabric-video-im-capability-design.md']) {
    const doc = readFileSync(path, 'utf8');
    assert.match(doc, /rustdesk-client-version-matrix\.md/);
    assert.match(doc, /configured/);
    assert.match(doc, /available/);
    assert.match(doc, /granted/);
    assert.match(doc, /observed/);
    assert.match(doc, /not_observed/);
    assert.match(doc, /top-level `operation_id`[^.。\n]*authoritative/);
    assert.match(doc, /ConveractFabricRustDeskGatewayDisconnectState[^.。\n]*interface/);
    assert.match(doc, /declaration merging/);
    assert.match(doc, /extends consumers/);
    assert.doesNotMatch(doc, /TypeScript source-compatibility risk/);
    assert.match(doc, /base URL[^.。\n]*root[^.。\n]*path/);
    assert.match(doc, /`launch_url`[^。\n]*opaque/);
    assert.doesNotMatch(doc, /不接收[^。\n]*signed launch token/);
  }
});

test('RustDesk client config pack command guidance keeps launch URLs runtime-only', () => {
  const detailedDesign = readFileSync('docs/converact-fabric-video-im-capability-design.md', 'utf8');
  const row = detailedDesign.match(/\| `npm run rustdesk:client-config-pack` \|([^\n]+)\|/);
  assert.ok(row, 'rustdesk:client-config-pack command guidance must exist');
  assert.doesNotMatch(row[1], /把 launch URL、protocol URL[^。]*写入 Markdown/);
  assert.match(row[1], /launch_url.*protocol_url.*保持为空/);
  assert.match(row[1], /availability/);
  assert.match(row[1], /用户主动发起启动前立即调用 `getGatewayLaunchPlan\(\)`/);
});

test('Converact Fabric SDK RustDesk sources remain browser-safe and independent from Converact server source', () => {
  const sourceDir = 'sdk/converact/src';
  for (const filename of readdirSync(sourceDir).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(sourceDir, filename), 'utf8');
    assert.doesNotMatch(source, /from ['"]node:/, filename);
    assert.doesNotMatch(source, /src\/agent-runtime|agent-runtime|db-pg|livekit-server-sdk/, filename);
  }
});

function interfaceBody(source: string, name: string): string {
  const match = source.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `${name} interface must exist`);
  return match[1];
}
