import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
  assert.ok(existsSync(path), `${path} is missing`);
  return readFileSync(path, 'utf8');
}

test('Valkey acceptance topology is isolated, persistent and immutable', () => {
  const compose = source('services/ivekit-service/acceptance/valkey-sentinel/docker-compose.yml');

  assert.match(compose, /VALKEY_ACCEPTANCE_IMAGE:\?immutable Valkey image is required/);
  for (const service of ['valkey-1', 'valkey-2', 'valkey-3', 'sentinel-1', 'sentinel-2', 'sentinel-3']) {
    assert.match(compose, new RegExp(`^  ${service}:$`, 'm'), service);
  }
  for (const volume of ['valkey_1_data', 'valkey_2_data', 'valkey_3_data']) {
    assert.match(compose, new RegExp(`^  ${volume}:$`, 'm'), volume);
  }
  assert.match(compose, /internal: true/);
  assert.doesNotMatch(compose, /ports:/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.equal((compose.match(/user: "999:1000"/g) || []).length, 2);
});

test('Valkey acceptance runner bounds failover, protects LED and cleans all project state', () => {
  const script = source('services/ivekit-service/acceptance/valkey-sentinel/accept.sh');

  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /64\.225\.122\.227/);
  assert.match(script, /ivekit-valkey-sentinel-/);
  assert.match(script, /refusing shared or unsafe Compose project name/);
  assert.match(script, /trap on_exit EXIT/);
  assert.match(script, /docker compose[\s\S]*down --volumes --remove-orphans/);
  assert.match(script, /timeout 180 docker pull/);
  assert.match(script, /timeout 120 docker compose/);
  assert.match(script, /pause "\$old_primary"/);
  assert.match(script, /docker compose[\s\S]*unpause/);
  assert.match(script, /wait_for_new_primary/);
  assert.match(script, /wait_for_sentinel_topology/);
  assert.match(script, /SENTINEL get-master-addr-by-name/);
  assert.match(script, /SENTINEL replicas/);
  assert.match(script, /SENTINEL sentinels/);
  assert.match(script, /SENTINEL ckquorum/);
  assert.match(script, /ROLE/);
  assert.match(script, /INFO replication/);
  assert.match(script, /sha256sum/);
  assert.match(script, /acceptance_source_sha256/);
  assert.match(script, /pre_failover_canary_survived/);
  assert.match(script, /post_failover_write_read/);
  assert.match(script, /pubsub_before_failover/);
  assert.match(script, /pubsub_after_failover/);
  for (const name of [
    'led-platform-admin-1',
    'led-platform-api-1',
    'led-platform-edge-1',
    'led-platform-minio-1',
    'led-platform-postgres-1',
    'led-platform-system-tasks-1',
    'led-platform-web-1'
  ]) {
    assert.match(script, new RegExp(name));
  }
  assert.doesNotMatch(script, /set -x/);
});

test('Valkey acceptance runner captures redacted diagnostics before cleanup', () => {
  const script = source('services/ivekit-service/acceptance/valkey-sentinel/accept.sh');

  assert.match(script, /failure_diagnostics\(\)/);
  assert.match(script, /docker compose[\s\S]*ps -a/);
  assert.match(script, /docker compose[\s\S]*logs --no-color --tail 100/);
  assert.match(script, /\[REDACTED\]/);
  assert.match(script, /trap on_exit EXIT/);
  assert.match(script, /failure_diagnostics[\s\S]*cleanup/);
});

test('Valkey acceptance probe uses the production Sentinel resolver and verifies PubSub', () => {
  const probe = source('services/ivekit-service/acceptance/valkey-sentinel/probe.ts');

  assert.match(probe, /resolveRedisConnectionOptions/);
  assert.match(probe, /buildIoRedisConstructorArgs/);
  assert.match(probe, /topology !== 'sentinel'/);
  assert.match(probe, /subscriber\.subscribe/);
  assert.match(probe, /publisher\.publish/);
  assert.match(probe, /SET[\s\S]*EX/);
  assert.match(probe, /pre_failover_canary_survived/);
  assert.doesNotMatch(probe, /REDIS_PASSWORD[\s\S]*console\.log/);
});
