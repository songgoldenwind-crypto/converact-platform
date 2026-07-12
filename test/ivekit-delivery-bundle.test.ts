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
    const expected = [
      ...DELIVERY_SOURCE_FILES.map((entry) => entry.destination),
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

    for (const entry of result.manifest.files) {
      const content = readFileSync(join(outputDir, entry.path));
      assert.equal(entry.bytes, content.byteLength);
      assert.equal(entry.sha256, createHash('sha256').update(content).digest('hex'));
    }

    const sums = readFileSync(join(outputDir, 'SHA256SUMS'), 'utf8');
    assert.match(sums, /  manifest\.json$/m);
    assert.doesNotMatch(sums, /SHA256SUMS/);
    assert.deepEqual(validateIveKitDeliveryBundle(outputDir), result.manifest);
    assert.equal(files.some((file) => /call-center|ivr|src\//i.test(file)), false);
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
