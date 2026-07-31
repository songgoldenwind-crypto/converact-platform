import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const patchPath =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-callrecord-capacity.patch';
const databasePolicyPatchPath =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-callrecord-database-policy.patch';
const runtimeIsolationPatchPath =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-callrecord-runtime-isolation.patch';
const failureTelemetryPatchPath =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-callrecord-failure-telemetry.patch';

test('RustPBX bounds and observes the asynchronous call-record queue', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  const patch = readFileSync(patchPath, 'utf8');

  assert.match(build, /rustpbx-ivekit-callrecord-capacity\.patch/);
  assert.match(patch, /call_record_channel_capacity/);
  assert.match(patch, /DEFAULT_CALL_RECORD_CHANNEL_CAPACITY/);
  assert.match(patch, /DEFAULT_CALL_RECORD_CHANNEL_CAPACITY: usize = 65_536/);
  assert.match(patch, /MAX_CALL_RECORD_CHANNEL_CAPACITY/);
  assert.match(patch, /with_channel_capacity/);
  assert.match(patch, /src\/proxy\/tests\/cdr_capture\.rs/);
  assert.match(patch, /tests\/helpers\/cdr_verifier\.rs/);
  assert.match(patch, /crate::config::DEFAULT_CALL_RECORD_CHANNEL_CAPACITY/);
  assert.match(patch, /rustpbx::config::DEFAULT_CALL_RECORD_CHANNEL_CAPACITY/);
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

test('RustPBX can omit the duplicate local CDR database hook behind an explicit policy', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  const patch = readFileSync(databasePolicyPatchPath, 'utf8');

  assert.match(
    build,
    /rustpbx-ivekit-callrecord-capacity\.patch"[\s\S]*rustpbx-ivekit-callrecord-database-policy\.patch"/
  );
  assert.match(patch, /persist_to_database/);
  assert.match(patch, /default_call_record_persist_to_database/);
  assert.match(patch, /persist_call_records_to_database/);
  assert.match(patch, /persist_to_database: true/);
  assert.match(patch, /callrecord_database_persistence_defaults_to_enabled/);
  assert.match(patch, /callrecord_database_persistence_can_be_disabled/);
});

test('RustPBX isolates call-record sinks from SIP transaction workers', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  const patch = readFileSync(runtimeIsolationPatchPath, 'utf8');

  assert.match(
    build,
    /rustpbx-ivekit-callrecord-database-policy\.patch"[\s\S]*rustpbx-ivekit-callrecord-runtime-isolation\.patch"/
  );
  assert.match(patch, /callrecord_worker_threads/);
  assert.match(patch, /CALL_RECORD_RUNTIME/);
  assert.match(patch, /set_callrecord_runtime/);
  assert.match(patch, /callrecord_spawn/);
  assert.match(patch, /thread_name\("callrecord-worker"\)/);
  assert.match(patch, /manager\.serve\(\)\.await/);
});

test('RustPBX counts sink failures without per-record warning amplification', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  const patch = readFileSync(failureTelemetryPatchPath, 'utf8');

  assert.match(
    build,
    /rustpbx-ivekit-callrecord-runtime-isolation\.patch"[\s\S]*rustpbx-ivekit-callrecord-failure-telemetry\.patch"/
  );
  assert.match(patch, /rustpbx_call_record_sink_failures_total/);
  assert.match(patch, /"stage" => stage/);
  assert.match(patch, /report_sink_failure\("save"/);
  assert.match(patch, /report_sink_failure\("hook"/);
  assert.match(patch, /try_claim_sink_warning/);
  assert.match(patch, /CALL_RECORD_SINK_WARNING_INTERVAL_SECS/);
  assert.match(patch, /sink_warning_claim_is_rate_limited/);
  assert.doesNotMatch(patch, /^\+\s+warn!\("Failed to save call record:/m);
  assert.doesNotMatch(patch, /^\+\s+warn!\("CallRecordHook failed:/m);
});
