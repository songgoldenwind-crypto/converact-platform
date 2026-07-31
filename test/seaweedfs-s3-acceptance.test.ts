import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const compose = read('services/converact-service/acceptance/seaweedfs-s3/docker-compose.yml');
const probe = read('services/converact-service/acceptance/seaweedfs-s3/probe.ts');
const acceptance = read('services/converact-service/acceptance/seaweedfs-s3/accept.sh');

test('SeaweedFS acceptance topology is isolated and immutable', () => {
  for (const service of ['master', 'volume', 'filer', 's3']) {
    assert.match(compose, new RegExp(`^  ${service}:`, 'm'));
  }
  assert.match(compose, /SEAWEEDFS_IMAGE immutable digest reference is required/);
  assert.match(compose, /127\.0\.0\.1:\$\{SEAWEEDFS_S3_HOST_PORT/);
  assert.match(compose, /name: \$\{COMPOSE_PROJECT_NAME:-ivekit-seaweedfs\}-network/);
  assert.doesNotMatch(compose, /internal: true/);
  assert.doesNotMatch(compose, /\n\s+- ["']?8333:8333/);
  assert.doesNotMatch(compose, /0\.0\.0\.0:\$\{SEAWEEDFS_S3_HOST_PORT/);
});

test('SeaweedFS probe uses the production provider and covers the S3 matrix honestly', () => {
  assert.match(probe, /createObjectStorage/);
  assert.match(probe, /new ListBucketsCommand/);
  assert.match(probe, /new NodeHttpHandler/);
  assert.match(probe, /requestTimeout: 10_000/);
  for (const capability of [
    'small_object',
    'large_object',
    'multipart_complete',
    'multipart_abort',
    'range_get',
    'versioning'
  ]) {
    assert.match(probe, new RegExp(capability));
  }
  assert.match(probe, /object_lock_worm: 'not_supported_upstream'/);
  assert.match(probe, /not_run_real_livekit_egress/);
  assert.match(probe, /not_run_target_kubernetes/);
});

test('SeaweedFS server acceptance fails closed and removes temporary resources', () => {
  assert.match(acceptance, /^#!\/bin\/sh\nset -eu/);
  assert.match(acceptance, /trap cleanup EXIT HUP INT TERM/);
  assert.match(acceptance, /SEAWEEDFS_IMAGE must be pinned by sha256 digest/);
  assert.match(acceptance, /od -An -N16 -tx1 \/dev\/urandom/);
  assert.match(acceptance, /compose stop s3/);
  assert.match(acceptance, /SeaweedFS phase: running production S3 provider matrix/);
  assert.match(acceptance, /sed "s\/\$SEAWEEDFS_ACCESS_KEY\/\[REDACTED\]\//);
  assert.match(acceptance, /expect-outage/);
  assert.match(acceptance, /compose down --volumes --remove-orphans/);
  assert.doesNotMatch(acceptance, /printf[^\n]*(?:ACCESS_KEY|SECRET_KEY)/);
});

function read(path: string): string {
  return readFileSync(path, 'utf8');
}
