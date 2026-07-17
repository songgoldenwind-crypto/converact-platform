import { createHash } from 'node:crypto';

import { MemoryPg, pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import { withPgBypass, withPgTenant } from '../../db-pg-tenant.js';
import { createObjectStorage } from '../../storage/object-storage.js';
import { resolveRecordingObjectContent } from '../media-recording-object.js';
import { CollaborationStore } from './collaboration-store.js';
import { SecureFileStore } from './secure-file-store.js';
import type {
  CollaborationAttachmentProcessingJob,
  CollaborationAttachmentProcessor,
  CollaborationMessage,
  CollaborationMessageAttachment,
  CollaborationVisualObservation,
  PolicyScanResult
} from './types.js';
import type {
  AttachmentProcessor,
  AttachmentTextProvider,
  AttachmentTextExtractionResult,
  AttachmentVisualObservation
} from './attachment-text-provider.js';
import { listCollaborationWorkerTenants } from './worker-tenant-scope.js';
import {
  sanitizeProviderMetadata,
  sanitizeProviderRequestId
} from './provider-safety.js';
import { intelligenceProviderRouteFailure } from './intelligence-provider-route.js';

export type {
  AttachmentProviderMode,
  AttachmentMediaMode,
  AttachmentTextExtractionInput,
  AttachmentTextExtractionResult,
  AttachmentTextProvider,
  AttachmentVisualObservation,
  AttachmentVisualObservationType
} from './attachment-text-provider.js';

export interface AttachmentObjectResult {
  status: 'readable' | 'missing_storage_url' | 'not_found' | 'forbidden' | 'unsupported' | 'fetch_failed';
  source?: string;
  content?: Buffer;
  error?: string;
}

export interface AttachmentProcessingServiceInput {
  pg: PgQueryable;
  providers?: Partial<Record<AttachmentProcessor, AttachmentTextProvider | null>>;
  resolveProvider?: AttachmentProviderResolver;
  resolveObject?: (attachment: CollaborationMessageAttachment) => Promise<AttachmentObjectResult>;
  now?: () => Date;
  maxAttempts?: number;
  retryDelaysMs?: number[];
  claimLeaseMs?: number;
  onProcessed?: (input: {
    attachment: CollaborationMessageAttachment;
    job: CollaborationAttachmentProcessingJob;
    policy: PolicyScanResult;
  }) => void | Promise<void>;
}

export interface AttachmentProviderResolution {
  enabled: boolean;
  automatic: boolean;
  profile_id: string;
  provider: AttachmentTextProvider | null;
  error_code: string;
}

export type AttachmentProviderResolver = (input: {
  tenant_id: string;
  processor: CollaborationAttachmentProcessor;
}) => Promise<AttachmentProviderResolution>;

export interface AttachmentProcessingRunSummary {
  candidates: number;
  claimed: number;
  succeeded: number;
  retry_wait: number;
  failed: number;
}

export class AttachmentProcessingService {
  private readonly providers: Partial<Record<AttachmentProcessor, AttachmentTextProvider | null>>;
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: number[];
  private readonly claimLeaseMs: number;

  constructor(private readonly input: AttachmentProcessingServiceInput) {
    this.providers = input.providers || {};
    this.maxAttempts = boundedInteger(input.maxAttempts ?? 3, 1, 10, 'maxAttempts');
    this.retryDelaysMs = normalizeRetryDelays(input.retryDelaysMs || [2_000, 10_000]);
    this.claimLeaseMs = boundedInteger(input.claimLeaseMs ?? 60_000, 5_000, 600_000, 'claimLeaseMs');
  }

  async enqueueMessage(
    message: CollaborationMessage,
    options: { automatic?: boolean } = {}
  ): Promise<CollaborationAttachmentProcessingJob[]> {
    return withPgTenant(this.input.pg, message.tenant_id, async (pg) => {
      const jobs: CollaborationAttachmentProcessingJob[] = [];
      for (const attachment of message.attachments) {
        const processors = processorsForAttachment(attachment);
        if (!processors.length || attachment.extracted_text) continue;
        for (const processor of processors) {
          const resolution = await this.resolveProvider(message.tenant_id, processor);
          const provider = resolution.provider;
          const cancelled = !resolution.enabled || (options.automatic !== false && !resolution.automatic);
          const status = cancelled ? 'cancelled' : 'pending';
          const errorCode = !resolution.enabled
            ? resolution.error_code || 'policy_disabled'
            : options.automatic !== false && !resolution.automatic
              ? 'automatic_processing_disabled'
              : provider
                ? ''
                : resolution.error_code || 'provider_unavailable';
          const inserted = await pg.query(
            `INSERT INTO collaboration_attachment_processing_jobs
              (id, tenant_id, session_id, message_id, attachment_id, processor, status,
               max_attempts, provider_profile_id, provider_mode, provider_name, error_code)
             VALUES ($1, $2, $3, $4, $5, $6, $8, $7, $9, $10, $11, $12)
             ON CONFLICT (tenant_id, attachment_id, processor) DO NOTHING
             RETURNING *`,
            [
              pgId('capj'), message.tenant_id, message.session_id, message.id, attachment.id,
              processor, this.maxAttempts, status, resolution.profile_id,
              provider?.mode || 'unconfigured', provider?.name || '', errorCode
            ]
          );
          const row = inserted.rows[0] || (await pg.query(
            `SELECT * FROM collaboration_attachment_processing_jobs
             WHERE tenant_id = $1 AND attachment_id = $2 AND processor = $3`,
            [message.tenant_id, attachment.id, processor]
          )).rows[0];
          if (row) jobs.push(decodeJob(row));
        }
        await this.refreshAttachmentProcessingStatus(
          pg, message.tenant_id, attachment.id, this.now().toISOString()
        );
      }
      return jobs;
    });
  }

  async getAttachment(input: {
    tenant_id: string;
    attachment_id: string;
  }): Promise<CollaborationMessageAttachment | null> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        'SELECT * FROM collaboration_message_attachments WHERE id = $1 AND tenant_id = $2',
        [input.attachment_id, input.tenant_id]
      );
      return result.rows[0] ? decodeAttachment(result.rows[0]) : null;
    });
  }

  async getJobForAttachment(input: {
    tenant_id: string;
    attachment_id: string;
  }): Promise<CollaborationAttachmentProcessingJob | null> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM collaboration_attachment_processing_jobs
         WHERE tenant_id = $1 AND attachment_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [input.tenant_id, input.attachment_id]
      );
      return result.rows[0] ? decodeJob(result.rows[0]) : null;
    });
  }

  async listJobsForAttachment(input: {
    tenant_id: string;
    attachment_id: string;
  }): Promise<CollaborationAttachmentProcessingJob[]> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM collaboration_attachment_processing_jobs
         WHERE tenant_id = $1 AND attachment_id = $2
         ORDER BY created_at ASC, id ASC`,
        [input.tenant_id, input.attachment_id]
      );
      return result.rows.map(decodeJob);
    });
  }

  async listVisualObservations(input: {
    tenant_id: string;
    attachment_id: string;
  }): Promise<CollaborationVisualObservation[]> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM collaboration_visual_observations
         WHERE tenant_id = $1 AND attachment_id = $2
         ORDER BY created_at ASC, id ASC`,
        [input.tenant_id, input.attachment_id]
      );
      return result.rows.map(decodeVisualObservation);
    });
  }

  async retryAttachment(input: {
    tenant_id: string;
    attachment_id: string;
  }): Promise<CollaborationAttachmentProcessingJob | null> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const now = this.now().toISOString();
      const result = await pg.query(
        `UPDATE collaboration_attachment_processing_jobs
         SET status = 'pending', attempt_count = 0, next_attempt_at = NULL,
             lease_until = NULL, worker_id = '', error_code = '', error_message = '',
             completed_at = NULL, updated_at = $3
         WHERE tenant_id = $1 AND attachment_id = $2 AND status IN ('failed', 'cancelled')
         RETURNING *`,
        [input.tenant_id, input.attachment_id, now]
      );
      if (!result.rows[0]) return null;
      await pg.query(
        `UPDATE collaboration_message_attachments
         SET processing_status = 'pending', processing_error_code = '', updated_at = $3
         WHERE id = $1 AND tenant_id = $2`,
        [input.attachment_id, input.tenant_id, now]
      );
      return decodeJob(result.rows[0]);
    });
  }

  async runDue(input: { tenant_id?: string; limit?: number } = {}): Promise<AttachmentProcessingRunSummary> {
    const now = this.now();
    const limit = boundedInteger(input.limit ?? 25, 1, 100, 'limit');
    if (!input.tenant_id && !(this.input.pg instanceof MemoryPg)) {
      const tenants = await listCollaborationWorkerTenants(this.input.pg, 'attachment', now, limit);
      const total: AttachmentProcessingRunSummary = {
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
    const configuredProcessors = this.input.resolveProvider
      ? undefined
      : configuredJobProcessors(this.providers);
    const candidates = await this.listDue(
      input.tenant_id,
      now,
      limit,
      configuredProcessors?.length ? configuredProcessors : undefined
    );
    const summary: AttachmentProcessingRunSummary = {
      candidates: candidates.length,
      claimed: 0,
      succeeded: 0,
      retry_wait: 0,
      failed: 0
    };

    for (const candidate of candidates) {
      const resolution = await this.resolveProvider(candidate.tenant_id, candidate.processor);
      if (!resolution.enabled) {
        await this.cancelUnclaimed(candidate, resolution.error_code || 'policy_disabled', now);
        continue;
      }
      const provider = resolution.provider;
      if (!provider) {
        await this.markProviderUnavailable(candidate, resolution.error_code || 'provider_unavailable', now);
        continue;
      }
      const claimed = await this.claim(candidate, provider, resolution.profile_id, now);
      if (!claimed) continue;
      summary.claimed += 1;
      const status = await this.processClaim(claimed, provider);
      summary[status] += 1;
    }
    return summary;
  }

  private async processClaim(
    job: CollaborationAttachmentProcessingJob,
    provider: AttachmentTextProvider
  ): Promise<'succeeded' | 'retry_wait' | 'failed'> {
    try {
      const attachment = await this.getAttachment({
        tenant_id: job.tenant_id,
        attachment_id: job.attachment_id
      });
      if (!attachment) throw processingError('attachment_not_found', false);
      const object = await this.resolveObject(attachment);
      if (object.status !== 'readable' || !object.content) {
        throw processingError(
          object.error || `attachment_object_${object.status}`,
          object.status === 'not_found' || object.status === 'fetch_failed'
        );
      }
      const output = await provider.extract({
        attachment_id: attachment.id,
        tenant_id: attachment.tenant_id,
        session_id: attachment.session_id,
        message_id: attachment.message_id,
        filename: attachment.filename,
        content_type: attachment.content_type,
        source_ref: `ivekit://attachment/${attachment.id}`,
        content: object.content,
        ...(job.processor === 'video_frame_ocr'
          ? { media_mode: 'video_frame_sampling' as const, frame_interval_ms: 2_000, max_frames: 120 }
          : { media_mode: 'text' as const })
      });
      const completed = await this.complete(job, attachment, provider, output);
      try {
        await this.input.onProcessed?.(completed);
      } catch {
        // Extraction is already committed; notification delivery is best-effort.
      }
      return 'succeeded';
    } catch (error) {
      return this.fail(job, error);
    }
  }

  private async complete(
    job: CollaborationAttachmentProcessingJob,
    attachment: CollaborationMessageAttachment,
    provider: AttachmentTextProvider,
    output: AttachmentTextExtractionResult
  ): Promise<{
    attachment: CollaborationMessageAttachment;
    job: CollaborationAttachmentProcessingJob;
    policy: PolicyScanResult;
  }> {
    const now = this.now().toISOString();
    const text = String(output.text || '').trim().slice(0, 200_000);
    return withPgTenant(this.input.pg, job.tenant_id, (scopedPg) =>
      withPgTransaction(scopedPg, async (pg) => {
        const ocrText = job.processor === 'ocr' || job.processor === 'video_frame_ocr'
          ? text
          : attachment.ocr_text;
        const asrText = job.processor === 'asr' ? text : attachment.asr_text;
        const extractedText = [ocrText, asrText].filter(Boolean).join('\n');
        const safeOutputMetadata = sanitizeProviderMetadata(output.metadata || {});
        const providerRequestId = sanitizeProviderRequestId(output.provider_request_id);
        const metadata = {
          ...attachment.metadata,
          ...safeOutputMetadata,
          extraction_processor: job.processor,
          extraction_provider: provider.name,
          extraction_provider_mode: provider.mode,
          extraction_provider_profile_id: provider.profile_id || job.provider_profile_id,
          ...(output.confidence != null ? { extraction_confidence: output.confidence } : {}),
          ...(output.language ? { extraction_language: output.language } : {}),
          ...(providerRequestId ? { provider_request_id: providerRequestId } : {})
        };
        const attachmentResult = await pg.query(
          `UPDATE collaboration_message_attachments
           SET processing_status = 'ready', ocr_text = $3, asr_text = $4,
               extracted_text = $5, processing_error_code = '', metadata = $6,
               processed_at = $7, updated_at = $7
           WHERE id = $1 AND tenant_id = $2
           RETURNING *`,
          [attachment.id, job.tenant_id, ocrText, asrText, extractedText, JSON.stringify(metadata), now]
        );
        if (!attachmentResult.rows[0]) throw processingError('attachment_update_conflict', true);
        const outputMetadata = {
          confidence: output.confidence ?? null,
          language: output.language || '',
          provider_request_id: providerRequestId,
          text_length: text.length,
          observation_count: output.observations?.length || 0,
          object_source: ''
        };
        const jobResult = await pg.query(
          `UPDATE collaboration_attachment_processing_jobs
           SET status = 'succeeded', provider_profile_id = $4, provider_mode = $5, provider_name = $6,
               error_code = '', error_message = '', output_metadata = $7,
               lease_until = NULL, worker_id = '', completed_at = $8, updated_at = $8
           WHERE id = $1 AND tenant_id = $2 AND status = 'processing' AND worker_id = $3
           RETURNING *`,
          [
            job.id,
            job.tenant_id,
            job.worker_id,
            provider.profile_id || job.provider_profile_id,
            provider.mode,
            provider.name,
            JSON.stringify(outputMetadata),
            now
          ]
        );
        if (!jobResult.rows[0]) throw processingError('attachment_job_claim_lost', true);
        const policySource = job.processor === 'video_frame_ocr' ? 'ocr' : job.processor;
        const policyResults: PolicyScanResult[] = [];
        if (text) {
          policyResults.push(await new CollaborationStore(pg).scanPolicy({
            tenant_id: job.tenant_id,
            session_id: job.session_id,
            message_id: job.message_id,
            source: policySource,
            source_ref_id: attachment.id,
            evidence_refs: [{
              type: 'attachment',
              id: attachment.id,
              processor: job.processor,
              checksum: attachment.checksum
            }],
            text
          }));
        }
        for (const observation of output.observations || []) {
          await this.persistVisualObservation(pg, job, observation, now);
          policyResults.push(await new CollaborationStore(pg).scanPolicy({
            tenant_id: job.tenant_id,
            session_id: job.session_id,
            message_id: job.message_id,
            source: 'ocr',
            source_ref_id: attachment.id,
            evidence_refs: [{
              type: 'attachment',
              id: attachment.id,
              processor: job.processor,
              checksum: attachment.checksum,
              observation_type: observation.type,
              symbology: observation.symbology || '',
              frame_timestamp_ms: observation.frame_timestamp_ms ?? null,
              page_number: observation.page ?? null
            }],
            text: observation.value
          }));
        }
        const refreshedAttachment = await this.refreshAttachmentProcessingStatus(
          pg, job.tenant_id, attachment.id, now
        );
        return {
          attachment: refreshedAttachment || decodeAttachment(attachmentResult.rows[0]),
          job: decodeJob(jobResult.rows[0]),
          policy: mergePolicyResults(policyResults)
        };
      })
    );
  }

  private async persistVisualObservation(
    pg: PgQueryable,
    job: CollaborationAttachmentProcessingJob,
    observation: AttachmentVisualObservation,
    now: string
  ): Promise<void> {
    const valueHash = createHash('sha256').update(observation.value).digest('hex');
    await pg.query(
      `INSERT INTO collaboration_visual_observations
        (id, tenant_id, session_id, message_id, attachment_id, processor_job_id,
         observation_type, value_hash, symbology, confidence, frame_timestamp_ms,
         page_number, metadata, detector_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT DO NOTHING`,
      [
        pgId('cvo'), job.tenant_id, job.session_id, job.message_id, job.attachment_id, job.id,
        observation.type, valueHash, observation.symbology || '', observation.confidence ?? null,
        observation.frame_timestamp_ms ?? null, observation.page ?? null,
        JSON.stringify(sanitizeProviderMetadata(observation.metadata || {})),
        'visual-observation-v1', now
      ]
    );
  }

  private async refreshAttachmentProcessingStatus(
    pg: PgQueryable,
    tenantId: string,
    attachmentId: string,
    now: string
  ): Promise<CollaborationMessageAttachment | null> {
    const result = await pg.query(
      `SELECT status, error_code FROM collaboration_attachment_processing_jobs
       WHERE tenant_id = $1 AND attachment_id = $2`,
      [tenantId, attachmentId]
    );
    if (!result.rows.length) return null;
    const statuses = result.rows.map((row) => String(row.status));
    const active = statuses.some((status) => ['pending', 'processing', 'retry_wait'].includes(status));
    const succeeded = statuses.some((status) => status === 'succeeded');
    const unsuccessful = statuses.some((status) => status === 'failed' || status === 'cancelled');
    const status = active ? 'pending' : succeeded ? 'ready' : 'failed';
    const errorCode = active || (succeeded && !unsuccessful)
      ? ''
      : succeeded
        ? 'partial_processing_failure'
        : String(result.rows.find((row) => row.error_code)?.error_code || 'attachment_processing_failed');
    const updated = await pg.query(
      `UPDATE collaboration_message_attachments
       SET processing_status = $3, processing_error_code = $4, updated_at = $5
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [attachmentId, tenantId, status, errorCode, now]
    );
    return updated.rows[0] ? decodeAttachment(updated.rows[0]) : null;
  }

  private async fail(
    job: CollaborationAttachmentProcessingJob,
    error: unknown
  ): Promise<'retry_wait' | 'failed'> {
    const classified = classifyError(error);
    const terminal = !classified.retryable || (
      classified.attempt_consumed && job.attempt_count >= job.max_attempts
    );
    const status = terminal ? 'failed' : 'retry_wait';
    const now = this.now();
    const nextAttemptAt = terminal
      ? null
      : nextRetryAt(
        now,
        retryDelay(this.retryDelaysMs, job.attempt_count),
        classified.retry_at
      );
    await withPgTenant(this.input.pg, job.tenant_id, async (pg) => {
      await pg.query(
        `UPDATE collaboration_attachment_processing_jobs
         SET status = $4, next_attempt_at = $5, lease_until = NULL, worker_id = '',
             error_code = $6, error_message = $7,
             attempt_count = GREATEST(attempt_count - $9, 0),
             output_metadata = output_metadata || $10::JSONB,
             completed_at = CASE WHEN $4 = 'failed' THEN $8 ELSE NULL END,
             updated_at = $8
         WHERE id = $1 AND tenant_id = $2 AND status = 'processing' AND worker_id = $3`,
        [
          job.id,
          job.tenant_id,
          job.worker_id,
          status,
          nextAttemptAt,
          classified.code,
          classified.message,
          now.toISOString(),
          classified.attempt_consumed ? 0 : 1,
          JSON.stringify(classified.metadata)
        ]
      );
      await this.refreshAttachmentProcessingStatus(
        pg, job.tenant_id, job.attachment_id, now.toISOString()
      );
    });
    return status;
  }

  private async claim(
    candidate: CollaborationAttachmentProcessingJob,
    provider: AttachmentTextProvider,
    profileId: string,
    now: Date
  ): Promise<CollaborationAttachmentProcessingJob | null> {
    const workerId = pgId('capw');
    const leaseUntil = new Date(now.getTime() + this.claimLeaseMs).toISOString();
    return withPgTenant(this.input.pg, candidate.tenant_id, async (pg) => {
      const result = await pg.query(
        `UPDATE collaboration_attachment_processing_jobs
         SET status = 'processing', attempt_count = attempt_count + 1,
             lease_until = $4, worker_id = $3, next_attempt_at = NULL,
             provider_profile_id = $5, provider_mode = $6, provider_name = $7,
             error_code = '', error_message = '', updated_at = $8
         WHERE id = $1 AND tenant_id = $2 AND attempt_count < max_attempts
           AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $8)))
         RETURNING *`,
        [
          candidate.id,
          candidate.tenant_id,
          workerId,
          leaseUntil,
          profileId || provider.profile_id || '',
          provider.mode,
          provider.name,
          now.toISOString()
        ]
      );
      return result.rows[0] ? decodeJob(result.rows[0]) : null;
    });
  }

  private async cancelUnclaimed(
    job: CollaborationAttachmentProcessingJob,
    errorCode: string,
    now: Date
  ): Promise<void> {
    await withPgTenant(this.input.pg, job.tenant_id, async (pg) => {
      await pg.query(
        `UPDATE collaboration_attachment_processing_jobs
         SET status = 'cancelled', error_code = $3, error_message = $3,
             next_attempt_at = NULL, completed_at = $4, updated_at = $4
         WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'retry_wait')`,
        [job.id, job.tenant_id, errorCode, now.toISOString()]
      );
      await this.refreshAttachmentProcessingStatus(
        pg, job.tenant_id, job.attachment_id, now.toISOString()
      );
    });
  }

  private async markProviderUnavailable(
    job: CollaborationAttachmentProcessingJob,
    errorCode: string,
    now: Date
  ): Promise<void> {
    await withPgTenant(this.input.pg, job.tenant_id, async (pg) => {
      await pg.query(
        `UPDATE collaboration_attachment_processing_jobs
         SET error_code = $3, error_message = $3, updated_at = $4
         WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'retry_wait')`,
        [job.id, job.tenant_id, errorCode, now.toISOString()]
      );
    });
  }

  private async resolveProvider(
    tenantId: string,
    processor: CollaborationAttachmentProcessor
  ): Promise<AttachmentProviderResolution> {
    if (this.input.resolveProvider) return this.input.resolveProvider({ tenant_id: tenantId, processor });
    const provider = this.providers[providerCapability(processor)] || null;
    return {
      enabled: true,
      automatic: true,
      profile_id: provider?.profile_id || '',
      provider,
      error_code: provider ? '' : 'provider_unavailable'
    };
  }

  private async listDue(
    tenantId: string | undefined,
    now: Date,
    limit: number,
    processors?: CollaborationAttachmentProcessor[]
  ): Promise<CollaborationAttachmentProcessingJob[]> {
    const query = async (pg: PgQueryable) => {
      const result = tenantId
        ? processors
          ? await pg.query(
            `SELECT * FROM collaboration_attachment_processing_jobs
             WHERE tenant_id = $1 AND attempt_count < max_attempts
               AND processor = ANY($3::text[])
               AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $2)))
             ORDER BY created_at ASC LIMIT $4`,
            [tenantId, now.toISOString(), processors, limit]
          )
          : await pg.query(
          `SELECT * FROM collaboration_attachment_processing_jobs
           WHERE tenant_id = $1 AND attempt_count < max_attempts
             AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $2)))
           ORDER BY created_at ASC LIMIT $3`,
          [tenantId, now.toISOString(), limit]
        )
        : processors
          ? await pg.query(
            `SELECT * FROM collaboration_attachment_processing_jobs
             WHERE attempt_count < max_attempts
               AND processor = ANY($2::text[])
               AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)))
             ORDER BY created_at ASC LIMIT $3`,
            [now.toISOString(), processors, limit]
          )
          : await pg.query(
          `SELECT * FROM collaboration_attachment_processing_jobs
           WHERE attempt_count < max_attempts
             AND (status = 'pending' OR (status = 'retry_wait' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)))
           ORDER BY created_at ASC LIMIT $2`,
          [now.toISOString(), limit]
        );
      return result.rows.map(decodeJob);
    };
    return tenantId
      ? withPgTenant(this.input.pg, tenantId, query)
      : withPgBypass(this.input.pg, query);
  }

  private async reconcileExpired(tenantId: string | undefined, now: Date): Promise<void> {
    const reconcile = async (pg: PgQueryable) => {
      const result = tenantId
        ? await pg.query(
          `UPDATE collaboration_attachment_processing_jobs
           SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
               next_attempt_at = CASE WHEN attempt_count >= max_attempts THEN NULL ELSE $2 END,
               lease_until = NULL, worker_id = '', error_code = 'claim_lease_expired',
               error_message = 'attachment processing claim lease expired', updated_at = $2,
               completed_at = CASE WHEN attempt_count >= max_attempts THEN $2 ELSE NULL END
           WHERE tenant_id = $1 AND status = 'processing' AND lease_until <= $2
           RETURNING tenant_id, attachment_id`,
          [tenantId, now.toISOString()]
        )
        : await pg.query(
          `UPDATE collaboration_attachment_processing_jobs
           SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
               next_attempt_at = CASE WHEN attempt_count >= max_attempts THEN NULL ELSE $1 END,
               lease_until = NULL, worker_id = '', error_code = 'claim_lease_expired',
               error_message = 'attachment processing claim lease expired', updated_at = $1,
               completed_at = CASE WHEN attempt_count >= max_attempts THEN $1 ELSE NULL END
           WHERE status = 'processing' AND lease_until <= $1
           RETURNING tenant_id, attachment_id`,
          [now.toISOString()]
        );
      const affected = new Map<string, { tenant_id: string; attachment_id: string }>();
      for (const row of result.rows) {
        const item = { tenant_id: String(row.tenant_id), attachment_id: String(row.attachment_id) };
        affected.set(`${item.tenant_id}:${item.attachment_id}`, item);
      }
      for (const item of affected.values()) {
        await this.refreshAttachmentProcessingStatus(
          pg, item.tenant_id, item.attachment_id, now.toISOString()
        );
      }
    };
    return tenantId
      ? withPgTenant(this.input.pg, tenantId, reconcile)
      : withPgBypass(this.input.pg, reconcile);
  }

  private async resolveObject(attachment: CollaborationMessageAttachment): Promise<AttachmentObjectResult> {
    if (attachment.secure_file_id) {
      try {
        const file = await new SecureFileStore(this.input.pg).getFile(
          attachment.tenant_id,
          attachment.secure_file_id
        );
        if (
          file.session_id !== attachment.session_id || file.status !== 'ready' ||
          file.threat_status !== 'clean'
        ) {
          return { status: 'forbidden', source: 'secure_file' };
        }
        const content = await createObjectStorage().download(file.object_key, file.size_bytes);
        if (!content) return { status: 'not_found', source: 'secure_file' };
        if (
          content.length !== file.size_bytes ||
          createHash('sha256').update(content).digest('hex') !== file.sha256
        ) {
          return {
            status: 'fetch_failed',
            source: 'secure_file',
            error: 'secure file integrity check failed'
          };
        }
        return { status: 'readable', source: 'secure_file', content };
      } catch (error) {
        return {
          status: 'fetch_failed',
          source: 'secure_file',
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    if (this.input.resolveObject) return this.input.resolveObject(attachment);
    const key = String(attachment.metadata.storage_key || '').trim();
    if (key && key.startsWith(`${attachment.tenant_id}/`)) {
      try {
        const content = await createObjectStorage().download(key);
        return content
          ? { status: 'readable', source: 'object_storage', content }
          : { status: 'not_found', source: 'object_storage' };
      } catch (error) {
        return {
          status: 'fetch_failed',
          source: 'object_storage',
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    return resolveRecordingObjectContent(attachment);
  }

  private now(): Date {
    return this.input.now?.() || new Date();
  }
}

function processorsForAttachment(
  attachment: CollaborationMessageAttachment
): CollaborationAttachmentProcessor[] {
  if (attachment.processing_status !== 'pending') return [];
  if (attachment.kind === 'image') return ['ocr'];
  if (attachment.kind === 'audio') return ['asr'];
  if (attachment.kind === 'video' || attachment.kind === 'screen_recording') {
    return ['asr', 'video_frame_ocr'];
  }
  if (attachment.kind === 'file' && attachment.content_type === 'application/pdf') {
    return ['ocr'];
  }
  return [];
}

function providerCapability(processor: CollaborationAttachmentProcessor): AttachmentProcessor {
  return processor === 'video_frame_ocr' ? 'ocr' : processor;
}

function configuredJobProcessors(
  providers: Partial<Record<AttachmentProcessor, AttachmentTextProvider | null>>
): CollaborationAttachmentProcessor[] {
  const processors: CollaborationAttachmentProcessor[] = [];
  if (providers.ocr) processors.push('ocr', 'video_frame_ocr');
  if (providers.asr) processors.push('asr');
  return processors;
}

function decodeAttachment(row: Record<string, unknown>): CollaborationMessageAttachment {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    secure_file_id: String(row.secure_file_id || ''),
    kind: String(row.kind) as CollaborationMessageAttachment['kind'],
    storage_url: String(row.storage_url || ''),
    filename: String(row.filename || ''),
    content_type: String(row.content_type || ''),
    size_bytes: Number(row.size_bytes || 0),
    checksum: String(row.checksum || ''),
    processing_status: String(row.processing_status || 'pending') as CollaborationMessageAttachment['processing_status'],
    ocr_text: String(row.ocr_text || ''),
    asr_text: String(row.asr_text || ''),
    extracted_text: String(row.extracted_text || ''),
    processing_error_code: String(row.processing_error_code || ''),
    processed_at: row.processed_at ? String(row.processed_at) : null,
    updated_at: String(row.updated_at || row.created_at || ''),
    metadata: parseRecord(row.metadata),
    created_at: String(row.created_at || '')
  };
}

function decodeJob(row: Record<string, unknown>): CollaborationAttachmentProcessingJob {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    attachment_id: String(row.attachment_id),
    processor: String(row.processor) as CollaborationAttachmentProcessingJob['processor'],
    status: String(row.status || 'pending') as CollaborationAttachmentProcessingJob['status'],
    attempt_count: Number(row.attempt_count || 0),
    max_attempts: Number(row.max_attempts || 3),
    next_attempt_at: row.next_attempt_at ? String(row.next_attempt_at) : null,
    lease_until: row.lease_until ? String(row.lease_until) : null,
    worker_id: String(row.worker_id || ''),
    provider_profile_id: String(row.provider_profile_id || ''),
    provider_mode: String(row.provider_mode || 'unconfigured') as CollaborationAttachmentProcessingJob['provider_mode'],
    provider_name: String(row.provider_name || ''),
    error_code: String(row.error_code || ''),
    error_message: String(row.error_message || ''),
    output_metadata: parseRecord(row.output_metadata),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || row.created_at || ''),
    completed_at: row.completed_at ? String(row.completed_at) : null
  };
}

function decodeVisualObservation(row: Record<string, unknown>): CollaborationVisualObservation {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    attachment_id: String(row.attachment_id),
    processor_job_id: String(row.processor_job_id),
    observation_type: String(row.observation_type) as CollaborationVisualObservation['observation_type'],
    value_hash: String(row.value_hash),
    symbology: String(row.symbology || ''),
    confidence: row.confidence == null ? null : Number(row.confidence),
    frame_timestamp_ms: row.frame_timestamp_ms == null ? null : Number(row.frame_timestamp_ms),
    page_number: row.page_number == null ? null : Number(row.page_number),
    metadata: parseRecord(row.metadata),
    detector_version: String(row.detector_version || 'visual-observation-v1'),
    created_at: String(row.created_at || '')
  };
}

function mergePolicyResults(results: PolicyScanResult[]): PolicyScanResult {
  const events = results.flatMap((result) => result.events);
  const findings = results.flatMap((result) => result.findings);
  return { matched: findings.length > 0, events, findings };
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function processingError(code: string, retryable: boolean): Error {
  return Object.assign(new Error(code), { code, retryable });
}

function classifyError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  retry_at: string;
  attempt_consumed: boolean;
  metadata: Record<string, unknown>;
} {
  const details = error as { code?: unknown; retryable?: unknown; message?: unknown };
  const code = String(details?.code || 'attachment_processing_failed').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const route = intelligenceProviderRouteFailure(error);
  const message = String(details?.message || code)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 300);
  return {
    code,
    message,
    retryable: details?.retryable === true,
    retry_at: route?.retry_at || '',
    attempt_consumed: route?.provider_invoked !== false,
    metadata: routeMetadata(route)
  };
}

function retryDelay(delays: number[], attemptCount: number): number {
  return delays[Math.min(Math.max(0, attemptCount - 1), delays.length - 1)] || 0;
}

function nextRetryAt(now: Date, delayMs: number, providerRetryAt: string): string {
  const delayed = now.getTime() + delayMs;
  const requested = Date.parse(providerRetryAt);
  return new Date(Number.isNaN(requested) ? delayed : Math.max(delayed, requested)).toISOString();
}

function routeMetadata(
  route: ReturnType<typeof intelligenceProviderRouteFailure>
): Record<string, unknown> {
  if (!route) return {};
  return {
    ivekit_route_attempts: route.attempts,
    ivekit_route_provider_invoked: route.provider_invoked,
    ivekit_route_failover_attempted: route.failover_attempted,
    ...(route.retry_at ? { ivekit_route_retry_at: route.retry_at } : {})
  };
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
