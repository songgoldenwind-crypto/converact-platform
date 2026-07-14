import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createIveKitReleaseOperations,
  validateIveKitReleaseOperations
} from '../scripts/ivekit-release-operations.js';

const sourceCommit = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;

test('release operations bind immutable images, migrations, Compose, and Helm', () => {
  const operations = createIveKitReleaseOperations({
    sourceCommit,
    generatedAt: '2026-07-14T00:00:00.000Z',
    imageReference: 'registry.example.com/ivekit/service:2026.07.14',
    imageDigest: digest,
    imageMetadataSha256: 'c'.repeat(64),
    migrationManifestSha256: 'd'.repeat(64)
  });

  assert.equal(operations.contract.execution_status, 'ready');
  assert.equal(
    operations.contract.image.immutable_reference,
    `registry.example.com/ivekit/service:2026.07.14@${digest}`
  );
  assert.equal(operations.contract.compose.service, 'ivekit');
  assert.equal(operations.contract.compose.image_variable, 'IVEKIT_SERVICE_IMAGE');
  assert.equal(operations.contract.helm.chart, 'deploy/kubernetes/ivekit');
  assert.equal(operations.contract.database.rollback, 'restore_verified_pre_upgrade_backup_only');
  assert.match(operations.runbook, /sha256sum --check SHA256SUMS/);
  assert.match(operations.runbook, /docker compose[\s\S]*run --rm migrate/);
  assert.match(operations.runbook, /helm upgrade --install/);
  assert.match(operations.runbook, /PREVIOUS_IVEKIT_IMAGE/);
  assert.match(operations.runbook, /restore[\s-]*only/i);
  assert.doesNotMatch(operations.runbook, /down\s+-v|DROP\s+(?:DATABASE|TABLE)|:latest/i);
  assert.doesNotThrow(() => validateIveKitReleaseOperations(operations));
});

test('release operations remain blocked until an image digest is recorded', () => {
  const operations = createIveKitReleaseOperations({
    sourceCommit,
    generatedAt: '2026-07-14T00:00:00.000Z',
    imageReference: `ivekit-service:${sourceCommit.slice(0, 12)}`,
    imageDigest: '',
    imageMetadataSha256: 'c'.repeat(64),
    migrationManifestSha256: 'd'.repeat(64)
  });

  assert.equal(operations.contract.execution_status, 'blocked_build_required');
  assert.equal(operations.contract.image.immutable_reference, '');
  assert.match(operations.runbook, /blocked_build_required/);
  assert.doesNotThrow(() => validateIveKitReleaseOperations(operations));
});

test('release operation validation rejects mutable or destructive instructions', () => {
  const operations = createIveKitReleaseOperations({
    sourceCommit,
    generatedAt: '2026-07-14T00:00:00.000Z',
    imageReference: 'registry.example.com/ivekit/service:2026.07.14',
    imageDigest: digest,
    imageMetadataSha256: 'c'.repeat(64),
    migrationManifestSha256: 'd'.repeat(64)
  });

  assert.throws(
    () => validateIveKitReleaseOperations({ ...operations, runbook: `${operations.runbook}\ndocker compose down -v\n` }),
    /destructive/i
  );
  assert.throws(
    () => validateIveKitReleaseOperations({
      ...operations,
      contract: {
        ...operations.contract,
        image: { ...operations.contract.image, immutable_reference: 'ivekit-service:latest' }
      }
    }),
    /immutable image/i
  );
});

test('standalone Helm chart gates migration before an immutable application rollout', () => {
  const chart = readFileSync('services/ivekit-service/helm/ivekit/Chart.yaml', 'utf8');
  const values = readFileSync('services/ivekit-service/helm/ivekit/values.yaml', 'utf8');
  const helpers = readFileSync('services/ivekit-service/helm/ivekit/templates/_helpers.tpl', 'utf8');
  const migration = readFileSync('services/ivekit-service/helm/ivekit/templates/migrate-job.yaml', 'utf8');
  const deployment = readFileSync('services/ivekit-service/helm/ivekit/templates/deployment.yaml', 'utf8');
  const rustpbx = readFileSync('services/ivekit-service/helm/ivekit/templates/rustpbx-deployment.yaml', 'utf8');

  assert.match(chart, /name: ivekit-service/);
  assert.match(values, /repository: ""[\s\S]*digest: ""/);
  assert.match(helpers, /sha256:\[a-f0-9\]\{64\}/);
  assert.match(helpers, /printf "%s@%s"/);
  assert.match(migration, /helm\.sh\/hook: pre-install,pre-upgrade/);
  assert.match(migration, /dist\/ivekit-init-runtime-role\.js/);
  assert.match(migration, /dist\/ivekit-migrate\.js/);
  assert.match(deployment, /dist\/ivekit-server\.js/);
  assert.match(deployment, /readinessProbe:/);
  assert.match(deployment, /OPC_SCHEMA_MANAGED_BY_MIGRATIONS/);
  assert.match(deployment, /runtimeEnvironmentSecret/);
  assert.doesNotMatch(deployment, /envFrom:[\s\S]{0,160}include "ivekit\.secretName"/);
  assert.match(rustpbx, /if \.Values\.voice\.enabled/);
  assert.match(rustpbx, /dist\/ivekit-render-rustpbx-config\.js/);
  assert.doesNotMatch(`${values}\n${deployment}`, /opc\/platform|:latest/);
});
