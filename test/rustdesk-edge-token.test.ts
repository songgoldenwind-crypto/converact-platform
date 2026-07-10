import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { verifyRustDeskEdgeCommandToken } from '../src/agent-runtime/collaboration/rustdesk-edge-auth.js';
import { createRustDeskEdgeAgentConfigFromEnv } from '../scripts/rustdesk-edge-agent.js';
import {
  createRustDeskEdgeTokenFileConfigFromEnv,
  writeRustDeskEdgeTokenFile
} from '../scripts/rustdesk-edge-token.js';

const secret = 'rustdesk-edge-token-file-test-secret-32-bytes';

test('RustDesk edge token generator writes a device-bound token with restricted permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-edge-token-'));
  const outputFile = join(dir, 'edge-command.token');
  const config = createRustDeskEdgeTokenFileConfigFromEnv({
    OPC_RUSTDESK_EDGE_TOKEN_SECRET: secret,
    OPC_RUSTDESK_EDGE_TOKEN_TENANT_ID: 'tenant_led',
    OPC_RUSTDESK_EDGE_TOKEN_RUSTDESK_ID: '123456789',
    OPC_RUSTDESK_EDGE_TOKEN_INSTANCE_ID: 'edge-led-1',
    OPC_RUSTDESK_EDGE_TOKEN_TTL_MS: '86400000',
    OPC_RUSTDESK_EDGE_TOKEN_NOW: '2026-07-10T12:00:00.000Z',
    OPC_RUSTDESK_EDGE_TOKEN_OUTPUT_FILE: outputFile
  });

  const written = writeRustDeskEdgeTokenFile(config);
  const token = readFileSync(outputFile, 'utf8').trim();

  assert.equal(written.outputFile, outputFile);
  assert.equal(written.expiresAt, '2026-07-11T12:00:00.000Z');
  assert.equal(statSync(outputFile).mode & 0o077, 0);
  assert.equal(token.includes(secret), false);
  assert.equal(
    verifyRustDeskEdgeCommandToken(token, secret, '2026-07-10T12:01:00.000Z').edge_instance_id,
    'edge-led-1'
  );
  const edgeConfig = createRustDeskEdgeAgentConfigFromEnv({
    OPC_BASE_URL: 'https://opc.example.com',
    OPC_COLLABORATION_API_KEY: 'collaboration-key',
    OPC_RUSTDESK_EDGE_TENANT_ID: 'tenant_led',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE: 'service_order',
    OPC_RUSTDESK_EDGE_BUSINESS_REF_ID: 'SO-EDGE-TOKEN',
    OPC_RUSTDESK_EDGE_RUSTDESK_ID: '123456789',
    OPC_RUSTDESK_EDGE_COMMAND_TOKEN_FILE: outputFile,
    OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE: process.execPath
  });
  assert.equal(edgeConfig.commandToken, token);
});

test('RustDesk edge token generator is wired as a package script', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.['rustdesk:edge-token'], 'tsx scripts/rustdesk-edge-token.ts');
  assert.match(readFileSync('.env.example', 'utf8'), /^OPC_RUSTDESK_EDGE_COMMAND_TOKEN=$/m);
  assert.match(readFileSync('infra/env.example', 'utf8'), /^OPC_RUSTDESK_EDGE_TOKEN_SECRET=$/m);
});
