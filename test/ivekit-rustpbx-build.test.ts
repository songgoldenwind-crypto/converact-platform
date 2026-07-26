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
const rsipstackCapacityPatch = readFileSync(
  'infra/ivekit/rustpbx/patches/rsipstack-ivekit-capacity.patch',
  'utf8'
);
const rsipstackRetransmissionPatch = readFileSync(
  'infra/ivekit/rustpbx/patches/rsipstack-ivekit-retransmission-atomicity.patch',
  'utf8'
);
const rustPbxSipCapacityPatch = readFileSync(
  'infra/ivekit/rustpbx/patches/rustpbx-ivekit-sip-capacity.patch',
  'utf8'
);
const rustPbxMediaHotPathPatch = readFileSync(
  'infra/ivekit/rustpbx/patches/rustpbx-ivekit-media-hot-path.patch',
  'utf8'
);
const rustPbxSessionCleanupPatch = readFileSync(
  'infra/ivekit/rustpbx/patches/rustpbx-ivekit-session-cleanup-isolation.patch',
  'utf8'
);
const imageWorkflow = readFileSync('.github/workflows/ivekit-rustpbx-image.yml', 'utf8');

test('iveKit RustPBX build pins source, toolchain, lockfile, and runtime base', () => {
  assert.equal(spawnSync('bash', ['-n', 'infra/ivekit/rustpbx/build.sh']).status, 0);
  assert.match(buildScript, /RUSTPBX_COMMIT="[a-f0-9]{40}"/);
  assert.match(buildScript, /RSIPSTACK_COMMIT="[a-f0-9]{40}"/);
  assert.match(buildScript, /RUSTRTC_COMMIT="[a-f0-9]{40}"/);
  assert.match(buildScript, /rust:1\.94-bookworm@sha256:[a-f0-9]{64}/);
  assert.match(buildScript, /cargo build --locked --release/);
  assert.match(buildScript, /IVEKIT_RUSTPBX_BUILD_CPUS/);
  assert.match(buildScript, /IVEKIT_RUSTPBX_BUILD_MEMORY/);
  assert.match(buildScript, /IVEKIT_RUSTPBX_BUILD_JOBS/);
  assert.match(buildScript, /IVEKIT_RUSTPBX_CARGO_HOME/);
  assert.match(buildScript, /cross compilation is not supported/);
  assert.match(runtimeDockerfile, /^FROM debian:bookworm-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(buildScript, /PATCHSET="ivekit\.26"/);
  assert.match(buildScript, /cp "\$SCRIPT_DIR\/entrypoint\.sh"/);
  assert.match(runtimeDockerfile, /COPY entrypoint\.ivekit\.sh \/app\/entrypoint\.sh/);
  assert.match(runtimeDockerfile, /ENTRYPOINT \["\/app\/entrypoint\.sh"\]/);

  const lock = readFileSync('infra/ivekit/rustpbx/Cargo.lock', 'utf8');
  assert.match(
    lock,
    /name = "rustrtc"\nversion = "0\.3\.90"\ndependencies = \[[\s\S]*?"socket2 0\.6\.5"/
  );
  assert.match(lock, /name = "rsipstack"\nversion = "0\.5\.18"\ndependencies =/);
});

test('RustPBX deployment examples reference the current patchset', () => {
  for (const path of [
    'infra/env.example',
    'infra/ivekit/env.example',
    'services/ivekit-service/env.example'
  ]) {
    assert.match(
      readFileSync(path, 'utf8'),
      /RUSTPBX_IMAGE=ivekit\/rustpbx:0\.4\.11-ivekit\.26-6c49ee76/,
      path
    );
  }
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

test('iveKit rsipstack fork enforces bounded transaction and transport state', () => {
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

test('iveKit rsipstack atomically publishes completed transactions before releasing active keys', () => {
  assert.match(
    buildScript,
    /rsipstack-ivekit-capacity\.patch"[\s\S]*rsipstack-ivekit-retransmission-atomicity\.patch"/
  );
  assert.match(rsipstackRetransmissionPatch, /publish_finished_transaction/);
  assert.match(rsipstackRetransmissionPatch, /finished transaction is visible before active transaction release/);
  assert.match(rsipstackRetransmissionPatch, /duplicate_request_during_detach_is_not_readmitted/);
});

test('iveKit RustPBX wires rsipstack capacity limits and low-cardinality metrics', () => {
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

test('iveKit RustPBX keeps recording codec and disk work off RTP forwarding loops', () => {
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

test('iveKit RustPBX isolates session teardown from the media command loop', () => {
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
  assert.match(imageWorkflow, /VERSION: 0\.4\.11-ivekit\.26-6c49ee76/);
  assert.match(imageWorkflow, /docker manifest create/);
  assert.match(imageWorkflow, /docker manifest push/);
  assert.match(imageWorkflow, /packages: write/);
  assert.match(imageWorkflow, /outputs:[\s\S]*digest: \$\{\{ steps\.digest\.outputs\.digest \}\}/);
  assert.match(imageWorkflow, /uses: \.\/\.github\/workflows\/ivekit-oci-release-gate\.yml/);
  assert.match(imageWorkflow, /digest: \$\{\{ needs\.manifest\.outputs\.digest \}\}/);
  assert.match(imageWorkflow, /id-token: write/);
  assert.match(imageWorkflow, /attestations: write/);
  assert.match(imageWorkflow, /artifact-metadata: write/);
  assert.doesNotMatch(imageWorkflow, /docker\/login-action@v\d/);
  for (const match of imageWorkflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) {
    assert.match(match[1], /^[a-f0-9]{40}$/, `mutable action reference: ${match[0]}`);
  }
});
