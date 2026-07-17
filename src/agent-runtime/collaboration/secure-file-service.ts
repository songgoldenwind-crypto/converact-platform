import { createHash } from 'node:crypto';

import {
  objectStorageKeyFor,
  type ObjectStorage,
  type ObjectStorageUploadResult
} from '../../storage/object-storage.js';
import { SecureFileDerivativeStore } from './secure-file-derivative-store.js';
import {
  SecureFileStore,
  type SecureFileMultipartSession
} from './secure-file-store.js';
import type {
  SecureFile,
  SecureFileDerivative,
  SecureFileKind,
  SecureFilePart,
  SecureFileStatus,
  SecureFileThreatStatus,
  SecureFileUploadMode
} from './secure-file-types.js';

export interface SecureFileDescriptor {
  file_id: string;
  session_id: string;
  created_by: string;
  kind: SecureFileKind;
  filename: string;
  extension: string;
  declared_mime: string;
  detected_mime: string;
  mime_conflict: boolean;
  status: SecureFileStatus;
  threat_status: SecureFileThreatStatus;
  failure_code: string;
  upload_mode: SecureFileUploadMode;
  expected_size_bytes: number;
  received_size_bytes: number;
  part_size_bytes: number;
  size_bytes: number;
  sha256: string;
  scan_attempt_count: number;
  retention_until: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  derivatives: SecureFileDerivativeDescriptor[];
}

export interface SecureFilePartDescriptor {
  part_number: number;
  size_bytes: number;
  sha256: string;
  status: SecureFilePart['status'];
  created_at: string;
  updated_at: string;
}

export interface SecureFileDerivativeDescriptor {
  kind: SecureFileDerivative['derivative_kind'];
  status: SecureFileDerivative['status'];
  mime: string;
  size_bytes: number;
  sha256: string;
  error_code: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SecureFileDownload {
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  content: Buffer;
}

export interface SecureFileServiceInput {
  files: SecureFileStore;
  derivatives: SecureFileDerivativeStore;
  storage: ObjectStorage;
}

export class SecureFileService {
  constructor(private readonly input: SecureFileServiceInput) {}

  async createUpload(input: {
    tenant_id: string;
    session_id: string;
    created_by: string;
    kind: SecureFileKind;
    filename: string;
    declared_mime?: string;
    upload_mode: SecureFileUploadMode;
    expected_size_bytes: number;
    part_size_bytes?: number;
    idempotency_key: string;
    payload_hash: string;
    retention_until?: string | null;
    expires_at?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<SecureFileDescriptor> {
    let file = await this.input.files.createUpload({
      ...input,
      metadata: clientMetadata(input.metadata)
    });
    if (file.upload_mode === 'multipart' && !await this.multipartSession(file)) {
      const created = await this.input.storage.initiateMultipart({
        tenantId: file.tenant_id,
        contentType: uploadContentType(file),
        keyPrefix: 'secure-files',
        resourceId: file.id
      });
      try {
        const attached = await this.input.files.attachMultipartSession({
          tenant_id: file.tenant_id,
          secure_file_id: file.id,
          upload_id: created.upload_id,
          object_key: created.key,
          storage_url: created.storage_url
        });
        file = attached.file;
        if (!attached.attached) {
          await this.input.storage.abortMultipart({ upload_id: created.upload_id, key: created.key });
        }
      } catch (error) {
        await this.input.storage.abortMultipart({ upload_id: created.upload_id, key: created.key })
          .catch(() => undefined);
        throw error;
      }
    }
    return this.describeFile(file);
  }

  async getFile(input: {
    tenant_id: string;
    session_id: string;
    secure_file_id: string;
  }): Promise<SecureFileDescriptor> {
    return this.describeFile(await this.sessionFile(input));
  }

  async uploadPart(input: {
    tenant_id: string;
    session_id: string;
    secure_file_id: string;
    part_number: number;
    content: Buffer;
    sha256: string;
  }): Promise<SecureFilePartDescriptor> {
    const file = await this.sessionFile(input);
    if (file.upload_mode !== 'multipart') {
      throw serviceError('parts are only valid for multipart uploads', 409, 'upload_mode_conflict');
    }
    const content = contentBuffer(input.content);
    const checksum = verifiedChecksum(content, input.sha256);
    assertPartShape(file, input.part_number, content.length);
    const session = await this.requiredMultipartSession(file);
    const reserved = await this.input.files.reservePart({
      tenant_id: file.tenant_id,
      secure_file_id: file.id,
      part_number: input.part_number,
      size_bytes: content.length,
      sha256: checksum,
      object_key: session.object_key
    });
    if (reserved.status === 'uploaded') return publicPart(reserved);
    const uploaded = await this.input.storage.uploadPart({
      upload_id: session.upload_id,
      key: session.object_key,
      part_number: input.part_number,
      body: content,
      sha256: checksum
    });
    const part = await this.input.files.commitPart({
      tenant_id: file.tenant_id,
      secure_file_id: file.id,
      part_number: input.part_number,
      sha256: checksum,
      etag: uploaded.etag
    });
    return publicPart(part);
  }

  async listParts(input: {
    tenant_id: string;
    session_id: string;
    secure_file_id: string;
  }): Promise<SecureFilePartDescriptor[]> {
    await this.sessionFile(input);
    return (await this.input.files.listParts(input.tenant_id, input.secure_file_id)).map(publicPart);
  }

  async completeUpload(input: {
    tenant_id: string;
    session_id: string;
    secure_file_id: string;
    size_bytes: number;
    sha256: string;
  }): Promise<SecureFileDescriptor> {
    let file = await this.sessionFile(input);
    const checksum = checksumValue(input.sha256);
    const size = positiveInteger(input.size_bytes, 'size_bytes');
    if (file.status !== 'initiated' && file.status !== 'uploading') {
      assertCompletedReplay(file, size, checksum);
      if (file.upload_mode === 'multipart') {
        await this.input.files.markPartsCommitted({
          tenant_id: file.tenant_id,
          secure_file_id: file.id
        });
      }
      return this.describeFile(file);
    }
    if (file.upload_mode !== 'multipart') {
      throw serviceError('single uploads complete with their content', 409, 'upload_mode_conflict');
    }
    if (file.expected_size_bytes !== size) {
      throw serviceError('completed size does not match expected size', 409, 'upload_size_conflict');
    }
    const session = await this.requiredMultipartSession(file);
    const parts = await this.input.files.listParts(file.tenant_id, file.id);
    assertCompleteParts(file, parts, size);
    const completed = await this.input.storage.completeMultipart({
      upload_id: session.upload_id,
      key: session.object_key,
      parts: parts.map((part) => ({
        part_number: part.part_number,
        etag: part.etag,
        sha256: part.sha256
      })),
      size_bytes: size,
      sha256: checksum
    });
    assertStoredObject(completed, size);
    file = await this.input.files.completeUpload({
      tenant_id: file.tenant_id,
      secure_file_id: file.id,
      size_bytes: size,
      sha256: checksum,
      object_key: completed.key
    });
    await this.input.files.markPartsCommitted({
      tenant_id: file.tenant_id,
      secure_file_id: file.id
    });
    return this.describeFile(file);
  }

  async uploadContent(input: {
    tenant_id: string;
    session_id: string;
    secure_file_id: string;
    content: Buffer;
    sha256: string;
  }): Promise<SecureFileDescriptor> {
    let file = await this.sessionFile(input);
    if (file.upload_mode !== 'single') {
      throw serviceError('multipart uploads require parts', 409, 'upload_mode_conflict');
    }
    const content = contentBuffer(input.content);
    const checksum = verifiedChecksum(content, input.sha256);
    if (content.length !== file.expected_size_bytes) {
      throw serviceError('uploaded size does not match expected size', 409, 'upload_size_conflict');
    }
    if (file.status !== 'initiated' && file.status !== 'uploading') {
      assertCompletedReplay(file, content.length, checksum);
      return this.describeFile(file);
    }
    if (file.status === 'initiated') {
      file = await this.input.files.beginUpload({
        tenant_id: file.tenant_id,
        secure_file_id: file.id
      });
    }
    const stored = await this.storeSingleContent(file, content, checksum);
    file = await this.input.files.completeUpload({
      tenant_id: file.tenant_id,
      secure_file_id: file.id,
      size_bytes: content.length,
      sha256: checksum,
      object_key: stored.key
    });
    return this.describeFile(file);
  }

  async abortUpload(input: {
    tenant_id: string;
    session_id: string;
    secure_file_id: string;
  }): Promise<SecureFileDescriptor> {
    const file = await this.sessionFile(input);
    if (file.status === 'expired') return this.describeFile(file);
    if (file.status !== 'initiated' && file.status !== 'uploading') {
      throw serviceError('completed secure file cannot be aborted', 409, 'upload_state_conflict');
    }
    if (file.upload_mode === 'multipart') {
      const session = await this.multipartSession(file);
      if (session) {
        await this.input.storage.abortMultipart({
          upload_id: session.upload_id,
          key: session.object_key
        });
      }
    } else {
      await this.input.storage.delete(objectKey(file)).catch((error) => {
        if (errorCode(error) !== 'object_key_invalid') throw error;
      });
    }
    const aborted = await this.input.files.abortUpload({
      tenant_id: file.tenant_id,
      secure_file_id: file.id
    });
    return this.describeFile(aborted);
  }

  async download(input: {
    tenant_id: string;
    session_id: string;
    secure_file_id: string;
  }): Promise<SecureFileDownload> {
    const file = await this.sessionFile(input);
    if (file.status !== 'ready' || file.threat_status !== 'clean') {
      throw serviceError('secure file is not available for download', 409, 'secure_file_not_ready');
    }
    const content = await this.input.storage.download(file.object_key, file.size_bytes);
    if (!content) throw serviceError('secure file object not found', 503, 'secure_file_object_missing');
    if (content.length !== file.size_bytes || sha256(content) !== file.sha256) {
      throw serviceError('secure file object integrity check failed', 503, 'secure_file_integrity_failed');
    }
    return {
      filename: file.filename,
      content_type: file.detected_mime || file.declared_mime || 'application/octet-stream',
      size_bytes: file.size_bytes,
      sha256: file.sha256,
      content
    };
  }

  private async sessionFile(input: {
    tenant_id: string;
    session_id: string;
    secure_file_id: string;
  }): Promise<SecureFile> {
    const file = await this.input.files.getFile(input.tenant_id, input.secure_file_id);
    if (file.session_id !== input.session_id) {
      throw serviceError('secure file not found', 404, 'secure_file_not_found');
    }
    return file;
  }

  private async multipartSession(file: SecureFile): Promise<SecureFileMultipartSession | null> {
    return this.input.files.getMultipartSession(file.tenant_id, file.id);
  }

  private async requiredMultipartSession(file: SecureFile): Promise<SecureFileMultipartSession> {
    const session = await this.multipartSession(file);
    if (!session) {
      throw serviceError('multipart upload session is missing', 503, 'multipart_session_missing');
    }
    return session;
  }

  private async storeSingleContent(
    file: SecureFile,
    content: Buffer,
    checksum: string
  ): Promise<ObjectStorageUploadResult> {
    try {
      return await this.input.storage.upload({
        tenantId: file.tenant_id,
        filename: file.filename,
        body: content,
        contentType: uploadContentType(file),
        keyPrefix: 'secure-files',
        resourceId: file.id
      });
    } catch (error) {
      if (errorCode(error) !== 'object_exists') throw error;
      const key = objectKey(file);
      const existing = await this.input.storage.download(key, content.length);
      if (!existing || existing.length !== content.length || sha256(existing) !== checksum) {
        throw serviceError('existing upload object contains different content', 409, 'upload_object_conflict');
      }
      const head = await this.input.storage.head(key);
      if (!head || head.size_bytes !== content.length) {
        throw serviceError('existing upload object could not be verified', 503, 'upload_object_unverified');
      }
      return { ...head, storage_url: '' };
    }
  }

  private async describeFile(file: SecureFile): Promise<SecureFileDescriptor> {
    const derivatives = await this.input.derivatives.listJobs(file.tenant_id, file.id);
    return {
      file_id: file.id,
      session_id: file.session_id,
      created_by: file.created_by,
      kind: file.kind,
      filename: file.filename,
      extension: file.extension,
      declared_mime: file.declared_mime,
      detected_mime: file.detected_mime,
      mime_conflict: file.mime_conflict,
      status: file.status,
      threat_status: file.threat_status,
      failure_code: file.failure_code,
      upload_mode: file.upload_mode,
      expected_size_bytes: file.expected_size_bytes,
      received_size_bytes: file.received_size_bytes,
      part_size_bytes: file.part_size_bytes,
      size_bytes: file.size_bytes,
      sha256: file.sha256,
      scan_attempt_count: file.scan_attempt_count,
      retention_until: file.retention_until,
      expires_at: file.expires_at,
      created_at: file.created_at,
      updated_at: file.updated_at,
      completed_at: file.completed_at,
      derivatives: derivatives.map(publicDerivative)
    };
  }
}

function publicPart(part: SecureFilePart): SecureFilePartDescriptor {
  return {
    part_number: part.part_number,
    size_bytes: part.size_bytes,
    sha256: part.sha256,
    status: part.status,
    created_at: part.created_at,
    updated_at: part.updated_at
  };
}

function publicDerivative(derivative: SecureFileDerivative): SecureFileDerivativeDescriptor {
  return {
    kind: derivative.derivative_kind,
    status: derivative.status,
    mime: derivative.mime,
    size_bytes: derivative.size_bytes,
    sha256: derivative.sha256,
    error_code: derivative.error_code,
    created_at: derivative.created_at,
    updated_at: derivative.updated_at,
    completed_at: derivative.completed_at
  };
}

function assertPartShape(file: SecureFile, partNumberInput: number, size: number): void {
  const partNumber = positiveInteger(partNumberInput, 'part_number');
  const offset = (partNumber - 1) * file.part_size_bytes;
  if (offset >= file.expected_size_bytes) {
    throw serviceError('part number exceeds upload size', 400, 'upload_part_number_invalid');
  }
  const expected = Math.min(file.part_size_bytes, file.expected_size_bytes - offset);
  if (size !== expected) {
    throw serviceError('part size does not match upload plan', 409, 'upload_part_size_conflict');
  }
}

function assertCompleteParts(file: SecureFile, parts: SecureFilePart[], size: number): void {
  const expectedCount = Math.ceil(file.expected_size_bytes / file.part_size_bytes);
  if (parts.length !== expectedCount) {
    throw serviceError('multipart upload is incomplete', 409, 'upload_parts_incomplete');
  }
  let total = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.part_number !== index + 1 || part.status !== 'uploaded' || !part.etag) {
      throw serviceError('multipart upload is incomplete', 409, 'upload_parts_incomplete');
    }
    assertPartShape(file, part.part_number, part.size_bytes);
    total += part.size_bytes;
  }
  if (total !== size) {
    throw serviceError('uploaded part total does not match completed size', 409, 'upload_part_total_conflict');
  }
}

function assertCompletedReplay(file: SecureFile, size: number, checksum: string): void {
  if (file.size_bytes !== size || file.sha256 !== checksum) {
    throw serviceError(
      'secure file completion was already recorded with different content',
      409,
      'upload_completion_conflict'
    );
  }
}

function assertStoredObject(stored: ObjectStorageUploadResult, expectedSize: number): void {
  if (stored.size_bytes !== expectedSize) {
    throw serviceError('stored object size does not match upload', 503, 'upload_object_unverified');
  }
}

function objectKey(file: SecureFile): string {
  return objectStorageKeyFor({
    tenantId: file.tenant_id,
    keyPrefix: 'secure-files',
    resourceId: file.id
  });
}

function uploadContentType(file: SecureFile): string {
  return file.declared_mime || 'application/octet-stream';
}

function contentBuffer(value: Buffer): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw serviceError('upload content must be a non-empty buffer', 400, 'upload_content_invalid');
  }
  return value;
}

function clientMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  if (Object.hasOwn(value, 'multipart_upload')) {
    throw serviceError('metadata contains a reserved field', 400, 'metadata_reserved_field');
  }
  return value;
}

function verifiedChecksum(content: Buffer, expectedInput: string): string {
  const expected = checksumValue(expectedInput);
  if (sha256(content) !== expected) {
    throw serviceError('upload SHA-256 does not match content', 400, 'upload_checksum_invalid');
  }
  return expected;
}

function checksumValue(value: unknown): string {
  const checksum = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw serviceError('sha256 must be a SHA-256 digest', 400, 'upload_checksum_invalid');
  }
  return checksum;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw serviceError(`${field} must be a positive integer`, 400, `${field}_invalid`);
  }
  return parsed;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown): string {
  return String((error as { code?: unknown })?.code || '');
}

function serviceError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}
