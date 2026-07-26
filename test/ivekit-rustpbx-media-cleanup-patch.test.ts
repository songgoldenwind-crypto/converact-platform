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

test('RustPBX closes allocated media with one stable replayable delete', () => {
  const effective = effectivePatch();

  assert.match(effective, /pub async fn close_media/);
  assert.match(effective, /MediaControlAction::Delete/);
  assert.match(effective, /close_command/);
  assert.match(effective, /delete_is_replayed_with_stable_identity_after_unknown/);
  assert.match(effective, /cancel_before_offer_does_not_allocate_or_delete/);
  assert.match(effective, /non_2xx_ack_does_not_allocate_media/);
  assert.match(effective, /close_after_early_and_final_media_is_idempotent/);
  assert.match(effective, /close_after_early_media_uses_both_dialog_tags/);
});

test('SIP cleanup bounds media deletion without weakening durable recovery', () => {
  const effective = effectivePatch();

  assert.match(effective, /MEDIA_CONTROL_CLEANUP_TIMEOUT/);
  assert.match(
    effective,
    /tokio::time::timeout\([\s\S]{0,200}MEDIA_CONTROL_CLEANUP_TIMEOUT[\s\S]{0,600}close_media/
  );
  assert.match(effective, /media_control_cleanup_unconfirmed/);
  assert.match(effective, /orphan|durable reconciliation/);
  assert.match(effective, /CallRecordHangupReason::RtpTimeout/);
});

test('SipSession Drop never issues an identity-free media delete', () => {
  const effective = effectivePatch();
  const start = effective.indexOf('impl Drop for SipSession');
  const end = effective.indexOf('\ndiff --git ', start);
  const drop = start >= 0
    ? effective.slice(start, end >= 0 ? end : undefined)
    : '';

  assert.ok(drop.length > 0);
  assert.doesNotMatch(drop, /close_media|MediaControlAction::Delete|media_reservation_id/);
});
