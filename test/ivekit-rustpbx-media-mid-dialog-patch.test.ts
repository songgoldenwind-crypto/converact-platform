import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/ivekit/rustpbx/patches/rustpbx-ivekit-media-lifecycle.patch';

function effectivePatch(): string {
  return readFileSync(PATCH_PATH, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .join('\n');
}

test('ordinary relay commits both mid-dialog negotiation directions', () => {
  const effective = effectivePatch();

  assert.match(effective, /prepare_mid_dialog_offer/);
  assert.match(effective, /commit_mid_dialog_answer/);
  assert.match(effective, /MediaDialogSide::Caller/);
  assert.match(effective, /MediaDialogSide::Callee/);
  assert.match(effective, /dialog_tags/);
  assert.match(effective, /MidDialogOffer/);
  assert.match(effective, /MidDialogAnswer/);
  assert.match(
    effective,
    /prepare_mid_dialog_offer[\s\S]*send_mid_dialog_offer_once_with_fallback/
  );
  assert.match(
    effective,
    /commit_mid_dialog_answer[\s\S]*committed_mid_dialog_leg_state/
  );
  assert.match(effective, /same media_reservation_id|media_reservation_id/);
});

test('session refresh, glare and fallback stay bounded', () => {
  const effective = effectivePatch();

  assert.match(effective, /relay_ordinary_media_control_offer/);
  assert.match(effective, /mid_dialog_glare_backoff/);
  assert.match(effective, /StatusCode::RequestPending/);
  assert.match(effective, /MAX_MID_DIALOG_GLARE_RETRIES/);
  assert.match(
    effective,
    /loop \{[\s\S]{0,1200}prepare_mid_dialog_offer[\s\S]{0,1200}StatusCode::RequestPending[\s\S]{0,600}mid_dialog_glare_backoff/
  );
  assert.match(effective, /should_fallback_to_reinvite\(response\.status_code/);
  assert.doesNotMatch(
    effective,
    /method != rsipstack::sip::Method::Update[\s\S]{0,500}retrying as re-INVITE/
  );
});

test('hold state and RTP DTMF become visible only after media commit', () => {
  const effective = effectivePatch();

  assert.match(effective, /committed_mid_dialog_leg_state/);
  assert.match(
    effective,
    /commit_mid_dialog_answer[\s\S]*committed_mid_dialog_leg_state[\s\S]*update_leg_state/
  );
  assert.match(effective, /inject_rtp_dtmf/);
  assert.match(effective, /MediaControlAction::InjectDtmf/);
  assert.match(
    effective,
    /leg_id == LegId::from\("caller"\)[\s\S]*MediaDialogSide::Caller/
  );
  assert.match(
    effective,
    /leg_id == LegId::from\("callee"\)[\s\S]*MediaDialogSide::Callee/
  );
  assert.match(effective, /command_unknown|OutcomeUnknown/);
});

test('unsolicited RTPengine DTMF uses a replayable RustPBX event stream', () => {
  const effective = effectivePatch();

  assert.match(effective, /MediaControlDtmfEvent/);
  assert.match(effective, /consume_events/);
  assert.match(effective, /after_sequence/);
  assert.match(effective, /spawn_media_control_event_listener/);
  assert.match(effective, /owner_node_id/);
  assert.match(effective, /CallCommand::InjectAppEvent/);
  assert.match(effective, /AppEvent::Dtmf/);
  assert.match(effective, /send_command_async/);
});

test('RustPBX deployment references advance atomically to ivekit.27', () => {
  for (const path of [
    'infra/env.example',
    'infra/ivekit/env.example',
    'services/ivekit-service/env.example'
  ]) {
    assert.match(
      readFileSync(path, 'utf8'),
      /RUSTPBX_IMAGE=ivekit\/rustpbx:0\.4\.11-ivekit\.27-6c49ee76/,
      path
    );
  }
});
