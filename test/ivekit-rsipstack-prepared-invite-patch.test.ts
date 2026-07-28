import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH_PATH =
  'infra/ivekit/rustpbx/patches/rsipstack-ivekit-prepared-invite.patch';

function patch(): string {
  return readFileSync(PATCH_PATH, 'utf8');
}

function addedLines(): string {
  return patch()
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('rsipstack prepares an effective offer after assigning the real dialog tag', () => {
  assert.equal(existsSync(PATCH_PATH), true, `${PATCH_PATH} is required`);
  const added = addedLines();

  assert.match(added, /pub struct PreparedClientInvite/);
  assert.match(added, /pub fn prepare_invite/);
  assert.match(added, /pub fn dialog_id/);
  assert.match(added, /pub fn logical_offer/);
  assert.match(added, /replace_uncommitted_invite_offer/);
  assert.match(added, /tx\.original\.body = effective_offer/);
  assert.match(added, /dialog\.inner\.initial_request\.lock\(\)/);
  assert.match(added, /prepared_invite_exposes_real_local_tag_before_send/);
  assert.match(added, /prepared_invite_sends_only_the_effective_offer/);
});

test('the exact rsipstack prepared-invite patch is applied and recorded', () => {
  const build = readFileSync('infra/ivekit/rustpbx/build.sh', 'utf8');
  assert.match(
    build,
    /rsipstack-ivekit-dialog-recovery\.patch"[\s\S]*rsipstack-ivekit-prepared-invite\.patch"/
  );

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
      (change) => change.change_id === 'rsipstack-prepared-invite-v1'
    ),
    true
  );
});
