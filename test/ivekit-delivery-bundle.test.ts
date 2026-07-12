import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import {
  DELIVERY_SOURCE_FILES,
  buildIveKitDeliveryBundle,
  listDeliveryFiles,
  validateIveKitDeliveryBundle
} from '../scripts/ivekit-delivery-bundle.js';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('iveKit delivery bundle contains only curated handoff artifacts with verified hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-delivery-'));
  const outputDir = join(root, 'bundle');
  const sdkTarball = join(root, 'opc-ivekit-sdk-0.1.0.tgz');
  const clientDist = join(root, 'client-dist');
  writeFileSync(sdkTarball, 'test sdk archive');
  mkdirSync(join(clientDist, 'assets'), { recursive: true });
  writeFileSync(join(clientDist, 'index.html'), '<!doctype html><title>iveKit</title>');
  writeFileSync(join(clientDist, 'assets', 'index.js'), 'console.log("iveKit")');

  try {
    const result = buildIveKitDeliveryBundle({
      repoRoot,
      outputDir,
      sdkTarball,
      clientDist,
      sourceCommit: 'a'.repeat(40)
    });
    const files = listDeliveryFiles(outputDir);
    const contextManifest = JSON.parse(readFileSync(
      join(outputDir, 'service', 'build-context', 'context-manifest.json'),
      'utf8'
    )) as { files: Array<{ path: string }>; source_commit: string };
    const contextFiles = [
      ...contextManifest.files.map((entry) => `service/build-context/${entry.path}`),
      'service/build-context/context-manifest.json',
      'service/build-context/SHA256SUMS',
      'service/image-metadata.json',
      'service/migration-manifest.json',
      'service/sbom.spdx.json'
    ];
    const expected = [
      ...DELIVERY_SOURCE_FILES.map((entry) => entry.destination),
      ...contextFiles,
      'edge/dist/rustdesk-edge-agent.js',
      'edge/dist/rustdesk-edge-command.js',
      'edge/dist/rustdesk-edge-pending-store.js',
      '.ivekit-delivery-root',
      'README.md',
      'SHA256SUMS',
      'acceptance/status.json',
      'client/assets/index.js',
      'client/index.html',
      'manifest.json',
      'sdk/opc-ivekit-sdk-0.1.0.tgz'
    ].sort();

    assert.deepEqual(files, expected);
    assert.equal(result.manifest.status, 'ready_for_handoff');
    assert.deepEqual(result.manifest.real_environment_acceptance, {
      livekit: 'not_run',
      tinode: 'not_run',
      rustdesk: 'not_run'
    });
    assert.equal(result.manifest.files.length, files.length - 2);
    assert.equal(result.manifest.files.some((entry) => entry.path === 'manifest.json'), false);
    assert.equal(result.manifest.files.some((entry) => entry.path === 'SHA256SUMS'), false);
    assert.equal(contextManifest.source_commit, 'a'.repeat(40));
    assert.equal(result.manifest.contents.service_source, 'service/build-context/');
    assert.equal(result.manifest.artifacts.sdk_package.sha256, createHash('sha256').update('test sdk archive').digest('hex'));
    assert.equal(result.manifest.artifacts.service_build_context.path, 'service/build-context/');
    assert.match(result.manifest.artifacts.reference_client.tree_sha256, /^[a-f0-9]{64}$/);

    for (const entry of result.manifest.files) {
      const content = readFileSync(join(outputDir, entry.path));
      assert.equal(entry.bytes, content.byteLength);
      assert.equal(entry.sha256, createHash('sha256').update(content).digest('hex'));
    }

    const sums = readFileSync(join(outputDir, 'SHA256SUMS'), 'utf8');
    assert.match(sums, /  manifest\.json$/m);
    assert.doesNotMatch(sums, /  SHA256SUMS$/m);
    assert.deepEqual(validateIveKitDeliveryBundle(outputDir), result.manifest);
    assert.equal(files.some((file) => /call-center|ivr/i.test(file)), false);
    const migrationManifest = JSON.parse(readFileSync(
      join(outputDir, 'service', 'migration-manifest.json'),
      'utf8'
    )) as { migrations: Array<{ file: string; sha256: string }> };
    assert.equal(migrationManifest.migrations.length, 32);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '041_tinode_inbound_sync.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '042_ivekit_tenant_events.sql'), true);
    assert.equal(migrationManifest.migrations.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)), true);
    const imageMetadata = JSON.parse(readFileSync(
      join(outputDir, 'service', 'image-metadata.json'),
      'utf8'
    )) as { source_commit: string; status: string; build_context: string };
    assert.deepEqual(imageMetadata, {
      schema_version: 1,
      source_commit: 'a'.repeat(40),
      reference: `ivekit-service:${'a'.repeat(12)}`,
      digest: '',
      status: 'build_required',
      build_context: 'service/build-context/'
    });
    const sbom = JSON.parse(readFileSync(join(outputDir, 'service', 'sbom.spdx.json'), 'utf8')) as {
      spdxVersion: string;
      packages: unknown[];
    };
    assert.equal(sbom.spdxVersion, 'SPDX-2.3');
    assert.ok(sbom.packages.length > 1);
    const applicationCompose = readFileSync(join(outputDir, 'deploy/application/docker-compose.yml'), 'utf8');
    assert.doesNotMatch(applicationCompose, /^\s+build:/m);
    assert.doesNotMatch(applicationCompose, /ivekit-opc:local/);
    assert.match(applicationCompose, /IVEKIT_OPC_IMAGE_NAME:\?IVEKIT_OPC_IMAGE_NAME is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('iveKit delivery validation rejects extra files and secret material', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-delivery-secret-'));
  const outputDir = join(root, 'bundle');
  const sdkTarball = join(root, 'sdk.tgz');
  const clientDist = join(root, 'client-dist');
  writeFileSync(sdkTarball, 'sdk');
  mkdirSync(clientDist);
  writeFileSync(join(clientDist, 'index.html'), '<!doctype html>');

  try {
    buildIveKitDeliveryBundle({ repoRoot, outputDir, sdkTarball, clientDist });
    writeFileSync(join(outputDir, 'private-key.pem'), [
      '-----BEGIN PRIVATE KEY-----',
      'not-real-but-must-never-ship',
      '-----END PRIVATE KEY-----'
    ].join('\n'));

    assert.throws(
      () => validateIveKitDeliveryBundle(outputDir),
      /unexpected delivery file: private-key\.pem|secret material/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivery source paths remain inside the repository and destinations are unique', () => {
  const destinations = new Set<string>();
  for (const entry of DELIVERY_SOURCE_FILES) {
    assert.equal(relative(repoRoot, join(repoRoot, entry.source)).startsWith('..'), false);
    assert.equal(entry.destination.startsWith('/'), false);
    assert.equal(destinations.has(entry.destination), false, entry.destination);
    destinations.add(entry.destination);
  }
});

test('delivery generation refuses to erase an unowned existing directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-delivery-unowned-'));
  const outputDir = join(root, 'existing');
  const sdkTarball = join(root, 'sdk.tgz');
  const clientDist = join(root, 'client-dist');
  mkdirSync(outputDir);
  mkdirSync(clientDist);
  writeFileSync(join(outputDir, 'important.txt'), 'keep me');
  writeFileSync(join(clientDist, 'index.html'), '<!doctype html>');
  writeFileSync(sdkTarball, 'sdk');

  try {
    assert.throws(
      () => buildIveKitDeliveryBundle({ repoRoot, outputDir, sdkTarball, clientDist }),
      /refusing to replace an existing directory without the iveKit ownership marker/
    );
    assert.equal(readFileSync(join(outputDir, 'important.txt'), 'utf8'), 'keep me');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
