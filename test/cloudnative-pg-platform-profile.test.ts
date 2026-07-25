import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parseAllDocuments } from 'yaml';

const ROOT = 'infra/platform/cloudnative-pg';

function source(path: string): string {
  assert.ok(existsSync(path), `${path} is missing`);
  return readFileSync(path, 'utf8');
}

function documents(path: string): Array<Record<string, any>> {
  return parseAllDocuments(source(path)).map((document) => {
    assert.equal(document.errors.length, 0, `${path}: ${document.errors.join(', ')}`);
    return document.toJSON() as Record<string, any>;
  });
}

test('CloudNativePG profile is external to the application Chart and pins supported releases', () => {
  const readme = source(`${ROOT}/README.md`);
  const kustomization = documents(`${ROOT}/kustomization.yaml`)[0];

  assert.match(readme, /CloudNativePG v1\.30\.0/);
  assert.match(readme, /Barman Cloud Plugin v0\.13\.0/);
  assert.match(readme, /not install|does not install/i);
  assert.match(readme, /PostgreSQL 18\.4/);
  assert.deepEqual(kustomization.resources, [
    'cluster.yaml',
    'pooler-rw.yaml',
    'pooler-pdb.yaml',
    'object-store.yaml',
    'scheduled-backup.yaml'
  ]);
  assert.doesNotMatch(source(`${ROOT}/kustomization.yaml`), /operator|crd/i);
});

test('CloudNativePG Cluster is three-node, synchronous and spread across zones and hosts', () => {
  const cluster = documents(`${ROOT}/cluster.yaml`)[0];
  const spec = cluster.spec;

  assert.equal(cluster.apiVersion, 'postgresql.cnpg.io/v1');
  assert.equal(cluster.kind, 'Cluster');
  assert.equal(cluster.metadata.name, 'opc-postgres');
  assert.equal(spec.instances, 3);
  assert.match(spec.imageName, /^ghcr\.io\/cloudnative-pg\/postgresql:18\.4-standard-trixie@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(spec.postgresql.synchronous, {
    method: 'any',
    number: 1,
    dataDurability: 'required'
  });
  assert.equal(spec.affinity.podAntiAffinityType, 'required');
  assert.equal(spec.affinity.topologyKey, 'kubernetes.io/hostname');
  assert.ok(spec.topologySpreadConstraints.some(
    (entry: Record<string, unknown>) => entry.topologyKey === 'topology.kubernetes.io/zone'
      && entry.whenUnsatisfiable === 'DoNotSchedule'
  ));
  assert.equal(spec.enablePDB, true);
  assert.equal(spec.monitoring.enablePodMonitor, true);
  assert.ok(spec.resources.requests.cpu);
  assert.ok(spec.resources.requests.memory);
  assert.ok(spec.storage.size);
  assert.ok(spec.walStorage.size);
});

test('PgBouncer profile has bounded transaction pooling and independent high availability', () => {
  const pooler = documents(`${ROOT}/pooler-rw.yaml`)[0];
  const pdb = documents(`${ROOT}/pooler-pdb.yaml`)[0];

  assert.equal(pooler.kind, 'Pooler');
  assert.equal(pooler.metadata.name, 'opc-postgres-rw-pooler');
  assert.equal(pooler.spec.cluster.name, 'opc-postgres');
  assert.equal(pooler.spec.type, 'rw');
  assert.equal(pooler.spec.instances, 3);
  assert.equal(pooler.spec.pgbouncer.poolMode, 'transaction');
  for (const key of ['max_client_conn', 'default_pool_size', 'reserve_pool_size', 'max_db_connections']) {
    assert.match(pooler.spec.pgbouncer.parameters[key], /^\d+$/, key);
  }
  assert.deepEqual(pooler.spec.template.spec.containers.map((container: Record<string, unknown>) => container.name), ['pgbouncer']);
  assert.ok(pooler.spec.template.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution.length > 0);
  assert.equal(pdb.kind, 'PodDisruptionBudget');
  assert.equal(pdb.spec.minAvailable, 2);
  assert.equal(pdb.spec.selector.matchLabels['cnpg.io/poolerName'], 'opc-postgres-rw-pooler');
});

test('CloudNativePG backups use the CNPG-I plugin and external Secret references only', () => {
  const cluster = source(`${ROOT}/cluster.yaml`);
  const objectStore = documents(`${ROOT}/object-store.yaml`)[0];
  const scheduled = documents(`${ROOT}/scheduled-backup.yaml`)[0];
  const recovery = documents(`${ROOT}/recovery-example.yaml`)[0];

  assert.doesNotMatch(cluster, /barmanObjectStore/);
  assert.match(cluster, /name: barman-cloud\.cloudnative-pg\.io/);
  assert.match(cluster, /isWALArchiver: true/);
  assert.equal(objectStore.apiVersion, 'barmancloud.cnpg.io/v1');
  assert.equal(objectStore.kind, 'ObjectStore');
  assert.equal(objectStore.metadata.name, 'opc-postgres-backup');
  assert.match(objectStore.spec.configuration.destinationPath, /^s3:\/\//);
  assert.equal(objectStore.spec.configuration.s3Credentials.accessKeyId.name, 'opc-postgres-backup-credentials');
  assert.deepEqual(objectStore.spec.configuration.s3Credentials.secretAccessKey, {
    name: 'opc-postgres-backup-credentials',
    key: 'ACCESS_SECRET_KEY'
  });
  assert.equal(scheduled.spec.method, 'plugin');
  assert.equal(scheduled.spec.pluginConfiguration.name, 'barman-cloud.cloudnative-pg.io');
  assert.equal(scheduled.spec.target, 'prefer-standby');
  assert.equal(recovery.metadata.name, 'opc-postgres-recovery');
  assert.equal(recovery.spec.bootstrap.recovery.source, 'source');
  assert.ok(recovery.spec.bootstrap.recovery.recoveryTarget.targetTime);
});
