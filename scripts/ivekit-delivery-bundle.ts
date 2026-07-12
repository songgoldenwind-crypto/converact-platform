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
    service_source: string;
  };
  artifacts: {
    sdk_package: { path: string; sha256: string };
    reference_client: { path: string; tree_sha256: string };
    service_build_context: { path: string; manifest_sha256: string };
    migration_manifest: { path: string; sha256: string };
    image_metadata: { path: string; sha256: string };
    sbom: { path: string; sha256: string };
  };
  provider_ownership: {
    livekit: string;
    tinode: string;
    rustdesk: string;
  };
  real_environment_acceptance: {
    livekit: 'not_run';
    tinode: 'not_run';
    rustdesk: 'not_run';
  };
  files: IveKitDeliveryManifestFile[];
}

export interface BuildIveKitDeliveryBundleOptions {
  repoRoot: string;
  outputDir: string;
  sdkTarball: string;
  clientDist: string;
  imageReference?: string;
  imageDigest?: string;
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
  'services/ivekit-service/migrations/090_ivekit_runtime_security.sql'
];

export const DELIVERY_SOURCE_FILES: readonly DeliverySourceFile[] = [
  ...[
    'README.md',
    'docker-compose.yml',
    'env.example',
    'init-postgres-runtime-role.sh'
  ].map((name) => ({ source: `infra/ivekit/${name}`, destination: `deploy/application/${name}` })),
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
    'livekit-im-full-capability-plan.md',
    'rustdesk-client-version-matrix.md'
  ].map((name) => ({ source: `docs/${name}`, destination: `docs/${name}` })),
  ...[
    'ivekit-led-integration-example.ts',
    'ivekit-rustdesk-led-example.ts'
  ].map((name) => ({ source: `scripts/${name}`, destination: `examples/${name}` })),
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

export function buildIveKitDeliveryBundle(
  options: BuildIveKitDeliveryBundleOptions
): { outputDir: string; manifest: IveKitDeliveryManifest } {
  const repoRoot = resolve(options.repoRoot);
  const outputDir = resolve(options.outputDir);
  const sourceCommit = options.sourceCommit || resolveSourceCommit(repoRoot);
  const generatedAt = options.generatedAt || new Date().toISOString();
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
  writeFileSync(join(outputDir, 'acceptance', 'status.json'), `${JSON.stringify({
    schema_version: 1,
    status: 'not_run',
    livekit: 'not_run',
    tinode: 'not_run',
    rustdesk: 'not_run',
    reason: 'Real provider and server acceptance must be executed in the target environment.',
    local_controlled_tests_are_acceptance_evidence: false
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
      }
    },
    provider_ownership: {
      livekit: 'audio, video, rooms, screen share, recording and webhooks',
      tinode: 'instant messaging, topics, delivery and presence',
      rustdesk: 'native remote desktop transport and controlled operations'
    },
    real_environment_acceptance: {
      livekit: 'not_run',
      tinode: 'not_run',
      rustdesk: 'not_run'
    },
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
      imageDigest: process.env.OPC_IVEKIT_DELIVERY_IMAGE_DIGEST
    });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
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
    'A generated bundle is ready for engineering handoff, not production acceptance. LiveKit, Tinode and RustDesk remain',
    '`not_run` until the existing provider acceptance commands are executed against the target server and real clients.',
    ''
  ].join('\n');
}

function assertAllowedDeliveryPath(path: string): void {
  const fixed = new Set([
    ...DELIVERY_SOURCE_FILES.map((entry) => entry.destination),
    ...GENERATED_FILES
  ]);
  if (fixed.has(path)) return;
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
    ['service/build-context/context-manifest.json', artifacts.service_build_context.manifest_sha256]
  ];
  for (const [path, expected] of checks) {
    if (sha256(join(outputDir, path)) !== expected) throw new Error(`artifact checksum mismatch: ${path}`);
  }
  if (treeSha256(join(outputDir, artifacts.reference_client.path)) !== artifacts.reference_client.tree_sha256) {
    throw new Error('reference client tree checksum mismatch');
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
    real_environment_acceptance: result.manifest.real_environment_acceptance
  }, null, 2)}\n`);
}
