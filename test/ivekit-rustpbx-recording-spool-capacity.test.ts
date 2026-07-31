import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RustPbxRecordingSpoolCapacityGate
} from '../src/agent-runtime/converact/recordings/rustpbx-recording-spool-capacity.js';

test('RustPBX recording spool gate admits below 90 percent and rejects projected exhaustion', async (t) => {
  const fixture = await metricsFixture(t, { capacity_bytes: 1_000, available_bytes: 150 });
  const gate = new RustPbxRecordingSpoolCapacityGate({
    metrics_file: fixture.path,
    stale_after_ms: 5_000
  });
  assert.equal(await gate.refresh(fixture.now), true);

  gate.assertReservation({ 'data.local_spool_bytes': 50 }, fixture.now);
  assert.throws(
    () => gate.assertReservation({ 'data.local_spool_bytes': 51 }, fixture.now),
    (error: any) => error?.code === 'component_recording_spool_exhausted'
      && error?.status === 503
      && error?.retryable === true
  );
  assert.doesNotThrow(() => gate.assertReservation({ 'voice.weighted_calls': 1 },
    new Date(fixture.now.getTime() + 10_000)));

  const metrics = gate.prometheusMetrics(fixture.now);
  assert.match(metrics, /ivekit_rustpbx_recording_spool_capacity_bytes 1000/);
  assert.match(metrics, /ivekit_rustpbx_recording_spool_used_bytes 850/);
  assert.match(metrics, /ivekit_rustpbx_recording_spool_non_core_deferred 1/);
  assert.match(metrics, /ivekit_rustpbx_recording_spool_terminal_segments 1/);
  assert.match(metrics, /ivekit_rustpbx_recording_spool_finalization_backlog 3/);
  assert.match(metrics, /ivekit_rustpbx_recording_spool_finalization_terminal 1/);
  assert.match(metrics, /ivekit_rustpbx_recording_spool_oldest_finalization_age_seconds 7/);
  assert.match(metrics, /ivekit_rustpbx_recording_spool_observation_fresh 1/);
});

test('RustPBX recording spool gate fails required recording closed on stale or invalid evidence', async (t) => {
  const fixture = await metricsFixture(t, { capacity_bytes: 1_000, available_bytes: 500 });
  const gate = new RustPbxRecordingSpoolCapacityGate({
    metrics_file: fixture.path,
    stale_after_ms: 5_000
  });
  assert.equal(await gate.refresh(fixture.now), true);
  assert.throws(
    () => gate.assertReservation(
      { 'data.local_spool_bytes': 1 },
      new Date(fixture.now.getTime() + 5_001)
    ),
    (error: any) => error?.code === 'component_recording_spool_observation_stale'
  );

  await writeFile(fixture.path, '{"schema_version":1,"used_bytes":-1}\n', { mode: 0o600 });
  assert.equal(await gate.refresh(new Date(fixture.now.getTime() + 6_000)), false);
  assert.match(gate.prometheusMetrics(new Date(fixture.now.getTime() + 6_000)),
    /ivekit_rustpbx_recording_spool_observation_fresh 0/);
});

async function metricsFixture(
  t: import('node:test').TestContext,
  input: { capacity_bytes: number; available_bytes: number }
) {
  const root = await mkdtemp(join(tmpdir(), 'ivekit-spool-capacity-'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'metrics.json');
  const now = new Date('2026-07-17T08:00:00.000Z');
  const used = input.capacity_bytes - input.available_bytes;
  await writeFile(path, `${JSON.stringify({
    schema_version: 1,
    observed_at: now.toISOString(),
    capacity_bytes: input.capacity_bytes,
    available_bytes: input.available_bytes,
    used_bytes: used,
    utilization_ratio: used / input.capacity_bytes,
    non_core_admission: used * 100 >= input.capacity_bytes * 80 ? 'defer_non_core' : 'accept',
    must_record_admission: used * 100 >= input.capacity_bytes * 90 ? 'reject_must_record' : 'accept',
    backlog_segments: 2,
    backlog_bytes: 100,
    oldest_backlog_age_seconds: 3,
    terminal_segments: 1,
    finalization_backlog: 3,
    finalization_terminal: 1,
    oldest_finalization_age_seconds: 7,
    states: { pending: 2, uploading: 0, uploaded_cleanup_pending: 0, terminal: 0 },
    last_upload_succeeded_at: now.toISOString()
  })}\n`, { mode: 0o600 });
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  return { path, now };
}
