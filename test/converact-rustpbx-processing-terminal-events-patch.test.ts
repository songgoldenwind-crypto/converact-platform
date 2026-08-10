import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-processing-terminal-events.patch';

test('RustPBX consumes processing terminal events through an owner-fenced stream', () => {
  assert.equal(existsSync(PATCH_PATH), true, `${PATCH_PATH} is required`);
  const patch = readFileSync(PATCH_PATH, 'utf8');

  assert.match(patch, /MediaControlTerminalEventDecoder/);
  assert.match(patch, /consume_terminal_events/);
  assert.match(patch, /v1\/terminal-events/);
  assert.match(patch, /InjectFencedMediaEvent/);
  assert.match(patch, /accepts_terminal_event/);
  assert.match(patch, /media_reservation_id/);
  assert.match(patch, /terminal_media_events_project_to_application_completion_events/);
  assert.match(
    patch,
    /processing_terminal_events_require_current_owner_and_media_reservation/
  );
});

test('processing terminal event patch is ordered, reproducible, and manifest-bound', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  assert.match(
    build,
    /rustpbx-ivekit-recording-lifecycle-reservation\.patch"[\s\S]*rustpbx-ivekit-processing-terminal-events\.patch"/
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
      (change) => change.change_id === 'rustpbx-processing-terminal-events-v1'
    ),
    true
  );
});
