import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const RSIPSTACK_PATCH =
  'infra/converact/rustpbx/patches/rsipstack-ivekit-bounded-protocol-mailboxes.patch';
const RUSTPBX_PATCH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-bounded-call-mailboxes.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';

function additions(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

function assertValidPatch(path: string): string {
  assert.equal(existsSync(path), true, `${path} is required`);
  const parsed = spawnSync('git', ['apply', '--numstat', path], {
    encoding: 'utf8',
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  return readFileSync(path, 'utf8');
}

test('rsipstack bounds transaction, dialog, and transport event mailboxes without blocking ingress', () => {
  const patch = assertValidPatch(RSIPSTACK_PATCH);
  const addedSource = additions(patch);

  assert.match(patch, /src\/bounded\.rs/);
  assert.match(patch, /src\/transaction\/transaction\.rs/);
  assert.match(patch, /src\/dialog\/dialog\.rs/);
  assert.match(patch, /src\/transport\/connection\.rs/);
  assert.match(patch, /src\/transport\/transport_layer\.rs/);
  assert.match(addedSource, /TRANSACTION_EVENT_QUEUE_CAPACITY/);
  assert.match(addedSource, /DIALOG_STATE_QUEUE_CAPACITY/);
  assert.match(addedSource, /TRANSPORT_EVENT_QUEUE_CAPACITY/);
  assert.match(addedSource, /TRANSPORT_CONNECTION_EVENT_QUEUE_CAPACITY/);
  assert.match(addedSource, /transport_connection_event_channel/);
  assert.match(addedSource, /BoundedSender/);
  assert.match(addedSource, /try_send/);
  assert.match(addedSource, /protocol_mailbox_stats/);
  assert.match(addedSource, /full_rejections_total/);
  assert.match(addedSource, /closed_rejections_total/);
  assert.doesNotMatch(addedSource, /Mutex|RwLock|unbounded_channel/);
  assert.doesNotMatch(addedSource, /tokio::spawn\(/);
});

test('RustPBX bounds Call actor, timer, dialog, and REFER control paths with rejection telemetry', () => {
  const patch = assertValidPatch(RUSTPBX_PATCH);
  const addedSource = additions(patch);

  assert.match(patch, /src\/call\/app\/controller\.rs/);
  assert.match(patch, /src\/call\/runtime\/default_app_runtime\.rs/);
  assert.match(patch, /src\/call\/domain\/transfer_event\.rs/);
  assert.match(patch, /src\/proxy\/proxy_call\/state\.rs/);
  assert.match(patch, /src\/proxy\/proxy_call\/sip_session\.rs/);
  assert.match(patch, /src\/rwi\/gateway\.rs/);
  assert.match(patch, /src\/rwi\/handler\.rs/);
  assert.match(patch, /src\/sipflow\/backend\/local\.rs/);
  assert.match(addedSource, /CALL_CONTROLLER_EVENT_QUEUE_CAPACITY/);
  assert.match(addedSource, /CALL_CONTROLLER_TIMER_QUEUE_CAPACITY/);
  assert.match(addedSource, /REFER_NOTIFY_QUEUE_CAPACITY/);
  assert.match(addedSource, /RWI_SESSION_EVENT_QUEUE_CAPACITY/);
  assert.match(addedSource, /LOCAL_SIPFLOW_CHANNEL_CAPACITY/);
  assert.match(addedSource, /new_dialog_state_channel/);
  assert.match(addedSource, /try_send/);
  assert.match(addedSource, /rustpbx_call_control_mailbox_rejections_total/);
  assert.match(addedSource, /reason" => reason/);
  assert.doesNotMatch(addedSource, /unbounded_channel/);
  assert.doesNotMatch(addedSource, /tokio::spawn\(/);
});

test('the exact RustPBX build applies bounded protocol mailboxes before bounded Call mailboxes', () => {
  const build = readFileSync(BUILD, 'utf8');

  assert.match(build, /PATCHSET="ivekit\.59"/);
  assert.match(
    build,
    /rsipstack-ivekit-wire-guard\.patch"[\s\S]*rsipstack-ivekit-bounded-protocol-mailboxes\.patch"/
  );
  assert.match(
    build,
    /rustpbx-ivekit-inbound-refer-wire\.patch"[\s\S]*rustpbx-ivekit-bounded-call-mailboxes\.patch"/
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rsipstack" apply --numstat[\s\\\n]+"\$PATCH_DIR\/rsipstack-ivekit-bounded-protocol-mailboxes\.patch"/
  );
  assert.doesNotMatch(build, /"\$PATCH_DIR"\/rsipstack-\*\.patch/);
  assert.match(build, /^\s*cargo test --locked --lib\s*$/m);
});
