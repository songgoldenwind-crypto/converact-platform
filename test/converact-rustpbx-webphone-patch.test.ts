import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH = 'infra/converact/rustpbx/patches/rustpbx-ivekit-webphone-registry.patch';

test('RustPBX WebPhone patch replaces the serialized linear pre-auth registry', () => {
  const patch = readFileSync(PATCH, 'utf8');

  assert.match(patch, /HashMap<SipAddr, PreAuthEntry>/);
  assert.match(patch, /RwLock<HashMap/);
  assert.match(patch, /struct PreAuthRegistration/);
  assert.match(patch, /impl Drop for PreAuthRegistration/);
  assert.match(patch, /Arc::downgrade/);
  assert.match(patch, /read_map\(\)[\s\S]*?\.get\(addr\)/);
  assert.match(patch, /register_guard_cleans_up_on_drop/);
  assert.match(patch, /ten_thousand_entries_have_constant_keyed_lookup/);
  assert.match(patch, /-\s*map: Mutex<Vec/);
  assert.doesNotMatch(patch, /^\+.*(?:SOFT_CAP|ENTRY_TTL|map\.iter\(\))/m);
});

test('RustPBX reproducible build applies the WebPhone registry patch', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  const readme = readFileSync('infra/converact/rustpbx/README.md', 'utf8');

  assert.match(build, /apply --check "\$PATCH_DIR\/rustpbx-ivekit-webphone-registry\.patch"/);
  assert.match(build, /apply "\$PATCH_DIR\/rustpbx-ivekit-webphone-registry\.patch"/);
  assert.match(build, /PATCHSET="ivekit\.48"/);
  assert.match(build, /0\.4\.11-\$\{PATCHSET\}-6c49ee76/);
  assert.match(readme, /WebPhone pre-authentication registry/);
  assert.match(readme, /O\(1\)/);
  assert.match(readme, /connection-lifetime guard/);
});
