import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  analyzeIveKitStandaloneSourceGraph,
  assertIveKitStandaloneBoundary
} from '../scripts/ivekit-standalone-source-graph.js';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('iveKit standalone graph resolves every local module and excludes OPC product domains', () => {
  const graph = analyzeIveKitStandaloneSourceGraph({
    repoRoot,
    entrypoints: ['src/ivekit-server.ts']
  });

  assert.equal(graph.unresolved.length, 0, graph.unresolved.join('\n'));
  assert.equal(graph.files.includes('src/ivekit-server.ts'), true);
  assert.equal(graph.files.includes('src/server.ts'), false);
  assert.equal(graph.files.some((path) => path.startsWith('src/agent-runtime/call-center/')), false);
  assert.equal(graph.files.some((path) => path.startsWith('src/agent-runtime/ivr/')), false);
  assert.equal(graph.files.some((path) => path.startsWith('frontend/')), false);
  assert.doesNotThrow(() => assertIveKitStandaloneBoundary(graph));
});

test('iveKit standalone graph reports runtime packages without node builtins', () => {
  const graph = analyzeIveKitStandaloneSourceGraph({
    repoRoot,
    entrypoints: ['src/ivekit-server.ts']
  });

  for (const required of ['@aws-sdk/client-s3', 'ioredis', 'livekit-server-sdk', 'pg', 'prom-client', 'ws']) {
    assert.equal(graph.packages.includes(required), true, required);
  }
  for (const builtin of ['node:crypto', 'node:fs', 'node:http']) {
    assert.equal(graph.packages.includes(builtin), false, builtin);
  }
});

test('standalone source policy is explicit and keeps build assets out of OPC internals', () => {
  const policy = JSON.parse(readFileSync('services/ivekit-service/source-policy.json', 'utf8')) as {
    entrypoints: string[];
    forbidden_prefixes: string[];
    assets: string[];
  };

  assert.deepEqual(policy.entrypoints, ['src/ivekit-server.ts', 'src/ivekit-migrate.ts']);
  for (const prefix of [
    'src/agent-runtime/call-center/',
    'src/agent-runtime/ivr/',
    'frontend/',
    'src/server.ts'
  ]) assert.equal(policy.forbidden_prefixes.includes(prefix), true, prefix);
  assert.equal(policy.assets.includes('services/ivekit-service/package.json'), true);
  assert.equal(policy.assets.includes('services/ivekit-service/Dockerfile'), true);
});
