import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-native-call-recovery-identity.patch';

test('ivekit.65 carries one fenced Native Call identity through HA recovery', () => {
  const patch = readFileSync(PATCH, 'utf8');
  const parsed = spawnSync('git', ['apply', '--numstat', PATCH], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(
    parsed.stdout,
    '185\t0\tsrc/call/domain/foundation_identity.rs\n' +
      '235\t5\tsrc/ivekit_dialog_shadow.rs\n' +
      '18\t1\ttests/ivekit_dialog_shadow_contract_test.rs\n'
  );
  assert.equal(
    createHash('sha256').update(patch).digest('hex'),
    '41b9641ad9994ed14432fb0e7a691e69d76c564e84309b1442e96f082ed956ac'
  );

  assert.match(patch, /pub struct NativeCallRecoveryBinding/);
  assert.match(patch, /converact\.native-call-recovery-binding/);
  assert.match(patch, /pub fn recover_from_binding/);
  assert.match(patch, /owner_epoch <= previous_owner_epoch/);
  assert.match(patch, /checked_add\(1\)/);
  assert.match(patch, /ensure_owner_with_identity/);
  assert.match(patch, /resume_capsule_v1_cannot_grant_native_call_authority/);
  assert.match(patch, /deserialize_with = "deserialize_native_call_binding"/);
  assert.match(
    patch,
    /capsule_v1_rejects_an_explicit_null_native_call_binding/
  );
  assert.match(patch, /tests\/ivekit_dialog_shadow_contract_test\.rs/);
  assert.match(patch, /native_call_binding: Some\(native_call_binding\(\)\)/);
  assert.match(
    patch,
    /native_call_recovery_binding_hash_matches_typescript_golden_vector/
  );
  assert.doesNotMatch(patch, /tokio::spawn|unbounded_channel|std::thread::spawn/);
});

test('ivekit.65 exact-source build applies and formats the recovery slice last', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  assert.match(build, /PATCHSET="ivekit\.85"/);
  assert.match(
    build,
    /rustpbx-converact-uas-2xx-owner-retention\.patch"[\s\S]*rustpbx-converact-native-call-recovery-identity\.patch"/
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-native-call-recovery-identity\.patch/
  );
});

test('TypeScript freezes the same bounded Native Call recovery contract', () => {
  const source = readFileSync(
    'src/agent-runtime/converact/voice/dialog-recovery-capsule.ts',
    'utf8'
  );
  assert.match(source, /const MAX_PLAINTEXT_BYTES = 16 \* 1024/);
  assert.match(source, /nativeCallRecoveryBindingSha256/);
  assert.match(source, /typeof value !== 'string'/);
  assert.match(source, /schema_version: 1 \| 2/);
  assert.match(source, /result\.provider_call_id !== expectedProviderCallId/);
});
