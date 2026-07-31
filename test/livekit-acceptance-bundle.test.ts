import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createLiveKitAcceptanceBundleConfigFromEnv,
  writeLiveKitAcceptanceBundle
} from '../scripts/livekit-acceptance-bundle.js';

test('LiveKit acceptance bundle creates deterministic local handoff artifacts without forging runtime evidence', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'opc-livekit-acceptance-bundle-'));
  try {
    const result = writeLiveKitAcceptanceBundle({
      outputDir,
      title: 'LED LiveKit Acceptance',
      env: configuredEnv()
    });
    const manifest = JSON.parse(readFileSync(result.manifestFile, 'utf8')) as any;

    assert.equal(result.status, 'awaiting_real_environment_evidence');
    assert.equal(result.evidencePackOk, false);
    assert.equal(manifest.status, 'awaiting_real_environment_evidence');
    assert.equal(manifest.acceptance.run_id, 'lk-run-20260711-001');
    for (const file of [
      'env-checklist.md',
      'preflight.json',
      'server-runbook.md',
      'client-acceptance-runbook.md',
      'client-acceptance-template.json',
      'evidence-pack.md',
      'manifest.json'
    ]) {
      assert.equal(existsSync(join(outputDir, file)), true, file);
    }
    for (const file of ['server-evidence.json', 'readiness.json', 'client-acceptance-result.json']) {
      assert.equal(existsSync(join(outputDir, file)), false, `${file} must come from real execution`);
    }
    assert.match(manifest.commands.server_evidence, /server-evidence\.json' npm run livekit:server-evidence/);
    assert.match(manifest.commands.readiness, /readiness\.json' npm run smoke:media:readiness/);
    assert.match(manifest.commands.client_acceptance, /client-acceptance-result\.json' npm run livekit:client-acceptance/);
    assert.match(manifest.commands.evidence_pack, /npm run livekit:evidence-pack/);
    assert.equal(manifest.evidence_pack.status, 'incomplete');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('LiveKit acceptance bundle refuses to reuse a directory containing real evidence', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'opc-livekit-acceptance-existing-'));
  try {
    writeFileSync(join(outputDir, 'server-evidence.json'), '{}\n');
    assert.throws(
      () => writeLiveKitAcceptanceBundle({ outputDir, title: 'Unsafe reuse', env: configuredEnv() }),
      /already contains real-environment evidence/
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('LiveKit acceptance bundle shell-quotes paths with spaces and single quotes', () => {
  const parent = mkdtempSync(join(tmpdir(), 'opc-livekit-acceptance-quote-'));
  const outputDir = join(parent, "bundle with ' quote");
  try {
    const result = writeLiveKitAcceptanceBundle({ outputDir, title: 'Quoted paths', env: configuredEnv() });
    const manifest = JSON.parse(readFileSync(result.manifestFile, 'utf8')) as any;
    assert.match(manifest.commands.server_evidence, /OPC_LIVEKIT_SERVER_EVIDENCE_FILE='.*bundle with '"'"' quote.*server-evidence\.json'/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('LiveKit acceptance bundle masks deployment secrets in every generated artifact', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'opc-livekit-acceptance-secrets-'));
  const secrets = [
    'bundle-livekit-secret-value',
    'bundle-media-token-value',
    'bundle-invite-secret-value',
    'bundle-storage-secret-value'
  ];
  try {
    writeLiveKitAcceptanceBundle({
      outputDir,
      title: 'Secret-safe LiveKit Bundle',
      env: configuredEnv({
        LIVEKIT_API_SECRET: secrets[0],
        OPC_MEDIA_API_TOKEN: secrets[1],
        OPC_MEDIA_INVITE_SECRET: secrets[2],
        MINIO_SECRET_KEY: secrets[3]
      })
    });

    for (const file of [
      'env-checklist.md',
      'preflight.json',
      'server-runbook.md',
      'client-acceptance-runbook.md',
      'client-acceptance-template.json',
      'evidence-pack.md',
      'manifest.json'
    ]) {
      const content = readFileSync(join(outputDir, file), 'utf8');
      for (const secret of secrets) assert.equal(content.includes(secret), false, `${file} leaked a secret`);
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('LiveKit acceptance bundle config requires an output directory', () => {
  assert.throws(
    () => createLiveKitAcceptanceBundleConfigFromEnv({}),
    /OPC_LIVEKIT_ACCEPTANCE_BUNDLE_DIR is required/
  );
  const config = createLiveKitAcceptanceBundleConfigFromEnv({
    OPC_LIVEKIT_ACCEPTANCE_BUNDLE_DIR: '/tmp/livekit-bundle',
    OPC_LIVEKIT_ACCEPTANCE_BUNDLE_TITLE: 'Customer LiveKit Acceptance'
  });
  assert.equal(config.outputDir, '/tmp/livekit-bundle');
  assert.equal(config.title, 'Customer LiveKit Acceptance');
});

test('LiveKit acceptance bundle rejects an invalid acceptance deployment mode', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'opc-livekit-acceptance-mode-'));
  try {
    assert.throws(
      () => writeLiveKitAcceptanceBundle({
        outputDir,
        title: 'Invalid mode',
        env: configuredEnv({ OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE: 'bundled-dev' })
      }),
      /must match OPC_LIVEKIT_DEPLOYMENT_MODE|must be standalone-vm or external/
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('LiveKit acceptance bundle is exposed through package scripts', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['livekit:acceptance-bundle'], 'tsx scripts/livekit-acceptance-bundle.ts');
});

function configuredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    OPC_LIVEKIT_DEPLOYMENT_MODE: 'standalone-vm',
    OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE: 'standalone-vm',
    OPC_LIVEKIT_ACCEPTANCE_RUN_ID: 'lk-run-20260711-001',
    OPC_LIVEKIT_ACCEPTANCE_ENVIRONMENT_ID: 'led-staging-sfo2',
    OPC_LIVEKIT_ACCEPTANCE_DEPLOYED_COMMIT: 'a'.repeat(40),
    LIVEKIT_URL: 'ws://10.0.0.8:7880',
    LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com',
    LIVEKIT_SIGNAL_DOMAIN: 'livekit.example.com',
    LIVEKIT_TURN_DOMAIN: 'turn.example.com',
    LIVEKIT_ACME_EMAIL: 'ops@example.com',
    LIVEKIT_API_KEY: 'bundle-livekit-key',
    LIVEKIT_API_SECRET: 'bundle-livekit-secret',
    LIVEKIT_SERVER_IMAGE_TAG: 'v1.13.4',
    LIVEKIT_EGRESS_IMAGE_TAG: 'v1.13.0',
    LIVEKIT_SIP_IMAGE_TAG: 'v1.6.0',
    LIVEKIT_CADDYL4_IMAGE_TAG: 'v2.11.3',
    LIVEKIT_REDIS_IMAGE_TAG: '7.4.9',
    OPC_BASE_URL: 'https://opc.example.com',
    OPC_MEDIA_API_TOKEN: 'bundle-media-token',
    OPC_MEDIA_INVITE_SECRET: 'bundle-invite-secret',
    OPC_MEDIA_SMOKE_TENANT_ID: 'tenant-led',
    OPC_VIDEO_READINESS_TARGETS: 'media',
    MINIO_ACCESS_KEY: 'bundle-storage-key',
    MINIO_SECRET_KEY: 'bundle-storage-secret',
    ...overrides
  };
}
