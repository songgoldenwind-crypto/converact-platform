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
      '207\t5\tsrc/ivekit_dialog_shadow.rs\n'
  );
  assert.equal(
    createHash('sha256').update(patch).digest('hex'),
    'd45c3578a4fc61357131418733c250ee9aa65013852a33aeb2e99b58d61f11fa'
  );

  assert.match(patch, /pub struct NativeCallRecoveryBinding/);
  assert.match(patch, /converact\.native-call-recovery-binding/);
  assert.match(patch, /pub fn recover_from_binding/);
  assert.match(patch, /owner_epoch <= previous_owner_epoch/);
  assert.match(patch, /checked_add\(1\)/);
  assert.match(patch, /ensure_owner_with_identity/);
  assert.match(patch, /resume_capsule_v1_cannot_grant_native_call_authority/);
  assert.match(
    patch,
    /native_call_recovery_binding_hash_matches_typescript_golden_vector/
  );
  assert.doesNotMatch(patch, /tokio::spawn|unbounded_channel|std::thread::spawn/);
});

test('ivekit.65 exact-source build applies and formats the recovery slice last', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  assert.match(build, /PATCHSET="ivekit\.65"/);
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
  assert.match(source, /schema_version: 1 \| 2/);
  assert.match(source, /result\.provider_call_id !== expectedProviderCallId/);
});
