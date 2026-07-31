import { createHash } from 'node:crypto';

import type { ObjectStorage } from '../../storage/object-storage.js';
import type { SecureFile } from './secure-file-types.js';
import {
  SecureFileStore,
  type SecureFileScanClaim,
  type SecureFileScanOutcome
} from './secure-file-store.js';
import { detectSecureFileMime, type SecureFileMimeResult } from './secure-file-mime.js';
import {
  FileThreatScannerError,
  type FileThreatScanResult,
  type FileThreatScanner
} from './file-threat-scanner.js';

const DEFAULT_MAX_SCAN_BYTES = 100 * 1024 * 1024;

export interface SecureFileScanServiceInput {
  store: SecureFileStore;
  objectStorage: ObjectStorage;
  scanner: FileThreatScanner;
  workerId: string;
  now?: () => Date;
  maxAttempts?: number;
  claimLeaseMs?: number;
  retryDelaysMs?: number[];
  maxScanBytes?: number;
  mimeConflictAction?: 'reject' | 'quarantine';
  onProcessed?: (file: SecureFile) => void | Promise<void>;
}

export interface SecureFileScanRunSummary {
  candidates: number;
  claimed: number;
  clean: number;
  quarantined: number;
  retry_wait: number;
  failed: number;
}

interface ScanDecision {
  outcome: SecureFileScanOutcome;
  detected_mime?: string;
  mime_conflict?: boolean;
  failure_code?: string;
  next_attempt_at?: string;
  scanner_request_id?: string;
  scan_metadata?: Record<string, unknown>;
}

export class SecureFileScanService {
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly claimLeaseMs: number;
  private readonly retryDelaysMs: number[];
  private readonly maxScanBytes: number;
  private readonly mimeConflictAction: 'reject' | 'quarantine';

  constructor(private readonly input: SecureFileScanServiceInput) {
    this.now = input.now || (() => new Date());
    this.maxAttempts = boundedInteger(input.maxAttempts ?? 3, 1, 10, 'maxAttempts');
    this.claimLeaseMs = boundedInteger(input.claimLeaseMs ?? 60_000, 5_000, 600_000, 'claimLeaseMs');
    this.retryDelaysMs = normalizeRetryDelays(input.retryDelaysMs || [2_000, 10_000]);
    this.maxScanBytes = boundedInteger(
      input.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES,
      1,
      10 * 1024 * 1024 * 1024,
      'maxScanBytes'
    );
    this.mimeConflictAction = input.mimeConflictAction || 'quarantine';
    if (this.mimeConflictAction !== 'quarantine' && this.mimeConflictAction !== 'reject') {
      throw new Error('mimeConflictAction must be reject or quarantine');
    }
  }

  async runDue(input: { tenant_id?: string; limit?: number } = {}): Promise<SecureFileScanRunSummary> {
    const limit = boundedInteger(input.limit ?? 25, 1, 100, 'limit');
    const summary = emptySummary();
    const tenantIds = input.tenant_id
      ? [requiredText(input.tenant_id, 'tenant_id')]
      : await this.input.store.discoverScanTenantIds({ limit });
    for (const tenantId of tenantIds) {
      const remaining = limit - summary.claimed;
      if (remaining <= 0) break;
      const claims = await this.input.store.claimScanJobs({
        tenant_id: tenantId,
        worker_id: requiredText(this.input.workerId, 'workerId'),
        limit: remaining,
        lease_ms: this.claimLeaseMs,
        max_attempts: this.maxAttempts
      });
      summary.candidates += claims.length;
      summary.claimed += claims.length;
      for (const claim of claims) {
        const outcome = await this.processClaim(claim);
        summary[outcome] += 1;
      }
    }
    return summary;
  }

  private async processClaim(
    claim: SecureFileScanClaim
  ): Promise<'clean' | 'quarantined' | 'retry_wait' | 'failed'> {
    let decision: ScanDecision;
    try {
      decision = await this.inspect(claim.file);
    } catch (error) {
      decision = this.failureDecision(claim.file, error);
    }
    const file = await this.input.store.finishScanJob({
      tenant_id: claim.file.tenant_id,
      secure_file_id: claim.file.id,
      worker_id: this.input.workerId,
      claim_token: claim.claim_token,
      outcome: decision.outcome,
      detected_mime: decision.detected_mime,
      mime_conflict: decision.mime_conflict,
      failure_code: decision.failure_code,
      next_attempt_at: decision.next_attempt_at,
      scanner_name: this.input.scanner.name,
      scanner_mode: this.input.scanner.mode,
      scanner_request_id: decision.scanner_request_id,
      scan_metadata: decision.scan_metadata
    });
    await this.input.onProcessed?.(file);
    if (file.status === 'processing') return 'clean';
    if (file.status === 'quarantined') return 'quarantined';
    if (file.status === 'scanning') return 'retry_wait';
    return 'failed';
  }

  private async inspect(file: SecureFile): Promise<ScanDecision> {
    const content = await this.input.objectStorage.download(file.object_key, this.maxScanBytes);
    if (!content) return { outcome: 'failed', failure_code: 'object_not_found' };
    if (content.length !== file.size_bytes) {
      return { outcome: 'failed', failure_code: 'object_size_mismatch' };
    }
    if (sha256(content) !== file.sha256) {
      return { outcome: 'failed', failure_code: 'object_checksum_mismatch' };
    }
    const mime = await detectSecureFileMime(content, { declaredMime: file.declared_mime });
    const policyDecision = this.mimeDecision(mime);
    if (policyDecision) return policyDecision;
    const result = await this.input.scanner.scan({
      tenant_id: file.tenant_id,
      secure_file_id: file.id,
      filename: file.filename,
      detected_mime: mime.mime,
      content
    });
    return this.threatDecision(mime, result);
  }

  private mimeDecision(mime: SecureFileMimeResult): ScanDecision | null {
    if (!mime.detected) {
      return {
        outcome: this.mimeConflictAction === 'reject' ? 'failed' : 'quarantined',
        detected_mime: mime.mime,
        mime_conflict: mime.mime_conflict,
        failure_code: 'mime_unknown'
      };
    }
    if (!mime.mime_conflict) return null;
    return {
      outcome: this.mimeConflictAction === 'reject' ? 'failed' : 'quarantined',
      detected_mime: mime.mime,
      mime_conflict: true,
      failure_code: 'mime_conflict'
    };
  }

  private threatDecision(
    mime: SecureFileMimeResult,
    result: FileThreatScanResult
  ): ScanDecision {
    return {
      outcome: result.status === 'clean' ? 'clean' : 'infected',
      detected_mime: mime.mime,
      mime_conflict: mime.mime_conflict,
      ...(result.threat_code ? { failure_code: result.threat_code } : {}),
      ...(result.provider_request_id ? { scanner_request_id: result.provider_request_id } : {}),
      scan_metadata: { engine: result.engine, ...result.metadata }
    };
  }

  private failureDecision(file: SecureFile, error: unknown): ScanDecision {
    const scannerError = error instanceof FileThreatScannerError ? error : null;
    const code = safeCode(
      scannerError?.code || (error as { code?: unknown })?.code || 'scan_worker_error'
    );
    const retryable = scannerError?.retryable === true;
    if (retryable && file.scan_attempt_count < this.maxAttempts) {
      const delay = this.retryDelaysMs[Math.min(file.scan_attempt_count - 1, this.retryDelaysMs.length - 1)];
      return {
        outcome: 'retry_wait',
        failure_code: code,
        next_attempt_at: new Date(this.now().getTime() + delay).toISOString()
      };
    }
    return { outcome: 'failed', failure_code: code };
  }
}

function emptySummary(): SecureFileScanRunSummary {
  return { candidates: 0, claimed: 0, clean: 0, quarantined: 0, retry_wait: 0, failed: 0 };
}

function normalizeRetryDelays(value: number[]): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new Error('retryDelaysMs must contain between 1 and 10 delays');
  }
  return value.map((delay) => boundedInteger(delay, 0, 3_600_000, 'retryDelaysMs'));
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeCode(value: unknown): string {
  return String(value || 'scan_worker_error')
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
    .slice(0, 100) || 'scan_worker_error';
}

function requiredText(value: unknown, field: string): string {
  const text = String(value || '').trim();
  if (!text || text.length > 255 || /[\r\n\u0000]/.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return parsed;
}
