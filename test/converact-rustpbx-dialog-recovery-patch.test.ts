import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const BUILD = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
const RUSTPBX_PATCH = readFileSync(
  'infra/converact/rustpbx/patches/rustpbx-ivekit-dialog-recovery.patch',
  'utf8'
);
const DUAL_LEG_CDR_PATCH = readFileSync(
  'infra/converact/rustpbx/patches/rustpbx-ivekit-dual-leg-cdr.patch',
  'utf8'
);
const RSIPSTACK_PATCH = readFileSync(
  'infra/converact/rustpbx/patches/rsipstack-ivekit-dialog-recovery.patch',
  'utf8'
);

test('the current patchset retains recovery and mTLS CDR convergence before media tracing', () => {
  assert.match(BUILD, /PATCHSET="ivekit\.63"/);
  assert.match(
    BUILD,
    /rsipstack-ivekit-retransmission-atomicity\.patch"[\s\S]*rsipstack-ivekit-dialog-recovery\.patch"/
  );
  assert.match(
    BUILD,
    /rustpbx-ivekit-dialog-shadow\.patch"[\s\S]*rustpbx-ivekit-dialog-recovery\.patch"[\s\S]*rustpbx-ivekit-dual-leg-cdr\.patch"[\s\S]*rustpbx-ivekit-cdr-mtls-noop\.patch"[\s\S]*rustpbx-ivekit-media-tracing\.patch"[\s\S]*rustpbx-ivekit-inbound-admission-response-contract\.patch"/
  );
});

test('RustPBX recovery patch carries an authenticated atomic two-leg takeover', () => {
  assert.match(RUSTPBX_PATCH, /Aes256Gcm/);
  assert.match(RUSTPBX_PATCH, /DialogRecoveryCapsulePayload/);
  assert.match(RUSTPBX_PATCH, /interaction_id/);
  assert.match(RUSTPBX_PATCH, /DialogShadowCommitPairRequest/);
  assert.match(RUSTPBX_PATCH, /commit-pair/);
  assert.match(RUSTPBX_PATCH, /claim_takeover/);
  assert.match(RUSTPBX_PATCH, /consume_takeover/);
  assert.match(RUSTPBX_PATCH, /check_authority/);
  assert.match(RUSTPBX_PATCH, /spawn_recovered_dialog_controller/);
  assert.match(RUSTPBX_PATCH, /prepare_mid_dialog_offer/);
  assert.match(RUSTPBX_PATCH, /commit_mid_dialog_answer/);
  assert.match(RUSTPBX_PATCH, /close_media/);
  assert.match(RUSTPBX_PATCH, /close_owner/);
});

test('normal cleanup durably terminates both legs without discarding recovery capsules', () => {
  assert.match(RUSTPBX_PATCH, /pub async fn terminate_pair/);
  assert.match(RUSTPBX_PATCH, /\.terminate_pair\("normal_session_cleanup"\)/);
  assert.match(
    RUSTPBX_PATCH,
    /normal_runtime_commits_recoverable_terminal_state_as_one_pair/
  );
  assert.match(RUSTPBX_PATCH, /record\.state == DialogShadowState::Terminated/);
  assert.match(RUSTPBX_PATCH, /record\.recovery_capsule\.is_some\(\)/);
  assert.match(RUSTPBX_PATCH, /\.terminate_pair\("duplicate_cleanup"\)/);
  assert.match(RUSTPBX_PATCH, /\.is_none\(\)/);
});

test('recovered finalization freezes CDR bytes and retries shadow without re-emitting CDR', () => {
  assert.match(
    DUAL_LEG_CDR_PATCH,
    /pub async fn emit_recovered_terminal_cdr\([\s\S]*?ended_at: &str/
  );
  assert.match(
    DUAL_LEG_CDR_PATCH,
    /emit_recovered_terminal_cdr\([\s\S]*?cdr_sequence,[\s\S]*?&ended_at/
  );
  const shadowRetry = DUAL_LEG_CDR_PATCH.match(
    /async fn retry_recovered_terminal_shadow[\s\S]*?\n\+\}/
  )?.[0] || '';
  assert.doesNotMatch(shadowRetry, /emit_recovered_terminal_cdr/);
  assert.match(shadowRetry, /commit_pair/);
});

test('recovered dialog controller has bounded backpressure and freezes uncertain authority', () => {
  assert.match(
    RUSTPBX_PATCH,
    /const RECOVERED_DIALOG_EVENT_CAPACITY: usize = 64/
  );
  assert.match(
    RUSTPBX_PATCH,
    /RECOVERED_DIALOG_TERMINAL_ENQUEUE_TIMEOUT: Duration = Duration::from_millis\(100\)/
  );
  assert.match(
    RUSTPBX_PATCH,
    /tokio::sync::mpsc::channel\(RECOVERED_DIALOG_EVENT_CAPACITY\)/
  );
  assert.doesNotMatch(RUSTPBX_PATCH, /unbounded_channel/);
  assert.match(
    RUSTPBX_PATCH,
    /DialogShadowError::OutcomeUnknown[\s\S]*DialogShadowError::ReconcileRequired[\s\S]*self\.frozen = true/
  );
});

test('recovery saga publishes new dialog authority before media takeover and claim consumption', () => {
  const commit = RUSTPBX_PATCH.indexOf('let active_records = match commit_recovered_shadow_pair(');
  const media = RUSTPBX_PATCH.indexOf(
    'let takeover = crate::ivekit_media_lifecycle::takeover_recovered_media(',
    commit
  );
  const consume = RUSTPBX_PATCH.indexOf('.consume_takeover(&consume_request', media);

  assert.notEqual(commit, -1);
  assert.notEqual(media, -1);
  assert.notEqual(consume, -1);
  assert.ok(commit < media);
  assert.ok(media < consume);
});

test('media takeover queries authority and replays one exact command without destructive recovery', () => {
  assert.match(
    RUSTPBX_PATCH,
    /let existing = recovery_session\(executor\.as_ref\(\), &input\.media_reservation_id\)\.await\?/
  );
  assert.match(
    RUSTPBX_PATCH,
    /let command =[\s\S]*build_recovered_media_takeover_command[\s\S]*for attempt in 0\.\.2/
  );
  assert.match(
    RUSTPBX_PATCH,
    /MediaControlExecutor::execute\(executor\.as_ref\(\), &command\)/
  );
  assert.match(
    RUSTPBX_PATCH,
    /admission_reservation_id: admission_reservation_id\.to_string\(\)/
  );
  assert.match(RUSTPBX_PATCH, /MediaLifecycleError::ReconcileRequired/);
  assert.doesNotMatch(RUSTPBX_PATCH, /MediaControlCommand::Delete/);
});

test('recovered requests cannot relay dialog, transaction, or authentication identity', () => {
  for (const header of [
    'authorization',
    'call-id',
    'contact',
    'cseq',
    'from',
    'proxy-authorization',
    'record-route',
    'route',
    'to',
    'via',
    'www-authenticate',
    'x-ivekit-recovery'
  ]) {
    assert.match(RUSTPBX_PATCH, new RegExp(`"${header}"`));
  }
  assert.match(
    RUSTPBX_PATCH,
    /relayed_headers_drop_dialog_transaction_and_authentication_identity/
  );
});

test('rsipstack keeps every handled in-dialog event on the confirmed authority', () => {
  for (const state of ['Updated', 'Publish', 'Notify', 'Refer', 'Message', 'Info', 'Options']) {
    assert.match(RSIPSTACK_PATCH, new RegExp(`DialogState::${state}`));
  }
  assert.match(RSIPSTACK_PATCH, /pub fn snapshot\(&self\) -> DialogSnapshot/);
  assert.match(RSIPSTACK_PATCH, /must not replace the durable dialog state/);
});

test('successful target refresh updates the next in-dialog request URI', () => {
  assert.match(
    RSIPSTACK_PATCH,
    /self\.refresh_remote_target_from_response\(&method, &resp\)\?/
  );
  assert.match(
    RSIPSTACK_PATCH,
    /matches!\(method, Method::Invite \| Method::Update\)/
  );
  assert.match(RSIPSTACK_PATCH, /target refresh response must contain one Contact/);
  assert.match(
    RSIPSTACK_PATCH,
    /let remote_uri = contact\.uri\.clone\(\);[\s\S]*self\.set_remote_target\(remote_uri/
  );
  assert.match(
    RSIPSTACK_PATCH,
    /expect\("failed to receive INFO transaction"\)[\s\S]*refreshed\.example\.com/
  );
});
