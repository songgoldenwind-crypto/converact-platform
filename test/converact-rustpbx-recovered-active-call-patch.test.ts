import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-active-call.patch';
const PREDECESSOR =
  'infra/converact/rustpbx/patches/rustpbx-converact-trusted-recovery-proof.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';
const PATCH_SHA256 =
  '2f45849d742e99a2a3716ff7831179bb3a68c5072fc498df42b894145bd263e9';

function additions(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('ivekit.81 applies recovered Active Call authority after trusted proof', () => {
  const patch = readFileSync(PATCH, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), PATCH_SHA256);
  const parsed = spawnSync('git', ['apply', '--numstat', PATCH], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(
    parsed.stdout,
    [
      '83\t0\tsrc/proxy/proxy_call/sip_session.rs',
      '177\t0\tsrc/proxy/active_call_registry.rs',
      '1\t0\tsrc/proxy/call.rs',
      '285\t60\tsrc/ivekit_dialog_shadow.rs',
      ''
    ].join('\n')
  );

  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /PATCHSET="ivekit\.85"/u);
  assert.match(
    build,
    /rustpbx-converact-trusted-recovery-proof\.patch"[\s\S]*rustpbx-converact-recovered-active-call\.patch"/u
  );
  assert.equal(readFileSync(PREDECESSOR, 'utf8').length > 0, true);
});

test('recovered call reuses the sole registry and publishes one confirmed inbound leg', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /register_recovered_call/u);
  assert.match(source, /restore_recovered_native_call_confirmed/u);
  for (const event of [
    'InboundInviteObserved',
    'Final2xx',
    'Invite2xxAckObserved'
  ]) {
    assert.match(source, new RegExp(`NativeLegEvent::${event}`, 'u'));
  }
  assert.match(source, /NativeLegState::Confirmed/u);
  assert.match(source, /active_call_registry/u);
  assert.match(source, /\[caller_dialog_id\.to_string\(\), callee_dialog_id\.to_string\(\)\]/u);
  assert.doesNotMatch(source, /struct RecoveredActiveCallRegistry/u);
});

test('recovered control is bounded, explicit and cleanup-fenced', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /mpsc::channel\(CMD_CHANNEL_CAPACITY\)/u);
  assert.match(source, /SipSessionCommandScope::RecoveredDialog/u);
  assert.match(source, /command\.leg_id\.is_none\(\)/u);
  assert.match(source, /command\.cascade == HangupCascade::All/u);
  assert.match(source, /RecoveredActiveCallLease/u);
  assert.match(source, /cleanup_fence\.remove_original\(&self\.registry\)/u);
  assert.match(source, /tokio::select!/u);
  assert.doesNotMatch(source, /unbounded_channel|spawn_blocking|std::thread::spawn/u);
});

test('confirmed-dialog recovery never fabricates the original INVITE Oracle facts', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.doesNotMatch(
    source,
    /install_for_admitted_or_recovered_native_call|TransactionKey::from_request|ServerInvite/u
  );
  assert.doesNotMatch(
    source,
    /criterion|calls_per_second|throughput_benchmark|production_eligible/u
  );
});
