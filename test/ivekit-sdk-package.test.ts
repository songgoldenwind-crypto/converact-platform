import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createIveKitClient } from '../sdk/ivekit/src/index.js';
import { createIveKitClient as createLegacyIveKitClient } from '../src/agent-runtime/ivekit/index.js';

test('iveKit SDK exposes media chat voice contact center and rustdesk through one factory', () => {
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
  assert.equal(typeof sdk.events.getHeadCursor, 'function');
  assert.equal(typeof sdk.events.replay, 'function');
  assert.equal(typeof sdk.voice.createOutboundCall, 'function');
  assert.equal(typeof sdk.voice.createExtensionSession, 'function');
  assert.equal(typeof sdk.contactCenter.getMonitorSnapshot, 'function');
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

  const entrypoint = readFileSync('sdk/ivekit/src/index.ts', 'utf8');
  const readme = readFileSync('sdk/ivekit/README.md', 'utf8');
  assert.match(entrypoint, /export type \* from '\.\/chat-types\.js'/);
  assert.match(entrypoint, /export type \* from '\.\/media-types\.js'/);
  assert.match(entrypoint, /export type \* from '\.\/event-types\.js'/);
  assert.match(entrypoint, /export type \* from '\.\/voice-types\.js'/);
  assert.match(entrypoint, /export type \* from '\.\/contact-center-types\.js'/);
  assert.match(entrypoint, /export \* from '\.\/voice-controller\.js'/);
  assert.match(readme, /IveKitChatSnapshot/);
  assert.match(readme, /IveKitMediaCallSnapshot/);
  assert.match(readme, /createOutboundCall/);
  assert.match(readme, /extension_sessions/);
  assert.match(readme, /createIveKitVoiceController/);
  assert.match(readme, /receive-only/);
});

test('root build commands and production image include the iveKit SDK', () => {
  const root = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  assert.equal(root.scripts?.['build:ivekit-sdk'], 'npm --prefix sdk/ivekit run build');
  assert.equal(root.scripts?.['pack:ivekit-sdk'], 'npm pack ./sdk/ivekit --dry-run');
  assert.equal(
    root.scripts?.['verify:ivekit:foundation'],
    'npm run test:ivekit:foundation && npm run build:ivekit-sdk && npm run pack:ivekit-sdk'
  );
  assert.match(dockerfile, /COPY sdk\/ivekit \.\/sdk\/ivekit/);
});

test('LED integration documentation describes the delivered standalone contract', () => {
  const guide = readFileSync('docs/ivekit-led-integration-guide.md', 'utf8');
  const openapi = readFileSync('docs/ivekit-openapi.md', 'utf8');

  for (const expected of [
    '@opc/ivekit-sdk',
    'npm run start:ivekit',
    '/api/ivekit/media/*',
    '/api/ivekit/chat/*',
    '/api/ivekit/rustdesk/*',
    'Node 后端',
    '浏览器',
    '兼容导出'
  ]) {
    assert.match(guide, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(guide, /尚未打包为独立 npm package|独立进程尚未创建/);
  assert.match(openapi, /@opc\/ivekit-sdk/);
  assert.match(openapi, /standalone|独立进程/i);
});
