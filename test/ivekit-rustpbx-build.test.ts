import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const buildScript = readFileSync('infra/ivekit/rustpbx/build.sh', 'utf8');
const runtimeDockerfile = readFileSync('infra/ivekit/rustpbx/Dockerfile.runtime', 'utf8');
const rustPbxPatch = readFileSync(
  'infra/ivekit/rustpbx/patches/rustpbx-local-rsipstack.patch',
  'utf8'
);
const rustPbxAmiPatch = readFileSync(
  'infra/ivekit/rustpbx/patches/rustpbx-ivekit-ami-dialogs.patch',
  'utf8'
);
const rustPbxRwiHangupPatchPath =
  'infra/ivekit/rustpbx/patches/rustpbx-ivekit-rwi-originate-hangup.patch';
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

test('iveKit RustPBX AMI patch exposes deterministic call ids for reconciliation', () => {
  assert.match(buildScript, /rustpbx-ivekit-ami-dialogs\.patch/);
  assert.match(rustPbxAmiPatch, /let id = state\.id\(\)/);
  assert.match(rustPbxAmiPatch, /"call_id": id\.call_id\.clone\(\)/);
  assert.match(rustPbxAmiPatch, /active_call_registry/);
  assert.match(rustPbxAmiPatch, /"provider_call_id": call_id/);
  assert.match(rustPbxAmiPatch, /"source": "active_call_registry"/);
});

test('iveKit RustPBX RWI originate hangup patch terminates early and answered SIP dialogs', () => {
  assert.equal(existsSync(rustPbxRwiHangupPatchPath), true);
  const rustPbxRwiHangupPatch = readFileSync(rustPbxRwiHangupPatchPath, 'utf8');

  assert.match(buildScript, /rustpbx-ivekit-rwi-originate-hangup\.patch/);
  assert.match(rustPbxRwiHangupPatch, /_ = cancel_token\.cancelled\(\)/);
  assert.match(rustPbxRwiHangupPatch, /RWI originate cancelled before answer/);
  assert.match(rustPbxRwiHangupPatch, /dialog\.hangup\(\)\.await/);
  assert.match(rustPbxRwiHangupPatch, /Failed to hang up RWI-originated SIP dialog/);
  assert.match(
    rustPbxRwiHangupPatch,
    /\+ {28}registry\.remove\(&call_id\);\n {29}cleanup\(\)\.await;/
  );
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
    packageJson.scripts['ivekit:rustpbx-rwi-acceptance'],
    'node --import tsx scripts/ivekit-rustpbx-rwi-acceptance.ts'
  );
  assert.equal(
    packageJson.scripts['ivekit:rustpbx-sipp-acceptance'],
    'node --import tsx scripts/ivekit-rustpbx-sipp-acceptance.ts'
  );
});

test('iveKit publishes native amd64 and arm64 RustPBX images as one manifest', () => {
  assert.match(imageWorkflow, /runner: ubuntu-24\.04\n/);
  assert.match(imageWorkflow, /runner: ubuntu-24\.04-arm\n/);
  assert.match(imageWorkflow, /VERSION: 0\.4\.11-ivekit\.3/);
  assert.match(imageWorkflow, /docker manifest create/);
  assert.match(imageWorkflow, /docker manifest push/);
  assert.match(imageWorkflow, /packages: write/);
});
