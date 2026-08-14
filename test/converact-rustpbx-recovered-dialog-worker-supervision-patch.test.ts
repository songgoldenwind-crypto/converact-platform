import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-dialog-worker-supervision.patch';
const PREDECESSOR =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-admission-cleanup-deadline.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';
const PATCH_SHA256 =
  '4ee5e5b33e777aba508097c1b1018651036fd33fade8db624458107734066185';

function additions(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('ivekit.84 applies worker supervision after admission cleanup bounding', () => {
  const patch = readFileSync(PATCH, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), PATCH_SHA256);
  const parsed = spawnSync('git', ['apply', '--numstat', PATCH], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout, '197\t47\tsrc/ivekit_dialog_shadow.rs\n');

  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /PATCHSET="ivekit\.85"/u);
  assert.match(
    build,
    /rustpbx-converact-recovered-admission-cleanup-deadline\.patch"[\s\S]*rustpbx-converact-recovered-dialog-worker-supervision\.patch"/u
  );
  assert.equal(readFileSync(PREDECESSOR, 'utf8').length > 0, true);
});

test('exactly two recovered Dialog workers have one bounded exit channel', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /RECOVERED_DIALOG_WORKER_EXIT_CAPACITY: usize = 2/u);
  assert.match(
    source,
    /mpsc::channel\(RECOVERED_DIALOG_WORKER_EXIT_CAPACITY\)[\s\S]*for \(side, _, receiver\) in receivers/u
  );
  assert.match(source, /report_recovered_dialog_worker_exit/u);
  assert.match(source, /run_recovered_dialog_worker/u);
  assert.doesNotMatch(source, /unbounded_channel/u);
});

test('panic and unexpected exit notify the sole controller while cancellation stays silent', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /AssertUnwindSafe\(future\)\.catch_unwind\(\)/u);
  assert.match(source, /RecoveredDialogWorkerExitKind::Panicked/u);
  assert.match(source, /Ok\(RecoveredDialogWorkerExitKind::Cancelled\) => return/u);
  assert.match(source, /RecoveredDialogWorkerExitKind::ReceiverClosed/u);
  assert.match(source, /try_send\(RecoveredDialogWorkerExit \{ side, kind \}\)/u);
});

test('worker loss terminates only the exact recovered Call and controller exit cancels siblings', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /worker_exit_receiver\.recv\(\)/u);
  assert.match(source, /let mut worker_exit_open = true/u);
  assert.match(
    source,
    /worker_exit_receiver\.recv\(\), if worker_exit_open[\s\S]*None => \{[\s\S]*worker_exit_open = false;[\s\S]*continue;/u
  );
  assert.match(
    source,
    /Ok\(\(\)\) if terminal => return RecoveredDialogWorkerExitKind::Cancelled/u
  );
  assert.match(source, /self\.terminate_all\(reason\)\.await/u);
  assert.match(source, /self\.worker_cancel\.cancel\(\)/u);
  assert.match(source, /dialog_event_worker_panicked/u);
  assert.match(source, /recovered_dialog_worker_exit_is_reported_without_unbounded_supervision/u);
  assert.doesNotMatch(
    source,
    /std::process::abort|panic::set_hook|spawn_blocking|std::thread::spawn|global_registry/u
  );
  assert.doesNotMatch(
    source,
    /RTP|rtp_packet|calls_per_second|throughput_benchmark|production_eligible/u
  );
});
