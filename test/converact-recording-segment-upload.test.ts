import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { ObjectStorage } from '../src/storage/object-storage.js';
import {
  RecordingSegmentUploadError,
  RecordingSegmentUploadService,
  type RecordingSegmentUploadStore
} from '../src/agent-runtime/converact/recordings/recording-segment-upload-service.js';
import type {
  RecordingMultipartUpload,
  RecordingUploadLease,
  RecordingUploadPart
} from '../src/agent-runtime/converact/recordings/postgres-recording-manifest-store.js';
import type {
  RecordingSegment
} from '../src/agent-runtime/converact/recordings/recording-manifest.js';

const now = new Date('2026-07-17T04:00:00.000Z');

test('recording segment upload resumes persisted parts and completes the fenced segment', async () => {
  const content = Buffer.from('abcdefghij');
  const store = new MemoryUploadStore(segment(content));
  const storage = new MemoryObjectStorage();
  const service = new RecordingSegmentUploadService({ store, storage });
  const lease = leaseInput();

  const upload = await service.ensureMultipart({
    ...lease,
    part_size_bytes: 6,
    now
  });
  assert.equal(upload.upload_id, 'mpu-a');
  assert.equal((await service.ensureMultipart({
    ...lease,
    part_size_bytes: 6,
    now
  })).upload_id, 'mpu-a');
  assert.equal(storage.initiated, 1);

  await service.uploadPart({
    ...lease,
    part_number: 1,
    content: content.subarray(0, 6),
    sha256: sha(content.subarray(0, 6)),
    now
  });
  assert.deepEqual(
    (await service.listParts(lease)).map((part) => part.part_number),
    [1]
  );
  await service.uploadPart({
    ...lease,
    part_number: 2,
    content: content.subarray(6),
    sha256: sha(content.subarray(6)),
    now
  });
  const completed = await service.complete({ ...lease, now });

  assert.equal(completed.segment.state, 'uploaded');
  assert.equal(completed.upload.state, 'completed');
  assert.equal(completed.segment.object_ref, 'recording-intake://recording-segments/segment-a');
  assert.equal(storage.completed, 1);
});

test('recording segment upload rejects changed bytes before object storage mutation', async () => {
  const content = Buffer.from('abcdefghij');
  const store = new MemoryUploadStore(segment(content));
  const storage = new MemoryObjectStorage();
  const service = new RecordingSegmentUploadService({ store, storage });
  const lease = leaseInput();
  await service.ensureMultipart({ ...lease, part_size_bytes: 6, now });

  await assert.rejects(
    service.uploadPart({
      ...lease,
      part_number: 1,
      content: content.subarray(0, 6),
      sha256: 'f'.repeat(64),
      now
    }),
    (error: unknown) => error instanceof RecordingSegmentUploadError
      && error.code === 'recording_upload_part_checksum_invalid'
  );
  assert.equal(storage.parts.size, 0);
});

function leaseInput() {
  return {
    tenant_id: 'tenant-a',
    segment_id: 'segment-a',
    owner_epoch: '7',
    worker_id: 'rustpbx-sidecar-a',
    lease_token_hash: 'a'.repeat(64)
  };
}

function segment(content: Buffer): RecordingSegment {
  return {
    id: 'segment-a',
    tenant_id: 'tenant-a',
    manifest_id: 'recording-a',
    owner_epoch: '7',
    sequence: 1,
    track_id: 'mixed',
    state: 'uploading',
    container: 'wav',
    codec: 'PCMU',
    started_at: '2026-07-17T03:59:00.000Z',
    ended_at: '2026-07-17T04:00:00.000Z',
    size_bytes: content.length,
    sha256: sha(content),
    local_ref: 'spool://recording-a/segment-a.wav',
    object_ref: '',
    failure_code: '',
    created_at: '2026-07-17T03:59:00.000Z',
    updated_at: '2026-07-17T04:00:00.000Z'
  };
}

function sha(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

class MemoryUploadStore implements RecordingSegmentUploadStore {
  upload: RecordingMultipartUpload | null = null;
  parts: RecordingUploadPart[] = [];
  readonly lease: RecordingUploadLease = {
    tenant_id: 'tenant-a',
    segment_id: 'segment-a',
    worker_id: 'rustpbx-sidecar-a',
    lease_token_hash: 'a'.repeat(64),
    state: 'leased',
    attempt_count: 1,
    max_attempts: 20,
    lease_expires_at: '2026-07-17T04:01:00.000Z',
    next_attempt_at: null,
    last_error_code: '',
    last_error_message: '',
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };

  constructor(readonly segment: RecordingSegment) {}

  async assertActiveLease(): Promise<{ segment: RecordingSegment; lease: RecordingUploadLease }> {
    return { segment: this.segment, lease: this.lease };
  }

  async getMultipartUpload(): Promise<RecordingMultipartUpload | null> {
    return this.upload;
  }

  async attachMultipartUpload(input: {
    tenant_id: string;
    segment_id: string;
    upload_id: string;
    object_key: string;
    storage_url: string;
    part_size_bytes: number;
    now: Date;
  }): Promise<{ upload: RecordingMultipartUpload; created: boolean }> {
    this.upload = {
      tenant_id: input.tenant_id,
      segment_id: input.segment_id,
      upload_id: input.upload_id,
      object_key: input.object_key,
      storage_url: input.storage_url,
      part_size_bytes: input.part_size_bytes,
      state: 'initiated',
      created_at: input.now.toISOString(),
      updated_at: input.now.toISOString(),
      completed_at: null
    };
    return { upload: this.upload, created: true };
  }

  async recordUploadedPart(input: {
    tenant_id: string;
    segment_id: string;
    part_number: number;
    size_bytes: number;
    sha256: string;
    etag: string;
    now: Date;
  }): Promise<{ part: RecordingUploadPart; created: boolean }> {
    const part: RecordingUploadPart = {
      ...input,
      status: 'uploaded',
      created_at: input.now.toISOString(),
      updated_at: input.now.toISOString()
    };
    this.parts.push(part);
    return { part, created: true };
  }

  async listUploadedParts(): Promise<RecordingUploadPart[]> {
    return [...this.parts].sort((left, right) => left.part_number - right.part_number);
  }

  async completeSegment(input: {
    size_bytes: number;
    sha256: string;
    object_ref: string;
  }): Promise<RecordingSegment> {
    Object.assign(this.segment, {
      state: 'uploaded',
      size_bytes: input.size_bytes,
      sha256: input.sha256,
      object_ref: input.object_ref
    });
    return this.segment;
  }

  async markMultipartCompleted(input: {
    now: Date;
  }): Promise<RecordingMultipartUpload> {
    this.upload = {
      ...this.upload!,
      state: 'completed',
      completed_at: input.now.toISOString(),
      updated_at: input.now.toISOString()
    };
    return this.upload;
  }
}

class MemoryObjectStorage implements ObjectStorage {
  initiated = 0;
  completed = 0;
  readonly parts = new Map<number, Buffer>();

  async initiateMultipart() {
    this.initiated += 1;
    return {
      upload_id: 'mpu-a',
      key: 'recording-segments/segment-a',
      storage_url: 's3://recordings/recording-segments/segment-a'
    };
  }

  async uploadPart(input: {
    part_number: number;
    body: Buffer;
    sha256: string;
  }) {
    this.parts.set(input.part_number, Buffer.from(input.body));
    return {
      part_number: input.part_number,
      size_bytes: input.body.length,
      etag: input.sha256,
      sha256: input.sha256
    };
  }

  async completeMultipart(input: {
    key: string;
    size_bytes: number;
    sha256: string;
  }) {
    this.completed += 1;
    return {
      key: input.key,
      storage_url: `s3://recordings/${input.key}`,
      size_bytes: input.size_bytes,
      etag: input.sha256
    };
  }

  async upload(): Promise<never> { throw new Error('not used'); }
  async download(): Promise<null> { return null; }
  async head(): Promise<null> { return null; }
  async delete(): Promise<'not_found'> { return 'not_found'; }
  async abortMultipart(): Promise<'aborted'> { return 'aborted'; }
}
