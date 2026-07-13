import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildIveKitStandaloneContext,
  validateIveKitStandaloneContext
} from './ivekit-standalone-build-context.js';

export interface DeliverySourceFile {
  source: string;
  destination: string;
}

export interface IveKitDeliveryManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface IveKitDeliveryManifest {
  schema_version: 1;
  product: 'iveKit';
  status: 'ready_for_handoff';
  source_commit: string;
  generated_at: string;
  contents: {
    sdk: string;
    reference_client: string;
    deployment: string;
    database: string;
    documentation: string;
    acceptance: string;
    provider_profiles: string;
    operations: string;
    completion_audit: string;
    intelligence_preflight: string;
    voice_preflight: string;
    voice_compose: string;
    voice_helm: string;
    service_source: string;
  };
  artifacts: {
    sdk_package: { path: string; sha256: string };
    reference_client: { path: string; tree_sha256: string };
    service_build_context: { path: string; manifest_sha256: string };
    migration_manifest: { path: string; sha256: string };
    image_metadata: { path: string; sha256: string };
    sbom: { path: string; sha256: string };
    acceptance_status: { path: string; sha256: string };
    provider_profiles_example: { path: string; sha256: string };
  };
  provider_ownership: {
    livekit: string;
    tinode: string;
    rustdesk: string;
    rustpbx: string;
  };
  real_environment_acceptance: {
    livekit: 'not_run';
    tinode: 'not_run';
    rustdesk: 'not_run';
    rustpbx: 'not_run';
    ocr: 'not_run';
    asr: 'not_run';
    quality_review: 'not_run';
    translation: 'not_run';
  };
  controlled_environment_acceptance: {
    postgres: IveKitControlledAcceptanceStatus;
    provider_protocol: IveKitControlledAcceptanceStatus;
    browser: IveKitControlledAcceptanceStatus;
    restart_recovery: IveKitControlledAcceptanceStatus;
  };
  known_not_run: IveKitKnownNotRun[];
  files: IveKitDeliveryManifestFile[];
}

export interface IveKitKnownNotRun {
  id: string;
  status: 'not_run';
  reason: string;
}

export type IveKitControlledAcceptanceStatus = 'not_run' | 'passed';

export interface IveKitControlledAcceptanceEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

export interface LoadedControlledAcceptancePackage {
  root: string;
  statuses: IveKitDeliveryManifest['controlled_environment_acceptance'];
  checks: Record<keyof IveKitDeliveryManifest['controlled_environment_acceptance'], {
    status: IveKitControlledAcceptanceStatus;
    evidence: string[];
  }>;
  evidence: IveKitControlledAcceptanceEvidence[];
}

export interface BuildIveKitDeliveryBundleOptions {
  repoRoot: string;
  outputDir: string;
  sdkTarball: string;
  clientDist: string;
  imageReference?: string;
  imageDigest?: string;
  controlledAcceptanceDir?: string;
  sourceCommit?: string;
  generatedAt?: string;
}

const STANDALONE_MIGRATIONS = [
  'services/ivekit-service/migrations/000_ivekit_foundation.sql',
  'src/migrations/009_tenant_rls.sql',
  'src/migrations/010_force_rls.sql',
  '011_collaboration_remote_assistance.sql',
  '012_livekit_participants.sql',
  '013_media_recording_business_ref.sql',
  '014_remote_assistance_web_assist_mode.sql',
  '016_collaboration_chat_bindings.sql',
  '017_collaboration_message_attachments.sql',
  '018_rustdesk_devices.sql',
  '019_rustdesk_gateway_sessions.sql',
  '020_rustdesk_gateway_events.sql',
  '021_rustdesk_device_heartbeat.sql',
  '022_rustdesk_tenant_rls.sql',
  '024_rustdesk_device_commands.sql',
  '025_collaboration_message_delivery.sql',
  '026_media_recording_lifecycle.sql',
  '027_collaboration_attachment_processing.sql',
  '028_collaboration_policy_findings.sql',
  '029_collaboration_quality_review.sql',
  '030_collaboration_message_state.sql',
  '033_collaboration_im_features.sql',
  '034_ivekit_media_calls.sql',
  '035_ivekit_media_moderation.sql',
  '036_media_recording_call_room.sql',
  '037_media_call_timeout_worker.sql',
  '038_media_recording_evidence.sql',
  '039_rustdesk_access_policy.sql',
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
  'services/ivekit-service/migrations/090_ivekit_runtime_security.sql'
];

export const DELIVERY_SOURCE_FILES: readonly DeliverySourceFile[] = [
  ...[
    'README.md',
    'docker-compose.yml',
    'docker-compose.voice.yml',
    'env.example',
    'init-postgres-runtime-role.sh'
  ].map((name) => ({ source: `infra/ivekit/${name}`, destination: `deploy/application/${name}` })),
  ...[
    'Chart.yaml',
    'values.yaml',
    'files/nats.conf',
    'templates/_helpers.tpl',
    'templates/ai-agent-deployment.yaml',
    'templates/frontend-deployment.yaml',
    'templates/ingress.yaml',
    'templates/livekit-deployment.yaml',
    'templates/livekit-egress-deployment.yaml',
    'templates/livekit-sip-deployment.yaml',
    'templates/minio-deployment.yaml',
    'templates/nats-statefulset.yaml',
    'templates/opc-deployment.yaml',
    'templates/postgres-statefulset.yaml',
    'templates/redis-deployment.yaml',
    'templates/rustdesk-server-deployment.yaml',
    'templates/rustpbx-deployment.yaml',
    'templates/secrets.yaml'
  ].map((name) => ({
    source: `infra/k8s/${name}`,
    destination: `deploy/kubernetes/ivekit/${name}`
  })),
  ...[
    'README.md',
    'docker-compose.yml',
    'docker-compose.storage.yml',
    'env.example',
    'config/redis.conf'
  ].map((name) => ({ source: `infra/livekit/${name}`, destination: `deploy/livekit/${name}` })),
  ...STANDALONE_MIGRATIONS.map((source) => ({
    source: source.includes('/') ? source : `src/migrations/${source}`,
    destination: `database/migrations/${basename(source)}`
  })),
  ...[
    'iveKit\u89c6\u9891IM\u901a\u7528\u80fd\u529b\u8be6\u7ec6\u8bbe\u8ba1.md',
    'ivekit-openapi.md',
    'ivekit-led-integration-guide.md',
    'ivekit-m5-unified-collaboration-plan.md',
    'ivekit-client-delivery-v1-roadmap.md',
    'ivekit-voice-foundation-v1-design.md',
    'ivekit-v3-intelligence-operations.md',
    'ivekit-v3-completion-audit.md',
    'livekit-im-full-capability-plan.md',
    'rustdesk-client-version-matrix.md'
  ].map((name) => ({ source: `docs/${name}`, destination: `docs/${name}` })),
  ...[
    'ivekit-led-integration-example.ts',
    'ivekit-rustdesk-led-example.ts'
  ].map((name) => ({ source: `scripts/${name}`, destination: `examples/${name}` })),
  {
    source: 'scripts/ivekit-controlled-provider.ts',
    destination: 'acceptance/tools/ivekit-controlled-provider.ts'
  },
  {
    source: 'scripts/ivekit-controlled-voice-provider.ts',
    destination: 'acceptance/tools/ivekit-controlled-voice-provider.ts'
  },
  ...[
    'rustdesk-edge-agent.ts',
    'rustdesk-edge-command.ts',
    'rustdesk-edge-pending-store.ts'
  ].map((name) => ({ source: `scripts/${name}`, destination: `edge/src/${name}` })),
  ...[
    'linux-disconnect.sh',
    'linux-restart.sh',
    'macos-disconnect.sh',
    'macos-restart.sh',
    'windows-disconnect.ps1',
    'windows-restart.ps1'
  ].map((name) => ({ source: `scripts/rustdesk-edge-adapters/${name}`, destination: `edge/adapters/${name}` })),
  { source: 'services/rustdesk-edge-agent/package.json', destination: 'edge/package.json' },
  { source: 'services/rustdesk-edge-agent/package-lock.json', destination: 'edge/package-lock.json' },
  { source: 'services/rustdesk-edge-agent/README.md', destination: 'edge/README.md' }
] as const;

const DELIVERY_ROOT_MARKER = '.ivekit-delivery-root';
const GENERATED_FILES = new Set([
  DELIVERY_ROOT_MARKER,
  'README.md',
  'acceptance/provider-profiles.example.json',
  'acceptance/status.json',
  'manifest.json',
  'SHA256SUMS'
]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/
];
const TEXT_EXTENSIONS = new Set([
  '', '.conf', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.sh', '.sql', '.ts', '.txt', '.yaml', '.yml'
]);

const REAL_ENVIRONMENT_ACCEPTANCE = {
  livekit: 'not_run',
  tinode: 'not_run',
  rustdesk: 'not_run',
  rustpbx: 'not_run',
  ocr: 'not_run',
  asr: 'not_run',
  quality_review: 'not_run',
  translation: 'not_run'
} as const;

const CONTROLLED_ENVIRONMENT_ACCEPTANCE = {
  postgres: 'not_run',
  provider_protocol: 'not_run',
  browser: 'not_run',
  restart_recovery: 'not_run'
} as const;

const CONTROLLED_ACCEPTANCE_KEYS = [
  'postgres',
  'provider_protocol',
  'browser',
  'restart_recovery'
] as const;

const KNOWN_NOT_RUN: readonly IveKitKnownNotRun[] = [
  { id: 'real_livekit_clients', status: 'not_run', reason: 'Current release requires fresh real browser media and Egress evidence.' },
  { id: 'real_tinode_clients', status: 'not_run', reason: 'Current release requires fresh real Tinode multi-client evidence.' },
  { id: 'real_rustdesk_clients', status: 'not_run', reason: 'Current release requires fresh physical RustDesk client evidence.' },
  { id: 'real_rustpbx', status: 'not_run', reason: 'Current release requires fresh real RustPBX SIP, media, RWI, and webhook evidence.' },
  { id: 'real_ocr_vendor', status: 'not_run', reason: 'No production OCR vendor, credentials, quota, or accuracy corpus is selected.' },
  { id: 'real_asr_vendor', status: 'not_run', reason: 'No production ASR vendor, credentials, quota, or accuracy corpus is selected.' },
  { id: 'real_quality_vendor', status: 'not_run', reason: 'No production AI quality vendor, credentials, or evaluation corpus is selected.' },
  { id: 'real_translation_vendor', status: 'not_run', reason: 'No production translation vendor, credentials, quota, or evaluation corpus is selected.' }
] as const;

const CONTROLLED_PROVIDER_PROFILES = [
  ['ocr', 'OPC_IVEKIT_OCR_TOKEN', '/v1/ocr'],
  ['asr', 'OPC_IVEKIT_ASR_TOKEN', '/v1/asr'],
  ['quality_review', 'OPC_IVEKIT_QUALITY_TOKEN', '/v1/quality-review'],
  ['translation', 'OPC_IVEKIT_TRANSLATION_TOKEN', '/v1/translate']
].map(([capability, tokenEnv, endpoint]) => ({
  id: `controlled-${capability.replace('_', '-')}`,
  capability,
  mode: 'self_hosted',
  base_url: 'http://controlled-intelligence-provider:8790',
  endpoint,
  health_endpoint: '/health',
  token_env: tokenEnv,
  timeout_ms: 30_000,
  name: `controlled-${capability.replace('_', '-')}`
}));

export function loadControlledAcceptancePackage(
  inputDir: string,
  sourceCommit: string
): LoadedControlledAcceptancePackage {
  const root = resolve(inputDir);
  assertIveKitDeliverySourceState(sourceCommit, '');
  requireDirectory(root, 'controlled acceptance package');
  assertNoSymlinks(root);
  const reportPath = join(root, 'report.json');
  requireFile(reportPath, 'controlled acceptance report');
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    schema_version?: unknown;
    product?: unknown;
    source_commit?: unknown;
    controlled_tests_are_real_vendor_evidence?: unknown;
    controlled_environment?: unknown;
    evidence?: unknown;
    real_environment?: unknown;
  };
  if (report.schema_version !== 1 || report.product !== 'iveKit') {
    throw new Error('invalid controlled acceptance report');
  }
  if (report.source_commit !== sourceCommit) {
    throw new Error('controlled acceptance source commit mismatch');
  }
  if (report.controlled_tests_are_real_vendor_evidence !== false || report.real_environment !== undefined) {
    throw new Error('controlled acceptance cannot claim real vendor evidence');
  }
  if (!isRecord(report.controlled_environment)) {
    throw new Error('controlled acceptance checks are missing');
  }
  const checkKeys = Object.keys(report.controlled_environment).sort();
  if (JSON.stringify(checkKeys) !== JSON.stringify([...CONTROLLED_ACCEPTANCE_KEYS].sort())) {
    throw new Error('controlled acceptance checks are incomplete');
  }

  const evidenceDir = join(root, 'evidence');
  requireDirectory(evidenceDir, 'controlled acceptance evidence');
  const actualFiles = readdirSync(evidenceDir).sort();
  for (const name of actualFiles) {
    const path = join(evidenceDir, name);
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
      throw new Error(`controlled acceptance evidence must be a regular file: ${name}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,127}\.(?:json|log|md|png|txt)$/.test(name)) {
      throw new Error(`controlled acceptance evidence path is invalid: ${name}`);
    }
  }
  if (!Array.isArray(report.evidence)) throw new Error('controlled acceptance evidence manifest is missing');
  const evidence = report.evidence as Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }>;
  const evidencePaths = evidence.map((entry) => String(entry.path || ''));
  if (new Set(evidencePaths).size !== evidencePaths.length ||
      JSON.stringify([...evidencePaths].sort()) !== JSON.stringify(actualFiles)) {
    throw new Error('controlled acceptance evidence file list mismatch');
  }
  let totalBytes = 0;
  const verifiedEvidence: IveKitControlledAcceptanceEvidence[] = [];
  for (const entry of evidence) {
    const path = String(entry.path || '');
    const absolute = join(evidenceDir, path);
    const bytes = statSync(absolute).size;
    totalBytes += bytes;
    if (bytes < 1 || bytes > 10_485_760 || totalBytes > 26_214_400) {
      throw new Error('controlled acceptance evidence size is invalid');
    }
    if (Number(entry.bytes) !== bytes || String(entry.sha256 || '') !== sha256(absolute)) {
      throw new Error(`controlled acceptance evidence checksum mismatch: ${path}`);
    }
    verifiedEvidence.push({ path, bytes, sha256: String(entry.sha256) });
  }

  const evidenceSet = new Set(evidencePaths);
  const referenced = new Set<string>();
  const statuses = {} as IveKitDeliveryManifest['controlled_environment_acceptance'];
  const checks = {} as LoadedControlledAcceptancePackage['checks'];
  for (const key of CONTROLLED_ACCEPTANCE_KEYS) {
    const raw = report.controlled_environment[key];
    if (!isRecord(raw) || (raw.status !== 'passed' && raw.status !== 'not_run') || !Array.isArray(raw.evidence)) {
      throw new Error(`controlled acceptance check is invalid: ${key}`);
    }
    const names = raw.evidence.map((value) => String(value));
    if (new Set(names).size !== names.length || names.some((name) => !evidenceSet.has(name))) {
      throw new Error(`controlled acceptance evidence reference is invalid: ${key}`);
    }
    if ((raw.status === 'passed' && names.length === 0) || (raw.status === 'not_run' && names.length !== 0)) {
      throw new Error(`controlled acceptance evidence state is invalid: ${key}`);
    }
    for (const name of names) referenced.add(name);
    statuses[key] = raw.status;
    checks[key] = { status: raw.status, evidence: names };
  }
  if (referenced.size !== evidenceSet.size) {
    throw new Error('controlled acceptance contains unreferenced evidence');
  }
  return { root, statuses, checks, evidence: verifiedEvidence };
}

function emptyControlledAcceptancePackage(): LoadedControlledAcceptancePackage {
  const statuses = { ...CONTROLLED_ENVIRONMENT_ACCEPTANCE };
  return {
    root: '',
    statuses,
    checks: {
      postgres: { status: statuses.postgres, evidence: [] },
      provider_protocol: { status: statuses.provider_protocol, evidence: [] },
      browser: { status: statuses.browser, evidence: [] },
      restart_recovery: { status: statuses.restart_recovery, evidence: [] }
    },
    evidence: []
  };
}

function controlledAcceptanceStatus(
  statuses: IveKitDeliveryManifest['controlled_environment_acceptance']
): 'not_run' | 'partial' | 'passed' {
  const passed = Object.values(statuses).filter((status) => status === 'passed').length;
  return passed === 0 ? 'not_run' : passed === CONTROLLED_ACCEPTANCE_KEYS.length ? 'passed' : 'partial';
}

export function buildIveKitDeliveryBundle(
  options: BuildIveKitDeliveryBundleOptions
): { outputDir: string; manifest: IveKitDeliveryManifest } {
  const repoRoot = resolve(options.repoRoot);
  const outputDir = resolve(options.outputDir);
  const sourceCommit = options.sourceCommit || resolveSourceCommit(repoRoot);
  assertIveKitDeliverySourceState(sourceCommit, '');
  const generatedAt = options.generatedAt || new Date().toISOString();
  const controlledAcceptance = options.controlledAcceptanceDir
    ? loadControlledAcceptancePackage(options.controlledAcceptanceDir, sourceCommit)
    : emptyControlledAcceptancePackage();
  assertSafeOutputDirectory(repoRoot, outputDir);
  requireFile(options.sdkTarball, 'SDK tarball');
  requireDirectory(options.clientDist, 'reference client dist');

  assertReplaceableOutputDirectory(outputDir);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, DELIVERY_ROOT_MARKER), 'ivekit-delivery-bundle-v1\n', 'utf8');

  for (const entry of DELIVERY_SOURCE_FILES) {
    const source = resolveInside(repoRoot, entry.source);
    requireFile(source, `delivery source ${entry.source}`);
    copyDeliverySource(outputDir, source, entry.destination);
  }
  const edgeStaging = mkdtempSync(join(tmpdir(), 'ivekit-delivery-edge-'));
  try {
    run('npx', [
      'tsc',
      '--outDir', edgeStaging,
      '--rootDir', 'scripts',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--target', 'ES2022',
      '--types', 'node',
      '--skipLibCheck',
      'scripts/rustdesk-edge-agent.ts',
      'scripts/rustdesk-edge-command.ts',
      'scripts/rustdesk-edge-pending-store.ts'
    ], repoRoot);
    for (const name of [
      'rustdesk-edge-agent.js',
      'rustdesk-edge-command.js',
      'rustdesk-edge-pending-store.js'
    ]) copyFile(outputDir, join(edgeStaging, name), `edge/dist/${name}`);
  } finally {
    rmSync(edgeStaging, { recursive: true, force: true });
  }

  cpSync(options.clientDist, join(outputDir, 'client'), { recursive: true, dereference: false });
  copyFile(outputDir, options.sdkTarball, `sdk/${basename(options.sdkTarball)}`);
  const serviceStaging = mkdtempSync(join(tmpdir(), 'ivekit-delivery-service-'));
  try {
    const contextDir = join(serviceStaging, 'build-context');
    const context = buildIveKitStandaloneContext({
      repoRoot,
      outputDir: contextDir,
      sourceCommit,
      generatedAt
    });
    cpSync(contextDir, join(outputDir, 'service', 'build-context'), {
      recursive: true,
      dereference: false
    });
    const migrations = context.manifest.files
      .filter((entry) => entry.path.startsWith('migrations/'))
      .map((entry) => ({
        version: basename(entry.path, '.sql').split('_', 1)[0],
        file: basename(entry.path),
        bytes: entry.bytes,
        sha256: entry.sha256
      }));
    writeFileSync(join(outputDir, 'service', 'migration-manifest.json'), `${JSON.stringify({
      schema_version: 1,
      source_commit: sourceCommit,
      migrations
    }, null, 2)}\n`, 'utf8');
  } finally {
    rmSync(serviceStaging, { recursive: true, force: true });
  }
  const imageDigest = validatedImageDigest(options.imageDigest);
  writeFileSync(join(outputDir, 'service', 'image-metadata.json'), `${JSON.stringify({
    schema_version: 1,
    source_commit: sourceCommit,
    reference: String(options.imageReference || `ivekit-service:${sourceCommit.slice(0, 12)}`).trim(),
    digest: imageDigest,
    status: imageDigest ? 'digest_pinned' : 'build_required',
    build_context: 'service/build-context/'
  }, null, 2)}\n`, 'utf8');
  const sbom = JSON.parse(run(
    'npm',
    ['sbom', '--package-lock-only', '--sbom-format', 'spdx'],
    join(repoRoot, 'services', 'ivekit-service')
  )) as Record<string, unknown>;
  writeFileSync(join(outputDir, 'service', 'sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDir, 'README.md'), renderBundleReadme(), 'utf8');
  mkdirSync(join(outputDir, 'acceptance'), { recursive: true });
  if (controlledAcceptance.evidence.length) {
    const evidenceDir = join(outputDir, 'acceptance', 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    for (const entry of controlledAcceptance.evidence) {
      copyFileSync(
        join(controlledAcceptance.root, 'evidence', entry.path),
        join(evidenceDir, entry.path)
      );
    }
  }
  writeFileSync(
    join(outputDir, 'acceptance', 'provider-profiles.example.json'),
    `${JSON.stringify(CONTROLLED_PROVIDER_PROFILES, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(join(outputDir, 'acceptance', 'status.json'), `${JSON.stringify({
    schema_version: 2,
    product: 'iveKit',
    source_commit: sourceCommit,
    generated_at: generatedAt,
    status: controlledAcceptanceStatus(controlledAcceptance.statuses),
    controlled_environment: controlledAcceptance.statuses,
    controlled_checks: controlledAcceptance.checks,
    evidence: controlledAcceptance.evidence,
    real_environment: REAL_ENVIRONMENT_ACCEPTANCE,
    known_not_run: KNOWN_NOT_RUN,
    reason: controlledAcceptance.evidence.length
      ? 'Controlled acceptance passed only for checks bound to packaged evidence; real providers and clients remain not_run.'
      : 'Controlled and real provider acceptance must be executed in the target environment.',
    controlled_tests_are_real_vendor_evidence: false
  }, null, 2)}\n`, 'utf8');

  assertNoSymlinks(outputDir);
  scanForSecrets(outputDir);

  const payloadFiles = listDeliveryFiles(outputDir);
  const manifest: IveKitDeliveryManifest = {
    schema_version: 1,
    product: 'iveKit',
    status: 'ready_for_handoff',
    source_commit: sourceCommit,
    generated_at: generatedAt,
    contents: {
      sdk: 'sdk/',
      reference_client: 'client/',
      deployment: 'deploy/',
      database: 'database/migrations/',
      documentation: 'docs/',
      acceptance: 'acceptance/status.json',
      provider_profiles: 'acceptance/provider-profiles.example.json',
      operations: 'docs/ivekit-v3-intelligence-operations.md',
      completion_audit: 'docs/ivekit-v3-completion-audit.md',
      intelligence_preflight: 'service/build-context/src/ivekit-intelligence-preflight.ts',
      voice_preflight: 'service/build-context/src/ivekit-voice-preflight.ts',
      voice_compose: 'service/build-context/docker-compose.voice.yml',
      voice_helm: 'deploy/kubernetes/ivekit/',
      service_source: 'service/build-context/'
    },
    artifacts: {
      sdk_package: {
        path: `sdk/${basename(options.sdkTarball)}`,
        sha256: sha256(join(outputDir, 'sdk', basename(options.sdkTarball)))
      },
      reference_client: {
        path: 'client/',
        tree_sha256: treeSha256(join(outputDir, 'client'))
      },
      service_build_context: {
        path: 'service/build-context/',
        manifest_sha256: sha256(join(outputDir, 'service', 'build-context', 'context-manifest.json'))
      },
      migration_manifest: {
        path: 'service/migration-manifest.json',
        sha256: sha256(join(outputDir, 'service', 'migration-manifest.json'))
      },
      image_metadata: {
        path: 'service/image-metadata.json',
        sha256: sha256(join(outputDir, 'service', 'image-metadata.json'))
      },
      sbom: {
        path: 'service/sbom.spdx.json',
        sha256: sha256(join(outputDir, 'service', 'sbom.spdx.json'))
      },
      acceptance_status: {
        path: 'acceptance/status.json',
        sha256: sha256(join(outputDir, 'acceptance', 'status.json'))
      },
      provider_profiles_example: {
        path: 'acceptance/provider-profiles.example.json',
        sha256: sha256(join(outputDir, 'acceptance', 'provider-profiles.example.json'))
      }
    },
    provider_ownership: {
      livekit: 'audio, video, rooms, screen share, recording and webhooks',
      tinode: 'instant messaging, topics, delivery and presence',
      rustdesk: 'native remote desktop transport and controlled operations',
      rustpbx: 'SIP and PSTN signaling, media, call control, CDR and telephony webhooks'
    },
    real_environment_acceptance: { ...REAL_ENVIRONMENT_ACCEPTANCE },
    controlled_environment_acceptance: { ...controlledAcceptance.statuses },
    known_not_run: KNOWN_NOT_RUN.map((entry) => ({ ...entry })),
    files: payloadFiles.map((path) => fileEntry(outputDir, path))
  };
  writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  scanForSecrets(outputDir);

  const checksummedFiles = listDeliveryFiles(outputDir).filter((path) => path !== 'SHA256SUMS');
  writeFileSync(join(outputDir, 'SHA256SUMS'), checksummedFiles
    .map((path) => `${sha256(join(outputDir, path))}  ${path}`)
    .join('\n') + '\n', 'utf8');

  validateIveKitDeliveryBundle(outputDir);
  return { outputDir, manifest };
}

export function validateIveKitDeliveryBundle(outputDirInput: string): IveKitDeliveryManifest {
  const outputDir = resolve(outputDirInput);
  assertNoSymlinks(outputDir);
  const files = listDeliveryFiles(outputDir);
  for (const path of files) assertAllowedDeliveryPath(path);
  for (const required of GENERATED_FILES) {
    if (!files.includes(required)) throw new Error(`missing delivery file: ${required}`);
  }

  const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8')) as IveKitDeliveryManifest;
  if (manifest.schema_version !== 1 || manifest.product !== 'iveKit') {
    throw new Error('invalid iveKit delivery manifest');
  }
  if (Object.values(manifest.real_environment_acceptance).some((status) => status !== 'not_run')) {
    throw new Error('delivery generation cannot claim real-environment acceptance');
  }
  validateAcceptanceMetadata(outputDir, manifest);
  const contextManifest = validateIveKitStandaloneContext(join(outputDir, 'service', 'build-context'));
  if (contextManifest.source_commit !== manifest.source_commit) {
    throw new Error('service build context source commit does not match delivery manifest');
  }
  validateArtifactBindings(outputDir, manifest);

  const payloadFiles = files.filter((path) => path !== 'manifest.json' && path !== 'SHA256SUMS');
  if (JSON.stringify(manifest.files.map((entry) => entry.path)) !== JSON.stringify(payloadFiles)) {
    throw new Error('manifest file list does not match delivery payload');
  }
  for (const entry of manifest.files) {
    const actual = fileEntry(outputDir, entry.path);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new Error(`delivery checksum mismatch: ${entry.path}`);
    }
  }

  const expectedSums = files
    .filter((path) => path !== 'SHA256SUMS')
    .map((path) => `${sha256(join(outputDir, path))}  ${path}`)
    .join('\n') + '\n';
  if (readFileSync(join(outputDir, 'SHA256SUMS'), 'utf8') !== expectedSums) {
    throw new Error('SHA256SUMS does not match delivery files');
  }
  scanForSecrets(outputDir);
  return manifest;
}

export function listDeliveryFiles(root: string): string[] {
  const files: string[] = [];
  walk(resolve(root), resolve(root), files);
  return files.sort();
}

function prepareBundleFromCli(): { outputDir: string; manifest: IveKitDeliveryManifest } {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const outputDir = resolve(process.env.OPC_IVEKIT_DELIVERY_DIR || join(repoRoot, '.tmp', 'ivekit-led-delivery'));
  const sourceCommit = resolveSourceCommit(repoRoot);
  assertIveKitDeliverySourceState(
    sourceCommit,
    run('git', ['status', '--porcelain=v1', '--untracked-files=all'], repoRoot)
  );
  const stagingDir = mkdtempSync(join(tmpdir(), 'ivekit-delivery-build-'));
  try {
    run('npm', ['--prefix', 'sdk/ivekit', 'run', 'build'], repoRoot);
    run('npm', ['--prefix', 'clients/ivekit-reference', 'run', 'build'], repoRoot);
    const packed = run('npm', ['pack', './sdk/ivekit', '--json', '--pack-destination', stagingDir], repoRoot);
    const packResult = JSON.parse(packed) as Array<{ filename: string }>;
    const filename = packResult[0]?.filename;
    if (!filename) throw new Error('npm pack did not return an SDK filename');
    return buildIveKitDeliveryBundle({
      repoRoot,
      outputDir,
      sdkTarball: join(stagingDir, filename),
      clientDist: join(repoRoot, 'clients', 'ivekit-reference', 'dist'),
      imageReference: process.env.OPC_IVEKIT_DELIVERY_IMAGE_REFERENCE,
      imageDigest: process.env.OPC_IVEKIT_DELIVERY_IMAGE_DIGEST,
      controlledAcceptanceDir: process.env.OPC_IVEKIT_DELIVERY_CONTROLLED_ACCEPTANCE_DIR,
      sourceCommit
    });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function assertIveKitDeliverySourceState(sourceCommit: string, porcelainStatus: string): void {
  if (!/^[a-f0-9]{40}$/.test(String(sourceCommit || '').trim())) {
    throw new Error('iveKit delivery source must be a full 40-character Git commit');
  }
  const changedEntries = String(porcelainStatus || '').split(/\r?\n/).filter(Boolean).length;
  if (changedEntries) {
    throw new Error(`iveKit delivery worktree is dirty (${changedEntries} entries)`);
  }
}

function renderBundleReadme(): string {
  return [
    '# iveKit LED Delivery Bundle',
    '',
    'This directory is a curated integration handoff for the reusable iveKit communication foundation.',
    'It does not contain OPC call-center or IVR source code and it does not contain credentials.',
    '',
    '## Contents',
    '',
    '- `sdk/`: installable `@opc/ivekit-sdk` npm package.',
    '- `client/`: production reference client static assets.',
    '- `deploy/application/`: PostgreSQL, Redis, Tinode, object storage, RustDesk and iveKit application Compose.',
    '- `deploy/livekit/`: separately deployable LiveKit media plane.',
    '- `database/migrations/`: ordered communication-domain overlay migrations used by the application image.',
    '- `docs/`: API, architecture, LED integration, roadmap and provider compatibility documents.',
    '- `examples/`: minimal LED SDK and RustDesk integration examples.',
    '- `acceptance/status.json`: honest target-environment acceptance state.',
    '- `acceptance/evidence/`: optional source-bound controlled-environment evidence with verified hashes.',
    '- `acceptance/provider-profiles.example.json`: secret-free controlled Provider profiles.',
    '- `acceptance/tools/`: deterministic controlled Provider source for isolated acceptance.',
    '- `service/build-context/`: independently buildable iveKit service source context with its own package lock.',
    '- `service/migration-manifest.json`: ordered standalone migration checksums.',
    '- `service/image-metadata.json`: source-bound image reference/digest state.',
    '- `service/sbom.spdx.json`: npm dependency SBOM in SPDX 2.3 format.',
    '- `edge/`: RustDesk device agent source, crash-safe spool, package manifest, and OS adapter examples.',
    '',
    '## Integrity',
    '',
    '`manifest.json` records SHA-256 and size for every payload file. `SHA256SUMS` additionally covers the manifest.',
    'The checksum file intentionally cannot checksum itself.',
    '',
    '## Deployment boundary',
    '',
    'Build the iveKit image directly from `service/build-context/`; no OPC root checkout is required.',
    'The context and image metadata are bound to the same source commit recorded in `manifest.json`.',
    'The SQL files are application-owned overlay migrations and must be run by the image migration job in numeric order.',
    'Do not apply them to an unrelated schema without the foundation tables and RLS helpers documented in the integration guide.',
    '',
    '## Acceptance',
    '',
    'A generated bundle is ready for engineering handoff, not production acceptance. Controlled PostgreSQL, Provider,',
    'browser and restart checks may be marked passed only when source-bound evidence is packaged and hash verified.',
    'They remain separate from real LiveKit, Tinode, RustDesk, OCR, ASR, quality and translation vendor evidence.',
    'Every unexecuted surface remains `not_run`; controlled evidence never upgrades a real vendor result.',
    ''
  ].join('\n');
}

function assertAllowedDeliveryPath(path: string): void {
  const fixed = new Set([
    ...DELIVERY_SOURCE_FILES.map((entry) => entry.destination),
    ...GENERATED_FILES
  ]);
  if (fixed.has(path)) return;
  if (/^acceptance\/evidence\/[a-z0-9][a-z0-9._-]{0,127}\.(?:json|log|md|png|txt)$/.test(path)) return;
  if (path.startsWith('client/') && path.length > 'client/'.length) return;
  if (/^sdk\/[^/]+\.tgz$/.test(path)) return;
  if (path.startsWith('service/build-context/') && path.length > 'service/build-context/'.length) return;
  if (/^edge\/dist\/rustdesk-edge-(?:agent|command|pending-store)\.js$/.test(path)) return;
  if (path === 'service/migration-manifest.json' || path === 'service/image-metadata.json' || path === 'service/sbom.spdx.json') return;
  throw new Error(`unexpected delivery file: ${path}`);
}

function assertSafeOutputDirectory(repoRoot: string, outputDir: string): void {
  if (outputDir === repoRoot || outputDir === resolve(repoRoot, '..') || outputDir === resolve('/')) {
    throw new Error('refusing unsafe iveKit delivery output directory');
  }
  for (const protectedPath of ['src', 'scripts', 'sdk', 'clients', 'docs', 'infra', 'test']) {
    const absolute = resolve(repoRoot, protectedPath);
    if (outputDir === absolute || absolute.startsWith(`${outputDir}${sep}`)) {
      throw new Error('refusing delivery output that contains repository source directories');
    }
  }
}

function assertReplaceableOutputDirectory(outputDir: string): void {
  if (!existsSync(outputDir)) return;
  const marker = join(outputDir, DELIVERY_ROOT_MARKER);
  if (!existsSync(marker) || !statSync(marker).isFile()) {
    throw new Error('refusing to replace an existing directory without the iveKit ownership marker');
  }
  if (readFileSync(marker, 'utf8') !== 'ivekit-delivery-bundle-v1\n') {
    throw new Error('refusing to replace a directory with an invalid iveKit ownership marker');
  }
}

function assertNoSymlinks(root: string): void {
  for (const path of listPaths(root)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`delivery symlink is not allowed: ${relative(root, path)}`);
  }
}

function scanForSecrets(root: string): void {
  for (const path of listDeliveryFiles(root)) {
    const extension = path.includes('.') ? path.slice(path.lastIndexOf('.')).toLowerCase() : '';
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const content = readFileSync(join(root, path), 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(content)) throw new Error(`secret material detected in delivery file: ${path}`);
    }
    if (basename(path) === 'env.example') scanExampleEnvironment(path, content);
    if (basename(path) === '.npmrc' && /(?:_authToken|_password)\s*=\s*[^\s$<{]/i.test(content)) {
      throw new Error(`secret material detected in delivery file: ${path}`);
    }
  }
}

function scanExampleEnvironment(path: string, content: string): void {
  const sensitiveName = /(?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|JWT)/;
  const safePlaceholder = /^(?:|replace[_-]with|change[_-]me|example|your[_-]|<|\$\{)/i;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!assignment || !sensitiveName.test(assignment[1])) continue;
    if (!safePlaceholder.test(assignment[2].trim())) {
      throw new Error(`secret material detected in delivery file: ${path} (${assignment[1]})`);
    }
  }
}

function fileEntry(root: string, path: string): IveKitDeliveryManifestFile {
  const absolute = join(root, path);
  return { path, bytes: statSync(absolute).size, sha256: sha256(absolute) };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function treeSha256(root: string): string {
  return createHash('sha256').update(listDeliveryFiles(root)
    .map((path) => `${path}\0${sha256(join(root, path))}\n`)
    .join('')).digest('hex');
}

function validatedImageDigest(value: string | undefined): string {
  const digest = String(value || '').trim();
  if (digest && !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error('imageDigest must be a sha256 digest');
  }
  return digest;
}

function validateArtifactBindings(outputDir: string, manifest: IveKitDeliveryManifest): void {
  const artifacts = manifest.artifacts;
  const checks: Array<[string, string]> = [
    [artifacts.sdk_package.path, artifacts.sdk_package.sha256],
    [artifacts.migration_manifest.path, artifacts.migration_manifest.sha256],
    [artifacts.image_metadata.path, artifacts.image_metadata.sha256],
    [artifacts.sbom.path, artifacts.sbom.sha256],
    [artifacts.acceptance_status.path, artifacts.acceptance_status.sha256],
    [artifacts.provider_profiles_example.path, artifacts.provider_profiles_example.sha256],
    ['service/build-context/context-manifest.json', artifacts.service_build_context.manifest_sha256]
  ];
  for (const [path, expected] of checks) {
    if (sha256(join(outputDir, path)) !== expected) throw new Error(`artifact checksum mismatch: ${path}`);
  }
  if (treeSha256(join(outputDir, artifacts.reference_client.path)) !== artifacts.reference_client.tree_sha256) {
    throw new Error('reference client tree checksum mismatch');
  }
  const migrationManifest = JSON.parse(readFileSync(
    join(outputDir, artifacts.migration_manifest.path), 'utf8'
  )) as { source_commit?: unknown };
  const imageMetadata = JSON.parse(readFileSync(
    join(outputDir, artifacts.image_metadata.path), 'utf8'
  )) as { source_commit?: unknown };
  if (migrationManifest.source_commit !== manifest.source_commit) {
    throw new Error('migration manifest source commit does not match delivery manifest');
  }
  if (imageMetadata.source_commit !== manifest.source_commit) {
    throw new Error('image metadata source commit does not match delivery manifest');
  }
}

function validateAcceptanceMetadata(outputDir: string, manifest: IveKitDeliveryManifest): void {
  if (!isRecord(manifest.controlled_environment_acceptance) ||
      JSON.stringify(Object.keys(manifest.controlled_environment_acceptance).sort()) !==
        JSON.stringify([...CONTROLLED_ACCEPTANCE_KEYS].sort()) ||
      Object.values(manifest.controlled_environment_acceptance)
        .some((value) => value !== 'not_run' && value !== 'passed')) {
    throw new Error('controlled acceptance contract is incomplete');
  }
  if (
    JSON.stringify(manifest.real_environment_acceptance) !==
    JSON.stringify(REAL_ENVIRONMENT_ACCEPTANCE)
  ) throw new Error('real-environment acceptance contract is incomplete');
  const status = JSON.parse(readFileSync(join(outputDir, 'acceptance', 'status.json'), 'utf8')) as {
    schema_version?: unknown;
    product?: unknown;
    source_commit?: unknown;
    generated_at?: unknown;
    status?: unknown;
    controlled_environment?: unknown;
    controlled_checks?: unknown;
    evidence?: unknown;
    real_environment?: unknown;
    known_not_run?: unknown;
    controlled_tests_are_real_vendor_evidence?: unknown;
  };
  if (status.schema_version !== 2 || status.product !== 'iveKit' ||
      status.status !== controlledAcceptanceStatus(manifest.controlled_environment_acceptance)) {
    throw new Error('invalid V3 acceptance status');
  }
  if (status.source_commit !== manifest.source_commit) {
    throw new Error('acceptance source commit does not match delivery manifest');
  }
  if (status.generated_at !== manifest.generated_at) {
    throw new Error('acceptance generated_at does not match delivery manifest');
  }
  if (JSON.stringify(status.controlled_environment) !== JSON.stringify(manifest.controlled_environment_acceptance)) {
    throw new Error('controlled acceptance state does not match delivery manifest');
  }
  if (!isRecord(status.controlled_checks) || !Array.isArray(status.evidence)) {
    throw new Error('controlled acceptance evidence contract is missing');
  }
  const evidence = status.evidence as Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }>;
  const evidencePaths = evidence.map((entry) => String(entry.path || ''));
  if (new Set(evidencePaths).size !== evidencePaths.length) {
    throw new Error('duplicate controlled acceptance evidence');
  }
  const actualEvidenceDir = join(outputDir, 'acceptance', 'evidence');
  const actualEvidence = existsSync(actualEvidenceDir) ? listDeliveryFiles(actualEvidenceDir) : [];
  if (JSON.stringify([...evidencePaths].sort()) !== JSON.stringify(actualEvidence)) {
    throw new Error('controlled acceptance evidence file list mismatch');
  }
  const referenced = new Set<string>();
  for (const entry of evidence) {
    const path = String(entry.path || '');
    const absolute = join(actualEvidenceDir, path);
    if (Number(entry.bytes) !== statSync(absolute).size || String(entry.sha256 || '') !== sha256(absolute)) {
      throw new Error(`controlled acceptance evidence checksum mismatch: ${path}`);
    }
  }
  for (const key of CONTROLLED_ACCEPTANCE_KEYS) {
    const check = status.controlled_checks[key];
    if (!isRecord(check) || check.status !== manifest.controlled_environment_acceptance[key] ||
        !Array.isArray(check.evidence)) {
      throw new Error(`controlled acceptance check does not match manifest: ${key}`);
    }
    const names = check.evidence.map((value) => String(value));
    if (new Set(names).size !== names.length || names.some((name) => !evidencePaths.includes(name)) ||
        (check.status === 'passed' && names.length === 0) ||
        (check.status === 'not_run' && names.length !== 0)) {
      throw new Error(`controlled acceptance evidence state is invalid: ${key}`);
    }
    for (const name of names) referenced.add(name);
  }
  if (referenced.size !== evidencePaths.length) {
    throw new Error('controlled acceptance contains unreferenced evidence');
  }
  if (JSON.stringify(status.real_environment) !== JSON.stringify(manifest.real_environment_acceptance)) {
    throw new Error('real-environment acceptance state does not match delivery manifest');
  }
  if (status.controlled_tests_are_real_vendor_evidence !== false) {
    throw new Error('controlled tests cannot claim real vendor evidence');
  }
  if (!Array.isArray(status.known_not_run)) throw new Error('known_not_run must be an array');
  const entries = status.known_not_run as Array<{ id?: unknown; status?: unknown; reason?: unknown }>;
  const ids = entries.map((entry) => String(entry.id || ''));
  if (new Set(ids).size !== ids.length) throw new Error('duplicate known_not_run id');
  if (JSON.stringify(ids) !== JSON.stringify(KNOWN_NOT_RUN.map((entry) => entry.id))) {
    throw new Error('known_not_run items do not match the V3 acceptance contract');
  }
  for (const entry of entries) {
    const reason = String(entry.reason || '').trim();
    if (entry.status !== 'not_run') throw new Error(`known_not_run ${entry.id} must remain not_run`);
    if (reason.length < 20 || /\b(?:TBD|TODO|placeholder|replace[_ -]?me)\b/i.test(reason)) {
      throw new Error(`placeholder known_not_run reason: ${entry.id}`);
    }
  }
  if (JSON.stringify(entries) !== JSON.stringify(manifest.known_not_run)) {
    throw new Error('known_not_run items do not match delivery manifest');
  }

  const profiles = JSON.parse(readFileSync(
    join(outputDir, 'acceptance', 'provider-profiles.example.json'), 'utf8'
  )) as Array<Record<string, unknown>>;
  if (!Array.isArray(profiles) || profiles.length !== 4) throw new Error('invalid controlled provider profiles');
  const capabilities = profiles.map((profile) => profile.capability);
  if (JSON.stringify(capabilities) !== JSON.stringify(['ocr', 'asr', 'quality_review', 'translation'])) {
    throw new Error('controlled provider profiles are incomplete or duplicated');
  }
  for (const profile of profiles) {
    if (
      profile.mode !== 'self_hosted' ||
      profile.base_url !== 'http://controlled-intelligence-provider:8790' ||
      typeof profile.token_env !== 'string' ||
      !String(profile.token_env).startsWith('OPC_IVEKIT_')
    ) throw new Error('controlled provider profile is unsafe');
  }
}

function copyFile(outputDir: string, source: string, destination: string): void {
  const target = join(outputDir, destination);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function copyDeliverySource(outputDir: string, source: string, destination: string): void {
  if (destination !== 'deploy/application/docker-compose.yml') {
    copyFile(outputDir, source, destination);
    return;
  }
  const target = join(outputDir, destination);
  mkdirSync(dirname(target), { recursive: true });
  const portableCompose = readFileSync(source, 'utf8')
    .replace(/\n    build:\n      context: \.\.\/\.\.\n      dockerfile: Dockerfile/, '')
    .replaceAll(
      '${IVEKIT_OPC_IMAGE_NAME:-ivekit-opc:local}',
      '${IVEKIT_OPC_IMAGE_NAME:?IVEKIT_OPC_IMAGE_NAME is required}'
    );
  if (/^\s+build:/m.test(portableCompose) || portableCompose.includes('ivekit-opc:local')) {
    throw new Error('failed to remove repository-only build settings from delivery Compose');
  }
  writeFileSync(target, portableCompose, 'utf8');
}

function resolveInside(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`source escapes repository: ${path}`);
  return absolute;
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
}

function requireDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} is missing: ${path}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function walk(root: string, current: string, files: string[]): void {
  if (!existsSync(current)) return;
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) walk(root, absolute, files);
    else files.push(relative(root, absolute).split(sep).join('/'));
  }
}

function listPaths(root: string): string[] {
  const paths: string[] = [];
  const visit = (current: string): void => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      paths.push(path);
      if (lstatSync(path).isDirectory()) visit(path);
    }
  };
  visit(root);
  return paths;
}

function resolveSourceCommit(repoRoot: string): string {
  return run('git', ['rev-parse', 'HEAD'], repoRoot).trim();
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`.trim());
  }
  return result.stdout || '';
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = prepareBundleFromCli();
  process.stdout.write(`${JSON.stringify({
    output_dir: result.outputDir,
    status: result.manifest.status,
    source_commit: result.manifest.source_commit,
    payload_files: result.manifest.files.length,
    controlled_environment_acceptance: result.manifest.controlled_environment_acceptance,
    real_environment_acceptance: result.manifest.real_environment_acceptance
  }, null, 2)}\n`);
}
