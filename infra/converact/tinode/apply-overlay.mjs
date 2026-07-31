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

export function patchTinodeDockerfile(source) {
  let next = source;
  if (!next.includes('FROM ${IVEKIT_TINODE_BUILDER_IMAGE} AS ivekit-builder')) {
    next = replaceOnce(
      next,
      'FROM alpine:3.22',
      'ARG IVEKIT_TINODE_BUILDER_IMAGE\n' +
        'ARG IVEKIT_TINODE_RUNTIME_IMAGE\n' +
        'FROM ${IVEKIT_TINODE_BUILDER_IMAGE} AS ivekit-builder\n' +
        'ARG TARGETARCH\n' +
        'ARG TARGET_DB=postgres\n' +
        'WORKDIR /src\n' +
        'COPY go.mod go.sum ./\n' +
        'COPY ivekit/ ivekit/\n' +
        'COPY vendor/ vendor/\n' +
        'ENV GOFLAGS=-mod=vendor\n' +
        'COPY . .\n' +
        'RUN mkdir -p /out && \\\n' +
        '\tGOCACHE=/tmp/ivekit-tinode-go-cache CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go test -tags "${TARGET_DB}" ./server ./server/db/postgres && \\\n' +
        '\tGOCACHE=/tmp/ivekit-tinode-go-cache CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -trimpath -ldflags "-s -w -X main.buildstamp=v0.25.3-ivekit.3" -tags "${TARGET_DB}" -o /out/tinode ./server && \\\n' +
        '\tGOCACHE=/tmp/ivekit-tinode-go-cache CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -trimpath -ldflags "-s -w" -tags "${TARGET_DB}" -o /out/init-db ./tinode-db && \\\n' +
        '\trm -rf /tmp/ivekit-tinode-go-cache\n\n' +
        'FROM ${IVEKIT_TINODE_RUNTIME_IMAGE}',
      'Dockerfile source builder'
    );
  }
  next = replaceOnce(
    next,
    'COPY . .',
    'COPY pbx/ pbx/\nCOPY server/ server/\nCOPY tinode-db/ tinode-db/',
    'Dockerfile source boundary'
  );
  next = replaceOnce(
    next,
    'COPY config.template .',
    'COPY docker/tinode/config.template .',
    'Dockerfile config path'
  );
  next = replaceOnce(
    next,
    'COPY entrypoint.sh .',
    'COPY docker/tinode/entrypoint.sh .',
    'Dockerfile entrypoint path'
  );
  if (!next.includes('COPY --from=ivekit-builder /out/tinode .')) {
    next = replaceOnce(
      next,
      'ADD https://github.com/tinode/chat/releases/download/v$BINVERS/tinode-$TARGET_DB.linux-amd64.tar.gz .',
      'COPY --from=ivekit-builder /out/tinode .\n' +
        'COPY --from=ivekit-builder /out/init-db .\n' +
        'COPY tinode-db/data.json .\n' +
        'COPY tinode-db/*.jpg .\n' +
        'COPY tinode-db/credentials.sh .',
      'Dockerfile release artifact'
    );
    const unpackPattern = /^RUN tar -xzf tinode-\$TARGET_DB\.linux-amd64\.tar\.gz(?: \\\n\t&&| &&) rm tinode-\$TARGET_DB\.linux-amd64\.tar\.gz\n?/m;
    const matches = [...next.matchAll(new RegExp(unpackPattern.source, 'gm'))];
    if (matches.length !== 1 || matches[0].index == null) {
      throw new Error('Tinode Dockerfile release unpack anchor mismatch');
    }
    next = next.slice(0, matches[0].index) +
      next.slice(matches[0].index + matches[0][0].length);
  }
  next = replaceOnce(
    next,
    'COPY tinode-db/*.jpg .',
    'COPY tinode-db/*.jpg ./',
    'Dockerfile wildcard destination'
  );
  if (next.includes('RUN apk update && \\\n\tapk add --no-cache ca-certificates bash grep')) {
    next = replaceOnce(
      next,
      'RUN apk update && \\\n\tapk add --no-cache ca-certificates bash grep',
      'COPY --from=ivekit-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt',
      'Dockerfile offline runtime certificates'
    );
  } else if (!next.includes('COPY --from=ivekit-builder /etc/ssl/certs/ca-certificates.crt')) {
    throw new Error('Tinode Dockerfile offline runtime certificates anchor mismatch');
  }
  if (!next.includes('ln -s /usr/local/bin/bash /bin/bash')) {
    next = replaceOnce(
      next,
      'COPY --from=ivekit-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt',
      'COPY --from=ivekit-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt\n' +
        'RUN test -x /usr/local/bin/bash && ln -s /usr/local/bin/bash /bin/bash',
      'Dockerfile Bash compatibility link'
    );
  }
  next = replaceOnce(
    next,
    'RUN mkdir /botdata',
    'RUN addgroup -g 10001 -S tinode && \\\n' +
      '\tadduser -S -D -H -u 10001 -G tinode tinode && \\\n' +
      '\tmkdir -p /botdata /opt/tinode/static /var/log && \\\n' +
      '\ttouch /var/log/tinode.log && \\\n' +
      '\tchown -R tinode:tinode /opt/tinode /botdata /var/log',
    'Dockerfile runtime directories'
  );
  if (!next.includes('USER tinode')) {
    next = replaceOnce(
      next,
      'RUN chmod +x credentials.sh',
      'RUN chmod +x credentials.sh\n\nUSER tinode',
      'Dockerfile non-root runtime'
    );
  }
  return next;
}

export function patchTinodeEntrypoint(source) {
  const marker = '# iveKit writable runtime and deterministic cluster bootstrap';
  if (source.includes(marker)) return source;

  let next = replaceOnce(
    source,
    '#!/bin/bash\n',
    '#!/bin/bash\n\n' +
      `${marker}\n` +
      'RUNTIME_DIR="${TINODE_RUNTIME_DIR:-/tmp/tinode-runtime}"\n' +
      'mkdir -p "${RUNTIME_DIR}"\n' +
      'FS_UPLOAD_DIR="${FS_UPLOAD_DIR:-${RUNTIME_DIR}/uploads}"\n' +
      'AWS_FORCE_PATH_STYLE="${AWS_FORCE_PATH_STYLE:-false}"\n' +
      'if [ "${MEDIA_HANDLER:-fs}" = "fs" ]; then\n' +
      '\tmkdir -p "${FS_UPLOAD_DIR}"\n' +
      'fi\n' +
      'TINODE_CLUSTER_NODE_0_NAME="${TINODE_CLUSTER_NODE_0_NAME:-tinode-0}"\n' +
      'TINODE_CLUSTER_NODE_0_ADDR="${TINODE_CLUSTER_NODE_0_ADDR:-tinode-0:12000}"\n' +
      'TINODE_CLUSTER_NODE_1_NAME="${TINODE_CLUSTER_NODE_1_NAME:-tinode-1}"\n' +
      'TINODE_CLUSTER_NODE_1_ADDR="${TINODE_CLUSTER_NODE_1_ADDR:-tinode-1:12001}"\n' +
      'TINODE_CLUSTER_NODE_2_NAME="${TINODE_CLUSTER_NODE_2_NAME:-tinode-2}"\n' +
      'TINODE_CLUSTER_NODE_2_ADDR="${TINODE_CLUSTER_NODE_2_ADDR:-tinode-2:12002}"\n',
    'entrypoint runtime preamble'
  );
  next = replaceOnce(
    next,
    '\tCONFIG=working.config',
    '\tCONFIG="${RUNTIME_DIR}/working.config"',
    'entrypoint generated config path'
  );
  next = replaceOnce(
    next,
    '\trm -f working.config',
    '\trm -f "${CONFIG}"',
    'entrypoint generated config cleanup'
  );
  next = replaceOnce(
    next,
    '\t\techo "$line" >> working.config',
    '\t\techo "$line" >> "${CONFIG}"',
    'entrypoint generated config write'
  );
  next = replaceOnce(
    next,
    '\tSTATIC_DIR=$EXT_STATIC_DIR',
    '\tSTATIC_DIR="$EXT_STATIC_DIR"',
    'entrypoint external static path'
  );
  next = replaceOnce(
    next,
    '\tSTATIC_DIR="./static"',
    '\tSTATIC_DIR="${RUNTIME_DIR}/static"',
    'entrypoint default static path'
  );
  next = replaceOnce(
    next,
    '\tSTATIC_DIR="${RUNTIME_DIR}/static"\nfi',
    '\tSTATIC_DIR="${RUNTIME_DIR}/static"\nfi\nmkdir -p "${STATIC_DIR}"',
    'entrypoint writable static directory'
  );
  next = next
    .replaceAll('> $STATIC_DIR/firebase-init.js', '> "${STATIC_DIR}/firebase-init.js"')
    .replaceAll('> $STATIC_DIR/apple-app-site-association', '> "${STATIC_DIR}/apple-app-site-association"');
  next = replaceOnce(
    next,
    'init_stdout=./init-db-stdout.txt',
    'init_stdout="${RUNTIME_DIR}/init-db-stdout.txt"',
    'entrypoint init output path'
  );
  next = replaceOnce(
    next,
    './init-db \\\n',
    '/opt/tinode/init-db \\\n',
    'entrypoint init binary path'
  );
  next = replaceOnce(
    next,
    'if [ $? -ne 0 ]; then\n\techo "./init-db failed. Quitting."\n\texit 1\nfi',
    'if [ $? -ne 0 ]; then\n\techo "/opt/tinode/init-db failed. Quitting."\n\texit 1\nfi\n\n' +
      'if [ "${TINODE_INIT_ONLY:-0}" = "1" ]; then\n' +
      '\texit 0\n' +
      'fi',
    'entrypoint init-only gate'
  );
  next = replaceOnce(
    next,
    '\t./credentials.sh /botdata/.tn-cookie < /botdata/tino-password',
    '\t/opt/tinode/credentials.sh /botdata/.tn-cookie < /botdata/tino-password',
    'entrypoint credentials binary path'
  );
  next = replaceOnce(
    next,
    './tinode "${args[@]}" 2>> /var/log/tinode.log',
    'exec /opt/tinode/tinode "${args[@]}" 2>> /var/log/tinode.log',
    'entrypoint server exec path'
  );
  return next;
}

export function patchTinodeConfigTemplate(source) {
  const replacements = [
    [
      '"upload_dir": "uploads"',
      '"upload_dir": "$FS_UPLOAD_DIR"'
    ],
    [
      '"endpoint": "$AWS_S3_ENDPOINT",',
      '"endpoint": "$AWS_S3_ENDPOINT",\n' +
        '\t\t\t\t"force_path_style": $AWS_FORCE_PATH_STYLE,'
    ],
    [
      '{"name": "tinode-0", "addr": "tinode-0:12000"}',
      '{"name": "$TINODE_CLUSTER_NODE_0_NAME", "addr": "$TINODE_CLUSTER_NODE_0_ADDR"}'
    ],
    [
      '{"name": "tinode-1", "addr": "tinode-1:12001"}',
      '{"name": "$TINODE_CLUSTER_NODE_1_NAME", "addr": "$TINODE_CLUSTER_NODE_1_ADDR"}'
    ],
    [
      '{"name": "tinode-2", "addr": "tinode-2:12002"}',
      '{"name": "$TINODE_CLUSTER_NODE_2_NAME", "addr": "$TINODE_CLUSTER_NODE_2_ADDR"}'
    ]
  ];
  let next = source;
  for (const [anchor, replacement] of replacements) {
    next = replaceOnce(next, anchor, replacement, 'Tinode cluster member template');
  }
  return next;
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
  const hookTestPath = join(sourceDir, 'server/ivekit_owner_test.go');
  const dockerfilePath = join(sourceDir, 'docker/tinode/Dockerfile');
  const entrypointPath = join(sourceDir, 'docker/tinode/entrypoint.sh');
  const configTemplatePath = join(sourceDir, 'docker/tinode/config.template');
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
  await writeFile(
    dockerfilePath,
    patchTinodeDockerfile(await readFile(dockerfilePath, 'utf8')),
    'utf8'
  );
  await writeFile(
    entrypointPath,
    patchTinodeEntrypoint(await readFile(entrypointPath, 'utf8')),
    'utf8'
  );
  await writeFile(
    configTemplatePath,
    patchTinodeConfigTemplate(await readFile(configTemplatePath, 'utf8')),
    'utf8'
  );
  await cp(join(repoRoot, 'infra/converact/tinode/server-hook.go'), hookPath, {
    force: true
  });
  await cp(
    join(repoRoot, 'infra/converact/tinode/server-hook_test.go'),
    hookTestPath,
    { force: true }
  );
  execFileSync(
    'gofmt',
    ['-w', mainPath, topicInitPath, topicPath, hookPath, hookTestPath],
    { stdio: 'inherit' }
  );
  const hotPathPatchStatus = applyPinnedPatch(
    sourceDir,
    join(
      repoRoot,
      'infra/converact/tinode/patches/tinode-ivekit-session-fanout-hot-path.patch'
    )
  );
  const postgresBootstrapPatchStatus = applyPinnedPatch(
    sourceDir,
    join(
      repoRoot,
      'infra/converact/tinode/patches/tinode-ivekit-postgres-bootstrap.patch'
    )
  );
  return {
    upstream_tag: TINODE_UPSTREAM_TAG,
    upstream_commit: TINODE_UPSTREAM_COMMIT,
    source_dir: sourceDir,
    hot_path_patch_status: hotPathPatchStatus,
    postgres_bootstrap_patch_status: postgresBootstrapPatchStatus
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
