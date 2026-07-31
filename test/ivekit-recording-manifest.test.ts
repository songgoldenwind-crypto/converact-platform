import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeRecordingSegment,
  createRecordingManifest,
  createRecordingSegment,
  recordingSpoolAdmission,
  sealRecordingSegment,
  transitionRecordingManifest,
  transitionRecordingSegment
} from '../src/agent-runtime/ivekit/recordings/recording-manifest.js';

const now = new Date('2026-07-17T02:00:00.000Z');

test('RecordingManifest follows the requested to available evidence state machine', () => {
  let manifest = createRecordingManifest({
    id: 'recording-a',
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    owner_epoch: '7',
    source: 'sip_voice',
    consent_id: 'consent-a',
    recording_mode: 'always',
    retention_until: '2026-08-17T02:00:00.000Z',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    recorder_node_id: 'rustpbx-a',
    media: {
      container: 'wav',
      codecs: ['PCMU'],
      channels: 2,
      sample_rate_hz: 8000
    }
  }, now);

  for (const state of [
    'reserved',
    'recording',
    'finalizing',
    'uploading',
    'uploaded_unverified',
    'scanning',
    'available'
  ] as const) {
    manifest = transitionRecordingManifest(manifest, state, {
      owner_epoch: '7',
      at: new Date(manifest.updated_at).getTime() === now.getTime()
        ? new Date(now.getTime() + 1)
        : new Date(Date.parse(manifest.updated_at) + 1)
    });
  }

  assert.equal(manifest.state, 'available');
  assert.equal(manifest.failure_code, '');
  assert.equal(manifest.legal_hold, false);
});

test('RecordingManifest fences stale owners and rejects skipped states', () => {
  const manifest = createRecordingManifest({
    id: 'recording-b',
    tenant_id: 'tenant-a',
    interaction_id: 'call-b',
    interaction_kind: 'sip_voice',
    owner_epoch: '9',
    source: 'sip_voice',
    consent_id: 'consent-b',
    recording_mode: 'policy',
    retention_until: '2026-08-17T02:00:00.000Z',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    recorder_node_id: 'rustpbx-a',
    media: { container: 'wav', codecs: ['PCMA'], channels: 2, sample_rate_hz: 8000 }
  }, now);

  assert.throws(
    () => transitionRecordingManifest(manifest, 'recording', {
      owner_epoch: '9', at: new Date(now.getTime() + 1)
    }),
    /recording_manifest_transition_invalid/
  );
  assert.throws(
    () => transitionRecordingManifest(manifest, 'reserved', {
      owner_epoch: '8', at: new Date(now.getTime() + 1)
    }),
    /recording_owner_epoch_conflict/
  );
});

test('recording segment complete is idempotent and detects conflicting bytes', () => {
  let segment = sealRecordingSegment(createRecordingSegment({
    id: 'segment-a-000001',
    tenant_id: 'tenant-a',
    manifest_id: 'recording-a',
    owner_epoch: '7',
    sequence: 1,
    track_id: 'mixed',
    container: 'wav',
    codec: 'PCMU',
    started_at: '2026-07-17T02:00:00.000Z',
    local_ref: 'spool://recording-a/segment-a-000001.wav'
  }, now), {
    owner_epoch: '7',
    size_bytes: 4096,
    sha256: 'a'.repeat(64),
    ended_at: new Date(now.getTime() + 1)
  });
  segment = transitionRecordingSegment(segment, 'upload_pending', {
    owner_epoch: '7', at: new Date(now.getTime() + 2)
  });
  segment = transitionRecordingSegment(segment, 'uploading', {
    owner_epoch: '7', at: new Date(now.getTime() + 3)
  });
  const uploaded = completeRecordingSegment(segment, {
    owner_epoch: '7',
    size_bytes: 4096,
    sha256: 'a'.repeat(64),
    object_ref: 'ivekit-secure-file://voice-segment-a',
    at: new Date(now.getTime() + 4)
  });
  const replay = completeRecordingSegment(uploaded, {
    owner_epoch: '7',
    size_bytes: 4096,
    sha256: 'a'.repeat(64),
    object_ref: 'ivekit-secure-file://voice-segment-a',
    at: new Date(now.getTime() + 5)
  });

  assert.deepEqual(replay, uploaded);
  assert.throws(
    () => completeRecordingSegment(uploaded, {
      owner_epoch: '7',
      size_bytes: 4097,
      sha256: 'b'.repeat(64),
      object_ref: 'ivekit-secure-file://voice-segment-b',
      at: new Date(now.getTime() + 5)
    }),
    /recording_segment_completion_conflict/
  );
});

test('sealing a local segment is idempotent and checksum-fenced', () => {
  const open = createRecordingSegment({
    id: 'segment-seal-a',
    tenant_id: 'tenant-a',
    manifest_id: 'recording-a',
    owner_epoch: '7',
    sequence: 2,
    track_id: 'mixed',
    container: 'wav',
    codec: 'PCMU',
    started_at: now.toISOString(),
    local_ref: 'spool://recording-a/segment-seal-a.wav'
  }, now);
  const sealed = sealRecordingSegment(open, {
    owner_epoch: '7',
    size_bytes: 8192,
    sha256: 'c'.repeat(64),
    ended_at: new Date(now.getTime() + 60_000)
  });
  assert.equal(sealed.state, 'closed');
  assert.equal(sealed.size_bytes, 8192);
  assert.deepEqual(sealRecordingSegment(sealed, {
    owner_epoch: '7',
    size_bytes: 8192,
    sha256: 'c'.repeat(64),
    ended_at: new Date(now.getTime() + 60_000)
  }), sealed);
  assert.throws(() => sealRecordingSegment(sealed, {
    owner_epoch: '7',
    size_bytes: 8193,
    sha256: 'd'.repeat(64),
    ended_at: new Date(now.getTime() + 60_000)
  }), /recording_segment_seal_conflict/);
});

test('spool watermarks preserve accepted evidence and fail closed for new recording work', () => {
  assert.equal(recordingSpoolAdmission({
    used_bytes: 79,
    capacity_bytes: 100,
    recording_class: 'non_core'
  }), 'accept');
  assert.equal(recordingSpoolAdmission({
    used_bytes: 80,
    capacity_bytes: 100,
    recording_class: 'non_core'
  }), 'defer_non_core');
  assert.equal(recordingSpoolAdmission({
    used_bytes: 89,
    capacity_bytes: 100,
    recording_class: 'must_record'
  }), 'accept');
  assert.equal(recordingSpoolAdmission({
    used_bytes: 90,
    capacity_bytes: 100,
    recording_class: 'must_record'
  }), 'reject_must_record');
});
