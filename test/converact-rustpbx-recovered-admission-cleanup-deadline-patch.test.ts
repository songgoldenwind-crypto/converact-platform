import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-admission-cleanup-deadline.patch';
const PREDECESSOR =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-controller-fault-boundary.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';
const PATCH_SHA256 =
  '489c4400fad54ac4062baf8a75e472a8e4e5016263f42c852e4f26df5268d34b';

function additions(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('ivekit.83 applies the admission cleanup deadline after controller fault containment', () => {
  const patch = readFileSync(PATCH, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), PATCH_SHA256);
  const parsed = spawnSync('git', ['apply', '--numstat', PATCH], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout, '42\t4\tsrc/ivekit_dialog_shadow.rs\n');

  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /PATCHSET="ivekit\.84"/u);
  assert.match(
    build,
    /rustpbx-converact-recovered-controller-fault-boundary\.patch"[\s\S]*rustpbx-converact-recovered-admission-cleanup-deadline\.patch"/u
  );
  assert.equal(readFileSync(PREDECESSOR, 'utf8').length > 0, true);
});

test('recovered admission rejection cannot wait indefinitely for media cleanup', () => {
  const patch = readFileSync(PATCH, 'utf8');
  const source = additions(patch);
  assert.match(source, /recovered_media_cleanup_before_deadline/u);
  assert.match(patch, /async fn close_recovered_media_after_admission_error/u);
  assert.match(
    source,
    /RECOVERED_MEDIA_TERMINATION_TIMEOUT[\s\S]*media\.close_media\(\)/u
  );
  assert.match(source, /tokio::time::timeout\(deadline, future\)/u);
  assert.match(source, /recovered media cleanup reached its hard deadline after Active Call admission rejection/u);
});

test('the deadline helper is behavior-tested without broadening the fault domain', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /recovered_media_cleanup_wait_is_bounded/u);
  assert.match(source, /std::future::pending::<\(\)>\(\)/u);
  assert.doesNotMatch(
    source,
    /std::process::abort|panic::set_hook|unbounded_channel|spawn_blocking|std::thread::spawn/u
  );
  assert.doesNotMatch(
    source,
    /RTP|rtp_packet|calls_per_second|throughput_benchmark|production_eligible/u
  );
});
