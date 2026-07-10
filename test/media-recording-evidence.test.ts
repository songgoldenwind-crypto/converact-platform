import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { recordMediaRecordingEvidence } from '../src/agent-runtime/media-recording-evidence.js';
import type { EgressRecord } from '../src/agent-runtime/livekit/types.js';
import { createCollaborationModule } from '../src/agent-runtime/collaboration/index.js';
import { MemoryPg } from '../src/db-pg.js';

test('media recording evidence bridge records LiveKit recordings by business ref', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_media_evidence';
  const recording: EgressRecord = {
    id: 'crec_media_evidence_1',
    tenant_id: tenantId,
    call_session_id: '',
    business_ref_type: 'service_order',
    business_ref_id: 'order-media-evidence',
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order-media-evidence',
      display_name: 'LED media order',
      metadata: { project: 'led' }
    },
    source: 'livekit_egress',
    format: 'mp4',
    storage_url: 'recordings/tenant_media_evidence/service_order/order-media-evidence/1.mp4',
    duration_ms: null,
    file_size_bytes: null,
    has_video: 1,
    egress_id: 'egress-media-evidence',
    status: 'pending',
    retention_until: '2027-06-30T00:00:00.000Z',
    object_status: 'unchecked',
    object_checked_at: null,
    failure_code: '',
    completed_at: null,
    deleted_at: null,
    updated_at: '2026-06-30T00:00:00.000Z',
    created_at: '2026-06-30T00:00:00.000Z'
  };

  const evidence = await recordMediaRecordingEvidence(pg, recording, {
    roomName: 'tenant-media-evidence-room',
    createdBy: 'media-core-test'
  });

  assert.equal(evidence?.tenant_id, tenantId);
  assert.equal(evidence?.business_ref_type, 'service_order');
  assert.equal(evidence?.business_ref_id, 'order-media-evidence');
  assert.equal(evidence?.session_id, recording.id);
  assert.equal(evidence?.kind, 'video_recording');
  assert.equal(evidence?.storage_url, recording.storage_url);
  assert.equal(evidence?.created_by, 'media-core-test');
  assert.equal(evidence?.metadata.recording_id, recording.id);
  assert.equal(evidence?.metadata.room_name, 'tenant-media-evidence-room');
  assert.equal(evidence?.metadata.egress_id, recording.egress_id);

  const module = createCollaborationModule({ pg });
  const listed = await module.remote.listEvidence({
    tenant_id: tenantId,
    business_ref: recording.business_ref
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, evidence?.id);
});

test('media recording evidence bridge is idempotent for the same recording', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_media_evidence_idempotent';
  const recording: EgressRecord = {
    id: 'crec_media_evidence_idempotent',
    tenant_id: tenantId,
    call_session_id: '',
    business_ref_type: 'service_order',
    business_ref_id: 'order-media-evidence-idempotent',
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order-media-evidence-idempotent'
    },
    source: 'livekit_egress',
    format: 'mp4',
    storage_url: 'recordings/tenant_media_evidence_idempotent/service_order/order-media-evidence-idempotent/1.mp4',
    duration_ms: null,
    file_size_bytes: null,
    has_video: 1,
    egress_id: 'egress-media-evidence-idempotent',
    status: 'pending',
    retention_until: '2027-06-30T00:00:00.000Z',
    object_status: 'unchecked',
    object_checked_at: null,
    failure_code: '',
    completed_at: null,
    deleted_at: null,
    updated_at: '2026-06-30T00:00:00.000Z',
    created_at: '2026-06-30T00:00:00.000Z'
  };

  const first = await recordMediaRecordingEvidence(pg, recording);
  const second = await recordMediaRecordingEvidence(pg, {
    ...recording,
    storage_url: 'recordings/tenant_media_evidence_idempotent/service_order/order-media-evidence-idempotent/final.mp4'
  });

  assert.equal(second?.id, first?.id);
  const module = createCollaborationModule({ pg });
  const listed = await module.remote.listEvidence({
    tenant_id: tenantId,
    business_ref: recording.business_ref
  });
  assert.equal(listed.length, 1);
});

test('media recording evidence bridge updates the existing evidence when egress completes', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_media_evidence_completed';
  const recording: EgressRecord = {
    id: 'crec_media_evidence_completed',
    tenant_id: tenantId,
    call_session_id: '',
    business_ref_type: 'service_order',
    business_ref_id: 'order-media-evidence-completed',
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order-media-evidence-completed'
    },
    source: 'livekit_egress',
    format: 'mp4',
    storage_url: 'recordings/tenant_media_evidence_completed/service_order/order-media-evidence-completed/pending.mp4',
    duration_ms: null,
    file_size_bytes: null,
    has_video: 1,
    egress_id: 'egress-media-evidence-completed',
    status: 'pending',
    retention_until: '2027-06-30T00:00:00.000Z',
    object_status: 'unchecked',
    object_checked_at: null,
    failure_code: '',
    completed_at: null,
    deleted_at: null,
    updated_at: '2026-06-30T00:00:00.000Z',
    created_at: '2026-06-30T00:00:00.000Z'
  };

  const first = await recordMediaRecordingEvidence(pg, recording, { roomName: 'room-evidence-completed' });
  const completedEvidenceInput = {
    roomName: 'room-evidence-completed',
    checksum: 'sha256:final-recording'
  };
  const completed = await recordMediaRecordingEvidence(
    pg,
    {
      ...recording,
      storage_url: 's3://recordings/order-media-evidence-completed-final.mp4',
      duration_ms: 3000,
      file_size_bytes: 8192
    },
    completedEvidenceInput
  );

  assert.equal(completed?.id, first?.id);
  assert.equal(completed?.storage_url, 's3://recordings/order-media-evidence-completed-final.mp4');
  assert.equal(completed?.checksum, 'sha256:final-recording');
  assert.equal(completed?.metadata.duration_ms, 3000);
  assert.equal(completed?.metadata.file_size_bytes, 8192);
  assert.equal(completed?.metadata.recording_storage_url, 's3://recordings/order-media-evidence-completed-final.mp4');

  const module = createCollaborationModule({ pg });
  const listed = await module.remote.listEvidence({
    tenant_id: tenantId,
    business_ref: recording.business_ref
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, first?.id);
  assert.equal(listed[0]?.storage_url, 's3://recordings/order-media-evidence-completed-final.mp4');
});

test('media recording evidence bridge calculates checksum when completed object content is readable', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_media_evidence_checksum';
  const recording: EgressRecord = {
    id: 'crec_media_evidence_checksum',
    tenant_id: tenantId,
    call_session_id: '',
    business_ref_type: 'service_order',
    business_ref_id: 'order-media-evidence-checksum',
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order-media-evidence-checksum'
    },
    source: 'livekit_egress',
    format: 'mp4',
    storage_url: 'recordings/tenant_media_evidence_checksum/service_order/order-media-evidence-checksum/pending.mp4',
    duration_ms: null,
    file_size_bytes: null,
    has_video: 1,
    egress_id: 'egress-media-evidence-checksum',
    status: 'pending',
    retention_until: '2027-07-01T00:00:00.000Z',
    object_status: 'unchecked',
    object_checked_at: null,
    failure_code: '',
    completed_at: null,
    deleted_at: null,
    updated_at: '2026-07-01T00:00:00.000Z',
    created_at: '2026-07-01T00:00:00.000Z'
  };
  const finalBody = Buffer.from('final recording bytes from object storage');
  const expectedChecksum = `sha256:${createHash('sha256').update(finalBody).digest('hex')}`;

  await recordMediaRecordingEvidence(pg, recording, { roomName: 'room-evidence-checksum' });
  const completedEvidenceInput = {
    roomName: 'room-evidence-checksum',
    resolveContent: async () => finalBody
  };
  const completed = await recordMediaRecordingEvidence(
    pg,
    {
      ...recording,
      storage_url: 's3://recordings/order-media-evidence-checksum-final.mp4',
      duration_ms: 5000,
      file_size_bytes: finalBody.length
    },
    completedEvidenceInput
  );

  assert.equal(completed?.checksum, expectedChecksum);
  assert.equal(completed?.metadata.checksum_status, 'recorded');
  assert.equal(completed?.metadata.checksum_source, 'content_resolver');
  assert.equal(completed?.metadata.content_readable, true);
  assert.equal(completed?.metadata.object_read_status, 'readable');
});

test('media recording evidence bridge ignores unbound recordings', async () => {
  const pg = new MemoryPg();
  const evidence = await recordMediaRecordingEvidence(pg, {
    id: 'crec_unbound',
    tenant_id: 'tenant_media_evidence',
    call_session_id: '',
    business_ref_type: '',
    business_ref_id: '',
    business_ref: null,
    source: 'livekit_egress',
    format: 'ogg',
    storage_url: 'recordings/unbound.ogg',
    duration_ms: null,
    file_size_bytes: null,
    has_video: 0,
    egress_id: 'egress-unbound',
    status: 'pending',
    retention_until: '2027-06-30T00:00:00.000Z',
    object_status: 'unchecked',
    object_checked_at: null,
    failure_code: '',
    completed_at: null,
    deleted_at: null,
    updated_at: '2026-06-30T00:00:00.000Z',
    created_at: '2026-06-30T00:00:00.000Z'
  });

  assert.equal(evidence, null);
});
