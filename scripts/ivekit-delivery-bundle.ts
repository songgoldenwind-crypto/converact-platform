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
  sourceCommit?: string;
  generatedAt?: string;
}

const COMMUNICATION_MIGRATIONS = [
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
  '040_rustdesk_control_ownership.sql'
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
  ...COMMUNICATION_MIGRATIONS.map((name) => ({
    source: `src/migrations/${name}`,
    destination: `database/migrations/${name}`
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
  ].map((name) => ({ source: `scripts/${name}`, destination: `examples/${name}` }))
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
  '', '.conf', '.css', '.html', '.js', '.json', '.md', '.mjs', '.sh', '.sql', '.ts', '.txt', '.yaml', '.yml'
]);

export function buildIveKitDeliveryBundle(
  options: BuildIveKitDeliveryBundleOptions
): { outputDir: string; manifest: IveKitDeliveryManifest } {
  const repoRoot = resolve(options.repoRoot);
  const outputDir = resolve(options.outputDir);
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

  cpSync(options.clientDist, join(outputDir, 'client'), { recursive: true, dereference: false });
  copyFile(outputDir, options.sdkTarball, `sdk/${basename(options.sdkTarball)}`);
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
    source_commit: options.sourceCommit || resolveSourceCommit(repoRoot),
    generated_at: options.generatedAt || new Date().toISOString(),
    contents: {
      sdk: 'sdk/',
      reference_client: 'client/',
      deployment: 'deploy/',
      database: 'database/migrations/',
      documentation: 'docs/',
      acceptance: 'acceptance/status.json'
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
      clientDist: join(repoRoot, 'clients', 'ivekit-reference', 'dist')
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
    '',
    '## Integrity',
    '',
    '`manifest.json` records SHA-256 and size for every payload file. `SHA256SUMS` additionally covers the manifest.',
    'The checksum file intentionally cannot checksum itself.',
    '',
    '## Deployment boundary',
    '',
    'The Compose stack references an iveKit application image. Build or distribute that image from the same source commit',
    'recorded in `manifest.json`; this bundle deliberately does not copy the wider OPC source tree.',
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
