import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-http-client-capacity.patch';
const patch = readFileSync(PATCH_PATH, 'utf8');
const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
const lock = readFileSync('infra/converact/rustpbx/Cargo.lock', 'utf8');

test('RustPBX uses async DNS and a connection pool sized for concurrent routing and CDR work', () => {
  assert.match(patch, /"hickory-dns"/);
  assert.match(patch, /DEFAULT_HTTP_POOL_MAX_IDLE_PER_HOST: usize = 64/);
  assert.match(patch, /crate::http_util::build_keepalive_client/);
  assert.doesNotMatch(patch, /^\+.*pool_max_idle_per_host\(8\)/m);

  const reqwestPackage = lock.match(
    /\[\[package\]\]\nname = "reqwest"\nversion = "0\.13\.4"[\s\S]*?(?=\n\[\[package\]\])/
  )?.[0] || '';
  assert.match(reqwestPackage, /"hickory-resolver"/);
});

test('RustPBX reproducible build applies the HTTP capacity patch after the audio tap', () => {
  assert.match(
    build,
    /rustpbx-ivekit-realtime-audio-tap\.patch"[\s\S]*apply --check "\$PATCH_DIR\/rustpbx-ivekit-http-client-capacity\.patch"[\s\S]*apply "\$PATCH_DIR\/rustpbx-ivekit-http-client-capacity\.patch"/
  );
  assert.match(build, /PATCHSET="ivekit\.83"/);
});
