import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const ROOT = 'infra/livekit/helm';
const CHART = `${ROOT}/livekit-server`;
const VALIDATOR = new URL('../scripts/livekit-official-helm-profile.ts', import.meta.url);

function source(path: string): string {
  assert.ok(existsSync(path), `${path} is missing`);
  return readFileSync(path, 'utf8');
}

function yaml(path: string): Record<string, any> {
  return parse(source(path)) as Record<string, any>;
}

async function validator() {
  assert.ok(existsSync(VALIDATOR), 'LiveKit official Helm profile validator is missing');
  return import(VALIDATOR.href);
}

test('vendored LiveKit chart is upstream-pinned and carries only targeted production hardening', () => {
  const lock = JSON.parse(source(`${ROOT}/upstream-lock.json`)) as Record<string, any>;
  const chart = yaml(`${CHART}/Chart.yaml`);
  const deployment = source(`${CHART}/templates/deployment.yaml`);
  const configMap = source(`${CHART}/templates/configmap.yaml`);
  const pdb = source(`${CHART}/templates/pdb.yaml`);

  assert.equal(lock.repository, 'https://github.com/livekit/livekit-helm.git');
  assert.equal(lock.commit, '8f0ad0809c2be8cbed375a6f8bef10625e5e8a2b');
  assert.equal(lock.chart_path, 'livekit-server');
  assert.equal(lock.chart_version, '1.11.0');
  assert.equal(lock.app_version, 'v1.11.0');
  assert.deepEqual(lock.upstream_sha256, {
    'Chart.yaml': 'd05320080ad0cbe108fcccc7cea5ea0a44b72bc4c933aff4ecbec8f4aaa7b3ce',
    'templates/configmap.yaml': 'b8f04a0c10f6681ff70415d9425d0d90f17a76c573676f338992c193e97a5ef4',
    'templates/deployment.yaml': '3c18f1705e46ce83e7fcbd9c8aad8a3edec17262115610fa8f5d51e9bf2db57e',
    'values.yaml': 'e449d2e01767c118d3fd0e7727136b5c54b87a2439f1adbbca4003a3b6e25f8b'
  });

  assert.equal(chart.version, '1.11.0-ivekit.1');
  assert.equal(chart.appVersion, 'v1.13.4-ivekit.1');
  assert.equal(chart.annotations['converact.io/upstream-commit'], lock.commit);
  assert.match(configMap, /toYaml \.Values\.livekit/);
  assert.match(deployment, /name: REDIS_PASSWORD[\s\S]*secretKeyRef/);
  assert.match(deployment, /name: redis-tls[\s\S]*mountPath: \/etc\/livekit-redis-tls/);
  assert.match(deployment, /topologySpreadConstraints/);
  assert.match(pdb, /kind: PodDisruptionBudget/);
  assert.match(pdb, /minAvailable/);
});

test('production performance profile is horizontally scalable and keeps credentials in Secrets', async () => {
  const values = yaml(`${ROOT}/values.production-performance.yaml`);
  values.image.tag = `v1.13.4-ivekit.1@sha256:${'a'.repeat(64)}`;
  const { validateLiveKitOfficialHelmProfile } = await validator();

  const result = validateLiveKitOfficialHelmProfile(values);

  assert.equal(result.image_reference, `ghcr.io/songgoldenwind-crypto/converact-livekit-server:v1.13.4-ivekit.1@sha256:${'a'.repeat(64)}`);
  assert.equal(result.minimum_replicas, 2);
  assert.equal(result.maximum_replicas, 32);
  assert.equal(result.rtc_udp_port_count, 10_001);
  assert.equal(result.cpu_limit_present, false);
  assert.equal(result.redis_password_secret, 'livekit-valkey-auth');
  assert.equal(result.redis_tls_secret, 'livekit-valkey-tls');
  assert.equal(values.storeKeysInSecret.existingSecret, 'livekit-api-keys');
  assert.equal(values.livekit.redis.password, undefined);
  assert.equal(values.livekit.keys, undefined);
});

test('production profile validator rejects unresolved images and ConfigMap credential leakage', async () => {
  const { validateLiveKitOfficialHelmProfile } = await validator();
  const unresolved = yaml(`${ROOT}/values.production-performance.yaml`);
  assert.throws(
    () => validateLiveKitOfficialHelmProfile(unresolved),
    /immutable LiveKit image digest/
  );

  const leaked = yaml(`${ROOT}/values.production-performance.yaml`);
  leaked.image.tag = `v1.13.4-ivekit.1@sha256:${'b'.repeat(64)}`;
  leaked.livekit.redis.password = 'must-not-enter-configmap';
  assert.throws(
    () => validateLiveKitOfficialHelmProfile(leaked),
    /Redis credentials must not be stored in livekit values/
  );
});

test('package exposes the official LiveKit Helm production profile gate', () => {
  const packageJson = JSON.parse(source('package.json')) as Record<string, any>;
  assert.equal(
    packageJson.scripts['livekit:helm-profile:validate'],
    'tsx scripts/livekit-official-helm-profile.ts'
  );
});
