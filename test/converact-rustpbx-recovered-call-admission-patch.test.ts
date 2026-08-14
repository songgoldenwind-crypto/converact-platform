import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-call-admission.patch';
const PREDECESSOR =
  'infra/converact/rustpbx/patches/rustpbx-converact-durable-sip-runtime-composition.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';
const VOICE_HTTP = 'src/agent-runtime/converact/voice/http.ts';
const VOICE_HTTP_TEST = 'test/converact-voice-http.test.ts';
const PATCH_SHA256 =
  'db62ef488199d9c10dfa54edf7a70037ad3c3a175530c65cbec36918e52b4d9c';

function additions(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('ivekit.79 applies exact recovered admission after durable composition', () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  assert.equal(existsSync(PREDECESSOR), true, `${PREDECESSOR} is required`);
  const patch = readFileSync(PATCH, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), PATCH_SHA256);

  const parsed = spawnSync('git', ['apply', '--numstat', PATCH], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(
    parsed.stdout,
    '75\t4\tsrc/call/adapters/native_sip_effect_capabilities.rs\n' +
      '387\t15\tsrc/ivekit_owner.rs\n' +
      '53\t1\tsrc/proxy/active_call_registry.rs\n' +
      '92\t13\tsrc/proxy/proxy_call/sip_session.rs\n' +
      '149\t19\tsrc/proxy/routing/http.rs\n'
  );

  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /PATCHSET="ivekit\.79"/u);
  assert.match(
    build,
    /rustpbx-converact-durable-sip-runtime-composition\.patch"[\s\S]*rustpbx-converact-recovered-call-admission\.patch"/u
  );
});

test('fresh and recovered owner proofs are closed and missing proof fails durable admission', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /enum HttpNativeCallAdmission/u);
  assert.match(source, /serde\(tag = "mode", rename_all = "snake_case", deny_unknown_fields\)/u);
  assert.match(source, /Fresh/u);
  assert.match(source, /Recovered \{[\s\S]*predecessor:.*NativeCallRecoveryBinding/u);
  assert.match(source, /enum NativeCallOwnerProof/u);
  assert.match(source, /LegacyUnspecified if runtime_enabled => Err/u);
  assert.match(source, /None if runtime_enabled => Err/u);
  assert.match(source, /native_call_recovery_binding_for_runtime/u);
  assert.match(source, /durable native call admission requires explicit fresh or recovered proof/u);
  assert.match(source, /native call recovery requires the VOICE-HA-T1 profile/u);
  assert.match(source, /recover_from_binding\([\s\S]*native_identity\.owner_epoch\(\)/u);
  assert.match(source, /snapshot_admission_has_no_implicit_recovery_binding/u);
  assert.match(source, /snapshot_admission_accepts_only_an_exact_closed_recovery_binding/u);
});

test('one owner snapshot feeds registry and recovery oracle and fences replacement cleanup', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /let native_owner_admission =.*owner_native_call_admission/u);
  assert.match(source, /register_handle_with_identity\([\s\S]*admission\.identity\.clone\(\)/u);
  assert.match(source, /install_for_admitted_or_recovered_native_call/u);
  assert.match(source, /install_recovered_unconsumed_call/u);
  assert.match(source, /admission\.assert_current\(&session_id\)/u);
  assert.match(source, /Arc::ptr_eq\(current\.value\(\), &self\.entry\)/u);
  assert.match(source, /close_if_current/u);
  assert.match(source, /stale_native_call_admission_cannot_close_a_replacement_owner/u);
  assert.match(source, /cleanup_fence_for_identity/u);
  assert.match(source, /register_handle_with_identity_and_cleanup_fence/u);
  assert.match(source, /cleanup_fence\.remove_original\(&server\.active_call_registry\)/u);
  assert.doesNotMatch(source, /active_call_registry\.remove\(&session_id\)/u);
  assert.match(
    source,
    /fn current_owner_entry\([\s\S]*Arc::ptr_eq\(&current, expected_entry\)[\s\S]*fn start_refresh\([\s\S]*expected_entry: Arc<OwnerEntry>[\s\S]*current_owner_entry\(&provider_call_id, &expected_entry\)/u
  );
  assert.match(
    source,
    /stale_refresh_identity_cannot_follow_a_replacement_owner/u
  );
  assert.match(source, /recovered_admission_invokes_the_oracle_instead_of_ordinary_installation/u);
  assert.match(source, /recovered_admission_cannot_downgrade_when_the_runtime_is_absent/u);
  assert.doesNotMatch(source, /unbounded_channel|std::thread::spawn|fallback_to_memory/u);
});

test('control plane emits fresh only from a newly prepared reservation', () => {
  const voice = readFileSync(VOICE_HTTP, 'utf8');
  const contractTest = readFileSync(VOICE_HTTP_TEST, 'utf8');
  assert.match(
    voice,
    /inboundPlacement\.reservation[\s\S]{0,160}native_call_admission: \{ mode: 'fresh' as const \}/u
  );
  assert.match(contractTest, /reservation: null/u);
  assert.match(
    contractTest,
    /Object\.hasOwn\(replay\.data, 'native_call_admission'\), false/u
  );
  assert.doesNotMatch(voice, /native_call_admission:\s*\{\s*mode:\s*'recovered'/u);
});

test('the admission slice is functional-only and does not claim production or performance', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.doesNotMatch(
    source,
    /criterion|calls_per_second|requests_per_second|throughput_benchmark|production_eligible/u
  );
});
