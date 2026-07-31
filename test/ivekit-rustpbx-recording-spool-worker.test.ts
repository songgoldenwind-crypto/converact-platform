import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RustPbxRecordingSpoolWorker,
  type RustPbxRecordingSpoolWorkerConfig
} from '../src/agent-runtime/converact/recordings/rustpbx-recording-spool-worker.js';

const PART_SIZE = 5 * 1024 * 1024;

test('RustPBX recording spool worker streams a stable segment and deletes only after complete', async (t) => {
  const fixture = await spoolFixture(t);
  const requests: Array<{ method: string; url: string; body: Buffer }> = [];
  const worker = await RustPbxRecordingSpoolWorker.open(fixture.config, async (input, init) => {
    const method = init?.method || 'GET';
    const body = init?.body ? Buffer.from(init.body as ArrayBuffer) : Buffer.alloc(0);
    requests.push({ method, url: String(input), body });
    assert.equal(new Headers(init?.headers).get('x-pbx-key'), 'service-key-a');
    if (method === 'POST' && String(input).endsWith('/recording-spool/segments')) {
      const request = JSON.parse(body.toString()) as Record<string, any>;
      assert.equal(request.tenant_id, undefined);
      assert.equal(request.profile_id, undefined);
      assert.equal(request.segment.segment_id, 'vseg-a');
      assert.deepEqual(request.events, [{
        schema_version: 1,
        recording_id: 'vrec-a', segment_id: 'vseg-a', interaction_id: 'call-a',
        reservation_id: 'reservation-a', owner_epoch: '7', event_sequence: 1,
        event_type: 'paused', occurred_at: Date.parse('2026-07-17T05:59:30.000Z')
      }]);
      assert.equal(request.whole_file.size_bytes, fixture.payload.length);
      return jsonResponse({
        state: 'uploading',
        segment: { id: 'vseg-a' },
        lease: { worker_id: 'sidecar-a' },
        upload: { part_size_bytes: PART_SIZE },
        parts: []
      }, 201);
    }
    if (method === 'PUT') {
      assert.equal(body.equals(fixture.payload), true);
      return jsonResponse({
        part_number: 1,
        size_bytes: body.length,
        sha256: new Headers(init?.headers).get('x-ivekit-content-sha256')
      });
    }
    if (method === 'POST' && String(input).endsWith('/complete')) {
      return jsonResponse({ segment: { id: 'vseg-a', state: 'uploaded' }, upload: { state: 'completed' } });
    }
    return jsonResponse({ error: { code: 'not_found' } }, 404);
  }, {
    filesystem_stats: async () => ({ capacity_bytes: 1_000, available_bytes: 150 })
  });
  t.after(() => worker.close());

  const result = await worker.pollOnce();
  assert.deepEqual(result, { discovered: 1, uploaded: 1, retrying: 0, terminal: 0, cleanup_pending: 0 });
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'PUT', 'POST']);
  await assert.rejects(stat(fixture.payloadPath), hasCode('ENOENT'));
  await assert.rejects(stat(fixture.manifestPath), hasCode('ENOENT'));
  await assert.rejects(stat(fixture.eventPath), hasCode('ENOENT'));
  assert.deepEqual(await worker.listRecords(), []);
  const metrics = JSON.parse(await readFile(join(fixture.stateDirectory, 'metrics.json'), 'utf8'));
  assert.equal(metrics.backlog_segments, 0);
  assert.equal(metrics.last_upload_succeeded_at, fixture.now.toISOString());
  assert.equal(metrics.capacity_bytes, 1_000);
  assert.equal(metrics.used_bytes, 850);
  assert.equal(metrics.utilization_ratio, 0.85);
  assert.equal(metrics.non_core_admission, 'defer_non_core');
  assert.equal(metrics.must_record_admission, 'accept');
});

test('RustPBX recording spool worker resumes the same lease after retryable upload failure', async (t) => {
  let now = new Date('2026-07-17T07:00:00.000Z');
  const fixture = await spoolFixture(t, () => now);
  const leaseTokens: string[] = [];
  let failPart = true;
  const worker = await RustPbxRecordingSpoolWorker.open(fixture.config, async (input, init) => {
    const method = init?.method || 'GET';
    const headers = new Headers(init?.headers);
    if (method === 'POST' && String(input).endsWith('/recording-spool/segments')) {
      const request = JSON.parse(String(init?.body)) as Record<string, any>;
      leaseTokens.push(request.lease_token);
      return jsonResponse({
        state: 'uploading', segment: { id: 'vseg-a' }, lease: {},
        upload: { part_size_bytes: PART_SIZE }, parts: []
      }, 201);
    }
    if (method === 'PUT' && failPart) {
      failPart = false;
      return jsonResponse({ error: { code: 'storage_unavailable' } }, 503);
    }
    if (method === 'PUT') {
      assert.equal(headers.get('x-ivekit-recording-lease-token'), leaseTokens[0]);
      return jsonResponse({ part_number: 1, size_bytes: fixture.payload.length, sha256: headers.get('x-ivekit-content-sha256') });
    }
    return jsonResponse({ segment: { id: 'vseg-a', state: 'uploaded' }, upload: { state: 'completed' } });
  });
  t.after(() => worker.close());

  assert.deepEqual(await worker.pollOnce(), {
    discovered: 1, uploaded: 0, retrying: 1, terminal: 0, cleanup_pending: 0
  });
  const failed = await worker.listRecords();
  assert.equal(failed[0]?.state, 'pending');
  assert.equal(failed[0]?.attempt_count, 1);
  assert.equal(await stat(fixture.payloadPath).then(() => true), true);

  now = new Date('2026-07-17T07:00:01.000Z');
  assert.equal((await worker.pollOnce()).uploaded, 1);
  assert.equal(leaseTokens.length, 2);
  assert.equal(leaseTokens[0], leaseTokens[1]);
  assert.deepEqual(await worker.listRecords(), []);
});

test('RustPBX recording spool worker retries and cleans an owner-bound recording completion marker', async (t) => {
  let now = new Date('2026-07-17T07:00:00.000Z');
  const fixture = await spoolFixture(t, () => now, { completionMarker: true });
  let finalizationAttempts = 0;
  const worker = await RustPbxRecordingSpoolWorker.open(fixture.config, async (input, init) => {
    const method = init?.method || 'GET';
    const url = String(input);
    if (method === 'POST' && url.endsWith('/recording-spool/segments')) {
      return jsonResponse({ state: 'uploading', segment: { id: 'vseg-a' }, lease: {},
        upload: { part_size_bytes: PART_SIZE }, parts: [] }, 201);
    }
    if (method === 'PUT') {
      return jsonResponse({ part_number: 1, size_bytes: fixture.payload.length,
        sha256: new Headers(init?.headers).get('x-ivekit-content-sha256') });
    }
    if (method === 'POST' && url.endsWith('/segments/vseg-a/complete')) {
      return jsonResponse({ segment: { id: 'vseg-a', state: 'uploaded' },
        upload: { state: 'completed' } });
    }
    if (method === 'POST' && url.endsWith('/recording-spool/recordings/vrec-a/complete')) {
      finalizationAttempts += 1;
      const marker = JSON.parse(String(init?.body));
      assert.equal(marker.last_segment_sequence, 1);
      if (finalizationAttempts === 1) {
        return new Response(JSON.stringify({ error: {
          code: 'recording_manifest_segments_pending', retryable: true
        } }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      return jsonResponse({ id: 'vrec-a', state: 'uploaded_unverified' });
    }
    return jsonResponse({ error: { code: 'not_found' } }, 404);
  });
  t.after(() => worker.close());

  await worker.pollOnce();
  assert.equal((await worker.listFinalizations())[0]?.state, 'pending');
  assert.equal(await stat(fixture.completionPath!).then(() => true), true);
  const pendingMetrics = JSON.parse(
    await readFile(join(fixture.stateDirectory, 'metrics.json'), 'utf8')
  );
  assert.equal(pendingMetrics.finalization_backlog, 1);
  assert.equal(pendingMetrics.finalization_terminal, 0);
  assert.equal(pendingMetrics.oldest_finalization_age_seconds, 0);

  now = new Date('2026-07-17T07:00:01.000Z');
  await worker.pollOnce();
  assert.equal(finalizationAttempts, 2);
  assert.deepEqual(await worker.listFinalizations(), []);
  await assert.rejects(stat(fixture.completionPath!), hasCode('ENOENT'));
  const completedMetrics = JSON.parse(
    await readFile(join(fixture.stateDirectory, 'metrics.json'), 'utf8')
  );
  assert.equal(completedMetrics.finalization_backlog, 0);
});

test('RustPBX recording spool worker treats dropped-sample manifest failure as audited terminal completion', async (t) => {
  const fixture = await spoolFixture(t, undefined, { completionMarker: true });
  const worker = await RustPbxRecordingSpoolWorker.open(fixture.config, async (input, init) => {
    const method = init?.method || 'GET';
    const url = String(input);
    if (method === 'POST' && url.endsWith('/recording-spool/segments')) {
      return jsonResponse({ state: 'uploading', segment: { id: 'vseg-a' }, lease: {},
        upload: { part_size_bytes: PART_SIZE }, parts: [] }, 201);
    }
    if (method === 'PUT') {
      return jsonResponse({ part_number: 1, size_bytes: fixture.payload.length,
        sha256: new Headers(init?.headers).get('x-ivekit-content-sha256') });
    }
    if (method === 'POST' && url.endsWith('/segments/vseg-a/complete')) {
      return jsonResponse({ segment: { id: 'vseg-a', state: 'uploaded' },
        upload: { state: 'completed' } });
    }
    if (method === 'POST' && url.endsWith('/recording-spool/recordings/vrec-a/complete')) {
      return jsonResponse({
        id: 'vrec-a',
        state: 'failed',
        failure_code: 'recording_samples_dropped'
      });
    }
    return jsonResponse({ error: { code: 'not_found' } }, 404);
  });
  t.after(() => worker.close());

  await worker.pollOnce();

  assert.deepEqual(await worker.listFinalizations(), []);
  await assert.rejects(stat(fixture.completionPath!), hasCode('ENOENT'));
});

test('RustPBX recording spool worker fail-closes symlink payloads without issuing network calls', async (t) => {
  const fixture = await spoolFixture(t, undefined, { symlinkPayload: true });
  let requested = false;
  const worker = await RustPbxRecordingSpoolWorker.open(fixture.config, async () => {
    requested = true;
    return jsonResponse({});
  });
  t.after(() => worker.close());

  const result = await worker.pollOnce();
  assert.equal(result.terminal, 1);
  assert.equal(requested, false);
  const records = await worker.listRecords();
  assert.equal(records[0]?.state, 'terminal');
  assert.equal(records[0]?.last_error_code, 'recording_spool_local_file_invalid');
  const metrics = JSON.parse(await readFile(join(fixture.stateDirectory, 'metrics.json'), 'utf8'));
  assert.equal(metrics.backlog_segments, 0);
  assert.equal(metrics.terminal_segments, 1);
});

async function spoolFixture(
  t: import('node:test').TestContext,
  nowFactory: (() => Date) | undefined = undefined,
  options: { symlinkPayload?: boolean; completionMarker?: boolean } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'ivekit-rustpbx-spool-'));
  const spoolDirectory = join(root, 'recordings');
  const stateDirectory = join(root, 'state');
  const recordingDirectory = join(spoolDirectory, 'vrec-a');
  await mkdir(recordingDirectory, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const serviceKeyFile = join(root, 'service-key');
  const leaseSecretFile = join(root, 'lease-secret');
  await writeFile(serviceKeyFile, 'service-key-a\n', { mode: 0o600 });
  await writeFile(leaseSecretFile, 'lease-secret-a-with-at-least-32-bytes\n', { mode: 0o600 });
  const payload = Buffer.from('stable wav payload');
  const payloadPath = join(recordingDirectory, 'segment-000001.wav');
  if (options.symlinkPayload) {
    const target = join(root, 'outside.wav');
    await writeFile(target, payload);
    const { symlink } = await import('node:fs/promises');
    await symlink(target, payloadPath);
  } else {
    await writeFile(payloadPath, payload, { mode: 0o600 });
  }
  const manifestPath = join(recordingDirectory, 'segment-000001.json');
  await writeFile(manifestPath, JSON.stringify({
    schema_version: 1,
    recording_id: 'vrec-a', segment_id: 'vseg-a', interaction_id: 'call-a',
    reservation_id: 'reservation-a', owner_epoch: '7', region_id: 'region-a',
    zone_id: 'zone-a', cell_id: 'cell-a', recorder_node_id: 'rustpbx-a',
    sequence: 1, track_id: 'mixed', payload_filename: 'segment-000001.wav',
    container: 'wav', codec: 'PCMU', channels: 1, sample_rate_hz: 8000,
    size_bytes: payload.length, encoded_payload_bytes: payload.length - 2,
    encoded_payload_sha256: 'b'.repeat(64), checksum_scope: 'encoded_payload',
    written_samples: 8000,
    started_at: Date.parse('2026-07-17T05:59:00.000Z'),
    ended_at: Date.parse('2026-07-17T06:00:00.000Z')
  }), { mode: 0o600 });
  const eventPath = join(recordingDirectory, 'event-000001.json');
  await writeFile(eventPath, JSON.stringify({
    schema_version: 1,
    recording_id: 'vrec-a', segment_id: 'vseg-a', interaction_id: 'call-a',
    reservation_id: 'reservation-a', owner_epoch: '7', event_sequence: 1,
    event_type: 'paused', occurred_at: Date.parse('2026-07-17T05:59:30.000Z')
  }), { mode: 0o600 });
  const completionPath = options.completionMarker
    ? join(recordingDirectory, 'recording-completed.json')
    : null;
  if (completionPath) {
    await writeFile(completionPath, JSON.stringify({
      schema_version: 1, recording_id: 'vrec-a', interaction_id: 'call-a',
      reservation_id: 'reservation-a', owner_epoch: '7', region_id: 'region-a',
      zone_id: 'zone-a', cell_id: 'cell-a', recorder_node_id: 'rustpbx-a',
      segment_count: 1, last_segment_sequence: 1,
      ended_at: Date.parse('2026-07-17T06:00:00.000Z')
    }), { mode: 0o600 });
  }
  const now = new Date('2026-07-17T07:00:00.000Z');
  const config: RustPbxRecordingSpoolWorkerConfig = {
    base_url: 'http://ivekit:3000', profile_id: 'profile-a', worker_id: 'sidecar-a',
    spool_directory: spoolDirectory, state_directory: stateDirectory,
    service_key_file: serviceKeyFile, lease_secret_file: leaseSecretFile,
    part_size_bytes: PART_SIZE, lease_ms: 60_000, scan_limit: 100,
    max_concurrent_uploads: 2, retry_base_ms: 100, retry_max_ms: 1_000,
    now: nowFactory || (() => now), random: () => 0
  };
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  return {
    config, payload, payloadPath, manifestPath, eventPath, completionPath,
    stateDirectory, now
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => Boolean(error && typeof error === 'object' &&
    'code' in error && (error as { code?: unknown }).code === code);
}
