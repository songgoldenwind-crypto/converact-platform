import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-media-lifecycle.patch';

function effectivePatch(): string {
  return readFileSync(PATCH_PATH, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .join('\n');
}

test('RustPBX media lifecycle patch is ordered and exact-source applicable', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8');
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');

  assert.equal(
    spawnSync('git', ['apply', '--numstat', PATCH_PATH]).status,
    0
  );
  assert.match(
    build,
    /rustpbx-ivekit-media-control-client\.patch"[\s\S]*rustpbx-ivekit-media-lifecycle\.patch"/
  );
  assert.match(build, /PATCHSET="ivekit\.64"/);
  assert.match(patch, /IveKitMediaLifecycle/);
  assert.match(patch, /OrdinaryRelay/);
});

test('session freezes an immutable bounded media admission binding', () => {
  const effective = effectivePatch();

  assert.match(effective, /MediaAdmissionBinding/);
  assert.match(effective, /tenant_id/);
  assert.match(effective, /cell_id/);
  assert.match(effective, /owner_node_id/);
  assert.match(effective, /owner_epoch/);
  assert.match(effective, /admission_reservation_id/);
  assert.match(
    effective,
    /admission_reservation_id:\s*self\.binding\.admission_reservation_id\(\)\.to_string\(\)/
  );
  assert.match(effective, /media_profile_id/);
  assert.match(effective, /MAX_MEDIA_LEGS/);
  assert.match(effective, /MAX_MEDIA_BRANCHES/);
  assert.doesNotMatch(
    effective,
    /struct (IveKitMediaLifecycle|MediaAdmissionBinding)[\s\S]{0,800}(service_token|private_key|authorization):/
  );
});

test('RustPBX validates SIP tags with their RFC 3261 token grammar', () => {
  const effective = effectivePatch();

  assert.match(effective, /fn valid_sip_tag/);
  assert.match(effective, /valid_sip_tag\(from_tag\)/);
  assert.match(effective, /valid_sip_tag\(to_tag\)/);
  assert.match(effective, /b'!' \| b'%' \| b'\*' \| b'_' \| b'\+'/);
  assert.match(effective, /b'`' \| b'\\'' \| b'~'/);
});

test('ordinary relay commits effective SDP before visible SIP responses', () => {
  const effective = effectivePatch();

  assert.match(effective, /prepare_ordinary_relay_offer/);
  assert.match(effective, /effective_sdp/);
  assert.match(effective, /commit_early_media/);
  assert.match(effective, /commit_final_answer/);
  assert.match(effective, /prepare_callee_media_offer\(target\)\.await\?/);
  assert.match(effective, /commit_early_media_before_caller_183/);
  assert.match(effective, /commit_final_answer_before_caller_200/);
  assert.match(effective, /server_dialog\.ringing/);
  assert.match(effective, /MediaControlAction::Offer/);
  assert.match(effective, /MediaControlAction::Update/);
  assert.match(effective, /MediaControlAction::Answer/);
});

test('offerless, late-offer, branch winner and compensation are explicit', () => {
  const effective = effectivePatch();

  assert.match(effective, /OfferlessInvite/);
  assert.match(effective, /AwaitingAckAnswer/);
  assert.match(effective, /EarlyMedia/);
  assert.match(effective, /Committed/);
  assert.match(effective, /select_winning_branch/);
  assert.match(effective, /delete_losing_branch/);
  assert.match(effective, /cancel_before_answer/);
  assert.match(effective, /send_487_once/);
});

test('local media profiles stay local and remote failures never silently bypass', () => {
  const effective = effectivePatch();

  assert.match(effective, /LocalMediaGraph/);
  assert.match(effective, /Ivr/);
  assert.match(effective, /Conference/);
  assert.match(effective, /Transcoding/);
  assert.match(effective, /WebRtcBridge/);
  assert.match(effective, /ExplicitBypass/);
  assert.match(effective, /FailClosed/);
  assert.match(effective, /ExplicitFallback/);
  assert.match(effective, /Unknown/);
  assert.match(effective, /reconcile_required/);
  assert.doesNotMatch(effective, /unwrap_or.*bypass|unwrap_or_else.*bypass/);
});

test('media-control failures retain a safe diagnostic code across the lifecycle boundary', () => {
  const effective = effectivePatch();
  const clientPatch = readFileSync(
    'infra/converact/rustpbx/patches/rustpbx-ivekit-media-control-client.patch',
    'utf8'
  )
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .join('\n');

  assert.match(
    clientPatch,
    /impl MediaControlClientError[\s\S]*pub fn failure_code\(&self\) -> &str/
  );
  assert.match(
    effective,
    /ControlRejected\s*\{\s*code: String\s*\}/
  );
  assert.match(
    effective,
    /Err\(error\)[\s\S]{0,300}error\.failure_code\(\)\.to_string\(\)/
  );
  assert.match(
    effective,
    /failure_code = error\.failure_code\(\)/
  );
  assert.match(
    effective,
    /Err\(error\)[\s\S]{0,300}ControlRejected\s*\{[\s\S]{0,120}error\.failure_code\(\)\.to_string\(\)/
  );
});
