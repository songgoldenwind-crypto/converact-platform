import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-worker-registry-isolation.patch';
const PREDECESSOR =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-dialog-worker-supervision.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';
const PATCH_SHA256 =
  '5bbacdd3b2dc4c1dc377c82d56bfabc8e73efc306b150c6fb6f24825ca57976a';

function additions(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('ivekit.85 adds exact registry-isolation evidence after worker supervision', () => {
  const patch = readFileSync(PATCH, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), PATCH_SHA256);
  const parsed = spawnSync('git', ['apply', '--numstat', PATCH], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout, '95\t0\tsrc/ivekit_dialog_shadow.rs\n');

  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /PATCHSET="ivekit\.85"/u);
  assert.match(
    build,
    /rustpbx-converact-recovered-dialog-worker-supervision\.patch"[\s\S]*rustpbx-converact-recovered-worker-registry-isolation\.patch"/u
  );
  assert.equal(readFileSync(PREDECESSOR, 'utf8').length > 0, true);
});

test('fault evidence registers two distinct recovered Calls before injection', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /recovered_worker_panic_cleanup_preserves_unrelated_active_call/u);
  assert.match(source, /call-session-unaffected/u);
  assert.match(source, /call-session-worker-fault/u);
  assert.match(source, /assert_eq!\(registry\.count\(\), 2\)/u);
  assert.match(source, /register_recovered_call/u);
});

test('the actual worker panic report releases only the affected cleanup lease', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /report_recovered_dialog_worker_exit/u);
  assert.match(source, /recovered worker registry isolation fault injection/u);
  assert.match(source, /RecoveredDialogWorkerExitKind::Panicked/u);
  assert.match(source, /drop\(affected_lease\)/u);
  assert.match(source, /registry\.get\(affected_session\)\.is_none\(\)/u);
  assert.match(source, /dialog-worker-fault-caller/u);
});

test('unrelated Call and Dialog indexes survive without broad fault claims', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /assert_eq!\(registry\.count\(\), 1\)/u);
  assert.match(source, /registry\.get\(unaffected_session\)\.is_some\(\)/u);
  assert.match(source, /dialog-unaffected-caller/u);
  assert.match(source, /unaffected_cleanup\.remove_original/u);
  assert.doesNotMatch(
    source,
    /std::process::abort|spawn_blocking|std::thread::spawn|global_registry|unbounded_channel/u
  );
  assert.doesNotMatch(
    source,
    /RTP|rtp_packet|calls_per_second|throughput_benchmark|production_eligible/u
  );
});
