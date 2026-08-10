import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-recording-lifecycle-reservation.patch';

test('RustPBX reserves asynchronous recording start and releases every lifecycle edge', () => {
  assert.equal(existsSync(PATCH_PATH), true, `${PATCH_PATH} is required`);
  const patch = readFileSync(PATCH_PATH, 'utf8');

  assert.match(patch, /recording_start_pending/);
  assert.match(patch, /\.swap\(true, Ordering::AcqRel\)/);
  assert.match(patch, /Recording start already pending for session/);
  assert.match(patch, /Recording already active for session/);
  assert.match(patch, /fn reset_reservation/);
  assert.match(
    patch,
    /recording_finalization_started\.store\(false, Ordering::Release\)/
  );
  assert.match(patch, /test_recording_pending_start_rejects_duplicate/);
});

test('recording lifecycle reservation is reproducible and recorded in the fork manifest', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  assert.match(
    build,
    /rustpbx-ivekit-session-media-profile\.patch"[\s\S]*rustpbx-ivekit-recording-lifecycle-reservation\.patch"/
  );
  assert.match(build, /cargo test --locked --lib test_recording_double_start_fails/);
  assert.match(
    build,
    /cargo test --locked --lib test_recording_pending_start_rejects_duplicate/
  );
  assert.match(build, /PATCHSET="ivekit\.70"/);

  const manifest = JSON.parse(
    readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8')
  ) as {
    components: Array<{
      component_id: string;
      patches: Array<{ path: string; sha256: string }>;
      implemented_changes: Array<{ change_id: string }>;
    }>;
  };
  const rustpbx = manifest.components.find(
    (component) => component.component_id === 'rustpbx'
  );
  assert.ok(rustpbx);
  const entry = rustpbx.patches.find((candidate) => candidate.path === PATCH_PATH);
  assert.ok(entry);
  assert.equal(
    entry.sha256,
    createHash('sha256').update(readFileSync(PATCH_PATH)).digest('hex')
  );
  assert.equal(
    rustpbx.implemented_changes.some(
      (change) => change.change_id === 'rustpbx-recording-lifecycle-reservation-v1'
    ),
    true
  );
});
