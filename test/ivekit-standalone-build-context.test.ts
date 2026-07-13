import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildIveKitStandaloneContext,
  validateIveKitStandaloneContext
} from '../scripts/ivekit-standalone-build-context.js';
import {
  analyzeIveKitStandaloneSourceGraph,
  readIveKitStandaloneSourcePolicy
} from '../scripts/ivekit-standalone-source-graph.js';
import { generateIveKitServiceLock } from '../scripts/generate-ivekit-service-lock.js';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('standalone context contains the complete allowed graph and no OPC product source', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-context-'));
  const outputDir = join(root, 'context');
  try {
    const result = buildIveKitStandaloneContext({
      repoRoot,
      outputDir,
      sourceCommit: 'b'.repeat(40),
      generatedAt: '2026-07-12T00:00:00.000Z'
    });
    const policy = readIveKitStandaloneSourcePolicy(repoRoot);
    const graph = analyzeIveKitStandaloneSourceGraph({ repoRoot, entrypoints: policy.entrypoints });

    for (const path of graph.files) assert.equal(result.manifest.files.some((entry) => entry.path === path), true, path);
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile']) {
      assert.equal(result.manifest.files.some((entry) => entry.path === path), true, path);
    }
    assert.equal(result.manifest.source_files, graph.files.length);
    assert.deepEqual(result.manifest.runtime_packages, graph.packages);
    assert.equal(result.manifest.source_commit, 'b'.repeat(40));
    assert.equal(result.manifest.files.some((entry) => /call-center|agent-runtime\/ivr|frontend\//.test(entry.path)), false);
    assert.deepEqual(validateIveKitStandaloneContext(outputDir), result.manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone service lock is reproducibly derived and excludes unrelated root dependencies', () => {
  const generated = generateIveKitServiceLock(repoRoot);
  const committed = JSON.parse(readFileSync('services/ivekit-service/package-lock.json', 'utf8'));
  assert.deepEqual(committed, generated);
  const rootDependencies = Object.keys((generated.packages[''].dependencies || {})).sort();
  assert.deepEqual(rootDependencies, [
    '@aws-sdk/client-s3',
    'ioredis',
    'livekit-server-sdk',
    'pg',
    'prom-client',
    'ws'
  ]);
  for (const unrelated of ['nats', 'node-cron', 'nodemailer', 'stripe']) {
    assert.equal(generated.packages[`node_modules/${unrelated}`], undefined, unrelated);
  }
});

test('standalone context refuses to erase a directory it does not own', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-context-unowned-'));
  const outputDir = join(root, 'existing');
  mkdirSync(outputDir);
  writeFileSync(join(outputDir, 'important.txt'), 'keep');
  try {
    assert.throws(
      () => buildIveKitStandaloneContext({ repoRoot, outputDir, sourceCommit: 'b'.repeat(40) }),
      /ownership marker/
    );
    assert.equal(readFileSync(join(outputDir, 'important.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone context rejects an invalid explicit source commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-context-commit-'));
  try {
    assert.throws(
      () => buildIveKitStandaloneContext({
        repoRoot,
        outputDir: join(root, 'context'),
        sourceCommit: 'snapshot'
      }),
      /full 40-character Git commit/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone V3 examples expose provider profiles, storage, and bounded worker settings', () => {
  const required = [
    'OPC_IVEKIT_PROVIDER_PROFILES_JSON=[]',
    'OPC_ATTACHMENT_PROCESSING_INTERVAL_MS=5000',
    'OPC_ATTACHMENT_PROCESSING_CLAIM_LEASE_MS=120000',
    'OPC_QUALITY_REVIEW_AUTO_ENQUEUE=0',
    'OPC_QUALITY_REVIEW_CLAIM_LEASE_MS=120000',
    'OPC_TRANSLATION_WORKER_ENABLED=0',
    'OPC_TRANSLATION_INTERVAL_MS=5000',
    'OPC_TRANSLATION_BATCH_SIZE=25',
    'OPC_TRANSLATION_MAX_ATTEMPTS=3',
    'OPC_TRANSLATION_CLAIM_LEASE_MS=120000',
    'OPC_TRANSLATION_RETRY_DELAYS_MS=5000,30000'
  ];
  for (const file of ['.env.example', 'infra/ivekit/env.example', 'services/ivekit-service/env.example']) {
    const content = readFileSync(file, 'utf8');
    for (const value of required) assert.equal(content.split('\n').includes(value), true, `${file}: ${value}`);
    assert.equal(content.split('\n').some((line) => line.startsWith('MINIO_BUCKET=')), true, `${file}: MINIO_BUCKET`);
  }
  const compose = readFileSync('services/ivekit-service/docker-compose.yml', 'utf8');
  for (const value of ['OPC_IVEKIT_PROVIDER_PROFILES_JSON', 'OPC_TRANSLATION_WORKER_ENABLED', 'MINIO_BUCKET']) {
    assert.match(compose, new RegExp(`${value}:`), value);
  }
  const servicePackage = JSON.parse(readFileSync('services/ivekit-service/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(servicePackage.scripts['preflight:intelligence'], 'node dist/ivekit-intelligence-preflight.js');
});
