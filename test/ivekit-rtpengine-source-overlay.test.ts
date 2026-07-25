import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
      'rtpengine-ivekit-low-cardinality-metrics-v1'
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
  assert.match(patch, /ivekit stale owner epoch/);
  assert.match(patch, /ivekit command sequence gap/);
});
