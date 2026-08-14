import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-trusted-recovery-proof.patch';
const PREDECESSOR =
  'infra/converact/rustpbx/patches/rustpbx-converact-recovered-call-admission.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';
const TAKEOVER = 'src/agent-runtime/converact/voice/dialog-owner-takeover.ts';
const PATCH_SHA256 =
  'b5bcf6a9f45dcd58f4d7dbafd9f97bcbe2df8c92f89c1c2708f48407f614eea8';

function additions(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('ivekit.80 applies trusted recovery proof after closed recovered admission', () => {
  const patch = readFileSync(PATCH, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), PATCH_SHA256);
  const parsed = spawnSync('git', ['apply', '--numstat', PATCH], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout, '19\t12\tsrc/ivekit_dialog_shadow.rs\n');

  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /PATCHSET="ivekit\.81"/u);
  assert.match(
    build,
    /rustpbx-converact-recovered-call-admission\.patch"[\s\S]*rustpbx-converact-trusted-recovery-proof\.patch"/u
  );
  assert.equal(readFileSync(PREDECESSOR, 'utf8').length > 0, true);
});

test('only the exact decrypted predecessor can mint a recovered owner proof', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /fn recovered_native_call_authority/u);
  assert.match(
    source,
    /Result<\(NativeCallRecoveryBinding, NativeCallIdentity\), DialogShadowError>/u
  );
  assert.match(source, /Ok\(\(binding\.clone\(\), successor\)\)/u);
  assert.equal(
    source.match(/ensure_recovered_owner_with_identity/g)?.length,
    2,
    'resume and finalize must both retain the recovered proof'
  );
  assert.match(source, /predecessor_native_call_binding/u);
  assert.doesNotMatch(source, /LegacyUnspecified|fallback_to_memory|unbounded_channel/u);
});

test('the takeover compatibility coordinator rejects legacy or split bindings before claim', () => {
  const source = readFileSync(TAKEOVER, 'utf8');
  assert.match(source, /payload\.schema_version !== 2/u);
  assert.match(source, /!payload\.native_call_binding/u);
  assert.match(source, /nativeCallRecoveryBindingSha256\(payload\.native_call_binding\)/u);
  assert.match(source, /nativeCallRecoveryBindingSha256\(predecessor\)/u);
});

test('trusted proof production remains functional-only', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.doesNotMatch(
    source,
    /criterion|calls_per_second|throughput_benchmark|production_eligible/u
  );
});
