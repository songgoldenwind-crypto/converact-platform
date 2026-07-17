import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildRustDeskWindowsPackage,
  createRustDeskWindowsPackageConfigFromEnv,
  writeRustDeskWindowsPackage
} from '../scripts/rustdesk-windows-package.js';
import {
  RUSTDESK_WINDOWS_CAPABILITY_OPTIONS,
  createRustDeskWindowsCapabilityPolicy
} from '../scripts/rustdesk-windows-capability-policy.js';

const SOURCE_COMMIT = 'a'.repeat(40);
const INSTALLER_SHA256 = 'b'.repeat(64);
const WINSW_SHA256 = 'c'.repeat(64);
const SERVER_FINGERPRINT = 'sha256:1234567890abcdef';

test('Windows package config requires pinned source and service wrapper artifacts', () => {
  const config = createRustDeskWindowsPackageConfigFromEnv({
    OPC_RUSTDESK_WINDOWS_PACKAGE_DIR: '/tmp/rustdesk-windows-package',
    OPC_RUSTDESK_WINDOWS_PROFILE_FILE: '/tmp/client-profile.json',
    OPC_RUSTDESK_WINDOWS_NETWORK_CONFIG_FILE: '/tmp/network-config.txt',
    OPC_RUSTDESK_WINDOWS_SOURCE_COMMIT: SOURCE_COMMIT,
    OPC_RUSTDESK_WINDOWS_EXPECTED_FINGERPRINT: SERVER_FINGERPRINT,
    OPC_IVEKIT_PLACEMENT_ENABLED: '1',
    OPC_RUSTDESK_WINDOWS_WINSW_URL: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
    OPC_RUSTDESK_WINDOWS_WINSW_SHA256: WINSW_SHA256
  });

  assert.equal(config.sourceCommit, SOURCE_COMMIT);
  assert.equal(config.serviceName, 'IveKitRustDeskEdge');
  assert.equal(config.winSw.version, '2.12.0');
  assert.equal(config.winSw.sha256, WINSW_SHA256);
  assert.equal(config.placementEnabled, true);
  assert.throws(
    () => createRustDeskWindowsPackageConfigFromEnv({
      OPC_RUSTDESK_WINDOWS_PACKAGE_DIR: '/tmp/output',
      OPC_RUSTDESK_WINDOWS_PROFILE_FILE: '/tmp/profile',
      OPC_RUSTDESK_WINDOWS_NETWORK_CONFIG_FILE: '/tmp/config',
      OPC_RUSTDESK_WINDOWS_SOURCE_COMMIT: 'dirty'
    }),
    /source commit must be 40 lowercase hexadecimal characters/
  );
});

test('effective Windows capability policy maps every iveKit scope to exact RustDesk options', () => {
  const policy = createRustDeskWindowsCapabilityPolicy();

  assert.deepEqual(policy.scopes, [
    'view_screen',
    'control_mouse_keyboard',
    'clipboard',
    'transfer_file',
    'record_screen'
  ]);
  assert.deepEqual(policy.scope_option_map.control_mouse_keyboard, ['enable-keyboard']);
  assert.deepEqual(policy.scope_option_map.clipboard, ['enable-clipboard', 'disable-clipboard']);
  assert.deepEqual(policy.scope_option_map.transfer_file, ['enable-file-transfer', 'enable-file-copy-paste']);
  assert.deepEqual(policy.scope_option_map.record_screen, ['enable-record-session', 'allow-auto-record-incoming']);
  assert.equal(policy.options['approve-mode'], 'click');
  assert.equal(policy.options['access-mode'], 'custom');
  assert.equal(policy.options['enable-keyboard'], 'Y');
  assert.equal(policy.options['enable-clipboard'], 'Y');
  assert.equal(policy.options['enable-file-transfer'], 'Y');
  assert.equal(policy.options['enable-record-session'], 'Y');
  assert.equal(policy.options['allow-auto-record-incoming'], 'N');
  assert.equal(policy.options['allow-remote-config-modification'], 'N');
  assert.deepEqual(Object.keys(policy.options).sort(), [...RUSTDESK_WINDOWS_CAPABILITY_OPTIONS].sort());
});

test('Windows package binds installer, network config, companion, policy, service wrapper, and commit hashes', () => {
  const fixture = createFixture();
  const built = buildRustDeskWindowsPackage(fixture.config, {
    profile: fixture.profile,
    networkConfig: fixture.networkConfig,
    deploymentScript: fixture.deploymentScript,
    serviceTemplate: fixture.serviceTemplate,
    edgeSources: fixture.edgeSources,
    generatedAt: new Date('2026-07-15T03:00:00.000Z')
  });

  assert.equal(built.manifest.schema_version, 1);
  assert.equal(built.manifest.source_commit, SOURCE_COMMIT);
  assert.equal(built.manifest.rustdesk.client_version, '1.4.7');
  assert.equal(built.manifest.rustdesk.server_version, '1.1.15');
  assert.equal(built.manifest.rustdesk.installer.sha256, INSTALLER_SHA256);
  assert.equal(
    built.manifest.rustdesk.installer.native_control_protocol,
    'ivekit-rustdesk-native-control-v2'
  );
  assert.equal(
    built.manifest.rustdesk.installer.native_evidence_protocol,
    'rustdesk-native-evidence-v1'
  );
  assert.equal(built.manifest.rustdesk.server_key_fingerprint, SERVER_FINGERPRINT);
  assert.equal(
    built.manifest.rustdesk.network_config.sha256,
    sha256(`${fixture.networkConfig}\n`)
  );
  assert.equal(built.manifest.companion.service_name, 'IveKitRustDeskEdge');
  assert.equal(built.manifest.companion.service_wrapper.sha256, WINSW_SHA256);
  assert.equal(built.manifest.companion.package_version, 6);
  assert.equal(
    built.manifest.companion.native_session_control.protocol,
    'ivekit-rustdesk-native-control-v2'
  );
  assert.equal(built.manifest.placement.enabled, true);
  assert.equal(built.manifest.companion.native_session_control.owner_epoch_fence, 'durable');
  assert.equal(built.manifest.companion.native_session_control.arbitrary_hook, 'forbidden');
  assert.equal(built.manifest.companion.native_evidence.event_contract, 'rustdesk-native-evidence-v1');
  assert.equal(
    built.manifest.companion.native_evidence.producer_path,
    'custom-rustdesk/src/ivekit_native_evidence.rs'
  );
  assert.equal(
    built.manifest.companion.native_evidence.producer_mode,
    'native_allowlist_scanner_with_device_context_correlation'
  );
  assert.equal(built.manifest.companion.native_evidence.secure_file_pipeline, 'required');
  assert.match(built.manifest.companion.edge_package_sha256, /^[a-f0-9]{64}$/);
  assert.equal(built.manifest.companion.device_token.argument_transport, 'forbidden');
  assert.equal(built.manifest.companion.device_token.storage, 'acl_file');
  assert.equal(built.manifest.rollback.strategy, 'restore_previous_binary_options_and_service');
  assert.deepEqual(
    built.manifest.package_files.map((file) => file.path),
    [...built.files.keys()].filter((path) => path !== 'manifest.json').sort()
  );
  for (const file of built.manifest.package_files) {
    assert.equal(file.sha256, sha256(built.files.get(file.path) || ''));
  }
  assert.doesNotMatch(JSON.stringify(built.manifest), /api[_-]?key|password|private[_-]?key|bearer|token_value/i);
});

test('Windows package writes a secret-free deterministic handoff with executable contracts', () => {
  const fixture = createFixture();
  const result = writeRustDeskWindowsPackage(fixture.config, {
    profile: fixture.profile,
    networkConfig: fixture.networkConfig,
    edgeSources: fixture.edgeSources,
    generatedAt: new Date('2026-07-15T03:00:00.000Z')
  });

  const manifest = JSON.parse(readFileSync(join(fixture.config.outputDir, 'manifest.json'), 'utf8'));
  const script = readFileSync(join(fixture.config.outputDir, 'Deploy-IveKitRustDesk.ps1'), 'utf8');
  const service = readFileSync(join(fixture.config.outputDir, 'IveKitRustDeskEdge.xml.template'), 'utf8');
  assert.equal(result.files, manifest.package_files.length + 1);
  assert.equal(result.edgePackageSha256, manifest.companion.edge_package_sha256);
  assert.match(script, /ValidateSet\('validate', 'install', 'repair', 'uninstall'\)/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /--silent-install/);
  assert.match(script, /--config/);
  assert.match(script, /--get-id/);
  assert.match(script, /--option/);
  assert.match(script, /Get-FileHash/);
  assert.match(script, /icacls/);
  assert.match(script, /rollback-state\.json/);
  assert.match(script, /Restore-IveKitRollback/);
  assert.match(service, /<serviceaccount>\s*<username>LocalSystem<\/username>\s*<\/serviceaccount>/);
  assert.match(service, /OPC_RUSTDESK_EDGE_DEVICE_TOKEN_FILE/);
  assert.match(service, /OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR/);
  assert.match(service, /OPC_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR/);
  assert.match(service, /OPC_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR/);
  assert.match(service, /OPC_RUSTDESK_EDGE_EVIDENCE_SPOOL_DIR/);
  assert.match(service, /OPC_RUSTDESK_NATIVE_EVIDENCE_EVENT_DIR/);
  assert.match(service, /OPC_RUSTDESK_NATIVE_EVIDENCE_CANDIDATE_DIR/);
  assert.match(service, /OPC_RUSTDESK_NATIVE_EVIDENCE_SPOOL_DIR/);
  assert.match(service, /OPC_RUSTDESK_NATIVE_FILE_ROOTS_JSON/);
  assert.match(service, /OPC_RUSTDESK_NATIVE_RECORDING_ROOTS_JSON/);
  assert.match(script, /native-evidence-roots-v1\.txt/);
  assert.match(script, /native-evidence\\candidates/);
  assert.match(
    readFileSync(join(fixture.config.outputDir, 'edge/windows/Publish-IveKitRustDeskEvidence.ps1'), 'utf8'),
    /FileMode\]::CreateNew/
  );
  assert.match(service, /OPC_RUSTDESK_PRECISE_DISCONNECT_SCRIPT/);
  assert.match(service, /OPC_RUSTDESK_SESSION_REGISTRY_FILE/);
  assert.match(service, /OPC_RUSTDESK_NATIVE_CONTROL_PIPE/);
  assert.match(service, /OPC_RUSTDESK_EDGE_CLIENT_VERSION.*1\.4\.7/);
  assert.doesNotMatch(readFileSync(join(fixture.config.outputDir, 'README.md'), 'utf8'), /passed.*physical/i);
});

test('Windows package rejects drift, unsafe config text, and incomplete profile artifacts', () => {
  const fixture = createFixture();
  assert.throws(
    () => buildRustDeskWindowsPackage(fixture.config, {
      ...fixture.inputs,
      profile: { ...fixture.profile, client_version: '1.4.6' }
    }),
    /client version must equal 1\.4\.7/
  );
  assert.throws(
    () => buildRustDeskWindowsPackage(fixture.config, {
      ...fixture.inputs,
      profile: {
        ...fixture.profile,
        targets: [{
          platform: 'windows',
          architecture: 'x86_64',
          install_source: { state: 'not_configured' },
          protocol_handler: { supported: true, user_initiated_only: true }
        }]
      }
    }),
    /Windows x86_64 installer is not configured/
  );
  assert.throws(
    () => buildRustDeskWindowsPackage(fixture.config, {
      ...fixture.inputs,
      networkConfig: 'password=secret'
    }),
    /network config contains a forbidden secret marker/
  );
  assert.throws(
    () => buildRustDeskWindowsPackage(fixture.config, {
      ...fixture.inputs,
      profile: { ...fixture.profile, server_key_fingerprint: 'sha256:ffffffffffffffff' }
    }),
    /server key fingerprint does not match package pin/
  );
  assert.throws(
    () => buildRustDeskWindowsPackage(fixture.config, {
      ...fixture.inputs,
      profile: {
        ...fixture.profile,
        targets: [{
          ...fixture.profile.targets[0],
          install_source: {
            ...fixture.profile.targets[0].install_source,
            native_control_protocol: undefined
          }
        }]
      }
    }),
    /installer must include an ivekit native control protocol/
  );
  assert.throws(
    () => buildRustDeskWindowsPackage(fixture.config, {
      ...fixture.inputs,
      profile: {
        ...fixture.profile,
        targets: [{
          ...fixture.profile.targets[0],
          install_source: {
            ...fixture.profile.targets[0].install_source,
            native_control_protocol: 'ivekit-rustdesk-native-control-v1'
          }
        }]
      }
    }),
    /placement requires ivekit-rustdesk-native-control-v2/
  );
  assert.throws(
    () => buildRustDeskWindowsPackage(fixture.config, {
      ...fixture.inputs,
      profile: {
        ...fixture.profile,
        targets: [{
          ...fixture.profile.targets[0],
          install_source: {
            ...fixture.profile.targets[0].install_source,
            native_evidence_protocol: undefined
          }
        }]
      }
    }),
    /installer must include rustdesk-native-evidence-v1/
  );
});

test('Windows package emits syntax-valid JavaScript from the real companion sources', () => {
  const fixture = createFixture();
  writeRustDeskWindowsPackage(fixture.config, {
    profile: fixture.profile,
    networkConfig: fixture.networkConfig,
    generatedAt: new Date('2026-07-15T03:00:00.000Z')
  });

  for (const file of [
    'rustdesk-edge-agent.js',
    'rustdesk-edge-command.js',
    'rustdesk-edge-pending-store.js',
    'rustdesk-owner-epoch-fence.js',
    'rustdesk-edge-observation-contract.js',
    'rustdesk-observation-spool.js',
    'rustdesk-observation-bridge.js',
    'rustdesk-evidence-uploader.js',
    'rustdesk-native-evidence-correlator.js',
    'rustdesk-native-evidence-policy.js',
    'rustdesk-native-evidence-watcher.js'
  ]) {
    execFileSync(process.execPath, ['--check', join(fixture.config.outputDir, 'edge', file)], {
      stdio: 'pipe'
    });
  }
});

test('Windows package command, environment samples, and Windows AST validation CI are wired', () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  const rootEnv = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
  const standaloneEnv = readFileSync(join(process.cwd(), 'infra/ivekit/env.example'), 'utf8');
  const workflow = readFileSync(
    join(process.cwd(), '.github/workflows/ivekit-rustdesk-windows-ci.yml'),
    'utf8'
  );

  assert.equal(
    packageJson.scripts['rustdesk:windows-package'],
    'node --import tsx scripts/rustdesk-windows-package.ts'
  );
  for (const marker of [
    'OPC_RUSTDESK_WINDOWS_PACKAGE_DIR=',
    'OPC_RUSTDESK_WINDOWS_NETWORK_CONFIG_FILE=',
    'OPC_RUSTDESK_WINDOWS_SOURCE_COMMIT=',
    'OPC_RUSTDESK_WINDOWS_WINSW_SHA256='
  ]) {
    assert.match(rootEnv, new RegExp(marker));
    assert.match(standaloneEnv, new RegExp(marker));
  }
  assert.match(rootEnv, /OPC_RUSTDESK_EDGE_DEVICE_TOKEN_FILE=/);
  assert.match(rootEnv, /OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR=/);
  assert.match(rootEnv, /OPC_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR=/);
  assert.match(rootEnv, /OPC_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR=/);
  assert.match(rootEnv, /OPC_RUSTDESK_EDGE_EVIDENCE_SPOOL_DIR=/);
  assert.match(rootEnv, /OPC_RUSTDESK_EDGE_EVIDENCE_DEAD_LETTER_RETENTION_MS=604800000/);
  assert.match(standaloneEnv, /OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR=/);
  assert.match(standaloneEnv, /OPC_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR=/);
  assert.match(standaloneEnv, /OPC_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR=/);
  assert.match(standaloneEnv, /OPC_RUSTDESK_EDGE_EVIDENCE_SPOOL_DIR=/);
  assert.match(standaloneEnv, /OPC_RUSTDESK_EDGE_EVIDENCE_DEAD_LETTER_RETENTION_MS=604800000/);
  assert.match(
    readFileSync(join(process.cwd(), 'scripts/rustdesk-windows/IveKitRustDeskEdge.xml.template'), 'utf8'),
    /OPC_RUSTDESK_EDGE_EVIDENCE_DEAD_LETTER_RETENTION_MS/
  );
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /System\.Management\.Automation\.Language\.Parser/);
  assert.match(workflow, /-Mode validate/);
  assert.match(workflow, /validate mode wrote to the install root/);
  assert.match(workflow, /integrations\/rustdesk-1\.4\.7\/\*\*/);
  assert.match(workflow, /repository: rustdesk\/rustdesk/);
  assert.match(workflow, /ref: 1\.4\.7/);
  assert.match(workflow, /apply-overlay\.mjs/);
  assert.match(workflow, /cargo check/);
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-rustdesk-windows-'));
  const outputDir = join(root, 'package');
  const profileFile = join(root, 'client-profile.json');
  const networkConfigFile = join(root, 'network-config.txt');
  const profile = {
    schema_version: 1,
    ready: true,
    client_version: '1.4.7',
    server_version: '1.1.15',
    server_key_fingerprint: SERVER_FINGERPRINT,
    manual_fields: {
      id_server: 'rustdesk.example.com:21116',
      relay_server: 'rustdesk.example.com:21117',
      api_server: '',
      key: 'public-key'
    },
    targets: [{
      platform: 'windows',
      architecture: 'x86_64',
      install_source: {
        state: 'configured',
        url: 'https://github.com/acme/ivekit-rustdesk/releases/download/1.4.7/rustdesk-1.4.7-ivekit1-x86_64.exe',
        filename: 'rustdesk-1.4.7-ivekit1-x86_64.exe',
        sha256: INSTALLER_SHA256,
        native_control_protocol: 'ivekit-rustdesk-native-control-v2',
        native_evidence_protocol: 'rustdesk-native-evidence-v1'
      },
      protocol_handler: { supported: true, user_initiated_only: true }
    }]
  };
  const networkConfig = 'host=rustdesk.example.com,key=public-material';
  writeFileSync(profileFile, JSON.stringify(profile), 'utf8');
  writeFileSync(networkConfigFile, networkConfig, 'utf8');
  const config = {
    outputDir,
    profileFile,
    networkConfigFile,
    sourceCommit: SOURCE_COMMIT,
    expectedServerKeyFingerprint: SERVER_FINGERPRINT,
    serviceName: 'IveKitRustDeskEdge',
    placementEnabled: true,
    winSw: {
      version: '2.12.0',
      url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
      filename: 'IveKitRustDeskEdge.exe',
      sha256: WINSW_SHA256
    }
  } as const;
  const edgeSources = new Map([
    ['rustdesk-edge-agent.ts', 'import { run } from "./rustdesk-edge-command.js";\nexport const value: string = run();\n'],
    ['rustdesk-edge-command.ts', 'export function run(): string { return "ok"; }\n'],
    ['rustdesk-edge-pending-store.ts', 'export const schema: number = 1;\n'],
    ['rustdesk-owner-epoch-fence.ts', 'export const epochFenceSchema: number = 1;\n'],
    ['rustdesk-edge-observation-contract.ts', 'export const observationSchema: number = 1;\n'],
    ['rustdesk-observation-spool.ts', 'export const spoolSchema: number = 1;\n'],
    ['rustdesk-observation-bridge.ts', 'export const bridgeSchema: number = 1;\n'],
    ['rustdesk-evidence-uploader.ts', 'export const evidenceUploaderSchema: number = 1;\n'],
    ['rustdesk-native-evidence-correlator.ts', 'export const nativeEvidenceCorrelatorSchema: number = 1;\n'],
    ['rustdesk-native-evidence-policy.ts', 'export const nativeEvidencePolicySchema: number = 1;\n'],
    ['rustdesk-native-evidence-watcher.ts', 'export const nativeEvidenceWatcherSchema: number = 1;\n']
  ]);
  const deploymentScript = '# Deploy-IveKitRustDesk.ps1 fixture\n';
  const serviceTemplate = '<service></service>\n';
  const inputs = {
    profile,
    networkConfig,
    deploymentScript,
    serviceTemplate,
    edgeSources,
    generatedAt: new Date('2026-07-15T03:00:00.000Z')
  };
  return { config, profile, networkConfig, deploymentScript, serviceTemplate, edgeSources, inputs };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
