import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import {
  DELIVERY_SOURCE_FILES,
  assertIveKitDeliverySourceState,
  buildIveKitDeliveryBundle,
  listDeliveryFiles,
  loadControlledAcceptancePackage,
  validateIveKitDeliveryBundle
} from '../scripts/ivekit-delivery-bundle.js';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const testSourceCommit = 'a'.repeat(40);

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
      sourceCommit: testSourceCommit,
      generatedAt: '2026-07-13T00:00:00.000Z'
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
      'acceptance/provider-profiles.example.json',
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
      rustdesk: 'not_run',
      rustpbx: 'not_run',
      ocr: 'not_run',
      asr: 'not_run',
      quality_review: 'not_run',
      translation: 'not_run'
    });
    const v3Manifest = result.manifest as typeof result.manifest & {
      controlled_environment_acceptance: Record<string, string>;
      known_not_run: Array<{ id: string; status: string; reason: string }>;
      artifacts: typeof result.manifest.artifacts & {
        acceptance_status: { path: string; sha256: string };
        provider_profiles_example: { path: string; sha256: string };
      };
    };
    assert.deepEqual(v3Manifest.controlled_environment_acceptance, {
      postgres: 'not_run',
      provider_protocol: 'not_run',
      browser: 'not_run',
      restart_recovery: 'not_run'
    });
    assert.deepEqual(v3Manifest.known_not_run.map((entry) => entry.id), [
      'real_livekit_clients',
      'real_tinode_clients',
      'real_rustdesk_clients',
      'real_rustpbx',
      'real_ocr_vendor',
      'real_asr_vendor',
      'real_quality_vendor',
      'real_translation_vendor'
    ]);
    assert.equal(v3Manifest.known_not_run.every((entry) => entry.status === 'not_run' && entry.reason.length > 20), true);
    assert.equal(result.manifest.files.length, files.length - 2);
    assert.equal(result.manifest.files.some((entry) => entry.path === 'manifest.json'), false);
    assert.equal(result.manifest.files.some((entry) => entry.path === 'SHA256SUMS'), false);
    assert.equal(contextManifest.source_commit, testSourceCommit);
    assert.equal(result.manifest.contents.service_source, 'service/build-context/');
    assert.equal(
      (result.manifest.contents as typeof result.manifest.contents & { intelligence_preflight: string })
        .intelligence_preflight,
      'service/build-context/src/ivekit-intelligence-preflight.ts'
    );
    assert.equal(result.manifest.contents.voice_preflight, 'service/build-context/src/ivekit-voice-preflight.ts');
    assert.equal(result.manifest.contents.voice_compose, 'service/build-context/docker-compose.voice.yml');
    assert.equal(result.manifest.contents.voice_helm, 'deploy/kubernetes/ivekit/');
    assert.match(result.manifest.provider_ownership.rustpbx, /SIP|PSTN|call/i);
    assert.equal(result.manifest.artifacts.sdk_package.sha256, createHash('sha256').update('test sdk archive').digest('hex'));
    assert.equal(result.manifest.artifacts.service_build_context.path, 'service/build-context/');
    assert.match(result.manifest.artifacts.reference_client.tree_sha256, /^[a-f0-9]{64}$/);
    assert.equal(v3Manifest.artifacts.acceptance_status.path, 'acceptance/status.json');
    assert.equal(v3Manifest.artifacts.provider_profiles_example.path, 'acceptance/provider-profiles.example.json');
    assert.match(v3Manifest.artifacts.acceptance_status.sha256, /^[a-f0-9]{64}$/);
    assert.match(v3Manifest.artifacts.provider_profiles_example.sha256, /^[a-f0-9]{64}$/);

    for (const entry of result.manifest.files) {
      const content = readFileSync(join(outputDir, entry.path));
      assert.equal(entry.bytes, content.byteLength);
      assert.equal(entry.sha256, createHash('sha256').update(content).digest('hex'));
    }

    const sums = readFileSync(join(outputDir, 'SHA256SUMS'), 'utf8');
    assert.match(sums, /  manifest\.json$/m);
    assert.doesNotMatch(sums, /  SHA256SUMS$/m);
    assert.deepEqual(validateIveKitDeliveryBundle(outputDir), result.manifest);
    assert.equal(
      files.some((file) => [
        'service/build-context/src/agent-runtime/call-center/',
        'service/build-context/src/agent-runtime/ivr/'
      ].some((prefix) => file.startsWith(prefix))),
      false
    );
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/voice/index.ts'), true);
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/ivr/index.ts'), true);
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/contact-center/index.ts'), true);
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/contact-center/configuration-service.ts'), true);
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/contact-center/http.ts'), true);
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/contact-center/ivr-queue-port.ts'), true);
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/contact-center/queue-service.ts'), true);
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/contact-center/maintenance-worker.ts'), true);
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/contact-center/postgres/store.ts'), true);
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/contact-center/postgres/configuration-store.ts'), true);
    assert.equal(files.includes('service/build-context/src/agent-runtime/ivekit/contact-center/postgres/unit-of-work.ts'), true);
    assert.equal(files.includes('acceptance/tools/ivekit-controlled-voice-provider.ts'), true);
    assert.equal(files.includes('docs/ivekit-voice-foundation-v1-design.md'), true);
    assert.equal(files.includes('deploy/application/docker-compose.voice.yml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/Chart.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/values.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/templates/rustpbx-deployment.yaml'), true);
    for (const migration of [
      '040_rustdesk_control_ownership.sql',
      '041_tinode_inbound_sync.sql',
      '042_ivekit_tenant_events.sql',
      '043_ivekit_intelligence_translation.sql',
      '044_quality_review_policy_routing.sql',
      '045_translation_worker_routing.sql',
      '046_ivekit_voice_foundation.sql',
      '047_ivekit_ivr_foundation.sql',
      '048_ivekit_voice_operations.sql',
      '049_ivekit_voice_route_deployment.sql',
      '050_ivekit_ivr_runtime.sql',
      '051_ivekit_ivr_resources.sql',
      '052_ivekit_contact_center.sql',
      '053_ivekit_contact_center_configuration_idempotency.sql',
      '054_ivekit_contact_center_worker.sql',
      '055_ivekit_contact_center_callbacks.sql'
    ]) assert.equal(files.includes(`database/migrations/${migration}`), true, migration);
    const migrationManifest = JSON.parse(readFileSync(
      join(outputDir, 'service', 'migration-manifest.json'),
      'utf8'
    )) as { migrations: Array<{ file: string; sha256: string }> };
    assert.equal(migrationManifest.migrations.length, 45);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '041_tinode_inbound_sync.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '042_ivekit_tenant_events.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '043_ivekit_intelligence_translation.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '044_quality_review_policy_routing.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '045_translation_worker_routing.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '046_ivekit_voice_foundation.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '047_ivekit_ivr_foundation.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '048_ivekit_voice_operations.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '049_ivekit_voice_route_deployment.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '050_ivekit_ivr_runtime.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '051_ivekit_ivr_resources.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '052_ivekit_contact_center.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '053_ivekit_contact_center_configuration_idempotency.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '054_ivekit_contact_center_worker.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '055_ivekit_contact_center_callbacks.sql'), true);
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
    const voiceCompose = readFileSync(join(outputDir, 'service/build-context/docker-compose.voice.yml'), 'utf8');
    assert.match(voiceCompose, /command: \["node", "dist\/ivekit-render-rustpbx-config\.js"\]/);
    assert.doesNotMatch(voiceCompose, /--import|\btsx\b|scripts\/render-rustpbx-config\.ts/);
    const acceptance = JSON.parse(readFileSync(
      join(outputDir, 'acceptance', 'status.json'),
      'utf8'
    )) as Record<string, unknown>;
    assert.equal(acceptance.schema_version, 2);
    assert.equal(acceptance.source_commit, 'a'.repeat(40));
    assert.equal(acceptance.generated_at, '2026-07-13T00:00:00.000Z');
    assert.deepEqual(acceptance.controlled_environment, v3Manifest.controlled_environment_acceptance);
    assert.deepEqual(acceptance.real_environment, result.manifest.real_environment_acceptance);
    assert.deepEqual(acceptance.known_not_run, v3Manifest.known_not_run);
    assert.equal(acceptance.controlled_tests_are_real_vendor_evidence, false);
    const profiles = JSON.parse(readFileSync(
      join(outputDir, 'acceptance', 'provider-profiles.example.json'),
      'utf8'
    )) as Array<Record<string, unknown>>;
    assert.deepEqual(profiles.map((profile) => profile.capability), [
      'ocr', 'asr', 'quality_review', 'translation'
    ]);
    assert.equal(profiles.every((profile) => profile.base_url === 'http://controlled-intelligence-provider:8790'), true);
    assert.equal(files.includes('docs/ivekit-v3-intelligence-operations.md'), true);
    assert.equal(files.includes('docs/ivekit-v3-completion-audit.md'), true);
    assert.equal(files.includes('acceptance/tools/ivekit-controlled-provider.ts'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivery validation rejects stale, duplicate, or placeholder acceptance metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-delivery-acceptance-'));
  const outputDir = join(root, 'bundle');
  const sdkTarball = join(root, 'sdk.tgz');
  const clientDist = join(root, 'client-dist');
  writeFileSync(sdkTarball, 'sdk');
  mkdirSync(clientDist);
  writeFileSync(join(clientDist, 'index.html'), '<!doctype html>');

  try {
    buildIveKitDeliveryBundle({
      repoRoot,
      outputDir,
      sdkTarball,
      clientDist,
      sourceCommit: 'a'.repeat(40),
      generatedAt: '2026-07-13T00:00:00.000Z'
    });
    const path = join(outputDir, 'acceptance', 'status.json');
    const original = JSON.parse(readFileSync(path, 'utf8')) as {
      source_commit: string;
      known_not_run: Array<{ id: string; status: string; reason: string }>;
    };
    writeFileSync(path, `${JSON.stringify({ ...original, source_commit: 'b'.repeat(40) }, null, 2)}\n`);
    assert.throws(() => validateIveKitDeliveryBundle(outputDir), /acceptance source commit/i);

    writeFileSync(path, `${JSON.stringify({
      ...original,
      known_not_run: [...original.known_not_run, original.known_not_run[0]]
    }, null, 2)}\n`);
    assert.throws(() => validateIveKitDeliveryBundle(outputDir), /duplicate known_not_run/i);

    writeFileSync(path, `${JSON.stringify({
      ...original,
      known_not_run: original.known_not_run.map((entry, index) => index === 0
        ? { ...entry, reason: 'TBD' }
        : entry)
    }, null, 2)}\n`);
    assert.throws(() => validateIveKitDeliveryBundle(outputDir), /placeholder known_not_run/i);

    const manifestPath = join(outputDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({
      ...manifest,
      controlled_environment_acceptance: {}
    }, null, 2)}\n`);
    writeFileSync(path, `${JSON.stringify({
      ...original,
      controlled_environment: {}
    }, null, 2)}\n`);
    assert.throws(() => validateIveKitDeliveryBundle(outputDir), /controlled acceptance contract/i);
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
    buildIveKitDeliveryBundle({
      repoRoot,
      outputDir,
      sdkTarball,
      clientDist,
      sourceCommit: testSourceCommit
    });
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

test('delivery CLI source binding rejects invalid commits and dirty worktrees', () => {
  assert.doesNotThrow(() => assertIveKitDeliverySourceState('a'.repeat(40), ''));
  assert.throws(
    () => assertIveKitDeliverySourceState('not-a-full-commit', ''),
    /full 40-character Git commit/i
  );
  assert.throws(
    () => assertIveKitDeliverySourceState('a'.repeat(40), ' M docs/a.md\n?? secret.txt\n'),
    /worktree is dirty/i
  );
});

test('controlled acceptance package binds passed checks to source-scoped evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-controlled-acceptance-'));
  const evidenceDir = join(root, 'evidence');
  mkdirSync(evidenceDir);
  const evidence = {
    'postgres.log': 'fresh upgrade RLS and worker recovery passed\n',
    'provider.log': 'OCR ASR quality translation failure matrix passed\n',
    'browser.log': '128 unit and 9 Playwright checks passed\n',
    'restart.log': 'attachment quality translation expired leases recovered\n'
  };
  for (const [name, content] of Object.entries(evidence)) writeFileSync(join(evidenceDir, name), content);
  const entries = Object.entries(evidence).map(([path, content]) => ({
    path,
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex')
  }));
  const reportPath = join(root, 'report.json');
  const report = {
    schema_version: 1,
    product: 'iveKit',
    source_commit: testSourceCommit,
    controlled_tests_are_real_vendor_evidence: false,
    controlled_environment: {
      postgres: { status: 'passed', evidence: ['postgres.log'] },
      provider_protocol: { status: 'passed', evidence: ['provider.log'] },
      browser: { status: 'passed', evidence: ['browser.log'] },
      restart_recovery: { status: 'passed', evidence: ['restart.log'] }
    },
    evidence: entries
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  try {
    const accepted = loadControlledAcceptancePackage(root, testSourceCommit);
    assert.deepEqual(accepted.statuses, {
      postgres: 'passed',
      provider_protocol: 'passed',
      browser: 'passed',
      restart_recovery: 'passed'
    });
    assert.equal(accepted.evidence.length, 4);
    const sdkTarball = join(root, 'sdk.tgz');
    const clientDist = join(root, 'client-dist');
    const outputDir = join(root, 'bundle');
    writeFileSync(sdkTarball, 'sdk');
    mkdirSync(clientDist);
    writeFileSync(join(clientDist, 'index.html'), '<!doctype html>');
    const built = buildIveKitDeliveryBundle({
      repoRoot,
      outputDir,
      sdkTarball,
      clientDist,
      sourceCommit: testSourceCommit,
      controlledAcceptanceDir: root,
      generatedAt: '2026-07-13T06:00:00.000Z'
    });
    assert.deepEqual(built.manifest.controlled_environment_acceptance, accepted.statuses);
    const status = JSON.parse(readFileSync(join(outputDir, 'acceptance', 'status.json'), 'utf8')) as {
      status: string;
      evidence: Array<{ path: string }>;
    };
    assert.equal(status.status, 'passed');
    assert.deepEqual(status.evidence.map((entry) => entry.path).sort(), Object.keys(evidence).sort());
    assert.doesNotThrow(() => validateIveKitDeliveryBundle(outputDir));
    writeFileSync(join(evidenceDir, 'provider.log'), 'tampered\n');
    assert.throws(
      () => loadControlledAcceptancePackage(root, testSourceCommit),
      /controlled acceptance evidence checksum mismatch/
    );
    writeFileSync(join(evidenceDir, 'provider.log'), evidence['provider.log']);
    writeFileSync(reportPath, `${JSON.stringify({ ...report, real_environment: { ocr: 'passed' } }, null, 2)}\n`);
    assert.throws(
      () => loadControlledAcceptancePackage(root, testSourceCommit),
      /controlled acceptance cannot claim real vendor evidence/
    );
    writeFileSync(reportPath, `${JSON.stringify({
      ...report,
      controlled_environment: {
        ...report.controlled_environment,
        browser: { status: 'passed', evidence: [] }
      }
    }, null, 2)}\n`);
    assert.throws(
      () => loadControlledAcceptancePackage(root, testSourceCommit),
      /controlled acceptance evidence state is invalid: browser/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('V3 handoff documents state implemented, configurable, and not-run boundaries', () => {
  const roadmap = readFileSync('docs/ivekit-client-delivery-v1-roadmap.md', 'utf8');
  const design = readFileSync('docs/iveKit视频IM通用能力详细设计.md', 'utf8');
  const audit = readFileSync('docs/ivekit-v3-completion-audit.md', 'utf8');
  const voiceDesign = readFileSync('docs/ivekit-voice-foundation-v1-design.md', 'utf8');

  assert.match(roadmap, /M7：V3 多模态智能与翻译/);
  assert.match(roadmap, /OCR.*ASR.*AI.*翻译/s);
  assert.match(design, /## 22\. 2026-07-13 V3 多模态智能与翻译/);
  assert.match(design, /OPC_IVEKIT_PROVIDER_PROFILES_JSON/);
  assert.match(design, /043_ivekit_intelligence_translation/);
  assert.match(audit, /受控 Provider/);
  assert.match(audit, /not_run/);
  assert.match(voiceDesign, /M2.*代码完成.*受控 PostgreSQL.*通过/s);
  assert.match(voiceDesign, /\/api\/ivekit\/voice\/dids\/:id\/apply/);
  assert.match(voiceDesign, /\/api\/ivekit\/voice\/providers\/:profileId\/cdrs/);
  assert.match(voiceDesign, /DTMF.*Park.*Pickup.*capability_unavailable/s);
  assert.match(voiceDesign, /049_ivekit_voice_route_deployment/);
  assert.match(voiceDesign, /真实 RustPBX.*not_run/s);
  assert.match(design, /Voice Foundation V1.*受控 PostgreSQL.*通过/s);
  assert.match(design, /真实 RustPBX.*not_run/s);
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
      () => buildIveKitDeliveryBundle({
        repoRoot,
        outputDir,
        sdkTarball,
        clientDist,
        sourceCommit: testSourceCommit
      }),
      /refusing to replace an existing directory without the iveKit ownership marker/
    );
    assert.equal(readFileSync(join(outputDir, 'important.txt'), 'utf8'), 'keep me');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
