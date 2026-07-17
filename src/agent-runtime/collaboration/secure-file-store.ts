import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import { MemoryPg, pgId, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import type {
  SecureFile,
  SecureFileKind,
  SecureFilePart,
  SecureFileStatus,
  SecureFileThreatStatus,
  SecureFileUploadMode
} from './secure-file-types.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_PART_BYTES = 512 * 1024 * 1024;

const NEXT_STATUSES: Readonly<Record<SecureFileStatus, readonly SecureFileStatus[]>> = {
  initiated: ['uploading', 'failed', 'expired'],
  uploading: ['scanning', 'failed', 'expired'],
  scanning: ['processing', 'quarantined', 'failed'],
  processing: ['ready', 'failed'],
  ready: ['expired'],
  quarantined: ['expired'],
  failed: ['expired'],
  expired: []
};

interface MemorySecureFileState {
  files: Map<string, SecureFileInternal>;
  parts: Map<string, SecureFilePart>;
}

interface SecureFileInternal extends SecureFile {
  lease_token_hash: string;
  cleanup_attempt_count: number;
  cleanup_next_attempt_at: string | null;
  cleanup_lease_token_hash: string;
  cleanup_lease_until: string | null;
  cleanup_worker_id: string;
  cleanup_error_code: string;
}

const memoryStates = new WeakMap<MemoryPg, MemorySecureFileState>();

export interface SecureFileStoreOptions {
  now?: () => Date;
}

export interface SecureFileScanClaim {
  file: SecureFile;
  claim_token: string;
}

export type SecureFileScanOutcome =
  | 'clean'
  | 'infected'
  | 'quarantined'
  | 'retry_wait'
  | 'failed';

export interface SecureFileCleanupClaim {
  file: SecureFile;
  claim_token: string;
  cleanup_attempt_count: number;
}

export interface SecureFileMultipartSession {
  upload_id: string;
  object_key: string;
  storage_url: string;
}

export class SecureFileStore {
  private readonly now: () => Date;

  constructor(
    private readonly pg: PgQueryable,
    options: SecureFileStoreOptions = {}
  ) {
    this.now = options.now || (() => new Date());
  }

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
  }): Promise<SecureFile> {
    const normalized = normalizeCreateInput(input);
    if (this.pg instanceof MemoryPg) return this.createUploadMemory(normalized);

    return withPgTenant(this.pg, normalized.tenant_id, async (pg) => {
      const existing = await fileByIdempotencyKey(
        pg,
        normalized.tenant_id,
        normalized.session_id,
        normalized.idempotency_key
      );
      if (existing) return assertIdempotentCreate(existing, normalized.payload_hash);

      const id = pgId('sfile');
      const result = await pg.query(
        `INSERT INTO collaboration_secure_files
          (id, tenant_id, session_id, created_by, kind, filename, extension,
           declared_mime, upload_mode, expected_size_bytes, part_size_bytes,
           idempotency_key, payload_hash, retention_until, expires_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14::TIMESTAMPTZ, $15::TIMESTAMPTZ, $16::JSONB)
         ON CONFLICT (tenant_id, session_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          id, normalized.tenant_id, normalized.session_id, normalized.created_by,
          normalized.kind, normalized.filename, normalized.extension, normalized.declared_mime,
          normalized.upload_mode, normalized.expected_size_bytes, normalized.part_size_bytes,
          normalized.idempotency_key, normalized.payload_hash, normalized.retention_until,
          normalized.expires_at, JSON.stringify(normalized.metadata)
        ]
      );
      if (result.rows[0]) return decodeFile(result.rows[0]);
      const replay = await fileByIdempotencyKey(
        pg,
        normalized.tenant_id,
        normalized.session_id,
        normalized.idempotency_key
      );
      if (!replay) throw secureFileError('secure file upload could not be created', 503, 'upload_create_failed');
      return assertIdempotentCreate(replay, normalized.payload_hash);
    });
  }

  async getFile(tenantIdInput: string, secureFileIdInput: string): Promise<SecureFile> {
    const tenantId = requiredText(tenantIdInput, 'tenant_id');
    const secureFileId = requiredText(secureFileIdInput, 'secure_file_id');
    if (this.pg instanceof MemoryPg) return this.memoryFile(tenantId, secureFileId);
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query(
        'SELECT * FROM collaboration_secure_files WHERE tenant_id = $1 AND id = $2',
        [tenantId, secureFileId]
      );
      if (!result.rows[0]) throw secureFileError('secure file not found', 404, 'secure_file_not_found');
      return decodeFile(result.rows[0]);
    });
  }

  async listFilesByStatus(input: {
    tenant_id: string;
    status: SecureFileStatus;
    limit?: number;
  }): Promise<SecureFile[]> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const status = secureFileStatus(input.status);
    const limit = boundedInteger(input.limit ?? 100, 1, 1_000, 'limit');
    if (this.pg instanceof MemoryPg) {
      return [...memoryState(this.pg).files.values()]
        .filter((file) => file.tenant_id === tenantId && file.status === status)
        .sort((left, right) =>
          left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id)
        )
        .slice(0, limit)
        .map(cloneFile);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM collaboration_secure_files
         WHERE tenant_id = $1 AND status = $2
         ORDER BY updated_at, id LIMIT $3`,
        [tenantId, status, limit]
      );
      return result.rows.map(decodeFile);
    });
  }

  async listRustDeskEvidenceIntelligenceCandidates(input: {
    limit?: number;
  } = {}): Promise<SecureFile[]> {
    const limit = boundedInteger(input.limit ?? 25, 1, 100, 'limit');
    if (this.pg instanceof MemoryPg) {
      return [...memoryState(this.pg).files.values()]
        .filter((file) =>
          file.status === 'ready' &&
          file.threat_status === 'clean' &&
          file.metadata.source === 'rustdesk_companion_evidence' &&
          !file.metadata.rustdesk_intelligence_reconciliation
        )
        .sort((left, right) =>
          left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id)
        )
        .slice(0, limit)
        .map(cloneFile);
    }
    const candidates = await this.pg.query<{ tenant_id: string; secure_file_id: string }>(
      'SELECT tenant_id, secure_file_id FROM opc_rustdesk_evidence_intelligence_candidates($1)',
      [limit]
    );
    const files: SecureFile[] = [];
    for (const candidate of candidates.rows) {
      files.push(await this.getFile(candidate.tenant_id, candidate.secure_file_id));
    }
    return files;
  }

  async markRustDeskEvidenceIntelligenceReconciled(input: {
    tenant_id: string;
    secure_file_id: string;
    status: 'ignored' | 'unsupported';
    reason: string;
  }): Promise<void> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const secureFileId = requiredText(input.secure_file_id, 'secure_file_id');
    const reason = requiredText(input.reason, 'reason');
    const marker = {
      status: input.status,
      reason,
      completed_at: new Date().toISOString()
    };
    if (this.pg instanceof MemoryPg) {
      const file = memoryState(this.pg).files.get(secureFileId);
      if (!file || file.tenant_id !== tenantId) {
        throw secureFileError('secure file not found', 404, 'secure_file_not_found');
      }
      file.metadata = { ...file.metadata, rustdesk_intelligence_reconciliation: marker };
      file.updated_at = marker.completed_at;
      return;
    }
    await withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query(
        `UPDATE collaboration_secure_files
         SET metadata = metadata || jsonb_build_object(
           'rustdesk_intelligence_reconciliation', $3::JSONB
         ), updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING id`,
        [tenantId, secureFileId, JSON.stringify(marker)]
      );
      if (!result.rows[0]) {
        throw secureFileError('secure file not found', 404, 'secure_file_not_found');
      }
    });
  }

  async beginUpload(input: { tenant_id: string; secure_file_id: string }): Promise<SecureFile> {
    return this.transitionStatus({
      tenant_id: input.tenant_id,
      secure_file_id: input.secure_file_id,
      from_status: 'initiated',
      to_status: 'uploading'
    });
  }

  async attachMultipartSession(input: {
    tenant_id: string;
    secure_file_id: string;
    upload_id: string;
    object_key: string;
    storage_url: string;
  }): Promise<{ file: SecureFile; attached: boolean }> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const secureFileId = requiredText(input.secure_file_id, 'secure_file_id');
    const identity = {
      upload_id: boundedSingleLine(input.upload_id, 'upload_id', 512),
      object_key: objectKeyValue(input.object_key),
      storage_url: boundedSingleLine(input.storage_url, 'storage_url', 2_048)
    };
    if (this.pg instanceof MemoryPg) {
      const file = this.memoryFile(tenantId, secureFileId, false);
      const existing = multipartIdentity(file.metadata);
      if (existing) return { file: cloneFile(file), attached: false };
      assertMultipartUploadable(file);
      file.metadata = { ...file.metadata, multipart_upload: identity };
      file.updated_at = this.now().toISOString();
      return { file: cloneFile(file), attached: true };
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const file = await lockFile(pg, tenantId, secureFileId);
      if (multipartIdentity(file.metadata)) return { file, attached: false };
      assertMultipartUploadable(file);
      const metadata = { ...file.metadata, multipart_upload: identity };
      const result = await pg.query(
        `UPDATE collaboration_secure_files
         SET metadata = $3::JSONB, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tenantId, secureFileId, JSON.stringify(metadata), await databaseNow(pg)]
      );
      return { file: decodeFile(result.rows[0]), attached: true };
    });
  }

  async getMultipartSession(
    tenantIdInput: string,
    secureFileIdInput: string
  ): Promise<SecureFileMultipartSession | null> {
    const file = await this.getFile(tenantIdInput, secureFileIdInput);
    return multipartIdentity(file.metadata);
  }

  async reservePart(input: {
    tenant_id: string;
    secure_file_id: string;
    part_number: number;
    size_bytes: number;
    sha256: string;
    object_key: string;
  }): Promise<SecureFilePart> {
    const normalized = normalizePartInput(input);
    if (this.pg instanceof MemoryPg) {
      const file = this.memoryFile(normalized.tenant_id, normalized.secure_file_id, false);
      assertMultipartUploadable(file);
      const state = memoryState(this.pg);
      const key = partKey(normalized.tenant_id, normalized.secure_file_id, normalized.part_number);
      const existing = state.parts.get(key);
      if (existing) return assertReservedPart(existing, normalized);
      const now = this.now().toISOString();
      const part: SecureFilePart = {
        tenant_id: normalized.tenant_id,
        session_id: file.session_id,
        secure_file_id: file.id,
        part_number: normalized.part_number,
        size_bytes: normalized.size_bytes,
        sha256: normalized.sha256,
        object_key: normalized.object_key,
        etag: '',
        status: 'staged',
        created_at: now,
        updated_at: now
      };
      state.parts.set(key, part);
      if (file.status === 'initiated') file.status = 'uploading';
      file.updated_at = now;
      return clonePart(part);
    }
    return withPgTenant(this.pg, normalized.tenant_id, async (pg) => {
      const file = await lockFile(pg, normalized.tenant_id, normalized.secure_file_id);
      assertMultipartUploadable(file);
      const existing = await pg.query(
        `SELECT * FROM collaboration_secure_file_parts
         WHERE tenant_id = $1 AND secure_file_id = $2 AND part_number = $3`,
        [normalized.tenant_id, normalized.secure_file_id, normalized.part_number]
      );
      if (existing.rows[0]) return assertReservedPart(decodePart(existing.rows[0]), normalized);
      const now = await databaseNow(pg);
      const inserted = await pg.query(
        `INSERT INTO collaboration_secure_file_parts
          (tenant_id, session_id, secure_file_id, part_number, size_bytes,
           sha256, object_key, etag, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '', 'staged', $8, $8)
         ON CONFLICT (tenant_id, secure_file_id, part_number) DO NOTHING
         RETURNING *`,
        [
          normalized.tenant_id, file.session_id, file.id, normalized.part_number,
          normalized.size_bytes, normalized.sha256, normalized.object_key, now
        ]
      );
      const part = inserted.rows[0]
        ? decodePart(inserted.rows[0])
        : await selectAndAssertReservedPart(pg, normalized);
      await pg.query(
        `UPDATE collaboration_secure_files
         SET status = CASE WHEN status = 'initiated' THEN 'uploading' ELSE status END,
             updated_at = $3
         WHERE tenant_id = $1 AND id = $2`,
        [normalized.tenant_id, normalized.secure_file_id, now]
      );
      return part;
    });
  }

  async commitPart(input: {
    tenant_id: string;
    secure_file_id: string;
    part_number: number;
    sha256: string;
    etag: string;
  }): Promise<SecureFilePart> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const secureFileId = requiredText(input.secure_file_id, 'secure_file_id');
    const partNumber = boundedInteger(input.part_number, 1, MAX_PARTS, 'part_number');
    const checksum = sha256Value(input.sha256, 'sha256');
    const etag = boundedSingleLine(input.etag, 'etag', 255);
    if (this.pg instanceof MemoryPg) {
      const file = this.memoryFile(tenantId, secureFileId, false);
      assertMultipartUploadable(file);
      const part = memoryState(this.pg).parts.get(partKey(tenantId, secureFileId, partNumber));
      if (!part) throw secureFileError('secure file part not found', 404, 'secure_file_part_not_found');
      if (part.sha256 !== checksum || (part.status !== 'staged' && part.status !== 'uploaded')) {
        throw secureFileError('secure file part changed', 409, 'secure_file_part_conflict');
      }
      if (part.status === 'uploaded' && part.etag !== etag) {
        throw secureFileError('secure file part ETag changed', 409, 'secure_file_part_conflict');
      }
      const now = this.now().toISOString();
      part.status = 'uploaded';
      part.etag = etag;
      part.updated_at = now;
      updateMemoryReceivedSize(this.pg, file, now);
      return clonePart(part);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const file = await lockFile(pg, tenantId, secureFileId);
      assertMultipartUploadable(file);
      const now = await databaseNow(pg);
      const result = await pg.query(
        `UPDATE collaboration_secure_file_parts
         SET status = 'uploaded', etag = $5, updated_at = $6
         WHERE tenant_id = $1 AND secure_file_id = $2 AND part_number = $3
           AND sha256 = $4
           AND (status = 'staged' OR (status = 'uploaded' AND etag = $5))
         RETURNING *`,
        [tenantId, secureFileId, partNumber, checksum, etag, now]
      );
      if (!result.rows[0]) {
        throw secureFileError('secure file part changed', 409, 'secure_file_part_conflict');
      }
      await updateDatabaseReceivedSize(pg, tenantId, secureFileId, now);
      return decodePart(result.rows[0]);
    });
  }

  async markPartsCommitted(input: {
    tenant_id: string;
    secure_file_id: string;
  }): Promise<SecureFilePart[]> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const secureFileId = requiredText(input.secure_file_id, 'secure_file_id');
    const file = await this.getFile(tenantId, secureFileId);
    if (file.upload_mode !== 'multipart') return [];
    if (file.status === 'initiated' || file.status === 'uploading') {
      throw secureFileError('secure file upload is not complete', 409, 'upload_state_conflict');
    }
    if (this.pg instanceof MemoryPg) {
      const now = this.now().toISOString();
      for (const part of memoryState(this.pg).parts.values()) {
        if (part.tenant_id !== tenantId || part.secure_file_id !== secureFileId) continue;
        if (part.status === 'uploaded') {
          part.status = 'committed';
          part.updated_at = now;
        }
      }
      return this.listParts(tenantId, secureFileId);
    }
    await withPgTenant(this.pg, tenantId, async (pg) => {
      await pg.query(
        `UPDATE collaboration_secure_file_parts
         SET status = 'committed', updated_at = $3
         WHERE tenant_id = $1 AND secure_file_id = $2 AND status = 'uploaded'`,
        [tenantId, secureFileId, await databaseNow(pg)]
      );
    });
    return this.listParts(tenantId, secureFileId);
  }

  async abortUpload(input: {
    tenant_id: string;
    secure_file_id: string;
  }): Promise<SecureFile> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const secureFileId = requiredText(input.secure_file_id, 'secure_file_id');
    if (this.pg instanceof MemoryPg) {
      const file = this.memoryFile(tenantId, secureFileId, false);
      if (file.status === 'expired') return cloneFile(file);
      if (file.status !== 'initiated' && file.status !== 'uploading') {
        throw secureFileError('completed secure file cannot be aborted', 409, 'upload_state_conflict');
      }
      const now = this.now().toISOString();
      file.status = 'expired';
      file.updated_at = now;
      for (const part of memoryState(this.pg).parts.values()) {
        if (part.tenant_id === tenantId && part.secure_file_id === secureFileId) {
          part.status = 'aborted';
          part.updated_at = now;
        }
      }
      return cloneFile(file);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const file = await lockFile(pg, tenantId, secureFileId);
      if (file.status === 'expired') return file;
      if (file.status !== 'initiated' && file.status !== 'uploading') {
        throw secureFileError('completed secure file cannot be aborted', 409, 'upload_state_conflict');
      }
      const now = await databaseNow(pg);
      await pg.query(
        `UPDATE collaboration_secure_file_parts
         SET status = 'aborted', updated_at = $3
         WHERE tenant_id = $1 AND secure_file_id = $2`,
        [tenantId, secureFileId, now]
      );
      const result = await pg.query(
        `UPDATE collaboration_secure_files
         SET status = 'expired', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status IN ('initiated', 'uploading')
         RETURNING *`,
        [tenantId, secureFileId, now]
      );
      if (!result.rows[0]) {
        throw secureFileError('secure file upload state changed', 409, 'upload_state_conflict');
      }
      return decodeFile(result.rows[0]);
    });
  }

  async recordPart(input: {
    tenant_id: string;
    secure_file_id: string;
    part_number: number;
    size_bytes: number;
    sha256: string;
    object_key: string;
    etag?: string;
  }): Promise<SecureFilePart> {
    const normalized = normalizePartInput(input);
    if (this.pg instanceof MemoryPg) return this.recordPartMemory(normalized);

    return withPgTenant(this.pg, normalized.tenant_id, async (pg) => {
      const file = await lockFile(pg, normalized.tenant_id, normalized.secure_file_id);
      assertMultipartUploadable(file);
      const existing = await pg.query(
        `SELECT * FROM collaboration_secure_file_parts
         WHERE tenant_id = $1 AND secure_file_id = $2 AND part_number = $3`,
        [normalized.tenant_id, normalized.secure_file_id, normalized.part_number]
      );
      if (existing.rows[0]) return assertIdempotentPart(decodePart(existing.rows[0]), normalized);
      const now = await databaseNow(pg);
      const result = await pg.query(
        `INSERT INTO collaboration_secure_file_parts
          (tenant_id, session_id, secure_file_id, part_number, size_bytes,
           sha256, object_key, etag, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'uploaded', $9, $9)
         ON CONFLICT (tenant_id, secure_file_id, part_number) DO NOTHING
         RETURNING *`,
        [
          normalized.tenant_id, file.session_id, file.id, normalized.part_number,
          normalized.size_bytes, normalized.sha256, normalized.object_key,
          normalized.etag, now
        ]
      );
      const part = result.rows[0]
        ? decodePart(result.rows[0])
        : await selectAndAssertPart(pg, normalized);
      await pg.query(
        `UPDATE collaboration_secure_files file
         SET status = CASE WHEN status = 'initiated' THEN 'uploading' ELSE status END,
             received_size_bytes = parts.received_size_bytes,
             updated_at = $3
         FROM (
           SELECT COALESCE(SUM(size_bytes), 0) AS received_size_bytes
           FROM collaboration_secure_file_parts
           WHERE tenant_id = $1 AND secure_file_id = $2 AND status = 'uploaded'
         ) parts
         WHERE file.tenant_id = $1 AND file.id = $2`,
        [normalized.tenant_id, normalized.secure_file_id, now]
      );
      return part;
    });
  }

  async listParts(tenantIdInput: string, secureFileIdInput: string): Promise<SecureFilePart[]> {
    const tenantId = requiredText(tenantIdInput, 'tenant_id');
    const secureFileId = requiredText(secureFileIdInput, 'secure_file_id');
    if (this.pg instanceof MemoryPg) {
      this.memoryFile(tenantId, secureFileId);
      return [...memoryState(this.pg).parts.values()]
        .filter((part) => part.tenant_id === tenantId && part.secure_file_id === secureFileId)
        .sort((left, right) => left.part_number - right.part_number)
        .map(clonePart);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      await lockFile(pg, tenantId, secureFileId, false);
      const result = await pg.query(
        `SELECT * FROM collaboration_secure_file_parts
         WHERE tenant_id = $1 AND secure_file_id = $2 ORDER BY part_number`,
        [tenantId, secureFileId]
      );
      return result.rows.map(decodePart);
    });
  }

  async completeUpload(input: {
    tenant_id: string;
    secure_file_id: string;
    size_bytes: number;
    sha256: string;
    object_key: string;
  }): Promise<SecureFile> {
    const normalized = normalizeCompleteInput(input);
    if (this.pg instanceof MemoryPg) return this.completeUploadMemory(normalized);

    return withPgTenant(this.pg, normalized.tenant_id, async (pg) => {
      const file = await lockFile(pg, normalized.tenant_id, normalized.secure_file_id);
      const replay = completedReplay(file, normalized);
      if (replay) return replay;
      assertCompletable(file, normalized);
      if (file.upload_mode === 'multipart') {
        const total = await pg.query<{ received_size_bytes: string | number }>(
          `SELECT COALESCE(SUM(size_bytes), 0) AS received_size_bytes
           FROM collaboration_secure_file_parts
           WHERE tenant_id = $1 AND secure_file_id = $2 AND status = 'uploaded'`,
          [normalized.tenant_id, normalized.secure_file_id]
        );
        assertReceivedSize(Number(total.rows[0]?.received_size_bytes || 0), normalized.size_bytes);
      }
      const now = await databaseNow(pg);
      const result = await pg.query(
        `UPDATE collaboration_secure_files
         SET status = 'scanning', threat_status = 'pending', object_key = $3,
             size_bytes = $4, received_size_bytes = $4, sha256 = $5,
             completed_at = $6, updated_at = $6
         WHERE tenant_id = $1 AND id = $2 AND status = 'uploading'
         RETURNING *`,
        [
          normalized.tenant_id, normalized.secure_file_id, normalized.object_key,
          normalized.size_bytes, normalized.sha256, now
        ]
      );
      if (!result.rows[0]) throw secureFileError('secure file upload state changed', 409, 'upload_state_conflict');
      return decodeFile(result.rows[0]);
    });
  }

  async transitionStatus(input: {
    tenant_id: string;
    secure_file_id: string;
    from_status: SecureFileStatus;
    to_status: SecureFileStatus;
    threat_status?: SecureFileThreatStatus;
    detected_mime?: string;
    mime_conflict?: boolean;
    failure_code?: string;
  }): Promise<SecureFile> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const secureFileId = requiredText(input.secure_file_id, 'secure_file_id');
    const fromStatus = secureFileStatus(input.from_status);
    const toStatus = secureFileStatus(input.to_status);
    assertSecureFileStatusTransition(fromStatus, toStatus);
    const threatStatus = input.threat_status == null
      ? undefined
      : secureFileThreatStatus(input.threat_status);
    const detectedMime = input.detected_mime == null ? undefined : mimeText(input.detected_mime);
    const failureCode = safeCode(input.failure_code);

    if (this.pg instanceof MemoryPg) {
      const file = this.memoryFile(tenantId, secureFileId, false);
      return transitionLockedFile(file, {
        fromStatus, toStatus, threatStatus, detectedMime,
        mimeConflict: input.mime_conflict, failureCode, now: this.now().toISOString()
      });
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const file = await lockFile(pg, tenantId, secureFileId);
      if (file.status === toStatus) return file;
      if (file.status !== fromStatus) {
        throw secureFileError('secure file status changed', 409, 'secure_file_status_conflict');
      }
      const next = transitionLockedFile(cloneFile(file), {
        fromStatus, toStatus, threatStatus, detectedMime,
        mimeConflict: input.mime_conflict, failureCode, now: await databaseNow(pg)
      });
      const result = await pg.query(
        `UPDATE collaboration_secure_files
         SET status = $3, threat_status = $4, detected_mime = $5,
             mime_conflict = $6, failure_code = $7, updated_at = $8
         WHERE tenant_id = $1 AND id = $2 AND status = $9
         RETURNING *`,
        [
          tenantId, secureFileId, next.status, next.threat_status, next.detected_mime,
          next.mime_conflict, next.failure_code, next.updated_at, fromStatus
        ]
      );
      if (!result.rows[0]) throw secureFileError('secure file status changed', 409, 'secure_file_status_conflict');
      return decodeFile(result.rows[0]);
    });
  }

  async discoverScanTenantIds(input: { limit?: number } = {}): Promise<string[]> {
    const limit = boundedInteger(input.limit ?? 100, 1, 1_000, 'limit');
    const now = this.now().toISOString();
    if (this.pg instanceof MemoryPg) {
      return [...new Set(
        [...memoryState(this.pg).files.values()]
          .filter((file) => scanFileIsDue(file, now))
          .map((file) => file.tenant_id)
      )].sort().slice(0, limit);
    }
    const result = await this.pg.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM opc_secure_file_worker_tenant_ids($1::TIMESTAMPTZ, $2)',
      [now, limit]
    );
    return result.rows.map((row) => String(row.tenant_id)).filter(Boolean);
  }

  async claimScanJobs(input: {
    tenant_id: string;
    worker_id: string;
    limit?: number;
    lease_ms?: number;
    max_attempts?: number;
  }): Promise<SecureFileScanClaim[]> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const workerId = boundedSingleLine(input.worker_id, 'worker_id', 255);
    const limit = boundedInteger(input.limit ?? 25, 1, 100, 'limit');
    const leaseMs = boundedInteger(input.lease_ms ?? 60_000, 5_000, 600_000, 'lease_ms');
    const maxAttempts = boundedInteger(input.max_attempts ?? 3, 1, 10, 'max_attempts');
    if (this.pg instanceof MemoryPg) {
      return this.claimScanJobsMemory(tenantId, workerId, limit, leaseMs, maxAttempts);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const now = await databaseNow(pg);
      await pg.query(
        `UPDATE collaboration_secure_files
         SET status = 'failed', threat_status = 'error',
             failure_code = 'scan_attempts_exhausted', lease_token_hash = '',
             lease_until = NULL, worker_id = '', next_attempt_at = NULL, updated_at = $2
         WHERE tenant_id = $1 AND status = 'scanning'
           AND scan_attempt_count >= $3
           AND lease_until IS NOT NULL AND lease_until <= $2`,
        [tenantId, now, maxAttempts]
      );
      const claims: SecureFileScanClaim[] = [];
      for (let index = 0; index < limit; index += 1) {
        const claimToken = randomUUID();
        const tokenHash = sha256Text(claimToken);
        const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
        const result = await pg.query(
          `WITH candidate AS (
             SELECT id
             FROM collaboration_secure_files
             WHERE tenant_id = $1 AND status = 'scanning'
               AND scan_attempt_count < $6
               AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
               AND (lease_until IS NULL OR lease_until <= $2)
             ORDER BY COALESCE(next_attempt_at, updated_at), updated_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE collaboration_secure_files file
           SET threat_status = 'scanning', scan_attempt_count = scan_attempt_count + 1,
               worker_id = $3, lease_token_hash = $4, lease_until = $5,
               next_attempt_at = NULL, failure_code = '', updated_at = $2
           FROM candidate
           WHERE file.tenant_id = $1 AND file.id = candidate.id
           RETURNING file.*`,
          [tenantId, now, workerId, tokenHash, leaseUntil, maxAttempts]
        );
        if (!result.rows[0]) break;
        claims.push({ file: decodeFile(result.rows[0]), claim_token: claimToken });
      }
      return claims;
    });
  }

  async finishScanJob(input: {
    tenant_id: string;
    secure_file_id: string;
    worker_id: string;
    claim_token: string;
    outcome: SecureFileScanOutcome;
    detected_mime?: string;
    mime_conflict?: boolean;
    failure_code?: string;
    next_attempt_at?: string | null;
    scanner_name?: string;
    scanner_mode?: string;
    scanner_request_id?: string;
    scan_metadata?: Record<string, unknown>;
  }): Promise<SecureFile> {
    const normalized = normalizeScanFinishInput(input);
    if (this.pg instanceof MemoryPg) return this.finishScanJobMemory(normalized);
    return withPgTenant(this.pg, normalized.tenant_id, async (pg) => {
      const now = await databaseNow(pg);
      const next = scanOutcomeFields(normalized, now);
      const result = await pg.query(
        `UPDATE collaboration_secure_files
         SET status = $6, threat_status = $7, detected_mime = $8,
             mime_conflict = $9, failure_code = $10,
             scanner_name = $11, scanner_mode = $12, scanner_request_id = $13,
             scan_metadata = $14::JSONB, next_attempt_at = $15::TIMESTAMPTZ,
             lease_token_hash = '', lease_until = NULL, worker_id = '', updated_at = $5
         WHERE tenant_id = $1 AND id = $2 AND status = 'scanning'
           AND worker_id = $3 AND lease_token_hash = $4 AND lease_until > $5
         RETURNING *`,
        [
          normalized.tenant_id, normalized.secure_file_id, normalized.worker_id,
          normalized.claim_token_hash, now, next.status, next.threat_status,
          next.detected_mime, next.mime_conflict, next.failure_code,
          normalized.scanner_name, normalized.scanner_mode, normalized.scanner_request_id,
          JSON.stringify(normalized.scan_metadata), next.next_attempt_at
        ]
      );
      if (result.rows[0]) return decodeFile(result.rows[0]);
      const existing = await pg.query(
        'SELECT id FROM collaboration_secure_files WHERE tenant_id = $1 AND id = $2',
        [normalized.tenant_id, normalized.secure_file_id]
      );
      if (!existing.rows[0]) throw secureFileError('secure file not found', 404, 'secure_file_not_found');
      throw secureFileError('secure file scan claim is stale', 409, 'secure_file_scan_claim_stale');
    });
  }

  async discoverCleanupTenantIds(input: {
    upload_stale_ms?: number;
    limit?: number;
  } = {}): Promise<string[]> {
    const uploadStaleMs = boundedInteger(
      input.upload_stale_ms ?? 24 * 60 * 60_000,
      60_000,
      30 * 24 * 60 * 60_000,
      'upload_stale_ms'
    );
    const limit = boundedInteger(input.limit ?? 100, 1, 1_000, 'limit');
    const now = this.now();
    const staleBefore = new Date(now.getTime() - uploadStaleMs).toISOString();
    const nowIso = now.toISOString();
    if (this.pg instanceof MemoryPg) {
      return [...new Set(
        [...memoryState(this.pg).files.values()]
          .filter((file) => cleanupFileIsDue(file, nowIso, staleBefore))
          .map((file) => file.tenant_id)
      )].sort().slice(0, limit);
    }
    const result = await this.pg.query<{ tenant_id: string }>(
      `SELECT tenant_id
       FROM opc_secure_file_cleanup_worker_tenant_ids(
         $1::TIMESTAMPTZ, $2::TIMESTAMPTZ, $3
       )`,
      [nowIso, staleBefore, limit]
    );
    return result.rows.map((row) => String(row.tenant_id)).filter(Boolean);
  }

  async listCleanupCandidates(input: {
    tenant_id: string;
    upload_stale_ms?: number;
    limit?: number;
  }): Promise<SecureFile[]> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const uploadStaleMs = boundedInteger(
      input.upload_stale_ms ?? 24 * 60 * 60_000,
      60_000,
      30 * 24 * 60 * 60_000,
      'upload_stale_ms'
    );
    const limit = boundedInteger(input.limit ?? 100, 1, 1_000, 'limit');
    const now = this.now();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - uploadStaleMs).toISOString();
    if (this.pg instanceof MemoryPg) {
      return [...memoryState(this.pg).files.values()]
        .filter((file) => file.tenant_id === tenantId && cleanupFileIsDue(file, nowIso, staleBefore))
        .sort((left, right) =>
          left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id)
        )
        .slice(0, limit)
        .map(cloneFile);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM collaboration_secure_files
         WHERE tenant_id = $1
           AND status IN ('initiated', 'uploading', 'ready', 'quarantined', 'failed')
           AND NOT EXISTS (
             SELECT 1 FROM ivekit_legal_holds hold
             WHERE hold.tenant_id = collaboration_secure_files.tenant_id
               AND hold.category = 'secure_files'
               AND hold.resource_type = 'secure_file'
               AND hold.resource_id = collaboration_secure_files.id
               AND hold.status = 'active'
           )
           AND (cleanup_next_attempt_at IS NULL OR cleanup_next_attempt_at <= $2)
           AND (cleanup_lease_until IS NULL OR cleanup_lease_until <= $2)
           AND (
             (expires_at IS NOT NULL AND expires_at <= $2) OR
             (status IN ('initiated', 'uploading') AND updated_at <= $3) OR
             (
               status IN ('ready', 'quarantined', 'failed') AND
               retention_until IS NOT NULL AND retention_until <= $2
             )
           )
         ORDER BY updated_at, id LIMIT $4`,
        [tenantId, nowIso, staleBefore, limit]
      );
      return result.rows.map(decodeFile);
    });
  }

  async claimCleanupJobs(input: {
    tenant_id: string;
    worker_id: string;
    upload_stale_ms?: number;
    limit?: number;
    lease_ms?: number;
  }): Promise<SecureFileCleanupClaim[]> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const workerId = boundedSingleLine(input.worker_id, 'worker_id', 255);
    const uploadStaleMs = boundedInteger(
      input.upload_stale_ms ?? 24 * 60 * 60_000,
      60_000,
      30 * 24 * 60 * 60_000,
      'upload_stale_ms'
    );
    const limit = boundedInteger(input.limit ?? 25, 1, 100, 'limit');
    const leaseMs = boundedInteger(input.lease_ms ?? 120_000, 5_000, 30 * 60_000, 'lease_ms');
    const now = this.now();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - uploadStaleMs).toISOString();
    if (this.pg instanceof MemoryPg) {
      const candidates = [...memoryState(this.pg).files.values()]
        .filter((file) => file.tenant_id === tenantId && cleanupFileIsDue(file, nowIso, staleBefore))
        .sort((left, right) =>
          left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id)
        );
      const claims: SecureFileCleanupClaim[] = [];
      for (const file of candidates.slice(0, limit)) {
        const claimToken = randomUUID();
        file.cleanup_attempt_count += 1;
        file.cleanup_worker_id = workerId;
        file.cleanup_lease_token_hash = sha256Text(claimToken);
        file.cleanup_lease_until = new Date(now.getTime() + leaseMs).toISOString();
        file.cleanup_next_attempt_at = null;
        file.cleanup_error_code = '';
        claims.push({
          file: cloneFile(file),
          claim_token: claimToken,
          cleanup_attempt_count: file.cleanup_attempt_count
        });
      }
      return claims;
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const claims: SecureFileCleanupClaim[] = [];
      for (let index = 0; index < limit; index += 1) {
        const claimToken = randomUUID();
        const tokenHash = sha256Text(claimToken);
        const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
        const result = await pg.query(
          `WITH candidate AS (
             SELECT id
             FROM collaboration_secure_files
             WHERE tenant_id = $1
               AND status IN ('initiated', 'uploading', 'ready', 'quarantined', 'failed')
               AND NOT EXISTS (
                 SELECT 1 FROM ivekit_legal_holds hold
                 WHERE hold.tenant_id = collaboration_secure_files.tenant_id
                   AND hold.category = 'secure_files'
                   AND hold.resource_type = 'secure_file'
                   AND hold.resource_id = collaboration_secure_files.id
                   AND hold.status = 'active'
               )
               AND (cleanup_next_attempt_at IS NULL OR cleanup_next_attempt_at <= $2)
               AND (cleanup_lease_until IS NULL OR cleanup_lease_until <= $2)
               AND (
                 (expires_at IS NOT NULL AND expires_at <= $2) OR
                 (status IN ('initiated', 'uploading') AND updated_at <= $3) OR
                 (
                   status IN ('ready', 'quarantined', 'failed') AND
                   retention_until IS NOT NULL AND retention_until <= $2
                 )
               )
             ORDER BY updated_at, id
             FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE collaboration_secure_files file
           SET cleanup_attempt_count = cleanup_attempt_count + 1,
               cleanup_worker_id = $4, cleanup_lease_token_hash = $5,
               cleanup_lease_until = $6, cleanup_next_attempt_at = NULL,
               cleanup_error_code = ''
           FROM candidate
           WHERE file.tenant_id = $1 AND file.id = candidate.id
           RETURNING file.*`,
          [tenantId, nowIso, staleBefore, workerId, tokenHash, leaseUntil]
        );
        if (!result.rows[0]) break;
        claims.push({
          file: decodeFile(result.rows[0]),
          claim_token: claimToken,
          cleanup_attempt_count: Number(result.rows[0].cleanup_attempt_count || 0)
        });
      }
      return claims;
    });
  }

  async finishCleanupJob(input: {
    tenant_id: string;
    secure_file_id: string;
    worker_id: string;
    claim_token: string;
    outcome: 'expired' | 'retry_wait';
    error_code?: string;
    next_attempt_at?: string | null;
  }): Promise<SecureFile> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const secureFileId = requiredText(input.secure_file_id, 'secure_file_id');
    const workerId = boundedSingleLine(input.worker_id, 'worker_id', 255);
    const claimTokenHash = sha256Text(boundedSingleLine(input.claim_token, 'claim_token', 255));
    const outcome = input.outcome;
    if (outcome !== 'expired' && outcome !== 'retry_wait') {
      throw secureFileError('cleanup outcome is invalid', 400, 'cleanup_outcome_invalid');
    }
    const nextAttemptAt = optionalTimestamp(input.next_attempt_at, 'next_attempt_at');
    if (outcome === 'retry_wait' && !nextAttemptAt) {
      throw secureFileError('next_attempt_at is required for cleanup retry', 400, 'next_attempt_at_required');
    }
    const errorCode = safeCode(input.error_code || (outcome === 'retry_wait' ? 'cleanup_retry' : ''));
    const now = this.now().toISOString();
    if (this.pg instanceof MemoryPg) {
      const file = this.memoryFile(tenantId, secureFileId, false);
      assertCleanupClaim(file, workerId, claimTokenHash, now);
      if (outcome === 'retry_wait') {
        file.cleanup_next_attempt_at = nextAttemptAt;
        file.cleanup_error_code = errorCode;
        clearCleanupLease(file);
        return cloneFile(file);
      }
      assertSecureFileStatusTransition(file.status, 'expired');
      file.status = 'expired';
      file.cleanup_next_attempt_at = null;
      file.cleanup_error_code = '';
      clearCleanupLease(file);
      file.updated_at = now;
      for (const part of memoryState(this.pg).parts.values()) {
        if (part.tenant_id === tenantId && part.secure_file_id === secureFileId) {
          part.status = 'aborted';
          part.updated_at = now;
        }
      }
      return cloneFile(file);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const locked = await pg.query(
        `SELECT * FROM collaboration_secure_files
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, secureFileId]
      );
      if (!locked.rows[0]) throw secureFileError('secure file not found', 404, 'secure_file_not_found');
      const row = locked.rows[0];
      if (
        String(row.cleanup_worker_id || '') !== workerId ||
        String(row.cleanup_lease_token_hash || '') !== claimTokenHash ||
        !row.cleanup_lease_until || timestampText(row.cleanup_lease_until) <= now
      ) {
        throw secureFileError('secure file cleanup claim is stale', 409, 'cleanup_claim_stale');
      }
      if (outcome === 'retry_wait') {
        const retry = await pg.query(
          `UPDATE collaboration_secure_files
           SET cleanup_next_attempt_at = $3::TIMESTAMPTZ, cleanup_error_code = $4,
               cleanup_lease_token_hash = '', cleanup_lease_until = NULL,
               cleanup_worker_id = ''
           WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          [tenantId, secureFileId, nextAttemptAt, errorCode]
        );
        return decodeFile(retry.rows[0]);
      }
      await pg.query(
        `UPDATE collaboration_secure_file_parts
         SET status = 'aborted', updated_at = $3
         WHERE tenant_id = $1 AND secure_file_id = $2`,
        [tenantId, secureFileId, now]
      );
      const expired = await pg.query(
        `UPDATE collaboration_secure_files
         SET status = 'expired', cleanup_next_attempt_at = NULL,
             cleanup_error_code = '', cleanup_lease_token_hash = '',
             cleanup_lease_until = NULL, cleanup_worker_id = '', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tenantId, secureFileId, now]
      );
      return decodeFile(expired.rows[0]);
    });
  }

  private createUploadMemory(input: NormalizedCreateInput): SecureFile {
    const state = memoryState(this.pg as MemoryPg);
    const existing = [...state.files.values()].find((file) =>
      file.tenant_id === input.tenant_id && file.session_id === input.session_id &&
      file.idempotency_key === input.idempotency_key
    );
    if (existing) return assertIdempotentCreate(existing, input.payload_hash);
    const now = this.now().toISOString();
    const file: SecureFileInternal = {
      id: pgId('sfile'), tenant_id: input.tenant_id, session_id: input.session_id,
      created_by: input.created_by, kind: input.kind, filename: input.filename,
      extension: input.extension, declared_mime: input.declared_mime, detected_mime: '',
      mime_conflict: false, status: 'initiated', threat_status: 'pending', failure_code: '',
      object_key: '', size_bytes: 0, sha256: '', upload_mode: input.upload_mode,
      expected_size_bytes: input.expected_size_bytes, received_size_bytes: 0,
      part_size_bytes: input.part_size_bytes, idempotency_key: input.idempotency_key,
      payload_hash: input.payload_hash, scan_attempt_count: 0,
      scanner_name: '', scanner_mode: '', scanner_request_id: '', scan_metadata: {},
      next_attempt_at: null, lease_token_hash: '', lease_until: null,
      worker_id: '', retention_until: input.retention_until, expires_at: input.expires_at,
      cleanup_attempt_count: 0, cleanup_next_attempt_at: null,
      cleanup_lease_token_hash: '', cleanup_lease_until: null,
      cleanup_worker_id: '', cleanup_error_code: '',
      metadata: { ...input.metadata }, created_at: now, updated_at: now, completed_at: null
    };
    state.files.set(file.id, file);
    return cloneFile(file);
  }

  private recordPartMemory(input: NormalizedPartInput): SecureFilePart {
    const file = this.memoryFile(input.tenant_id, input.secure_file_id, false);
    assertMultipartUploadable(file);
    const state = memoryState(this.pg as MemoryPg);
    const key = partKey(input.tenant_id, input.secure_file_id, input.part_number);
    const existing = state.parts.get(key);
    if (existing) return assertIdempotentPart(existing, input);
    const now = this.now().toISOString();
    const part: SecureFilePart = {
      tenant_id: input.tenant_id, session_id: file.session_id, secure_file_id: file.id,
      part_number: input.part_number, size_bytes: input.size_bytes, sha256: input.sha256,
      object_key: input.object_key, etag: input.etag, status: 'uploaded',
      created_at: now, updated_at: now
    };
    state.parts.set(key, part);
    if (file.status === 'initiated') file.status = 'uploading';
    file.received_size_bytes = [...state.parts.values()]
      .filter((item) => item.tenant_id === file.tenant_id && item.secure_file_id === file.id && item.status === 'uploaded')
      .reduce((sum, item) => sum + item.size_bytes, 0);
    file.updated_at = now;
    return clonePart(part);
  }

  private completeUploadMemory(input: NormalizedCompleteInput): SecureFile {
    const file = this.memoryFile(input.tenant_id, input.secure_file_id, false);
    const replay = completedReplay(file, input);
    if (replay) return replay;
    assertCompletable(file, input);
    if (file.upload_mode === 'multipart') {
      const received = [...memoryState(this.pg as MemoryPg).parts.values()]
        .filter((part) => part.tenant_id === file.tenant_id && part.secure_file_id === file.id && part.status === 'uploaded')
        .reduce((sum, part) => sum + part.size_bytes, 0);
      assertReceivedSize(received, input.size_bytes);
    }
    const now = this.now().toISOString();
    file.status = 'scanning';
    file.threat_status = 'pending';
    file.object_key = input.object_key;
    file.size_bytes = input.size_bytes;
    file.received_size_bytes = input.size_bytes;
    file.sha256 = input.sha256;
    file.completed_at = now;
    file.updated_at = now;
    return cloneFile(file);
  }

  private claimScanJobsMemory(
    tenantId: string,
    workerId: string,
    limit: number,
    leaseMs: number,
    maxAttempts: number
  ): SecureFileScanClaim[] {
    const now = this.now();
    const nowIso = now.toISOString();
    const candidates = [...memoryState(this.pg as MemoryPg).files.values()]
      .filter((file) => file.tenant_id === tenantId && file.status === 'scanning')
      .sort((left, right) =>
        String(left.next_attempt_at || left.updated_at).localeCompare(String(right.next_attempt_at || right.updated_at)) ||
        left.id.localeCompare(right.id)
      );
    const claims: SecureFileScanClaim[] = [];
    for (const file of candidates) {
      if (claims.length >= limit) break;
      const leaseExpired = Boolean(file.lease_until && file.lease_until <= nowIso);
      if (leaseExpired && file.scan_attempt_count >= maxAttempts) {
        file.status = 'failed';
        file.threat_status = 'error';
        file.failure_code = 'scan_attempts_exhausted';
        clearScanLease(file);
        file.updated_at = nowIso;
        continue;
      }
      if (!scanFileIsDue(file, nowIso) || file.scan_attempt_count >= maxAttempts) continue;
      const claimToken = randomUUID();
      file.threat_status = 'scanning';
      file.scan_attempt_count += 1;
      file.worker_id = workerId;
      file.lease_token_hash = sha256Text(claimToken);
      file.lease_until = new Date(now.getTime() + leaseMs).toISOString();
      file.next_attempt_at = null;
      file.failure_code = '';
      file.updated_at = nowIso;
      claims.push({ file: cloneFile(file), claim_token: claimToken });
    }
    return claims;
  }

  private finishScanJobMemory(input: NormalizedScanFinishInput): SecureFile {
    const file = this.memoryFile(input.tenant_id, input.secure_file_id, false);
    const now = this.now().toISOString();
    if (
      file.status !== 'scanning' || file.worker_id !== input.worker_id ||
      file.lease_token_hash !== input.claim_token_hash || !file.lease_until || file.lease_until <= now
    ) {
      throw secureFileError('secure file scan claim is stale', 409, 'secure_file_scan_claim_stale');
    }
    const next = scanOutcomeFields(input, now);
    assertSecureFileStatusTransition(file.status, next.status);
    file.status = next.status;
    file.threat_status = next.threat_status;
    file.detected_mime = next.detected_mime;
    file.mime_conflict = next.mime_conflict;
    file.failure_code = next.failure_code;
    file.scanner_name = input.scanner_name;
    file.scanner_mode = input.scanner_mode;
    file.scanner_request_id = input.scanner_request_id;
    file.scan_metadata = { ...input.scan_metadata };
    file.next_attempt_at = next.next_attempt_at;
    clearScanLease(file);
    file.updated_at = now;
    return cloneFile(file);
  }

  private memoryFile(tenantId: string, secureFileId: string, clone?: true): SecureFile;
  private memoryFile(tenantId: string, secureFileId: string, clone: false): SecureFileInternal;
  private memoryFile(tenantId: string, secureFileId: string, clone = true): SecureFile | SecureFileInternal {
    const file = memoryState(this.pg as MemoryPg).files.get(secureFileId);
    if (!file || file.tenant_id !== tenantId) {
      throw secureFileError('secure file not found', 404, 'secure_file_not_found');
    }
    return clone ? cloneFile(file) : file;
  }
}

export function assertSecureFileStatusTransition(
  fromStatus: SecureFileStatus,
  toStatus: SecureFileStatus
): void {
  const from = secureFileStatus(fromStatus);
  const to = secureFileStatus(toStatus);
  if (from === to) return;
  if (!NEXT_STATUSES[from].includes(to)) {
    throw secureFileError(
      `secure file status transition ${from} -> ${to} is not allowed`,
      409,
      'secure_file_transition_invalid'
    );
  }
}

interface NormalizedCreateInput {
  tenant_id: string;
  session_id: string;
  created_by: string;
  kind: SecureFileKind;
  filename: string;
  extension: string;
  declared_mime: string;
  upload_mode: SecureFileUploadMode;
  expected_size_bytes: number;
  part_size_bytes: number;
  idempotency_key: string;
  payload_hash: string;
  retention_until: string | null;
  expires_at: string | null;
  metadata: Record<string, unknown>;
}

interface NormalizedPartInput {
  tenant_id: string;
  secure_file_id: string;
  part_number: number;
  size_bytes: number;
  sha256: string;
  object_key: string;
  etag: string;
}

interface NormalizedCompleteInput {
  tenant_id: string;
  secure_file_id: string;
  size_bytes: number;
  sha256: string;
  object_key: string;
}

interface NormalizedScanFinishInput {
  tenant_id: string;
  secure_file_id: string;
  worker_id: string;
  claim_token_hash: string;
  outcome: SecureFileScanOutcome;
  detected_mime: string;
  mime_conflict: boolean;
  failure_code: string;
  next_attempt_at: string | null;
  scanner_name: string;
  scanner_mode: string;
  scanner_request_id: string;
  scan_metadata: Record<string, unknown>;
}

interface ScanOutcomeFields {
  status: SecureFileStatus;
  threat_status: SecureFileThreatStatus;
  detected_mime: string;
  mime_conflict: boolean;
  failure_code: string;
  next_attempt_at: string | null;
}

function normalizeCreateInput(input: {
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
}): NormalizedCreateInput {
  const filename = boundedText(input.filename, 'filename', 512);
  const expectedSize = boundedInteger(input.expected_size_bytes, 1, MAX_FILE_BYTES, 'expected_size_bytes');
  const uploadMode = uploadModeValue(input.upload_mode);
  const requestedPartSize = input.part_size_bytes ?? expectedSize;
  const partSize = boundedInteger(
    requestedPartSize,
    1,
    Math.min(MAX_PART_BYTES, expectedSize),
    'part_size_bytes'
  );
  return {
    tenant_id: requiredText(input.tenant_id, 'tenant_id'),
    session_id: requiredText(input.session_id, 'session_id'),
    created_by: boundedText(input.created_by, 'created_by', 255),
    kind: kindValue(input.kind),
    filename,
    extension: normalizedExtension(filename),
    declared_mime: input.declared_mime ? mimeText(input.declared_mime) : '',
    upload_mode: uploadMode,
    expected_size_bytes: expectedSize,
    part_size_bytes: partSize,
    idempotency_key: boundedSingleLine(input.idempotency_key, 'idempotency_key', 128),
    payload_hash: sha256Value(input.payload_hash, 'payload_hash'),
    retention_until: optionalTimestamp(input.retention_until, 'retention_until'),
    expires_at: optionalTimestamp(input.expires_at, 'expires_at'),
    metadata: boundedMetadata(input.metadata)
  };
}

function normalizePartInput(input: {
  tenant_id: string;
  secure_file_id: string;
  part_number: number;
  size_bytes: number;
  sha256: string;
  object_key: string;
  etag?: string;
}): NormalizedPartInput {
  return {
    tenant_id: requiredText(input.tenant_id, 'tenant_id'),
    secure_file_id: requiredText(input.secure_file_id, 'secure_file_id'),
    part_number: boundedInteger(input.part_number, 1, MAX_PARTS, 'part_number'),
    size_bytes: boundedInteger(input.size_bytes, 1, MAX_PART_BYTES, 'size_bytes'),
    sha256: sha256Value(input.sha256, 'sha256'),
    object_key: objectKeyValue(input.object_key),
    etag: boundedSingleLine(input.etag || '', 'etag', 255, true)
  };
}

function normalizeCompleteInput(input: {
  tenant_id: string;
  secure_file_id: string;
  size_bytes: number;
  sha256: string;
  object_key: string;
}): NormalizedCompleteInput {
  return {
    tenant_id: requiredText(input.tenant_id, 'tenant_id'),
    secure_file_id: requiredText(input.secure_file_id, 'secure_file_id'),
    size_bytes: boundedInteger(input.size_bytes, 1, MAX_FILE_BYTES, 'size_bytes'),
    sha256: sha256Value(input.sha256, 'sha256'),
    object_key: objectKeyValue(input.object_key)
  };
}

function normalizeScanFinishInput(input: {
  tenant_id: string;
  secure_file_id: string;
  worker_id: string;
  claim_token: string;
  outcome: SecureFileScanOutcome;
  detected_mime?: string;
  mime_conflict?: boolean;
  failure_code?: string;
  next_attempt_at?: string | null;
  scanner_name?: string;
  scanner_mode?: string;
  scanner_request_id?: string;
  scan_metadata?: Record<string, unknown>;
}): NormalizedScanFinishInput {
  const outcome = scanOutcomeValue(input.outcome);
  const detectedMime = input.detected_mime ? mimeText(input.detected_mime) : '';
  if ((outcome === 'clean' || outcome === 'infected' || outcome === 'quarantined') && !detectedMime) {
    throw secureFileError('detected_mime is required for scan outcome', 400, 'detected_mime_required');
  }
  const nextAttemptAt = optionalTimestamp(input.next_attempt_at, 'next_attempt_at');
  if (outcome === 'retry_wait' && !nextAttemptAt) {
    throw secureFileError('next_attempt_at is required for retry', 400, 'next_attempt_at_required');
  }
  const claimToken = boundedSingleLine(input.claim_token, 'claim_token', 255);
  return {
    tenant_id: requiredText(input.tenant_id, 'tenant_id'),
    secure_file_id: requiredText(input.secure_file_id, 'secure_file_id'),
    worker_id: boundedSingleLine(input.worker_id, 'worker_id', 255),
    claim_token_hash: sha256Text(claimToken),
    outcome,
    detected_mime: detectedMime,
    mime_conflict: input.mime_conflict === true,
    failure_code: safeCode(input.failure_code),
    next_attempt_at: nextAttemptAt,
    scanner_name: boundedSingleLine(input.scanner_name || '', 'scanner_name', 100, true),
    scanner_mode: boundedSingleLine(input.scanner_mode || '', 'scanner_mode', 50, true),
    scanner_request_id: boundedSingleLine(
      input.scanner_request_id || '', 'scanner_request_id', 200, true
    ),
    scan_metadata: boundedMetadata(input.scan_metadata)
  };
}

function scanOutcomeFields(input: NormalizedScanFinishInput, _now: string): ScanOutcomeFields {
  switch (input.outcome) {
    case 'clean':
      return {
        status: 'processing', threat_status: 'clean', detected_mime: input.detected_mime,
        mime_conflict: input.mime_conflict, failure_code: '', next_attempt_at: null
      };
    case 'infected':
      return {
        status: 'quarantined', threat_status: 'infected', detected_mime: input.detected_mime,
        mime_conflict: input.mime_conflict,
        failure_code: input.failure_code || 'malware_detected', next_attempt_at: null
      };
    case 'quarantined':
      return {
        status: 'quarantined', threat_status: 'error', detected_mime: input.detected_mime,
        mime_conflict: input.mime_conflict,
        failure_code: input.failure_code || 'file_security_quarantine', next_attempt_at: null
      };
    case 'retry_wait':
      return {
        status: 'scanning', threat_status: 'pending', detected_mime: input.detected_mime,
        mime_conflict: input.mime_conflict,
        failure_code: input.failure_code || 'scanner_retry', next_attempt_at: input.next_attempt_at
      };
    case 'failed':
      return {
        status: 'failed', threat_status: 'error', detected_mime: input.detected_mime,
        mime_conflict: input.mime_conflict,
        failure_code: input.failure_code || 'scanner_failed', next_attempt_at: null
      };
  }
}

function scanOutcomeValue(value: unknown): SecureFileScanOutcome {
  if (
    value === 'clean' || value === 'infected' || value === 'quarantined' ||
    value === 'retry_wait' || value === 'failed'
  ) return value;
  throw secureFileError('scan outcome is invalid', 400, 'scan_outcome_invalid');
}

function transitionLockedFile(
  file: SecureFile,
  input: {
    fromStatus: SecureFileStatus;
    toStatus: SecureFileStatus;
    threatStatus?: SecureFileThreatStatus;
    detectedMime?: string;
    mimeConflict?: boolean;
    failureCode: string;
    now: string;
  }
): SecureFile {
  if (file.status === input.toStatus) return cloneFile(file);
  if (file.status !== input.fromStatus) {
    throw secureFileError('secure file status changed', 409, 'secure_file_status_conflict');
  }
  assertSecureFileStatusTransition(file.status, input.toStatus);
  const threatStatus = input.threatStatus ?? file.threat_status;
  const detectedMime = input.detectedMime ?? file.detected_mime;
  if (input.toStatus === 'processing' && (threatStatus !== 'clean' || !detectedMime)) {
    throw secureFileError(
      'clean threat result and detected MIME are required before processing',
      409,
      'secure_file_scan_incomplete'
    );
  }
  if (input.toStatus === 'quarantined' && threatStatus !== 'infected' && threatStatus !== 'error') {
    throw secureFileError(
      'quarantine requires an infected or error threat result',
      409,
      'secure_file_quarantine_reason_required'
    );
  }
  if (input.toStatus === 'ready' && threatStatus !== 'clean') {
    throw secureFileError('only clean files can become ready', 409, 'secure_file_not_clean');
  }
  file.status = input.toStatus;
  file.threat_status = threatStatus;
  file.detected_mime = detectedMime;
  file.mime_conflict = input.mimeConflict ?? file.mime_conflict;
  file.failure_code = input.failureCode || file.failure_code;
  file.updated_at = input.now;
  return cloneFile(file);
}

function assertMultipartUploadable(file: SecureFile): void {
  if (file.upload_mode !== 'multipart') {
    throw secureFileError('parts are only valid for multipart uploads', 409, 'upload_mode_conflict');
  }
  if (file.status !== 'initiated' && file.status !== 'uploading') {
    throw secureFileError('secure file no longer accepts parts', 409, 'upload_state_conflict');
  }
}

function assertCompletable(file: SecureFile, input: NormalizedCompleteInput): void {
  if (file.status !== 'uploading') {
    throw secureFileError('secure file is not uploading', 409, 'upload_state_conflict');
  }
  if (file.expected_size_bytes !== input.size_bytes) {
    throw secureFileError('completed size does not match expected size', 409, 'upload_size_conflict');
  }
}

function completedReplay(file: SecureFile, input: NormalizedCompleteInput): SecureFile | null {
  if (file.status === 'initiated' || file.status === 'uploading') return null;
  if (
    file.size_bytes === input.size_bytes && file.sha256 === input.sha256 &&
    file.object_key === input.object_key
  ) return cloneFile(file);
  throw secureFileError(
    'secure file completion was already recorded with different content',
    409,
    'upload_completion_conflict'
  );
}

function assertReceivedSize(received: number, completed: number): void {
  if (received !== completed) {
    throw secureFileError('uploaded part total does not match completed size', 409, 'upload_part_total_conflict');
  }
}

function assertIdempotentCreate(file: SecureFile, payloadHash: string): SecureFile {
  if (file.payload_hash !== payloadHash) {
    throw secureFileError(
      'idempotency key was already used for a different upload payload',
      409,
      'idempotency_payload_conflict'
    );
  }
  return cloneFile(file);
}

function assertIdempotentPart(part: SecureFilePart, input: NormalizedPartInput): SecureFilePart {
  if (
    part.size_bytes !== input.size_bytes || part.sha256 !== input.sha256 ||
    part.object_key !== input.object_key || part.etag !== input.etag
  ) {
    throw secureFileError(
      'part number was already used for different content',
      409,
      'upload_part_conflict'
    );
  }
  return clonePart(part);
}

function assertReservedPart(part: SecureFilePart, input: NormalizedPartInput): SecureFilePart {
  if (
    part.size_bytes !== input.size_bytes || part.sha256 !== input.sha256 ||
    part.object_key !== input.object_key ||
    (part.status !== 'staged' && part.status !== 'uploaded')
  ) {
    throw secureFileError(
      'part number was already reserved for different content',
      409,
      'upload_part_conflict'
    );
  }
  return clonePart(part);
}

async function selectAndAssertPart(
  pg: PgQueryable,
  input: NormalizedPartInput
): Promise<SecureFilePart> {
  const result = await pg.query(
    `SELECT * FROM collaboration_secure_file_parts
     WHERE tenant_id = $1 AND secure_file_id = $2 AND part_number = $3`,
    [input.tenant_id, input.secure_file_id, input.part_number]
  );
  if (!result.rows[0]) throw secureFileError('secure file part could not be recorded', 503, 'upload_part_failed');
  return assertIdempotentPart(decodePart(result.rows[0]), input);
}

async function selectAndAssertReservedPart(
  pg: PgQueryable,
  input: NormalizedPartInput
): Promise<SecureFilePart> {
  const result = await pg.query(
    `SELECT * FROM collaboration_secure_file_parts
     WHERE tenant_id = $1 AND secure_file_id = $2 AND part_number = $3`,
    [input.tenant_id, input.secure_file_id, input.part_number]
  );
  if (!result.rows[0]) {
    throw secureFileError('secure file part could not be reserved', 503, 'upload_part_failed');
  }
  return assertReservedPart(decodePart(result.rows[0]), input);
}

async function fileByIdempotencyKey(
  pg: PgQueryable,
  tenantId: string,
  sessionId: string,
  idempotencyKey: string
): Promise<SecureFile | null> {
  const result = await pg.query(
    `SELECT * FROM collaboration_secure_files
     WHERE tenant_id = $1 AND session_id = $2 AND idempotency_key = $3`,
    [tenantId, sessionId, idempotencyKey]
  );
  return result.rows[0] ? decodeFile(result.rows[0]) : null;
}

async function lockFile(
  pg: PgQueryable,
  tenantId: string,
  secureFileId: string,
  forUpdate = true
): Promise<SecureFile> {
  const result = await pg.query(
    `SELECT * FROM collaboration_secure_files
     WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId, secureFileId]
  );
  if (!result.rows[0]) throw secureFileError('secure file not found', 404, 'secure_file_not_found');
  return decodeFile(result.rows[0]);
}

function updateMemoryReceivedSize(
  pg: MemoryPg,
  file: SecureFileInternal,
  now: string
): void {
  file.received_size_bytes = [...memoryState(pg).parts.values()]
    .filter((part) =>
      part.tenant_id === file.tenant_id && part.secure_file_id === file.id &&
      part.status === 'uploaded'
    )
    .reduce((sum, part) => sum + part.size_bytes, 0);
  file.updated_at = now;
}

async function updateDatabaseReceivedSize(
  pg: PgQueryable,
  tenantId: string,
  secureFileId: string,
  now: string
): Promise<void> {
  await pg.query(
    `UPDATE collaboration_secure_files file
     SET received_size_bytes = parts.received_size_bytes, updated_at = $3
     FROM (
       SELECT COALESCE(SUM(size_bytes), 0) AS received_size_bytes
       FROM collaboration_secure_file_parts
       WHERE tenant_id = $1 AND secure_file_id = $2 AND status = 'uploaded'
     ) parts
     WHERE file.tenant_id = $1 AND file.id = $2`,
    [tenantId, secureFileId, now]
  );
}

async function databaseNow(pg: PgQueryable): Promise<string> {
  const result = await pg.query<{ now: string | Date }>('SELECT clock_timestamp() AS now');
  const value = result.rows[0]?.now;
  const parsed = value instanceof Date ? value : new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) throw secureFileError('database clock is unavailable', 503, 'database_clock_unavailable');
  return parsed.toISOString();
}

function decodeFile(row: Record<string, unknown>): SecureFile {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), session_id: String(row.session_id),
    created_by: String(row.created_by || ''), kind: kindValue(row.kind),
    filename: String(row.filename || ''), extension: String(row.extension || ''),
    declared_mime: String(row.declared_mime || ''), detected_mime: String(row.detected_mime || ''),
    mime_conflict: booleanValue(row.mime_conflict), status: secureFileStatus(row.status),
    threat_status: secureFileThreatStatus(row.threat_status), failure_code: String(row.failure_code || ''),
    object_key: String(row.object_key || ''), size_bytes: Number(row.size_bytes || 0),
    sha256: String(row.sha256 || ''), upload_mode: uploadModeValue(row.upload_mode),
    expected_size_bytes: Number(row.expected_size_bytes || 0),
    received_size_bytes: Number(row.received_size_bytes || 0),
    part_size_bytes: Number(row.part_size_bytes || 0), idempotency_key: String(row.idempotency_key || ''),
    payload_hash: String(row.payload_hash || ''), scan_attempt_count: Number(row.scan_attempt_count || 0),
    scanner_name: String(row.scanner_name || ''), scanner_mode: String(row.scanner_mode || ''),
    scanner_request_id: String(row.scanner_request_id || ''), scan_metadata: jsonObject(row.scan_metadata),
    next_attempt_at: nullableTimestamp(row.next_attempt_at),
    lease_until: nullableTimestamp(row.lease_until), worker_id: String(row.worker_id || ''),
    retention_until: nullableTimestamp(row.retention_until), expires_at: nullableTimestamp(row.expires_at),
    metadata: jsonObject(row.metadata), created_at: timestampText(row.created_at),
    updated_at: timestampText(row.updated_at), completed_at: nullableTimestamp(row.completed_at)
  };
}

function decodePart(row: Record<string, unknown>): SecureFilePart {
  return {
    tenant_id: String(row.tenant_id), session_id: String(row.session_id),
    secure_file_id: String(row.secure_file_id), part_number: Number(row.part_number),
    size_bytes: Number(row.size_bytes || 0), sha256: String(row.sha256 || ''),
    object_key: String(row.object_key || ''), etag: String(row.etag || ''),
    status: String(row.status || 'uploaded') as SecureFilePart['status'],
    created_at: timestampText(row.created_at), updated_at: timestampText(row.updated_at)
  };
}

function memoryState(pg: MemoryPg): MemorySecureFileState {
  let state = memoryStates.get(pg);
  if (!state) {
    state = { files: new Map(), parts: new Map() };
    memoryStates.set(pg, state);
  }
  return state;
}

function partKey(tenantId: string, secureFileId: string, partNumber: number): string {
  return `${tenantId}\u0000${secureFileId}\u0000${partNumber}`;
}

function scanFileIsDue(file: SecureFile, now: string): boolean {
  return file.status === 'scanning' &&
    (!file.next_attempt_at || file.next_attempt_at <= now) &&
    (!file.lease_until || file.lease_until <= now);
}

function cleanupFileIsDue(
  file: SecureFileInternal,
  now: string,
  uploadStaleBefore: string
): boolean {
  if (
    file.status !== 'initiated' && file.status !== 'uploading' && file.status !== 'ready' &&
    file.status !== 'quarantined' && file.status !== 'failed'
  ) return false;
  if (file.cleanup_next_attempt_at && file.cleanup_next_attempt_at > now) return false;
  if (file.cleanup_lease_until && file.cleanup_lease_until > now) return false;
  if (file.expires_at && file.expires_at <= now) return true;
  if (
    (file.status === 'initiated' || file.status === 'uploading') &&
    file.updated_at <= uploadStaleBefore
  ) return true;
  return (file.status === 'ready' || file.status === 'quarantined' || file.status === 'failed') &&
    Boolean(file.retention_until && file.retention_until <= now);
}

function clearScanLease(file: SecureFileInternal): void {
  file.lease_token_hash = '';
  file.lease_until = null;
  file.worker_id = '';
}

function assertCleanupClaim(
  file: SecureFileInternal,
  workerId: string,
  claimTokenHash: string,
  now: string
): void {
  if (
    file.cleanup_worker_id !== workerId ||
    file.cleanup_lease_token_hash !== claimTokenHash ||
    !file.cleanup_lease_until || file.cleanup_lease_until <= now
  ) {
    throw secureFileError('secure file cleanup claim is stale', 409, 'cleanup_claim_stale');
  }
}

function clearCleanupLease(file: SecureFileInternal): void {
  file.cleanup_lease_token_hash = '';
  file.cleanup_lease_until = null;
  file.cleanup_worker_id = '';
}

function kindValue(value: unknown): SecureFileKind {
  if (value === 'image' || value === 'video' || value === 'audio' || value === 'file' || value === 'screen_recording') {
    return value;
  }
  throw secureFileError('secure file kind is invalid', 400, 'secure_file_kind_invalid');
}

function uploadModeValue(value: unknown): SecureFileUploadMode {
  if (value === 'single' || value === 'multipart') return value;
  throw secureFileError('upload mode is invalid', 400, 'upload_mode_invalid');
}

function secureFileStatus(value: unknown): SecureFileStatus {
  if (typeof value === 'string' && Object.hasOwn(NEXT_STATUSES, value)) return value as SecureFileStatus;
  throw secureFileError('secure file status is invalid', 400, 'secure_file_status_invalid');
}

function secureFileThreatStatus(value: unknown): SecureFileThreatStatus {
  if (value === 'pending' || value === 'scanning' || value === 'clean' || value === 'infected' || value === 'error') {
    return value;
  }
  throw secureFileError('secure file threat status is invalid', 400, 'secure_file_threat_status_invalid');
}

function normalizedExtension(filename: string): string {
  return extname(filename).slice(1).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 32);
}

function multipartIdentity(metadata: Record<string, unknown>): SecureFileMultipartSession | null {
  const value = metadata.multipart_upload;
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw secureFileError('multipart upload metadata is invalid', 500, 'multipart_metadata_invalid');
  }
  const candidate = value as Record<string, unknown>;
  try {
    return {
      upload_id: boundedSingleLine(candidate.upload_id, 'upload_id', 512),
      object_key: objectKeyValue(candidate.object_key),
      storage_url: boundedSingleLine(candidate.storage_url, 'storage_url', 2_048)
    };
  } catch {
    throw secureFileError('multipart upload metadata is invalid', 500, 'multipart_metadata_invalid');
  }
}

function objectKeyValue(value: unknown): string {
  const key = boundedSingleLine(value, 'object_key', 1024);
  if (key.startsWith('/') || key.includes('..') || key.includes('\\')) {
    throw secureFileError('object_key is invalid', 400, 'object_key_invalid');
  }
  return key;
}

function mimeText(value: unknown): string {
  const mime = boundedSingleLine(value, 'mime', 255).toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) {
    throw secureFileError('MIME type is invalid', 400, 'mime_invalid');
  }
  return mime;
}

function sha256Value(value: unknown, field: string): string {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw secureFileError(`${field} must be a SHA-256 digest`, 400, `${field}_invalid`);
  return hash;
}

function boundedMetadata(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw secureFileError('metadata must be an object', 400, 'metadata_invalid');
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 16_384) {
    throw secureFileError('metadata is too large', 400, 'metadata_too_large');
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function optionalTimestamp(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw secureFileError(`${field} is invalid`, 400, `${field}_invalid`);
  return parsed.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  return timestampText(value);
}

function timestampText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value || '');
}

function requiredText(value: unknown, field: string): string {
  return boundedText(value, field, 255);
}

function boundedText(value: unknown, field: string, max: number): string {
  const text = String(value || '').trim();
  if (!text) throw secureFileError(`${field} is required`, 400, `${field}_required`);
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw secureFileError(`${field} is invalid`, 400, `${field}_invalid`);
  }
  return text;
}

function boundedSingleLine(
  value: unknown,
  field: string,
  max: number,
  allowEmpty = false
): string {
  const text = String(value || '').trim();
  if (!text && !allowEmpty) throw secureFileError(`${field} is required`, 400, `${field}_required`);
  if (text.length > max || /[\r\n\u0000]/.test(text)) {
    throw secureFileError(`${field} is invalid`, 400, `${field}_invalid`);
  }
  return text;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw secureFileError(`${field} must be between ${min} and ${max}`, 400, `${field}_invalid`);
  }
  return parsed;
}

function safeCode(value: unknown): string {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 100);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cloneFile(file: SecureFile | SecureFileInternal): SecureFile {
  const {
    lease_token_hash: _leaseTokenHash,
    cleanup_attempt_count: _cleanupAttemptCount,
    cleanup_next_attempt_at: _cleanupNextAttemptAt,
    cleanup_lease_token_hash: _cleanupLeaseTokenHash,
    cleanup_lease_until: _cleanupLeaseUntil,
    cleanup_worker_id: _cleanupWorkerId,
    cleanup_error_code: _cleanupErrorCode,
    ...publicFile
  } = file as SecureFileInternal;
  return {
    ...publicFile,
    metadata: { ...file.metadata },
    scan_metadata: { ...file.scan_metadata }
  };
}

function clonePart(part: SecureFilePart): SecureFilePart {
  return { ...part };
}

function secureFileError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

export type * from './secure-file-types.js';
