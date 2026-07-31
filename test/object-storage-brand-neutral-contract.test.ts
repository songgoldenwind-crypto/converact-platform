import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { resolveS3ConnectionConfig } from '../src/storage/s3-connection-config.js';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

test('generic S3 configuration wins over legacy MinIO aliases without mixing credential families', () => {
  const config = resolveS3ConnectionConfig({
    S3_BUCKET: 'generic-bucket',
    MINIO_BUCKET: 'legacy-bucket',
    S3_ENDPOINT: 'https://s3.example.invalid',
    MINIO_ENDPOINT: 'http://legacy.invalid:9000',
    S3_REGION: 'eu-west-1',
    S3_ACCESS_KEY_ID: 'generic-access',
    S3_SECRET_ACCESS_KEY: 'generic-secret',
    MINIO_ACCESS_KEY: 'legacy-access',
    MINIO_SECRET_KEY: 'legacy-secret',
    S3_FORCE_PATH_STYLE: 'false'
  });

  assert.deepEqual(config, {
    bucket: 'generic-bucket',
    region: 'eu-west-1',
    endpoint: 'https://s3.example.invalid',
    forcePathStyle: false,
    credentials: {
      accessKeyId: 'generic-access',
      secretAccessKey: 'generic-secret'
    },
    source: 's3'
  });
});

test('S3 endpoint style is explicit and incomplete or invalid generic input fails closed', () => {
  assert.equal(resolveS3ConnectionConfig({
    S3_BUCKET: 'aws-bucket',
    S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
    S3_FORCE_PATH_STYLE: 'false'
  })?.forcePathStyle, false);
  assert.equal(resolveS3ConnectionConfig({
    S3_BUCKET: 'seaweed-bucket',
    S3_ENDPOINT: 'http://seaweed-s3:8333',
    S3_FORCE_PATH_STYLE: 'true'
  })?.forcePathStyle, true);
  assert.equal(resolveS3ConnectionConfig({}), null);
  assert.throws(
    () => resolveS3ConnectionConfig({ S3_BUCKET: 'bucket', S3_ACCESS_KEY_ID: 'partial' }),
    /S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together/
  );
  assert.throws(
    () => resolveS3ConnectionConfig({ S3_BUCKET: 'bucket', S3_FORCE_PATH_STYLE: 'sometimes' }),
    /S3_FORCE_PATH_STYLE must be true or false/
  );
});

test('application Chart defaults to external brand-neutral S3 and keeps MinIO disabled for rollback', () => {
  const values = source('infra/k8s/values.yaml');
  const helpers = source('infra/k8s/templates/_helpers.tpl');

  assert.match(values, /objectStorage:\n    mode: external/);
  assert.match(values, /authMode: secret/);
  assert.match(values, /existingSecret: opc-object-storage-runtime/);
  assert.match(values, /accessKeyIdKey: access-key-id/);
  assert.match(values, /secretAccessKeyKey: secret-access-key/);
  assert.match(values, /forcePathStyle: false/);
  assert.match(values, /minio:\n    enabled: false/);
  assert.match(values, /existingSecret: opc-minio-legacy/);
  assert.doesNotMatch(values, /^  minioAccessKey:/m);
  assert.doesNotMatch(values, /^  minioSecretKey:/m);
  assert.match(helpers, /define "opc\.objectStorageMode"/);
  assert.match(helpers, /media\.objectStorage\.mode must be external or legacy-minio/);
  assert.match(helpers, /media\.objectStorage\.authMode must be secret or workload-identity/);
  assert.match(helpers, /media\.objectStorage\.existingSecret is required with secret authentication/);
  assert.match(helpers, /bundled MinIO requires media\.objectStorage\.mode=legacy-minio/);
});

test('OPC and Egress consume one S3 contract without putting credentials in Helm values or config', () => {
  const deployment = source('infra/k8s/templates/opc-deployment.yaml');
  const egress = source('infra/k8s/templates/livekit-egress-deployment.yaml');
  const helpers = source('infra/k8s/templates/_helpers.tpl');
  const secrets = source('infra/k8s/templates/secrets.yaml');
  const minio = source('infra/k8s/templates/minio-deployment.yaml');

  for (const variable of [
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_REGION',
    'S3_FORCE_PATH_STYLE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY'
  ]) {
    assert.match(helpers, new RegExp(`name: ${variable}`), variable);
  }
  assert.match(deployment, /include "opc\.objectStorageEnv"/);
  assert.match(egress, /include "opc\.objectStorageEnv"/);
  assert.match(egress, /access_key: ""/);
  assert.match(egress, /secret: ""/);
  assert.match(egress, /force_path_style: \{\{ include "opc\.objectStorageForcePathStyle"/);
  assert.doesNotMatch(egress, /Values\.media\.minioAccessKey/);
  assert.doesNotMatch(egress, /Values\.media\.minioSecretKey/);
  assert.doesNotMatch(secrets, /minio-access-key|minio-secret-key/);
  assert.match(minio, /name: \{\{ include "opc\.objectStorageSecretName" \. \}\}/);
});

test('object storage Helm server acceptance covers external, workload identity, legacy and failures', () => {
  const script = source('scripts/verify-object-storage-contract.sh');

  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /helm lint/);
  assert.match(script, /external S3 Secret env/);
  assert.match(script, /workload identity omits static credentials/);
  assert.match(script, /legacy MinIO rollback/);
  assert.match(script, /missing-object-storage-bucket/);
  assert.match(script, /missing-object-storage-secret/);
  assert.match(script, /invalid-object-storage-mode/);
  assert.match(script, /minio-with-external-mode/);
});

test('recording and backup runtime consumers share the brand-neutral S3 resolver', () => {
  for (const path of [
    'src/agent-runtime/media-recording-object.ts',
    'src/agent-runtime/converact/operations/backup-runner.ts',
    'scripts/render-media-configs.ts'
  ]) {
    const consumer = source(path);
    assert.match(consumer, /resolveS3ConnectionConfig/, path);
    assert.doesNotMatch(
      consumer,
      /AWS_ACCESS_KEY_ID\s*\|\|[^\n]*(?:S3_ACCESS_KEY_ID|MINIO_ACCESS_KEY)/,
      path
    );
    assert.doesNotMatch(
      consumer,
      /AWS_SECRET_ACCESS_KEY\s*\|\|[^\n]*(?:S3_SECRET_ACCESS_KEY|MINIO_SECRET_KEY)/,
      path
    );
  }
});
