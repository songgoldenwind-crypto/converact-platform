import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  analyzeConveractFabricStandaloneSourceGraph,
  assertConveractFabricStandaloneBoundary
} from '../scripts/converact-standalone-source-graph.js';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('Converact Fabric standalone graph resolves every local module and excludes Converact product domains', () => {
  const policy = JSON.parse(readFileSync('services/converact-service/source-policy.json', 'utf8')) as {
    entrypoints: string[];
  };
  const graph = analyzeConveractFabricStandaloneSourceGraph({
    repoRoot,
    entrypoints: policy.entrypoints
  });

  assert.equal(graph.unresolved.length, 0, graph.unresolved.join('\n'));
  assert.equal(graph.files.includes('src/converact-server.ts'), true);
  for (const path of [
    'src/agent-runtime/collaboration/intelligence-provider-registry.ts',
    'src/agent-runtime/collaboration/intelligence-policy-store.ts',
    'src/agent-runtime/collaboration/intelligence-source-service.ts',
    'src/agent-runtime/collaboration/translation-worker.ts',
    'src/agent-runtime/converact/voice/types.ts',
    'src/agent-runtime/converact/voice/ports.ts',
    'src/agent-runtime/converact/voice/index.ts',
    'src/agent-runtime/converact/voice/sip-foundation/index.ts',
    'src/agent-runtime/converact/voice/sip-foundation/types.ts',
    'src/agent-runtime/converact/voice/sip-foundation/capabilities.ts',
    'src/agent-runtime/converact/voice/sip-foundation/closed-schema.ts',
    'src/agent-runtime/converact/voice/sip-foundation/route-binding.ts',
    'src/agent-runtime/converact/voice/sip-foundation/rsipstack-adapter.ts',
    'src/agent-runtime/converact/voice/sip-foundation/session-registry.ts',
    'src/agent-runtime/converact/voice/sip-foundation/effect-oracle.ts',
    'src/agent-runtime/converact/voice/sip-foundation/postgres-effect-store.ts',
    'src/agent-runtime/converact/voice/sip-foundation/recovery.ts',
    'src/agent-runtime/converact/ivr/types.ts',
    'src/agent-runtime/converact/ivr/graph-types.ts',
    'src/agent-runtime/converact/ivr/ports.ts',
    'src/agent-runtime/converact/ivr/index.ts',
    'src/agent-runtime/converact/contact-center/types.ts',
    'src/agent-runtime/converact/contact-center/index.ts',
    'src/agent-runtime/converact/contact-center/configuration-service.ts',
    'src/agent-runtime/converact/contact-center/http.ts',
    'src/agent-runtime/converact/contact-center/ivr-queue-port.ts',
    'src/agent-runtime/converact/contact-center/queue-service.ts',
    'src/agent-runtime/converact/contact-center/monitor-service.ts',
    'src/agent-runtime/converact/contact-center/postgres/monitor-source.ts',
    'src/agent-runtime/converact/contact-center/overflow-service.ts',
    'src/agent-runtime/converact/contact-center/overflow-runtime.ts',
    'src/agent-runtime/converact/contact-center/voice-overflow-adapter.ts',
    'src/agent-runtime/converact/contact-center/supervisor-control.ts',
    'src/agent-runtime/converact/contact-center/rustpbx-supervisor-control.ts',
    'src/agent-runtime/converact/contact-center/supervisor-service.ts',
    'src/agent-runtime/converact/contact-center/postgres/store.ts',
    'src/agent-runtime/converact/contact-center/postgres/configuration-store.ts',
    'src/agent-runtime/converact/contact-center/postgres/unit-of-work.ts'
  ]) assert.equal(graph.files.includes(path), true, path);
  assert.equal(graph.files.includes('src/server.ts'), false);
  assert.equal(graph.files.some((path) => path.startsWith('src/agent-runtime/call-center/')), false);
  assert.equal(graph.files.some((path) => path.startsWith('src/agent-runtime/ivr/')), false);
  assert.equal(graph.files.some((path) => path.startsWith('shared/')), false);
  assert.equal(graph.files.some((path) => path.startsWith('frontend/')), false);
  assert.doesNotThrow(() => assertConveractFabricStandaloneBoundary(graph));
});

test('Converact Fabric standalone graph reports runtime packages without node builtins', () => {
  const graph = analyzeConveractFabricStandaloneSourceGraph({
    repoRoot,
    entrypoints: ['src/converact-server.ts']
  });

  for (const required of ['@aws-sdk/client-s3', 'ioredis', 'livekit-server-sdk', 'pg', 'prom-client', 'ws']) {
    assert.equal(graph.packages.includes(required), true, required);
  }
  for (const builtin of ['node:crypto', 'node:fs', 'node:http']) {
    assert.equal(graph.packages.includes(builtin), false, builtin);
  }
});

test('standalone source policy is explicit and keeps build assets out of Converact internals', () => {
  const policy = JSON.parse(readFileSync('services/converact-service/source-policy.json', 'utf8')) as {
    entrypoints: string[];
    forbidden_prefixes: string[];
    assets: string[];
    migrations: string[];
  };

  assert.deepEqual(policy.entrypoints, [
    'src/converact-server.ts',
    'src/converact-worker.ts',
    'src/converact-realtime-audio-tap-worker.ts',
    'src/converact-backup.ts',
    'src/converact-restore.ts',
    'src/converact-migrate.ts',
    'src/converact-init-runtime-role.ts',
    'src/converact-init-event-runtime-role.ts',
    'src/converact-tinode-bootstrap.ts',
    'src/converact-intelligence-preflight.ts',
    'src/converact-render-kamailio-config.ts',
    'src/converact-kamailio-compose-config.ts',
    'src/converact-kamailio-route-agent.ts',
    'src/converact-kamailio-webphone-acceptance.ts',
    'src/converact-render-rustpbx-config.ts',
    'src/converact-rustpbx-route-snapshot.ts',
    'src/converact-rustpbx-recording-spool.ts',
    'src/converact-component-node-admission.ts',
    'src/converact-placement-snapshot-projector.ts',
    'src/converact-rustpbx-recovery.ts',
    'src/converact-dialog-shadow-agent.ts',
    'src/converact-voice-preflight.ts',
    'src/agent-runtime/converact/voice/index.ts',
    'src/agent-runtime/converact/ivr/index.ts',
    'src/agent-runtime/converact/contact-center/index.ts'
  ]);
  assert.deepEqual(policy.migrations.slice(-10), [
    '113_converact_sip_effect_transport_completed.sql',
    '114_converact_sip_effect_transport_completed_validate.sql',
    '115_converact_sip_effect_stale_nonterminal_recovery.sql',
    '116_converact_sip_capability_recovery_fence.sql',
    '117_converact_authority_migration_routes.sql',
    '118_converact_platform_event_runtime_fencing.sql',
    '119_converact_platform_event_runtime_indexes.sql',
    '120_converact_platform_event_runtime_roles.sql',
    '121_converact_audit_runtime_fencing.sql',
    '122_converact_audit_runtime_indexes.sql'
  ]);
  for (const prefix of [
    'src/agent-runtime/call-center/',
    'src/agent-runtime/ivr/',
    'frontend/',
    'src/server.ts'
  ]) assert.equal(policy.forbidden_prefixes.includes(prefix), true, prefix);
  assert.equal(policy.assets.includes('services/converact-service/package.json'), true);
  assert.equal(policy.assets.includes('services/converact-service/Dockerfile'), true);
  assert.equal(policy.assets.includes('services/converact-service/docker-compose.yml'), true);
  assert.equal(policy.assets.includes('services/converact-service/docker-compose.voice.yml'), true);
  assert.equal(policy.assets.includes('services/converact-service/init-rustpbx-database.sh'), true);
  assert.equal(policy.assets.includes('services/converact-service/env.example'), true);
});

test('standalone verifier proves the packaged dialog-shadow sidecar entrypoint', () => {
  const verifier = readFileSync('scripts/verify-converact-standalone-context.ts', 'utf8');
  const servicePackage = JSON.parse(
    readFileSync('services/converact-service/package.json', 'utf8')
  ) as { scripts: Record<string, string> };

  assert.equal(
    servicePackage.scripts['start:dialog-shadow'],
    'node dist/converact-dialog-shadow-agent.js'
  );
  assert.match(verifier, /'converact-dialog-shadow-agent\.js'/);
});

test('standalone PostgreSQL compatibility worker requires no writable application filesystem', () => {
  const source = readFileSync('src/db-pg-sync.ts', 'utf8');

  assert.doesNotMatch(source, /writeFileSync\s*\(/);
  assert.match(source, /new Worker\(WORKER_CODE,\s*\{\s*eval:\s*true\s*\}\)/);
  assert.match(source, /responseBuffer/);
  assert.doesNotMatch(source, /const SHARED_BUF\b/);
});
