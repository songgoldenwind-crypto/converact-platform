import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { createRustDeskWindowsCapabilityPolicy } from './rustdesk-windows-capability-policy.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLIENT_VERSION = '1.4.9' as const;
const SERVER_VERSION = '1.1.16' as const;
type NativeControlProtocol =
  | 'ivekit-rustdesk-native-control-v1'
  | 'ivekit-rustdesk-native-control-v2';
const EDGE_SOURCE_NAMES = [
  'rustdesk-edge-agent.ts',
  'rustdesk-edge-command.ts',
  'rustdesk-edge-pending-store.ts',
  'rustdesk-owner-epoch-fence.ts',
  'rustdesk-edge-observation-contract.ts',
  'rustdesk-observation-spool.ts',
  'rustdesk-observation-bridge.ts',
  'rustdesk-evidence-uploader.ts',
  'rustdesk-native-evidence-correlator.ts',
  'rustdesk-native-evidence-policy.ts',
  'rustdesk-native-evidence-watcher.ts'
] as const;
const EDGE_ASSET_NAMES = [
  'adapters/windows-disconnect.ps1',
  'adapters/windows-restart.ps1',
  'windows/Invoke-IveKitRustDeskSessionDisconnect.ps1',
  'windows/Publish-IveKitRustDeskEvidence.ps1',
  'windows/Resolve-IveKitRustDeskSession.ps1'
] as const;

export interface RustDeskWindowsPackageConfig {
  readonly outputDir: string;
  readonly profileFile: string;
  readonly networkConfigFile: string;
  readonly sourceCommit: string;
  readonly expectedServerKeyFingerprint: string;
  readonly serviceName: string;
  readonly placementEnabled: boolean;
  readonly winSw: {
    readonly version: string;
    readonly url: string;
    readonly filename: string;
    readonly sha256: string;
  };
}

export interface RustDeskWindowsPackageBuildInputs {
  profile?: unknown;
  networkConfig?: string;
  deploymentScript?: string;
  serviceTemplate?: string;
  edgeSources?: ReadonlyMap<string, string>;
  edgeAssets?: ReadonlyMap<string, string>;
  generatedAt?: Date;
}

interface PackageFileRecord {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface RustDeskWindowsPackageManifest {
  schema_version: 1;
  package_type: 'ivekit-rustdesk-windows-x86_64';
  source_commit: string;
  generated_at: string;
  secret_free: true;
  rustdesk: {
    client_version: typeof CLIENT_VERSION;
    server_version: typeof SERVER_VERSION;
    server_key_fingerprint: string;
    installer: {
      url: string;
      filename: string;
      sha256: string;
      native_control_protocol: NativeControlProtocol;
      native_evidence_protocol: 'rustdesk-native-evidence-v1';
      authenticode: {
        required: true;
        publisher_subject_contains: 'RustDesk';
      };
    };
    network_config: {
      path: 'rustdesk-network-config.txt';
      sha256: string;
      apply: 'rustdesk_cli_config';
    };
    capability_policy: {
      path: 'effective-capability-policy.json';
      sha256: string;
      drift: 'fail_closed';
    };
  };
  placement: {
    enabled: boolean;
    owner_epoch_required: boolean;
  };
  companion: {
    package_version: 6;
    service_name: string;
    service_account: 'LocalSystem';
    minimum_node_version: '23.0.0';
    edge_package_sha256: string;
    service_wrapper: {
      version: string;
      url: string;
      filename: string;
      sha256: string;
    };
    device_token: {
      storage: 'acl_file';
      argument_transport: 'forbidden';
      registry_storage: 'forbidden';
      log_storage: 'forbidden';
    };
    native_session_control: {
      protocol: NativeControlProtocol;
      transport: 'windows_named_pipe';
      registry: 'acl_file';
      owner_epoch_fence: 'durable';
      precise_only: true;
      arbitrary_hook: 'forbidden';
    };
    native_evidence: {
      event_contract: 'rustdesk-native-evidence-v1';
      producer_path: 'custom-rustdesk/src/ivekit_native_evidence.rs';
      producer_mode: 'native_allowlist_scanner_with_device_context_correlation';
      producer_acl: 'explicit_windows_principal';
      path_allowlist: 'required';
      stable_copy_gate: 'required';
      secure_file_pipeline: 'required';
      raw_clipboard_or_keystrokes: 'forbidden';
    };
  };
  rollback: {
    state_file: 'rollback-state.json';
    strategy: 'restore_previous_binary_options_and_service';
    automatic_on_install_failure: true;
  };
  package_files: PackageFileRecord[];
  real_windows_acceptance: 'not_run';
}

export interface RustDeskWindowsPackageBuild {
  manifest: RustDeskWindowsPackageManifest;
  files: Map<string, string>;
}

export interface RustDeskWindowsPackageWriteResult {
  outputDir: string;
  files: number;
  edgePackageSha256: string;
  sourceCommit: string;
}

export function createRustDeskWindowsPackageConfigFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskWindowsPackageConfig {
  const outputDir = requiredString(
    env.OPC_RUSTDESK_WINDOWS_PACKAGE_DIR,
    'OPC_RUSTDESK_WINDOWS_PACKAGE_DIR is required'
  );
  const profileFile = requiredString(
    env.OPC_RUSTDESK_WINDOWS_PROFILE_FILE,
    'OPC_RUSTDESK_WINDOWS_PROFILE_FILE is required'
  );
  const networkConfigFile = requiredString(
    env.OPC_RUSTDESK_WINDOWS_NETWORK_CONFIG_FILE,
    'OPC_RUSTDESK_WINDOWS_NETWORK_CONFIG_FILE is required'
  );
  const sourceCommit = requiredString(
    env.OPC_RUSTDESK_WINDOWS_SOURCE_COMMIT,
    'OPC_RUSTDESK_WINDOWS_SOURCE_COMMIT is required'
  ).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error('RustDesk Windows package source commit must be 40 lowercase hexadecimal characters');
  }
  const expectedServerKeyFingerprint = requiredString(
    env.OPC_RUSTDESK_WINDOWS_EXPECTED_FINGERPRINT,
    'OPC_RUSTDESK_WINDOWS_EXPECTED_FINGERPRINT is required'
  ).toLowerCase();
  if (!/^sha256:[a-f0-9]{16}$/.test(expectedServerKeyFingerprint)) {
    throw new Error('RustDesk Windows package expected server key fingerprint is invalid');
  }
  const serviceName = String(env.OPC_RUSTDESK_WINDOWS_SERVICE_NAME || 'IveKitRustDeskEdge').trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]{2,63}$/.test(serviceName)) {
    throw new Error('RustDesk Windows package service name is invalid');
  }
  const version = String(env.OPC_RUSTDESK_WINDOWS_WINSW_VERSION || '2.12.0').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('OPC_RUSTDESK_WINDOWS_WINSW_VERSION must be a semantic version');
  }
  const url = safeHttpsUrl(
    env.OPC_RUSTDESK_WINDOWS_WINSW_URL,
    'OPC_RUSTDESK_WINDOWS_WINSW_URL'
  );
  if (!url.pathname.includes(`/v${version}/`) || basename(url.pathname) !== 'WinSW-x64.exe') {
    throw new Error('RustDesk Windows WinSW URL must identify the pinned x64 release');
  }
  const sha256 = sha256Pin(
    env.OPC_RUSTDESK_WINDOWS_WINSW_SHA256,
    'OPC_RUSTDESK_WINDOWS_WINSW_SHA256'
  );
  const placementEnabled = booleanFlag(
    env.OPC_IVEKIT_PLACEMENT_ENABLED,
    false,
    'OPC_IVEKIT_PLACEMENT_ENABLED'
  );

  return {
    outputDir,
    profileFile,
    networkConfigFile,
    sourceCommit,
    expectedServerKeyFingerprint,
    serviceName,
    placementEnabled,
    winSw: {
      version,
      url: url.toString(),
      filename: `${serviceName}.exe`,
      sha256
    }
  };
}

export function buildRustDeskWindowsPackage(
  config: RustDeskWindowsPackageConfig,
  provided: RustDeskWindowsPackageBuildInputs = {}
): RustDeskWindowsPackageBuild {
  validateConfig(config);
  const inputs = resolveBuildInputs(config, provided);
  const profile = windowsProfile(
    inputs.profile,
    config.expectedServerKeyFingerprint,
    config.placementEnabled
  );
  const networkConfig = normalizeNetworkConfig(inputs.networkConfig);
  const generatedAt = inputs.generatedAt || new Date();
  if (Number.isNaN(generatedAt.getTime())) {
    throw new Error('RustDesk Windows package generation clock is invalid');
  }

  const files = new Map<string, string>();
  const policy = `${JSON.stringify(createRustDeskWindowsCapabilityPolicy(), null, 2)}\n`;
  const normalizedNetworkConfig = `${networkConfig}\n`;
  files.set('Deploy-IveKitRustDesk.ps1', normalizeText(inputs.deploymentScript));
  files.set(`${config.serviceName}.xml.template`, normalizeText(inputs.serviceTemplate));
  files.set('rustdesk-network-config.txt', normalizedNetworkConfig);
  files.set('effective-capability-policy.json', policy);

  const edgeRecords: PackageFileRecord[] = [];
  for (const sourceName of EDGE_SOURCE_NAMES) {
    const source = inputs.edgeSources.get(sourceName);
    if (source === undefined) throw new Error(`RustDesk Windows edge source is missing: ${sourceName}`);
    const outputName = `edge/${sourceName.replace(/\.ts$/, '.js')}`;
    const output = transpileEdgeSource(source, sourceName);
    files.set(outputName, output);
    edgeRecords.push(packageFileRecord(outputName, output));
  }
  for (const assetName of EDGE_ASSET_NAMES) {
    const source = inputs.edgeAssets.get(assetName);
    if (source === undefined) throw new Error(`RustDesk Windows edge asset is missing: ${assetName}`);
    const outputName = `edge/${assetName}`;
    const output = normalizeText(source);
    files.set(outputName, output);
    edgeRecords.push(packageFileRecord(outputName, output));
  }
  edgeRecords.sort((left, right) => compareAscii(left.path, right.path));
  const edgePackageSha256 = sha256(JSON.stringify(edgeRecords));
  files.set('README.md', renderReadme(config, profile.installer.filename));

  const packageFiles = [...files.entries()]
    .map(([path, content]) => packageFileRecord(path, content))
    .sort((left, right) => compareAscii(left.path, right.path));
  const manifest: RustDeskWindowsPackageManifest = {
    schema_version: 1,
    package_type: 'ivekit-rustdesk-windows-x86_64',
    source_commit: config.sourceCommit,
    generated_at: generatedAt.toISOString(),
    secret_free: true,
    rustdesk: {
      client_version: CLIENT_VERSION,
      server_version: SERVER_VERSION,
      server_key_fingerprint: config.expectedServerKeyFingerprint,
      installer: {
        url: profile.installer.url,
        filename: profile.installer.filename,
        sha256: profile.installer.sha256,
        native_control_protocol: profile.installer.native_control_protocol,
        native_evidence_protocol: profile.installer.native_evidence_protocol,
        authenticode: {
          required: true,
          publisher_subject_contains: 'RustDesk'
        }
      },
      network_config: {
        path: 'rustdesk-network-config.txt',
        sha256: sha256(normalizedNetworkConfig),
        apply: 'rustdesk_cli_config'
      },
      capability_policy: {
        path: 'effective-capability-policy.json',
        sha256: sha256(policy),
        drift: 'fail_closed'
      }
    },
    placement: {
      enabled: config.placementEnabled,
      owner_epoch_required: config.placementEnabled
    },
    companion: {
      package_version: 6,
      service_name: config.serviceName,
      service_account: 'LocalSystem',
      minimum_node_version: '23.0.0',
      edge_package_sha256: edgePackageSha256,
      service_wrapper: {
        version: config.winSw.version,
        url: config.winSw.url,
        filename: config.winSw.filename,
        sha256: config.winSw.sha256
      },
      device_token: {
        storage: 'acl_file',
        argument_transport: 'forbidden',
        registry_storage: 'forbidden',
        log_storage: 'forbidden'
      },
      native_session_control: {
        protocol: profile.installer.native_control_protocol,
        transport: 'windows_named_pipe',
        registry: 'acl_file',
        owner_epoch_fence: 'durable',
        precise_only: true,
        arbitrary_hook: 'forbidden'
      },
      native_evidence: {
        event_contract: 'rustdesk-native-evidence-v1',
        producer_path: 'custom-rustdesk/src/ivekit_native_evidence.rs',
        producer_mode: 'native_allowlist_scanner_with_device_context_correlation',
        producer_acl: 'explicit_windows_principal',
        path_allowlist: 'required',
        stable_copy_gate: 'required',
        secure_file_pipeline: 'required',
        raw_clipboard_or_keystrokes: 'forbidden'
      }
    },
    rollback: {
      state_file: 'rollback-state.json',
      strategy: 'restore_previous_binary_options_and_service',
      automatic_on_install_failure: true
    },
    package_files: packageFiles,
    real_windows_acceptance: 'not_run'
  };
  files.set('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, files };
}

export function writeRustDeskWindowsPackage(
  config: RustDeskWindowsPackageConfig,
  inputs: RustDeskWindowsPackageBuildInputs = {}
): RustDeskWindowsPackageWriteResult {
  assertWritableOutputDirectory(config.outputDir);
  const built = buildRustDeskWindowsPackage(config, inputs);
  mkdirSync(config.outputDir, { recursive: true });
  for (const [relativePath, content] of built.files) {
    const outputFile = join(config.outputDir, relativePath);
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, content, 'utf8');
  }
  return {
    outputDir: config.outputDir,
    files: built.files.size,
    edgePackageSha256: built.manifest.companion.edge_package_sha256,
    sourceCommit: built.manifest.source_commit
  };
}

function resolveBuildInputs(
  config: RustDeskWindowsPackageConfig,
  provided: RustDeskWindowsPackageBuildInputs
): Required<RustDeskWindowsPackageBuildInputs> {
  const edgeSources = provided.edgeSources || new Map(
    EDGE_SOURCE_NAMES.map((name) => [name, readFileSync(join(SCRIPT_DIR, name), 'utf8')])
  );
  const edgeAssets = provided.edgeAssets || new Map([
    ['adapters/windows-disconnect.ps1', readFileSync(
      join(SCRIPT_DIR, 'rustdesk-edge-adapters', 'windows-disconnect.ps1'),
      'utf8'
    )],
    ['adapters/windows-restart.ps1', readFileSync(
      join(SCRIPT_DIR, 'rustdesk-edge-adapters', 'windows-restart.ps1'),
      'utf8'
    )],
    ['windows/Invoke-IveKitRustDeskSessionDisconnect.ps1', readFileSync(
      join(SCRIPT_DIR, 'rustdesk-windows', 'Invoke-IveKitRustDeskSessionDisconnect.ps1'),
      'utf8'
    )],
    ['windows/Publish-IveKitRustDeskEvidence.ps1', readFileSync(
      join(SCRIPT_DIR, 'rustdesk-windows', 'Publish-IveKitRustDeskEvidence.ps1'),
      'utf8'
    )],
    ['windows/Resolve-IveKitRustDeskSession.ps1', readFileSync(
      join(SCRIPT_DIR, 'rustdesk-windows', 'Resolve-IveKitRustDeskSession.ps1'),
      'utf8'
    )]
  ]);
  return {
    profile: provided.profile ?? JSON.parse(readFileSync(config.profileFile, 'utf8')),
    networkConfig: provided.networkConfig ?? readFileSync(config.networkConfigFile, 'utf8'),
    deploymentScript: provided.deploymentScript ?? readFileSync(
      join(SCRIPT_DIR, 'rustdesk-windows', 'Deploy-IveKitRustDesk.ps1'),
      'utf8'
    ),
    serviceTemplate: provided.serviceTemplate ?? readFileSync(
      join(SCRIPT_DIR, 'rustdesk-windows', 'IveKitRustDeskEdge.xml.template'),
      'utf8'
    ),
    edgeSources,
    edgeAssets,
    generatedAt: provided.generatedAt || new Date()
  };
}

function windowsProfile(
  value: unknown,
  expectedFingerprint: string,
  placementEnabled: boolean
): {
  installer: {
    url: string;
    filename: string;
    sha256: string;
    native_control_protocol: NativeControlProtocol;
    native_evidence_protocol: 'rustdesk-native-evidence-v1';
  };
} {
  const profile = objectValue(value, 'RustDesk Windows client profile');
  if (profile.ready !== true) throw new Error('RustDesk Windows client profile is not ready');
  if (profile.client_version !== CLIENT_VERSION) {
    throw new Error(`RustDesk Windows client version must equal ${CLIENT_VERSION}`);
  }
  if (profile.server_version !== SERVER_VERSION) {
    throw new Error(`RustDesk Windows server version must equal ${SERVER_VERSION}`);
  }
  const fingerprint = String(profile.server_key_fingerprint || '').trim().toLowerCase();
  if (fingerprint !== expectedFingerprint) {
    throw new Error('RustDesk Windows server key fingerprint does not match package pin');
  }
  const targets = Array.isArray(profile.targets) ? profile.targets : [];
  const target = targets
    .map((entry) => objectValue(entry, 'RustDesk Windows client target'))
    .find((entry) => entry.platform === 'windows' && entry.architecture === 'x86_64');
  if (!target) throw new Error('RustDesk Windows x86_64 target is missing');
  const source = objectValue(target.install_source, 'RustDesk Windows install source');
  if (source.state !== 'configured') {
    throw new Error('RustDesk Windows x86_64 installer is not configured');
  }
  if (
    source.native_control_protocol !== 'ivekit-rustdesk-native-control-v1' &&
    source.native_control_protocol !== 'ivekit-rustdesk-native-control-v2'
  ) {
    throw new Error('RustDesk Windows installer must include an ivekit native control protocol');
  }
  if (
    placementEnabled &&
    source.native_control_protocol !== 'ivekit-rustdesk-native-control-v2'
  ) {
    throw new Error('RustDesk Windows placement requires ivekit-rustdesk-native-control-v2');
  }
  if (source.native_evidence_protocol !== 'rustdesk-native-evidence-v1') {
    throw new Error('RustDesk Windows installer must include rustdesk-native-evidence-v1');
  }
  const url = safeHttpsUrl(source.url, 'RustDesk Windows installer URL');
  const filename = requiredString(source.filename, 'RustDesk Windows installer filename is required');
  if (
    basename(url.pathname) !== filename ||
    !/^rustdesk-1\.4\.9-ivekit[A-Za-z0-9.-]*-x86_64\.exe$/.test(filename)
  ) {
    throw new Error('RustDesk Windows installer identity is invalid');
  }
  if (!url.pathname.includes(`/download/${CLIENT_VERSION}/`)) {
    throw new Error('RustDesk Windows installer URL does not match the pinned release');
  }
  return {
    installer: {
      url: url.toString(),
      filename,
      sha256: sha256Pin(source.sha256, 'RustDesk Windows installer sha256'),
      native_control_protocol: source.native_control_protocol,
      native_evidence_protocol: 'rustdesk-native-evidence-v1'
    }
  };
}

function normalizeNetworkConfig(value: unknown): string {
  const config = requiredString(value, 'RustDesk Windows network config is required');
  if (config.length > 8_192 || /[\u0000-\u001f\u007f]/.test(config)) {
    throw new Error('RustDesk Windows network config must be one printable line');
  }
  if (/(?:^|[,;\s])(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|bearer)\s*[:=]/i.test(config)) {
    throw new Error('RustDesk Windows network config contains a forbidden secret marker');
  }
  return config;
}

function transpileEdgeSource(source: string, sourceName: string): string {
  const result = ts.transpileModule(source, {
    fileName: sourceName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      verbatimModuleSyntax: true,
      sourceMap: false,
      inlineSourceMap: false,
      removeComments: false
    }
  });
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  );
  if (errors.length) {
    throw new Error(`RustDesk Windows edge source transpile failed: ${sourceName}`);
  }
  return normalizeText(result.outputText);
}

function renderReadme(config: RustDeskWindowsPackageConfig, installerFilename: string): string {
  return [
    '# iveKit RustDesk Windows x86_64 Package',
    '',
    `Source commit: \`${config.sourceCommit}\``,
    `RustDesk installer: \`${installerFilename}\``,
    `Companion service: \`${config.serviceName}\``,
    '',
    'Run `Deploy-IveKitRustDesk.ps1 -Mode validate` first. Validation is read-only and verifies the manifest, package hashes, fixed versions, capability policy, architecture, and local prerequisites.',
    '',
    'For install or repair, provide `-BaseUrl`, `-TenantId`, `-BusinessRefType`, `-BusinessRefId`, and `-DeviceTokenFile`. The token file must already exist and is copied with inheritance removed so only LocalSystem and Administrators can read it. No token is placed in argv, registry, manifest, rollback state, or logs.',
    '',
    'The package applies the exported RustDesk network config with `--config`, applies every allowlisted capability option with `--option`, reads every option back, obtains the runtime ID with `--get-id`, and installs the companion as a separate WinSW service.',
    '',
    `Precise disconnect uses the packaged \`${config.placementEnabled ? 'ivekit-rustdesk-native-control-v2' : 'ivekit-rustdesk-native-control-v1'}\` named-pipe contract. Placement-enabled packages persist the greatest accepted owner epoch before native execution. The adapter cannot execute an operator-supplied hook. Service restart is available only after a separate server-side emergency authorization.`,
    '',
    'Native file-transfer and recording completion evidence uses the custom RustDesk allowlist scanner, device-token context correlator, and `rustdesk-native-evidence-v1` event contract. Existing files are baselined, new files must become stable, and the controller ID, operation grant, expected filename, time window, and device identity must resolve to exactly one server-side authorization. `Publish-IveKitRustDeskEvidence.ps1` remains a fixed recovery tool, not the normal producer. The producer and companion reject path escapes, links, invalid or ambiguous binding, mutation during copy, duplicate conflicts, clipboard payloads, keystrokes, and raw screen frames. Accepted copies always enter the iveKit secure-file MIME, threat-scan, quarantine, derivative, OCR, ASR, and AI-quality pipeline.',
    '',
    '`uninstall` removes the companion and restores the pre-install option/service state. A failed install or repair invokes the same rollback automatically.',
    '',
    'Real screen, keyboard/mouse, clipboard, file transfer, multi-display, recording, UAC/login-screen, reconnect, and physical-disconnect acceptance remains `not_run` until executed on two real Windows devices.',
    ''
  ].join('\n');
}

function validateConfig(config: RustDeskWindowsPackageConfig): void {
  if (!/^[a-f0-9]{40}$/.test(config.sourceCommit)) {
    throw new Error('RustDesk Windows package source commit must be 40 lowercase hexadecimal characters');
  }
  if (!/^sha256:[a-f0-9]{16}$/.test(config.expectedServerKeyFingerprint)) {
    throw new Error('RustDesk Windows package expected server key fingerprint is invalid');
  }
  if (!/^[A-Za-z][A-Za-z0-9._-]{2,63}$/.test(config.serviceName)) {
    throw new Error('RustDesk Windows package service name is invalid');
  }
  safeHttpsUrl(config.winSw.url, 'RustDesk Windows WinSW URL');
  sha256Pin(config.winSw.sha256, 'RustDesk Windows WinSW sha256');
  if (config.winSw.filename !== `${config.serviceName}.exe`) {
    throw new Error('RustDesk Windows WinSW filename must match the service name');
  }
}

function assertWritableOutputDirectory(outputDir: string): void {
  try {
    const stat = statSync(outputDir);
    if (!stat.isDirectory()) throw new Error('not-directory');
    if (readdirSync(outputDir).length) {
      throw new Error('RustDesk Windows package output directory must be empty');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if ((error as Error).message === 'not-directory') {
      throw new Error('RustDesk Windows package output path must be a directory');
    }
    throw error;
  }
}

function packageFileRecord(path: string, content: string): PackageFileRecord {
  return {
    path,
    sha256: sha256(content),
    size_bytes: Buffer.byteLength(content)
  };
}

function normalizeText(value: string): string {
  return `${String(value || '').replace(/\r\n/g, '\n').replace(/\n*$/, '')}\n`;
}

function safeHttpsUrl(value: unknown, name: string): URL {
  const raw = requiredString(value, `${name} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must use HTTPS without credentials, query, or fragment`);
  }
  return url;
}

function sha256Pin(value: unknown, name: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${name} must be 64 hexadecimal characters`);
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function booleanFlag(
  value: string | undefined,
  fallback: boolean,
  name: string
): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  throw new Error(`${name} must be 0 or 1`);
}

async function main(): Promise<void> {
  const config = createRustDeskWindowsPackageConfigFromEnv(process.env);
  console.log(JSON.stringify(writeRustDeskWindowsPackage(config), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
