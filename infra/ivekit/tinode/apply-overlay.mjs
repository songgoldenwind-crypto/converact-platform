#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TINODE_UPSTREAM_TAG = 'v0.25.3';
export const TINODE_UPSTREAM_COMMIT =
  '22a7c18e9cd695e9a061bf1b8c84175196ef5a15';

export function applyPinnedPatch(sourceDir, patchPath) {
  const check = ['-C', sourceDir, 'apply', '--check', patchPath];
  try {
    execFileSync('git', check, { stdio: 'pipe' });
    execFileSync(
      'git',
      ['-C', sourceDir, 'apply', '--whitespace=error-all', patchPath],
      { stdio: 'pipe' }
    );
    return 'applied';
  } catch (forwardError) {
    try {
      execFileSync(
        'git',
        ['-C', sourceDir, 'apply', '--reverse', '--check', patchPath],
        { stdio: 'pipe' }
      );
      return 'already_applied';
    } catch {
      const reason = forwardError instanceof Error
        ? forwardError.message
        : String(forwardError);
      throw new Error(`Tinode pinned patch does not apply: ${reason}`);
    }
  }
}

export function patchTinodeGoMod(source) {
  if (!source.startsWith('module github.com/tinode/chat\n')) {
    throw new Error('Tinode go.mod module identity mismatch');
  }
  if (!/^go 1\.26\.0$/m.test(source)) {
    throw new Error('Tinode go.mod toolchain identity mismatch');
  }
  const overlayFragments = [
    'ivekit.local/componenthook v0.0.0 // indirect',
    'ivekit.local/tinodeowner v0.0.0',
    'replace ivekit.local/componenthook => ./ivekit/component-hook-go',
    'replace ivekit.local/tinodeowner => ./ivekit/tinode-owner'
  ];
  const presentFragments = overlayFragments.filter((fragment) =>
    source.includes(fragment)
  );
  if (presentFragments.length === overlayFragments.length) return source;
  if (presentFragments.length > 0) {
    throw new Error('Tinode go.mod overlay is partially applied');
  }

  const indirectAnchor = '\tgolang.org/x/net v0.56.0 // indirect\n';
  const withComponentHook = source.includes(indirectAnchor)
    ? source.replace(
        indirectAnchor,
        `${indirectAnchor}\tivekit.local/componenthook v0.0.0 // indirect\n`
      )
    : `${source.trimEnd()}\n\nrequire ivekit.local/componenthook v0.0.0 // indirect\n`;
  return `${withComponentHook.trimEnd()}

require ivekit.local/tinodeowner v0.0.0

replace ivekit.local/componenthook => ./ivekit/component-hook-go

replace ivekit.local/tinodeowner => ./ivekit/tinode-owner
`;
}

export function patchTinodeMain(source) {
  let next = replaceOnce(
    source,
    '\t// Set up HTTP server. Must use non-default mux because of expvar.\n' +
      '\tmux := http.NewServeMux()\n\n' +
      '\t// Exposing values for statistics and monitoring.',
    '\t// Set up HTTP server. Must use non-default mux because of expvar.\n' +
      '\tmux := http.NewServeMux()\n' +
      '\tif err = ivekitUseStableClusterNodeID(clusterSelf); err != nil {\n' +
      '\t\tlogs.Err.Fatal(err)\n' +
      '\t}\n' +
      '\tif err = ivekitInitTopicOwners(mux); err != nil {\n' +
      '\t\tlogs.Err.Fatal(err)\n' +
      '\t}\n' +
      '\tdefer ivekitStopTopicOwners()\n' +
      '\t// Exposing values for statistics and monitoring.',
    'owner startup'
  );
  next = replaceOnce(
    next,
    '\t// Initialize cluster and receive calculated workerId.\n' +
      '\t// Cluster won\'t be started here yet.\n' +
      '\tworkerId := clusterInit(config.Cluster, clusterSelf)',
    '\t// Initialize cluster and receive calculated workerId.\n' +
      '\t// Cluster won\'t be started here yet. The iveKit hook has already\n' +
      '\t// aligned clusterSelf with the stable component-node identity.\n' +
      '\tworkerId := clusterInit(config.Cluster, clusterSelf)',
    'stable cluster identity'
  );
  return next;
}

export function patchTinodeTopicInit(source) {
  return replaceOnce(
    source,
    '\t}\n\n' +
      '\t// Failed to create or load the topic.\n' +
      '\tif err != nil {',
    '\t}\n' +
      '\tif err == nil {\n' +
      '\t\terr = ivekitOpenTopicOwner(t, timestamp)\n' +
      '\t\tif err != nil && (strings.HasPrefix(t.xoriginal, "new") ||\n' +
      '\t\t\tstrings.HasPrefix(t.xoriginal, "nch")) {\n' +
      '\t\t\tif cleanupErr := store.Topics.Delete(t.name, t.isChan, true); cleanupErr != nil {\n' +
      '\t\t\t\tlogs.Err.Printf("ivekit topic owner rollback failed: topic=%s err=%v", t.name, cleanupErr)\n' +
      '\t\t\t}\n' +
      '\t\t}\n' +
      '\t}\n\n' +
      '\t// Failed to create or load the topic.\n' +
      '\tif err != nil {',
    'topic owner open'
  );
}

export function patchTinodeTopic(source) {
  let next = replaceOnce(
    source,
    'func (t *Topic) handleClientMsg(msg *ClientComMessage) {\n' +
      '\tif msg.Pub != nil {',
    'func (t *Topic) handleClientMsg(msg *ClientComMessage) {\n' +
      '\tif err := ivekitAssertTopicOwner(t, time.Now()); err != nil {\n' +
      '\t\tmsg.sess.queueOut(ErrServiceUnavailableReply(msg, types.TimeNow()))\n' +
      '\t\treturn\n' +
      '\t}\n' +
      '\tif msg.Pub != nil {',
    'publish owner assertion'
  );
  next = replaceOnce(
    next,
    'func (t *Topic) handleMeta(msg *ClientComMessage) {\n' +
      '\t// Request to get/set topic metadata',
    'func (t *Topic) handleMeta(msg *ClientComMessage) {\n' +
      '\tif err := ivekitAssertTopicOwner(t, time.Now()); err != nil {\n' +
      '\t\tmsg.sess.queueOut(ErrServiceUnavailableReply(msg, types.TimeNow()))\n' +
      '\t\treturn\n' +
      '\t}\n' +
      '\t// Request to get/set topic metadata',
    'metadata owner assertion'
  );
  next = replaceOnce(
    next,
    'func (t *Topic) handleTopicTermination(sd *shutDown) {\n' +
      '\t// Handle four cases:',
    'func (t *Topic) handleTopicTermination(sd *shutDown) {\n' +
      '\tivekitCloseTopicOwner(t.name)\n' +
      '\t// Handle four cases:',
    'topic owner close'
  );
  return next;
}

export async function applyTinodeOverlay(input) {
  const sourceDir = resolve(input.sourceDir);
  const repoRoot = resolve(input.repoRoot || defaultRepoRoot());
  const commit = execFileSync(
    'git',
    ['-C', sourceDir, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
  if (commit !== TINODE_UPSTREAM_COMMIT) {
    throw new Error(
      `Tinode source commit mismatch: expected ${TINODE_UPSTREAM_COMMIT}, got ${commit}`
    );
  }
  const exactTag = execFileSync(
    'git',
    ['-C', sourceDir, 'describe', '--tags', '--exact-match', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
  if (exactTag !== TINODE_UPSTREAM_TAG) {
    throw new Error(
      `Tinode source tag mismatch: expected ${TINODE_UPSTREAM_TAG}, got ${exactTag}`
    );
  }

  const componentHookTarget = join(sourceDir, 'ivekit/component-hook-go');
  const ownerTarget = join(sourceDir, 'ivekit/tinode-owner');
  await mkdir(dirname(componentHookTarget), { recursive: true });
  await cp(
    join(repoRoot, 'integrations/component-hook-go'),
    componentHookTarget,
    { recursive: true, force: true }
  );
  await cp(
    join(repoRoot, 'integrations/tinode-v0.25.3'),
    ownerTarget,
    { recursive: true, force: true }
  );

  const goModPath = join(sourceDir, 'go.mod');
  const mainPath = join(sourceDir, 'server/main.go');
  const topicInitPath = join(sourceDir, 'server/init_topic.go');
  const topicPath = join(sourceDir, 'server/topic.go');
  const hookPath = join(sourceDir, 'server/ivekit_owner.go');
  await writeFile(
    goModPath,
    patchTinodeGoMod(await readFile(goModPath, 'utf8')),
    'utf8'
  );
  await writeFile(
    mainPath,
    patchTinodeMain(await readFile(mainPath, 'utf8')),
    'utf8'
  );
  await writeFile(
    topicInitPath,
    patchTinodeTopicInit(await readFile(topicInitPath, 'utf8')),
    'utf8'
  );
  await writeFile(
    topicPath,
    patchTinodeTopic(await readFile(topicPath, 'utf8')),
    'utf8'
  );
  await cp(join(repoRoot, 'infra/ivekit/tinode/server-hook.go'), hookPath, {
    force: true
  });
  execFileSync(
    'gofmt',
    ['-w', mainPath, topicInitPath, topicPath, hookPath],
    { stdio: 'inherit' }
  );
  const hotPathPatchStatus = applyPinnedPatch(
    sourceDir,
    join(
      repoRoot,
      'infra/ivekit/tinode/patches/tinode-ivekit-session-fanout-hot-path.patch'
    )
  );
  return {
    upstream_tag: TINODE_UPSTREAM_TAG,
    upstream_commit: TINODE_UPSTREAM_COMMIT,
    source_dir: sourceDir,
    hot_path_patch_status: hotPathPatchStatus
  };
}

function replaceOnce(source, anchor, replacement, label) {
  if (source.includes(replacement)) return source;
  const first = source.indexOf(anchor);
  const last = source.lastIndexOf(anchor);
  if (first < 0 || first !== last) {
    throw new Error(`Tinode ${label} anchor mismatch`);
  }
  return source.slice(0, first) + replacement +
    source.slice(first + anchor.length);
}

function defaultRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sourceDir = process.argv[2];
  if (!sourceDir) {
    console.error('usage: node apply-overlay.mjs <tinode-source-dir>');
    process.exitCode = 2;
  } else {
    applyTinodeOverlay({ sourceDir }).then((result) => {
      console.log(JSON.stringify(result));
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
