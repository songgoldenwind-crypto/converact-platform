import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const RSIPSTACK_PATCH =
  'infra/converact/rustpbx/patches/rsipstack-ivekit-server-invite-lifecycle.patch';
const RUSTPBX_PATCH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-server-invite-owner.patch';
const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
const rsipstackPatch = readFileSync(RSIPSTACK_PATCH, 'utf8');
const rustpbxPatch = readFileSync(RUSTPBX_PATCH, 'utf8');
const manifest = JSON.parse(
  readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8')
) as {
  revision: number;
  components: Array<{
    component_id: string;
    patches: Array<{ path: string; sha256: string }>;
    implemented_changes: Array<{ change_id: string }>;
    verification: { evidence_paths: string[] };
  }>;
};

function effective(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .map((line) =>
      line.startsWith('+') && !line.startsWith('+++') ? line.slice(1) : line
    )
    .join('\n');
}

test('ivekit.42 retains the server INVITE lifecycle and owner patches in order', () => {
  assert.equal(spawnSync('git', ['apply', '--numstat', RSIPSTACK_PATCH]).status, 0);
  assert.equal(spawnSync('git', ['apply', '--numstat', RUSTPBX_PATCH]).status, 0);
  assert.match(build, /PATCHSET="ivekit\.52"/);
  assert.match(
    build,
    /rsipstack-ivekit-single-trying\.patch"[\s\S]*rsipstack-ivekit-server-invite-lifecycle\.patch"[\s\S]*rsipstack-ivekit-wire-guard\.patch"[\s\S]*rustrtc-ivekit-udp-socket-capacity\.patch"/
  );
  assert.match(
    build,
    /rustpbx-ivekit-processing-ivr-execution\.patch"[\s\S]*rustpbx-ivekit-server-invite-owner\.patch"/
  );
});

test('the fork manifest binds both lifecycle patches and their evidence', () => {
  assert.equal(manifest.revision, 64);
  for (const [componentId, patchPath, contents, changeId] of [
    ['rsipstack', RSIPSTACK_PATCH, rsipstackPatch, 'rsipstack-server-invite-lifecycle-v1'],
    ['rustpbx', RUSTPBX_PATCH, rustpbxPatch, 'rustpbx-server-invite-owner-v1']
  ] as const) {
    const component = manifest.components.find(
      (candidate) => candidate.component_id === componentId
    );
    assert.ok(component, componentId);
    const patch = component.patches.find((candidate) => candidate.path === patchPath);
    assert.equal(
      patch?.sha256,
      createHash('sha256').update(contents).digest('hex'),
      patchPath
    );
    assert.ok(
      component.implemented_changes.some((change) => change.change_id === changeId),
      changeId
    );
    assert.ok(component.verification.evidence_paths.includes(patchPath), patchPath);
  }
  const rsipstack = manifest.components.find(
    (component) => component.component_id === 'rsipstack'
  );
  assert.ok(
    rsipstack?.verification.evidence_paths.includes(
      'test/ivekit-rsipstack-server-invite-lifecycle-patch.test.ts'
    )
  );
});

test('rsipstack implements the RFC 3261 300-699 G/H/I lifecycle', () => {
  const source = effective(rsipstackPatch);
  const added = rsipstackPatch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');

  assert.match(source, /pub t2: Duration/);
  assert.match(source, /TimerH\(TransactionKey\)/);
  assert.match(source, /TimerI\(TransactionKey\)/);
  assert.match(source, /\(300\.\.=699\)\.contains/);
  assert.match(source, /duration \* 2\)\.min\(self\.endpoint_inner\.option\.t2\)/);
  assert.match(source, /ServerInviteTermination::TimerHExpired/);
  assert.match(source, /ServerInviteTermination::TransportError/);
  assert.match(source, /send_frozen_last_response/);
  assert.match(
    source,
    /connection[\s\S]*\.send\(response\.clone\(\), self\.destination\.as_ref\(\)\)[\s\S]*self\.last_response\.replace/
  );
  assert.match(source, /duplicate_invite_replays_frozen_post_inspector_response/);
  assert.match(source, /timer_g_doubles_to_t2_and_replays_frozen_udp_response/);
  assert.match(source, /reliable_transport_uses_h_but_no_g_or_i/);
  assert.match(
    source,
    /async_final_response_send_failure_terminates_and_notifies_owner/
  );
  assert.match(
    source,
    /self\.respond\(response\)\.await\.is_err\(\) && self\.is_terminated\(\)/
  );
  assert.match(source, /endpoint_capacity_emergency_503_remains_stateless/);
  assert.doesNotMatch(rsipstackPatch, /src\/transport\/connection\.rs/);
  assert.doesNotMatch(added, /notify_waiters\(\)/);
});

test('timer head changes retain a wake permit without non-head wakeups', () => {
  const source = effective(rsipstackPatch);
  assert.match(source, /if should_notify \{[\s\S]*self\.notify\.notify_one\(\)/);
  assert.match(source, /if was_head \{[\s\S]*self\.notify\.notify_one\(\)/);
  assert.match(source, /new_head_notification_is_retained_before_waiter_registration/);
  assert.match(
    source,
    /wait_for_ready_ignores_non_head_insert_and_wakes_for_earlier_deadline/
  );
});

test('RustPBX releases business concurrency before bounded protocol retention', () => {
  const source = effective(rustpbxPatch);
  const latency = source.indexOf('latency_seconds');
  const released = source.indexOf('runnings_tx.fetch_sub');
  const retained = source.lastIndexOf('retain_server_invite_owner(&token, &mut tx)');

  assert.ok(latency >= 0);
  assert.ok(released > latency);
  assert.ok(retained > released);
  assert.match(source, /token\.clone\(\)\.drop_guard\(\)/);
  assert.match(
    source,
    /spawn\(Self::reject_max_concurrency_and_retain\(token, tx\)\)/
  );
  assert.match(source, /drain_non_2xx_server_invite/);
  assert.match(source, /rustpbx_sip_server_invite_terminations_total/);
  assert.match(source, /"cause" => "timer_h_expired"/);
  assert.match(source, /"cause" => "transport_error"/);
  assert.doesNotMatch(source, /warn!\(key = %tx\.key, \?termination/);
  assert.match(source, /ivekit_server_invite_owner_survives_module_return_until_cancelled/);
  assert.match(source, /ivekit_max_concurrency_rejection_retains_owner_until_cancelled/);
  assert.match(
    build,
    /^\s*cargo test --manifest-path \/build\/rsipstack\/Cargo\.toml --offline\s*$/m
  );
});
