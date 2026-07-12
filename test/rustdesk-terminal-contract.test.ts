import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createIveKitRustDeskHttpClient } from '../sdk/ivekit/src/rustdesk-http-client.js';

const typesSource = readFileSync('sdk/ivekit/src/types.ts', 'utf8');
const clientSource = readFileSync('sdk/ivekit/src/rustdesk-http-client.ts', 'utf8');

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

test('RustDesk HTTP client preserves the existing lifecycle and adds profile and access policy methods', () => {
  const client = createIveKitRustDeskHttpClient({
    baseUrl: 'https://ivekit.example.test',
    accessToken: 'short-lived-browser-token',
    tenantId: 'tenant-led',
    fetch: async () => new Response('{}', { status: 200 })
  });

  assert.deepEqual(Object.keys(client).sort(), [
    'configureAccessPolicy',
    'deactivateDevice',
    'endGatewaySession',
    'getAccessPolicy',
    'getClientConfig',
    'getClientProfile',
    'getDevice',
    'getGatewayDisconnectState',
    'getGatewayLaunchPlan',
    'heartbeatDevice',
    'listAccessPolicyHistory',
    'listDevicesByBusinessRef',
    'listGatewayAuditEvents',
    'recordGatewayEvent',
    'registerDevice',
    'revokeAccessPolicy',
    'startGatewaySession'
  ]);
  const legacyDisconnect = interfaceBody(clientSource, 'IveKitRustDeskGatewayDisconnectState');
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
  assert.doesNotMatch(typeContractTest, /['"]sdk\/ivekit\/node_modules\/typescript\/bin\/tsc['"]/);
});

test('RustDesk client matrix pins OSS versions and platform limitations without claiming real acceptance', () => {
  const matrixPath = 'docs/rustdesk-client-version-matrix.md';
  assert.equal(existsSync(matrixPath), true, `${matrixPath} must exist`);
  const matrix = readFileSync(matrixPath, 'utf8');

  assert.match(matrix, /rustdesk-server:1\.1\.15/);
  assert.match(matrix, /RustDesk OSS client 1\.4\.7/);
  assert.match(matrix, /releases\/tag\/1\.4\.7/);
  assert.doesNotMatch(matrix, /rustdesk-server:latest/);
  for (const envPath of ['.env.example', 'infra/env.example', 'infra/ivekit/env.example']) {
    const env = readFileSync(envPath, 'utf8');
    assert.match(env, /^RUSTDESK_SERVER_IMAGE_TAG=1\.1\.15$/m, envPath);
    assert.doesNotMatch(env, /^RUSTDESK_SERVER_IMAGE_TAG=(?:latest|1\.1\.14)$/m, envPath);
  }
  for (const composePath of ['docker-compose.callcenter.yml', 'infra/docker-compose.production.yml']) {
    const compose = readFileSync(composePath, 'utf8');
    assert.match(compose, /rustdesk\/rustdesk-server:\$\{RUSTDESK_SERVER_IMAGE_TAG:-1\.1\.15\}/, composePath);
    assert.doesNotMatch(compose, /RUSTDESK_SERVER_IMAGE_TAG:-latest/, composePath);
  }
  for (const expected of ['Windows', 'macOS', 'Linux', 'x86_64', 'aarch64', 'Wayland', 'not_run']) {
    assert.match(matrix, new RegExp(expected));
  }
  assert.match(matrix, /configured[\s\S]*available[\s\S]*granted[\s\S]*observed/);

  const detailedDesign = readFileSync('docs/iveKit视频IM通用能力详细设计.md', 'utf8');
  assert.match(detailedDesign, /RUSTDESK_SERVER_IMAGE_TAG=1\.1\.15/);
  assert.doesNotMatch(detailedDesign, /RUSTDESK_SERVER_IMAGE_TAG=latest/);
});

test('RustDesk public docs link the frozen matrix and explain capability truth states', () => {
  for (const path of ['docs/ivekit-openapi.md', 'docs/iveKit视频IM通用能力详细设计.md']) {
    const doc = readFileSync(path, 'utf8');
    assert.match(doc, /rustdesk-client-version-matrix\.md/);
    assert.match(doc, /configured/);
    assert.match(doc, /available/);
    assert.match(doc, /granted/);
    assert.match(doc, /observed/);
    assert.match(doc, /not_observed/);
    assert.match(doc, /top-level `operation_id`[^.。\n]*authoritative/);
    assert.match(doc, /IveKitRustDeskGatewayDisconnectState[^.。\n]*interface/);
    assert.match(doc, /declaration merging/);
    assert.match(doc, /extends consumers/);
    assert.doesNotMatch(doc, /TypeScript source-compatibility risk/);
    assert.match(doc, /base URL[^.。\n]*root[^.。\n]*path/);
    assert.match(doc, /`launch_url`[^。\n]*opaque/);
    assert.doesNotMatch(doc, /不接收[^。\n]*signed launch token/);
  }
});

test('RustDesk client config pack command guidance keeps launch URLs runtime-only', () => {
  const detailedDesign = readFileSync('docs/iveKit视频IM通用能力详细设计.md', 'utf8');
  const row = detailedDesign.match(/\| `npm run rustdesk:client-config-pack` \|([^\n]+)\|/);
  assert.ok(row, 'rustdesk:client-config-pack command guidance must exist');
  assert.doesNotMatch(row[1], /把 launch URL、protocol URL[^。]*写入 Markdown/);
  assert.match(row[1], /launch_url.*protocol_url.*保持为空/);
  assert.match(row[1], /availability/);
  assert.match(row[1], /用户主动发起启动前立即调用 `getGatewayLaunchPlan\(\)`/);
});

test('iveKit SDK RustDesk sources remain browser-safe and independent from OPC server source', () => {
  const sourceDir = 'sdk/ivekit/src';
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
