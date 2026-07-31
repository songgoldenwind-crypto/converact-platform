import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  analyzeIveKitStandaloneSourceGraph,
  assertIveKitStandaloneBoundary,
  readIveKitStandaloneSourcePolicy
} from '../scripts/ivekit-standalone-source-graph.js';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('Voice Foundation source graph owns new modules and excludes OPC legacy runtime', () => {
  const policy = readIveKitStandaloneSourcePolicy(repoRoot);
  const graph = analyzeIveKitStandaloneSourceGraph({
    repoRoot,
    entrypoints: policy.entrypoints
  });

  assert.doesNotThrow(() => assertIveKitStandaloneBoundary(graph, policy.forbidden_prefixes));
  for (const required of [
    'src/agent-runtime/converact/voice/types.ts',
    'src/agent-runtime/converact/voice/ports.ts',
    'src/agent-runtime/converact/voice/index.ts',
    'src/agent-runtime/converact/ivr/types.ts',
    'src/agent-runtime/converact/ivr/graph-types.ts',
    'src/agent-runtime/converact/ivr/ports.ts',
    'src/agent-runtime/converact/ivr/index.ts'
  ]) assert.equal(graph.files.includes(required), true, required);

  for (const forbidden of [
    'src/agent-runtime/voice/voice-store.ts',
    'src/db.ts',
    'src/db-migrations/ivr-runtime-schema.ts'
  ]) assert.equal(graph.files.includes(forbidden), false, forbidden);
  assert.equal(graph.files.some((path) => path.startsWith('src/agent-runtime/ivr/')), false);
  assert.equal(graph.files.some((path) => path.startsWith('src/agent-runtime/call-center/')), false);
});

test('Voice Foundation public files do not import forbidden runtime modules', () => {
  const files = [
    'src/agent-runtime/converact/voice/types.ts',
    'src/agent-runtime/converact/voice/ports.ts',
    'src/agent-runtime/converact/voice/index.ts',
    'src/agent-runtime/converact/ivr/types.ts',
    'src/agent-runtime/converact/ivr/graph-types.ts',
    'src/agent-runtime/converact/ivr/ports.ts',
    'src/agent-runtime/converact/ivr/index.ts'
  ];
  const forbidden = [
    '/agent-runtime/voice/',
    '/agent-runtime/ivr/',
    '/agent-runtime/call-center/',
    '/db.js',
    '/db-compat.js',
    '/db-migrations/',
    'harness'
  ];
  for (const file of files) {
    assert.equal(existsSync(file), true, file);
    const source = readFileSync(file, 'utf8');
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file}: ${token}`);
    }
  }
});
