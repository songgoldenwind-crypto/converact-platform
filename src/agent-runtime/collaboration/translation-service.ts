import { createHash } from 'node:crypto';

import { MemoryPg, pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import { withPgBypass, withPgTenant } from '../../db-pg-tenant.js';
import { CollaborationStore } from './collaboration-store.js';
import { listCollaborationWorkerTenants } from './worker-tenant-scope.js';
import {
  TranslationProviderError,
  type TranslationProvider,
  type TranslationProviderMode,
  type TranslationSourceType
} from './translation-provider.js';
import { sanitizeProviderMetadata, sanitizeProviderRequestId } from './provider-safety.js';

export type TranslationJobStatus =
  | 'pending' | 'processing' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled';

export interface CollaborationTranslationJob {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  source_type: TranslationSourceType;
  source_ref_id: string;
  source_language: string;
  target_language: string;
  source_hash: string;
  status: TranslationJobStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  provider_profile_id: string;
  provider_mode: 'unconfigured' | TranslationProviderMode;
  provider_name: string;
  provider_request_id: string;
  error_code: string;
  error_message: string;
  output_metadata: Record<string, unknown>;
  idempotency_key: string;
  payload_hash: string;
  automatic: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CollaborationTranslationResult {
  id: string;
  tenant_id: string;
  message_id: string;
  source_type: TranslationSourceType;
  source_ref_id: string;
  source_hash: string;
  source_language: string;
  target_language: string;
  translated_text: string;
  provider_profile_id: string;
  provider_mode: 'unconfigured' | TranslationProviderMode;
  provider_name: string;
  provider_request_id: string;
  confidence: number | null;
  output_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TranslationProviderResolution {
  enabled: boolean;
  automatic: boolean;
  profile_id: string;
  provider: TranslationProvider | null;
  error_code: string;
}

export type TranslationProviderResolver = (input: {
  tenant_id: string;
}) => Promise<TranslationProviderResolution>;

export interface TranslationRunSummary {
  candidates: number;
  claimed: number;
  succeeded: number;
  retry_wait: number;
  failed: number;
}

export interface TranslationServiceInput {
  pg: PgQueryable;
  provider?: TranslationProvider | null;
  resolveProvider?: TranslationProviderResolver;
  now?: () => Date;
  maxAttempts?: number;
  retryDelaysMs?: number[];
  claimLeaseMs?: number;
  onCompleted?: (input: {
    job: CollaborationTranslationJob;
    result: CollaborationTranslationResult;
  }) => void | Promise<void>;
  onFailed?: (job: CollaborationTranslationJob) => void | Promise<void>;
}

interface TranslationSource {
  tenant_id: string;
  session_id: string;
  message_id: string;
  source_type: TranslationSourceType;
  source_ref_id: string;
  source_ref: string;
  text: string;
  hash: string;
  source_language: string;
}

export class TranslationService {
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: number[];
  private readonly claimLeaseMs: number;

  constructor(private readonly input: TranslationServiceInput) {
    this.maxAttempts = boundedInteger(input.maxAttempts ?? 3, 1, 10, 'maxAttempts');
    this.retryDelaysMs = retryDelays(input.retryDelaysMs || [5_000, 30_000]);
    this.claimLeaseMs = boundedInteger(input.claimLeaseMs ?? 120_000, 5_000, 600_000, 'claimLeaseMs');
  }

  async requestTranslation(input: {
    tenant_id: string;
    session_id: string;
    source_type: TranslationSourceType;
    source_ref_id: string;
    source_language?: string;
    target_language: string;
    idempotency_key: string;
    automatic?: boolean;
  }): Promise<{ job: CollaborationTranslationJob; replayed: boolean }> {
    const targetLanguage = language(input.target_language, false, 'target_language');
    const requestedSourceLanguage = language(input.source_language || 'auto', true, 'source_language');
    const idempotencyKey = boundedText(input.idempotency_key, 200, 'idempotency_key');
    const automatic = input.automatic === true;
    const resolution = await this.resolveProvider(input.tenant_id);
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const source = await this.resolveSource(pg, {
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        source_type: input.source_type,
        source_ref_id: input.source_ref_id,
        source_language: requestedSourceLanguage
      });
      const payloadHash = sha256(JSON.stringify({
        source_type: source.source_type,
        source_ref_id: source.source_ref_id,
        source_hash: source.hash,
        source_language: source.source_language,
        target_language: targetLanguage,
        automatic
      }));
      const existing = await pg.query(
        `SELECT * FROM collaboration_translation_jobs
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenant_id, idempotencyKey]
      );
      if (existing.rows[0]) {
        const job = decodeJob(existing.rows[0]);
        if (job.payload_hash !== payloadHash) throw conflict('idempotency key payload conflict');
        return { job, replayed: true };
      }
      const provider = resolution.provider;
      const cancelled = !resolution.enabled || (automatic && !resolution.automatic);
      const status: TranslationJobStatus = cancelled ? 'cancelled' : 'pending';
      const errorCode = !resolution.enabled
        ? resolution.error_code || 'policy_disabled'
        : automatic && !resolution.automatic
          ? 'automatic_translation_disabled'
          : provider
            ? ''
            : resolution.error_code || 'provider_unavailable';
      const now = this.now().toISOString();
      const inserted = await pg.query(
        `INSERT INTO collaboration_translation_jobs
          (id, tenant_id, session_id, message_id, source_type, source_ref_id,
           source_language, target_language, source_hash, status, max_attempts,
           provider_profile_id, provider_mode, provider_name, error_code,
           idempotency_key, payload_hash, automatic, created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16, $17, $18, $19, $19,
                 CASE WHEN $10 = 'cancelled' THEN $19 ELSE NULL END)
         ON CONFLICT DO NOTHING RETURNING *`,
        [
          pgId('ctjob'), input.tenant_id, source.session_id, source.message_id,
          source.source_type, source.source_ref_id, source.source_language, targetLanguage,
          source.hash, status, this.maxAttempts, resolution.profile_id,
          provider?.mode || 'unconfigured', provider?.name || '', errorCode,
          idempotencyKey, payloadHash, automatic, now
        ]
      );
      if (inserted.rows[0]) return { job: decodeJob(inserted.rows[0]), replayed: false };
      const duplicate = await pg.query(
        `SELECT * FROM collaboration_translation_jobs
         WHERE tenant_id = $1 AND source_type = $2 AND source_ref_id = $3
           AND target_language = $4 AND source_hash = $5`,
        [input.tenant_id, source.source_type, source.source_ref_id, targetLanguage, source.hash]
      );
      if (!duplicate.rows[0]) throw conflict('translation request conflict');
      return { job: decodeJob(duplicate.rows[0]), replayed: true };
    });
  }

  async getJob(input: { tenant_id: string; job_id: string }): Promise<CollaborationTranslationJob | null> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        'SELECT * FROM collaboration_translation_jobs WHERE id = $1 AND tenant_id = $2',
        [input.job_id, input.tenant_id]
      );
      return result.rows[0] ? decodeJob(result.rows[0]) : null;
    });
  }

  async listTranslations(input: {
    tenant_id: string;
    session_id: string;
    source_type: TranslationSourceType;
    source_ref_id: string;
    target_language?: string;
    history?: boolean;
  }): Promise<{ items: CollaborationTranslationResult[] }> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      let source: TranslationSource;
      try {
        source = await this.resolveSource(pg, {
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          source_type: input.source_type,
          source_ref_id: input.source_ref_id,
          source_language: 'auto'
        });
      } catch (error) {
        if (errorStatus(error) === 404 || errorCode(error) === 'source_deleted') return { items: [] };
        throw error;
      }
      const target = input.target_language ? language(input.target_language, false, 'target_language') : '';
      const result = await pg.query(
        `SELECT * FROM collaboration_message_translations
         WHERE tenant_id = $1 AND source_type = $2 AND source_ref_id = $3
           AND ($4 = '' OR target_language = $4)
           AND ($5 = TRUE OR source_hash = $6)
         ORDER BY created_at DESC, id DESC LIMIT 500`,
        [input.tenant_id, input.source_type, input.source_ref_id, target, input.history === true, source.hash]
      );
      return { items: result.rows.map(decodeResult) };
    });
  }

  async runDue(input: { tenant_id?: string; limit?: number } = {}): Promise<TranslationRunSummary> {
    const now = this.now();
    const limit = boundedInteger(input.limit ?? 25, 1, 100, 'limit');
    if (!input.tenant_id && !(this.input.pg instanceof MemoryPg)) {
      const tenants = await listCollaborationWorkerTenants(this.input.pg, 'translation', now, limit);
      const total = emptySummary();
      for (const tenantId of tenants) addSummary(total, await this.runDue({ tenant_id: tenantId, limit }));
      return total;
    }
    await this.reconcileExpired(input.tenant_id, now);
    const candidates = await this.listDue(input.tenant_id, now, limit);
    const summary = { ...emptySummary(), candidates: candidates.length };
    for (const candidate of candidates) {
      const resolution = await this.resolveProvider(candidate.tenant_id);
      if (!resolution.enabled || (candidate.automatic && !resolution.automatic)) {
        await this.cancel(candidate, !resolution.enabled
          ? resolution.error_code || 'policy_disabled'
          : 'automatic_translation_disabled', now);
        continue;
      }
      if (!resolution.provider) {
        await this.unavailable(candidate, resolution.profile_id, resolution.error_code || 'provider_unavailable', now);
        continue;
      }
      try {
        const current = await withPgTenant(this.input.pg, candidate.tenant_id, (pg) => this.resolveSource(pg, {
          tenant_id: candidate.tenant_id,
          session_id: candidate.session_id,
          source_type: candidate.source_type,
          source_ref_id: candidate.source_ref_id,
          source_language: candidate.source_language
        }));
        if (current.hash !== candidate.source_hash) {
          await this.cancel(candidate, 'source_changed', now);
          continue;
        }
      } catch (error) {
        if (errorCode(error) === 'source_deleted' || errorStatus(error) === 404) {
          await this.cancel(candidate, 'source_deleted', now);
          continue;
        }
        throw error;
      }
      const claimed = await this.claim(candidate, resolution.provider, resolution.profile_id, now);
      if (!claimed) continue;
      summary.claimed += 1;
      const status = await this.process(claimed, resolution.provider);
      summary[status] += 1;
    }
    return summary;
  }

  private async process(
    job: CollaborationTranslationJob,
    provider: TranslationProvider
  ): Promise<'succeeded' | 'retry_wait' | 'failed'> {
    try {
      const source = await withPgTenant(this.input.pg, job.tenant_id, (pg) => this.resolveSource(pg, {
        tenant_id: job.tenant_id,
        session_id: job.session_id,
        source_type: job.source_type,
        source_ref_id: job.source_ref_id,
        source_language: job.source_language
      }));
      if (source.hash !== job.source_hash) {
        await this.cancel(job, 'source_changed', this.now());
        return 'failed';
      }
      const output = await provider.translate({
        tenant_id: job.tenant_id,
        session_id: job.session_id,
        message_id: job.message_id,
        source_type: job.source_type,
        source_ref_id: job.source_ref_id,
        source_ref: source.source_ref,
        text: source.text,
        source_language: job.source_language,
        target_language: job.target_language
      });
      const completed = await this.complete(job, provider, output);
      await Promise.resolve(this.input.onCompleted?.(completed)).catch(() => undefined);
      return 'succeeded';
    } catch (error) {
      if (errorCode(error) === 'source_deleted' || errorStatus(error) === 404) {
        await this.cancel(job, 'source_deleted', this.now());
        return 'failed';
      }
      return this.fail(job, error);
    }
  }

  private async complete(
    job: CollaborationTranslationJob,
    provider: TranslationProvider,
    output: Awaited<ReturnType<TranslationProvider['translate']>>
  ): Promise<{ job: CollaborationTranslationJob; result: CollaborationTranslationResult }> {
    const now = this.now().toISOString();
    return withPgTenant(this.input.pg, job.tenant_id, (scopedPg) =>
      withPgTransaction(scopedPg, async (pg) => {
        const resultId = pgId('ctrans');
        const metadata = sanitizeProviderMetadata(output.metadata || {});
        await pg.query(
          `INSERT INTO collaboration_message_translations
            (id, tenant_id, message_id, target_language, translated_body, provider, confidence,
             source_type, source_ref_id, source_hash, source_language, provider_profile_id,
             provider_mode, provider_request_id, output_metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
           ON CONFLICT (tenant_id, source_type, source_ref_id, target_language, source_hash) DO NOTHING`,
          [
            resultId, job.tenant_id, job.message_id, job.target_language,
            output.translated_text, provider.name, output.confidence ?? null,
            job.source_type, job.source_ref_id, job.source_hash,
            output.detected_language || job.source_language,
            provider.profile_id || job.provider_profile_id, provider.mode,
            sanitizeProviderRequestId(output.provider_request_id), JSON.stringify(metadata), now
          ]
        );
        const stored = await pg.query(
          `SELECT * FROM collaboration_message_translations
           WHERE tenant_id = $1 AND source_type = $2 AND source_ref_id = $3
             AND target_language = $4 AND source_hash = $5`,
          [job.tenant_id, job.source_type, job.source_ref_id, job.target_language, job.source_hash]
        );
        if (!stored.rows[0]) throw serviceError('translation_result_missing', true);
        const updated = await pg.query(
          `UPDATE collaboration_translation_jobs
           SET status = 'succeeded', provider_profile_id = $5, provider_mode = $6,
               provider_name = $7, provider_request_id = $8, output_metadata = $9,
               error_code = '', error_message = '', lease_until = NULL, worker_id = '',
               completed_at = $10, updated_at = $10
           WHERE id = $1 AND tenant_id = $2 AND status = 'processing'
             AND worker_id = $3 AND source_hash = $4 RETURNING *`,
          [
            job.id, job.tenant_id, job.worker_id, job.source_hash,
            provider.profile_id || job.provider_profile_id, provider.mode, provider.name,
            sanitizeProviderRequestId(output.provider_request_id), JSON.stringify(metadata), now
          ]
        );
        if (!updated.rows[0]) throw serviceError('translation_job_claim_lost', true);
        return { job: decodeJob(updated.rows[0]), result: decodeResult(stored.rows[0]) };
      })
    );
  }

  private async claim(job: CollaborationTranslationJob, provider: TranslationProvider, profileId: string, now: Date) {
    return withPgTenant(this.input.pg, job.tenant_id, async (pg) => {
      const workerId = pgId('ctworker');
      const lease = new Date(now.getTime() + this.claimLeaseMs).toISOString();
      const result = await pg.query(
        `UPDATE collaboration_translation_jobs
         SET status = 'processing', attempt_count = attempt_count + 1, lease_until = $4,
             worker_id = $3, next_attempt_at = NULL, provider_profile_id = $5,
             provider_mode = $6, provider_name = $7, error_code = '', error_message = '', updated_at = $8
         WHERE id = $1 AND tenant_id = $2 AND attempt_count < max_attempts
           AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $8)))
         RETURNING *`,
        [job.id, job.tenant_id, workerId, lease, profileId, provider.mode, provider.name, now.toISOString()]
      );
      return result.rows[0] ? decodeJob(result.rows[0]) : null;
    });
  }

  private async fail(job: CollaborationTranslationJob, error: unknown): Promise<'retry_wait' | 'failed'> {
    const classified = classify(error);
    const terminal = !classified.retryable || job.attempt_count >= job.max_attempts;
    const status = terminal ? 'failed' : 'retry_wait';
    const now = this.now();
    const next = terminal ? null : new Date(
      now.getTime() + (this.retryDelaysMs[Math.min(job.attempt_count - 1, this.retryDelaysMs.length - 1)] || 0)
    ).toISOString();
    const result = await withPgTenant(this.input.pg, job.tenant_id, (pg) => pg.query(
      `UPDATE collaboration_translation_jobs
       SET status = $4, next_attempt_at = $5, lease_until = NULL, worker_id = '',
           error_code = $6, error_message = $7,
           completed_at = CASE WHEN $4 = 'failed' THEN $8 ELSE NULL END, updated_at = $8
       WHERE id = $1 AND tenant_id = $2 AND status = 'processing' AND worker_id = $3 RETURNING *`,
      [job.id, job.tenant_id, job.worker_id, status, next, classified.code, classified.message, now.toISOString()]
    ));
    if (terminal && result.rows[0]) {
      await Promise.resolve(this.input.onFailed?.(decodeJob(result.rows[0]))).catch(() => undefined);
    }
    return status;
  }

  private async resolveSource(pg: PgQueryable, input: {
    tenant_id: string;
    session_id: string;
    source_type: TranslationSourceType;
    source_ref_id: string;
    source_language: string;
  }): Promise<TranslationSource> {
    const store = new CollaborationStore(pg);
    if (input.source_type === 'message') {
      const message = await store.getMessage({ tenant_id: input.tenant_id, message_id: input.source_ref_id });
      if (!message || message.session_id !== input.session_id) throw notFound('translation source not found');
      if (message.deleted_at) throw serviceError('source_deleted', false);
      const text = sourceText(message.body);
      return source(input, message.id, text);
    }
    const attachment = await store.getAttachment({
      tenant_id: input.tenant_id,
      attachment_id: input.source_ref_id
    });
    if (!attachment || attachment.session_id !== input.session_id) throw notFound('translation source not found');
    const message = await store.getMessage({ tenant_id: input.tenant_id, message_id: attachment.message_id });
    if (!message || message.deleted_at) throw serviceError('source_deleted', false);
    const extracted = attachment.extracted_text || attachment.ocr_text || attachment.asr_text;
    if (attachment.processing_status !== 'ready' || !extracted.trim()) {
      throw Object.assign(new Error('attachment extraction is not ready'), { status: 409 });
    }
    return source(input, attachment.message_id, sourceText(extracted));
  }

  private async listDue(tenantId: string | undefined, now: Date, limit: number) {
    const query = async (pg: PgQueryable) => {
      const result = tenantId
        ? await pg.query(
          `SELECT * FROM collaboration_translation_jobs WHERE tenant_id = $1 AND attempt_count < max_attempts
           AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $2)))
           ORDER BY created_at ASC LIMIT $3`, [tenantId, now.toISOString(), limit]
        )
        : await pg.query(
          `SELECT * FROM collaboration_translation_jobs WHERE attempt_count < max_attempts
           AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)))
           ORDER BY created_at ASC LIMIT $2`, [now.toISOString(), limit]
        );
      return result.rows.map(decodeJob);
    };
    return tenantId ? withPgTenant(this.input.pg, tenantId, query) : withPgBypass(this.input.pg, query);
  }

  private async cancel(job: CollaborationTranslationJob, code: string, now: Date): Promise<void> {
    await withPgTenant(this.input.pg, job.tenant_id, (pg) => pg.query(
      `UPDATE collaboration_translation_jobs SET status = 'cancelled', next_attempt_at = NULL,
       lease_until = NULL, worker_id = '', error_code = $3, error_message = $3,
       completed_at = $4, updated_at = $4 WHERE id = $1 AND tenant_id = $2
       AND status IN ('pending', 'retry_wait', 'processing')`,
      [job.id, job.tenant_id, code, now.toISOString()]
    ));
  }

  private async unavailable(job: CollaborationTranslationJob, profileId: string, code: string, now: Date) {
    await withPgTenant(this.input.pg, job.tenant_id, (pg) => pg.query(
      `UPDATE collaboration_translation_jobs SET provider_profile_id = $3,
       error_code = $4, error_message = $4, updated_at = $5
       WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'retry_wait')`,
      [job.id, job.tenant_id, profileId, code, now.toISOString()]
    ));
  }

  private async reconcileExpired(tenantId: string | undefined, now: Date): Promise<void> {
    const query = (pg: PgQueryable) => pg.query(
      `UPDATE collaboration_translation_jobs
       SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
           next_attempt_at = CASE WHEN attempt_count >= max_attempts THEN NULL ELSE $2 END,
           lease_until = NULL, worker_id = '', error_code = 'claim_lease_expired',
           error_message = 'translation claim lease expired', updated_at = $2,
           completed_at = CASE WHEN attempt_count >= max_attempts THEN $2 ELSE NULL END
       WHERE ($1 = '' OR tenant_id = $1) AND status = 'processing' AND lease_until <= $2`,
      [tenantId || '', now.toISOString()]
    );
    if (tenantId) await withPgTenant(this.input.pg, tenantId, query);
    else await withPgBypass(this.input.pg, query);
  }

  private async resolveProvider(tenantId: string): Promise<TranslationProviderResolution> {
    if (this.input.resolveProvider) return this.input.resolveProvider({ tenant_id: tenantId });
    const provider = this.input.provider || null;
    return {
      enabled: true,
      automatic: true,
      profile_id: provider?.profile_id || '',
      provider,
      error_code: provider ? '' : 'provider_unavailable'
    };
  }

  private now(): Date {
    return this.input.now?.() || new Date();
  }
}

function source(input: {
  tenant_id: string; session_id: string; source_type: TranslationSourceType;
  source_ref_id: string; source_language: string;
}, messageId: string, text: string): TranslationSource {
  return {
    tenant_id: input.tenant_id,
    session_id: input.session_id,
    message_id: messageId,
    source_type: input.source_type,
    source_ref_id: input.source_ref_id,
    source_ref: `ivekit://${input.source_type}/${input.source_ref_id}`,
    text,
    hash: sha256(text),
    source_language: input.source_language
  };
}

function sourceText(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error('translation source is empty'), { status: 409 });
  return text.slice(0, 200_000);
}

function language(value: unknown, allowAuto: boolean, field: string): string {
  const text = String(value || '').trim();
  if (allowAuto && text.toLowerCase() === 'auto') return 'auto';
  if (!text || text.toLowerCase() === 'auto' || text.length > 35) throw badRequest(`${field} is invalid`);
  try {
    const canonical = Intl.getCanonicalLocales(text)[0];
    if (!canonical) throw new Error('invalid');
    return canonical;
  } catch {
    throw badRequest(`${field} is invalid`);
  }
}

function decodeJob(row: Record<string, unknown>): CollaborationTranslationJob {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), session_id: String(row.session_id),
    message_id: String(row.message_id), source_type: String(row.source_type) as TranslationSourceType,
    source_ref_id: String(row.source_ref_id), source_language: String(row.source_language || 'auto'),
    target_language: String(row.target_language), source_hash: String(row.source_hash),
    status: String(row.status || 'pending') as TranslationJobStatus,
    attempt_count: Number(row.attempt_count || 0), max_attempts: Number(row.max_attempts || 3),
    next_attempt_at: row.next_attempt_at ? String(row.next_attempt_at) : null,
    lease_until: row.lease_until ? String(row.lease_until) : null, worker_id: String(row.worker_id || ''),
    provider_profile_id: String(row.provider_profile_id || ''),
    provider_mode: String(row.provider_mode || 'unconfigured') as CollaborationTranslationJob['provider_mode'],
    provider_name: String(row.provider_name || ''), provider_request_id: String(row.provider_request_id || ''),
    error_code: String(row.error_code || ''), error_message: String(row.error_message || ''),
    output_metadata: record(row.output_metadata), idempotency_key: String(row.idempotency_key || ''),
    payload_hash: String(row.payload_hash || ''), automatic: boolean(row.automatic),
    created_at: String(row.created_at || ''), updated_at: String(row.updated_at || row.created_at || ''),
    completed_at: row.completed_at ? String(row.completed_at) : null
  };
}

function decodeResult(row: Record<string, unknown>): CollaborationTranslationResult {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), message_id: String(row.message_id),
    source_type: String(row.source_type || 'message') as TranslationSourceType,
    source_ref_id: String(row.source_ref_id || row.message_id), source_hash: String(row.source_hash || ''),
    source_language: String(row.source_language || 'auto'), target_language: String(row.target_language),
    translated_text: String(row.translated_body || ''), provider_profile_id: String(row.provider_profile_id || ''),
    provider_mode: String(row.provider_mode || 'unconfigured') as CollaborationTranslationResult['provider_mode'],
    provider_name: String(row.provider || ''), provider_request_id: String(row.provider_request_id || ''),
    confidence: row.confidence == null ? null : Number(row.confidence), output_metadata: record(row.output_metadata),
    created_at: String(row.created_at || ''), updated_at: String(row.updated_at || row.created_at || '')
  };
}

function classify(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof TranslationProviderError) {
    return { code: error.code.slice(0, 100), message: error.message.slice(0, 300), retryable: error.retryable };
  }
  const details = error as { code?: unknown; retryable?: unknown; message?: unknown };
  const code = String(details?.code || 'translation_failed').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  return { code, message: String(details?.message || code).slice(0, 300), retryable: details?.retryable === true };
}

function serviceError(code: string, retryable: boolean): Error {
  return Object.assign(new Error(code), { code, retryable });
}
function badRequest(message: string): Error { return Object.assign(new Error(message), { status: 400 }); }
function conflict(message: string): Error { return Object.assign(new Error(message), { status: 409 }); }
function notFound(message: string): Error { return Object.assign(new Error(message), { status: 404 }); }
function errorStatus(error: unknown): number { return Number((error as { status?: unknown })?.status || 0); }
function errorCode(error: unknown): string { return String((error as { code?: unknown })?.code || ''); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function boolean(value: unknown): boolean { return value === true || value === 'true' || value === 1 || value === '1'; }
function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try { const parsed = JSON.parse(String(value || '{}')); return parsed && typeof parsed === 'object' ? parsed : {}; }
  catch { return {}; }
}
function boundedText(value: unknown, max: number, field: string): string {
  const text = String(value || '').trim(); if (!text || text.length > max) throw badRequest(`${field} is invalid`); return text;
}
function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} must be between ${min} and ${max}`); return value;
}
function retryDelays(values: number[]): number[] {
  if (!values.length || values.some((value) => !Number.isInteger(value) || value < 0 || value > 3_600_000)) throw new Error('retryDelaysMs is invalid'); return values;
}
function emptySummary(): TranslationRunSummary { return { candidates: 0, claimed: 0, succeeded: 0, retry_wait: 0, failed: 0 }; }
function addSummary(target: TranslationRunSummary, value: TranslationRunSummary): void {
  target.candidates += value.candidates; target.claimed += value.claimed; target.succeeded += value.succeeded;
  target.retry_wait += value.retry_wait; target.failed += value.failed;
}
