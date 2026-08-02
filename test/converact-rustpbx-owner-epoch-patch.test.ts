import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const patchPath =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-owner-epoch.patch';

test('RustPBX owner epoch patch wires local component authorization outside RTP paths', () => {
  const patch = readFileSync(patchPath, 'utf8');
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');

  assert.match(build, /rustpbx-ivekit-owner-epoch\.patch/);
  assert.match(build, /integrations\/component-hook-rs/);
  assert.match(
    patch,
    /converact-component-hook = \{ path = "vendor\/converact-component-hook" \}/
  );
  assert.match(patch, /use converact_component_hook::/);
  assert.doesNotMatch(
    patch,
    /ivekit-component-hook = \{ path = "vendor\/ivekit-component-hook" \}/
  );
  assert.match(patch, /pub mod ivekit_owner/);
  assert.match(patch, /reservation_id/);
  assert.match(patch, /owner_epoch/);
  assert.match(patch, /IVEKIT_RUSTPBX_COMPONENT_NODE_URL/);
  assert.match(patch, /IVEKIT_RUSTPBX_COMPONENT_NODE_TOKEN/);
  assert.match(patch, /open_authorized/);
  assert.match(patch, /refresh_authorized/);
  assert.match(patch, /assert_mutation/);
  assert.match(patch, /ivekit_owners/);
  assert.doesNotMatch(
    patch,
    /forwarding_track\.rs|rtc_track\.rs|media\/engine|RtpPacket/
  );
});

test('RustPBX owner epoch patch is syntactically valid and hash-bound in the fork manifest', () => {
  const patchBytes = readFileSync(patchPath, 'utf8');
  const parsed = spawnSync(
    'git',
    ['apply', '--numstat', patchPath],
    { encoding: 'utf8' }
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(parsed.stdout, /Cargo\.toml/);
  assert.match(parsed.stdout, /src\/ivekit_owner\.rs/);
  assert.match(parsed.stdout, /src\/proxy\/routing\/http\.rs/);
  assert.match(parsed.stdout, /src\/rwi\/handler\.rs/);

  const ownerSection = patchBytes
    .split('diff --git a/src/ivekit_owner.rs b/src/ivekit_owner.rs\n')[1]!
    .split('\ndiff --git ')[0]!;
  const abbreviatedBlob = /^index 0000000\.\.([a-f0-9]+)$/m.exec(ownerSection)?.[1];
  assert.ok(abbreviatedBlob);
  const ownerSource = `${ownerSection
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')}\n`;
  const ownerBlob = spawnSync('git', ['hash-object', '--stdin'], {
    encoding: 'utf8',
    input: ownerSource
  });
  assert.equal(ownerBlob.status, 0, ownerBlob.stderr);
  assert.equal(ownerBlob.stdout.trim().slice(0, abbreviatedBlob.length), abbreviatedBlob);

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
    createHash('sha256').update(patchBytes).digest('hex')
  );
  assert.equal(
    rustpbx.implemented_changes.some(
      (change) => change.change_id === 'rustpbx-owner-epoch-runtime-v2'
    ),
    true
  );
  assert.equal(
    rustpbx.planned_changes.some(
      (change) => change.change_id === 'rustpbx-owner-epoch-runtime-v2'
    ),
    false
  );
});
