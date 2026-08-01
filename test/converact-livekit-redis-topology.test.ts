import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
  assert.ok(existsSync(path), `${path} is missing`);
  return readFileSync(path, 'utf8');
}

test('LiveKit Helm values expose one direct or Sentinel Redis contract', () => {
  const values = source('infra/k8s/values.yaml');

  assert.match(values, /livekit:[\s\S]*?redis:\n\s+mode: direct/);
  assert.match(values, /sentinelMasterName: ""/);
  assert.match(values, /sentinelAddresses: \[\]/);
  assert.match(values, /sentinelUsername: ""/);
  assert.match(values, /sentinelPassword: ""/);
  assert.match(values, /tls:\n\s+enabled: false/);
  assert.match(values, /secretName: ""/);
  assert.match(values, /serverName: ""/);
  assert.match(values, /caKey: ca\.crt/);
  assert.match(values, /clientCertKey: ""/);
  assert.match(values, /clientKeyKey: ""/);
});

test('LiveKit Redis helper rejects mixed topology and unsafe TLS', () => {
  const helpers = source('infra/k8s/templates/_helpers.tpl');

  assert.match(helpers, /define "converact\.livekitRedisConfig"/);
  assert.match(helpers, /livekit\.redis\.mode must be direct or sentinel/);
  assert.match(helpers, /livekit\.redis\.address must be empty in sentinel mode/);
  assert.match(helpers, /livekit\.redis\.sentinelAddresses must contain exactly three addresses/);
  assert.match(helpers, /livekit\.redis\.sentinelAddresses must contain three unique addresses/);
  assert.match(helpers, /livekit\.redis\.sentinelMasterName is required in sentinel mode/);
  assert.match(helpers, /livekit\.redis\.sentinel fields must be empty in direct mode/);
  assert.match(helpers, /livekit\.redis\.tls\.secretName is required when TLS is enabled/);
  assert.match(helpers, /livekit\.redis\.tls\.serverName is required when TLS is enabled/);
  assert.match(helpers, /livekit\.redis\.tls client certificate and key must be configured together/);
  assert.match(helpers, /sentinel_master_name:/);
  assert.match(helpers, /sentinel_addresses:/);
  assert.match(helpers, /sentinel_username:/);
  assert.match(helpers, /sentinel_password:/);
  assert.match(helpers, /ca_cert_file: \/etc\/livekit-redis-tls\/ca\.crt/);
  assert.match(helpers, /insecure: false/);
});

test('all LiveKit services render the shared Redis config and TLS secret mount', () => {
  for (const path of [
    'infra/k8s/templates/livekit-deployment.yaml',
    'infra/k8s/templates/livekit-egress-deployment.yaml',
    'infra/k8s/templates/livekit-ingress-deployment.yaml',
    'infra/k8s/templates/livekit-sip-deployment.yaml'
  ]) {
    const template = source(path);
    assert.match(template, /include "converact\.livekitRedisConfig"/, path);
    assert.match(template, /include "converact\.livekitRedisTLSVolumeMount"/, path);
    assert.match(template, /include "converact\.livekitRedisTLSVolume"/, path);
  }
});

test('Converact application renders the same Redis topology, ACL and TLS contract', () => {
  const deployment = source('infra/k8s/templates/converact-deployment.yaml');
  const secrets = source('infra/k8s/templates/secrets.yaml');

  assert.match(deployment, /include "converact\.redisClientEnv"/);
  assert.match(deployment, /include "converact\.livekitRedisTLSVolumeMount"/);
  assert.match(deployment, /include "converact\.livekitRedisTLSVolume"/);
  for (const key of [
    'redis-username',
    'redis-password',
    'redis-sentinel-username',
    'redis-sentinel-password'
  ]) {
    assert.match(secrets, new RegExp(`^  ${key}:`, 'm'), key);
  }
  const helpers = source('infra/k8s/templates/_helpers.tpl');
  for (const variable of [
    'REDIS_TOPOLOGY',
    'REDIS_URL',
    'REDIS_USERNAME',
    'REDIS_PASSWORD',
    'REDIS_SENTINEL_MASTER_NAME',
    'REDIS_SENTINEL_ADDRESSES',
    'REDIS_SENTINEL_USERNAME',
    'REDIS_SENTINEL_PASSWORD',
    'REDIS_TLS_MODE',
    'REDIS_CONNECT_TIMEOUT_MS',
    'REDIS_RECONNECT_WAIT_MS',
    'REDIS_MAX_RECONNECT_ATTEMPTS'
  ]) {
    assert.match(helpers, new RegExp(`name: ${variable}`), variable);
  }
});

test('LiveKit SIP mounts a complete provider config at its image default path', () => {
  const deployment = source('infra/k8s/templates/livekit-sip-deployment.yaml');

  assert.match(deployment, /kind: Secret/);
  assert.match(deployment, /sip\.yaml: \|/);
  assert.match(deployment, /api_key:/);
  assert.match(deployment, /api_secret:/);
  assert.match(deployment, /ws_url:/);
  assert.match(deployment, /redis:/);
  assert.match(deployment, /sip_port:/);
  assert.match(deployment, /mountPath: \/sip\/config\.yaml/);
  assert.match(deployment, /subPath: sip\.yaml/);
  assert.doesNotMatch(deployment, /name: SIP_PORT/);
});

test('LiveKit Redis Helm acceptance covers positive and fail-closed renders', () => {
  const script = source('scripts/verify-livekit-redis-topology.sh');

  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /helm lint/);
  assert.match(script, /helm template/);
  assert.match(script, /direct Redis blocks/);
  assert.match(script, /Sentinel Redis blocks/);
  assert.match(script, /TLS volume mounts/);
  assert.match(script, /invalid-mode/);
  assert.match(script, /mixed-direct-and-sentinel/);
  assert.match(script, /two-sentinel-voters/);
  assert.match(script, /duplicate-sentinel-voters/);
  assert.match(script, /missing-sentinel-master/);
  assert.match(script, /incomplete-data-acl/);
  assert.match(script, /incomplete-sentinel-acl/);
  assert.match(script, /missing-tls-secret/);
  assert.match(script, /missing-tls-server-name/);
  assert.match(script, /incomplete-mtls-pair/);
});
