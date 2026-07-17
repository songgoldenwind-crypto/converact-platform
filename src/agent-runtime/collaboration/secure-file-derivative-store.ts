import { createHash, randomUUID } from 'node:crypto';

import { MemoryPg, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { sanitizeProviderMetadata, sanitizeProviderRequestId } from './provider-safety.js';
import { SecureFileStore } from './secure-file-store.js';
import type {
  SecureFile,
  SecureFileDerivative,
  SecureFileDerivativeKind
} from './secure-file-types.js';

interface SecureFileDerivativeInternal extends SecureFileDerivative {
  lease_token_hash: string;
}

interface MemoryDerivativeState {
  jobs: Map<string, SecureFileDerivativeInternal>;
  processingFiles: Set<string>;
}

const memoryStates = new WeakMap<MemoryPg, MemoryDerivativeState>();

export interface SecureFileDerivativeClaim {
  file: SecureFile;
  derivative: SecureFileDerivative;
  claim_token: string;
}

export type SecureFileDerivativeOutcome = 'ready' | 'retry_wait' | 'failed';

export interface SecureFileDerivativeStoreOptions {
  now?: () => Date;
}

export class SecureFileDerivativeStore {
  private readonly now: () => Date;
  private readonly files: SecureFileStore;

  constructor(
    private readonly pg: PgQueryable,
    options: SecureFileDerivativeStoreOptions = {}
  ) {
    this.now = options.now || (() => new Date());
    this.files = new SecureFileStore(pg, { now: this.now });
  }

  async ensureJobs(input: {
    tenant_id: string;
    secure_file_id: string;
    provider_profile_id?: string;
  }): Promise<SecureFileDerivative[]> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const secureFileId = requiredText(input.secure_file_id, 'secure_file_id');
    const providerProfileId = boundedSingleLine(
      input.provider_profile_id || 'default', 'provider_profile_id', 255
    );
    const file = await this.files.getFile(tenantId, secureFileId);
    if (file.status !== 'processing' && file.status !== 'ready') {
      throw derivativeStoreError(
        'secure file is not ready for derivative planning', 409, 'secure_file_not_processing'
      );
    }
    if (file.threat_status !== 'clean' || !file.detected_mime) {
      throw derivativeStoreError(
        'secure file must be clean before derivative planning', 409, 'secure_file_not_clean'
      );
    }
    const kinds = requiredDerivativeKinds(file.detected_mime);
    if (this.pg instanceof MemoryPg) {
      const state = memoryState(this.pg);
      state.processingFiles.add(fileKey(tenantId, secureFileId));
      const now = this.now().toISOString();
      for (const kind of kinds) {
        const key = derivativeKey(tenantId, secureFileId, kind);
        if (state.jobs.has(key)) continue;
        state.jobs.set(key, {
          tenant_id: tenantId,
          session_id: file.session_id,
          secure_file_id: secureFileId,
          derivative_kind: kind,
          status: 'pending',
          object_key: '',
          mime: '',
          size_bytes: 0,
          sha256: '',
          provider_profile_id: providerProfileId,
          provider_request_id: '',
          provider_metadata: {},
          attempt_count: 0,
          next_attempt_at: null,
          lease_token_hash: '',
          lease_until: null,
          worker_id: '',
          error_code: '',
          retention_until: file.retention_until,
          expires_at: file.expires_at,
          created_at: now,
          updated_at: now,
          completed_at: null
        });
      }
      return this.listJobs(tenantId, secureFileId);
    }
    await withPgTenant(this.pg, tenantId, async (pg) => {
      for (const kind of kinds) {
        await pg.query(
          `INSERT INTO collaboration_secure_file_derivatives
            (tenant_id, session_id, secure_file_id, derivative_kind,
             provider_profile_id, retention_until, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6::TIMESTAMPTZ, $7::TIMESTAMPTZ)
           ON CONFLICT (tenant_id, secure_file_id, derivative_kind) DO NOTHING`,
          [
            tenantId, file.session_id, secureFileId, kind, providerProfileId,
            file.retention_until, file.expires_at
          ]
        );
      }
    });
    return this.listJobs(tenantId, secureFileId);
  }

  async listJobs(tenantIdInput: string, secureFileIdInput: string): Promise<SecureFileDerivative[]> {
    const tenantId = requiredText(tenantIdInput, 'tenant_id');
    const secureFileId = requiredText(secureFileIdInput, 'secure_file_id');
    await this.files.getFile(tenantId, secureFileId);
    if (this.pg instanceof MemoryPg) {
      return [...memoryState(this.pg).jobs.values()]
        .filter((job) => job.tenant_id === tenantId && job.secure_file_id === secureFileId)
        .sort((left, right) => left.derivative_kind.localeCompare(right.derivative_kind))
        .map(publicDerivative);
    }
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM collaboration_secure_file_derivatives
         WHERE tenant_id = $1 AND secure_file_id = $2
         ORDER BY derivative_kind`,
        [tenantId, secureFileId]
      );
      return result.rows.map(decodeDerivative);
    });
  }

  getFile(tenantId: string, secureFileId: string): Promise<SecureFile> {
    return this.files.getFile(tenantId, secureFileId);
  }

  async expireJobs(input: {
    tenant_id: string;
    secure_file_id: string;
  }): Promise<SecureFileDerivative[]> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const secureFileId = requiredText(input.secure_file_id, 'secure_file_id');
    await this.files.getFile(tenantId, secureFileId);
    const now = this.now().toISOString();
    if (this.pg instanceof MemoryPg) {
      for (const job of memoryState(this.pg).jobs.values()) {
        if (job.tenant_id !== tenantId || job.secure_file_id !== secureFileId) continue;
        job.status = 'expired';
        job.next_attempt_at = null;
        job.error_code = '';
        job.completed_at ||= now;
        job.updated_at = now;
        clearLease(job);
      }
      return this.listJobs(tenantId, secureFileId);
    }
    await withPgTenant(this.pg, tenantId, async (pg) => {
      await pg.query(
        `UPDATE collaboration_secure_file_derivatives
         SET status = 'expired', next_attempt_at = NULL, error_code = '',
             lease_token_hash = '', lease_until = NULL, worker_id = '',
             completed_at = COALESCE(completed_at, $3), updated_at = $3
         WHERE tenant_id = $1 AND secure_file_id = $2 AND status != 'expired'`,
        [tenantId, secureFileId, now]
      );
    });
    return this.listJobs(tenantId, secureFileId);
  }

  async discoverTenantIds(input: { limit?: number } = {}): Promise<string[]> {
    const limit = boundedInteger(input.limit ?? 100, 1, 1_000, 'limit');
    const now = this.now().toISOString();
    if (this.pg instanceof MemoryPg) {
      const state = memoryState(this.pg);
      const tenants = new Set<string>();
      for (const reference of state.processingFiles) {
        const [tenantId, secureFileId] = reference.split('\u0000');
        try {
          const file = await this.files.getFile(tenantId!, secureFileId!);
          if (file.status === 'processing') tenants.add(tenantId!);
        } catch {
          state.processingFiles.delete(reference);
        }
      }
      for (const job of state.jobs.values()) {
        if (derivativeIsDue(job, now)) tenants.add(job.tenant_id);
      }
      return [...tenants].sort().slice(0, limit);
    }
    const result = await this.pg.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM opc_secure_file_derivative_worker_tenant_ids($1::TIMESTAMPTZ, $2)',
      [now, limit]
    );
    return result.rows.map((row) => String(row.tenant_id)).filter(Boolean);
  }

  async listProcessingFiles(input: {
    tenant_id: string;
    limit?: number;
  }): Promise<SecureFile[]> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const limit = boundedInteger(input.limit ?? 100, 1, 1_000, 'limit');
    return this.files.listFilesByStatus({
      tenant_id: tenantId,
      status: 'processing',
      limit
    });
  }

  async claimJobs(input: {
    tenant_id: string;
    worker_id: string;
    limit?: number;
    lease_ms?: number;
    max_attempts?: number;
  }): Promise<SecureFileDerivativeClaim[]> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const workerId = boundedSingleLine(input.worker_id, 'worker_id', 255);
    const limit = boundedInteger(input.limit ?? 25, 1, 100, 'limit');
    const leaseMs = boundedInteger(input.lease_ms ?? 120_000, 5_000, 30 * 60_000, 'lease_ms');
    const maxAttempts = boundedInteger(input.max_attempts ?? 3, 1, 10, 'max_attempts');
    if (this.pg instanceof MemoryPg) {
      return this.claimMemory(tenantId, workerId, limit, leaseMs, maxAttempts);
    }
    const now = this.now().toISOString();
    const claimed: Array<{ derivative: SecureFileDerivative; claim_token: string }> = [];
    await withPgTenant(this.pg, tenantId, async (pg) => {
      await pg.query(
        `UPDATE collaboration_secure_file_derivatives
         SET status = 'failed', error_code = 'derivative_attempts_exhausted',
             lease_token_hash = '', lease_until = NULL, worker_id = '',
             next_attempt_at = NULL, completed_at = $2, updated_at = $2
         WHERE tenant_id = $1 AND status = 'processing'
           AND attempt_count >= $3 AND lease_until IS NOT NULL AND lease_until <= $2`,
        [tenantId, now, maxAttempts]
      );
      for (let index = 0; index < limit; index += 1) {
        const claimToken = randomUUID();
        const tokenHash = sha256(claimToken);
        const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
        const result = await pg.query(
          `WITH candidate AS (
             SELECT derivative.secure_file_id, derivative.derivative_kind
             FROM collaboration_secure_file_derivatives derivative
             JOIN collaboration_secure_files file
               ON file.tenant_id = derivative.tenant_id
              AND file.id = derivative.secure_file_id
             WHERE derivative.tenant_id = $1 AND file.status = 'processing'
               AND derivative.status IN ('pending', 'processing', 'retry_wait')
               AND derivative.attempt_count < $6
               AND (derivative.next_attempt_at IS NULL OR derivative.next_attempt_at <= $2)
               AND (derivative.status != 'processing' OR derivative.lease_until <= $2)
             ORDER BY COALESCE(derivative.next_attempt_at, derivative.updated_at),
                      derivative.updated_at, derivative.secure_file_id, derivative.derivative_kind
             FOR UPDATE OF derivative SKIP LOCKED
             LIMIT 1
           )
           UPDATE collaboration_secure_file_derivatives derivative
           SET status = 'processing', attempt_count = attempt_count + 1,
               worker_id = $3, lease_token_hash = $4, lease_until = $5,
               next_attempt_at = NULL, error_code = '', updated_at = $2
           FROM candidate
           WHERE derivative.tenant_id = $1
             AND derivative.secure_file_id = candidate.secure_file_id
             AND derivative.derivative_kind = candidate.derivative_kind
           RETURNING derivative.*`,
          [tenantId, now, workerId, tokenHash, leaseUntil, maxAttempts]
        );
        if (!result.rows[0]) break;
        claimed.push({ derivative: decodeDerivative(result.rows[0]), claim_token: claimToken });
      }
    });
    const files = new Map<string, SecureFile>();
    return Promise.all(claimed.map(async (claim) => {
      let file = files.get(claim.derivative.secure_file_id);
      if (!file) {
        file = await this.files.getFile(tenantId, claim.derivative.secure_file_id);
        files.set(file.id, file);
      }
      return { file, derivative: claim.derivative, claim_token: claim.claim_token };
    }));
  }

  async finishJob(input: {
    tenant_id: string;
    secure_file_id: string;
    derivative_kind: SecureFileDerivativeKind;
    worker_id: string;
    claim_token: string;
    outcome: SecureFileDerivativeOutcome;
    object_key?: string;
    mime?: string;
    size_bytes?: number;
    sha256?: string;
    error_code?: string;
    next_attempt_at?: string | null;
    provider_request_id?: string;
    provider_metadata?: Record<string, unknown>;
  }): Promise<SecureFileDerivative> {
    const normalized = normalizeFinishInput(input);
    if (this.pg instanceof MemoryPg) return this.finishMemory(normalized);
    const now = this.now().toISOString();
    return withPgTenant(this.pg, normalized.tenant_id, async (pg) => {
      const fields = finishFields(normalized, now);
      const result = await pg.query(
        `UPDATE collaboration_secure_file_derivatives
         SET status = $7, object_key = $8, mime = $9, size_bytes = $10,
             sha256 = $11, error_code = $12, next_attempt_at = $13::TIMESTAMPTZ,
             provider_request_id = $14, provider_metadata = $15::JSONB,
             lease_token_hash = '', lease_until = NULL, worker_id = '',
             completed_at = $16::TIMESTAMPTZ, updated_at = $6
         WHERE tenant_id = $1 AND secure_file_id = $2 AND derivative_kind = $3
           AND status = 'processing' AND worker_id = $4
           AND lease_token_hash = $5 AND lease_until > $6
         RETURNING *`,
        [
          normalized.tenant_id, normalized.secure_file_id, normalized.derivative_kind,
          normalized.worker_id, normalized.claim_token_hash, now,
          fields.status, fields.object_key, fields.mime, fields.size_bytes, fields.sha256,
          fields.error_code, fields.next_attempt_at, normalized.provider_request_id,
          JSON.stringify(normalized.provider_metadata), fields.completed_at
        ]
      );
      if (result.rows[0]) return decodeDerivative(result.rows[0]);
      const existing = await pg.query(
        `SELECT 1 FROM collaboration_secure_file_derivatives
         WHERE tenant_id = $1 AND secure_file_id = $2 AND derivative_kind = $3`,
        [normalized.tenant_id, normalized.secure_file_id, normalized.derivative_kind]
      );
      if (!existing.rows[0]) {
        throw derivativeStoreError('secure file derivative not found', 404, 'derivative_not_found');
      }
      throw derivativeStoreError('secure file derivative claim is stale', 409, 'derivative_claim_stale');
    });
  }

  async convergeFile(input: { tenant_id: string; secure_file_id: string }): Promise<SecureFile> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const secureFileId = requiredText(input.secure_file_id, 'secure_file_id');
    const file = await this.files.getFile(tenantId, secureFileId);
    if (file.status !== 'processing') return file;
    const required = requiredDerivativeKinds(file.detected_mime);
    const jobs = await this.listJobs(tenantId, secureFileId);
    const byKind = new Map(jobs.map((job) => [job.derivative_kind, job]));
    if (required.some((kind) => !byKind.has(kind))) return file;
    if (required.some((kind) => byKind.get(kind)?.status === 'failed')) {
      return this.files.transitionStatus({
        tenant_id: tenantId,
        secure_file_id: secureFileId,
        from_status: 'processing',
        to_status: 'failed',
        failure_code: 'required_derivative_failed'
      });
    }
    if (required.every((kind) => byKind.get(kind)?.status === 'ready')) {
      const ready = await this.files.transitionStatus({
        tenant_id: tenantId,
        secure_file_id: secureFileId,
        from_status: 'processing',
        to_status: 'ready'
      });
      if (this.pg instanceof MemoryPg) {
        memoryState(this.pg).processingFiles.delete(fileKey(tenantId, secureFileId));
      }
      return ready;
    }
    return file;
  }

  private async claimMemory(
    tenantId: string,
    workerId: string,
    limit: number,
    leaseMs: number,
    maxAttempts: number
  ): Promise<SecureFileDerivativeClaim[]> {
    const state = memoryState(this.pg as MemoryPg);
    const now = this.now();
    const nowIso = now.toISOString();
    const candidates = [...state.jobs.values()]
      .filter((job) => job.tenant_id === tenantId && derivativeIsDue(job, nowIso))
      .sort((left, right) =>
        String(left.next_attempt_at || left.updated_at).localeCompare(
          String(right.next_attempt_at || right.updated_at)
        ) || left.secure_file_id.localeCompare(right.secure_file_id) ||
        left.derivative_kind.localeCompare(right.derivative_kind)
      );
    const claims: SecureFileDerivativeClaim[] = [];
    for (const job of candidates) {
      if (claims.length >= limit) break;
      const file = await this.files.getFile(tenantId, job.secure_file_id);
      if (file.status !== 'processing') continue;
      if (job.attempt_count >= maxAttempts) {
        job.status = 'failed';
        job.error_code = 'derivative_attempts_exhausted';
        job.completed_at = nowIso;
        clearLease(job);
        continue;
      }
      const claimToken = randomUUID();
      job.status = 'processing';
      job.attempt_count += 1;
      job.worker_id = workerId;
      job.lease_token_hash = sha256(claimToken);
      job.lease_until = new Date(now.getTime() + leaseMs).toISOString();
      job.next_attempt_at = null;
      job.error_code = '';
      job.updated_at = nowIso;
      claims.push({ file, derivative: publicDerivative(job), claim_token: claimToken });
    }
    return claims;
  }

  private finishMemory(input: NormalizedFinishInput): SecureFileDerivative {
    const state = memoryState(this.pg as MemoryPg);
    const job = state.jobs.get(derivativeKey(
      input.tenant_id, input.secure_file_id, input.derivative_kind
    ));
    if (!job) throw derivativeStoreError('secure file derivative not found', 404, 'derivative_not_found');
    const now = this.now().toISOString();
    if (
      job.status !== 'processing' || job.worker_id !== input.worker_id ||
      job.lease_token_hash !== input.claim_token_hash || !job.lease_until || job.lease_until <= now
    ) {
      throw derivativeStoreError('secure file derivative claim is stale', 409, 'derivative_claim_stale');
    }
    const fields = finishFields(input, now);
    job.status = fields.status;
    job.object_key = fields.object_key;
    job.mime = fields.mime;
    job.size_bytes = fields.size_bytes;
    job.sha256 = fields.sha256;
    job.error_code = fields.error_code;
    job.next_attempt_at = fields.next_attempt_at;
    job.provider_request_id = input.provider_request_id;
    job.provider_metadata = { ...input.provider_metadata };
    job.completed_at = fields.completed_at;
    job.updated_at = now;
    clearLease(job);
    return publicDerivative(job);
  }
}

export function requiredDerivativeKinds(mimeInput: string): SecureFileDerivativeKind[] {
  const mime = String(mimeInput || '').trim().toLowerCase();
  if (mime.startsWith('image/')) return ['image_thumbnail'];
  if (mime.startsWith('video/')) return ['video_thumbnail', 'video_transcode'];
  if (mime.startsWith('audio/')) return ['audio_transcode'];
  return [];
}

interface NormalizedFinishInput {
  tenant_id: string;
  secure_file_id: string;
  derivative_kind: SecureFileDerivativeKind;
  worker_id: string;
  claim_token_hash: string;
  outcome: SecureFileDerivativeOutcome;
  object_key: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  error_code: string;
  next_attempt_at: string | null;
  provider_request_id: string;
  provider_metadata: Record<string, unknown>;
}

function normalizeFinishInput(input: {
  tenant_id: string;
  secure_file_id: string;
  derivative_kind: SecureFileDerivativeKind;
  worker_id: string;
  claim_token: string;
  outcome: SecureFileDerivativeOutcome;
  object_key?: string;
  mime?: string;
  size_bytes?: number;
  sha256?: string;
  error_code?: string;
  next_attempt_at?: string | null;
  provider_request_id?: string;
  provider_metadata?: Record<string, unknown>;
}): NormalizedFinishInput {
  const outcome = derivativeOutcome(input.outcome);
  const nextAttemptAt = optionalTimestamp(input.next_attempt_at, 'next_attempt_at');
  if (outcome === 'retry_wait' && !nextAttemptAt) {
    throw derivativeStoreError('next_attempt_at is required for retry', 400, 'next_attempt_at_required');
  }
  const objectKey = outcome === 'ready'
    ? boundedSingleLine(input.object_key, 'object_key', 1024)
    : '';
  const mime = outcome === 'ready' ? mimeValue(input.mime) : '';
  const sizeBytes = outcome === 'ready'
    ? boundedInteger(input.size_bytes, 1, 10 * 1024 * 1024 * 1024, 'size_bytes')
    : 0;
  const checksum = outcome === 'ready' ? sha256Value(input.sha256) : '';
  return {
    tenant_id: requiredText(input.tenant_id, 'tenant_id'),
    secure_file_id: requiredText(input.secure_file_id, 'secure_file_id'),
    derivative_kind: derivativeKind(input.derivative_kind),
    worker_id: boundedSingleLine(input.worker_id, 'worker_id', 255),
    claim_token_hash: sha256(boundedSingleLine(input.claim_token, 'claim_token', 255)),
    outcome,
    object_key: objectKey,
    mime,
    size_bytes: sizeBytes,
    sha256: checksum,
    error_code: safeCode(input.error_code || (outcome === 'failed' ? 'derivative_failed' : '')),
    next_attempt_at: nextAttemptAt,
    provider_request_id: sanitizeProviderRequestId(input.provider_request_id),
    provider_metadata: sanitizeProviderMetadata(input.provider_metadata)
  };
}

function finishFields(input: NormalizedFinishInput, now: string) {
  if (input.outcome === 'ready') {
    return {
      status: 'ready' as const,
      object_key: input.object_key,
      mime: input.mime,
      size_bytes: input.size_bytes,
      sha256: input.sha256,
      error_code: '',
      next_attempt_at: null,
      completed_at: now
    };
  }
  if (input.outcome === 'retry_wait') {
    return {
      status: 'retry_wait' as const,
      object_key: '', mime: '', size_bytes: 0, sha256: '',
      error_code: input.error_code || 'derivative_retry',
      next_attempt_at: input.next_attempt_at,
      completed_at: null
    };
  }
  return {
    status: 'failed' as const,
    object_key: '', mime: '', size_bytes: 0, sha256: '',
    error_code: input.error_code || 'derivative_failed',
    next_attempt_at: null,
    completed_at: now
  };
}

function decodeDerivative(row: Record<string, unknown>): SecureFileDerivative {
  return {
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    secure_file_id: String(row.secure_file_id),
    derivative_kind: derivativeKind(row.derivative_kind),
    status: derivativeStatus(row.status),
    object_key: String(row.object_key || ''),
    mime: String(row.mime || ''),
    size_bytes: Number(row.size_bytes || 0),
    sha256: String(row.sha256 || ''),
    provider_profile_id: String(row.provider_profile_id || ''),
    provider_request_id: String(row.provider_request_id || ''),
    provider_metadata: jsonObject(row.provider_metadata),
    attempt_count: Number(row.attempt_count || 0),
    next_attempt_at: nullableTimestamp(row.next_attempt_at),
    lease_until: nullableTimestamp(row.lease_until),
    worker_id: String(row.worker_id || ''),
    error_code: String(row.error_code || ''),
    retention_until: nullableTimestamp(row.retention_until),
    expires_at: nullableTimestamp(row.expires_at),
    created_at: timestampText(row.created_at),
    updated_at: timestampText(row.updated_at),
    completed_at: nullableTimestamp(row.completed_at)
  };
}

function publicDerivative(job: SecureFileDerivativeInternal): SecureFileDerivative {
  const { lease_token_hash: _leaseTokenHash, ...result } = job;
  return structuredClone(result);
}

function memoryState(pg: MemoryPg): MemoryDerivativeState {
  let state = memoryStates.get(pg);
  if (!state) {
    state = { jobs: new Map(), processingFiles: new Set() };
    memoryStates.set(pg, state);
  }
  return state;
}

function clearLease(job: SecureFileDerivativeInternal): void {
  job.lease_token_hash = '';
  job.lease_until = null;
  job.worker_id = '';
}

function derivativeIsDue(job: SecureFileDerivative, now: string): boolean {
  return (job.status === 'pending' || job.status === 'retry_wait' || job.status === 'processing') &&
    (!job.next_attempt_at || job.next_attempt_at <= now) &&
    (job.status !== 'processing' || Boolean(job.lease_until && job.lease_until <= now));
}

function derivativeKey(
  tenantId: string,
  secureFileId: string,
  kind: SecureFileDerivativeKind
): string {
  return `${tenantId}\u0000${secureFileId}\u0000${kind}`;
}

function fileKey(tenantId: string, secureFileId: string): string {
  return `${tenantId}\u0000${secureFileId}`;
}

function derivativeKind(value: unknown): SecureFileDerivativeKind {
  if (
    value === 'image_thumbnail' || value === 'video_thumbnail' ||
    value === 'video_transcode' || value === 'audio_transcode'
  ) return value;
  throw derivativeStoreError('derivative kind is invalid', 400, 'derivative_kind_invalid');
}

function derivativeOutcome(value: unknown): SecureFileDerivativeOutcome {
  if (value === 'ready' || value === 'retry_wait' || value === 'failed') return value;
  throw derivativeStoreError('derivative outcome is invalid', 400, 'derivative_outcome_invalid');
}

function derivativeStatus(value: unknown): SecureFileDerivative['status'] {
  if (
    value === 'pending' || value === 'processing' || value === 'retry_wait' ||
    value === 'ready' || value === 'failed' || value === 'expired'
  ) return value;
  throw derivativeStoreError('derivative status is invalid', 500, 'derivative_status_invalid');
}

function requiredText(value: unknown, field: string): string {
  return boundedSingleLine(value, field, 255);
}

function boundedSingleLine(
  value: unknown,
  field: string,
  max: number
): string {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text)) {
    throw derivativeStoreError(`${field} is invalid`, 400, `${field}_invalid`);
  }
  return text;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  field: string
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw derivativeStoreError(`${field} is invalid`, 400, `${field}_invalid`);
  }
  return number;
}

function optionalTimestamp(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw derivativeStoreError(`${field} is invalid`, 400, `${field}_invalid`);
  }
  return date.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  return timestampText(value);
}

function timestampText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value || '');
}

function mimeValue(value: unknown): string {
  const mime = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)) {
    throw derivativeStoreError('mime is invalid', 400, 'mime_invalid');
  }
  return mime;
}

function sha256Value(value: unknown): string {
  const checksum = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw derivativeStoreError('sha256 is invalid', 400, 'sha256_invalid');
  }
  return checksum;
}

function safeCode(value: unknown): string {
  return String(value || '')
    .trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 100);
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function derivativeStoreError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}
