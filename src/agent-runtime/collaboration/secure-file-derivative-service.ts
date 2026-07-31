import { createHash } from 'node:crypto';

import type {
  ObjectStorage,
  ObjectStorageUploadResult
} from '../../storage/object-storage.js';
import {
  FileDerivativeProviderError,
  ffmpegDerivativeSpec,
  type FileDerivativeOutput,
  type FileDerivativeProvider
} from './file-derivative-provider.js';
import {
  SecureFileDerivativeStore,
  type SecureFileDerivativeClaim,
  type SecureFileDerivativeOutcome
} from './secure-file-derivative-store.js';
import type { SecureFile, SecureFileDerivative } from './secure-file-types.js';

const DEFAULT_MAX_SOURCE_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 500 * 1024 * 1024;

export interface SecureFileDerivativeRunSummary {
  tenants: number;
  files_planned: number;
  claimed: number;
  ready: number;
  retry_wait: number;
  failed: number;
  files_ready: number;
  files_failed: number;
}

export interface SecureFileDerivativeServiceInput {
  store: SecureFileDerivativeStore;
  objectStorage: ObjectStorage;
  provider: FileDerivativeProvider;
  workerId: string;
  now?: () => Date;
  maxAttempts?: number;
  claimLeaseMs?: number;
  retryDelaysMs?: number[];
  maxSourceBytes?: number;
  maxOutputBytes?: number;
  providerProfileId?: string;
  onProcessed?: (input: {
    derivative: SecureFileDerivative;
    file: SecureFile;
  }) => void | Promise<void>;
  onFileConverged?: (file: SecureFile) => void | Promise<void>;
}

interface DerivativeDecision {
  outcome: SecureFileDerivativeOutcome;
  error_code?: string;
  next_attempt_at?: string;
  output?: {
    object_key: string;
    mime: string;
    size_bytes: number;
    sha256: string;
    provider_request_id?: string;
    provider_metadata: Record<string, unknown>;
  };
}

class DerivativeWorkError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super('secure file derivative work failed');
    this.name = 'DerivativeWorkError';
  }
}

export class SecureFileDerivativeService {
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly claimLeaseMs: number;
  private readonly retryDelaysMs: number[];
  private readonly maxSourceBytes: number;
  private readonly maxOutputBytes: number;
  private readonly workerId: string;
  private readonly providerProfileId: string;

  constructor(private readonly input: SecureFileDerivativeServiceInput) {
    this.now = input.now || (() => new Date());
    this.maxAttempts = boundedInteger(input.maxAttempts ?? 3, 1, 10, 'maxAttempts');
    this.claimLeaseMs = boundedInteger(
      input.claimLeaseMs ?? 120_000, 5_000, 30 * 60_000, 'claimLeaseMs'
    );
    this.retryDelaysMs = normalizeRetryDelays(input.retryDelaysMs || [5_000, 30_000]);
    this.maxSourceBytes = boundedInteger(
      input.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
      1,
      10 * 1024 * 1024 * 1024,
      'maxSourceBytes'
    );
    this.maxOutputBytes = boundedInteger(
      input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      1,
      10 * 1024 * 1024 * 1024,
      'maxOutputBytes'
    );
    this.workerId = requiredText(input.workerId, 'workerId');
    this.providerProfileId = requiredText(
      input.providerProfileId || input.provider.name,
      'providerProfileId'
    );
  }

  async runDue(input: {
    tenant_id?: string;
    limit?: number;
  } = {}): Promise<SecureFileDerivativeRunSummary> {
    const limit = boundedInteger(input.limit ?? 25, 1, 100, 'limit');
    const tenantIds = input.tenant_id
      ? [requiredText(input.tenant_id, 'tenant_id')]
      : await this.input.store.discoverTenantIds({ limit: 100 });
    const summary = emptySummary();
    summary.tenants = tenantIds.length;
    for (const tenantId of tenantIds) {
      const processingFiles = await this.input.store.listProcessingFiles({
        tenant_id: tenantId,
        limit
      });
      for (const file of processingFiles) {
        await this.input.store.ensureJobs({
          tenant_id: tenantId,
          secure_file_id: file.id,
          provider_profile_id: this.providerProfileId
        });
        summary.files_planned += 1;
        const converged = await this.input.store.convergeFile({
          tenant_id: tenantId,
          secure_file_id: file.id
        });
        if (countConvergedFile(summary, file, converged)) {
          await this.input.onFileConverged?.(converged);
        }
      }
      const remaining = limit - summary.claimed;
      if (remaining <= 0) break;
      const claims = await this.input.store.claimJobs({
        tenant_id: tenantId,
        worker_id: this.workerId,
        limit: remaining,
        lease_ms: this.claimLeaseMs,
        max_attempts: this.maxAttempts
      });
      summary.claimed += claims.length;
      for (const claim of claims) await this.processClaim(claim, summary);
    }
    return summary;
  }

  private async processClaim(
    claim: SecureFileDerivativeClaim,
    summary: SecureFileDerivativeRunSummary
  ): Promise<void> {
    let decision: DerivativeDecision;
    try {
      const currentFile = await this.input.store.getFile(
        claim.file.tenant_id,
        claim.file.id
      );
      if (currentFile.status !== 'processing') {
        throw new DerivativeWorkError('parent_file_not_processing', false);
      }
      decision = await this.produce(claim);
    } catch (error) {
      decision = this.failureDecision(claim, error);
    }
    const derivative = await this.input.store.finishJob({
      tenant_id: claim.file.tenant_id,
      secure_file_id: claim.file.id,
      derivative_kind: claim.derivative.derivative_kind,
      worker_id: this.workerId,
      claim_token: claim.claim_token,
      outcome: decision.outcome,
      ...(decision.output || {}),
      error_code: decision.error_code,
      next_attempt_at: decision.next_attempt_at
    });
    summary[decision.outcome] += 1;
    const file = await this.input.store.convergeFile({
      tenant_id: claim.file.tenant_id,
      secure_file_id: claim.file.id
    });
    const fileChanged = countConvergedFile(summary, claim.file, file);
    await this.input.onProcessed?.({ derivative, file });
    if (fileChanged) await this.input.onFileConverged?.(file);
  }

  private async produce(claim: SecureFileDerivativeClaim): Promise<DerivativeDecision> {
    const source = await this.input.objectStorage.download(
      claim.file.object_key,
      this.maxSourceBytes
    );
    if (!source) throw new DerivativeWorkError('source_object_not_found', false);
    if (source.length !== claim.file.size_bytes) {
      throw new DerivativeWorkError('source_size_mismatch', false);
    }
    if (sha256(source) !== claim.file.sha256) {
      throw new DerivativeWorkError('source_checksum_mismatch', false);
    }
    const output = await this.input.provider.derive({
      tenant_id: claim.file.tenant_id,
      secure_file_id: claim.file.id,
      derivative_kind: claim.derivative.derivative_kind,
      source_mime: claim.file.detected_mime,
      content: source
    });
    this.validateOutput(claim, output);
    const checksum = sha256(output.content);
    const uploaded = await this.publishOutput(claim, output, checksum);
    return {
      outcome: 'ready',
      output: {
        object_key: uploaded.key,
        mime: output.mime,
        size_bytes: output.content.length,
        sha256: checksum,
        provider_request_id: output.provider_request_id,
        provider_metadata: output.metadata
      }
    };
  }

  private validateOutput(
    claim: SecureFileDerivativeClaim,
    output: FileDerivativeOutput
  ): void {
    if (!Buffer.isBuffer(output.content) || output.content.length === 0) {
      throw new DerivativeWorkError('derivative_output_empty', false);
    }
    if (output.content.length > this.maxOutputBytes) {
      throw new DerivativeWorkError('derivative_output_too_large', false);
    }
    const expected = ffmpegDerivativeSpec(
      claim.derivative.derivative_kind,
      claim.file.detected_mime,
      'input',
      'output'
    );
    if (output.mime !== expected.mime || output.extension !== expected.extension) {
      throw new DerivativeWorkError('derivative_output_contract_invalid', false);
    }
  }

  private async publishOutput(
    claim: SecureFileDerivativeClaim,
    output: FileDerivativeOutput,
    checksum: string
  ): Promise<ObjectStorageUploadResult> {
    const resourceId = `${claim.file.id}-${claim.derivative.derivative_kind}`;
    try {
      return await this.input.objectStorage.upload({
        tenantId: claim.file.tenant_id,
        filename: `derivative${output.extension}`,
        body: output.content,
        contentType: output.mime,
        keyPrefix: 'secure-file-derivatives',
        resourceId
      });
    } catch (error) {
      if (Number((error as { status?: unknown })?.status || 0) !== 409) throw error;
      const key = [
        safeObjectSegment(claim.file.tenant_id),
        'secure-file-derivatives',
        safeObjectSegment(resourceId)
      ].join('/');
      const existing = await this.input.objectStorage.download(key, this.maxOutputBytes);
      if (!existing || existing.length !== output.content.length || sha256(existing) !== checksum) {
        throw new DerivativeWorkError('derivative_output_conflict', false);
      }
      const head = await this.input.objectStorage.head(key);
      if (!head) throw new DerivativeWorkError('derivative_output_conflict', false);
      return { ...head, storage_url: `private://${key}` };
    }
  }

  private failureDecision(
    claim: SecureFileDerivativeClaim,
    error: unknown
  ): DerivativeDecision {
    const providerError = error instanceof FileDerivativeProviderError ? error : null;
    const workError = error instanceof DerivativeWorkError ? error : null;
    const status = Number((error as { status?: unknown })?.status || 0);
    const code = safeCode(
      workError?.code || providerError?.code ||
      (error as { code?: unknown })?.code ||
      (status ? `derivative_storage_${status}` : 'derivative_worker_error')
    );
    const retryable = workError?.retryable === true || providerError?.retryable === true ||
      status === 408 || status === 425 || status === 429 || status >= 500;
    if (retryable && claim.derivative.attempt_count < this.maxAttempts) {
      const delay = this.retryDelaysMs[Math.min(
        claim.derivative.attempt_count - 1,
        this.retryDelaysMs.length - 1
      )];
      return {
        outcome: 'retry_wait',
        error_code: code,
        next_attempt_at: new Date(this.now().getTime() + delay).toISOString()
      };
    }
    return { outcome: 'failed', error_code: code };
  }
}

function countConvergedFile(
  summary: SecureFileDerivativeRunSummary,
  before: SecureFile,
  after: SecureFile
): boolean {
  if (before.status === after.status) return false;
  if (after.status === 'ready') summary.files_ready += 1;
  if (after.status === 'failed') summary.files_failed += 1;
  return after.status === 'ready' || after.status === 'failed';
}

function emptySummary(): SecureFileDerivativeRunSummary {
  return {
    tenants: 0,
    files_planned: 0,
    claimed: 0,
    ready: 0,
    retry_wait: 0,
    failed: 0,
    files_ready: 0,
    files_failed: 0
  };
}

function normalizeRetryDelays(value: number[]): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new Error('retryDelaysMs must contain between 1 and 10 delays');
  }
  return value.map((delay) => boundedInteger(delay, 0, 3_600_000, 'retryDelaysMs'));
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  const text = String(value || '').trim();
  if (!text || text.length > 255 || /[\r\n\0]/.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function safeObjectSegment(value: string): string {
  const segment = requiredText(value, 'object key segment').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (segment === '.' || segment === '..') throw new Error('object key segment is invalid');
  return segment;
}

function safeCode(value: unknown): string {
  return String(value || '')
    .trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 100) || 'derivative_worker_error';
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
