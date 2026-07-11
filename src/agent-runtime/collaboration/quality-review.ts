import { createHash } from 'node:crypto';

import { MemoryPg, pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import { withPgBypass, withPgTenant } from '../../db-pg-tenant.js';
import { CollaborationStore } from './collaboration-store.js';
import { PolicyFindingStore, sanitizePolicyMetadata } from './policy-finding-store.js';
import type {
  CollaborationPolicyFinding,
  PolicyEvidenceRef,
  PolicySeverity
} from './types.js';
import { listCollaborationWorkerTenants } from './worker-tenant-scope.js';

export type QualityReviewProviderMode = 'self_hosted' | 'third_party';
export type QualityReviewJobStatus =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface QualityReviewProviderInput {
  tenant_id: string;
  session_id: string;
  message_id: string;
  content: string;
  content_hash: string;
  rule_findings: CollaborationPolicyFinding[];
  evidence_refs: PolicyEvidenceRef[];
}

export interface QualityReviewCandidate {
  policy_type: string;
  severity: PolicySeverity;
  confidence?: number;
  recommended_action?: string;
  rationale?: string;
  matched_text?: string;
  metadata?: Record<string, unknown>;
}

export interface QualityReviewProviderOutput {
  findings: QualityReviewCandidate[];
  metadata?: Record<string, unknown>;
}

export interface QualityReviewProvider {
  name: string;
  mode: QualityReviewProviderMode;
  review(input: QualityReviewProviderInput): Promise<QualityReviewProviderOutput>;
}

export interface CollaborationQualityReviewJob {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  input_hash: string;
  status: QualityReviewJobStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  provider_mode: 'unconfigured' | QualityReviewProviderMode;
  provider_name: string;
  error_code: string;
  error_message: string;
  output_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface QualityReviewRunSummary {
  candidates: number;
  claimed: number;
  succeeded: number;
  retry_wait: number;
  failed: number;
}

export interface QualityReviewServiceInput {
  pg: PgQueryable;
  provider?: QualityReviewProvider | null;
  now?: () => Date;
  maxAttempts?: number;
  retryDelaysMs?: number[];
  claimLeaseMs?: number;
  onCompleted?: (input: {
    job: CollaborationQualityReviewJob;
    findings: CollaborationPolicyFinding[];
  }) => void | Promise<void>;
}

export class QualityReviewService {
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: number[];
  private readonly claimLeaseMs: number;

  constructor(private readonly input: QualityReviewServiceInput) {
    this.maxAttempts = boundedInteger(input.maxAttempts ?? 3, 1, 10, 'maxAttempts');
    this.retryDelaysMs = normalizeRetryDelays(input.retryDelaysMs || [5_000, 30_000]);
    this.claimLeaseMs = boundedInteger(input.claimLeaseMs ?? 120_000, 5_000, 600_000, 'claimLeaseMs');
  }

  async enqueueMessage(input: {
    tenant_id: string;
    message_id: string;
  }): Promise<CollaborationQualityReviewJob | null> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const message = await new CollaborationStore(pg).getMessage(input);
      if (!message) throw Object.assign(new Error('collaboration message not found'), { status: 404 });
      const content = qualityContent(message);
      if (!content) return null;
      const inputHash = sha256(content);
      const provider = this.input.provider;
      const now = this.now().toISOString();
      const result = await pg.query(
        `INSERT INTO collaboration_quality_review_jobs
          (id, tenant_id, session_id, message_id, input_hash, status, max_attempts,
           provider_mode, provider_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $9)
         ON CONFLICT (tenant_id, message_id) DO UPDATE SET
           session_id = EXCLUDED.session_id,
           input_hash = EXCLUDED.input_hash,
           status = CASE
             WHEN collaboration_quality_review_jobs.input_hash != EXCLUDED.input_hash THEN 'pending'
             ELSE collaboration_quality_review_jobs.status
           END,
           attempt_count = CASE
             WHEN collaboration_quality_review_jobs.input_hash != EXCLUDED.input_hash THEN 0
             ELSE collaboration_quality_review_jobs.attempt_count
           END,
           next_attempt_at = CASE
             WHEN collaboration_quality_review_jobs.input_hash != EXCLUDED.input_hash THEN NULL
             ELSE collaboration_quality_review_jobs.next_attempt_at
           END,
           lease_until = CASE
             WHEN collaboration_quality_review_jobs.input_hash != EXCLUDED.input_hash THEN NULL
             ELSE collaboration_quality_review_jobs.lease_until
           END,
           worker_id = CASE
             WHEN collaboration_quality_review_jobs.input_hash != EXCLUDED.input_hash THEN ''
             ELSE collaboration_quality_review_jobs.worker_id
           END,
           provider_mode = EXCLUDED.provider_mode,
           provider_name = EXCLUDED.provider_name,
           error_code = CASE
             WHEN collaboration_quality_review_jobs.input_hash != EXCLUDED.input_hash THEN ''
             ELSE collaboration_quality_review_jobs.error_code
           END,
           error_message = CASE
             WHEN collaboration_quality_review_jobs.input_hash != EXCLUDED.input_hash THEN ''
             ELSE collaboration_quality_review_jobs.error_message
           END,
           completed_at = CASE
             WHEN collaboration_quality_review_jobs.input_hash != EXCLUDED.input_hash THEN NULL
             ELSE collaboration_quality_review_jobs.completed_at
           END,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          pgId('cqjob'),
          message.tenant_id,
          message.session_id,
          message.id,
          inputHash,
          this.maxAttempts,
          provider?.mode || 'unconfigured',
          provider?.name || '',
          now
        ]
      );
      return decodeJob(result.rows[0]);
    });
  }

  async getJob(input: {
    tenant_id: string;
    message_id: string;
  }): Promise<CollaborationQualityReviewJob | null> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        'SELECT * FROM collaboration_quality_review_jobs WHERE tenant_id = $1 AND message_id = $2',
        [input.tenant_id, input.message_id]
      );
      return result.rows[0] ? decodeJob(result.rows[0]) : null;
    });
  }

  async cancelMessage(input: {
    tenant_id: string;
    message_id: string;
    reason?: string;
  }): Promise<CollaborationQualityReviewJob | null> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const now = this.now().toISOString();
      const result = await pg.query(
        `UPDATE collaboration_quality_review_jobs
         SET status = 'cancelled', next_attempt_at = NULL, lease_until = NULL,
             worker_id = '', error_code = $3, error_message = $4,
             completed_at = $5, updated_at = $5
         WHERE tenant_id = $1 AND message_id = $2
           AND status NOT IN ('succeeded', 'cancelled')
         RETURNING *`,
        [
          input.tenant_id,
          input.message_id,
          'message_deleted',
          String(input.reason || 'message deleted').slice(0, 300),
          now
        ]
      );
      if (result.rows[0]) return decodeJob(result.rows[0]);
      const existing = await pg.query(
        'SELECT * FROM collaboration_quality_review_jobs WHERE tenant_id = $1 AND message_id = $2',
        [input.tenant_id, input.message_id]
      );
      return existing.rows[0] ? decodeJob(existing.rows[0]) : null;
    });
  }

  async runDue(input: { tenant_id?: string; limit?: number } = {}): Promise<QualityReviewRunSummary> {
    const now = this.now();
    const limit = boundedInteger(input.limit ?? 25, 1, 100, 'limit');
    if (!input.tenant_id && !(this.input.pg instanceof MemoryPg)) {
      const tenants = await listCollaborationWorkerTenants(this.input.pg, 'quality', now, limit);
      const total: QualityReviewRunSummary = {
        candidates: 0,
        claimed: 0,
        succeeded: 0,
        retry_wait: 0,
        failed: 0
      };
      for (const tenantId of tenants) {
        const result = await this.runDue({
          tenant_id: tenantId,
          limit: Math.max(1, limit - total.candidates)
        });
        total.candidates += result.candidates;
        total.claimed += result.claimed;
        total.succeeded += result.succeeded;
        total.retry_wait += result.retry_wait;
        total.failed += result.failed;
        if (total.candidates >= limit) break;
      }
      return total;
    }
    await this.reconcileExpired(input.tenant_id, now);
    const candidates = await this.listDue(input.tenant_id, now, limit);
    const summary: QualityReviewRunSummary = {
      candidates: candidates.length,
      claimed: 0,
      succeeded: 0,
      retry_wait: 0,
      failed: 0
    };
    if (!this.input.provider) return summary;

    for (const candidate of candidates) {
      const claimed = await this.claim(candidate, this.input.provider, now);
      if (!claimed) continue;
      summary.claimed += 1;
      const status = await this.processClaim(claimed, this.input.provider);
      summary[status] += 1;
    }
    return summary;
  }

  private async processClaim(
    job: CollaborationQualityReviewJob,
    provider: QualityReviewProvider
  ): Promise<'succeeded' | 'retry_wait' | 'failed'> {
    try {
      const prepared = await withPgTenant(this.input.pg, job.tenant_id, async (pg) => {
        const message = await new CollaborationStore(pg).getMessage({
          tenant_id: job.tenant_id,
          message_id: job.message_id
        });
        if (!message) throw qualityError('message_not_found', false);
        const content = qualityContent(message);
        const contentHash = sha256(content);
        if (contentHash !== job.input_hash) return { inputChanged: true as const };
        const ruleFindings = (await new PolicyFindingStore(pg).listFindings({
          tenant_id: job.tenant_id,
          session_id: job.session_id,
          message_id: job.message_id,
          limit: 500
        })).filter((finding) => finding.source !== 'ai');
        const evidenceRefs: PolicyEvidenceRef[] = [
          { type: 'message', id: message.id },
          ...message.attachments.map((attachment) => ({
            type: 'attachment',
            id: attachment.id,
            checksum: attachment.checksum,
            kind: attachment.kind
          }))
        ];
        return { inputChanged: false as const, content, contentHash, ruleFindings, evidenceRefs };
      });
      if (prepared.inputChanged) {
        const refreshed = await this.enqueueMessage({
          tenant_id: job.tenant_id,
          message_id: job.message_id
        });
        if (!refreshed) throw qualityError('quality_input_empty', false);
        return 'retry_wait';
      }
      const output = await provider.review({
        tenant_id: job.tenant_id,
        session_id: job.session_id,
        message_id: job.message_id,
        content: prepared.content,
        content_hash: prepared.contentHash,
        rule_findings: prepared.ruleFindings,
        evidence_refs: prepared.evidenceRefs
      });
      const completed = await this.complete(job, provider, output, prepared.evidenceRefs);
      try {
        await this.input.onCompleted?.(completed);
      } catch {
        // Findings are committed; notification delivery is best-effort.
      }
      return 'succeeded';
    } catch (error) {
      return this.fail(job, error);
    }
  }

  private async complete(
    job: CollaborationQualityReviewJob,
    provider: QualityReviewProvider,
    output: QualityReviewProviderOutput,
    evidenceRefs: PolicyEvidenceRef[]
  ): Promise<{ job: CollaborationQualityReviewJob; findings: CollaborationPolicyFinding[] }> {
    const now = this.now().toISOString();
    return withPgTenant(this.input.pg, job.tenant_id, (scopedPg) =>
      withPgTransaction(scopedPg, async (pg) => {
        const updated = await pg.query(
          `UPDATE collaboration_quality_review_jobs
           SET status = 'succeeded', provider_mode = $5, provider_name = $6,
               error_code = '', error_message = '', output_metadata = $7,
               lease_until = NULL, worker_id = '', completed_at = $8, updated_at = $8
           WHERE id = $1 AND tenant_id = $2 AND status = 'processing'
             AND worker_id = $3 AND input_hash = $4
           RETURNING *`,
          [
            job.id,
            job.tenant_id,
            job.worker_id,
            job.input_hash,
            provider.mode,
            provider.name,
            JSON.stringify(sanitizePolicyMetadata({
              finding_count: output.findings.length,
              ...(output.metadata || {})
            })),
            now
          ]
        );
        if (!updated.rows[0]) throw qualityError('quality_job_claim_lost', true);
        const findingStore = new PolicyFindingStore(pg);
        const findings: CollaborationPolicyFinding[] = [];
        for (const [index, candidate] of output.findings.slice(0, 100).entries()) {
          const policyType = String(candidate.policy_type || '').trim();
          if (!policyType) continue;
          const matchedHash = candidate.matched_text
            ? sha256(candidate.matched_text.trim().toLowerCase())
            : sha256(`${job.input_hash}\u0000${policyType}\u0000${index}`);
          findings.push(await findingStore.recordFinding({
            tenant_id: job.tenant_id,
            session_id: job.session_id,
            message_id: job.message_id,
            source: 'ai',
            source_ref_id: `${job.message_id}:${job.input_hash}`,
            policy_type: policyType,
            severity: normalizeSeverity(candidate.severity),
            matched_text_hash: matchedHash,
            action: 'review',
            confidence: candidate.confidence,
            rationale: candidate.rationale,
            evidence_refs: evidenceRefs,
            metadata: {
              provider: provider.name,
              provider_mode: provider.mode,
              recommended_action: String(candidate.recommended_action || 'review'),
              ...(candidate.metadata || {})
            }
          }));
        }
        return { job: decodeJob(updated.rows[0]), findings };
      })
    );
  }

  private async claim(
    job: CollaborationQualityReviewJob,
    provider: QualityReviewProvider,
    now: Date
  ): Promise<CollaborationQualityReviewJob | null> {
    return withPgTenant(this.input.pg, job.tenant_id, async (pg) => {
      const workerId = pgId('cqworker');
      const leaseUntil = new Date(now.getTime() + this.claimLeaseMs).toISOString();
      const result = await pg.query(
        `UPDATE collaboration_quality_review_jobs
         SET status = 'processing', attempt_count = attempt_count + 1,
             lease_until = $4, worker_id = $3, next_attempt_at = NULL,
             provider_mode = $5, provider_name = $6,
             error_code = '', error_message = '', updated_at = $7
         WHERE id = $1 AND tenant_id = $2 AND attempt_count < max_attempts
           AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $7)))
         RETURNING *`,
        [job.id, job.tenant_id, workerId, leaseUntil, provider.mode, provider.name, now.toISOString()]
      );
      return result.rows[0] ? decodeJob(result.rows[0]) : null;
    });
  }

  private async fail(
    job: CollaborationQualityReviewJob,
    error: unknown
  ): Promise<'retry_wait' | 'failed'> {
    const classified = classifyError(error);
    const terminal = !classified.retryable || job.attempt_count >= job.max_attempts;
    const status = terminal ? 'failed' : 'retry_wait';
    const now = this.now();
    const next = terminal
      ? null
      : new Date(now.getTime() + retryDelay(this.retryDelaysMs, job.attempt_count)).toISOString();
    await withPgTenant(this.input.pg, job.tenant_id, (pg) => pg.query(
      `UPDATE collaboration_quality_review_jobs
       SET status = $4, next_attempt_at = $5, lease_until = NULL, worker_id = '',
           error_code = $6, error_message = $7,
           completed_at = CASE WHEN $4 = 'failed' THEN $8 ELSE NULL END,
           updated_at = $8
       WHERE id = $1 AND tenant_id = $2 AND status = 'processing' AND worker_id = $3`,
      [job.id, job.tenant_id, job.worker_id, status, next, classified.code, classified.message, now.toISOString()]
    ));
    return status;
  }

  private async listDue(
    tenantId: string | undefined,
    now: Date,
    limit: number
  ): Promise<CollaborationQualityReviewJob[]> {
    const query = async (pg: PgQueryable) => {
      const result = tenantId
        ? await pg.query(
          `SELECT * FROM collaboration_quality_review_jobs
           WHERE tenant_id = $1 AND attempt_count < max_attempts
             AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $2)))
           ORDER BY created_at ASC LIMIT $3`,
          [tenantId, now.toISOString(), limit]
        )
        : await pg.query(
          `SELECT * FROM collaboration_quality_review_jobs
           WHERE attempt_count < max_attempts
             AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)))
           ORDER BY created_at ASC LIMIT $2`,
          [now.toISOString(), limit]
        );
      return result.rows.map(decodeJob);
    };
    return tenantId ? withPgTenant(this.input.pg, tenantId, query) : withPgBypass(this.input.pg, query);
  }

  private async reconcileExpired(tenantId: string | undefined, now: Date): Promise<void> {
    const reconcile = (pg: PgQueryable) => tenantId
      ? pg.query(
        `UPDATE collaboration_quality_review_jobs
         SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
             next_attempt_at = CASE WHEN attempt_count >= max_attempts THEN NULL ELSE $2 END,
             lease_until = NULL, worker_id = '', error_code = 'claim_lease_expired',
             error_message = 'quality review claim lease expired', updated_at = $2,
             completed_at = CASE WHEN attempt_count >= max_attempts THEN $2 ELSE NULL END
         WHERE tenant_id = $1 AND status = 'processing' AND lease_until <= $2`,
        [tenantId, now.toISOString()]
      )
      : pg.query(
        `UPDATE collaboration_quality_review_jobs
         SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
             next_attempt_at = CASE WHEN attempt_count >= max_attempts THEN NULL ELSE $1 END,
             lease_until = NULL, worker_id = '', error_code = 'claim_lease_expired',
             error_message = 'quality review claim lease expired', updated_at = $1,
             completed_at = CASE WHEN attempt_count >= max_attempts THEN $1 ELSE NULL END
         WHERE status = 'processing' AND lease_until <= $1`,
        [now.toISOString()]
      );
    if (tenantId) await withPgTenant(this.input.pg, tenantId, reconcile);
    else await withPgBypass(this.input.pg, reconcile);
  }

  private now(): Date {
    return this.input.now?.() || new Date();
  }
}

export interface HttpQualityReviewProviderConfig {
  mode: QualityReviewProviderMode;
  baseUrl: string;
  endpoint?: string;
  token?: string;
  timeoutMs?: number;
  name?: string;
  fetch?: typeof fetch;
}

export function createHttpQualityReviewProvider(
  config: HttpQualityReviewProviderConfig
): QualityReviewProvider {
  const baseUrl = String(config.baseUrl || '').trim();
  if (!baseUrl) throw new Error('quality review provider baseUrl is required');
  const endpoint = new URL(
    String(config.endpoint || '/v1/quality-review').replace(/^\//, ''),
    baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  ).toString();
  const timeoutMs = boundedInteger(config.timeoutMs ?? 30_000, 1_000, 300_000, 'timeoutMs');
  const fetchImpl = config.fetch || fetch;
  return {
    name: config.name || `${config.mode}-quality-review`,
    mode: config.mode,
    async review(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.token ? { authorization: `Bearer ${config.token}` } : {})
          },
          body: JSON.stringify({
            tenant_id: input.tenant_id,
            session_id: input.session_id,
            message_id: input.message_id,
            content: input.content,
            content_hash: input.content_hash,
            rule_findings: input.rule_findings.map((finding) => ({
              policy_type: finding.policy_type,
              severity: finding.severity,
              matched_text_hash: finding.matched_text_hash,
              source: finding.source
            })),
            evidence_refs: input.evidence_refs
          }),
          signal: controller.signal
        });
      } catch {
        throw qualityError(controller.signal.aborted ? 'provider_timeout' : 'provider_unavailable', true);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw qualityError(
          `provider_http_${response.status}`,
          response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw qualityError('provider_invalid_response', false);
      }
      if (!isRecord(payload) || !Array.isArray(payload.findings)) {
        throw qualityError('provider_invalid_response', false);
      }
      return {
        findings: payload.findings.filter(isRecord).map((finding) => ({
          policy_type: String(finding.policy_type || ''),
          severity: normalizeSeverity(finding.severity),
          confidence: finiteNumber(finding.confidence),
          recommended_action: String(finding.recommended_action || 'review'),
          rationale: String(finding.rationale || ''),
          matched_text: typeof finding.matched_text === 'string' ? finding.matched_text : undefined,
          metadata: isRecord(finding.metadata) ? finding.metadata : {}
        })),
        metadata: isRecord(payload.metadata) ? payload.metadata : {}
      };
    }
  };
}

export function configuredQualityReviewProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch?: typeof fetch } = {}
): QualityReviewProvider | null {
  const baseUrl = String(env.OPC_QUALITY_REVIEW_BASE_URL || '').trim();
  if (!baseUrl) return null;
  const mode = String(env.OPC_QUALITY_REVIEW_PROVIDER_MODE || 'self_hosted').trim();
  if (mode !== 'self_hosted' && mode !== 'third_party') {
    throw new Error('OPC_QUALITY_REVIEW_PROVIDER_MODE must be self_hosted or third_party');
  }
  return createHttpQualityReviewProvider({
    mode,
    baseUrl,
    endpoint: env.OPC_QUALITY_REVIEW_ENDPOINT || '/v1/quality-review',
    token: env.OPC_QUALITY_REVIEW_TOKEN,
    timeoutMs: env.OPC_QUALITY_REVIEW_TIMEOUT_MS ? Number(env.OPC_QUALITY_REVIEW_TIMEOUT_MS) : undefined,
    name: env.OPC_QUALITY_REVIEW_PROVIDER_NAME || undefined,
    fetch: deps.fetch
  });
}

function qualityContent(message: Awaited<ReturnType<CollaborationStore['getMessage']>>): string {
  if (!message) return '';
  const chunks = [message.body];
  for (const attachment of message.attachments) {
    const extracted = attachment.extracted_text || attachment.ocr_text || attachment.asr_text ||
      legacyExtractedText(attachment.metadata);
    if (extracted) chunks.push(extracted);
  }
  return chunks.map((chunk) => String(chunk || '').trim()).filter(Boolean).join('\n').slice(0, 500_000);
}

function legacyExtractedText(metadata: Record<string, unknown>): string {
  for (const key of ['extracted_text', 'ocr_text', 'asr_text', 'transcript', 'quality_text']) {
    if (typeof metadata[key] === 'string' && metadata[key].trim()) return metadata[key].trim();
  }
  return '';
}

function decodeJob(row: Record<string, unknown>): CollaborationQualityReviewJob {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    input_hash: String(row.input_hash || ''),
    status: String(row.status || 'pending') as QualityReviewJobStatus,
    attempt_count: Number(row.attempt_count || 0),
    max_attempts: Number(row.max_attempts || 3),
    next_attempt_at: row.next_attempt_at ? String(row.next_attempt_at) : null,
    lease_until: row.lease_until ? String(row.lease_until) : null,
    worker_id: String(row.worker_id || ''),
    provider_mode: String(row.provider_mode || 'unconfigured') as CollaborationQualityReviewJob['provider_mode'],
    provider_name: String(row.provider_name || ''),
    error_code: String(row.error_code || ''),
    error_message: String(row.error_message || ''),
    output_metadata: parseRecord(row.output_metadata),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || row.created_at || ''),
    completed_at: row.completed_at ? String(row.completed_at) : null
  };
}

function normalizeSeverity(value: unknown): PolicySeverity {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function qualityError(code: string, retryable: boolean): Error {
  return Object.assign(new Error(code), { code, retryable });
}

function classifyError(error: unknown): { code: string; message: string; retryable: boolean } {
  const details = error as { code?: unknown; retryable?: unknown; message?: unknown };
  const code = String(details?.code || 'quality_review_failed').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  return {
    code,
    message: String(details?.message || code).slice(0, 300),
    retryable: details?.retryable === true
  };
}

function retryDelay(delays: number[], attempt: number): number {
  return delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)] || 0;
}

function normalizeRetryDelays(values: number[]): number[] {
  if (!values.length || values.some((value) => !Number.isInteger(value) || value < 0 || value > 3_600_000)) {
    throw new Error('retryDelaysMs must contain integers between 0 and 3600000');
  }
  return values;
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
