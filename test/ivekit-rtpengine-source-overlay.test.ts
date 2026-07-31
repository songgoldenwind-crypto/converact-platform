import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const RTPENGINE_COMMIT =
  '506cfa74386a5373e40fca139a932917f22f0524';
const RTPENGINE_ARCHIVE_SHA256 =
  'a6d23de8f656c3ad54e4060813c230861d100b79fb45ba1ce728ad2cef780143';
const overlayModule = pathToFileURL(
  join(process.cwd(), 'infra/ivekit/rtpengine/apply-overlay.mjs')
).href;

test('RTPengine source lock freezes archive, commit and patch order', () => {
  const lock = JSON.parse(readFileSync(
    'infra/ivekit/rtpengine/source-lock.json',
    'utf8'
  )) as Record<string, any>;
  assert.equal(lock.schema_version, '1.0.0');
  assert.equal(lock.component_id, 'rtpengine');
  assert.equal(lock.upstream.version, 'mr26.0.1.13');
  assert.equal(lock.upstream.release_ref, 'mr26.0.1.13');
  assert.equal(lock.upstream.commit, RTPENGINE_COMMIT);
  assert.equal(lock.upstream.archive_sha256, RTPENGINE_ARCHIVE_SHA256);
  assert.equal(lock.upstream.archive_size_bytes, 6_987_926);
  assert.equal(lock.upstream.license, 'GPL-3.0-only');
  assert.deepEqual(
    lock.patch_set.patches.map((patch: Record<string, string>) => patch.id),
    [
      'rtpengine-tcp-ng-bounded-frame-v1',
      'rtpengine-ivekit-owner-fence-v1',
      'rtpengine-ivekit-drain-capacity-v1',
      'rtpengine-ivekit-low-cardinality-metrics-v1',
      'rtpengine-ivekit-durable-replay-v1'
    ]
  );
});

test('RTPengine fetch refuses an archive with the wrong identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-rtpengine-fetch-'));
  const archive = join(root, 'wrong.tar.gz');
  const output = join(root, 'source');
  writeFileSync(archive, 'not-the-locked-archive');
  mkdirSync(output);

  const result = spawnSync(
    'bash',
    ['infra/ivekit/rtpengine/fetch-source.sh', output],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        IVEKIT_RTPENGINE_ARCHIVE_FILE: archive
      }
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archive (size|SHA-256) mismatch/);
});

test('pinned patch application is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-rtpengine-overlay-'));
  const source = join(root, 'source');
  const patch = join(root, 'change.patch');
  mkdirSync(source);
  execFileSync('git', ['init', '-q', source]);
  writeFileSync(join(source, 'sample.txt'), 'upstream\n');
  execFileSync('git', ['-C', source, 'add', 'sample.txt']);
  execFileSync(
    'git',
    [
      '-C',
      source,
      '-c',
      'user.name=ivekit-test',
      '-c',
      'user.email=ivekit-test@localhost',
      'commit',
      '-qm',
      'fixture'
    ]
  );
  writeFileSync(
    patch,
    [
      'diff --git a/sample.txt b/sample.txt',
      'index 7c0a16f..1f23818 100644',
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1 +1 @@',
      '-upstream',
      '+ivekit',
      ''
    ].join('\n')
  );
  const module = await import(`${overlayModule}?test=${Date.now()}`);

  assert.equal(module.applyPinnedPatch(source, patch), 'applied');
  assert.equal(module.applyPinnedPatch(source, patch), 'already_applied');
  assert.equal(readFileSync(join(source, 'sample.txt'), 'utf8'), 'ivekit\n');
});

test('pinned patch-set identity survives overlapping patch context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-rtpengine-patch-set-'));
  const source = join(root, 'source');
  const patchOne = join(root, 'one.patch');
  const patchTwo = join(root, 'two.patch');
  const identityPath = join(source, 'patch-set.json');
  mkdirSync(source);
  execFileSync('git', ['init', '-q', source]);
  writeFileSync(join(source, 'sample.txt'), 'alpha\nbeta\ngamma\n');
  execFileSync('git', ['-C', source, 'add', 'sample.txt']);
  execFileSync(
    'git',
    [
      '-C',
      source,
      '-c',
      'user.name=ivekit-test',
      '-c',
      'user.email=ivekit-test@localhost',
      'commit',
      '-qm',
      'fixture'
    ]
  );
  writeFileSync(
    patchOne,
    [
      'diff --git a/sample.txt b/sample.txt',
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1,3 +1,3 @@',
      '-alpha',
      '+ALPHA',
      ' beta',
      ' gamma',
      ''
    ].join('\n')
  );
  writeFileSync(
    patchTwo,
    [
      'diff --git a/sample.txt b/sample.txt',
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1,3 +1,3 @@',
      ' ALPHA',
      '-beta',
      '+BETA',
      ' gamma',
      ''
    ].join('\n')
  );
  const module = await import(`${overlayModule}?patch-set=${Date.now()}`);
  const patches = [
    { id: 'one', path: patchOne },
    { id: 'two', path: patchTwo }
  ];
  const identity = {
    schema_version: '1.0.0',
    component_id: 'rtpengine-test',
    source_commit: 'fixture',
    patch_set_id: 'fixture.1',
    patch_set_sha256: 'a'.repeat(64),
    patches: patches.map(({ id, path }) => ({ id, path }))
  };

  const first = module.applyPinnedPatchSet(
    source,
    patches,
    identityPath,
    identity
  );
  assert.deepEqual(
    first.patch_results.map((entry: { status: string }) => entry.status),
    ['applied', 'applied']
  );
  const second = module.applyPinnedPatchSet(
    source,
    patches,
    identityPath,
    identity
  );
  assert.deepEqual(
    second.patch_results.map((entry: { status: string }) => entry.status),
    ['already_applied', 'already_applied']
  );
  writeFileSync(join(source, 'sample.txt'), 'ALPHA\nchanged\ngamma\n');
  assert.throws(
    () => module.applyPinnedPatchSet(
      source,
      patches,
      identityPath,
      identity
    ),
    /patched source tree SHA-256 mismatch/
  );
  writeFileSync(join(source, 'sample.txt'), 'ALPHA\nBETA\ngamma\n');
  chmodSync(join(source, 'sample.txt'), 0o755);
  assert.throws(
    () => module.applyPinnedPatchSet(
      source,
      patches,
      identityPath,
      identity
    ),
    /patched source tree SHA-256 mismatch/
  );
});

test('patch-set identity refuses symlink writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-rtpengine-symlink-'));
  const source = join(root, 'source');
  const patch = join(root, 'change.patch');
  const identityPath = join(source, 'patch-set.json');
  const outsidePath = join(root, 'outside.json');
  mkdirSync(source);
  execFileSync('git', ['init', '-q', source]);
  writeFileSync(join(source, 'sample.txt'), 'upstream\n');
  execFileSync('git', ['-C', source, 'add', 'sample.txt']);
  execFileSync(
    'git',
    [
      '-C',
      source,
      '-c',
      'user.name=ivekit-test',
      '-c',
      'user.email=ivekit-test@localhost',
      'commit',
      '-qm',
      'fixture'
    ]
  );
  writeFileSync(
    patch,
    [
      'diff --git a/sample.txt b/sample.txt',
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1 +1 @@',
      '-upstream',
      '+ivekit',
      ''
    ].join('\n')
  );
  symlinkSync(outsidePath, identityPath);
  const module = await import(`${overlayModule}?symlink=${Date.now()}`);
  const patches = [{ id: 'one', path: patch }];
  const identity = {
    schema_version: '1.0.0',
    component_id: 'rtpengine-test',
    source_commit: 'fixture',
    patch_set_id: 'fixture.1',
    patch_set_sha256: 'a'.repeat(64),
    patches: patches.map(({ id, path }) => ({ id, path }))
  };

  assert.throws(
    () => module.applyPinnedPatchSet(
      source,
      patches,
      identityPath,
      identity
    ),
    /identity must be a regular file/
  );
  assert.equal(existsSync(outsidePath), false);
});

test('source identity assertion rejects an unpinned tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-rtpengine-identity-'));
  writeFileSync(
    join(root, 'ivekit-source-identity.json'),
    JSON.stringify({
      component_id: 'rtpengine',
      version: 'mr26.0.1.13',
      release_ref: 'mr26.0.1.13',
      commit: '0000000000000000000000000000000000000000',
      archive_sha256: RTPENGINE_ARCHIVE_SHA256,
      archive_size_bytes: 6_987_926
    })
  );
  const module = await import(`${overlayModule}?identity=${Date.now()}`);

  assert.throws(
    () => module.assertPinnedSource(root),
    /source commit mismatch/
  );
});

test('TCP NG patch bounds fragmented SDP frames without the upstream 1 KiB cutoff', () => {
  const patch = readFileSync(
    'infra/ivekit/rtpengine/patches/0001-tcp-ng-bounded-frame.patch',
    'utf8'
  );
  assert.match(patch, /IVEKIT_RTPENGINE_NG_MAX_FRAME_BYTES/);
  assert.match(patch, /262144/);
  assert.match(patch, /ivekit_ng_max_frame_bytes/);
  assert.match(patch, /streambuf_bufsize/);
  assert.doesNotMatch(patch, /^\+.*> 1024/m);
});

test('owner fence patch rejects stale mutations before RTPengine dispatch', () => {
  const patch = readFileSync(
    'infra/ivekit/rtpengine/patches/0002-ivekit-owner-fence.patch',
    'utf8'
  );
  for (const key of [
    'ivekit-owner-epoch',
    'ivekit-command-sequence',
    'ivekit-command-id',
    'ivekit-command-hash',
    'ivekit-reservation-id'
  ]) {
    assert.match(patch, new RegExp(key));
  }
  assert.match(patch, /uint64_t owner_epoch/);
  assert.match(patch, /uint32_t command_sequence/);
  assert.match(patch, /ivekit_guard_begin/);
  assert.match(patch, /ivekit_guard_finish/);
  assert.match(patch, /owner_epoch_text/);
  assert.doesNotMatch(patch, /char owner_epoch\[21\]/);
  assert.match(patch, /ivekit stale owner epoch/);
  assert.match(patch, /ivekit command sequence gap/);
  assert.match(patch, /ivekit command already applied/);
});

test('drain and capacity patch bounds new call admission without dropping active calls', () => {
  const patch = readFileSync(
    'infra/ivekit/rtpengine/patches/0003-ivekit-drain-capacity.patch',
    'utf8'
  );
  for (const setting of [
    'IVEKIT_RTPENGINE_MAX_ACTIVE_CALLS',
    'IVEKIT_RTPENGINE_GUARD_MAX_ENTRIES',
    'IVEKIT_RTPENGINE_TOMBSTONE_RETENTION_SECONDS'
  ]) {
    assert.match(patch, new RegExp(setting));
  }
  assert.match(patch, /ivekit drain/);
  assert.match(patch, /ivekit undrain/);
  assert.match(patch, /ivekit node draining/);
  assert.match(patch, /ivekit active call capacity/);
  assert.match(patch, /ivekit guard state capacity/);
  assert.match(patch, /expires_at_us/);
  assert.match(patch, /admission_reserved/);
  assert.match(patch, /accepted/);
  assert.match(patch, /replayed/);
  assert.match(patch, /stale_epoch/);
  assert.match(patch, /sequence_gap/);
  assert.match(patch, /draining_rejections/);
  assert.match(patch, /capacity_rejections/);
  assert.doesNotMatch(patch, /postgres|database query|redis command/i);
});

test('metrics patch exports a fixed low-cardinality iveKit metric set', () => {
  const patch = readFileSync(
    'infra/ivekit/rtpengine/patches/0004-ivekit-metrics.patch',
    'utf8'
  );

  assert.match(patch, /IVEKIT_RTPENGINE_RUNTIME_MODE/);
  assert.match(patch, /ivekit_guard_metrics_snapshot/);
  assert.match(patch, /statistics_gather_metrics/);
  for (const metric of [
    'ivekit_guard_events_total',
    'ivekit_active_calls',
    'ivekit_active_call_limit',
    'ivekit_guard_entries',
    'ivekit_guard_entry_limit',
    'ivekit_draining',
    'ivekit_owner_guard_enabled',
    'ivekit_runtime_info',
    'ivekit_userspace_fallback'
  ]) {
    assert.match(patch, new RegExp(metric));
  }
  for (const label of ['command', 'result', 'runtime_mode']) {
    assert.match(patch, new RegExp(`${label}=\\\\?"`));
  }
  for (const forbiddenLabel of [
    'tenant',
    'call',
    'reservation',
    'command_id',
    'sdp',
    'ip',
    'port',
    'phone'
  ]) {
    assert.doesNotMatch(
      patch,
      new RegExp(`PROMLAB\\([^\\n]*${forbiddenLabel}`, 'i')
    );
  }
  assert.doesNotMatch(patch, /postgres|database query|redis command/i);
});

test('durable replay patch owns replay SDP and preserves recovery queries', () => {
  const patch = readFileSync(
    'infra/ivekit/rtpengine/patches/0005-ivekit-durable-replay.patch',
    'utf8'
  );

  assert.match(patch, /ivekit_guard_capture_response/);
  assert.match(patch, /if \(str_eq\(command, "query"\)\)/);
  assert.match(patch, /if \(!command_id\.s\)/);
  assert.match(
    patch,
    /ticket->replay_sdp = g_memdup2\(\s*\+?\s*entry->effective_sdp/
  );
  assert.match(patch, /dict_add_str_dup\(ctx->resp, "sdp", &replay_sdp\)/);
  assert.match(patch, /g_clear_pointer\(&ticket->replay_sdp, g_free\)/);
  assert.match(patch, /IVEKIT_RTPENGINE_REPLAY_SDP_MAX_BYTES/);
  assert.match(patch, /ivekit_guard_replay_sdp_bytes/);
  assert.match(patch, /ivekit replay ack/);
  assert.match(patch, /ivekit command status/);
  assert.match(patch, /ivekit-command-status/);
  assert.match(patch, /ivekit-command-result/);
  assert.match(patch, /invalid_effective_sdp/);
  assert.match(patch, /ivekit-guard-entry-found/);
  assert.match(patch, /ivekit-ack-command-id/);
  assert.match(patch, /ivekit_replay_sdp_bytes/);
  assert.match(patch, /ivekit_replay_sdp_byte_limit/);
  assert.match(
    patch,
    /if \(ticket->replay_sdp_reserved == 0\)\s*\n\+\s*return;/
  );
  assert.doesNotMatch(
    patch,
    /^\+\s*parser->dict_add_str\(ctx->resp, "sdp", &replay_sdp\)/m
  );
  assert.doesNotMatch(patch, /strlen\(ticket->replay_sdp\)/);
  assert.match(patch, /g_utf8_validate/);
  assert.match(patch, /ticket->replay_sdp_bytes/);
});

test('owner guard overlay test exercises bounded identities and uint64 epochs', () => {
  const source = readFileSync(
    'infra/ivekit/rtpengine/overlay-tests/ivekit_owner_guard_test.c',
    'utf8'
  );
  assert.match(source, /18446744073709551615/);
  assert.match(source, /18446744073709551616/);
  assert.match(source, /IVEKIT_GUARD_COMMAND_HASH_MAX/);
  assert.match(source, /ivekit_guard_identifier/);
  assert.match(source, /ivekit_guard_epoch/);
  assert.match(source, /assert/);
});

test('replay protocol preserves SDP across stable and cross-cookie replays', () => {
  const source = readFileSync(
    'infra/ivekit/rtpengine/overlay-tests/ivekit_replay_protocol_test.py',
    'utf8'
  );
  assert.match(source, /stable-cookie replay did not return cached response/);
  assert.match(source, /cross-cookie replay was not rejected/);
  assert.match(source, /cross-cookie replay marker missing/);
  assert.match(source, /cross-cookie replay SDP missing/);
  assert.match(source, /exact applied command status missing/);
  assert.match(source, /next command status was not unseen/);
  assert.match(source, /conflicting command status was not fenced/);
  assert.match(source, /raw recovery query was fenced/);
  assert.match(source, /guarded query did not advance sequence/);
  assert.match(source, /post-query media mutation hit a sequence gap/);
  assert.match(source, /accepted != 1 or replayed != 1/);
  assert.match(source, /fenced_replay_with_sdp/);
});
