import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-processing-ivr-execution.patch';

test('RustPBX executes the existing IVR through owner-fenced processing media', () => {
  assert.equal(existsSync(PATCH_PATH), true, `${PATCH_PATH} is required`);
  const patch = readFileSync(PATCH_PATH, 'utf8');
  const parsed = spawnSync('git', ['apply', '--numstat', PATCH_PATH], {
    encoding: 'utf8'
  });

  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(patch, /CommitSingleLeg/);
  assert.match(patch, /prepare_processing_app_answer/);
  assert.match(patch, /processing_ivr_application/);
  assert.match(patch, /processing_single_leg_payload_invalid/);
  assert.match(patch, /play_processing_prompt/);
  assert.match(patch, /start_processing_gather/);
  assert.match(
    patch,
    /processing_app_answer_commits_single_leg_without_remote_sdp/
  );
  assert.match(
    patch,
    /processing_single_leg_is_reserved_for_the_existing_ivr_application/
  );
});

test('processing IVR execution patch is ordered, reproducible, and release-bound', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  assert.match(
    build,
    /rustpbx-ivekit-processing-terminal-events\.patch"[\s\S]*rustpbx-ivekit-processing-ivr-execution\.patch"/
  );
  assert.match(build, /PATCHSET="ivekit\.79"/);

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
      (change) => change.change_id === 'rustpbx-processing-ivr-execution-v1'
    ),
    true
  );

  const delivery = readFileSync('scripts/converact-delivery-bundle.ts', 'utf8');
  assert.match(delivery, /rustpbx-ivekit-processing-ivr-execution\.patch/);
});
