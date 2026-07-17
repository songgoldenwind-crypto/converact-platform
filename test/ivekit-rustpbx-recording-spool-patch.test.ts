import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const patchPath =
  'infra/ivekit/rustpbx/patches/rustpbx-ivekit-recording-spool.patch';

test('RustPBX recording spool patch segments locally without object storage in the media path', () => {
  const patch = readFileSync(patchPath, 'utf8');
  const build = readFileSync('infra/ivekit/rustpbx/build.sh', 'utf8');

  assert.match(build, /rustpbx-ivekit-recording-spool\.patch/);
  assert.match(patch, /IVEKIT_RUSTPBX_RECORDING_SPOOL_ENABLED/);
  assert.match(patch, /IVEKIT_RUSTPBX_RECORDING_SEGMENT_SECONDS/);
  assert.match(patch, /IVEKIT_RUSTPBX_RECORDING_SEGMENT_MAX_BYTES/);
  assert.match(patch, /\.wav\.partial/);
  assert.match(patch, /sync_all/);
  assert.match(patch, /std::fs::rename/);
  assert.match(patch, /segments\.ndjson/);
  assert.match(patch, /encoded_payload_sha256/);
  assert.match(patch, /checksum_scope: "encoded_payload"/);
  assert.match(patch, /owner_contract/);
  assert.match(patch, /record_control_event\("paused"\)/);
  assert.match(patch, /record_control_event\("resumed"\)/);
  assert.match(patch, /record_sample_dropped/);
  assert.match(patch, /recorder_drop_counter/);
  assert.match(patch, /fetch_add\(1, Ordering::Relaxed\)/);
  assert.match(patch, /recording-completed\.json/);
  assert.match(patch, /last_segment_sequence/);
  assert.match(patch, /discard_empty_current/);
  assert.match(patch, /recording segment cannot be closed without encoded media/);
  assert.match(patch, /spool\.finalize\(\)\?/);
  assert.match(patch, /ivekitSpool/);
  assert.doesNotMatch(patch, /reqwest|Postgres|NATS|S3Object|PutObject|upload_http/i);
});

test('RustPBX recording spool patch is syntactically valid and hash-bound', () => {
  const parsed = spawnSync(
    'git',
    ['apply', '--numstat', patchPath],
    { encoding: 'utf8' }
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(parsed.stdout, /src\/ivekit_recording\.rs/);
  assert.match(parsed.stdout, /src\/media\/recorder\.rs/);
  assert.match(parsed.stdout, /src\/callrecord\/recording_upload\.rs/);

  const manifest = JSON.parse(
    readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8')
  ) as {
    components: Array<{
      component_id: string;
      patches: Array<{ path: string; sha256: string }>;
      planned_changes: Array<{ change_id: string }>;
      implemented_changes: Array<{ change_id: string }>;
    }>;
  };
  const rustpbx = manifest.components.find(
    (component) => component.component_id === 'rustpbx'
  );
  assert.ok(rustpbx);
  const patch = rustpbx.patches.find((item) => item.path === patchPath);
  assert.ok(patch);
  assert.equal(
    patch.sha256,
    createHash('sha256').update(readFileSync(patchPath)).digest('hex')
  );
  assert.equal(
    rustpbx.implemented_changes.some(
      (change) => change.change_id === 'rustpbx-encoded-recording-fork-v1'
    ),
    true
  );
});
