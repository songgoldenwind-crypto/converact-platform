import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../services/ivekit-service/helm/ivekit/', import.meta.url);

function chartFile(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

test('Tinode Helm exposes compact and three-node cluster modes with fail-closed validation', () => {
  const values = chartFile('values.yaml');
  const helpers = chartFile('templates/_helpers.tpl');

  assert.match(values, /tinode:\n  enabled: false\n  mode: compact/);
  assert.match(values, /replicaCount: 1/);
  assert.match(values, /cluster:[\s\S]*?replicaCount: 3/);
  assert.match(values, /clusterPort: 12000/);
  assert.match(values, /allowedRepositories:[\s\S]*?opc-ivekit-tinode-server/);
  assert.match(helpers, /tinode\.mode must be compact or cluster/);
  assert.match(helpers, /tinode\.replicaCount must be 1 in compact mode/);
  assert.match(helpers, /tinode\.cluster\.replicaCount must be exactly 3/);
  assert.match(helpers, /tinode cluster mode requires the maintained iveKit image repository/);
  assert.match(helpers, /tinode cluster mode requires the s3 media handler/);
});

test('Tinode cluster is a stable StatefulSet with separate ring and client services', () => {
  const statefulSet = chartFile('templates/tinode-statefulset.yaml');
  const service = chartFile('templates/tinode-service.yaml');
  const values = chartFile('values.yaml');

  assert.match(statefulSet, /kind: StatefulSet/);
  assert.match(statefulSet, /serviceName: \{\{ include "ivekit\.tinodeHeadlessFullname" \. \}\}/);
  assert.match(statefulSet, /replicas: \{\{ \.Values\.tinode\.cluster\.replicaCount \}\}/);
  assert.match(statefulSet, /podManagementPolicy: Parallel/);
  assert.match(statefulSet, /fieldPath: metadata\.name/);
  assert.match(statefulSet, /name: CLUSTER_SELF/);
  assert.match(statefulSet, /name: TINODE_CLUSTER_NODE_0_NAME/);
  assert.match(statefulSet, /name: TINODE_CLUSTER_NODE_2_ADDR/);
  assert.match(statefulSet, /containerPort: \{\{ \.Values\.tinode\.cluster\.clusterPort \}\}/);
  assert.match(statefulSet, /requiredDuringSchedulingIgnoredDuringExecution/);
  assert.match(statefulSet, /tinode\.cluster\.scheduling\.zoneTopologyKey/);
  assert.match(statefulSet, /tinode\.cluster\.scheduling\.hostnameTopologyKey/);
  assert.match(values, /zoneTopologyKey: topology\.kubernetes\.io\/zone/);
  assert.match(values, /hostnameTopologyKey: kubernetes\.io\/hostname/);
  assert.match(service, /clusterIP: None/);
  assert.match(service, /publishNotReadyAddresses: true/);
  assert.match(service, /name: cluster/);
  assert.match(service, /name: http/);
});

test('Tinode cluster separates database initialization and uses shared S3 media', () => {
  const statefulSet = chartFile('templates/tinode-statefulset.yaml');
  const bootstrap = chartFile('templates/tinode-database-bootstrap.yaml');
  const values = chartFile('values.yaml');

  assert.match(bootstrap, /kind: Job/);
  assert.match(bootstrap, /helm\.sh\/hook: pre-install,pre-upgrade/);
  assert.match(bootstrap, /name: TINODE_INIT_ONLY[\s\S]*?value: "1"/);
  assert.match(bootstrap, /name: POSTGRES_DSN[\s\S]*?secretKeyRef/);
  assert.match(statefulSet, /name: NO_DB_INIT[\s\S]*?value: "true"/);
  assert.match(statefulSet, /name: MEDIA_HANDLER[\s\S]*?value: "s3"/);
  assert.match(statefulSet, /name: AWS_ACCESS_KEY_ID[\s\S]*?secretKeyRef/);
  assert.match(statefulSet, /name: AWS_SECRET_ACCESS_KEY[\s\S]*?secretKeyRef/);
  assert.match(statefulSet, /name: AWS_S3_ENDPOINT/);
  assert.match(statefulSet, /name: AWS_S3_BUCKET/);
  assert.match(statefulSet, /name: AWS_FORCE_PATH_STYLE/);
  assert.match(values, /accessKeyIdKey: tinode-s3-access-key-id/);
  assert.match(values, /secretAccessKeyKey: tinode-s3-secret-access-key/);
  assert.match(values, /forcePathStyle: false/);
});

test('Tinode cluster runtime is writable without weakening its container security context', () => {
  const statefulSet = chartFile('templates/tinode-statefulset.yaml');
  const values = chartFile('values.yaml');

  assert.match(statefulSet, /name: TINODE_RUNTIME_DIR[\s\S]*?\/var\/lib\/tinode-runtime/);
  assert.match(statefulSet, /name: EXT_STATIC_DIR[\s\S]*?\/var\/lib\/tinode-runtime\/static/);
  assert.match(statefulSet, /mountPath: \/var\/lib\/tinode-runtime/);
  assert.match(statefulSet, /mountPath: \/var\/log/);
  assert.match(statefulSet, /toYaml \.Values\.tinode\.securityContext/);
  assert.match(statefulSet, /toYaml \.Values\.tinode\.podSecurityContext/);
  assert.match(statefulSet, /tinode\.cluster\.runtimeVolumeSizeLimit/);
  assert.match(values, /readOnlyRootFilesystem: true/);
  assert.match(values, /runAsNonRoot: true/);
  assert.match(values, /runtimeVolumeSizeLimit: 2Gi/);
});

test('Tinode cluster disruption and network policy preserve two nodes and isolate ring traffic', () => {
  const pdb = chartFile('templates/tinode-pdb.yaml');
  const networkPolicy = chartFile('templates/tinode-network-policy.yaml');

  assert.match(pdb, /tinode\.mode "cluster"/);
  assert.match(pdb, /minAvailable: 2/);
  assert.match(networkPolicy, /port: \{\{ \.Values\.tinode\.cluster\.clusterPort \}\}/);
  assert.match(networkPolicy, /app\.kubernetes\.io\/component: tinode/);
  assert.match(networkPolicy, /podSelector:/);
});
