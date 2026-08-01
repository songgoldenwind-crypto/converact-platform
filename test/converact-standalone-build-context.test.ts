import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildConveractFabricStandaloneContext,
  validateConveractFabricStandaloneContext
} from '../scripts/converact-standalone-build-context.js';
import {
  analyzeConveractFabricStandaloneSourceGraph,
  readConveractFabricStandaloneSourcePolicy
} from '../scripts/converact-standalone-source-graph.js';
import { generateConveractFabricServiceLock } from '../scripts/generate-converact-service-lock.js';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('standalone context contains the complete allowed graph and no Converact product source', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-context-'));
  const outputDir = join(root, 'context');
  try {
    const result = buildConveractFabricStandaloneContext({
      repoRoot,
      outputDir,
      sourceCommit: 'b'.repeat(40),
      generatedAt: '2026-07-12T00:00:00.000Z'
    });
    const policy = readConveractFabricStandaloneSourcePolicy(repoRoot);
    const graph = analyzeConveractFabricStandaloneSourceGraph({ repoRoot, entrypoints: policy.entrypoints });

    for (const path of graph.files) assert.equal(result.manifest.files.some((entry) => entry.path === path), true, path);
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile']) {
      assert.equal(result.manifest.files.some((entry) => entry.path === path), true, path);
    }
    for (const path of ['docker-compose.voice.yml', 'init-rustpbx-database.sh']) {
      assert.equal(result.manifest.files.some((entry) => entry.path === path), true, path);
    }
    assert.equal(result.manifest.source_files, graph.files.length);
    assert.deepEqual(result.manifest.runtime_packages, graph.packages);
    assert.equal(result.manifest.source_commit, 'b'.repeat(40));
    assert.equal(result.manifest.files.some((entry) => /call-center|agent-runtime\/ivr|frontend\//.test(entry.path)), false);
    assert.deepEqual(validateConveractFabricStandaloneContext(outputDir), result.manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone service lock is reproducibly derived and excludes unrelated root dependencies', () => {
  const generated = generateConveractFabricServiceLock(repoRoot);
  const committed = JSON.parse(readFileSync('services/converact-service/package-lock.json', 'utf8'));
  assert.deepEqual(committed, generated);
  const rootDependencies = Object.keys((generated.packages[''].dependencies || {})).sort();
  assert.deepEqual(rootDependencies, [
    '@aws-sdk/client-s3',
    '@nats-io/jetstream',
    '@nats-io/nats-core',
    '@nats-io/transport-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/instrumentation-pg',
    '@opentelemetry/instrumentation-undici',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-node',
    '@opentelemetry/sdk-trace-base',
    'ajv',
    'file-type',
    'ioredis',
    'livekit-server-sdk',
    'nodemailer',
    'pg',
    'prom-client',
    'ws'
  ]);
  for (const unrelated of ['nats', 'node-cron', 'stripe']) {
    assert.equal(generated.packages[`node_modules/${unrelated}`], undefined, unrelated);
  }
});

test('standalone context refuses to erase a directory it does not own', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-context-unowned-'));
  const outputDir = join(root, 'existing');
  mkdirSync(outputDir);
  writeFileSync(join(outputDir, 'important.txt'), 'keep');
  try {
    assert.throws(
      () => buildConveractFabricStandaloneContext({ repoRoot, outputDir, sourceCommit: 'b'.repeat(40) }),
      /ownership marker/
    );
    assert.equal(readFileSync(join(outputDir, 'important.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone context rejects an invalid explicit source commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-context-commit-'));
  try {
    assert.throws(
      () => buildConveractFabricStandaloneContext({
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
    'CONVERACT_FABRIC_PROVIDER_PROFILES_JSON=[]',
    'CONVERACT_ATTACHMENT_PROCESSING_INTERVAL_MS=5000',
    'CONVERACT_ATTACHMENT_PROCESSING_CLAIM_LEASE_MS=120000',
    'CONVERACT_QUALITY_REVIEW_AUTO_ENQUEUE=0',
    'CONVERACT_QUALITY_REVIEW_CLAIM_LEASE_MS=120000',
    'CONVERACT_TRANSLATION_WORKER_ENABLED=0',
    'CONVERACT_TRANSLATION_INTERVAL_MS=5000',
    'CONVERACT_TRANSLATION_BATCH_SIZE=25',
    'CONVERACT_TRANSLATION_MAX_ATTEMPTS=3',
    'CONVERACT_TRANSLATION_CLAIM_LEASE_MS=120000',
    'CONVERACT_TRANSLATION_RETRY_DELAYS_MS=5000,30000'
  ];
  for (const file of ['.env.example', 'infra/converact/env.example', 'services/converact-service/env.example']) {
    const content = readFileSync(file, 'utf8');
    for (const value of required) assert.equal(content.split('\n').includes(value), true, `${file}: ${value}`);
    assert.equal(content.split('\n').some((line) => line.startsWith('MINIO_BUCKET=')), true, `${file}: MINIO_BUCKET`);
  }
  const compose = readFileSync('services/converact-service/docker-compose.yml', 'utf8');
  const voiceCompose = readFileSync('services/converact-service/docker-compose.voice.yml', 'utf8');
  const serviceEnv = readFileSync('services/converact-service/env.example', 'utf8');
  const immutablePostgresImage = /^CONVERACT_POSTGRES_IMAGE=postgres:[^\s@]+@sha256:[a-f0-9]{64}$/m;
  const immutableClamavImage =
    'CLAMAV_IMAGE=clamav/clamav:1.5.2_base@sha256:3aa0c6d6a966dc062899e070fb13f87485acf0cbb710fccaae9a848cd5f5b09a';
  assert.match(serviceEnv, immutablePostgresImage);
  assert.equal(serviceEnv.split('\n').includes(immutableClamavImage), true);
  assert.doesNotMatch(serviceEnv, /^CONVERACT_POSTGRES_IMAGE_TAG=/m);
  assert.match(
    compose,
    /image: \$\{CONVERACT_POSTGRES_IMAGE:\?CONVERACT_POSTGRES_IMAGE immutable digest reference is required\}/
  );
  assert.match(
    voiceCompose,
    /image: \$\{CONVERACT_POSTGRES_IMAGE:\?CONVERACT_POSTGRES_IMAGE immutable digest reference is required\}/
  );
  for (const value of ['CONVERACT_FABRIC_PROVIDER_PROFILES_JSON', 'CONVERACT_TRANSLATION_WORKER_ENABLED', 'MINIO_BUCKET']) {
    assert.match(compose, new RegExp(`${value}:`), value);
  }
  for (const value of [
    'CONVERACT_FILE_SECURITY_SCANNER_MODE',
    'CONVERACT_FILE_SECURITY_SCAN_WORKER_ENABLED',
    'CONVERACT_FILE_SECURITY_CLAMD_HOST',
    'CONVERACT_FILE_DERIVATIVE_WORKER_ENABLED',
    'CONVERACT_FILE_CLEANUP_WORKER_ENABLED'
  ]) assert.match(compose, new RegExp(`${value}:`), value);
  const clamav = compose.match(/^  clamav:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n|^volumes:)/m)?.[0] || '';
  assert.match(clamav, /image: \$\{CLAMAV_IMAGE:\?CLAMAV_IMAGE immutable digest reference is required\}/);
  assert.match(clamav, /healthcheck:/);
  assert.match(clamav, /clamdscan --ping/);
  assert.match(clamav, /clamav_signatures:\/var\/lib\/clamav/);
  assert.doesNotMatch(clamav, /ports:/);
  const converact = compose.match(/^  converact:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n|^volumes:)/m)?.[0] || '';
  assert.match(converact, /depends_on:[\s\S]*migrate:[\s\S]*condition: service_completed_successfully/);
  assert.doesNotMatch(converact, /\n {6}clamav:\n {8}condition: service_healthy/);
  const readme = readFileSync('services/converact-service/README.md', 'utf8');
  assert.match(readme, /ClamAV outage[^.]*must not gate API readiness or active communication/i);
  const dockerfile = readFileSync('services/converact-service/Dockerfile', 'utf8');
  assert.match(dockerfile, /apt-get install[^\n]*ffmpeg/);
  const servicePackage = JSON.parse(readFileSync('services/converact-service/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(servicePackage.scripts['preflight:intelligence'], 'node dist/converact-intelligence-preflight.js');
  assert.equal(servicePackage.scripts['render:kamailio-compose'], 'node dist/converact-kamailio-compose-config.js');
  assert.equal(servicePackage.scripts['accept:kamailio-webphone'], 'node dist/converact-kamailio-webphone-acceptance.js');
  assert.equal(servicePackage.scripts['render:rustpbx'], 'node dist/converact-render-rustpbx-config.js');
  assert.equal(servicePackage.scripts['project:rustpbx-routes'], 'node dist/converact-rustpbx-route-snapshot.js');
  assert.equal(servicePackage.scripts['preflight:voice'], 'node dist/converact-voice-preflight.js');
});

test('standalone verifier requires every compiled operational entrypoint', () => {
  const verifier = readFileSync('scripts/verify-converact-standalone-context.ts', 'utf8');

  for (const entrypoint of [
    'converact-server.js',
    'converact-worker.js',
    'converact-realtime-audio-tap-worker.js',
    'converact-kamailio-compose-config.js',
    'converact-kamailio-webphone-acceptance.js',
    'converact-render-rustpbx-config.js',
    'converact-rustpbx-route-snapshot.js',
    'converact-voice-preflight.js'
  ]) assert.match(verifier, new RegExp(entrypoint.replaceAll('.', '\\.')));
});
