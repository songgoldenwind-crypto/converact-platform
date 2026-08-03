import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const buildScript = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
const runtimeDockerfile = readFileSync('infra/converact/rustpbx/Dockerfile.runtime', 'utf8');
const rustPbxPatch = readFileSync(
  'infra/converact/rustpbx/patches/rustpbx-local-rsipstack.patch',
  'utf8'
);
const rustPbxAmiPatch = readFileSync(
  'infra/converact/rustpbx/patches/rustpbx-ivekit-ami-dialogs.patch',
  'utf8'
);
const rustPbxRwiHangupPatchPath =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-rwi-originate-hangup.patch';
const rsipstackPatch = readFileSync(
  'infra/converact/rustpbx/patches/rsipstack-tcp-reconnect.patch',
  'utf8'
);
const rsipstackCapacityPatch = readFileSync(
  'infra/converact/rustpbx/patches/rsipstack-ivekit-capacity.patch',
  'utf8'
);
const rsipstackRetransmissionPatch = readFileSync(
  'infra/converact/rustpbx/patches/rsipstack-ivekit-retransmission-atomicity.patch',
  'utf8'
);
const rsipstackDialogRecoveryPatch = readFileSync(
  'infra/converact/rustpbx/patches/rsipstack-ivekit-dialog-recovery.patch',
  'utf8'
);
const rustPbxSipCapacityPatch = readFileSync(
  'infra/converact/rustpbx/patches/rustpbx-ivekit-sip-capacity.patch',
  'utf8'
);
const rustPbxMediaHotPathPatch = readFileSync(
  'infra/converact/rustpbx/patches/rustpbx-ivekit-media-hot-path.patch',
  'utf8'
);
const rustPbxSessionCleanupPatch = readFileSync(
  'infra/converact/rustpbx/patches/rustpbx-ivekit-session-cleanup-isolation.patch',
  'utf8'
);
const imageWorkflow = readFileSync('.github/workflows/converact-rustpbx-image.yml', 'utf8');

test('Converact Fabric RustPBX build pins source, toolchain, lockfile, and runtime base', () => {
  assert.equal(spawnSync('bash', ['-n', 'infra/converact/rustpbx/build.sh']).status, 0);
  assert.match(buildScript, /RUSTPBX_COMMIT="[a-f0-9]{40}"/);
  assert.match(buildScript, /RSIPSTACK_COMMIT="[a-f0-9]{40}"/);
  assert.match(buildScript, /RUSTRTC_COMMIT="[a-f0-9]{40}"/);
  assert.match(buildScript, /rust:1\.94-bookworm@sha256:[a-f0-9]{64}/);
  assert.match(buildScript, /cargo build --locked --release/);
  assert.match(buildScript, /CONVERACT_FABRIC_RUSTPBX_BUILD_CPUS/);
  assert.match(buildScript, /CONVERACT_FABRIC_RUSTPBX_BUILD_MEMORY/);
  assert.match(buildScript, /CONVERACT_FABRIC_RUSTPBX_BUILD_JOBS/);
  assert.match(buildScript, /CONVERACT_FABRIC_RUSTPBX_CARGO_HOME/);
  assert.match(buildScript, /HOST_UID="\$\(id -u\)"/);
  assert.match(buildScript, /HOST_GID="\$\(id -g\)"/);
  assert.match(buildScript, /local status="\$\?"/);
  assert.match(
    buildScript,
    /docker run --rm[\s\S]*-v "\$BUILD_ROOT:\/build"[\s\S]*chown -R "\$HOST_UID:\$HOST_GID" \/build/
  );
  assert.match(buildScript, /exit "\$status"/);
  assert.match(buildScript, /cross compilation is not supported/);
  assert.match(
    buildScript,
    /git -C "\$SOURCE_ROOT" status --porcelain --/
  );
  assert.match(
    buildScript,
    /infra\/converact\/rustpbx integrations\/component-hook-rs/
  );
  assert.match(buildScript, /SHA256_COMMAND=\(sha256sum\)/);
  assert.match(buildScript, /PATCH_SET_SHA256=/);
  assert.match(buildScript, /find \. -type f -name '\*\.patch'.*LC_ALL=C sort/);
  assert.match(buildScript, /CONVERACT_SOURCE_COMMIT=.*rev-parse HEAD/s);
  assert.match(runtimeDockerfile, /^FROM debian:bookworm-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(buildScript, /PATCHSET="ivekit\.48"/);
  assert.match(
    buildScript,
    /--build-arg "CONVERACT_SOURCE_COMMIT=\$CONVERACT_SOURCE_COMMIT"/
  );
  assert.match(
    buildScript,
    /--build-arg "IVEKIT_PATCH_SET_SHA256=\$PATCH_SET_SHA256"/
  );
  assert.match(runtimeDockerfile, /ARG CONVERACT_SOURCE_COMMIT/);
  assert.match(runtimeDockerfile, /ARG IVEKIT_PATCH_SET_SHA256/);
  assert.match(
    runtimeDockerfile,
    /org\.opencontainers\.image\.revision="\$\{CONVERACT_SOURCE_COMMIT\}"/
  );
  assert.match(
    runtimeDockerfile,
    /io\.ivekit\.rustpbx\.patch-set-sha256="\$\{IVEKIT_PATCH_SET_SHA256\}"/
  );
  assert.match(buildScript, /cp "\$SCRIPT_DIR\/entrypoint\.sh"/);
  assert.match(runtimeDockerfile, /COPY entrypoint\.converact\.sh \/app\/entrypoint\.sh/);
  assert.match(runtimeDockerfile, /ENTRYPOINT \["\/app\/entrypoint\.sh"\]/);

  const lock = readFileSync('infra/converact/rustpbx/Cargo.lock', 'utf8');
  assert.match(
    lock,
    /name = "rustrtc"\nversion = "0\.3\.90"\ndependencies = \[[\s\S]*?"socket2 0\.6\.5"/
  );
  assert.match(lock, /name = "rsipstack"\nversion = "0\.5\.18"\ndependencies =/);
});

test('RustPBX verification accepts only a complete exact-source override set', () => {
  assert.match(buildScript, /CONVERACT_FABRIC_RUSTPBX_SOURCE_DIR/);
  assert.match(buildScript, /CONVERACT_FABRIC_RSIPSTACK_SOURCE_DIR/);
  assert.match(buildScript, /CONVERACT_FABRIC_RUSTRTC_SOURCE_DIR/);
  assert.match(buildScript, /all three Rust source overrides must be provided together/);
  assert.match(
    buildScript,
    /git -C "\$source_dir" status --porcelain --untracked-files=all/
  );
  assert.match(
    buildScript,
    /git -C "\$source_dir" rev-parse HEAD[\s\S]*expected_commit/
  );
  assert.match(
    buildScript,
    /git clone --no-local --no-checkout "\$source_dir" "\$destination"/
  );
  assert.match(
    buildScript,
    /git clone --filter=blob:none --no-checkout "\$remote_url" "\$destination"/
  );
});

test('rsipstack native tests fetch one locked graph before switching offline', () => {
  const rsipstackLockPath = 'infra/converact/rustpbx/rsipstack.Cargo.lock';
  assert.equal(existsSync(rsipstackLockPath), true);
  const lock = readFileSync(rsipstackLockPath, 'utf8');
  assert.match(lock, /^version = 4$/m);
  assert.match(lock, /name = "rtp-rs"\nversion = "0\.6\.0"/);
  assert.match(
    buildScript,
    /cp "\$SCRIPT_DIR\/rsipstack\.Cargo\.lock" "\$BUILD_ROOT\/rsipstack\/Cargo\.lock"/
  );
  assert.match(
    buildScript,
    /cargo fetch --manifest-path \/build\/rsipstack\/Cargo\.toml --locked[\s\S]*cargo test --manifest-path \/build\/rsipstack\/Cargo\.toml --offline/
  );
  const rsipstackOfflineTests = buildScript
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(
      'cargo test --manifest-path /build/rsipstack/Cargo.toml --offline'
    ));
  assert.deepEqual(rsipstackOfflineTests, [
    'cargo test --manifest-path /build/rsipstack/Cargo.toml --offline',
  ]);
});

test('RustPBX deployment examples reference the current patchset', () => {
  for (const path of [
    'infra/env.example',
    'infra/converact/env.example',
    'services/converact-service/env.example'
  ]) {
    assert.match(
      readFileSync(path, 'utf8'),
      /RUSTPBX_IMAGE=ghcr\.io\/songgoldenwind-crypto\/converact-rustpbx:0\.4\.11-ivekit\.40-6c49ee76/,
      path
    );
  }
});

test('RustPBX CI verifies exact-source behavior before publishing images', () => {
  assert.match(imageWorkflow, /^  pull_request:\s*$/m);
  assert.match(imageWorkflow, /^  verify:\s*$/m);
  assert.match(
    imageWorkflow,
    /CONVERACT_FABRIC_RUSTPBX_VERIFY_ONLY: "1"[\s\S]*bash infra\/converact\/rustpbx\/build\.sh/
  );
  assert.match(
    imageWorkflow,
    /^  build:\s*\n\s+name:[\s\S]*\n\s+needs: verify\s*$/m
  );
  assert.match(
    imageWorkflow,
    /if: github\.event_name != 'pull_request'/
  );
  assert.match(buildScript, /CONVERACT_FABRIC_RUSTPBX_VERIFY_ONLY/);
  assert.match(buildScript, /rustup component add rustfmt clippy/);
  assert.match(buildScript, /rustpbx-ivekit-dual-leg-cdr\.patch[\s\S]*--numstat/);
  assert.match(
    buildScript,
    /rustfmt --edition 2024 --check --config skip_children=true/
  );
  assert.match(
    buildScript,
    /cargo fmt --manifest-path vendor\/converact-component-hook\/Cargo\.toml -- --check/
  );
  assert.doesNotMatch(buildScript, /cargo fmt --all/);
  assert.match(buildScript, /cargo check --locked --features cross --bin rustpbx --bin sipflow/);
  assert.match(buildScript, /cargo clippy --locked --lib --features cross --no-deps/);
  assert.match(buildScript, /^\s*cargo test --locked --lib\s*$/m);
  assert.doesNotMatch(buildScript, /cargo test --locked --lib converact_/);
  assert.match(
    buildScript,
    /cargo test --locked --lib missing_callee_terminal_data_stays_independent_from_the_caller/
  );
  assert.match(
    buildScript,
    /cargo test --locked --test ivekit_dialog_shadow_contract_test/
  );
  assert.doesNotMatch(buildScript, /--test converact_dialog_shadow_contract_test/);
});

test('Converact Fabric RustPBX patch reconnects only failed TCP sends and removes matching stale entries', () => {
  assert.match(rustPbxPatch, /rustrtc = "=0\.3\.90"/);
  assert.match(rustPbxPatch, /rsipstack = \{ path = "\.\.\/rsipstack" \}/);
  assert.match(rsipstackPatch, /fn is_retryable_tcp_send_error/);
  assert.match(rsipstackPatch, /ErrorKind::BrokenPipe/);
  assert.match(rsipstackPatch, /del_connection_if_same/);
  assert.match(rsipstackPatch, /same_instance/);
  assert.match(rsipstackPatch, /closed_tcp_connection_is_removed_before_reconnect/);
  assert.doesNotMatch(rsipstackPatch, /for .*0\.\.2|targets.*target.*target/);
});

test('Converact Fabric rsipstack fork enforces bounded transaction and transport state', () => {
  assert.match(
    buildScript,
    /apply --check "\$PATCH_DIR\/rsipstack-tcp-reconnect\.patch"[\s\S]*apply --check "\$PATCH_DIR\/rsipstack-ivekit-capacity\.patch"/
  );
  assert.match(rsipstackCapacityPatch, /pub struct EndpointCapacityLimits/);
  assert.match(rsipstackCapacityPatch, /incoming_transaction_queue_capacity/);
  assert.match(rsipstackCapacityPatch, /try_acquire_active_transaction/);
  assert.match(rsipstackCapacityPatch, /try_acquire_finished_transaction/);
  assert.match(rsipstackCapacityPatch, /StatusCode::ServiceUnavailable/);
  assert.match(rsipstackCapacityPatch, /Retry-After/);
  assert.match(rsipstackCapacityPatch, /set_max_connections/);
  assert.match(rsipstackCapacityPatch, /struct TransportConnectionCapacityGuard/);
  assert.match(rsipstackCapacityPatch, /self\.inner\.capacity\.release_connection\(\)/);
  assert.match(rsipstackCapacityPatch, /connection_limit_rejections_total/);
  assert.match(rsipstackCapacityPatch, /tcp connection rejected by capacity limit/);
  assert.match(rsipstackCapacityPatch, /tls connection rejected by capacity limit/);
  assert.match(rsipstackCapacityPatch, /websocket connection rejected by capacity limit/);
  assert.doesNotMatch(rsipstackCapacityPatch, /tenant_id|interaction_id|call_id/);
});

test('Converact Fabric rsipstack atomically publishes completed transactions before releasing active keys', () => {
  assert.match(
    buildScript,
    /rsipstack-ivekit-capacity\.patch"[\s\S]*rsipstack-ivekit-retransmission-atomicity\.patch"/
  );
  assert.match(rsipstackRetransmissionPatch, /publish_finished_transaction/);
  assert.match(rsipstackRetransmissionPatch, /finished transaction is visible before active transaction release/);
  assert.match(rsipstackRetransmissionPatch, /duplicate_request_during_detach_is_not_readmitted/);
});

test('Converact Fabric rsipstack preserves recovered in-dialog authority and exposes snapshots', () => {
  assert.match(
    buildScript,
    /rsipstack-ivekit-retransmission-atomicity\.patch"[\s\S]*rsipstack-ivekit-dialog-recovery\.patch"/
  );
  assert.match(rsipstackDialogRecoveryPatch, /DialogState::Publish/);
  assert.match(rsipstackDialogRecoveryPatch, /DialogState::Refer/);
  assert.match(rsipstackDialogRecoveryPatch, /DialogState::Message/);
  assert.match(rsipstackDialogRecoveryPatch, /pub fn snapshot\(&self\) -> DialogSnapshot/);
  assert.match(
    rsipstackDialogRecoveryPatch,
    /test_dialog_in_dialog_requests[\s\S]*must not replace the durable dialog state/
  );
});

test('Converact Fabric RustPBX wires rsipstack capacity limits and low-cardinality metrics', () => {
  assert.match(
    buildScript,
    /apply --check "\$PATCH_DIR\/rustpbx-local-rsipstack\.patch"[\s\S]*apply --check "\$PATCH_DIR\/rustpbx-ivekit-sip-capacity\.patch"/
  );
  assert.match(rustPbxSipCapacityPatch, /EndpointCapacityLimits::try_new/);
  assert.match(rustPbxSipCapacityPatch, /with_capacity_limits/);
  assert.match(rustPbxSipCapacityPatch, /sip_max_active_transactions/);
  assert.match(rustPbxSipCapacityPatch, /sip_incoming_transaction_queue_capacity/);
  assert.match(rustPbxSipCapacityPatch, /rustpbx_sip_endpoint_incoming_queue_depth/);
  assert.match(rustPbxSipCapacityPatch, /rustpbx_sip_transport_connection_limit_rejections_total/);
  assert.doesNotMatch(rustPbxSipCapacityPatch, /tenant_id|interaction_id|call_id/);
});

test('Converact Fabric RustPBX keeps recording codec and disk work off RTP forwarding loops', () => {
  const effectivePatch = rustPbxMediaHotPathPatch
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .join('\n');
  assert.match(
    buildScript,
    /apply --check "\$PATCH_DIR\/rustpbx-ivekit-sip-capacity\.patch"[\s\S]*apply --check "\$PATCH_DIR\/rustpbx-ivekit-media-hot-path\.patch"/
  );
  assert.match(rustPbxMediaHotPathPatch, /struct RecorderCapture/);
  assert.match(rustPbxMediaHotPathPatch, /struct RecordingExecutor/);
  assert.match(rustPbxMediaHotPathPatch, /crossbeam_channel::bounded/);
  assert.match(rustPbxMediaHotPathPatch, /rustpbx-recording-/);
  assert.match(rustPbxMediaHotPathPatch, /media_recording_channel_capacity/);
  assert.match(rustPbxMediaHotPathPatch, /media_recording_worker_threads/);
  assert.match(rustPbxMediaHotPathPatch, /try_send/);
  assert.match(rustPbxMediaHotPathPatch, /recording_queue_dropped/);
  assert.match(rustPbxMediaHotPathPatch, /rustpbx_media_recording_queue_drops_total/);
  assert.match(effectivePatch, /spawn_recording_finalizer/);
  assert.match(effectivePatch, /crossbeam_channel::bounded::<RecordingLifecycleTask>/);
  assert.match(effectivePatch, /recording_lifecycle_queue_unavailable/);
  assert.match(effectivePatch, /try_write\(\)/);
  assert.match(effectivePatch, /Recorder dropped without synchronous finalization/);
  const stopRecordingPatch = effectivePatch.match(
    /MediaCommand::StopRecording[\s\S]*?MediaCommand::PauseRecording/
  )?.[0] || '';
  assert.doesNotMatch(stopRecordingPatch, /sess\.recorder\.write\(\)/);
  assert.doesNotMatch(effectivePatch, /reply_rx\.await/);
  assert.match(effectivePatch, /Recording starts on the bounded lifecycle executor/);
  assert.match(effectivePatch, /Finalization is deliberately fire-and-forget/);
  assert.ok((effectivePatch.match(/reply: None/g) || []).length >= 2);
  assert.match(effectivePatch, /test_recording_stop_does_not_block_engine_on_busy_recorder/);
  assert.match(rustPbxMediaHotPathPatch, /disabled: AtomicBool/);
  assert.match(rustPbxMediaHotPathPatch, /disable_after_write_failure/);
  assert.match(rustPbxMediaHotPathPatch, /record_disabled_drop/);
  assert.match(rustPbxMediaHotPathPatch, /record_drop\("write_failed"\)/);
  assert.match(rustPbxMediaHotPathPatch, /recorder capture disabled after write failure/);
  assert.match(rustPbxMediaHotPathPatch, /drop_counter_registered: AtomicBool/);
  assert.match(rustPbxMediaHotPathPatch, /compare_exchange\(false, true/);
  assert.match(
    rustPbxMediaHotPathPatch,
    /impl RecordingWorkItem[\s\S]{0,1000}register_drop_counter\(recorder\)/
  );
  assert.match(rustPbxMediaHotPathPatch, /fn wait_until_drained/);
  assert.match(effectivePatch, /recording_capture_drain_timeout/);
  assert.match(effectivePatch, /recording_finalize_lock_unavailable/);
  assert.doesNotMatch(effectivePatch, /try_write\(\)[\s\S]{0,300}\.write\(\)/);
  assert.match(
    rustPbxMediaHotPathPatch,
    /recorder_capture_counts_samples_seen_before_recorder_start/
  );
  assert.match(rustPbxMediaHotPathPatch, /recorder_capture_drain_waits_for_accepted_samples/);
  assert.match(rustPbxMediaHotPathPatch, /Arc::ptr_eq/);
  assert.doesNotMatch(rustPbxMediaHotPathPatch, /tenant_id|interaction_id|call_id/);
});

test('Converact Fabric RustPBX isolates session teardown from the media command loop', () => {
  const effectivePatch = rustPbxSessionCleanupPatch
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .join('\n');
  assert.match(
    buildScript,
    /rustpbx-ivekit-media-hot-path\.patch"[\s\S]*rustpbx-ivekit-session-cleanup-isolation\.patch"[\s\S]*rustpbx-ivekit-webphone-registry\.patch"/
  );
  assert.match(effectivePatch, /fn schedule_session_cleanup/);
  assert.match(effectivePatch, /Semaphore::new\(self\.session_cleanup_concurrency\)/);
  assert.match(effectivePatch, /try_acquire_owned\(\)/);
  assert.match(effectivePatch, /tokio::time::timeout\(cleanup_timeout, cleanup\)/);
  assert.match(effectivePatch, /session_cleanup_outcome\("capacity_exhausted"\)/);
  assert.match(effectivePatch, /session_cleanup_outcome\("timed_out"\)/);
  assert.match(effectivePatch, /media_session_cleanup_concurrency/);
  assert.match(effectivePatch, /media_session_cleanup_timeout_ms/);
  assert.match(
    effectivePatch,
    /sessions\.remove\(&session_id\)[\s\S]{0,250}schedule_session_cleanup\(sess\)/
  );
  assert.match(
    effectivePatch,
    /fn reap_stale_sessions[\s\S]{0,2500}schedule_session_cleanup\(sess\)/
  );
  assert.doesNotMatch(effectivePatch, /finalize_session_resources/);
  assert.match(runtimeDockerfile, /io\.ivekit\.rustpbx\.patchset/);
});

test('Converact Fabric RustPBX AMI patch exposes deterministic call ids for reconciliation', () => {
  assert.match(buildScript, /rustpbx-ivekit-ami-dialogs\.patch/);
  assert.match(rustPbxAmiPatch, /let id = state\.id\(\)/);
  assert.match(rustPbxAmiPatch, /"call_id": id\.call_id\.clone\(\)/);
  assert.match(rustPbxAmiPatch, /active_call_registry/);
  assert.match(rustPbxAmiPatch, /"provider_call_id": call_id/);
  assert.match(rustPbxAmiPatch, /"source": "active_call_registry"/);
});

test('Converact Fabric RustPBX RWI originate hangup patch terminates early and answered SIP dialogs', () => {
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

test('Converact Fabric exposes reproducible RustPBX build and acceptance commands', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['converact:rustpbx-build'], 'bash infra/converact/rustpbx/build.sh');
  assert.equal(
    packageJson.scripts['converact:rustpbx-management-acceptance'],
    'node --import tsx scripts/converact-rustpbx-management-acceptance.ts'
  );
  assert.equal(
    packageJson.scripts['converact:rustpbx-rwi-acceptance'],
    'node --import tsx scripts/converact-rustpbx-rwi-acceptance.ts'
  );
  assert.equal(
    packageJson.scripts['converact:rustpbx-sipp-acceptance'],
    'node --import tsx scripts/converact-rustpbx-sipp-acceptance.ts'
  );
});

test('Converact Fabric publishes native amd64 and arm64 RustPBX images as one manifest', () => {
  assert.match(imageWorkflow, /runner: ubuntu-24\.04\n/);
  assert.match(imageWorkflow, /runner: ubuntu-24\.04-arm\n/);
  assert.match(imageWorkflow, /VERSION: 0\.4\.11-ivekit\.42-6c49ee76/);
  assert.match(imageWorkflow, /docker manifest create/);
  assert.match(imageWorkflow, /docker manifest push/);
  assert.match(imageWorkflow, /packages: write/);
  assert.match(imageWorkflow, /outputs:[\s\S]*digest: \$\{\{ steps\.digest\.outputs\.digest \}\}/);
  assert.match(imageWorkflow, /uses: \.\/\.github\/workflows\/converact-oci-release-gate\.yml/);
  assert.match(imageWorkflow, /digest: \$\{\{ needs\.manifest\.outputs\.digest \}\}/);
  assert.match(imageWorkflow, /id-token: write/);
  assert.match(imageWorkflow, /attestations: write/);
  assert.match(imageWorkflow, /artifact-metadata: write/);
  assert.doesNotMatch(imageWorkflow, /docker\/login-action@v\d/);
  for (const match of imageWorkflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) {
    assert.match(match[1], /^[a-f0-9]{40}$/, `mutable action reference: ${match[0]}`);
  }
});
