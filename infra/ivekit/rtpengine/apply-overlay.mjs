#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  const patchResults = [];
  const hash = createHash('sha256');
  for (const patch of lock.patch_set.patches) {
    const path = join(overlayRoot, patch.path);
    if (!existsSync(path)) {
      throw new Error(`RTPengine locked patch is missing: ${patch.path}`);
    }
    const bytes = readFileSync(path);
    hash.update(`${patch.id}\0${patch.path}\0`);
    hash.update(bytes);
    hash.update('\0');
    patchResults.push({
      id: patch.id,
      path: patch.path,
      status: applyPinnedPatch(root, path)
    });
  }
  const patchSetIdentity = {
    schema_version: '1.0.0',
    component_id: 'rtpengine',
    source_commit: sourceIdentity.commit,
    patch_set_id: lock.patch_set.id,
    patch_set_sha256: hash.digest('hex'),
    patches: patchResults.map(({ id, path }) => ({ id, path }))
  };
  writeFileSync(
    join(root, 'ivekit-patch-set-identity.json'),
    `${JSON.stringify(patchSetIdentity, null, 2)}\n`,
    { mode: 0o644 }
  );
  return {
    source: sourceIdentity,
    patch_set: patchSetIdentity,
    patch_results: patchResults
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
