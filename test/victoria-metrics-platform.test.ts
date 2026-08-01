import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = 'infra/platform/observability/victoria-metrics';

test('VictoriaMetrics is a pinned, single-node, bounded metrics store', () => {
  for (const file of [
    'kustomization.yaml', 'pvc.yaml', 'statefulset.yaml', 'service.yaml',
    'pdb.yaml', 'network-policy.yaml', 'backup-cronjob.yaml',
    'prometheus-remote-write.example.yaml', 'prometheus-rules.example.yaml',
    'restore-job.example.yaml', 'README.md'
  ]) {
    assert.equal(existsSync(`${root}/${file}`), true, `missing ${file}`);
  }

  const statefulSet = readFileSync(`${root}/statefulset.yaml`, 'utf8');
  const pvc = readFileSync(`${root}/pvc.yaml`, 'utf8');
  const service = readFileSync(`${root}/service.yaml`, 'utf8');
  const pdb = readFileSync(`${root}/pdb.yaml`, 'utf8');
  const network = readFileSync(`${root}/network-policy.yaml`, 'utf8');
  const storageNetwork = network.split('\n---\n', 1)[0];

  assert.match(statefulSet, /replicas: 1/);
  assert.match(statefulSet, /victoria-metrics@sha256:407013e902f9/);
  assert.match(statefulSet, /-retentionPeriod=30d/);
  assert.match(statefulSet, /-storageDataPath=\/storage/);
  assert.match(statefulSet, /-snapshotsMaxAge=48h/);
  assert.match(statefulSet, /-maxLabelsPerTimeseries=50/);
  assert.match(statefulSet, /readOnlyRootFilesystem: true/);
  assert.match(statefulSet, /runAsNonRoot: true/);
  assert.doesNotMatch(statefulSet, /hostNetwork: true|hostPath:/);
  assert.match(pvc, /ReadWriteOnce/);
  assert.match(pvc, /storage: 200Gi/);
  assert.match(service, /type: ClusterIP/);
  assert.match(service, /port: 8428/);
  assert.match(pdb, /minAvailable: 1/);
  assert.match(network, /converact\.io\/victoria-metrics-role/);
  assert.doesNotMatch(storageNetwork, /ingress:\s*\[\]/);
});

test('VictoriaMetrics backup and restore use pinned community tools and external secrets', () => {
  const backup = readFileSync(`${root}/backup-cronjob.yaml`, 'utf8');
  const restore = readFileSync(`${root}/restore-job.example.yaml`, 'utf8');

  assert.match(backup, /concurrencyPolicy: Forbid/);
  assert.match(backup, /vmbackup@sha256:1d01f330d98d/);
  assert.match(backup, /-snapshot\.createURL=http:\/\/converact-victoria-metrics:8428\/snapshot\/create/);
  assert.match(backup, /-envflag\.enable/);
  assert.match(backup, /name: converact-victoria-metrics-backup/);
  assert.match(backup, /readOnly: true/);
  assert.doesNotMatch(backup, /AWS_SECRET_ACCESS_KEY:\s*[^\n]+/);
  assert.match(restore, /suspend: true/);
  assert.match(restore, /vmrestore@sha256:9a35e0b371f7/);
  assert.match(restore, /backoffLimit: 0/);
});

test('Prometheus stays the scrape and alert authority', () => {
  const remoteWrite = readFileSync(`${root}/prometheus-remote-write.example.yaml`, 'utf8');
  const rules = readFileSync(`${root}/prometheus-rules.example.yaml`, 'utf8');
  const kustomization = readFileSync(`${root}/kustomization.yaml`, 'utf8');

  assert.match(remoteWrite, /api\/v1\/write/);
  assert.match(remoteWrite, /queue_config:/);
  assert.match(remoteWrite, /capacity:/);
  assert.match(remoteWrite, /max_shards:/);
  assert.match(remoteWrite, /max_backoff:/);
  assert.match(rules, /kind: PrometheusRule/);
  assert.doesNotMatch(kustomization, /prometheus-remote-write\.example|prometheus-rules\.example|restore-job\.example/);
  assert.doesNotMatch(kustomization, /vmagent|VMServiceScrape|VMSingle/);
});
