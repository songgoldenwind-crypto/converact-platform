import { createHash } from 'node:crypto';
import type { PgQueryable } from '../db-pg.js';
import { createCollaborationModule } from './collaboration/index.js';
import type { EvidenceKind } from './collaboration/types.js';
import type { EgressRecord } from './livekit/types.js';
import type { RecordingObjectContentResult } from './media-recording-object.js';

export interface RecordMediaRecordingEvidenceInput {
  roomName?: string;
  createdBy?: string;
  checksum?: string;
  resolveContent?: (
    recording: EgressRecord
  ) => Promise<Buffer | Uint8Array | string | RecordingObjectContentResult | null | undefined>;
}

export async function recordMediaRecordingEvidence(
  pg: PgQueryable,
  recording: EgressRecord,
  input: RecordMediaRecordingEvidenceInput = {}
) {
  if (!recording.business_ref) return null;
  const module = createCollaborationModule({ pg });
  const kind: EvidenceKind = recording.has_video ? 'video_recording' : 'audio_recording';
  const checksumResult = await resolveEvidenceChecksum(recording, input);
  const metadata = {
    recording_id: recording.id,
    room_name: input.roomName || '',
    egress_id: recording.egress_id,
    source: recording.source,
    format: recording.format,
    has_video: Boolean(recording.has_video),
    call_session_id: recording.call_session_id,
    recording_storage_url: recording.storage_url,
    duration_ms: recording.duration_ms,
    file_size_bytes: recording.file_size_bytes,
    recording_status: recording.status,
    retention_until: recording.retention_until,
    object_status: recording.object_status,
    object_checked_at: recording.object_checked_at,
    checksum_status: checksumResult.status,
    checksum_source: checksumResult.source,
    content_readable: checksumResult.contentReadable,
    object_read_status: checksumResult.objectReadStatus,
    object_read_error: checksumResult.objectReadError
  };
  const existing = await module.remote.listEvidence({
    tenant_id: recording.tenant_id,
    business_ref: recording.business_ref,
    limit: 100
  });
  const matched = existing.find(
    (record) =>
      record.session_id === recording.id &&
      record.kind === kind &&
      record.metadata.recording_id === recording.id
  );
  if (matched) {
    const updatedMetadata = {
      ...matched.metadata,
      ...metadata,
      room_name: input.roomName || matched.metadata.room_name || ''
    };
    await pg.query(
      `UPDATE evidence_records
       SET storage_url = $1,
           checksum = CASE WHEN $2 != '' THEN $2 ELSE checksum END,
           metadata = $3,
           retention_until = CASE WHEN $4 IS NOT NULL THEN $4 ELSE retention_until END
       WHERE id = $5`,
      [
        recording.storage_url || matched.storage_url,
        checksumResult.checksum,
        JSON.stringify(updatedMetadata),
        recording.retention_until || null,
        matched.id
      ]
    );
    const refreshed = await module.remote.listEvidence({
      tenant_id: recording.tenant_id,
      business_ref: recording.business_ref,
      limit: 100
    });
    return refreshed.find((record) => record.id === matched.id) || matched;
  }
  return module.remote.recordEvidence({
    tenant_id: recording.tenant_id,
    business_ref: recording.business_ref,
    session_id: recording.id,
    kind,
    storage_url: recording.storage_url,
    checksum: checksumResult.checksum,
    retention_until: recording.retention_until || null,
    created_by: input.createdBy || 'media-core',
    metadata
  });
}

export async function markMediaRecordingEvidenceDeleted(
  pg: PgQueryable,
  recording: EgressRecord,
  input: { deletedBy?: string; deletionSource?: string } = {}
) {
  const module = createCollaborationModule({ pg });
  const evidence = (await module.remote.listEvidenceBySession({
    tenant_id: recording.tenant_id,
    session_id: recording.id,
    limit: 100
  })).find((record) =>
    (record.kind === 'video_recording' || record.kind === 'audio_recording') &&
    record.metadata.recording_id === recording.id
  );
  if (!evidence) return null;

  const metadata = {
    ...evidence.metadata,
    recording_status: 'deleted',
    object_status: 'deleted',
    deleted_at: recording.deleted_at || new Date().toISOString(),
    deleted_by: input.deletedBy || 'media-retention',
    deletion_source: input.deletionSource || ''
  };
  await pg.query(
    `UPDATE evidence_records
     SET metadata = $1
     WHERE id = $2`,
    [JSON.stringify(metadata), evidence.id]
  );
  return (await module.remote.listEvidenceBySession({
    tenant_id: recording.tenant_id,
    session_id: recording.id,
    limit: 100
  })).find((record) => record.id === evidence.id) || evidence;
}

async function resolveEvidenceChecksum(
  recording: EgressRecord,
  input: RecordMediaRecordingEvidenceInput
): Promise<{
  checksum: string;
  status: 'recorded' | 'pending_content_digest';
  source?: string;
  contentReadable?: boolean;
  objectReadStatus?: string;
  objectReadError?: string;
}> {
  if (input.checksum) {
    return {
      checksum: input.checksum,
      status: 'recorded',
      source: 'upstream'
    };
  }
  if (!input.resolveContent) return { checksum: '', status: 'pending_content_digest' };
  try {
    const resolved = await input.resolveContent(recording);
    const contentResult = normalizeContentResult(resolved);
    if (contentResult.content) {
      return {
        checksum: `sha256:${createHash('sha256').update(contentResult.content).digest('hex')}`,
        status: 'recorded',
        source: contentResult.source || 'content_resolver',
        contentReadable: true,
        objectReadStatus: contentResult.objectReadStatus || 'readable'
      };
    }
    return {
      checksum: '',
      status: 'pending_content_digest',
      source: contentResult.source,
      contentReadable: false,
      objectReadStatus: contentResult.objectReadStatus || 'unreadable',
      objectReadError: contentResult.objectReadError
    };
  } catch (error) {
    return {
      checksum: '',
      status: 'pending_content_digest',
      contentReadable: false,
      objectReadStatus: 'resolver_failed',
      objectReadError: (error as Error).message
    };
  }
}

function normalizeContentResult(value: unknown): {
  content?: Buffer;
  source?: string;
  objectReadStatus?: string;
  objectReadError?: string;
} {
  if (value == null) return { objectReadStatus: 'not_found' };
  if (Buffer.isBuffer(value)) return { content: value, source: 'content_resolver', objectReadStatus: 'readable' };
  if (value instanceof Uint8Array) {
    return { content: Buffer.from(value), source: 'content_resolver', objectReadStatus: 'readable' };
  }
  if (typeof value === 'string') {
    return { content: Buffer.from(value), source: 'content_resolver', objectReadStatus: 'readable' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) return { objectReadStatus: 'unsupported_result' };
  const result = value as RecordingObjectContentResult;
  return {
    content: result.content,
    source: result.source || 'content_resolver',
    objectReadStatus: result.status,
    objectReadError: result.error
  };
}
