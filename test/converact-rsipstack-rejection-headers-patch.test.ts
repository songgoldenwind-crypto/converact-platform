import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/converact/rustpbx/patches/rsipstack-ivekit-rejection-headers.patch';

test('rsipstack preserves overload Retry-After and Reason headers', () => {
  assert.equal(existsSync(PATCH_PATH), true, `${PATCH_PATH} is required`);
  const patch = readFileSync(PATCH_PATH, 'utf8');

  assert.match(patch, /pub fn reject_with_headers/);
  assert.match(patch, /Header::RetryAfter/);
  assert.match(patch, /Header::Reason/);
  assert.match(
    patch,
    /test_reject_with_headers_preserves_retry_after_and_reason/
  );
});

test('the rejection-header patch follows prepared INVITE and is recorded', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  assert.match(
    build,
    /rsipstack-ivekit-prepared-invite\.patch"[\s\S]*rsipstack-ivekit-rejection-headers\.patch"/
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
  const rsipstack = manifest.components.find(
    (component) => component.component_id === 'rsipstack'
  );
  assert.ok(rsipstack);
  const entry = rsipstack.patches.find((item) => item.path === PATCH_PATH);
  assert.ok(entry);
  assert.equal(
    entry.sha256,
    createHash('sha256').update(readFileSync(PATCH_PATH)).digest('hex')
  );
  assert.equal(
    rsipstack.implemented_changes.some(
      (change) => change.change_id === 'rsipstack-rejection-headers-v1'
    ),
    true
  );
});
