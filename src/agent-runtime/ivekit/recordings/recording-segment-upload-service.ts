import { createHash } from 'node:crypto';

import type {
  ObjectStorage,
  ObjectStorageCompletedPart
} from '../../../storage/object-storage.js';
import type {
  RecordingMultipartUpload,
  RecordingUploadLease,
  RecordingUploadPart
} from './postgres-recording-manifest-store.js';
import type { RecordingSegment } from './recording-manifest.js';

export interface RecordingSegmentUploadStore {
  assertActiveLease(input: {
    tenant_id: string;
    segment_id: string;
    owner_epoch: string;
    worker_id: string;
    lease_token_hash: string;
    now: Date;
  }): Promise<{ segment: RecordingSegment; lease: RecordingUploadLease }>;
  getMultipartUpload(
    tenantId: string,
    segmentId: string
  ): Promise<RecordingMultipartUpload | null>;
  attachMultipartUpload(input: {
    tenant_id: string;
    segment_id: string;
    upload_id: string;
    object_key: string;
    storage_url: string;
    part_size_bytes: number;
    now: Date;
  }): Promise<{ upload: RecordingMultipartUpload; created: boolean }>;
  recordUploadedPart(input: {
    tenant_id: string;
    segment_id: string;
    part_number: number;
    size_bytes: number;
    sha256: string;
    etag: string;
    now: Date;
  }): Promise<{ part: RecordingUploadPart; created: boolean }>;
  listUploadedParts(
    tenantId: string,
    segmentId: string
  ): Promise<RecordingUploadPart[]>;
  completeSegment(input: {
    tenant_id: string;
    segment_id: string;
    owner_epoch: string;
    worker_id: string;
    lease_token_hash: string;
    size_bytes: number;
    sha256: string;
    object_ref: string;
    now: Date;
  }): Promise<RecordingSegment>;
  markMultipartCompleted(input: {
    tenant_id: string;
    segment_id: string;
    upload_id: string;
    object_key: string;
    now: Date;
  }): Promise<RecordingMultipartUpload>;
}

export class RecordingSegmentUploadError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false
  ) {
    super(code);
    this.name = 'RecordingSegmentUploadError';
  }
}

export class RecordingSegmentUploadService {
  constructor(private readonly input: {
    store: RecordingSegmentUploadStore;
    storage: ObjectStorage;
  }) {}

  async ensureMultipart(input: LeaseIdentity & {
    part_size_bytes: number;
    now: Date;
  }): Promise<RecordingMultipartUpload> {
    const { segment } = await this.input.store.assertActiveLease(input);
    assertSealedSegment(segment);
    const partSize = boundedPartSize(input.part_size_bytes);
    const existing = await this.input.store.getMultipartUpload(
      input.tenant_id,
      input.segment_id
    );
    if (existing) {
      if (existing.part_size_bytes !== partSize || existing.state === 'aborted') {
        throw uploadError('recording_upload_identity_conflict', 409);
      }
      return existing;
    }

    const initiated = await this.input.storage.initiateMultipart({
      tenantId: input.tenant_id,
      contentType: contentType(segment.container),
      keyPrefix: 'recording-segments',
      resourceId: segment.id
    });
    try {
      const attached = await this.input.store.attachMultipartUpload({
        tenant_id: input.tenant_id,
        segment_id: input.segment_id,
        upload_id: initiated.upload_id,
        object_key: initiated.key,
        storage_url: initiated.storage_url,
        part_size_bytes: partSize,
        now: input.now
      });
      return attached.upload;
    } catch (error) {
      await this.input.storage.abortMultipart({
        upload_id: initiated.upload_id,
        key: initiated.key
      }).catch(() => 'not_found');
      const replay = await this.input.store.getMultipartUpload(
        input.tenant_id,
        input.segment_id
      );
      if (replay && replay.part_size_bytes === partSize && replay.state !== 'aborted') {
        return replay;
      }
      throw error;
    }
  }

  async uploadPart(input: LeaseIdentity & {
    part_number: number;
    content: Buffer;
    sha256: string;
    now: Date;
  }): Promise<RecordingUploadPart> {
    const { segment } = await this.input.store.assertActiveLease(input);
    const upload = await requiredUpload(
      this.input.store,
      input.tenant_id,
      input.segment_id
    );
    assertSealedSegment(segment);
    const partNumber = positiveInteger(input.part_number, 'recording_upload_part_number_invalid');
    const expected = expectedPartSize(segment, upload, partNumber);
    if (input.content.length !== expected) {
      throw uploadError('recording_upload_part_size_invalid', 409);
    }
    const sha256 = checksum(input.sha256);
    if (hash(input.content) !== sha256) {
      throw uploadError('recording_upload_part_checksum_invalid', 400);
    }
    const uploaded = await this.input.storage.uploadPart({
      upload_id: upload.upload_id,
      key: upload.object_key,
      part_number: partNumber,
      body: input.content,
      sha256
    });
    if (
      uploaded.part_number !== partNumber ||
      uploaded.size_bytes !== input.content.length ||
      uploaded.sha256 !== sha256
    ) {
      throw uploadError('recording_upload_storage_response_invalid', 502, true);
    }
    return (await this.input.store.recordUploadedPart({
      tenant_id: input.tenant_id,
      segment_id: input.segment_id,
      part_number: partNumber,
      size_bytes: uploaded.size_bytes,
      sha256,
      etag: uploaded.etag,
      now: input.now
    })).part;
  }

  async listParts(input: LeaseIdentity & { now?: Date }): Promise<RecordingUploadPart[]> {
    await this.input.store.assertActiveLease({
      ...input,
      now: input.now ?? new Date()
    });
    return this.input.store.listUploadedParts(input.tenant_id, input.segment_id);
  }

  async complete(input: LeaseIdentity & {
    now: Date;
  }): Promise<{ segment: RecordingSegment; upload: RecordingMultipartUpload }> {
    const { segment: current } = await this.input.store.assertActiveLease(input);
    const upload = await requiredUpload(
      this.input.store,
      input.tenant_id,
      input.segment_id
    );
    assertSealedSegment(current);
    const parts = await this.input.store.listUploadedParts(
      input.tenant_id,
      input.segment_id
    );
    const completedParts = completeParts(current, upload, parts);
    const object = await this.input.storage.completeMultipart({
      upload_id: upload.upload_id,
      key: upload.object_key,
      parts: completedParts,
      size_bytes: current.size_bytes!,
      sha256: current.sha256
    });
    if (object.key !== upload.object_key || object.size_bytes !== current.size_bytes) {
      throw uploadError('recording_upload_storage_response_invalid', 502, true);
    }
    const segment = await this.input.store.completeSegment({
      ...input,
      size_bytes: current.size_bytes!,
      sha256: current.sha256,
      object_ref: `recording-intake://${upload.object_key}`
    });
    const completedUpload = await this.input.store.markMultipartCompleted({
      tenant_id: input.tenant_id,
      segment_id: input.segment_id,
      upload_id: upload.upload_id,
      object_key: upload.object_key,
      now: input.now
    });
    return { segment, upload: completedUpload };
  }
}

interface LeaseIdentity {
  tenant_id: string;
  segment_id: string;
  owner_epoch: string;
  worker_id: string;
  lease_token_hash: string;
}

async function requiredUpload(
  store: RecordingSegmentUploadStore,
  tenantId: string,
  segmentId: string
): Promise<RecordingMultipartUpload> {
  const upload = await store.getMultipartUpload(tenantId, segmentId);
  if (!upload || upload.state === 'aborted') {
    throw uploadError('recording_upload_not_initialized', 409);
  }
  return upload;
}

function assertSealedSegment(segment: RecordingSegment): void {
  if (
    segment.state !== 'uploading' ||
    segment.size_bytes === null ||
    segment.size_bytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(segment.sha256) ||
    segment.ended_at === null
  ) {
    throw uploadError('recording_segment_not_sealed', 409);
  }
}

function expectedPartSize(
  segment: RecordingSegment,
  upload: RecordingMultipartUpload,
  partNumber: number
): number {
  const size = segment.size_bytes!;
  const partCount = Math.ceil(size / upload.part_size_bytes);
  if (partNumber > partCount || partNumber > 10_000) {
    throw uploadError('recording_upload_part_number_invalid', 400);
  }
  return partNumber === partCount
    ? size - upload.part_size_bytes * (partCount - 1)
    : upload.part_size_bytes;
}

function completeParts(
  segment: RecordingSegment,
  upload: RecordingMultipartUpload,
  parts: RecordingUploadPart[]
): ObjectStorageCompletedPart[] {
  const expectedCount = Math.ceil(segment.size_bytes! / upload.part_size_bytes);
  if (parts.length !== expectedCount) {
    throw uploadError('recording_upload_parts_incomplete', 409);
  }
  let total = 0;
  const completed = parts.map((part, index) => {
    const number = index + 1;
    if (
      part.part_number !== number ||
      part.size_bytes !== expectedPartSize(segment, upload, number) ||
      !part.etag ||
      !/^[a-f0-9]{64}$/.test(part.sha256)
    ) {
      throw uploadError('recording_upload_parts_incomplete', 409);
    }
    total += part.size_bytes;
    return {
      part_number: number,
      etag: part.etag,
      sha256: part.sha256
    };
  });
  if (total !== segment.size_bytes) {
    throw uploadError('recording_upload_parts_incomplete', 409);
  }
  return completed;
}

function contentType(container: string): string {
  if (container === 'wav') return 'audio/wav';
  if (container === 'ogg') return 'audio/ogg';
  return 'application/octet-stream';
}

function boundedPartSize(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 512 * 1024 * 1024
  ) {
    throw uploadError('recording_upload_part_size_invalid', 400);
  }
  return value;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw uploadError(code, 400);
  }
  return value;
}

function checksum(value: string): string {
  const normalized = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw uploadError('recording_upload_part_checksum_invalid', 400);
  }
  return normalized;
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function uploadError(
  code: string,
  status: number,
  retryable = false
): RecordingSegmentUploadError {
  return new RecordingSegmentUploadError(code, status, retryable);
}
