import { resolveFabricEnv } from '../src/config/converact-env.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeIveKitStandaloneSourceGraph,
  assertIveKitStandaloneBoundary,
  readIveKitStandaloneSourcePolicy,
  type IveKitStandaloneSourceGraph
} from './ivekit-standalone-source-graph.js';
import { generateIveKitServiceLock } from './generate-ivekit-service-lock.js';

export interface IveKitStandaloneContextFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface IveKitStandaloneContextManifest {
  schema_version: 1;
  product: 'iveKit standalone service';
  status: 'ready_to_build';
  source_commit: string;
  generated_at: string;
  entrypoints: string[];
  source_files: number;
  runtime_packages: string[];
  files: IveKitStandaloneContextFile[];
}

export interface BuildIveKitStandaloneContextOptions {
  repoRoot: string;
  outputDir: string;
  sourceCommit?: string;
  generatedAt?: string;
}

const MARKER = '.ivekit-standalone-context';
const MANIFEST = 'context-manifest.json';
const CHECKSUMS = 'SHA256SUMS';

export function buildIveKitStandaloneContext(
  options: BuildIveKitStandaloneContextOptions
): { outputDir: string; manifest: IveKitStandaloneContextManifest } {
  const repoRoot = resolve(options.repoRoot);
  const outputDir = resolve(options.outputDir);
  const sourceCommit = resolveIveKitStandaloneSourceCommit(repoRoot, options.sourceCommit);
  const policy = readIveKitStandaloneSourcePolicy(repoRoot);
  const graph = analyzeIveKitStandaloneSourceGraph({ repoRoot, entrypoints: policy.entrypoints });
  assertIveKitStandaloneBoundary(graph, policy.forbidden_prefixes);
  assertPackageBoundary(repoRoot, graph);
  assertServiceLockCurrent(repoRoot);
  assertSafeOutput(repoRoot, outputDir);
  assertReplaceable(outputDir);

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, MARKER), 'ivekit-standalone-context-v1\n', 'utf8');

  for (const path of graph.files) copy(repoRoot, outputDir, path, path);
  for (const source of policy.assets) copy(repoRoot, outputDir, source, basename(source));
  copy(repoRoot, outputDir, 'services/converact-service/source-policy.json', 'source-policy.json');
  for (const migration of policy.migrations || []) {
    const source = migration.includes('/') ? migration : `src/migrations/${migration}`;
    copy(repoRoot, outputDir, source, `migrations/${basename(migration)}`);
  }

  assertNoSymlinks(outputDir);
  const payload = listFiles(outputDir);
  const manifest: IveKitStandaloneContextManifest = {
    schema_version: 1,
    product: 'iveKit standalone service',
    status: 'ready_to_build',
    source_commit: sourceCommit,
    generated_at: options.generatedAt || new Date().toISOString(),
    entrypoints: graph.entrypoints,
    source_files: graph.files.length,
    runtime_packages: graph.packages,
    files: payload.map((path) => fileEntry(outputDir, path))
  };
  writeFileSync(join(outputDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const checksummed = listFiles(outputDir).filter((path) => path !== CHECKSUMS);
  writeFileSync(join(outputDir, CHECKSUMS), checksummed
    .map((path) => `${sha256(join(outputDir, path))}  ${path}`)
    .join('\n') + '\n', 'utf8');

  validateIveKitStandaloneContext(outputDir);
  return { outputDir, manifest };
}

export function validateIveKitStandaloneContext(outputDirInput: string): IveKitStandaloneContextManifest {
  const outputDir = resolve(outputDirInput);
  assertNoSymlinks(outputDir);
  const files = listFiles(outputDir);
  for (const required of [MARKER, MANIFEST, CHECKSUMS, 'package.json', 'package-lock.json', 'Dockerfile']) {
    if (!files.includes(required)) throw new Error(`standalone context is missing ${required}`);
  }
  for (const path of files) {
    if (/^(?:frontend|test|tests)\//.test(path) || path.includes('/agent-runtime/call-center/') || path.includes('/agent-runtime/ivr/')) {
      throw new Error(`standalone context contains forbidden source: ${path}`);
    }
  }

  const manifest = JSON.parse(readFileSync(join(outputDir, MANIFEST), 'utf8')) as IveKitStandaloneContextManifest;
  if (manifest.schema_version !== 1 || manifest.product !== 'iveKit standalone service') {
    throw new Error('invalid iveKit standalone context manifest');
  }
  const payload = files.filter((path) => path !== MANIFEST && path !== CHECKSUMS);
  if (JSON.stringify(manifest.files.map((entry) => entry.path)) !== JSON.stringify(payload)) {
    throw new Error('standalone context manifest file list mismatch');
  }
  for (const entry of manifest.files) {
    const actual = fileEntry(outputDir, entry.path);
    if (entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256) {
      throw new Error(`standalone context checksum mismatch: ${entry.path}`);
    }
  }
  const expectedChecksums = files
    .filter((path) => path !== CHECKSUMS)
    .map((path) => `${sha256(join(outputDir, path))}  ${path}`)
    .join('\n') + '\n';
  if (readFileSync(join(outputDir, CHECKSUMS), 'utf8') !== expectedChecksums) {
    throw new Error('standalone context SHA256SUMS mismatch');
  }
  return manifest;
}

function assertPackageBoundary(repoRoot: string, graph: IveKitStandaloneSourceGraph): void {
  const servicePackage = JSON.parse(readFileSync(
    join(repoRoot, 'services', 'converact-service', 'package.json'),
    'utf8'
  )) as { dependencies?: Record<string, string> };
  const declared = Object.keys(servicePackage.dependencies || {}).sort();
  if (JSON.stringify(declared) !== JSON.stringify(graph.packages)) {
    throw new Error([
      'iveKit service runtime dependencies do not match the source graph',
      `declared: ${declared.join(', ')}`,
      `required: ${graph.packages.join(', ')}`
    ].join('\n'));
  }
}

function assertServiceLockCurrent(repoRoot: string): void {
  const expected = generateIveKitServiceLock(repoRoot);
  const actual = JSON.parse(readFileSync(
    join(repoRoot, 'services', 'converact-service', 'package-lock.json'),
    'utf8'
  ));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('iveKit service package-lock.json is stale; run scripts/generate-ivekit-service-lock.ts');
  }
}

function assertSafeOutput(repoRoot: string, outputDir: string): void {
  if (outputDir === repoRoot || outputDir === resolve('/') || outputDir === resolve(repoRoot, '..')) {
    throw new Error('refusing unsafe iveKit standalone context directory');
  }
  for (const protectedPath of ['src', 'scripts', 'services', 'docs', 'test', 'clients', 'infra']) {
    const absolute = resolve(repoRoot, protectedPath);
    if (outputDir === absolute || absolute.startsWith(`${outputDir}${sep}`)) {
      throw new Error('refusing context output that contains repository source directories');
    }
  }
}

function assertReplaceable(outputDir: string): void {
  if (!existsSync(outputDir)) return;
  const marker = join(outputDir, MARKER);
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== 'ivekit-standalone-context-v1\n') {
    throw new Error('refusing to replace an existing directory without the iveKit ownership marker');
  }
}

function assertNoSymlinks(root: string): void {
  for (const path of listPaths(root)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`standalone context symlink is not allowed: ${relative(root, path)}`);
  }
}

function copy(repoRoot: string, outputDir: string, sourcePath: string, destinationPath: string): void {
  const source = resolve(repoRoot, sourcePath);
  if (!source.startsWith(`${repoRoot}${sep}`) || !existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`iveKit standalone source is missing or invalid: ${sourcePath}`);
  }
  const destination = join(outputDir, destinationPath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function fileEntry(root: string, path: string): IveKitStandaloneContextFile {
  const absolute = join(root, path);
  return { path, bytes: statSync(absolute).size, sha256: sha256(absolute) };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else files.push(relative(root, absolute).split(sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

function listPaths(root: string): string[] {
  const paths: string[] = [];
  const visit = (current: string): void => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const absolute = join(current, name);
      paths.push(absolute);
      if (lstatSync(absolute).isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return paths;
}

function gitCommit(repoRoot: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot resolve iveKit source commit: ${result.stderr || ''}`);
  return result.stdout.trim();
}

export function resolveIveKitStandaloneSourceCommit(repoRoot: string, override?: string): string {
  const sourceCommit = override?.trim() || gitCommit(repoRoot);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error('iveKit source commit must be a full 40-character Git commit');
  }
  return sourceCommit;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const outputDir = resolve(resolveFabricEnv(process.env, 'STANDALONE_CONTEXT_DIR') || join(repoRoot, '.tmp', 'ivekit-standalone-context'));
  const result = buildIveKitStandaloneContext({
    repoRoot,
    outputDir,
    sourceCommit: resolveFabricEnv(process.env, 'SOURCE_COMMIT')
  });
  process.stdout.write(`${JSON.stringify({
    output_dir: result.outputDir,
    source_commit: result.manifest.source_commit,
    source_files: result.manifest.source_files,
    payload_files: result.manifest.files.length,
    runtime_packages: result.manifest.runtime_packages
  }, null, 2)}\n`);
}
