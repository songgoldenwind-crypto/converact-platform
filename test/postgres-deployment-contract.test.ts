import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

test('application Chart exposes only external and bundled-dev PostgreSQL modes', () => {
  const values = source('infra/k8s/values.yaml');
  const helpers = source('infra/k8s/templates/_helpers.tpl');

  assert.match(values, /postgres:[\s\S]{0,160}?\n  mode: external/);
  assert.match(values, /external:\n    existingSecret: opc-database-runtime\n    secretKey: database-url/);
  assert.doesNotMatch(values, /postgres:\n  enabled:/);
  assert.match(helpers, /define "opc\.postgresMode"/);
  assert.match(helpers, /postgres\.mode must be external or bundled-dev/);
  assert.match(helpers, /postgres\.external\.existingSecret is required in external mode/);
  assert.match(helpers, /postgres\.external\.secretKey is required in external mode/);
});

test('external database mode references an existing Secret and never copies its URL', () => {
  const helpers = source('infra/k8s/templates/_helpers.tpl');
  const deployment = source('infra/k8s/templates/opc-deployment.yaml');
  const secrets = source('infra/k8s/templates/secrets.yaml');
  const postgres = source('infra/k8s/templates/postgres-statefulset.yaml');

  assert.match(helpers, /define "opc\.databaseUrlSecretName"/);
  assert.match(helpers, /define "opc\.databaseUrlSecretKey"/);
  assert.match(deployment, /name: \{\{ include "opc\.databaseUrlSecretName" \. \}\}/);
  assert.match(deployment, /key: \{\{ include "opc\.databaseUrlSecretKey" \. \}\}/);
  assert.match(secrets, /if eq \(include "opc\.postgresMode" \.\) "bundled-dev"/);
  assert.match(postgres, /if eq \(include "opc\.postgresMode" \.\) "bundled-dev"/);
  assert.doesNotMatch(postgres, /Values\.postgres\.enabled/);
});

test('bundled PostgreSQL is visibly development-only and preserves a rollback path', () => {
  const postgres = source('infra/k8s/templates/postgres-statefulset.yaml');

  assert.match(postgres, /opc\.ivekit\.io\/deployment-profile: bundled-dev/);
  assert.match(postgres, /opc\.ivekit\.io\/production-eligible: "false"/);
  assert.match(postgres, /Single-instance PostgreSQL is development-only/);
  assert.match(postgres, /kind: StatefulSet/);
  assert.match(postgres, /replicas: 1/);
});

test('Helm server acceptance covers positive and fail-closed database renders', () => {
  const script = source('scripts/verify-postgres-deployment-contract.sh');

  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /helm lint/);
  assert.match(script, /helm template/);
  assert.match(script, /external database Secret reference/);
  assert.match(script, /bundled-dev PostgreSQL/);
  assert.match(script, /missing-external-secret/);
  assert.match(script, /missing-external-secret-key/);
  assert.match(script, /invalid-postgres-mode/);
});
