import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const patchPath =
  'infra/ivekit/rustpbx/patches/rustpbx-ivekit-callrecord-capacity.patch';

test('RustPBX bounds and observes the asynchronous call-record queue', () => {
  const build = readFileSync('infra/ivekit/rustpbx/build.sh', 'utf8');
  const patch = readFileSync(patchPath, 'utf8');

  assert.match(build, /rustpbx-ivekit-callrecord-capacity\.patch/);
  assert.match(patch, /call_record_channel_capacity/);
  assert.match(patch, /DEFAULT_CALL_RECORD_CHANNEL_CAPACITY/);
  assert.match(patch, /MAX_CALL_RECORD_CHANNEL_CAPACITY/);
  assert.match(patch, /with_channel_capacity/);
  assert.match(patch, /rustpbx_call_record_queue_dropped_total/);
  assert.match(patch, /reason" => "full"/);
  assert.match(patch, /reason" => "closed"/);
  assert.match(patch, /rustpbx_call_record_queue_available/);
  assert.match(patch, /rustpbx_call_record_queue_capacity/);
});

test('RustPBX removes per-call info and expected rejection warning logs', () => {
  const patch = readFileSync(patchPath, 'utf8');

  assert.ok((patch.match(/\n-\s+info!\(\n\+\s+debug!\(/g) || []).length >= 2);
  assert.match(
    patch,
    /-\s+warn!\(key = %tx\.key, "failed to build dialplan"\);\n\+\s+debug!/
  );
  assert.match(patch, /-\s+tracing::info!\(\n\+\s+tracing::debug!\(/);
});
