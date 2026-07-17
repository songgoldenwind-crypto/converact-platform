import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  PostgresRecordingManifestStore,
  RecordingManifestStoreError
} from '../src/agent-runtime/ivekit/recordings/postgres-recording-manifest-store.js';
import {
  createRecordingManifest,
  createRecordingSegment,
  transitionRecordingSegment
} from '../src/agent-runtime/ivekit/recordings/recording-manifest.js';

class RecordingPg implements PgQueryable {
  readonly calls: Array<{ text: string; params: unknown[] }> = [];

  constructor(private readonly respond: (text: string, params: unknown[]) => unknown[] = () => []) {}

  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = this.respond(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

const now = new Date('2026-07-17T03:00:00.000Z');

test('Postgres recording store creates idempotent manifests and rejects identity conflicts', async () => {
  const manifest = recordingManifest();
  const replayPg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_recording_manifests/i.test(sql)) return [];
    if (/FROM ivekit_recording_manifests manifest/i.test(sql)) return [manifestRow()];
    return [];
  });
  const replay = await new PostgresRecordingManifestStore(replayPg).createManifest(manifest);
  assert.equal(replay.created, false);
  assert.equal(replay.manifest.id, 'recording-a');
  const insert = replayPg.calls.find((call) =>
    /INSERT INTO ivekit_recording_manifests/i.test(call.text)
  )!;
  assert.match(insert.text, /ON CONFLICT \(tenant_id, id\) DO NOTHING/i);
  assert.equal(insert.params.includes('call-a'), true);

  const conflictPg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_recording_manifests/i.test(sql)) return [];
    if (/FROM ivekit_recording_manifests manifest/i.test(sql)) {
      return [manifestRow({ interaction_id: 'call-other' })];
    }
    return [];
  });
  await assert.rejects(
    new PostgresRecordingManifestStore(conflictPg).createManifest(manifest),
    (error: unknown) => error instanceof RecordingManifestStoreError
      && error.code === 'recording_manifest_idempotency_conflict'
  );
});

test('Postgres recording store registers exact segment identity and append-only events', async () => {
  const segment = closedSegment();
  const pg = new RecordingPg((sql) => {
    if (/FROM ivekit_recording_manifests manifest/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return [manifestRow({ state: 'uploading', processing: JSON.stringify({
        reservation_id: 'reservation-a'
      }) })];
    }
    if (/INSERT INTO ivekit_recording_segments/i.test(sql)) return [segmentRow()];
    if (/INSERT INTO ivekit_recording_segment_events/i.test(sql)) return [eventRow()];
    return [];
  });
  const store = new PostgresRecordingManifestStore(pg);

  const inserted = await store.registerSegment(segment);
  assert.equal(inserted.segment.id, 'segment-a-000001');
  await store.appendSegmentEvent({
    id: 'segment-event-a',
    tenant_id: 'tenant-a',
    manifest_id: 'recording-a',
    segment_id: 'segment-a-000001',
    owner_epoch: '7',
    event_sequence: 1,
    event_type: 'closed',
    policy_source: 'always',
    actor_identity: 'rustpbx-a',
    metadata: { dropped_samples: 0 },
    occurred_at: '2026-07-17T03:01:00.000Z'
  });

  const segmentInsert = pg.calls.find((call) =>
    /INSERT INTO ivekit_recording_segments/i.test(call.text)
  )!;
  assert.match(
    segmentInsert.text,
    /ON CONFLICT \(tenant_id, manifest_id, track_id, sequence\) DO NOTHING/i
  );
  const eventInsert = pg.calls.find((call) =>
    /INSERT INTO ivekit_recording_segment_events/i.test(call.text)
  )!;
  assert.match(eventInsert.text, /ON CONFLICT \(tenant_id, segment_id, event_sequence\) DO NOTHING/i);
});

test('Postgres recording store finalizes only a contiguous fully uploaded segment set', async () => {
  const pg = new RecordingPg((sql) => {
    if (/FROM ivekit_recording_manifests manifest/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return [manifestRow({ state: 'uploading', processing: JSON.stringify({
        reservation_id: 'reservation-a'
      }) })];
    }
    if (/FROM ivekit_recording_segments segment/i.test(sql) && /uploaded_count/i.test(sql)) {
      return [{ segment_count: 2, uploaded_count: 2, distinct_sequences: 2,
        first_sequence: 1, last_sequence: 2 }];
    }
    if (/UPDATE ivekit_recording_manifests/i.test(sql)) {
      return [manifestRow({
        state: 'uploaded_unverified', ended_at: '2026-07-17T03:02:00.000Z',
        object_ref: 'recording-intake://recording-a',
        processing: JSON.stringify({ segment_count: 2, last_segment_sequence: 2 })
      })];
    }
    return [];
  });
  const store = new PostgresRecordingManifestStore(pg);
  const finalized = await store.finalizeManifest({
    tenant_id: 'tenant-a', manifest_id: 'recording-a', owner_epoch: '7',
    interaction_id: 'call-a', reservation_id: 'reservation-a', region_id: 'region-a',
    zone_id: 'zone-a', cell_id: 'cell-a', recorder_node_id: 'rustpbx-a',
    segment_count: 2, last_segment_sequence: 2,
    ended_at: new Date('2026-07-17T03:02:00.000Z'), now
  });

  assert.equal(finalized.state, 'uploaded_unverified');
  const lock = pg.calls.find((call) => /FOR UPDATE/i.test(call.text))!;
  assert.match(lock.text, /ivekit_recording_manifests/i);
  const summary = pg.calls.find((call) => /uploaded_count/i.test(call.text))!;
  assert.match(summary.text, /COUNT\(\*\) FILTER \(WHERE segment\.state = 'uploaded'\)/i);
  assert.match(summary.text, /COUNT\(DISTINCT segment\.sequence\)/i);
});

test('Postgres recording store leaves a manifest uploading while any expected segment is missing', async () => {
  const pg = new RecordingPg((sql) => {
    if (/FROM ivekit_recording_manifests manifest/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return [manifestRow({ state: 'uploading', processing: JSON.stringify({
        reservation_id: 'reservation-a'
      }) })];
    }
    if (/FROM ivekit_recording_segments segment/i.test(sql) && /uploaded_count/i.test(sql)) {
      return [{ segment_count: 1, uploaded_count: 1, distinct_sequences: 1,
        first_sequence: 1, last_sequence: 1 }];
    }
    return [];
  });
  await assert.rejects(
    new PostgresRecordingManifestStore(pg).finalizeManifest({
      tenant_id: 'tenant-a', manifest_id: 'recording-a', owner_epoch: '7',
      interaction_id: 'call-a', reservation_id: 'reservation-a', region_id: 'region-a',
      zone_id: 'zone-a', cell_id: 'cell-a', recorder_node_id: 'rustpbx-a',
      segment_count: 2, last_segment_sequence: 2,
      ended_at: new Date('2026-07-17T03:02:00.000Z'), now
    }),
    (error: unknown) => error instanceof RecordingManifestStoreError
      && error.code === 'recording_manifest_segments_pending'
  );
  assert.equal(pg.calls.some((call) => /UPDATE ivekit_recording_manifests/i.test(call.text)), false);
});

test('Postgres recording store claims due segments with row locks and lease fencing', async () => {
  const pg = new RecordingPg((sql) => {
    if (/WITH candidate AS/i.test(sql)) return [segmentRow({ state: 'uploading' })];
    if (/INSERT INTO ivekit_recording_upload_leases/i.test(sql)) {
      return [leaseRow({ attempt_count: 2 })];
    }
    return [];
  });
  const store = new PostgresRecordingManifestStore(pg);
  const claimed = await store.claimSegments({
    tenant_id: 'tenant-a',
    worker_id: 'worker-a',
    lease_token_hash: 'a'.repeat(64),
    now,
    lease_ms: 30_000,
    limit: 10
  });

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.segment.state, 'uploading');
  assert.equal(claimed[0]?.lease.attempt_count, 2);
  const claim = pg.calls.find((call) => /WITH candidate AS/i.test(call.text))!;
  assert.match(claim.text, /FOR UPDATE OF segment SKIP LOCKED/i);
  assert.match(claim.text, /lease\.lease_expires_at <= \$2/i);
  const lease = pg.calls.find((call) =>
    /INSERT INTO ivekit_recording_upload_leases/i.test(call.text)
  )!;
  assert.match(lease.text, /attempt_count = ivekit_recording_upload_leases\.attempt_count \+ 1/i);
  assert.match(lease.text, /lease_token_hash = EXCLUDED\.lease_token_hash/i);
});

test('Postgres recording store can claim one locally identified segment without taking adjacent work', async () => {
  const pg = new RecordingPg((sql) => {
    if (/WITH candidate AS/i.test(sql)) return [segmentRow({ state: 'uploading' })];
    if (/INSERT INTO ivekit_recording_upload_leases/i.test(sql)) return [leaseRow()];
    return [];
  });
  const claimed = await new PostgresRecordingManifestStore(pg).claimSegment({
    tenant_id: 'tenant-a',
    segment_id: 'segment-a-000001',
    worker_id: 'rustpbx-sidecar-a',
    lease_token_hash: 'a'.repeat(64),
    now,
    lease_ms: 30_000
  });

  assert.equal(claimed.segment.id, 'segment-a-000001');
  const claim = pg.calls.find((call) => /WITH candidate AS/i.test(call.text))!;
  assert.match(claim.text, /segment\.id = \$2/i);
  assert.match(claim.text, /FOR UPDATE OF segment SKIP LOCKED/i);
});

test('Postgres recording store completes only the current owner and upload lease', async () => {
  const pg = new RecordingPg((sql) => {
    if (/UPDATE ivekit_recording_segments segment/i.test(sql)) {
      return [segmentRow({
        state: 'uploaded',
        size_bytes: 4096,
        sha256: 'b'.repeat(64),
        object_ref: 'ivekit-secure-file://segment-a'
      })];
    }
    if (/UPDATE ivekit_recording_upload_leases/i.test(sql)) {
      return [leaseRow({ state: 'completed' })];
    }
    return [];
  });
  const store = new PostgresRecordingManifestStore(pg);
  const completed = await store.completeSegment({
    tenant_id: 'tenant-a',
    segment_id: 'segment-a-000001',
    owner_epoch: '7',
    worker_id: 'worker-a',
    lease_token_hash: 'a'.repeat(64),
    size_bytes: 4096,
    sha256: 'b'.repeat(64),
    object_ref: 'ivekit-secure-file://segment-a',
    now
  });

  assert.equal(completed.state, 'uploaded');
  const update = pg.calls.find((call) =>
    /UPDATE ivekit_recording_segments segment/i.test(call.text)
  )!;
  assert.match(update.text, /segment\.owner_epoch = \$3::numeric/i);
  assert.match(update.text, /lease\.worker_id = \$4/i);
  assert.match(update.text, /lease\.lease_token_hash = \$5/i);
  assert.match(update.text, /lease\.lease_expires_at > \$6/i);
});

test('Postgres recording store releases retryable work and preserves terminal evidence', async () => {
  const pg = new RecordingPg((sql) => {
    if (/UPDATE ivekit_recording_segments/i.test(sql)) {
      return [segmentRow({ state: 'upload_pending', failure_code: 'object_storage_unavailable' })];
    }
    if (/UPDATE ivekit_recording_upload_leases/i.test(sql)) {
      return [leaseRow({ state: 'retry_wait', last_error_code: 'object_storage_unavailable' })];
    }
    return [];
  });
  await new PostgresRecordingManifestStore(pg).releaseSegment({
    tenant_id: 'tenant-a',
    segment_id: 'segment-a-000001',
    owner_epoch: '7',
    worker_id: 'worker-a',
    lease_token_hash: 'a'.repeat(64),
    retryable: true,
    error_code: 'object_storage_unavailable',
    next_attempt_at: new Date(now.getTime() + 5_000),
    now
  });

  const lease = pg.calls.find((call) =>
    /UPDATE ivekit_recording_upload_leases/i.test(call.text)
  )!;
  assert.match(lease.text, /state = \$6/i);
  assert.equal(lease.params[5], 'retry_wait');
  assert.equal(lease.params.some((value) => String(value).includes('http')), false);
});

test('Postgres recording store persists resumable multipart identity and immutable parts', async () => {
  const pg = new RecordingPg((sql) => {
    if (/INSERT INTO ivekit_recording_segment_uploads/i.test(sql)) return [uploadRow()];
    if (/INSERT INTO ivekit_recording_upload_parts/i.test(sql)) return [partRow()];
    if (/FROM ivekit_recording_upload_parts part/i.test(sql)) return [partRow()];
    if (/UPDATE ivekit_recording_segment_uploads/i.test(sql)) {
      return [uploadRow({ state: 'completed', completed_at: now.toISOString() })];
    }
    return [];
  });
  const store = new PostgresRecordingManifestStore(pg);
  const upload = await store.attachMultipartUpload({
    tenant_id: 'tenant-a',
    segment_id: 'segment-a-000001',
    upload_id: 'mpu-a',
    object_key: 'recording-segments/opaque-a',
    storage_url: 's3://recordings/opaque-a',
    part_size_bytes: 8 * 1024 * 1024,
    now
  });
  assert.equal(upload.upload.upload_id, 'mpu-a');
  await store.recordUploadedPart({
    tenant_id: 'tenant-a',
    segment_id: 'segment-a-000001',
    part_number: 1,
    size_bytes: 4096,
    sha256: 'd'.repeat(64),
    etag: 'etag-a',
    now
  });
  assert.equal((await store.listUploadedParts(
    'tenant-a',
    'segment-a-000001'
  )).length, 1);
  await store.markMultipartCompleted({
    tenant_id: 'tenant-a',
    segment_id: 'segment-a-000001',
    upload_id: 'mpu-a',
    object_key: 'recording-segments/opaque-a',
    now
  });

  const attach = pg.calls.find((call) =>
    /INSERT INTO ivekit_recording_segment_uploads/i.test(call.text)
  )!;
  assert.match(attach.text, /ON CONFLICT \(tenant_id, segment_id\) DO NOTHING/i);
  const part = pg.calls.find((call) =>
    /INSERT INTO ivekit_recording_upload_parts/i.test(call.text)
  )!;
  assert.match(part.text, /ON CONFLICT \(tenant_id, segment_id, part_number\) DO NOTHING/i);
  const complete = pg.calls.find((call) =>
    /UPDATE ivekit_recording_segment_uploads/i.test(call.text)
  )!;
  assert.match(complete.text, /upload_id = \$3 AND object_key = \$4/i);
});

function recordingManifest() {
  return createRecordingManifest({
    id: 'recording-a',
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    owner_epoch: '7',
    source: 'sip_voice',
    consent_id: 'consent-a',
    recording_mode: 'always',
    retention_until: '2026-08-17T03:00:00.000Z',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    recorder_node_id: 'rustpbx-a',
    media: { container: 'wav', codecs: ['PCMU'], channels: 2, sample_rate_hz: 8000 }
  }, now);
}

function closedSegment() {
  return transitionRecordingSegment(createRecordingSegment({
    id: 'segment-a-000001',
    tenant_id: 'tenant-a',
    manifest_id: 'recording-a',
    owner_epoch: '7',
    sequence: 1,
    track_id: 'mixed',
    container: 'wav',
    codec: 'PCMU',
    started_at: '2026-07-17T03:00:00.000Z',
    local_ref: 'spool://recording-a/segment-a-000001.wav'
  }, now), 'closed', {
    owner_epoch: '7',
    at: new Date(now.getTime() + 60_000)
  });
}

function manifestRow(overrides: Record<string, unknown> = {}) {
  return {
    ...recordingManifest(),
    media: JSON.stringify(recordingManifest().media),
    processing: '{}',
    ...overrides
  };
}

function segmentRow(overrides: Record<string, unknown> = {}) {
  return {
    ...closedSegment(),
    ...overrides
  };
}

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a',
    segment_id: 'segment-a-000001',
    worker_id: 'worker-a',
    lease_token_hash: 'a'.repeat(64),
    state: 'leased',
    attempt_count: 1,
    max_attempts: 20,
    lease_expires_at: '2026-07-17T03:00:30.000Z',
    next_attempt_at: null,
    last_error_code: '',
    last_error_message: '',
    created_at: '2026-07-17T03:00:00.000Z',
    updated_at: '2026-07-17T03:00:00.000Z',
    ...overrides
  };
}

function eventRow() {
  return {
    id: 'segment-event-a',
    tenant_id: 'tenant-a',
    manifest_id: 'recording-a',
    segment_id: 'segment-a-000001',
    owner_epoch: '7',
    event_sequence: 1,
    event_type: 'closed',
    policy_source: 'always',
    actor_identity: 'rustpbx-a',
    metadata: '{"dropped_samples":0}',
    occurred_at: '2026-07-17T03:01:00.000Z',
    created_at: '2026-07-17T03:01:00.000Z'
  };
}

function uploadRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a',
    segment_id: 'segment-a-000001',
    upload_id: 'mpu-a',
    object_key: 'recording-segments/opaque-a',
    storage_url: 's3://recordings/opaque-a',
    part_size_bytes: 8 * 1024 * 1024,
    state: 'initiated',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    completed_at: null,
    ...overrides
  };
}

function partRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a',
    segment_id: 'segment-a-000001',
    part_number: 1,
    size_bytes: 4096,
    sha256: 'd'.repeat(64),
    etag: 'etag-a',
    status: 'uploaded',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides
  };
}
