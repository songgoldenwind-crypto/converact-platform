import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rsipstack-ivekit-single-trying.patch';

test('rsipstack gives application-initiated 100 Trying one transaction owner', () => {
  const patch = readFileSync(PATCH, 'utf8');
  const effective = patch
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .map((line) => line.startsWith('+') && !line.startsWith('+++')
      ? line.slice(1)
      : line)
    .join('\n');

  assert.match(effective, /initial_trying_sent: bool/);
  assert.match(
    effective,
    /if self\.initial_trying_sent \{\s+return Ok\(\(\)\);\s+\}/
  );
  assert.match(
    effective,
    /self\.respond\(response\)\.await\?;\s+self\.initial_trying_sent = true;/
  );
  assert.match(
    effective,
    /Protocol retransmissions still use respond\(last_response\) independently/
  );
  assert.match(
    effective,
    /repeated_send_trying_emits_one_initial_response/
  );
  assert.match(
    effective,
    /failed_send_trying_can_retry_on_replacement_connection/
  );
  assert.match(
    effective,
    /assert!\(transaction\.send_trying\(\)\.await\.is_err\(\)\)[\s\S]*transaction\.connection = Some\(retry_connection\.into\(\)\)[\s\S]*replacement connection sends 100 Trying/
  );
  assert.match(
    effective,
    /the second application owner must not emit another 100 Trying/
  );
  assert.doesNotMatch(patch, /^\+.*(?:Atomic|Mutex|RwLock)/m);
});

test('the current patchset retains single-Trying ownership after the existing rsipstack queue', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  const readme = readFileSync('infra/converact/rustpbx/README.md', 'utf8');

  assert.match(
    build,
    /rsipstack-ivekit-rejection-headers\.patch"[\s\S]*apply --check "\$PATCH_DIR\/rsipstack-ivekit-single-trying\.patch"[\s\S]*apply "\$PATCH_DIR\/rsipstack-ivekit-single-trying\.patch"[\s\S]*rustrtc-ivekit-udp-socket-capacity\.patch"/
  );
  assert.match(build, /PATCHSET="ivekit\.41"/);
  assert.match(
    build,
    /cargo test --manifest-path \/build\/rsipstack\/Cargo\.toml --offline failed_send_trying_can_retry_on_replacement_connection/
  );
  assert.match(
    readme,
    /CallModule::handle_invite[\s\S]*before routing and business admission/
  );
  assert.match(
    readme,
    /ServerInviteDialog[\s\S]*transaction-owned no-op/
  );
  assert.match(readme, /durable-admission Retry-After wire propagation remain `not_run`/);
  assert.match(readme, /Current Timer G\/H\/I evidence is recorded separately below/);
});

test('the current source manifest binds the single-Trying patch identity', () => {
  const manifest = JSON.parse(
    readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8')
  ) as {
    components: Array<{
      component_id: string;
      patches?: Array<{ path: string; sha256: string }>;
      implemented_changes?: Array<{ change_id: string }>;
    }>;
  };
  const rsipstack = manifest.components.find(
    (component) => component.component_id === 'rsipstack'
  );
  assert.ok(rsipstack);
  const registered = rsipstack.patches?.find(
    (patch) => patch.path === PATCH
  );
  assert.ok(registered);
  assert.equal(
    registered.sha256,
    createHash('sha256').update(readFileSync(PATCH)).digest('hex')
  );
  assert.equal(
    rsipstack.implemented_changes?.some(
      (change) => change.change_id === 'rsipstack-single-trying-v1'
    ),
    true
  );
});
