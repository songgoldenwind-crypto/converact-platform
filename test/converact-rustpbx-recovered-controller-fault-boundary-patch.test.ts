import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-controller-fault-boundary.patch';
const PREDECESSOR =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-active-call.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';
const PATCH_SHA256 =
  '145094cec96b2e441acb4fe2873d2bc29c7901c43562996450f81ed4f732649f';

function additions(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('ivekit.82 applies the recovered controller fault boundary after Active Call recovery', () => {
  const patch = readFileSync(PATCH, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), PATCH_SHA256);
  const parsed = spawnSync('git', ['apply', '--numstat', PATCH], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout, '63\t3\tsrc/ivekit_dialog_shadow.rs\n');

  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /PATCHSET="ivekit\.83"/u);
  assert.match(
    build,
    /rustpbx-converact-recovered-active-call\.patch"[\s\S]*rustpbx-converact-recovered-controller-fault-boundary\.patch"/u
  );
  assert.equal(readFileSync(PREDECESSOR, 'utf8').length > 0, true);
});

test('recovered controller panic is contained and cleanup has hard deadlines', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /AssertUnwindSafe\(future\)\.catch_unwind\(\)/u);
  assert.match(source, /recovered_controller_panicked/u);
  assert.match(source, /RECOVERED_CONTROLLER_PANIC_CLEANUP_TIMEOUT/u);
  assert.match(source, /Duration::from_secs\(8\)/u);
  assert.match(source, /RECOVERED_MEDIA_TERMINATION_TIMEOUT/u);
  assert.match(source, /Duration::from_secs\(2\)/u);
  assert.match(source, /tokio::time::timeout/u);
  assert.match(source, /self\.terminate_all\("controller_panic"\)/u);
});

test('fault containment remains a child control-path concern', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.doesNotMatch(
    source,
    /std::process::abort|panic::set_hook|unbounded_channel|spawn_blocking|std::thread::spawn/u
  );
  assert.doesNotMatch(
    source,
    /RTP|rtp_packet|calls_per_second|throughput_benchmark|production_eligible/u
  );
});
