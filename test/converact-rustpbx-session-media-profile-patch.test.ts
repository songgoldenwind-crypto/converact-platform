import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-session-media-profile.patch';

function patch(): string {
  return readFileSync(PATCH_PATH, 'utf8');
}

function addedLines(): string {
  return patch()
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

function removedLines(): string {
  return patch()
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('RustPBX retains the immutable per-session media profile in the current patchset', () => {
  assert.equal(existsSync(PATCH_PATH), true, `${PATCH_PATH} is required`);
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  const parsed = spawnSync('git', ['apply', '--numstat', PATCH_PATH], {
    encoding: 'utf8'
  });

  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(build, /PATCHSET="ivekit\.78"/);
  assert.match(
    build,
    /rustpbx-ivekit-inbound-admission-response-contract\.patch"[\s\S]*rustpbx-ivekit-session-media-profile\.patch"/
  );
});

test('RustPBX owner contracts reject unknown or incomplete media profiles', () => {
  const added = addedLines();

  assert.match(added, /#\[serde\(tag = "media_profile_id", deny_unknown_fields\)\]/);
  assert.match(added, /G711Relay/);
  assert.match(added, /VoiceIvrG711OpusV1/);
  assert.match(added, /leg_a_codec: MediaCodec/);
  assert.match(added, /leg_b_codec: MediaCodec/);
  assert.match(added, /leg_a_payload_type: u8/);
  assert.match(added, /leg_b_payload_type: u8/);
  assert.match(added, /packetization_ms: u8/);
  assert.match(added, /pub tenant_id: String/);
  assert.match(added, /pub cell_id: String/);
  assert.match(added, /pub owner_node_id: String/);
  assert.match(added, /pub media_control_profile: MediaControlProfile/);
  assert.match(added, /media_control_profile\.validate\(\)/);
});

test('inbound admission and RWI freeze the same tenant, Cell, node, and media facts', () => {
  const added = addedLines();

  assert.match(added, /tenant_id: admitted\.tenant_id/);
  assert.match(added, /cell_id: admitted\.cell_id/);
  assert.match(added, /owner_node_id: admitted\.owner_node_id/);
  assert.match(
    added,
    /media_control_profile: admitted\.media_control_profile/
  );
  assert.match(added, /owner_contract_rejects_partial_processing_profile/);
  assert.match(added, /owner_contract_rejects_unknown_media_profile/);
});

test('media bootstrap and recovery use the session contract instead of process routing facts', () => {
  const added = addedLines();
  const removed = removedLines();

  assert.match(added, /&owner\.tenant_id/);
  assert.match(added, /&owner\.cell_id/);
  assert.match(added, /&owner\.owner_node_id/);
  assert.match(added, /owner\.media_control_profile\.clone\(\)/);
  assert.match(added, /media_control_profile: MediaControlProfile/);
  assert.match(added, /input\.media_control_profile\.clone\(\)/);
  assert.match(
    added,
    /previous_caller\.media_control_profile\.clone\(\)/
  );
  assert.match(
    added,
    /previous_callee\.media_control_profile\.clone\(\)/
  );
  assert.match(removed, /IVEKIT_RUSTPBX_ROUTE_TENANT_ID/);
  assert.match(removed, /IVEKIT_RUSTPBX_CELL_ID/);
  assert.match(removed, /IVEKIT_RUSTPBX_OWNER_NODE_ID/);
  assert.match(removed, /IVEKIT_RUSTPBX_MEDIA_PROFILE_ID/);
});

test('processing offers contain the frozen codec pair, payload types, and ptime', () => {
  const added = addedLines();

  assert.match(added, /leg_a_codec/);
  assert.match(added, /leg_b_codec/);
  assert.match(added, /leg_a_payload_type/);
  assert.match(added, /leg_b_payload_type/);
  assert.match(added, /packetization_ms/);
  assert.match(added, /processing_offer_contains_frozen_media_profile/);
});

test('processing SIP INFO and overload failures stay on the bound media worker', () => {
  const added = addedLines();

  assert.match(added, /pub async fn submit_sip_info_digit/);
  assert.match(added, /source": "sip_info"/);
  assert.match(added, /sip_info_event_id/);
  assert.match(added, /processing_session_routes_sip_info_digit_with_stable_event_identity/);
  assert.match(added, /CapacityRejected/);
  assert.match(added, /RetryableControlRejected/);
  assert.match(added, /media_control_retry_after_seconds/);
  assert.match(added, /processing_pool_failures_never_fallback_to_local_media/);
  assert.match(added, /reject_with_headers/);
});

test('RWI originate exposes only media-control SDP and reconciles precise cleanup ownership', () => {
  const added = addedLines();

  assert.match(added, /prepare_invite/);
  assert.match(added, /replace_uncommitted_invite_offer/);
  assert.match(added, /IveKitMediaRuntime::bootstrap/);
  assert.match(added, /prepare_ordinary_relay_offer/);
  assert.match(added, /commit_early_media/);
  assert.match(added, /commit_final_answer/);
  assert.match(added, /close_media/);
  assert.match(added, /MediaControlReconcileInput/);
  assert.match(added, /reconciliation_command/);
  assert.match(
    added,
    /close_reconciles_a_lost_offer_result_before_deleting_media/
  );
  assert.match(added, /PendingRwiMediaCleanup/);
  assert.match(added, /RWI_MEDIA_CLEANUP_CONCURRENCY/);
  assert.match(
    added,
    /unresolved_rwi_media_cleanup_is_retained_for_retry/
  );
  assert.match(
    added,
    /pub async fn ensure_owner[\s\S]*Result<bool>/
  );
  assert.match(added, /owner_opened_by_command/);
  assert.match(added, /failed_originate_owner/);
  assert.match(added, /close_owner\(failed_call_id\)/);
  assert.match(
    added,
    /only_a_synchronously_failed_originate_closes_its_owner/
  );
  assert.match(added, /rwi_originate_media_prepare_is_fail_closed/);
});

test('fork manifest records the exact per-session profile patch', () => {
  const manifest = JSON.parse(
    readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8')
  ) as {
    components: Array<{
      component_id: string;
      patches: Array<{ path: string; sha256: string }>;
      implemented_changes: Array<{ change_id: string }>;
    }>;
  };
  const rustpbx = manifest.components.find(
    (component) => component.component_id === 'rustpbx'
  );
  assert.ok(rustpbx);
  const entry = rustpbx.patches.find((item) => item.path === PATCH_PATH);
  assert.ok(entry);
  assert.equal(
    entry.sha256,
    createHash('sha256').update(readFileSync(PATCH_PATH)).digest('hex')
  );
  assert.equal(
    rustpbx.implemented_changes.some(
      (change) => change.change_id === 'rustpbx-session-media-profile-v1'
    ),
    true
  );
});
