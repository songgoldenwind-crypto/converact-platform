import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-inbound-refer-wire.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';
const MANIFEST = 'docs/capacity/forks/ivekit-forks-v1.json';

function effective(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .map((line) =>
      line.startsWith('+') && !line.startsWith('+++') ? line.slice(1) : line
    )
    .join('\n');
}

function additions(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('inbound REFER emits one canonical Max-Forwards header', () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const patch = readFileSync(PATCH, 'utf8');
  const source = effective(patch);
  const addedSource = additions(patch);

  assert.equal(spawnSync('git', ['apply', '--numstat', PATCH]).status, 0);
  assert.match(source, /let headers = replaces_header\.map\(\|replaces\|/);
  assert.match(source, /"Replaces"\.into\(\)/);
  assert.match(source, /headers,/);
  assert.doesNotMatch(
    source,
    /Header::Other\([\s\S]{0,80}"Max-Forwards"/
  );
  assert.doesNotMatch(
    addedSource,
    /Vec::with_capacity|Mutex|RwLock|spawn\(/
  );
});

test('the exact build applies the REFER wire repair and runs the full library suite', () => {
  const build = readFileSync(BUILD, 'utf8');

  assert.match(build, /PATCHSET="ivekit\.82"/);
  assert.match(
    build,
    /rustpbx-ivekit-server-invite-owner\.patch"[\s\S]*rustpbx-ivekit-inbound-refer-wire\.patch"/
  );
  assert.match(build, /^\s*cargo test --locked --lib\s*$/m);
});

test('the fork manifest binds the REFER wire repair and focused native evidence', () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const patch = readFileSync(PATCH);
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    revision: number;
    components: Array<{
      component_id: string;
      build: { output_image: string };
      runtime_artifact: { reference: string };
      patches: Array<{ path: string; sha256: string }>;
      implemented_changes: Array<{ change_id: string }>;
      verification: { evidence_paths: string[] };
    }>;
  };
  const rustpbx = manifest.components.find(
    (component) => component.component_id === 'rustpbx'
  );

  assert.ok(rustpbx);
  assert.equal(manifest.revision, 64);
  assert.equal(
    rustpbx.build.output_image,
    'ivekit/rustpbx:0.4.11-ivekit.42-6c49ee76'
  );
  assert.equal(rustpbx.runtime_artifact.reference, rustpbx.build.output_image);
  assert.equal(
    rustpbx.patches.find((entry) => entry.path === PATCH)?.sha256,
    createHash('sha256').update(patch).digest('hex')
  );
  assert.ok(
    rustpbx.implemented_changes.some(
      (change) => change.change_id === 'rustpbx-inbound-refer-wire-v1'
    )
  );
  assert.ok(
    rustpbx.verification.evidence_paths.includes(
      'test/converact-rustpbx-inbound-refer-wire-patch.test.ts'
    )
  );
  assert.ok(
    rustpbx.verification.evidence_paths.includes(
      'src/proxy/tests/test_inbound_refer.rs'
    )
  );
});
