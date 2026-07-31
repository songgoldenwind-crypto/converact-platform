import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-dialog-shadow.patch';

function effectivePatch(): string {
  return readFileSync(PATCH_PATH, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .join('\n');
}

test('RustPBX dialog shadow records bounded recovery state without raw secrets', () => {
  const effective = effectivePatch();
  const start = effective.indexOf('pub struct DialogShadowRecord');
  const end = effective.indexOf(
    'pub struct DialogShadowCommitRequest',
    start
  );
  const record = effective.slice(start, end);

  assert.ok(record.length > 0);
  for (const field of [
    'local_tag',
    'remote_tag',
    'route_set',
    'local_cseq',
    'remote_cseq',
    'call_id_hash',
    'branch_hash',
    'final_response_hash',
    'auth_context_ref',
    'logical_offer_hash',
    'logical_answer_hash',
    'media_reservation_id',
    'provider_session_ref',
    'cdr_sequence'
  ]) {
    assert.match(record, new RegExp(`pub ${field}:`), field);
  }
  assert.doesNotMatch(record, /raw_call_id|raw_branch_identity|logical_offer_sdp/);
  assert.match(effective, /route_set_rejects_userinfo_and_unbounded_entries/);
  assert.match(effective, /shadow_records_hash_sensitive_dialog_material/);
});

test('RustPBX freezes uncertain shadow commits and advances only exact proofs', () => {
  const effective = effectivePatch();

  assert.match(
    effective,
    /pending: Option<\(DialogShadowEvent, DialogShadowCommitRequest\)>/
  );
  assert.match(effective, /OutcomeUnknown/);
  assert.match(effective, /unknown_commit_replays_the_exact_shadow_identity/);
  assert.match(effective, /mismatched_proof_freezes_the_sequence/);
  assert.match(effective, /committed_states_advance_monotonically/);
  assert.match(effective, /http_client_sends_bounded_authenticated_commit/);
  assert.match(effective, /production.*https|https.*production/s);
  assert.match(effective, /service_token_file/);
  assert.match(effective, /max_response_bytes/);
});

test('RustPBX commits both B2BUA legs before visible dialog success', () => {
  const effective = effectivePatch();

  assert.match(
    effective,
    /commit_dialog_shadow_before_visible_response[\s\S]{0,1500}server_dialog\.ringing/
  );
  assert.match(
    effective,
    /Some\("200 OK"\.to_string\(\)\)[\s\S]{0,1800}accept_call/
  );
  assert.match(
    effective,
    /DialogShadowState::Updating[\s\S]{0,1800}tx_handle[\s\S]{0,100}\.respond/
  );
  assert.match(effective, /vec!\[dialog_id\.clone\(\), self\.server_dialog\.id\(\)\]/);
  assert.match(effective, /connected_callee_dialog_id/);
});

test('RustPBX keeps ordinary calls independent and fails T1 closed', () => {
  const effective = effectivePatch();

  assert.match(effective, /"VOICE-ORDINARY" => return Self::Disabled/);
  assert.match(effective, /const PROFILE_T1: &str = "VOICE-HA-T1"/);
  assert.match(effective, /dialog_shadow_not_configured/);
  assert.match(effective, /dialog_shadow_auth_context_missing/);
  assert.match(
    effective,
    /assert_admission\(\)[\s\S]{0,800}register_handle/
  );
  assert.match(effective, /t1_admission_requires_two_fault_domains/);
  assert.match(effective, /DialogShadowError::Unavailable/);
});
