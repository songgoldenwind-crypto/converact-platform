import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createConveractFabricReleaseOperations,
  validateConveractFabricReleaseOperations
} from '../scripts/converact-release-operations.js';

const sourceCommit = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;

test('release operations bind immutable images, migrations, Compose, and Helm', () => {
  const operations = createConveractFabricReleaseOperations({
    sourceCommit,
    generatedAt: '2026-07-14T00:00:00.000Z',
    imageReference: 'registry.example.com/converact/service:2026.07.14',
    imageDigest: digest,
    imageMetadataSha256: 'c'.repeat(64),
    migrationManifestSha256: 'd'.repeat(64),
    stage2EvidenceSha256: 'e'.repeat(64),
    stage2ReleaseFingerprint: 'f'.repeat(64)
  });

  assert.equal(operations.contract.execution_status, 'ready');
  assert.equal(
    operations.contract.image.immutable_reference,
    `registry.example.com/converact/service:2026.07.14@${digest}`
  );
  assert.equal(operations.contract.compose.service, 'converact');
  assert.equal(
    operations.contract.compose.image_variable,
    'CONVERACT_FABRIC_SERVICE_IMAGE'
  );
  assert.equal(operations.contract.helm.chart, 'deploy/kubernetes/converact');
  assert.equal(operations.contract.database.rollback, 'restore_verified_pre_upgrade_backup_only');
  assert.deepEqual(operations.contract.migrations.required, [
    '061_ivekit_file_security.sql',
    '062_tinode_file_delivery_operations.sql',
    '063_livekit_media_quality.sql'
  ]);
  assert.equal(operations.contract.configuration.stage2_evidence_sha256, 'e'.repeat(64));
  assert.equal(operations.contract.configuration.release_fingerprint_sha256, 'f'.repeat(64));
  assert.match(operations.runbook, /sha256sum --check SHA256SUMS/);
  assert.match(operations.runbook, /docker compose[\s\S]*run --rm migrate/);
  assert.match(operations.runbook, /helm upgrade --install/);
  assert.match(operations.runbook, /CONVERACT_FABRIC_PREVIOUS_IMAGE/);
  assert.match(operations.runbook, /restore[\s-]*only/i);
  assert.doesNotMatch(operations.runbook, /down\s+-v|DROP\s+(?:DATABASE|TABLE)|:latest/i);
  assert.doesNotThrow(() => validateConveractFabricReleaseOperations(operations));
});

test('release operations remain blocked until an image digest is recorded', () => {
  const operations = createConveractFabricReleaseOperations({
    sourceCommit,
    generatedAt: '2026-07-14T00:00:00.000Z',
    imageReference: `converact-service:${sourceCommit.slice(0, 12)}`,
    imageDigest: '',
    imageMetadataSha256: 'c'.repeat(64),
    migrationManifestSha256: 'd'.repeat(64),
    stage2EvidenceSha256: 'e'.repeat(64),
    stage2ReleaseFingerprint: 'f'.repeat(64)
  });

  assert.equal(operations.contract.execution_status, 'blocked_build_required');
  assert.equal(operations.contract.image.immutable_reference, '');
  assert.match(operations.runbook, /blocked_build_required/);
  assert.doesNotThrow(() => validateConveractFabricReleaseOperations(operations));
});

test('release operation validation rejects mutable or destructive instructions', () => {
  const operations = createConveractFabricReleaseOperations({
    sourceCommit,
    generatedAt: '2026-07-14T00:00:00.000Z',
    imageReference: 'registry.example.com/converact/service:2026.07.14',
    imageDigest: digest,
    imageMetadataSha256: 'c'.repeat(64),
    migrationManifestSha256: 'd'.repeat(64),
    stage2EvidenceSha256: 'e'.repeat(64),
    stage2ReleaseFingerprint: 'f'.repeat(64)
  });

  assert.throws(
    () => validateConveractFabricReleaseOperations({ ...operations, runbook: `${operations.runbook}\ndocker compose down -v\n` }),
    /destructive/i
  );
  assert.throws(
    () => validateConveractFabricReleaseOperations({
      ...operations,
      contract: {
        ...operations.contract,
        image: { ...operations.contract.image, immutable_reference: 'converact-service:latest' }
      }
    }),
    /immutable image/i
  );
});

test('standalone Helm chart gates migration before an immutable application rollout', () => {
  const chart = readFileSync('services/converact-service/helm/converact/Chart.yaml', 'utf8');
  const values = readFileSync('services/converact-service/helm/converact/values.yaml', 'utf8');
  const helpers = readFileSync('services/converact-service/helm/converact/templates/_helpers.tpl', 'utf8');
  const migration = readFileSync('services/converact-service/helm/converact/templates/migrate-job.yaml', 'utf8');
  const deployment = readFileSync('services/converact-service/helm/converact/templates/deployment.yaml', 'utf8');
  const clamav = readFileSync('services/converact-service/helm/converact/templates/clamav.yaml', 'utf8');
  const rustpbx = readFileSync('services/converact-service/helm/converact/templates/rustpbx-deployment.yaml', 'utf8');

  assert.match(chart, /name: converact-service/);
  assert.match(values, /repository: ""[\s\S]*digest: ""/);
  assert.match(helpers, /sha256:\[a-f0-9\]\{64\}/);
  assert.match(helpers, /printf "%s@%s"/);
  assert.match(migration, /helm\.sh\/hook: pre-install,pre-upgrade/);
  assert.match(migration, /dist\/converact-init-runtime-role\.js/);
  assert.match(migration, /dist\/converact-migrate\.js/);
  assert.match(deployment, /dist\/converact-server\.js/);
  assert.match(deployment, /readinessProbe:/);
  assert.match(deployment, /CONVERACT_SCHEMA_MANAGED_BY_MIGRATIONS/);
  assert.match(deployment, /runtimeEnvironmentSecret/);
  assert.match(deployment, /CONVERACT_FILE_SECURITY_SCAN_WORKER_ENABLED/);
  assert.match(deployment, /name: CONVERACT_OBJECT_STORAGE_REQUIRED[\s\S]{0,80}value: "1"/);
  assert.match(deployment, /CONVERACT_FILE_SECURITY_CLAMD_HOST/);
  assert.match(deployment, /CONVERACT_FILE_DERIVATIVE_WORKER_ENABLED/);
  assert.match(deployment, /CONVERACT_FILE_CLEANUP_WORKER_ENABLED/);
  assert.match(
    deployment,
    /with \.Values\.secrets\.runtimeEnvironmentSecret[\s\S]{0,160}envFrom:/
  );
  assert.match(rustpbx, /if \.Values\.voice\.enabled/);
  assert.match(rustpbx, /dist\/converact-render-rustpbx-config\.js/);
  assert.match(rustpbx, /dist\/converact-rustpbx-route-snapshot\.js/);
  assert.match(values, /^fileSecurity:$/m);
  assert.match(values, /scannerMode: clamd/);
  assert.match(values, /^clamav:$/m);
  assert.match(values, /repository: clamav\/clamav:1\.5\.2_base/);
  assert.match(
    values,
    /digest: sha256:3aa0c6d6a966dc062899e070fb13f87485acf0cbb710fccaae9a848cd5f5b09a/
  );
  assert.match(helpers, /define "converact\.clamavImage"/);
  assert.match(values, /replicaCount: 2/);
  assert.match(values, /signatureMaxAgeMinutes: 4320/);
  assert.match(clamav, /kind: StatefulSet/);
  assert.match(clamav, /kind: Service/);
  assert.match(clamav, /clusterIP: None/);
  assert.match(clamav, /podManagementPolicy: Parallel/);
  assert.match(clamav, /volumeClaimTemplates:/);
  assert.match(clamav, /accessModes: \["ReadWriteOnce"\]/);
  assert.match(clamav, /kind: PodDisruptionBudget/);
  assert.match(clamav, /minAvailable:/);
  assert.match(clamav, /podAntiAffinity:/);
  assert.match(clamav, /topologySpreadConstraints:/);
  assert.match(clamav, /kind: NetworkPolicy/);
  assert.match(clamav, /readinessProbe:/);
  assert.match(clamav, /find \/var\/lib\/clamav[\s\S]*\.cld/);
  assert.match(clamav, /livenessProbe:/);
  assert.match(clamav, /resources:/);
  assert.match(clamav, /\/var\/lib\/clamav/);
  assert.doesNotMatch(clamav, /type: (?:NodePort|LoadBalancer)|hostPort:/);
  assert.doesNotMatch(deployment, /wait-for-clamav/);
  const readme = readFileSync('services/converact-service/helm/converact/README.md', 'utf8');
  assert.match(readme, /ClamAV outage[^.]*must not gate API readiness or active communication/i);
  assert.doesNotMatch(`${values}\n${deployment}`, /:latest/);
});
