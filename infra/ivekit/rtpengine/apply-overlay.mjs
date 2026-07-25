#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RTPENGINE_UPSTREAM_TAG = 'mr26.0.1.13';
export const RTPENGINE_UPSTREAM_COMMIT =
  '506cfa74386a5373e40fca139a932917f22f0524';
export const RTPENGINE_ARCHIVE_SHA256 =
  'a6d23de8f656c3ad54e4060813c230861d100b79fb45ba1ce728ad2cef780143';
export const RTPENGINE_ARCHIVE_SIZE = 6_987_926;

const overlayRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const sourceLockPath = join(overlayRoot, 'source-lock.json');

export function applyPinnedPatch(sourceRoot, patchPath) {
  const root = resolve(sourceRoot);
  const patch = resolve(patchPath);
  try {
    execFileSync('git', ['-C', root, 'apply', '--check', patch], {
      stdio: 'pipe'
    });
    execFileSync(
      'git',
      ['-C', root, 'apply', '--whitespace=error-all', patch],
      { stdio: 'pipe' }
    );
    return 'applied';
  } catch (forwardError) {
    try {
      execFileSync(
        'git',
        ['-C', root, 'apply', '--reverse', '--check', patch],
        { stdio: 'pipe' }
      );
      return 'already_applied';
    } catch {
      const reason = forwardError instanceof Error
        ? forwardError.message
        : String(forwardError);
      throw new Error(`RTPengine pinned patch does not apply: ${reason}`);
    }
  }
}

function normalizedRelative(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

function optionalLstat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function sourceTreeSha256(sourceRoot, ignoredPaths = []) {
  const root = resolve(sourceRoot);
  const ignored = new Set(
    ignoredPaths.map((path) => normalizedRelative(root, resolve(path)))
  );
  const hash = createHash('sha256');

  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => {
        if (left.name < right.name) return -1;
        if (left.name > right.name) return 1;
        return 0;
      });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = normalizedRelative(root, path);
      if (name === '.git' || name.startsWith('.git/') || ignored.has(name)) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      hash.update(name);
      hash.update('\0');
      if (entry.isFile()) {
        const mode = lstatSync(path).mode & 0o111 ? '100755' : '100644';
        hash.update(`${mode}\0`);
        hash.update(readFileSync(path));
      } else if (entry.isSymbolicLink()) {
        hash.update('120000\0');
        hash.update(readlinkSync(path));
      } else {
        const kind = lstatSync(path).mode.toString(8);
        throw new Error(`RTPengine source contains unsupported entry: ${name} (${kind})`);
      }
      hash.update('\0');
    }
  }

  visit(root);
  return hash.digest('hex');
}

function assertPristineSource(sourceRoot, ignoredPaths) {
  const root = resolve(sourceRoot);
  const ignored = new Set(
    ignoredPaths.map((path) => normalizedRelative(root, resolve(path)))
  );
  const output = execFileSync(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const dirty = output
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter((path) => !ignored.has(path.replaceAll('\\', '/')));
  if (dirty.length > 0) {
    throw new Error(
      `RTPengine source is dirty or partially patched: ${dirty.slice(0, 8).join(', ')}`
    );
  }
}

function assertPatchSetIdentity(actual, expected) {
  for (const key of [
    'schema_version',
    'component_id',
    'source_commit',
    'patch_set_id',
    'patch_set_sha256'
  ]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`RTPengine patch-set identity mismatch: ${key}`);
    }
  }
  if (JSON.stringify(actual.patches) !== JSON.stringify(expected.patches)) {
    throw new Error('RTPengine patch-set identity mismatch: patches');
  }
  if (!/^[a-f0-9]{64}$/.test(String(actual.patched_tree_sha256 || ''))) {
    throw new Error('RTPengine patched source tree SHA-256 is missing');
  }
}

export function applyPinnedPatchSet(
  sourceRoot,
  patches,
  identityPath,
  expectedIdentity,
  ignoredPaths = []
) {
  const root = resolve(sourceRoot);
  const resolvedIdentityPath = resolve(identityPath);
  const treeIgnoredPaths = [...ignoredPaths, resolvedIdentityPath];
  const identityStat = optionalLstat(resolvedIdentityPath);
  if (identityStat && !identityStat.isFile()) {
    throw new Error('RTPengine patch-set identity must be a regular file');
  }
  if (identityStat) {
    const actualIdentity = JSON.parse(readFileSync(resolvedIdentityPath, 'utf8'));
    assertPatchSetIdentity(actualIdentity, expectedIdentity);
    const actualTreeSha256 = sourceTreeSha256(root, treeIgnoredPaths);
    if (actualTreeSha256 !== actualIdentity.patched_tree_sha256) {
      throw new Error('RTPengine patched source tree SHA-256 mismatch');
    }
    return {
      patch_set: structuredClone(actualIdentity),
      patch_results: patches.map(({ id, path }) => ({
        id,
        path,
        status: 'already_applied'
      }))
    };
  }

  assertPristineSource(root, treeIgnoredPaths);
  const patchResults = patches.map(({ id, path }) => ({
    id,
    path,
    status: applyPinnedPatch(root, path)
  }));
  const patchSetIdentity = {
    ...expectedIdentity,
    patched_tree_sha256: sourceTreeSha256(root, treeIgnoredPaths)
  };
  writeFileSync(
    resolvedIdentityPath,
    `${JSON.stringify(patchSetIdentity, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 }
  );
  return {
    patch_set: patchSetIdentity,
    patch_results: patchResults
  };
}

export function assertPinnedSource(sourceRoot) {
  const root = resolve(sourceRoot);
  const identityPath = join(root, 'ivekit-source-identity.json');
  if (!existsSync(identityPath)) {
    throw new Error('RTPengine source identity is missing');
  }
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  if (identity.component_id !== 'rtpengine') {
    throw new Error('RTPengine source component mismatch');
  }
  if (identity.version !== RTPENGINE_UPSTREAM_TAG ||
      identity.release_ref !== RTPENGINE_UPSTREAM_TAG) {
    throw new Error('RTPengine source version mismatch');
  }
  if (identity.commit !== RTPENGINE_UPSTREAM_COMMIT) {
    throw new Error('RTPengine source commit mismatch');
  }
  if (identity.archive_sha256 !== RTPENGINE_ARCHIVE_SHA256) {
    throw new Error('RTPengine source archive SHA-256 mismatch');
  }
  if (identity.archive_size_bytes !== RTPENGINE_ARCHIVE_SIZE) {
    throw new Error('RTPengine source archive size mismatch');
  }
  for (const required of [
    'README.md',
    'daemon/control_ng.c',
    'docs/ng_control_protocol.md',
    'kernel-module/Makefile'
  ]) {
    if (!existsSync(join(root, required))) {
      throw new Error(`RTPengine source file is missing: ${required}`);
    }
  }
  return structuredClone(identity);
}

export function applyIveKitRtpengineOverlay(sourceRoot) {
  const root = resolve(sourceRoot);
  const sourceIdentity = assertPinnedSource(root);
  const lock = JSON.parse(readFileSync(sourceLockPath, 'utf8'));
  const hash = createHash('sha256');
  const patches = [];
  const lockedPaths = new Set(lock.patch_set.patches.map((patch) => patch.path));
  const discoveredPaths = readdirSync(join(overlayRoot, 'patches'))
    .filter((name) => name.endsWith('.patch'))
    .map((name) => `patches/${name}`)
    .sort();
  if (JSON.stringify(discoveredPaths) !== JSON.stringify([...lockedPaths].sort())) {
    throw new Error('RTPengine patch directory contains an unlocked patch');
  }
  for (const patch of lock.patch_set.patches) {
    const path = join(overlayRoot, patch.path);
    if (!existsSync(path)) {
      throw new Error(`RTPengine locked patch is missing: ${patch.path}`);
    }
    const bytes = readFileSync(path);
    hash.update(`${patch.id}\0${patch.path}\0`);
    hash.update(bytes);
    hash.update('\0');
    patches.push({
      id: patch.id,
      path: patch.path,
      sourcePath: path
    });
  }
  const expectedIdentity = {
    schema_version: '1.0.0',
    component_id: 'rtpengine',
    source_commit: sourceIdentity.commit,
    patch_set_id: lock.patch_set.id,
    patch_set_sha256: hash.digest('hex'),
    patches: patches.map(({ id, path }) => ({ id, path }))
  };
  const applied = applyPinnedPatchSet(
    root,
    patches.map(({ id, path, sourcePath }) => ({
      id,
      path: sourcePath,
      identityPath: path
    })),
    join(root, 'ivekit-patch-set-identity.json'),
    expectedIdentity,
    [join(root, 'ivekit-source-identity.json')]
  );
  return {
    source: sourceIdentity,
    patch_set: applied.patch_set,
    patch_results: applied.patch_results.map((result, index) => ({
      id: result.id,
      path: patches[index].path,
      status: result.status
    }))
  };
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) &&
    pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMain()) {
  const sourceRoot = process.argv[2];
  if (!sourceRoot) {
    process.stderr.write(
      'usage: apply-overlay.mjs RTPENGINE_SOURCE_DIRECTORY\n'
    );
    process.exit(64);
  }
  try {
    process.stdout.write(
      `${JSON.stringify(applyIveKitRtpengineOverlay(sourceRoot))}\n`
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
