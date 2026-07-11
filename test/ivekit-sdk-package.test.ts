import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createIveKitClient } from '../sdk/ivekit/src/index.js';
import { createIveKitClient as createLegacyIveKitClient } from '../src/agent-runtime/ivekit/index.js';

test('iveKit SDK exposes media chat and rustdesk through one factory', () => {
  const sdk = createIveKitClient({
    baseUrl: 'https://ivekit.example.test',
    tenantId: 'tenant-led',
    apiKey: 'test-key',
    userId: 'engineer-1',
    fetch: async () => new Response('{}', { status: 200 })
  });

  assert.equal(typeof sdk.media.createRoom, 'function');
  assert.equal(typeof sdk.chat.postMessage, 'function');
  assert.equal(typeof sdk.rustdesk.startGatewaySession, 'function');
  assert.equal(typeof sdk.rustdesk.ensureDevice, 'function');
  assert.equal(typeof sdk.rustdesk.startSession, 'function');
});

test('legacy iveKit module entrypoint keeps the unified client export', () => {
  assert.equal(createLegacyIveKitClient, createIveKitClient);
});

test('iveKit SDK package has no server-side source imports', () => {
  const sourceDir = 'sdk/ivekit/src';
  for (const filename of readdirSync(sourceDir).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(sourceDir, filename), 'utf8');
    assert.doesNotMatch(source, /agent-runtime|db-pg|node:fs|livekit-server-sdk/);
  }
});

test('iveKit SDK package publishes only compiled output and documentation', () => {
  const pkg = JSON.parse(readFileSync('sdk/ivekit/package.json', 'utf8')) as {
    name: string;
    files: string[];
    exports: Record<string, unknown>;
    sideEffects: boolean;
  };
  assert.equal(pkg.name, '@opc/ivekit-sdk');
  assert.deepEqual(pkg.files, ['dist', 'README.md']);
  assert.equal(pkg.sideEffects, false);
  assert.ok(pkg.exports['.']);
});

test('root build commands and production image include the iveKit SDK', () => {
  const root = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  assert.equal(root.scripts?.['build:ivekit-sdk'], 'npm --prefix sdk/ivekit run build');
  assert.equal(root.scripts?.['pack:ivekit-sdk'], 'npm pack ./sdk/ivekit --dry-run');
  assert.match(dockerfile, /COPY sdk\/ivekit \.\/sdk\/ivekit/);
});
