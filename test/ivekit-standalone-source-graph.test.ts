import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  analyzeIveKitStandaloneSourceGraph,
  assertIveKitStandaloneBoundary
} from '../scripts/ivekit-standalone-source-graph.js';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('iveKit standalone graph resolves every local module and excludes OPC product domains', () => {
  const policy = JSON.parse(readFileSync('services/ivekit-service/source-policy.json', 'utf8')) as {
    entrypoints: string[];
  };
  const graph = analyzeIveKitStandaloneSourceGraph({
    repoRoot,
    entrypoints: policy.entrypoints
  });

  assert.equal(graph.unresolved.length, 0, graph.unresolved.join('\n'));
  assert.equal(graph.files.includes('src/ivekit-server.ts'), true);
  for (const path of [
    'src/agent-runtime/collaboration/intelligence-provider-registry.ts',
    'src/agent-runtime/collaboration/intelligence-policy-store.ts',
    'src/agent-runtime/collaboration/intelligence-source-service.ts',
    'src/agent-runtime/collaboration/translation-worker.ts',
    'src/agent-runtime/ivekit/voice/types.ts',
    'src/agent-runtime/ivekit/voice/ports.ts',
    'src/agent-runtime/ivekit/voice/index.ts',
    'src/agent-runtime/ivekit/ivr/types.ts',
    'src/agent-runtime/ivekit/ivr/graph-types.ts',
    'src/agent-runtime/ivekit/ivr/ports.ts',
    'src/agent-runtime/ivekit/ivr/index.ts',
    'src/agent-runtime/ivekit/contact-center/types.ts',
    'src/agent-runtime/ivekit/contact-center/index.ts',
    'src/agent-runtime/ivekit/contact-center/configuration-service.ts',
    'src/agent-runtime/ivekit/contact-center/http.ts',
    'src/agent-runtime/ivekit/contact-center/ivr-queue-port.ts',
    'src/agent-runtime/ivekit/contact-center/queue-service.ts',
    'src/agent-runtime/ivekit/contact-center/monitor-service.ts',
    'src/agent-runtime/ivekit/contact-center/postgres/monitor-source.ts',
    'src/agent-runtime/ivekit/contact-center/overflow-service.ts',
    'src/agent-runtime/ivekit/contact-center/overflow-runtime.ts',
    'src/agent-runtime/ivekit/contact-center/voice-overflow-adapter.ts',
    'src/agent-runtime/ivekit/contact-center/supervisor-control.ts',
    'src/agent-runtime/ivekit/contact-center/rustpbx-supervisor-control.ts',
    'src/agent-runtime/ivekit/contact-center/supervisor-service.ts',
    'src/agent-runtime/ivekit/contact-center/postgres/store.ts',
    'src/agent-runtime/ivekit/contact-center/postgres/configuration-store.ts',
    'src/agent-runtime/ivekit/contact-center/postgres/unit-of-work.ts'
  ]) assert.equal(graph.files.includes(path), true, path);
  assert.equal(graph.files.includes('src/server.ts'), false);
  assert.equal(graph.files.some((path) => path.startsWith('src/agent-runtime/call-center/')), false);
  assert.equal(graph.files.some((path) => path.startsWith('src/agent-runtime/ivr/')), false);
  assert.equal(graph.files.some((path) => path.startsWith('shared/')), false);
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
    migrations: string[];
  };

  assert.deepEqual(policy.entrypoints, [
    'src/ivekit-server.ts',
    'src/ivekit-worker.ts',
    'src/ivekit-realtime-audio-tap-worker.ts',
    'src/ivekit-backup.ts',
    'src/ivekit-restore.ts',
    'src/ivekit-migrate.ts',
    'src/ivekit-init-runtime-role.ts',
    'src/ivekit-tinode-bootstrap.ts',
    'src/ivekit-intelligence-preflight.ts',
    'src/ivekit-render-kamailio-config.ts',
    'src/ivekit-kamailio-compose-config.ts',
    'src/ivekit-kamailio-route-agent.ts',
    'src/ivekit-kamailio-webphone-acceptance.ts',
    'src/ivekit-render-rustpbx-config.ts',
    'src/ivekit-rustpbx-route-snapshot.ts',
    'src/ivekit-rustpbx-recording-spool.ts',
    'src/ivekit-component-node-admission.ts',
    'src/ivekit-placement-snapshot-projector.ts',
    'src/ivekit-rustpbx-recovery.ts',
    'src/ivekit-dialog-shadow-agent.ts',
    'src/ivekit-voice-preflight.ts',
    'src/agent-runtime/ivekit/voice/index.ts',
    'src/agent-runtime/ivekit/ivr/index.ts',
    'src/agent-runtime/ivekit/contact-center/index.ts'
  ]);
  assert.deepEqual(policy.migrations.slice(-3), [
    '104_ivekit_cell_admission_ledger_runtime.sql',
    '105_tinode_closed_session_inbound.sql',
    '106_tinode_open_session_mutation_queue.sql'
  ]);
  for (const prefix of [
    'src/agent-runtime/call-center/',
    'src/agent-runtime/ivr/',
    'frontend/',
    'src/server.ts'
  ]) assert.equal(policy.forbidden_prefixes.includes(prefix), true, prefix);
  assert.equal(policy.assets.includes('services/ivekit-service/package.json'), true);
  assert.equal(policy.assets.includes('services/ivekit-service/Dockerfile'), true);
  assert.equal(policy.assets.includes('services/ivekit-service/docker-compose.yml'), true);
  assert.equal(policy.assets.includes('services/ivekit-service/docker-compose.voice.yml'), true);
  assert.equal(policy.assets.includes('services/ivekit-service/init-rustpbx-database.sh'), true);
  assert.equal(policy.assets.includes('services/ivekit-service/env.example'), true);
});

test('standalone verifier proves the packaged dialog-shadow sidecar entrypoint', () => {
  const verifier = readFileSync('scripts/verify-ivekit-standalone-context.ts', 'utf8');
  const servicePackage = JSON.parse(
    readFileSync('services/ivekit-service/package.json', 'utf8')
  ) as { scripts: Record<string, string> };

  assert.equal(
    servicePackage.scripts['start:dialog-shadow'],
    'node dist/ivekit-dialog-shadow-agent.js'
  );
  assert.match(verifier, /'ivekit-dialog-shadow-agent\.js'/);
});

test('standalone PostgreSQL compatibility worker requires no writable application filesystem', () => {
  const source = readFileSync('src/db-pg-sync.ts', 'utf8');

  assert.doesNotMatch(source, /writeFileSync\s*\(/);
  assert.match(source, /new Worker\(WORKER_CODE,\s*\{\s*eval:\s*true\s*\}\)/);
  assert.match(source, /responseBuffer/);
  assert.doesNotMatch(source, /const SHARED_BUF\b/);
});
