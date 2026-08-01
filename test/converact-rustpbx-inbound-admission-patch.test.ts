import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const patchPath =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-inbound-admission.patch';
const responseContractPatchPath =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-inbound-admission-response-contract.patch';

test('RustPBX snapshot fork admits inbound calls before local route lookup', () => {
  const patch = readFileSync(patchPath, 'utf8');
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  const readme = readFileSync('infra/converact/rustpbx/README.md', 'utf8');

  assert.match(build, /rustpbx-ivekit-inbound-admission\.patch/);
  assert.match(patch, /IVEKIT_RUSTPBX_INBOUND_ADMISSION_URL/);
  assert.match(patch, /IVEKIT_RUSTPBX_INBOUND_ADMISSION_SERVICE_KEY/);
  assert.match(patch, /IVEKIT_RUSTPBX_CELL_ID/);
  assert.match(patch, /IVEKIT_RUSTPBX_OWNER_NODE_ID/);
  assert.match(patch, /\/inbound-admission/);
  assert.match(patch, /ivekit_cell_id/);
  assert.match(patch, /ivekit_owner_node_id/);
  assert.match(patch, /snapshot inbound admission rejected/);
  assert.ok(
    patch.indexOf('admit_snapshot_call') <
    patch.lastIndexOf('snapshot_result(&to)'),
    'snapshot routing must be preceded by Cell admission'
  );
  assert.match(readme, /inbound-admission/);
  assert.match(readme, /before the local route snapshot lookup/i);
});

test('RustPBX inbound admission patch is a syntactically valid git patch', () => {
  const parsed = spawnSync(
    'git',
    ['apply', '--numstat', patchPath],
    { encoding: 'utf8' }
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(parsed.stdout, /^151\t0\tsrc\/proxy\/routing\/http\.rs\s*$/);
});

test('RustPBX parses the direct Converact Fabric HTTP response after the complete patch queue', () => {
  const patch = readFileSync(responseContractPatchPath, 'utf8');
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');

  assert.match(
    build,
    /rustpbx-ivekit-media-tracing\.patch"[\s\S]*rustpbx-ivekit-inbound-admission-response-contract\.patch"/
  );
  assert.match(patch, /\.json::<HttpSnapshotAdmissionResponse>\(\)/);
  assert.match(patch, /-struct HttpSnapshotAdmissionEnvelope/);
  assert.doesNotMatch(patch, /^\+.*admitted\.data\./m);
  assert.match(patch, /^\+.*admitted\.accepted/m);
});

test('fork manifest records the implemented RustPBX Cell owner patch identity', () => {
  const manifest = JSON.parse(
    readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8')
  ) as {
    components: Array<{
      component_id: string;
      patches: Array<{ path: string; sha256: string }>;
      implemented_changes: Array<{ change_id: string }>;
      planned_changes: Array<{ change_id: string }>;
    }>;
  };
  const rustpbx = manifest.components.find(
    (component) => component.component_id === 'rustpbx'
  );
  assert.ok(rustpbx);
  const patch = rustpbx.patches.find((item) => item.path === patchPath);
  assert.ok(patch);
  assert.equal(
    patch.sha256,
    createHash('sha256').update(readFileSync(patchPath)).digest('hex')
  );
  assert.equal(
    rustpbx.implemented_changes.some(
      (change) => change.change_id === 'rustpbx-cell-owner-v1'
    ),
    true
  );
  assert.equal(
    rustpbx.planned_changes.some(
      (change) => change.change_id === 'rustpbx-cell-owner-v1'
    ),
    false
  );
  const responseContractPatch = rustpbx.patches.find(
    (item) => item.path === responseContractPatchPath
  );
  assert.ok(responseContractPatch);
  assert.equal(
    responseContractPatch.sha256,
    createHash('sha256')
      .update(readFileSync(responseContractPatchPath))
      .digest('hex')
  );
});
