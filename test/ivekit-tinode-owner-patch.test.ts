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

import * as tinodeOverlay from '../infra/ivekit/tinode/apply-overlay.mjs';

import {
  TINODE_UPSTREAM_COMMIT,
  TINODE_UPSTREAM_TAG,
  applyPinnedPatch,
  patchTinodeGoMod,
  patchTinodeMain,
  patchTinodeTopic,
  patchTinodeTopicInit
} from '../infra/ivekit/tinode/apply-overlay.mjs';

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
    'infra/ivekit/tinode/patches/tinode-ivekit-session-fanout-hot-path.patch',
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

test('Tinode overlay makes the upstream runtime image compile the iveKit source', () => {
  const patchDockerfile = (tinodeOverlay as Record<string, unknown>)
    .patchTinodeDockerfile;
  assert.equal(typeof patchDockerfile, 'function');

  const patched = (patchDockerfile as (source: string) => string)(
    tinodeDockerfileFixture()
  );
  assert.match(patched, /FROM golang:1\.26-alpine AS ivekit-builder/);
  assert.match(patched, /COPY ivekit\/ ivekit\//);
  assert.ok(patched.indexOf('COPY ivekit/ ivekit/') < patched.indexOf('RUN go mod download'));
  assert.match(patched, /go build[\s\S]*-o \/out\/tinode \.\/server/);
  assert.match(patched, /go build[\s\S]*-o \/out\/init-db \.\/tinode-db/);
  assert.match(patched, /COPY --from=ivekit-builder \/out\/tinode \./);
  assert.match(patched, /COPY docker\/tinode\/config\.template \./);
  assert.match(patched, /COPY tinode-db\/credentials\.sh \./);
  assert.doesNotMatch(patched, /github\.com\/tinode\/chat\/releases\/download/);
  assert.equal(
    (patchDockerfile as (source: string) => string)(patched),
    patched
  );
});

test('Tinode build files retain the real upstream compile boundary', () => {
  const build = readFileSync('infra/ivekit/tinode/build.sh', 'utf8');
  const readme = readFileSync('infra/ivekit/tinode/README.md', 'utf8');
  const hook = readFileSync('infra/ivekit/tinode/server-hook.go', 'utf8');

  assert.match(build, /go test -C "\$\{TINODE_SOURCE_DIR\}" \.\/server/);
  assert.match(build, /ivekit\/component-hook-go" \.\/\.\.\./);
  assert.match(build, /ivekit\/tinode-owner" \.\/\.\.\./);
  assert.doesNotMatch(build, /\.\/ivekit\/\.\.\./);
  assert.match(build, /docker build/);
  assert.match(build, /--file "\$\{TINODE_SOURCE_DIR\}\/docker\/tinode\/Dockerfile"/);
  assert.match(build, /--build-arg "TARGET_DB=\$\{TINODE_TARGET_DB:-postgres\}"/);
  assert.match(readme, /Go 1\.26/);
  assert.match(readme, /remain `not_run`/);
  assert.match(hook, /IVEKIT_COMPONENT_NODE_ID/);
  assert.match(hook, /ivekitTopicOwners\.Assert/);
  assert.doesNotMatch(hook, /fanout/);
});

function tinodeDockerfileFixture(): string {
  return [
    'FROM alpine:3.22',
    'ARG TARGET_DB=mysql',
    'ENV TARGET_DB=$TARGET_DB',
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
