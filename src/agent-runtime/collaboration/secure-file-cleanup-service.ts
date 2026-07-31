import type { ObjectStorage } from '../../storage/object-storage.js';
import { SecureFileDerivativeStore } from './secure-file-derivative-store.js';
import {
  SecureFileStore,
  type SecureFileCleanupClaim
} from './secure-file-store.js';
import type { SecureFile, SecureFileStatus } from './secure-file-types.js';

export interface SecureFileCleanupItem {
  secure_file_id: string;
  prior_status: SecureFileStatus;
  outcome: 'would_expire' | 'expired' | 'retry_wait';
  object_count: number;
  cleanup_attempt_count: number;
  error_code: string;
}

export interface SecureFileCleanupResult {
  dry_run: boolean;
  candidates: number;
  claimed: number;
  expired: number;
  retry_wait: number;
  objects_deleted: number;
  objects_missing: number;
  items: SecureFileCleanupItem[];
}

export interface SecureFileCleanupServiceInput {
  store: SecureFileStore;
  derivativeStore: SecureFileDerivativeStore;
  objectStorage: ObjectStorage;
  workerId: string;
  now?: () => Date;
  uploadStaleMs?: number;
  claimLeaseMs?: number;
  retryDelayMs?: number;
  onProcessed?: (input: {
    file: SecureFile;
    outcome: 'expired' | 'retry_wait';
    error_code: string;
  }) => void | Promise<void>;
}

export class SecureFileCleanupService {
  private readonly now: () => Date;
  private readonly workerId: string;
  private readonly uploadStaleMs: number;
  private readonly claimLeaseMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly input: SecureFileCleanupServiceInput) {
    this.now = input.now || (() => new Date());
    this.workerId = requiredText(input.workerId, 'workerId');
    this.uploadStaleMs = boundedInteger(
      input.uploadStaleMs ?? 24 * 60 * 60_000,
      60_000,
      30 * 24 * 60 * 60_000,
      'uploadStaleMs'
    );
    this.claimLeaseMs = boundedInteger(
      input.claimLeaseMs ?? 120_000,
      5_000,
      30 * 60_000,
      'claimLeaseMs'
    );
    this.retryDelayMs = boundedInteger(
      input.retryDelayMs ?? 60_000,
      1_000,
      24 * 60 * 60_000,
      'retryDelayMs'
    );
  }

  async run(input: {
    tenant_id?: string;
    dry_run?: boolean;
    confirm?: boolean;
    limit?: number;
  } = {}): Promise<SecureFileCleanupResult> {
    const dryRun = input.dry_run !== false;
    if (!dryRun && input.confirm !== true) {
      throw new Error('confirm=true is required for destructive secure file cleanup');
    }
    const limit = boundedInteger(input.limit ?? 25, 1, 100, 'limit');
    const tenantIds = input.tenant_id
      ? [requiredText(input.tenant_id, 'tenant_id')]
      : await this.input.store.discoverCleanupTenantIds({
          upload_stale_ms: this.uploadStaleMs,
          limit: 100
        });
    const result = emptyResult(dryRun);
    for (const tenantId of tenantIds) {
      const remaining = limit - (dryRun ? result.candidates : result.claimed);
      if (remaining <= 0) break;
      if (dryRun) {
        const candidates = await this.input.store.listCleanupCandidates({
          tenant_id: tenantId,
          upload_stale_ms: this.uploadStaleMs,
          limit: remaining
        });
        result.candidates += candidates.length;
        for (const file of candidates) {
          const keys = await this.objectKeys(file);
          result.items.push({
            secure_file_id: file.id,
            prior_status: file.status,
            outcome: 'would_expire',
            object_count: keys.length,
            cleanup_attempt_count: 0,
            error_code: ''
          });
        }
        continue;
      }
      const claims = await this.input.store.claimCleanupJobs({
        tenant_id: tenantId,
        worker_id: this.workerId,
        upload_stale_ms: this.uploadStaleMs,
        limit: remaining,
        lease_ms: this.claimLeaseMs
      });
      result.candidates += claims.length;
      result.claimed += claims.length;
      for (const claim of claims) await this.processClaim(claim, result);
    }
    return result;
  }

  private async processClaim(
    claim: SecureFileCleanupClaim,
    result: SecureFileCleanupResult
  ): Promise<void> {
    const keys = await this.objectKeys(claim.file);
    try {
      for (const key of keys) {
        const deleted = await this.input.objectStorage.delete(key);
        if (deleted === 'deleted') result.objects_deleted += 1;
        else result.objects_missing += 1;
      }
      await this.input.derivativeStore.expireJobs({
        tenant_id: claim.file.tenant_id,
        secure_file_id: claim.file.id
      });
      const file = await this.input.store.finishCleanupJob({
        tenant_id: claim.file.tenant_id,
        secure_file_id: claim.file.id,
        worker_id: this.workerId,
        claim_token: claim.claim_token,
        outcome: 'expired'
      });
      result.expired += 1;
      result.items.push({
        secure_file_id: file.id,
        prior_status: claim.file.status,
        outcome: 'expired',
        object_count: keys.length,
        cleanup_attempt_count: claim.cleanup_attempt_count,
        error_code: ''
      });
      await this.input.onProcessed?.({ file, outcome: 'expired', error_code: '' });
    } catch (error) {
      const errorCode = safeCode(
        (error as { code?: unknown })?.code ||
        (Number((error as { status?: unknown })?.status || 0)
          ? `cleanup_storage_${Number((error as { status?: unknown })?.status)}`
          : 'cleanup_worker_error')
      );
      const file = await this.input.store.finishCleanupJob({
        tenant_id: claim.file.tenant_id,
        secure_file_id: claim.file.id,
        worker_id: this.workerId,
        claim_token: claim.claim_token,
        outcome: 'retry_wait',
        error_code: errorCode,
        next_attempt_at: new Date(this.now().getTime() + this.retryDelayMs).toISOString()
      });
      result.retry_wait += 1;
      result.items.push({
        secure_file_id: file.id,
        prior_status: claim.file.status,
        outcome: 'retry_wait',
        object_count: keys.length,
        cleanup_attempt_count: claim.cleanup_attempt_count,
        error_code: errorCode
      });
      await this.input.onProcessed?.({ file, outcome: 'retry_wait', error_code: errorCode });
    }
  }

  private async objectKeys(file: SecureFile): Promise<string[]> {
    const [parts, derivatives] = await Promise.all([
      this.input.store.listParts(file.tenant_id, file.id),
      this.input.derivativeStore.listJobs(file.tenant_id, file.id)
    ]);
    return [...new Set([
      file.object_key,
      ...parts.map((part) => part.object_key),
      ...derivatives.map((derivative) => derivative.object_key)
    ].filter(Boolean))];
  }
}

function emptyResult(dryRun: boolean): SecureFileCleanupResult {
  return {
    dry_run: dryRun,
    candidates: 0,
    claimed: 0,
    expired: 0,
    retry_wait: 0,
    objects_deleted: 0,
    objects_missing: 0,
    items: []
  };
}

function requiredText(value: unknown, field: string): string {
  const text = String(value || '').trim();
  if (!text || text.length > 255 || /[\r\n\0]/.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

function safeCode(value: unknown): string {
  return String(value || '')
    .trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 100) || 'cleanup_worker_error';
}
