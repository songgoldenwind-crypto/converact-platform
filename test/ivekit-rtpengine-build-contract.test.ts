import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = 'infra/converact/rtpengine';
const REQUIRED_FILES = [
  `${ROOT}/Dockerfile.toolchain`,
  `${ROOT}/Dockerfile.runtime`,
  `${ROOT}/build.sh`,
  `${ROOT}/entrypoint.sh`,
  `${ROOT}/rtpengine.conf.template`,
  `${ROOT}/toolchain-lock.json`,
  `${ROOT}/README.md`
];

function dockerStage(source: string, name: string): string {
  const marker = new RegExp(`^FROM [^\\n]+ AS ${name}$`, 'm');
  const match = marker.exec(source);
  assert.ok(match, `missing Docker stage: ${name}`);
  const tail = source.slice(match.index);
  const next = tail.slice(match[0].length).search(/^FROM /m);
  return next < 0
    ? tail
    : tail.slice(0, match[0].length + next);
}

test('RTPengine build inputs are complete and immutable', () => {
  for (const path of REQUIRED_FILES) {
    assert.equal(existsSync(path), true, `missing build input: ${path}`);
  }

  const lock = JSON.parse(readFileSync(
    `${ROOT}/toolchain-lock.json`,
    'utf8'
  )) as Record<string, unknown>;
  assert.equal(lock.schema_version, '1.0.0');
  assert.equal(
    lock.base_image,
    'debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd'
  );
  assert.equal(lock.debian_snapshot, '20260725T000000Z');
  assert.equal(
    lock.toolchain_amd64_tag,
    'ivekit/rtpengine-toolchain:trixie-20260725-amd64'
  );
  assert.match(String(lock.toolchain_amd64_image_id), /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(
    lock.toolchain_amd64_image_id,
    `sha256:${'0'.repeat(64)}`
  );
  assert.equal(lock.toolchain_amd64_status, 'pass');
  assert.equal(lock.toolchain_amd64_built_at, '2026-07-26');
  assert.equal(
    lock.toolchain_arm64_tag,
    'ivekit/rtpengine-toolchain:trixie-20260725-arm64'
  );
  assert.equal(lock.toolchain_arm64_image_id, null);
  assert.equal(lock.toolchain_arm64_status, 'not_run');
});

test('toolchain uses a pinned Debian snapshot and contains build plus runtime dependencies', () => {
  const source = readFileSync(`${ROOT}/Dockerfile.toolchain`, 'utf8');
  assert.match(
    source,
    /^FROM debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd/m
  );
  assert.match(source, /20260725T000000Z/);
  assert.match(source, /snapshot\.debian\.org\/archive\/debian\//);
  assert.match(source, /snapshot\.debian\.org\/archive\/debian-security\//);
  for (const dependency of [
    'build-essential',
    'curl',
    'libavfilter-dev',
    'libbcg729-dev',
    'libevent-dev',
    'libhiredis-dev',
    'libjson-glib-dev',
    'libnftnl-dev',
    'libopus-dev',
    'libspandsp-dev',
    'libwebsockets-dev'
  ]) {
    assert.match(source, new RegExp(`\\b${dependency}\\b`));
  }
  assert.match(source, /AS runtime-rootfs/);
  assert.match(source, /AS toolchain/);
  assert.match(source, /io\.ivekit\.toolchain\.snapshot/);
  assert.match(source, /\/opt\/ivekit-runtime-rootfs/);
  assert.match(source, /\/var\/lib\/dpkg\/status/);
  assert.match(source, /ivekit-runtime-dpkg-status/);
  assert.match(source, /rm -f[\s\S]*\/usr\/bin\/dpkg/);
});

test('runtime Dockerfile creates separate offline artifacts with immutable labels', () => {
  const source = readFileSync(`${ROOT}/Dockerfile.runtime`, 'utf8');
  assert.match(source, /^ARG IVEKIT_RTPENGINE_TOOLCHAIN_IMAGE$/m);
  assert.match(
    source,
    /^FROM \$\{IVEKIT_RTPENGINE_TOOLCHAIN_IMAGE\} AS source-base$/m
  );
  assert.match(source, /^FROM source-base AS relay-build$/m);
  assert.match(source, /^FROM source-base AS recording-build$/m);
  assert.match(source, /^FROM source-base AS kernel-build$/m);
  assert.match(source, /^FROM kernel-build AS kernel-runtime-identity$/m);
  assert.match(source, /^FROM scratch AS userspace$/m);
  assert.match(source, /^FROM scratch AS recording$/m);
  assert.match(source, /^FROM scratch AS kernel-artifact$/m);
  assert.match(source, /^FROM scratch AS kernel-runtime$/m);

  const relay = dockerStage(source, 'relay-build');
  assert.match(relay, /make[^\n]*rtpengine/);
  assert.doesNotMatch(relay, /rtpengine-recording|nft_rtpengine\.ko/);

  const recording = dockerStage(source, 'recording-build');
  assert.match(recording, /make[^\n]*rtpengine-recording/);
  assert.doesNotMatch(
    recording,
    /nft_rtpengine\.ko|make[^\n]*-C\s+daemon(?:\s|$)/
  );

  const kernel = dockerStage(source, 'kernel-build');
  assert.match(kernel, /nft_rtpengine\.ko/);
  assert.doesNotMatch(kernel, /rtpengine-recording|make[^\n]*daemon/);

  for (const label of [
    'io.ivekit.rtpengine.source-commit',
    'io.ivekit.rtpengine.archive-sha256',
    'io.ivekit.rtpengine.patch-set-sha256',
    'io.ivekit.toolchain.image-id',
    'io.ivekit.target-architecture',
    'io.ivekit.runtime-mode'
  ]) {
    assert.match(source, new RegExp(label.replaceAll('.', '\\.')));
  }

  const userspace = dockerStage(source, 'userspace');
  assert.match(userspace, /io\.ivekit\.runtime-mode="userspace"/);
  assert.match(userspace, /^USER 10001:10001$/m);
  assert.match(userspace, /COPY --from=relay-build/);

  const recordingRuntime = dockerStage(source, 'recording');
  assert.match(recordingRuntime, /io\.ivekit\.runtime-mode="recording"/);
  assert.match(recordingRuntime, /^USER 10001:10001$/m);
  assert.match(recordingRuntime, /COPY --from=recording-build/);

  const kernelRuntime = dockerStage(source, 'kernel-runtime');
  assert.match(kernelRuntime, /io\.ivekit\.runtime-mode="kernel"/);
  assert.match(kernelRuntime, /io\.ivekit\.kernel-srcversion/);
  assert.match(
    kernelRuntime,
    /\/usr\/share\/ivekit-rtpengine\/kernel\/module-srcversion/
  );
  assert.match(kernelRuntime, /^USER 10001:10001$/m);
  const kernelRuntimeIdentity = dockerStage(
    source,
    'kernel-runtime-identity'
  );
  assert.match(
    kernelRuntimeIdentity,
    /cat \/workspace\/kernel\/module-srcversion/
  );
  assert.match(kernelRuntimeIdentity, /IVEKIT_KERNEL_SRCVERSION/);
  assert.doesNotMatch(source, /RUN\s+(apt-get|apk|dnf|yum)/);
});

test('build script refuses cross compilation and performs final builds offline', () => {
  const source = readFileSync(`${ROOT}/build.sh`, 'utf8');
  const fetch = readFileSync(`${ROOT}/fetch-source.sh`, 'utf8');
  assert.match(source, /cross compilation is not supported/);
  assert.match(source, /amd64/);
  assert.match(source, /arm64/);
  assert.match(source, /fetch-source\.sh/);
  assert.match(source, /apply-overlay\.mjs/);
  assert.match(source, /IVEKIT_RTPENGINE_TOOLCHAIN_IMAGE/);
  assert.match(source, /docker pull/);
  assert.match(source, /@\$\{?[^}\n]*sha256|@sha256:/);
  assert.match(
    source,
    /SOURCE_RUN_ARGS\+=\(\s*--network=none\s*\)/
  );
  assert.match(source, /--network=none/);
  assert.match(source, /--pull=false/);
  assert.match(source, /toolchain image ID must be pinned as sha256:/);
  assert.doesNotMatch(source, /`\$\{key\}=\$\{value\}/);
  for (const target of [
    'userspace',
    'recording',
    'kernel-artifact',
    'kernel-runtime'
  ]) {
    assert.match(source, new RegExp(`--target[\"']?\\s+${target}`));
  }
  assert.match(source, /IVEKIT_RTPENGINE_KERNEL_HEADERS_DIR/);
  assert.match(source, /not_run/);

  assert.equal(fetch.match(/git ls-remote/g)?.length, 1);
  const lsRemote = fetch.indexOf('git ls-remote');
  const guard = fetch.lastIndexOf(
    'if [[ -z "${IVEKIT_RTPENGINE_ARCHIVE_FILE:-}" ]]; then',
    lsRemote
  );
  const guardEnd = fetch.indexOf('\nfi', lsRemote);
  assert.ok(guard >= 0 && guardEnd > lsRemote);
  const onlineBranch = fetch.slice(guard, guardEnd);
  assert.match(onlineBranch, /curl/);
  assert.match(onlineBranch, /git ls-remote/);
});

test('build script exposes the supply-chain evidence gate', () => {
  const source = readFileSync(`${ROOT}/build.sh`, 'utf8');

  assert.match(
    source,
    /toolchain\|userspace\|recording\|kernel\|supply-chain\|all/
  );
  assert.match(source, /ivekit-rtpengine-supply-chain\.ts/);
  assert.match(source, /node --import tsx/);
  assert.match(source, /IVEKIT_RTPENGINE_SUPPLY_CHAIN_EVIDENCE_OUTPUT/);
});

test('entrypoint resolves kernel identity without writing the root filesystem', () => {
  const source = readFileSync(`${ROOT}/entrypoint.sh`, 'utf8');
  assert.match(source, /IVEKIT_RTPENGINE_RUNTIME_MODE/);
  assert.match(
    source,
    /IVEKIT_RTPENGINE_OWNER_GUARD="\$\{IVEKIT_RTPENGINE_OWNER_GUARD:-true\}"/
  );
  assert.match(source, /export IVEKIT_RTPENGINE_OWNER_GUARD/);
  assert.match(source, /userspace\|kernel\|auto/);
  assert.match(
    source,
    /kernel_srcversion_path="\/sys\/module\/nft_rtpengine\/srcversion"/
  );
  assert.match(
    source,
    /expected_kernel_srcversion_path="\/usr\/share\/ivekit-rtpengine\/kernel\/module-srcversion"/
  );
  assert.doesNotMatch(source, /IVEKIT_RTPENGINE_KERNEL_SRCVERSION(?:_PATH)?/);
  assert.match(source, /IVEKIT_RTPENGINE_USERSPACE_FALLBACK=true/);
  assert.match(source, /\/run\/ivekit-rtpengine/);
  assert.doesNotMatch(source, /sed\s+-i/);
  assert.doesNotMatch(source, /s!__[^!]+__!/);

  const forged = spawnSync('sh', [`${ROOT}/entrypoint.sh`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      IVEKIT_RTPENGINE_RUNTIME_MODE: 'kernel',
      IVEKIT_RTPENGINE_KERNEL_SRCVERSION: 'FORGED'
    }
  });
  assert.equal(forged.status, 78);
  assert.match(forged.stderr, /identity does not match image metadata/);

  const root = mkdtempSync(join(tmpdir(), 'ivekit-rtpengine-entrypoint-'));
  const runtime = join(root, 'run');
  const config = join(root, 'rtpengine.conf');
  const template = join(root, 'rtpengine.conf.template');
  mkdirSync(runtime);
  writeFileSync(template, readFileSync(`${ROOT}/rtpengine.conf.template`));
  spawnSync('sh', [`${ROOT}/entrypoint.sh`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      IVEKIT_RTPENGINE_RUNTIME_MODE: 'auto',
      IVEKIT_RTPENGINE_RUNTIME_DIR: runtime,
      IVEKIT_RTPENGINE_CONFIG_TEMPLATE: template,
      IVEKIT_RTPENGINE_CONFIG_PATH: config,
      IVEKIT_RTPENGINE_INTERFACE: 'public/127.0.0.1!203.0.113.10'
    }
  });
  assert.match(
    readFileSync(config, 'utf8'),
    /interface=public\/127\.0\.0\.1!203\.0\.113\.10/
  );
  assert.match(
    readFileSync(config, 'utf8'),
    /listen-tcp-ng=0\.0\.0\.0:22222/
  );
  assert.match(
    readFileSync(join(runtime, 'runtime.prom'), 'utf8'),
    /ivekit_rtpengine_userspace_fallback\{[^}]+\} 1/
  );
  assert.match(
    readFileSync(join(runtime, 'runtime.identity'), 'utf8'),
    /runtime_mode=userspace/
  );

  const metricsPatch = readFileSync(
    `${ROOT}/patches/0004-ivekit-metrics.patch`,
    'utf8'
  );
  assert.match(metricsPatch, /IVEKIT_RTPENGINE_USERSPACE_FALLBACK/);
  assert.match(metricsPatch, /ivekit_userspace_fallback/);
  assert.match(metricsPatch, /reason=\\"kernel_identity_unavailable\\"/);
});

test('userspace runtime contract excludes build and package-manager tools', () => {
  const source = readFileSync(`${ROOT}/Dockerfile.toolchain`, 'utf8');
  const cleanup = source.match(/&& rm -f[\s\S]*?&& rm -rf/)?.[0] || '';
  for (const path of [
    '/usr/bin/apt',
    '/usr/bin/apt-get',
    '/usr/bin/dpkg',
    '/usr/bin/gcc',
    '/usr/bin/g++',
    '/usr/bin/make'
  ]) {
    assert.equal(cleanup.includes(path), true, `runtime cleanup must remove ${path}`);
  }

  const entrypoint = readFileSync(`${ROOT}/entrypoint.sh`, 'utf8');
  assert.match(entrypoint, /IVEKIT_RTPENGINE_CONFIG_TEMPLATE/);
  assert.match(entrypoint, /IVEKIT_RTPENGINE_CONFIG_PATH/);
  assert.match(entrypoint, /IVEKIT_RTPENGINE_LISTEN_TCP_NG/);
  assert.match(
    readFileSync(`${ROOT}/rtpengine.conf.template`, 'utf8'),
    /listen-tcp-ng=__LISTEN_TCP_NG__/
  );
});

test('Goal 2 command executes the Task 4 build contract', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    pkg.scripts['test:ivekit:voice-media-goal2'],
    /test\/ivekit-rtpengine-build-contract\.test\.ts/
  );
});
