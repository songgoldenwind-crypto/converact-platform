import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as tinodeOverlay from '../infra/converact/tinode/apply-overlay.mjs';

import {
  TINODE_UPSTREAM_COMMIT,
  TINODE_UPSTREAM_TAG,
  applyPinnedPatch,
  patchTinodeGoMod,
  patchTinodeMain,
  patchTinodeTopic,
  patchTinodeTopicInit
} from '../infra/converact/tinode/apply-overlay.mjs';

test('Tinode owner overlay is exact-release bound', () => {
  assert.equal(TINODE_UPSTREAM_TAG, 'v0.25.3');
  assert.equal(
    TINODE_UPSTREAM_COMMIT,
    '22a7c18e9cd695e9a061bf1b8c84175196ef5a15'
  );
});

test('Tinode main overlay aligns cluster_self before cluster initialization', () => {
  const patched = patchTinodeMain(mainFixture());

  assert.match(patched, /ivekitUseStableClusterNodeID\(clusterSelf\)/);
  assert.match(patched, /ivekitInitTopicOwners\(mux\)/);
  assert.match(patched, /defer ivekitStopTopicOwners\(\)/);
  assert.ok(
    patched.indexOf('ivekitUseStableClusterNodeID') <
      patched.indexOf('clusterInit(config.Cluster, clusterSelf)')
  );
  assert.equal(patchTinodeMain(patched), patched);
});

test('Tinode topic overlay opens before actor start and fences mutation boundaries', () => {
  const initialized = patchTinodeTopicInit(topicInitFixture());
  const topic = patchTinodeTopic(topicFixture());

  assert.match(initialized, /err = ivekitOpenTopicOwner\(t, timestamp\)/);
  assert.match(
    initialized,
    /store\.Topics\.Delete\(t\.name, t\.isChan, true\)/
  );
  assert.ok(
    initialized.indexOf('ivekitOpenTopicOwner') <
      initialized.indexOf('go t.run(h)')
  );
  assert.match(
    topic,
    /func \(t \*Topic\) handleClientMsg[\s\S]*ivekitAssertTopicOwner/
  );
  assert.match(
    topic,
    /func \(t \*Topic\) handleMeta[\s\S]*ivekitAssertTopicOwner/
  );
  assert.match(topic, /ivekitCloseTopicOwner\(t\.name\)/);
  assert.equal(patchTinodeTopicInit(initialized), initialized);
  assert.equal(patchTinodeTopic(topic), topic);
});

test('Tinode owner overlay adds only local replace modules', () => {
  const patched = patchTinodeGoMod(
    'module github.com/tinode/chat\n\ngo 1.26.0\n'
  );
  assert.match(patched, /require ivekit\.local\/tinodeowner v0\.0\.0/);
  assert.match(
    patched,
    /ivekit\.local\/componenthook v0\.0\.0 \/\/ indirect/
  );
  assert.match(
    patched,
    /replace ivekit\.local\/componenthook => \.\/ivekit\/component-hook-go/
  );
  assert.match(
    patched,
    /replace ivekit\.local\/tinodeowner => \.\/ivekit\/tinode-owner/
  );
  assert.equal(patchTinodeGoMod(patched), patched);
});

test('Tinode pinned source patch is exact and idempotent', () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'ivekit-tinode-patch-'));
  const patchPath = join(sourceDir, 'change.patch');
  try {
    execFileSync('git', ['init', '--quiet', sourceDir]);
    writeFileSync(join(sourceDir, 'sample.txt'), 'before\n');
    writeFileSync(
      patchPath,
      [
        'diff --git a/sample.txt b/sample.txt',
        '--- a/sample.txt',
        '+++ b/sample.txt',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        ''
      ].join('\n')
    );

    assert.equal(applyPinnedPatch(sourceDir, patchPath), 'applied');
    assert.equal(applyPinnedPatch(sourceDir, patchPath), 'already_applied');
    assert.equal(readFileSync(join(sourceDir, 'sample.txt'), 'utf8'), 'after\n');
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('Tinode hot-path patch keeps personalized and cluster messages isolated', () => {
  const source = readFileSync(
    'infra/converact/tinode/patches/tinode-ivekit-session-fanout-hot-path.patch',
    'utf8'
  );

  assert.match(source, /atomic\.Pointer\[time\.Timer\]/);
  assert.match(source, /background atomic\.Bool/);
  assert.match(source, /background\.CompareAndSwap\(true, false\)/);
  assert.match(source, /messageForSession/);
  assert.match(source, /TestIvekitForegroundSessionDoesNotAllocateBackgroundTimer/);
  assert.match(source, /TestIvekitGroupBroadcastSharesReadOnlyMessage/);
  assert.match(source, /TopicCatP2P/);
  assert.match(source, /isChan/);
  assert.match(source, /sess\.isCluster\(\)/);
  assert.doesNotMatch(source, /\b(?:postgres|redis|nats)\b/i);
  assert.doesNotMatch(source, /http\.(?:Get|Post|Do)/);
});

test('Tinode PostgreSQL bootstrap patch handles absent and precreated databases safely', () => {
  const source = readFileSync(
    'infra/converact/tinode/patches/tinode-ivekit-postgres-bootstrap.patch',
    'utf8'
  );

  assert.match(source, /ConnConfig\.Database = "postgres"/);
  assert.match(source, /SELECT EXISTS \(SELECT 1 FROM pg_database/);
  assert.match(source, /pgx\.Identifier\{a\.dbName\}\.Sanitize\(\)/);
  assert.match(source, /errors\.As\(err, &pgErr\)/);
  assert.match(source, /ivekit_bootstrap_test\.go/);
  assert.match(source, /TestIvekitMissingDatabaseClassification/);
});

test('Tinode overlay makes the upstream runtime image compile the Converact Fabric source', () => {
  const patchDockerfile = (tinodeOverlay as Record<string, unknown>)
    .patchTinodeDockerfile;
  assert.equal(typeof patchDockerfile, 'function');

  const patched = (patchDockerfile as (source: string) => string)(
    tinodeDockerfileFixture()
  );
  assert.match(patched, /ARG IVEKIT_TINODE_BUILDER_IMAGE/);
  assert.match(patched, /ARG IVEKIT_TINODE_RUNTIME_IMAGE/);
  assert.match(patched, /FROM \$\{IVEKIT_TINODE_BUILDER_IMAGE\} AS ivekit-builder/);
  assert.match(patched, /FROM \$\{IVEKIT_TINODE_RUNTIME_IMAGE\}/);
  assert.match(patched, /COPY ivekit\/ ivekit\//);
  assert.match(patched, /COPY vendor\/ vendor\//);
  assert.match(patched, /COPY pbx\/ pbx\//);
  assert.match(patched, /COPY server\/ server\//);
  assert.match(patched, /COPY tinode-db\/ tinode-db\//);
  assert.doesNotMatch(patched, /^COPY \. \.$/m);
  assert.match(patched, /GOFLAGS=-mod=vendor/);
  assert.doesNotMatch(patched, /go mod download/);
  assert.match(patched, /GOCACHE=\/tmp\/ivekit-tinode-go-cache/);
  assert.match(patched, /rm -rf \/tmp\/ivekit-tinode-go-cache/);
  assert.match(patched, /go build[\s\S]*-o \/out\/tinode \.\/server/);
  assert.match(patched, /main\.buildstamp=v0\.25\.3-ivekit\.3/);
  assert.match(patched, /go build[\s\S]*-o \/out\/init-db \.\/tinode-db/);
  assert.match(patched, /COPY --from=ivekit-builder \/out\/tinode \./);
  assert.match(patched, /COPY docker\/tinode\/config\.template \./);
  assert.match(patched, /COPY tinode-db\/credentials\.sh \./);
  assert.match(patched, /COPY tinode-db\/\*\.jpg \.\//);
  assert.doesNotMatch(patched, /COPY tinode-db\/\*\.jpg \.\n/);
  assert.match(patched, /adduser[\s\S]*-u 10001[\s\S]*tinode/);
  assert.match(patched, /chown -R tinode:tinode \/opt\/tinode \/botdata \/var\/log/);
  assert.match(patched, /ln -s \/usr\/local\/bin\/bash \/bin\/bash/);
  assert.match(patched, /USER tinode/);
  assert.doesNotMatch(patched, /github\.com\/tinode\/chat\/releases\/download/);
  assert.equal(
    (patchDockerfile as (source: string) => string)(patched),
    patched
  );
});

test('Tinode runtime overlay keeps generated state writable under a read-only root filesystem', () => {
  const patchEntrypoint = (tinodeOverlay as Record<string, unknown>)
    .patchTinodeEntrypoint;
  assert.equal(typeof patchEntrypoint, 'function');

  const patched = (patchEntrypoint as (source: string) => string)(
    tinodeEntrypointFixture()
  );
  assert.match(patched, /TINODE_RUNTIME_DIR/);
  assert.match(patched, /FS_UPLOAD_DIR/);
  assert.match(patched, /MEDIA_HANDLER.*fs/);
  assert.match(patched, /CONFIG="\$\{RUNTIME_DIR\}\/working\.config"/);
  assert.match(patched, /init_stdout="\$\{RUNTIME_DIR\}\/init-db-stdout\.txt"/);
  assert.match(patched, /mkdir -p "\$\{STATIC_DIR\}"/);
  assert.match(patched, /TINODE_INIT_ONLY/);
  assert.match(patched, /\/opt\/tinode\/init-db/);
  assert.match(patched, /exec \/opt\/tinode\/tinode/);
  assert.equal(
    (patchEntrypoint as (source: string) => string)(patched),
    patched
  );
});

test('Tinode config overlay parameterizes stable StatefulSet cluster members', () => {
  const patchConfigTemplate = (tinodeOverlay as Record<string, unknown>)
    .patchTinodeConfigTemplate;
  assert.equal(typeof patchConfigTemplate, 'function');

  const patched = (patchConfigTemplate as (source: string) => string)(
    tinodeConfigTemplateFixture()
  );
  for (const index of [0, 1, 2]) {
    assert.match(patched, new RegExp(`\\$TINODE_CLUSTER_NODE_${index}_NAME`));
    assert.match(patched, new RegExp(`\\$TINODE_CLUSTER_NODE_${index}_ADDR`));
  }
  assert.match(patched, /"upload_dir": "\$FS_UPLOAD_DIR"/);
  assert.match(patched, /"force_path_style": \$AWS_FORCE_PATH_STYLE/);
  assert.equal(
    (patchConfigTemplate as (source: string) => string)(patched),
    patched
  );
});

test('Tinode build files retain the real upstream compile boundary', () => {
  const build = readFileSync('infra/converact/tinode/build.sh', 'utf8');
  const publicBuild = readFileSync('infra/converact/tinode/build-converact.sh', 'utf8');
  const readme = readFileSync('infra/converact/tinode/README.md', 'utf8');
  const hook = readFileSync('infra/converact/tinode/server-hook.go', 'utf8');

  assert.match(
    build,
    /go test -C "\$\{TINODE_SOURCE_DIR\}" -tags postgres/
  );
  assert.match(build, /\.\/server \.\/server\/db\/postgres/);
  assert.match(build, /ivekit\/component-hook-go" \.\/\.\.\./);
  assert.match(build, /ivekit\/tinode-owner" \.\/\.\.\./);
  assert.doesNotMatch(build, /\.\/ivekit\/\.\.\./);
  assert.match(build, /docker build/);
  assert.match(build, /org\.opencontainers\.image\.version=v0\.25\.3-ivekit\.3/);
  assert.match(build, /--file "\$\{TINODE_SOURCE_DIR\}\/docker\/tinode\/Dockerfile"/);
  assert.match(build, /--build-arg "TARGET_DB=\$\{TINODE_TARGET_DB:-postgres\}"/);
  assert.match(build, /IVEKIT_TINODE_IMAGE/);
  assert.match(build, /IVEKIT_TINODE_BUILDER_IMAGE/);
  assert.match(build, /IVEKIT_TINODE_RUNTIME_IMAGE/);
  assert.match(build, /IVEKIT_TINODE_TARGETARCH/);
  assert.match(publicBuild, /CONVERACT_FABRIC_TINODE_IMAGE/);
  assert.match(publicBuild, /CONVERACT_FABRIC_TINODE_BUILDER_IMAGE/);
  assert.match(publicBuild, /CONVERACT_FABRIC_TINODE_RUNTIME_IMAGE/);
  assert.match(publicBuild, /CONVERACT_FABRIC_TINODE_TARGETARCH/);
  assert.match(publicBuild, /converact_env_resolve_fabric/);
  assert.match(publicBuild, /exec "\$SCRIPT_DIR\/build\.sh"/);
  assert.match(build, /IVEKIT_TINODE_BUILDER_IMAGE/);
  assert.match(build, /IVEKIT_TINODE_RUNTIME_IMAGE/);
  assert.match(build, /@sha256:\[a-f0-9\]/);
  assert.match(build, /go -C "\$\{TINODE_SOURCE_DIR\}" mod vendor/);
  assert.match(build, /--network=none/);
  assert.match(build, /--build-arg "IVEKIT_TINODE_BUILDER_IMAGE=/);
  assert.match(build, /--build-arg "IVEKIT_TINODE_RUNTIME_IMAGE=/);
  assert.match(build, /image user[\s\S]*tinode/);
  assert.match(build, /IVEKIT_COMPONENT_NODE_ID/);
  assert.match(readme, /Go 1\.26/);
  assert.match(readme, /remain `not_run`/);
  assert.match(hook, /IVEKIT_COMPONENT_NODE_ID/);
  assert.match(hook, /IVEKIT_TINODE_CLUSTER_MODE/);
  assert.match(hook, /case "standalone"/);
  assert.match(hook, /case "", "clustered"/);
  assert.match(hook, /ivekitTopicOwners\.Assert/);
  assert.doesNotMatch(hook, /fanout/);
});

function tinodeDockerfileFixture(): string {
  return [
    'FROM alpine:3.22',
    'ARG TARGET_DB=mysql',
    'ENV TARGET_DB=$TARGET_DB',
    'RUN apk update && \\',
    '\tapk add --no-cache ca-certificates bash grep',
    'WORKDIR /opt/tinode',
    'COPY config.template .',
    'COPY entrypoint.sh .',
    'ADD https://github.com/tinode/chat/releases/download/v$BINVERS/tinode-$TARGET_DB.linux-amd64.tar.gz .',
    'RUN tar -xzf tinode-$TARGET_DB.linux-amd64.tar.gz && rm tinode-$TARGET_DB.linux-amd64.tar.gz',
    'RUN mkdir /botdata',
    'RUN chmod +x entrypoint.sh',
    'RUN chmod +x credentials.sh',
    ''
  ].join('\n');
}

function tinodeEntrypointFixture(): string {
  return [
    '#!/bin/bash',
    '',
    'if [ ! -z "$EXT_CONFIG" ] ; then',
    '\tCONFIG="$EXT_CONFIG"',
    'else',
    '\tCONFIG=working.config',
    '\trm -f working.config',
    '\twhile IFS=\'\' read -r line || [[ -n $line ]] ; do',
    '\t\techo "$line" >> working.config',
    '\tdone < config.template',
    'fi',
    'if [ ! -z "$EXT_STATIC_DIR" ] ; then',
    '\tSTATIC_DIR=$EXT_STATIC_DIR',
    'else',
    '\tSTATIC_DIR="./static"',
    'fi',
    'echo "" > $STATIC_DIR/firebase-init.js',
    'init_stdout=./init-db-stdout.txt',
    './init-db \\',
    '\t--reset=${RESET_DB} \\',
    '\t--upgrade=${UPGRADE_DB} \\',
    '\t--config=${CONFIG} \\',
    '\t--data=${SAMPLE_DATA} \\',
    '\t--no_init=${NO_DB_INIT} \\',
    '\t1>${init_stdout}',
    'if [ $? -ne 0 ]; then',
    '\techo "./init-db failed. Quitting."',
    '\texit 1',
    'fi',
    'if [ -s /botdata/tino-password ] ; then',
    '\t./credentials.sh /botdata/.tn-cookie < /botdata/tino-password',
    'fi',
    'args=("--config=${CONFIG}" "--static_data=$STATIC_DIR" "--cluster_self=$CLUSTER_SELF" "--pprof_url=$PPROF_URL")',
    './tinode "${args[@]}" 2>> /var/log/tinode.log',
    ''
  ].join('\n');
}

function tinodeConfigTemplateFixture(): string {
  return [
    '{',
    '\t"media": {',
    '\t\t"handlers": {',
    '\t\t\t"fs": {"upload_dir": "uploads"},',
    '\t\t\t"s3": {',
    '\t\t\t\t"endpoint": "$AWS_S3_ENDPOINT",',
    '\t\t\t\t"presign_ttl": 3600',
    '\t\t\t}',
    '\t\t}',
    '\t},',
    '\t"cluster_config": {',
    '\t\t"self": "",',
    '\t\t"nodes": [',
    '\t\t\t{"name": "tinode-0", "addr": "tinode-0:12000"},',
    '\t\t\t{"name": "tinode-1", "addr": "tinode-1:12001"},',
    '\t\t\t{"name": "tinode-2", "addr": "tinode-2:12002"}',
    '\t\t]',
    '\t}',
    '}',
    ''
  ].join('\n');
}

function mainFixture(): string {
  return [
    'package main',
    '',
    'func main() {',
    '\t// Set up HTTP server. Must use non-default mux because of expvar.',
    '\tmux := http.NewServeMux()',
    '',
    '\t// Exposing values for statistics and monitoring.',
    '\tstatsInit(mux, evpath)',
    '\t// Initialize cluster and receive calculated workerId.',
    "\t// Cluster won't be started here yet.",
    '\tworkerId := clusterInit(config.Cluster, clusterSelf)',
    '\t_ = workerId',
    '}',
    ''
  ].join('\n');
}

function topicInitFixture(): string {
  return [
    'package main',
    '',
    'func topicInit(t *Topic, join *ClientComMessage, h *Hub) {',
    '\tvar err error',
    '\tswitch {',
    '\tcase true:',
    '\t\terr = initTopicGrp(t)',
    '\t}',
    '',
    '\t// Failed to create or load the topic.',
    '\tif err != nil {',
    '\t\treturn',
    '\t}',
    '\tstatsInc("LiveTopics", 1)',
    '\tgo t.run(h)',
    '}',
    ''
  ].join('\n');
}

function topicFixture(): string {
  return [
    'package main',
    '',
    'func (t *Topic) handleClientMsg(msg *ClientComMessage) {',
    '\tif msg.Pub != nil {',
    '\t\tt.handlePubBroadcast(msg)',
    '\t}',
    '}',
    '',
    'func (t *Topic) handleMeta(msg *ClientComMessage) {',
    '\t// Request to get/set topic metadata',
    '\tif msg.Get != nil {}',
    '}',
    '',
    'func (t *Topic) handleTopicTermination(sd *shutDown) {',
    '\t// Handle four cases:',
    '\t_ = sd',
    '}',
    ''
  ].join('\n');
}
