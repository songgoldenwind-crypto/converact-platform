import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-native-call-identity.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';

function additions(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('RustPBX adopts projections into canonical native call identities', () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync('git', ['apply', '--numstat', PATCH], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const patch = readFileSync(PATCH, 'utf8');
  const addedSource = additions(patch);
  assert.match(patch, /src\/call\/domain\/foundation_identity\.rs/);
  assert.match(patch, /src\/ivekit_owner\.rs/);
  assert.match(patch, /src\/proxy\/routing\/http\.rs/);
  for (const type of [
    'CallId',
    'LegId',
    'ProtocolDialogId',
    'TransactionId',
    'MediaSessionId',
    'InteractionId',
    'ProviderCallId'
  ]) {
    assert.match(addedSource, new RegExp(`\\b${type}\\b`));
  }
  assert.match(addedSource, /NativeCallIdentity::adopt_projection/);
  assert.match(addedSource, /ensure_owner_with_identity/);
  assert.match(addedSource, /call_projection_id/);
  assert.match(addedSource, /placement_interaction_id/);
  assert.match(addedSource, /provider_call_id/);
  assert.match(addedSource, /call_generation/);
  assert.match(addedSource, /call_revision/);
  assert.match(addedSource, /length\.to_be_bytes\(\)/);
  assert.match(addedSource, /expected_provider_call_id/);
  assert.doesNotMatch(addedSource, /Mutex|RwLock|tokio::spawn\(/);
});

test('the exact build applies native identity after bounded call mailboxes', () => {
  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /PATCHSET="ivekit\.47"/);
  assert.match(
    build,
    /rustpbx-ivekit-bounded-call-mailboxes\.patch"[\s\S]*rustpbx-converact-native-call-identity\.patch"/
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-native-call-identity\.patch"/
  );
});
