import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

import {
  DELIVERY_SOURCE_FILES,
  assertIveKitDeliverySourceState,
  buildIveKitDeliveryBundle,
  listDeliveryFiles,
  loadControlledAcceptancePackage,
  validateIveKitDeliveryBundle
} from '../scripts/ivekit-delivery-bundle.js';
import { VOICE_REQUIRED_ACCEPTANCE_CHECKS } from '../scripts/ivekit-voice-acceptance.js';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const testSourceCommit = 'a'.repeat(40);

test('capacity runtime handoff typechecks without borrowing repository source', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-capacity-runtime-'));
  try {
    for (const entry of DELIVERY_SOURCE_FILES) {
      if (!entry.destination.startsWith('capacity-runtime/')) continue;
      const destination = join(
        root,
        entry.destination.slice('capacity-runtime/'.length)
      );
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repoRoot, entry.source), destination, { recursive: true });
    }
    cpSync(
      join(root, 'infra', 'capacity', 'package.json'),
      join(root, 'package.json')
    );
    cpSync(
      join(root, 'infra', 'capacity', 'package-lock.json'),
      join(root, 'package-lock.json')
    );
    const install = spawnSync(
      'npm',
      ['ci', '--ignore-scripts', '--offline'],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(
      install.status,
      0,
      `capacity runtime npm ci failed:\n${install.stdout}\n${install.stderr}`
    );
    const typecheck = spawnSync(
      join(root, 'node_modules', '.bin', 'tsc'),
      ['--noEmit', '-p', 'infra/capacity/tsconfig.json'],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(
      typecheck.status,
      0,
      `capacity runtime typecheck failed:\n${typecheck.stdout}\n${typecheck.stderr}`
    );
    const prune = spawnSync(
      'npm',
      ['prune', '--omit=dev', '--ignore-scripts', '--offline'],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(
      prune.status,
      0,
      `capacity runtime prune failed:\n${prune.stdout}\n${prune.stderr}`
    );
    assert.equal(existsSync(join(root, 'node_modules', 'typescript')), false);
    assert.equal(existsSync(join(root, 'node_modules', 'tsx')), true);
    const smoke = spawnSync(
      'node',
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        [
          'await Promise.all([',
          'import("./scripts/ivekit-capacity-dispatcher.ts"),',
          'import("./scripts/ivekit-capacity-controller.ts"),',
          'import("./scripts/ivekit-capacity-finalizer.ts"),',
          'import("./scripts/ivekit-capacity-worker.ts"),',
          'import("./scripts/ivekit-cell-admission.ts"),',
          'import("./scripts/ivekit-cell-capacity-projector.ts"),',
          'import("./scripts/ivekit-component-node-admission.ts"),',
          'import("./src/agent-runtime/ivekit/placement/rustdesk-owner-binding.ts")',
          ']);'
        ].join('')
      ],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(
      smoke.status,
      0,
      `capacity runtime production dependency smoke failed:\n` +
      `${smoke.stdout}\n${smoke.stderr}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      'service/sbom.spdx.json',
      'operations/release-contract.json',
      'operations/stage2-deployment-evidence.json',
      'operations/upgrade-runbook.md'
    ];
    const expected = [
      ...DELIVERY_SOURCE_FILES.map((entry) => entry.destination),
      ...contextFiles,
      'edge/dist/rustdesk-edge-agent.js',
      'edge/dist/rustdesk-edge-command.js',
      'edge/dist/rustdesk-edge-pending-store.js',
      'edge/dist/rustdesk-owner-epoch-fence.js',
      'edge/dist/rustdesk-edge-observation-contract.js',
      'edge/dist/rustdesk-observation-spool.js',
      'edge/dist/rustdesk-observation-bridge.js',
      'edge/dist/rustdesk-evidence-uploader.js',
      'edge/dist/rustdesk-native-evidence-policy.js',
      'edge/dist/rustdesk-native-evidence-correlator.js',
      'edge/dist/rustdesk-native-evidence-watcher.js',
      'acceptance/rustpbx/package.json',
      'acceptance/rustpbx/package-lock.json',
      'acceptance/rustpbx/scripts/ivekit-rustpbx-management-acceptance.js',
      'acceptance/rustpbx/scripts/ivekit-rustpbx-rwi-acceptance.js',
      'acceptance/rustpbx/scripts/ivekit-rustpbx-sipp-acceptance.js',
      'acceptance/rustpbx/src/agent-runtime/ivekit/voice/adapters/rustpbx-management.js',
      'acceptance/rustpbx/src/agent-runtime/ivekit/voice/adapters/rustpbx-rwi.js',
      'acceptance/rustpbx/src/agent-runtime/ivekit/voice/canonical.js',
      'acceptance/rustpbx/src/agent-runtime/ivekit/voice/capabilities.js',
      'acceptance/rustpbx/src/agent-runtime/ivekit/voice/errors.js',
      'acceptance/rustpbx/src/agent-runtime/ivekit/voice/ports.js',
      'acceptance/rustpbx/src/agent-runtime/ivekit/voice/secret-resolver.js',
      'acceptance/rustpbx/src/agent-runtime/ivekit/voice/types.js',
      'acceptance/rustpbx/src/db-pg.js',
      'acceptance/rustpbx/src/postgres-migrations.js',
      '.ivekit-delivery-root',
      'README.md',
      'SHA256SUMS',
      'acceptance/provider-profiles.example.json',
      'acceptance/status.json',
      'acceptance/v6-real-template.json',
      'acceptance/voice-real-runbook.md',
      'acceptance/voice-real-template.json',
      'client/assets/index.js',
      'client/index.html',
      'manifest.json',
      'sdk/opc-ivekit-sdk-0.1.0.tgz'
    ].sort();

    assert.equal(
      DELIVERY_SOURCE_FILES.some((entry) =>
        entry.destination === 'edge/src/rustdesk-native-evidence-correlator.ts'),
      true
    );
    assert.equal(
      DELIVERY_SOURCE_FILES.some((entry) =>
        entry.destination === 'edge/src/rustdesk-owner-epoch-fence.ts'),
      true
    );
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
      translation: 'not_run',
      notification_providers: 'not_run',
      file_security: 'not_run',
      public_webhook: 'not_run',
      kubernetes: 'not_run',
      backup_restore: 'not_run'
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
      restart_recovery: 'not_run',
      full_chain: 'not_run'
    });
    assert.deepEqual(v3Manifest.known_not_run.map((entry) => entry.id), [
      'real_livekit_clients',
      'real_tinode_clients',
      'real_rustdesk_clients',
      'real_rustpbx',
      'real_ocr_vendor',
      'real_asr_vendor',
      'real_quality_vendor',
      'real_translation_vendor',
      'real_notification_providers',
      'real_file_security',
      'real_public_webhook',
      'real_kubernetes',
      'real_backup_restore'
    ]);
    assert.equal(result.manifest.foundation_version, 'V5');
    assert.equal(result.manifest.capability_matrix.length, 11);
    assert.equal(result.manifest.capability_matrix.every((entry) => entry.delivery_status === 'included'), true);
    assert.equal(result.manifest.acceptance_matrix.automated.status, 'required_before_release');
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
    assert.equal(result.manifest.contents.voice_acceptance_template, 'acceptance/voice-real-template.json');
    assert.equal(result.manifest.contents.voice_acceptance_runbook, 'acceptance/voice-real-runbook.md');
    assert.equal(result.manifest.contents.rustpbx_image_build, 'deploy/rustpbx/');
    assert.equal(result.manifest.contents.rustpbx_acceptance, 'acceptance/rustpbx/');
    assert.equal(result.manifest.contents.capacity_runtime, 'capacity-runtime/');
    assert.equal(result.manifest.contents.operations, 'docs/ivekit-v3-intelligence-operations.md');
    assert.equal(result.manifest.contents.release_operations, 'operations/upgrade-runbook.md');
    assert.match(result.manifest.provider_ownership.rustpbx, /SIP|PSTN|call/i);
    assert.equal(result.manifest.artifacts.sdk_package.sha256, createHash('sha256').update('test sdk archive').digest('hex'));
    assert.equal(result.manifest.artifacts.service_build_context.path, 'service/build-context/');
    assert.match(result.manifest.artifacts.reference_client.tree_sha256, /^[a-f0-9]{64}$/);
    assert.equal(v3Manifest.artifacts.acceptance_status.path, 'acceptance/status.json');
    assert.equal(v3Manifest.artifacts.provider_profiles_example.path, 'acceptance/provider-profiles.example.json');
    assert.match(v3Manifest.artifacts.acceptance_status.sha256, /^[a-f0-9]{64}$/);
    assert.match(v3Manifest.artifacts.provider_profiles_example.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.manifest.artifacts.release_contract.path, 'operations/release-contract.json');
    assert.equal(
      result.manifest.artifacts.stage2_deployment_evidence.path,
      'operations/stage2-deployment-evidence.json'
    );
    assert.equal(result.manifest.artifacts.upgrade_runbook.path, 'operations/upgrade-runbook.md');

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
    assert.equal(files.includes('acceptance/tools/ivekit-voice-acceptance.ts'), true);
    assert.equal(files.includes('deploy/rustpbx/build.sh'), true);
    assert.equal(files.includes('deploy/rustpbx/Cargo.lock'), true);
    assert.equal(files.includes('deploy/rustpbx/patches/rsipstack-tcp-reconnect.patch'), true);
    assert.equal(files.includes('deploy/rustpbx/patches/rsipstack-ivekit-capacity.patch'), true);
    assert.equal(files.includes('deploy/rustpbx/patches/rustpbx-ivekit-ami-dialogs.patch'), true);
    assert.equal(
      files.includes('deploy/rustpbx/patches/rustpbx-ivekit-rwi-originate-hangup.patch'),
      true
    );
    assert.equal(
      files.includes('deploy/rustpbx/patches/rustpbx-ivekit-route-snapshot.patch'),
      true
    );
    assert.equal(
      files.includes('deploy/rustpbx/patches/rustpbx-ivekit-inbound-admission.patch'),
      true
    );
    assert.equal(
      files.includes('deploy/rustpbx/patches/rustpbx-ivekit-owner-epoch.patch'),
      true
    );
    assert.equal(
      files.includes('deploy/rustpbx/patches/rustpbx-ivekit-recording-spool.patch'),
      true
    );
    assert.equal(
      files.includes('deploy/rustpbx/patches/rustpbx-ivekit-sip-capacity.patch'),
      true
    );
    assert.equal(
      files.includes('deploy/rustpbx/patches/rustpbx-ivekit-media-hot-path.patch'),
      true
    );
    assert.equal(files.includes('acceptance/rustpbx/router.py'), true);
    assert.equal(files.includes('acceptance/rustpbx/sipp/answer-bye-uac.xml'), true);
    const rustPbxAcceptancePackage = JSON.parse(readFileSync(
      join(outputDir, 'acceptance', 'rustpbx', 'package.json'),
      'utf8'
    )) as {
      name: string;
      version: string;
      type: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.deepEqual(rustPbxAcceptancePackage, {
      name: 'ivekit-rustpbx-acceptance',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: { ws: '8.21.0' },
      scripts: {
        management: 'node scripts/ivekit-rustpbx-management-acceptance.js',
        rwi: 'node scripts/ivekit-rustpbx-rwi-acceptance.js',
        sipp: 'node scripts/ivekit-rustpbx-sipp-acceptance.js'
      }
    });
    const rustPbxAcceptanceLock = JSON.parse(readFileSync(
      join(outputDir, 'acceptance', 'rustpbx', 'package-lock.json'),
      'utf8'
    )) as {
      lockfileVersion: number;
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    assert.equal(rustPbxAcceptanceLock.lockfileVersion, 3);
    assert.equal(rustPbxAcceptanceLock.packages['node_modules/ws']?.version, '8.21.0');
    assert.match(rustPbxAcceptanceLock.packages['node_modules/ws']?.integrity || '', /^sha512-/);
    const compiledSippAcceptance = readFileSync(
      join(outputDir, 'acceptance', 'rustpbx', 'scripts', 'ivekit-rustpbx-sipp-acceptance.js'),
      'utf8'
    );
    assert.match(compiledSippAcceptance, /\.\.\/sipp\//);
    assert.doesNotMatch(compiledSippAcceptance, /--import|\btsx\b/);
    const compiledRwiAcceptance = readFileSync(
      join(outputDir, 'acceptance', 'rustpbx', 'scripts', 'ivekit-rustpbx-rwi-acceptance.js'),
      'utf8'
    );
    assert.match(compiledRwiAcceptance, /active_call_registry/);
    assert.match(compiledRwiAcceptance, /RustPbxRwiClient/);
    assert.doesNotMatch(compiledRwiAcceptance, /--import|\btsx\b/);
    const tcpReconnectPatch = readFileSync(
      join(outputDir, 'deploy', 'rustpbx', 'patches', 'rsipstack-tcp-reconnect.patch'),
      'utf8'
    );
    assert.match(tcpReconnectPatch, /closed_tcp_connection_is_removed_before_reconnect/);
    const capacityPatch = readFileSync(
      join(outputDir, 'deploy', 'rustpbx', 'patches', 'rsipstack-ivekit-capacity.patch'),
      'utf8'
    );
    assert.match(capacityPatch, /StatusCode::ServiceUnavailable/);
    assert.match(capacityPatch, /connection_limit_rejections_total/);
    const rustPbxSipCapacityPatch = readFileSync(
      join(outputDir, 'deploy', 'rustpbx', 'patches', 'rustpbx-ivekit-sip-capacity.patch'),
      'utf8'
    );
    assert.match(rustPbxSipCapacityPatch, /EndpointCapacityLimits::try_new/);
    assert.match(rustPbxSipCapacityPatch, /rustpbx_sip_endpoint_active_limit_rejections_total/);
    const voiceTemplate = JSON.parse(readFileSync(
      join(outputDir, 'acceptance', 'voice-real-template.json'),
      'utf8'
    )) as {
      source: string;
      status: string;
      deployed_commit: string;
      checks: Record<string, { passed: boolean }>;
    };
    assert.equal(voiceTemplate.source, 'real_voice_environment');
    assert.equal(voiceTemplate.status, 'incomplete');
    assert.equal(voiceTemplate.deployed_commit, testSourceCommit);
    assert.deepEqual(Object.keys(voiceTemplate.checks), [...VOICE_REQUIRED_ACCEPTANCE_CHECKS]);
    assert.equal(Object.values(voiceTemplate.checks).every((check) => check.passed === false), true);
    const voiceRunbook = readFileSync(join(outputDir, 'acceptance', 'voice-real-runbook.md'), 'utf8');
    assert.match(voiceRunbook, /RustPBX/);
    assert.match(voiceRunbook, /SIP And PSTN/);
    assert.match(voiceRunbook, /WebPhone And RTP/);
    assert.match(voiceRunbook, /does not change any delivery `not_run` result automatically/);
    assert.equal(files.includes('docs/ivekit-voice-foundation-v1-design.md'), true);
    assert.equal(files.includes('deploy/application/docker-compose.voice.yml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/Chart.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/values.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/templates/rustpbx-deployment.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/templates/migrate-job.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/templates/deployment.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/templates/service-monitor.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/templates/prometheus-rule.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/templates/grafana-dashboard.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/files/prometheus-rules.yaml'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/files/grafana-dashboard.json'), true);
    assert.equal(files.includes('docs/ivekit-monitoring-runbook.md'), true);
    assert.equal(
      files.includes('docs/capacity/component-node-admission-protocol-v1.md'),
      true
    );
    assert.equal(
      files.includes('docs/capacity/forks/ivekit-forks-v1.json'),
      true
    );
    assert.equal(
      files.includes('docs/capacity/implementation-plan-phase2.md'),
      true
    );
    assert.equal(
      files.includes('docs/capacity/profiles/cell-10k-v1.json'),
      true
    );
    assert.equal(
      files.includes('docs/adr/ccaas-1-cell-placement.md'),
      true
    );
    assert.equal(
      files.includes('infra/capacity/kubernetes/cell-admission-deployment.yaml'),
      true
    );
    assert.equal(
      files.includes('infra/capacity/kubernetes/component-node-admission-sidecar.yaml'),
      true
    );
    assert.equal(
      files.includes('infra/capacity/kubernetes/livekit-statefulset.yaml'),
      true
    );
    assert.equal(
      files.includes('infra/capacity/kubernetes/tinode-statefulset.yaml'),
      true
    );
    assert.equal(
      files.includes('infra/capacity/kubernetes/rustdesk-statefulset.yaml'),
      true
    );
    assert.equal(
      files.includes('infra/capacity/kubernetes/scaling-finalizer-job.yaml'),
      true
    );
    assert.equal(
      files.includes('infra/capacity/kubernetes/platform-finalizer-job.yaml'),
      true
    );
    assert.equal(
      files.includes('capacity-runtime/infra/capacity/Dockerfile'),
      true
    );
    assert.equal(
      files.includes('capacity-runtime/infra/capacity/tsconfig.json'),
      true
    );
    assert.equal(
      files.includes('capacity-runtime/scripts/ivekit-capacity-controller.ts'),
      true
    );
    assert.equal(
      files.includes('capacity-runtime/scripts/ivekit-capacity-scaling-finalizer.ts'),
      true
    );
    assert.equal(
      files.includes('capacity-runtime/scripts/ivekit-capacity-platform-finalizer.ts'),
      true
    );
    assert.equal(
      files.includes('capacity-runtime/scripts/capacity/scaling-campaign-runtime.ts'),
      true
    );
    assert.equal(
      files.includes('capacity-runtime/scripts/capacity/orchestrator/worker-runtime.ts'),
      true
    );
    assert.equal(
      files.includes('capacity-runtime/scripts/ivekit-cell-admission.ts'),
      true
    );
    assert.equal(
      files.includes('capacity-runtime/scripts/ivekit-rustdesk-owner-binding.ts'),
      true
    );
    assert.equal(
      files.includes(
        'capacity-runtime/src/agent-runtime/ivekit/placement/component-node-admission.ts'
      ),
      true
    );
    assert.equal(
      files.includes('deploy/rustdesk-server-fork/bench/relay-hot-path.rs'),
      true
    );
    assert.equal(files.includes('deploy/rustdesk-server-fork/bench/run.sh'), true);
    assert.equal(
      files.includes(
        'capacity-runtime/src/agent-runtime/ivekit/placement/pg-queryable.ts'
      ),
      true
    );
    assert.equal(files.includes('fork-hooks/go/hook.go'), true);
    assert.equal(files.includes('fork-hooks/go/http_authorizer.go'), true);
    assert.equal(files.includes('fork-hooks/livekit-v1.13.3/registry.go'), true);
    assert.equal(files.includes('fork-hooks/livekit-v1.13.3/registry_test.go'), true);
    assert.equal(files.includes('fork-hooks/tinode-v0.25.3/registry.go'), true);
    assert.equal(files.includes('fork-hooks/tinode-v0.25.3/registry_test.go'), true);
    assert.equal(files.includes('fork-hooks/rust/Cargo.toml'), true);
    assert.equal(files.includes('fork-hooks/rust/Cargo.lock'), true);
    assert.equal(files.includes('fork-hooks/rust/src/lib.rs'), true);
    assert.equal(files.includes('deploy/livekit-fork/apply-overlay.mjs'), true);
    assert.equal(files.includes('deploy/livekit-fork/build.sh'), true);
    assert.equal(
      files.includes(
        'deploy/livekit-fork/patches/livekit-ivekit-small-room-hot-path.patch'
      ),
      true
    );
    for (const livekitEgressFile of [
      'components/livekit-egress/infra/ivekit/livekit-egress/README.md',
      'components/livekit-egress/infra/ivekit/livekit-egress/apply-overlay.mjs',
      'components/livekit-egress/infra/ivekit/livekit-egress/build.sh',
      'components/livekit-egress/infra/ivekit/livekit-egress/ivekit_metrics.go',
      'components/livekit-egress/integrations/livekit-egress-v1.13.0/go.mod',
      'components/livekit-egress/integrations/livekit-egress-v1.13.0/policy.go',
      'components/livekit-egress/integrations/livekit-egress-v1.13.0/policy_test.go',
      'components/livekit-egress/infra/k8s/Chart.yaml',
      'components/livekit-egress/infra/k8s/values.yaml',
      'components/livekit-egress/infra/k8s/templates/_helpers.tpl',
      'components/livekit-egress/infra/k8s/templates/livekit-egress-deployment.yaml'
    ]) {
      assert.equal(files.includes(livekitEgressFile), true, livekitEgressFile);
    }
    assert.equal(files.includes('deploy/tinode-fork/apply-overlay.mjs'), true);
    assert.equal(files.includes('deploy/tinode-fork/build.sh'), true);
    assert.equal(files.includes('deploy/tinode-fork/server-hook.go'), true);
    assert.equal(
      files.includes(
        'deploy/tinode-fork/patches/tinode-ivekit-session-fanout-hot-path.patch'
      ),
      true
    );
    assert.equal(files.includes('deploy/rustdesk-server-fork/apply-overlay.mjs'), true);
    assert.equal(files.includes('deploy/rustdesk-server-fork/build.sh'), true);
    assert.equal(files.includes('deploy/rustdesk-server-fork/server-hook.rs'), true);
    assert.equal(
      files.includes(
        'deploy/rustdesk-server-fork/patches/rustdesk-server-ivekit-relay-hot-path.patch'
      ),
      true
    );
    assert.equal(
      files.includes('deploy/rustdesk-server-fork/ivekit-rustdesk-owner-binding.ts'),
      true
    );
    assert.equal(
      files.includes('fork-hooks/rustdesk-server/rustdesk-owner-binding.ts'),
      true
    );
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
      '055_ivekit_contact_center_callbacks.sql',
      '056_ivekit_contact_center_overflow.sql',
      '057_ivekit_voice_action_capabilities.sql',
      '058_ivekit_voice_parking.sql',
      '059_ivekit_provider_governance.sql',
      '060_ivekit_content_intelligence.sql',
      '061_ivekit_file_security.sql',
      '062_tinode_file_delivery_operations.sql',
      '063_livekit_media_quality.sql',
      '064_rustdesk_authorization_codes.sql',
      '065_ivekit_notifications.sql',
      '066_ivekit_audit.sql',
      '067_ivekit_rate_limits.sql',
      '068_ivekit_retention.sql',
      '069_ivekit_runtime_heartbeats.sql',
      '070_ivekit_notification_operations.sql',
      '071_ivekit_notification_health.sql',
      '072_ivekit_notification_events.sql',
      '073_ivekit_integration_webhooks.sql',
      '074_tinode_message_mutation_outbox.sql',
      '075_rustdesk_emergency_fallback.sql',
      '076_rustdesk_evidence_intelligence_reconciliation.sql',
      '077_ivekit_capacity_orchestrator.sql',
      '078_ivekit_cell_leases.sql',
      '079_ivekit_voice_route_snapshot_revision.sql',
      '080_ivekit_interaction_placements.sql',
      '081_ivekit_notification_worker_partition.sql',
      '082_ivekit_capacity_worker_checkpoints.sql',
      '083_ivekit_cell_admission_reservations.sql',
      '084_ivekit_cell_lease_topology.sql',
      '085_ivekit_interaction_placement_handoffs.sql',
      '086_ivekit_recording_manifests.sql',
      '087_livekit_egress_jobs.sql',
      '088_livekit_egress_reconciliation.sql',
      '089_livekit_egress_capacity_metrics.sql',
      '091_ivekit_capacity_scaling_campaigns.sql',
      '092_ivekit_capacity_platform_campaigns.sql'
    ]) assert.equal(files.includes(`database/migrations/${migration}`), true, migration);
    const migrationManifest = JSON.parse(readFileSync(
      join(outputDir, 'service', 'migration-manifest.json'),
      'utf8'
    )) as { migrations: Array<{ file: string; sha256: string }> };
    assert.equal(migrationManifest.migrations.length, 81);
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
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '056_ivekit_contact_center_overflow.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '057_ivekit_voice_action_capabilities.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '058_ivekit_voice_parking.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '059_ivekit_provider_governance.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '060_ivekit_content_intelligence.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '061_ivekit_file_security.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '062_tinode_file_delivery_operations.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '063_livekit_media_quality.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '064_rustdesk_authorization_codes.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '065_ivekit_notifications.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '066_ivekit_audit.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '067_ivekit_rate_limits.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '068_ivekit_retention.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '069_ivekit_runtime_heartbeats.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '070_ivekit_notification_operations.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '071_ivekit_notification_health.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '072_ivekit_notification_events.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '073_ivekit_integration_webhooks.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '074_tinode_message_mutation_outbox.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '075_rustdesk_emergency_fallback.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '076_rustdesk_evidence_intelligence_reconciliation.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '077_ivekit_capacity_orchestrator.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '078_ivekit_cell_leases.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '079_ivekit_voice_route_snapshot_revision.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '080_ivekit_interaction_placements.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '081_ivekit_notification_worker_partition.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '082_ivekit_capacity_worker_checkpoints.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '083_ivekit_cell_admission_reservations.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '084_ivekit_cell_lease_topology.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '085_ivekit_interaction_placement_handoffs.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '086_ivekit_recording_manifests.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '087_livekit_egress_jobs.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '088_livekit_egress_reconciliation.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '089_livekit_egress_capacity_metrics.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '091_ivekit_capacity_scaling_campaigns.sql'), true);
    assert.equal(migrationManifest.migrations.some((entry) => entry.file === '092_ivekit_capacity_platform_campaigns.sql'), true);
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
    assert.doesNotMatch(applicationCompose, /ivekit-(?:opc|service):local/);
    assert.match(applicationCompose, /IVEKIT_SERVICE_IMAGE:\?IVEKIT_SERVICE_IMAGE is required/);
    assert.match(applicationCompose, /CLAMAV_IMAGE:\?CLAMAV_IMAGE immutable digest reference is required/);
    assert.match(applicationCompose, /^  ivekit:/m);
    assert.doesNotMatch(applicationCompose, /^  opc:/m);
    const voiceCompose = readFileSync(join(outputDir, 'service/build-context/docker-compose.voice.yml'), 'utf8');
    assert.match(voiceCompose, /command: \["node", "dist\/ivekit-render-rustpbx-config\.js"\]/);
    assert.doesNotMatch(voiceCompose, /--import|\btsx\b|scripts\/render-rustpbx-config\.ts/);
    const releaseContract = JSON.parse(readFileSync(
      join(outputDir, 'operations', 'release-contract.json'),
      'utf8'
    )) as {
      source_commit: string;
      execution_status: string;
      database: { rollback: string };
      configuration: { release_fingerprint_sha256: string };
    };
    assert.equal(releaseContract.source_commit, testSourceCommit);
    assert.equal(releaseContract.execution_status, 'blocked_build_required');
    assert.equal(releaseContract.database.rollback, 'restore_verified_pre_upgrade_backup_only');
    const stage2Evidence = JSON.parse(readFileSync(
      join(outputDir, 'operations', 'stage2-deployment-evidence.json'),
      'utf8'
    )) as {
      source_commit: string;
      execution_status: string;
      required_migrations: Array<{ file: string }>;
      configuration_template_fingerprints: Record<string, {
        artifacts: Array<{ path: string }>;
      }>;
      release_fingerprint_sha256: string;
      secret_values_embedded: boolean;
      real_environment_validation: string;
    };
    assert.equal(stage2Evidence.source_commit, testSourceCommit);
    assert.equal(stage2Evidence.execution_status, 'blocked_build_required');
    assert.deepEqual(stage2Evidence.required_migrations.map((entry) => entry.file), [
      '061_ivekit_file_security.sql',
      '062_tinode_file_delivery_operations.sql',
      '063_livekit_media_quality.sql'
    ]);
    assert.deepEqual(Object.keys(stage2Evidence.configuration_template_fingerprints), [
      'livekit_turn',
      'livekit_egress',
      'file_security'
    ]);
    const egressFingerprints = stage2Evidence.configuration_template_fingerprints.livekit_egress
      .artifacts.map((entry) => entry.path);
    for (const requiredEgressArtifact of [
      'components/livekit-egress/infra/ivekit/livekit-egress/apply-overlay.mjs',
      'components/livekit-egress/infra/ivekit/livekit-egress/build.sh',
      'components/livekit-egress/integrations/livekit-egress-v1.13.0/policy.go',
      'components/livekit-egress/infra/k8s/values.yaml',
      'components/livekit-egress/infra/k8s/templates/livekit-egress-deployment.yaml'
    ]) {
      assert.equal(egressFingerprints.includes(requiredEgressArtifact), true, requiredEgressArtifact);
    }
    assert.equal(stage2Evidence.release_fingerprint_sha256, releaseContract.configuration.release_fingerprint_sha256);
    assert.equal(stage2Evidence.secret_values_embedded, false);
    assert.equal(stage2Evidence.real_environment_validation, 'not_run');
    const upgradeRunbook = readFileSync(join(outputDir, 'operations', 'upgrade-runbook.md'), 'utf8');
    assert.match(upgradeRunbook, /blocked_build_required/);
    assert.doesNotMatch(upgradeRunbook, /down\s+-v|DROP\s+(?:DATABASE|TABLE)|:latest/i);
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
    const v6Acceptance = JSON.parse(readFileSync(
      join(outputDir, 'acceptance', 'v6-real-template.json'),
      'utf8'
    )) as {
      foundation_version: string;
      source_commit: string;
      generated_at: string;
      groups: Array<{ id: string; status: string; checks: unknown[] }>;
    };
    assert.equal(v6Acceptance.foundation_version, 'V6');
    assert.equal(v6Acceptance.source_commit, testSourceCommit);
    assert.equal(v6Acceptance.generated_at, '2026-07-13T00:00:00.000Z');
    assert.deepEqual(v6Acceptance.groups.map((group) => group.id), [
      'providers',
      'tinode',
      'livekit_turn_egress',
      'rustdesk_windows',
      'voice_pstn',
      'notifications',
      'object_storage',
      'kubernetes'
    ]);
    assert.equal(v6Acceptance.groups.every((group) =>
      group.status === 'not_run' && group.checks.length === 0
    ), true);
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
    assert.equal(files.includes('docs/ivekit-v5-shared-foundation-design.md'), true);
    assert.equal(files.includes('docs/ivekit-v5-stage1-content-intelligence-plan.md'), true);
    assert.equal(files.includes('docs/ivekit-v5-stage1-provider-resilience-plan.md'), true);
    assert.equal(files.includes('docs/ivekit-v5-stage2-im-livekit-file-plan.md'), true);
    assert.equal(files.includes('docs/ivekit-v6-production-closure-design.md'), true);
    assert.equal(files.includes('docs/ivekit-v6-production-closure-plan.md'), true);
    assert.equal(files.includes('docs/ivekit-v6-real-environment-acceptance.md'), true);
    assert.equal(files.includes('acceptance/tools/ivekit-controlled-provider.ts'), true);
    assert.equal(files.includes('acceptance/tools/ivekit-v6-real-acceptance.ts'), true);
    assert.equal(files.includes('deploy/kubernetes/ivekit/templates/tinode-deployment.yaml'), true);
    assert.equal(files.includes('edge/windows/Publish-IveKitRustDeskEvidence.ps1'), true);
    assert.equal(files.includes('edge/rustdesk-1.4.7/ivekit_native_control.rs'), true);
    assert.equal(files.includes('edge/rustdesk-1.4.7/ivekit_native_evidence.rs'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivery validation rejects tampered Voice acceptance assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-delivery-voice-acceptance-'));
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
    const templatePath = join(outputDir, 'acceptance', 'voice-real-template.json');
    const template = JSON.parse(readFileSync(templatePath, 'utf8')) as {
      checks: Record<string, { passed: boolean }>;
    };
    template.checks[VOICE_REQUIRED_ACCEPTANCE_CHECKS[0]].passed = true;
    writeFileSync(templatePath, `${JSON.stringify(template, null, 2)}\n`);
    assert.throws(
      () => validateIveKitDeliveryBundle(outputDir),
      /Voice acceptance template must remain incomplete/
    );

    buildIveKitDeliveryBundle({
      repoRoot,
      outputDir,
      sdkTarball,
      clientDist,
      sourceCommit: testSourceCommit
    });
    const runbookPath = join(outputDir, 'acceptance', 'voice-real-runbook.md');
    writeFileSync(runbookPath, `${readFileSync(runbookPath, 'utf8')}tampered\n`);
    assert.throws(
      () => validateIveKitDeliveryBundle(outputDir),
      /Voice acceptance runbook does not match the validator contract/
    );
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
    'restart.log': 'attachment quality translation expired leases recovered\n',
    'full-chain.log': 'business reference IM media remote voice notification and webhook passed\n'
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
      restart_recovery: { status: 'passed', evidence: ['restart.log'] },
      full_chain: { status: 'passed', evidence: ['full-chain.log'] }
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
      restart_recovery: 'passed',
      full_chain: 'passed'
    });
    assert.equal(accepted.evidence.length, 5);
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
  assert.match(voiceDesign, /call\.send_dtmf.*call\.hold.*call\.unhold.*call\.bridge.*capability_unavailable/s);
  assert.match(voiceDesign, /12\/12.*TCP reconnect.*10 路并发/s);
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
