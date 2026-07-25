import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../services/ivekit-service/helm/ivekit/', import.meta.url);

function chartFile(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

test('standalone Helm exposes an opt-in digest-pinned compact Tinode workload', () => {
  const values = chartFile('values.yaml');
  const helpers = chartFile('templates/_helpers.tpl');
  const deployment = chartFile('templates/tinode-deployment.yaml');

  assert.match(values, /tinode:\n  enabled: false\n  mode: compact/);
  assert.match(values, /replicaCount: 1/);
  assert.match(values, /repository: ghcr\.io\/songgoldenwind-crypto\/opc-ivekit-tinode-server/);
  assert.match(values, /digest: ""/);
  assert.match(helpers, /define "ivekit\.tinodeImage"/);
  assert.match(helpers, /tinode\.image\.digest must be an immutable sha256 digest/);
  assert.match(helpers, /tinode\.replicaCount must be 1 in compact mode/);
  assert.match(deployment, /and \.Values\.tinode\.enabled \(eq \.Values\.tinode\.mode "compact"\)/);
  assert.match(deployment, /image: \{\{ include "ivekit\.tinodeImage" \. \| quote \}\}/);
});

test('bundled Tinode uses secret references, persistent botdata, probes, and safe runtime flags', () => {
  const config = chartFile('templates/tinode-config.yaml');
  const deployment = chartFile('templates/tinode-deployment.yaml');
  const pvc = chartFile('templates/tinode-pvc.yaml');
  const values = chartFile('values.yaml');

  assert.match(config, /STORE_USE_ADAPTER: postgres/);
  assert.match(config, /RESET_DB: "false"/);
  assert.match(config, /WEBRTC_ENABLED: "false"/);
  assert.doesNotMatch(config, /POSTGRES_DSN|AUTH_TOKEN_KEY|UID_ENCRYPTION_KEY/);

  for (const envName of ['POSTGRES_DSN', 'API_KEY_SALT', 'AUTH_TOKEN_KEY', 'UID_ENCRYPTION_KEY']) {
    assert.match(deployment, new RegExp(`name: ${envName}[\\s\\S]*?secretKeyRef:`));
  }
  assert.match(config, /SERVER_STATUS_PATH: \/health/);
  assert.match(deployment, /startupProbe:[\s\S]*?httpGet:[\s\S]*?path: \/health/);
  assert.match(deployment, /readinessProbe:[\s\S]*?httpGet:[\s\S]*?path: \/health/);
  assert.match(deployment, /livenessProbe:[\s\S]*?httpGet:[\s\S]*?path: \/health/);
  assert.match(deployment, /mountPath: \/botdata/);
  assert.match(deployment, /mountPath: \/tmp/);
  assert.match(pvc, /accessModes:[\s\S]*?tinode\.persistence\.accessMode/);
  assert.match(values, /accessMode: ReadWriteOnce/);
});

test('bundled Tinode has service disruption and optional network isolation contracts', () => {
  const service = chartFile('templates/tinode-service.yaml');
  const pdb = chartFile('templates/tinode-pdb.yaml');
  const networkPolicy = chartFile('templates/tinode-network-policy.yaml');
  const apiDeployment = chartFile('templates/deployment.yaml');

  assert.match(service, /app\.kubernetes\.io\/component: tinode/);
  assert.match(service, /name: http[\s\S]*?port: \{\{ \.Values\.tinode\.service\.port \}\}/);
  assert.match(pdb, /kind: PodDisruptionBudget/);
  assert.match(pdb, /minAvailable: \{\{ \.Values\.tinode\.podDisruptionBudget\.minAvailable \}\}/);
  assert.match(networkPolicy, /kind: NetworkPolicy/);
  assert.match(networkPolicy, /app\.kubernetes\.io\/component: api/);
  assert.match(apiDeployment, /TINODE_BASE_URL/);
  assert.match(apiDeployment, /TINODE_WS_URL/);
  assert.match(apiDeployment, /include "ivekit\.tinodeFullname"/);
});

test('bundled Tinode bootstraps its service account before API startup and enables both sync workers', () => {
  const apiDeployment = chartFile('templates/deployment.yaml');
  const values = chartFile('values.yaml');
  const sourcePolicy = JSON.parse(chartFile('../../source-policy.json')) as {
    entrypoints: string[];
  };
  const servicePackage = JSON.parse(chartFile('../../package.json')) as {
    scripts: Record<string, string>;
  };

  assert.match(apiDeployment, /name: tinode-service-account-bootstrap/);
  assert.match(apiDeployment, /command: \["node", "dist\/ivekit-tinode-bootstrap\.js"\]/);
  for (const envName of [
    'TINODE_API_KEY',
    'TINODE_BASIC_USER',
    'TINODE_BASIC_PASSWORD',
    'TINODE_USER_PASSWORD_SECRET'
  ]) {
    assert.match(apiDeployment, new RegExp(`name: ${envName}[\\s\\S]*?secretKeyRef:`));
  }
  assert.match(apiDeployment, /name: OPC_TINODE_DELIVERY_WORKER_ENABLED[\s\S]*?tinode\.config\.deliveryWorkerEnabled/);
  assert.match(apiDeployment, /name: OPC_TINODE_INBOUND_WORKER_ENABLED[\s\S]*?tinode\.config\.inboundWorkerEnabled/);
  assert.match(values, /deliveryWorkerEnabled: "1"/);
  assert.match(values, /inboundWorkerEnabled: "1"/);
  assert.match(apiDeployment, /name: TINODE_PUBLIC_WS_URL/);
  assert.match(values, /publicWsUrl: ""/);
  assert.ok(sourcePolicy.entrypoints.includes('src/ivekit-tinode-bootstrap.ts'));
  assert.equal(servicePackage.scripts['bootstrap:tinode'], 'node dist/ivekit-tinode-bootstrap.js');
});

test('Tinode Helm values keep secrets external and document compact and cluster modes', () => {
  const values = chartFile('values.yaml');
  const readme = chartFile('README.md');

  assert.match(values, /postgresDsnKey: tinode-postgres-dsn/);
  assert.match(values, /apiKeySaltKey: tinode-api-key-salt/);
  assert.match(values, /apiKeyKey: tinode-api-key/);
  assert.match(values, /authTokenKeyKey: tinode-auth-token-key/);
  assert.match(values, /uidEncryptionKeyKey: tinode-uid-encryption-key/);
  assert.match(values, /basicUserKey: tinode-basic-user/);
  assert.match(values, /basicPasswordKey: tinode-basic-password/);
  assert.match(values, /userPasswordSecretKey: tinode-user-password-secret/);
  assert.match(values, /existingClaim: ""/);
  assert.match(readme, /bundled Tinode/i);
  assert.match(readme, /three-node cluster/i);
  assert.match(readme, /compact mode supports exactly one replica/i);
  assert.match(readme, /shared S3 media is mandatory/i);
  assert.match(readme, /CREATEDB/);
  assert.match(readme, /service account bootstrap/i);
  assert.doesNotMatch(values, /postgres(?:ql)?:\/\//i);
});
