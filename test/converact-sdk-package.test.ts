import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createConveractFabricClient } from '../sdk/converact/src/index.js';
import { createConveractFabricClient as createLegacyConveractFabricClient } from '../src/agent-runtime/converact/index.js';

test('Converact Fabric SDK exposes media chat voice contact center and rustdesk through one factory', () => {
  const sdk = createConveractFabricClient({
    baseUrl: 'https://converact.example.test',
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

test('legacy Converact Fabric module entrypoint keeps the unified client export', () => {
  assert.equal(createLegacyConveractFabricClient, createConveractFabricClient);
});

test('Converact Fabric SDK package has no server-side source imports', () => {
  const sourceDir = 'sdk/converact/src';
  for (const filename of readdirSync(sourceDir).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(sourceDir, filename), 'utf8');
    assert.doesNotMatch(source, /agent-runtime|db-pg|node:fs|livekit-server-sdk/);
  }
});

test('Converact Fabric SDK package publishes only compiled output and documentation', () => {
  const pkg = JSON.parse(readFileSync('sdk/converact/package.json', 'utf8')) as {
    name: string;
    files: string[];
    exports: Record<string, unknown>;
    sideEffects: boolean;
  };
  assert.equal(pkg.name, '@converact/sdk');
  assert.deepEqual(pkg.files, ['dist', 'examples', 'README.md']);
  assert.equal(pkg.sideEffects, false);
  assert.ok(pkg.exports['.']);

  const entrypoint = readFileSync('sdk/converact/src/index.ts', 'utf8');
  const readme = readFileSync('sdk/converact/README.md', 'utf8');
  assert.match(entrypoint, /export type \* from '\.\/chat-types\.js'/);
  assert.match(entrypoint, /export type \* from '\.\/media-types\.js'/);
  assert.match(entrypoint, /export type \* from '\.\/event-types\.js'/);
  assert.match(entrypoint, /export type \* from '\.\/voice-types\.js'/);
  assert.match(entrypoint, /export type \* from '\.\/contact-center-types\.js'/);
  assert.match(entrypoint, /export \* from '\.\/voice-controller\.js'/);
  assert.match(entrypoint, /export \* from '\.\/webhook\.js'/);
  assert.match(readme, /ConveractFabricChatSnapshot/);
  assert.match(readme, /ConveractFabricMediaCallSnapshot/);
  assert.match(readme, /createOutboundCall/);
  assert.match(readme, /extension_sessions/);
  assert.match(readme, /createConveractFabricVoiceController/);
  assert.match(readme, /Realtime Voice AI/);
  assert.match(readme, /receive-only/);
});

test('Converact Fabric SDK publishes the provider-neutral Realtime Voice AI contract', () => {
  const source = readFileSync('sdk/converact/src/voice-types.ts', 'utf8');
  for (const expected of [
    'ConveractFabricRealtimeVoiceAiProvider',
    'active_call',
    'livekit_agents',
    'self_hosted',
    'third_party',
    'ConveractFabricRealtimeVoiceAiCapabilities',
    'ConveractFabricStartRealtimeVoiceAiSessionInput',
    'ConveractFabricRealtimeVoiceAiSessionPlan',
    'ConveractFabricRealtimeVoiceAiSessionCommandInput',
    'ConveractFabricRealtimeVoiceAiDtmfInput',
    'ConveractFabricRealtimeVoiceAiProjectedEvent',
    'ConveractFabricRealtimeVoiceAiProjectionPolicy',
    'transcript_persisted'
  ]) assert.match(source, new RegExp(expected));
});

test('root build commands and production image include the Converact Fabric SDK', () => {
  const root = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  assert.equal(root.scripts?.['build:converact-sdk'], 'npm --prefix sdk/converact run build');
  assert.equal(root.scripts?.['pack:converact-sdk'], 'npm pack ./sdk/converact --dry-run');
  assert.equal(
    root.scripts?.['verify:converact:foundation'],
    'npm run test:converact:foundation && npm run build:converact-sdk && npm run pack:converact-sdk'
  );
  assert.match(dockerfile, /COPY sdk\/converact \.\/sdk\/converact/);
});

test('LED integration documentation describes the delivered standalone contract', () => {
  const guide = readFileSync('docs/converact-led-integration-guide.md', 'utf8');
  const openapi = readFileSync('docs/converact-openapi.md', 'utf8');

  for (const expected of [
    '@converact/sdk',
    'npm run start:converact',
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
  assert.match(openapi, /@converact\/sdk/);
  assert.match(openapi, /standalone|独立进程/i);
});
