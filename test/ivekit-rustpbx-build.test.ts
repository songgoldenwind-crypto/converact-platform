import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const buildScript = readFileSync('infra/ivekit/rustpbx/build.sh', 'utf8');
const runtimeDockerfile = readFileSync('infra/ivekit/rustpbx/Dockerfile.runtime', 'utf8');
const rustPbxPatch = readFileSync(
  'infra/ivekit/rustpbx/patches/rustpbx-local-rsipstack.patch',
  'utf8'
);
const rsipstackPatch = readFileSync(
  'infra/ivekit/rustpbx/patches/rsipstack-tcp-reconnect.patch',
  'utf8'
);
const imageWorkflow = readFileSync('.github/workflows/ivekit-rustpbx-image.yml', 'utf8');

test('iveKit RustPBX build pins source, toolchain, lockfile, and runtime base', () => {
  assert.equal(spawnSync('bash', ['-n', 'infra/ivekit/rustpbx/build.sh']).status, 0);
  assert.match(buildScript, /RUSTPBX_COMMIT="[a-f0-9]{40}"/);
  assert.match(buildScript, /RSIPSTACK_COMMIT="[a-f0-9]{40}"/);
  assert.match(buildScript, /rust:1\.94-bookworm@sha256:[a-f0-9]{64}/);
  assert.match(buildScript, /cargo build --locked --release/);
  assert.match(buildScript, /cross compilation is not supported/);
  assert.match(runtimeDockerfile, /^FROM debian:bookworm-slim@sha256:[a-f0-9]{64}$/m);

  const lock = readFileSync('infra/ivekit/rustpbx/Cargo.lock', 'utf8');
  assert.match(lock, /name = "rustrtc"\nversion = "0\.3\.90"/);
  assert.match(lock, /name = "rsipstack"\nversion = "0\.5\.18"\ndependencies =/);
});

test('iveKit RustPBX patch reconnects only failed TCP sends and removes matching stale entries', () => {
  assert.match(rustPbxPatch, /rustrtc = "=0\.3\.90"/);
  assert.match(rustPbxPatch, /rsipstack = \{ path = "\.\.\/rsipstack" \}/);
  assert.match(rsipstackPatch, /fn is_retryable_tcp_send_error/);
  assert.match(rsipstackPatch, /ErrorKind::BrokenPipe/);
  assert.match(rsipstackPatch, /del_connection_if_same/);
  assert.match(rsipstackPatch, /same_instance/);
  assert.match(rsipstackPatch, /closed_tcp_connection_is_removed_before_reconnect/);
  assert.doesNotMatch(rsipstackPatch, /for .*0\.\.2|targets.*target.*target/);
});

test('iveKit exposes reproducible RustPBX build and acceptance commands', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['ivekit:rustpbx-build'], 'bash infra/ivekit/rustpbx/build.sh');
  assert.equal(
    packageJson.scripts['ivekit:rustpbx-management-acceptance'],
    'node --import tsx scripts/ivekit-rustpbx-management-acceptance.ts'
  );
  assert.equal(
    packageJson.scripts['ivekit:rustpbx-sipp-acceptance'],
    'node --import tsx scripts/ivekit-rustpbx-sipp-acceptance.ts'
  );
});

test('iveKit publishes native amd64 and arm64 RustPBX images as one manifest', () => {
  assert.match(imageWorkflow, /runner: ubuntu-24\.04\n/);
  assert.match(imageWorkflow, /runner: ubuntu-24\.04-arm\n/);
  assert.match(imageWorkflow, /VERSION: 0\.4\.11-ivekit\.1/);
  assert.match(imageWorkflow, /docker manifest create/);
  assert.match(imageWorkflow, /docker manifest push/);
  assert.match(imageWorkflow, /packages: write/);
});
