import { createHash } from 'node:crypto';

import { pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import type { EgressRecord } from '../livekit/types.js';
import {
  AttachmentProcessingService,
  type AttachmentProviderResolver
} from './attachment-processing.js';
import { CollaborationStore } from './collaboration-store.js';
import type { IntelligenceProviderRegistry } from './intelligence-provider-registry.js';
import { createPolicyAttachmentProviderResolver } from './intelligence-provider-routing.js';
import { RemoteAssistanceStore } from './remote-assistance-store.js';
import type {
  CollaborationAttachmentProcessingJob,
  CollaborationMessage,
  CollaborationMessageAttachment,
  EvidenceRecord
} from './types.js';

export type IntelligenceSourceType = 'media_recording' | 'remote_recording';

export interface IntelligenceSourceLink {
  id: string;
  tenant_id: string;
  session_id: string;
  source_type: IntelligenceSourceType;
  source_ref_id: string;
  message_id: string;
  attachment_id: string;
  processor_profile_id: string;
  content_type: string;
  checksum: string;
  status: 'pending' | 'processing' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled';
  error_code: string;
  created_by: string;
  idempotency_key: string;
  request_hash: string;
  created_at: string;
  updated_at: string;
}

export interface IntelligenceSourceSnapshot {
  source: IntelligenceSourceLink;
  message: CollaborationMessage;
  attachment: CollaborationMessageAttachment;
  job: CollaborationAttachmentProcessingJob | null;
  replayed: boolean;
}

export interface IntelligenceSourceServiceInput {
  pg: PgQueryable;
  registry: IntelligenceProviderRegistry;
  resolveProvider?: AttachmentProviderResolver;
  getMediaRecording?: (recordingId: string) => EgressRecord | null | Promise<EgressRecord | null>;
}

interface ResolvedSource {
  storage_url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum: string;
  attachment_kind: 'audio' | 'screen_recording';
}

export class IntelligenceSourceService {
  constructor(private readonly input: IntelligenceSourceServiceInput) {}

  async importSource(input: {
    tenant_id: string;
    session_id: string;
    source_type: IntelligenceSourceType;
    source_ref_id: string;
    actor_identity: string;
    idempotency_key: string;
  }): Promise<IntelligenceSourceSnapshot> {
    const normalized = normalizeImport(input);
    const requestHash = sha256(JSON.stringify({
      tenant_id: normalized.tenant_id,
      session_id: normalized.session_id,
      source_type: normalized.source_type,
      source_ref_id: normalized.source_ref_id
    }));
    return withPgTenant(this.input.pg, normalized.tenant_id, (scopedPg) =>
      withPgTransaction(scopedPg, async (pg) => {
        const replay = await sourceByIdempotencyKey(pg, normalized.tenant_id, normalized.idempotency_key);
        if (replay) {
          assertRequestHash(replay, requestHash);
          return this.snapshot(pg, replay, true);
        }
        await pg.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `ivekit-source:${normalized.tenant_id}:${normalized.session_id}:${normalized.source_type}:${normalized.source_ref_id}`
        ]);
        const existingSource = await sourceByIdentity(pg, normalized);
        if (existingSource) {
          assertRequestHash(existingSource, requestHash);
          return this.snapshot(pg, existingSource, true);
        }

        const store = new CollaborationStore(pg);
        const session = await store.requireTenantSession(normalized.tenant_id, normalized.session_id);
        const source = await this.resolveSource(pg, normalized.tenant_id, normalized.source_type, normalized.source_ref_id);
        if (
          source.tenant_id !== normalized.tenant_id ||
          source.business_ref_type !== session.business_ref.type ||
          source.business_ref_id !== session.business_ref.id
        ) throw sourceError('intelligence recording source not found', 404);

        const material = materialForSource(source);
        const messageResult = await store.postOutgoingMessage({
          tenant_id: normalized.tenant_id,
          session_id: normalized.session_id,
          sender_identity: 'system',
          message_type: 'system',
          body: '',
          metadata: {
            intelligence_source_type: normalized.source_type,
            intelligence_source_ref_id: normalized.source_ref_id
          },
          attachments: [{
            kind: material.attachment_kind,
            storage_url: material.storage_url,
            filename: material.filename,
            content_type: material.content_type,
            size_bytes: material.size_bytes,
            checksum: material.checksum,
            processing_status: 'pending',
            metadata: {
              intelligence_source_type: normalized.source_type,
              intelligence_source_ref_id: normalized.source_ref_id
            }
          }],
          idempotency_key: `intelligence-source:${normalized.idempotency_key}`,
          idempotency_payload_hash: requestHash,
          provider: 'local',
          provider_topic_id: '',
          provider_payload: '',
          provider_metadata: { mode: 'intelligence_source' },
          provider_delivery_status: 'not_required'
        });
        const message = messageResult.message;
        const attachment = message.attachments[0];
        if (!attachment) throw new Error('intelligence source attachment was not created');
        const processing = this.processingService(pg);
        const jobs = await processing.enqueueMessage(message, { automatic: false });
        const job = jobs[0] || null;
        const inserted = await pg.query(
          `INSERT INTO collaboration_intelligence_source_links
            (id, tenant_id, session_id, source_type, source_ref_id, message_id, attachment_id,
             processor_profile_id, content_type, checksum, status, error_code, created_by,
             idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            pgId('cisrc'),
            normalized.tenant_id,
            normalized.session_id,
            normalized.source_type,
            normalized.source_ref_id,
            message.id,
            attachment.id,
            job?.provider_profile_id || '',
            material.content_type,
            material.checksum,
            sourceStatus(job),
            job?.error_code || '',
            normalized.actor_identity,
            normalized.idempotency_key,
            requestHash
          ]
        );
        if (inserted.rows[0]) return this.snapshot(pg, decodeSourceLink(inserted.rows[0]), false);
        const winner = await sourceByIdentity(pg, normalized);
        if (!winner) throw new Error('intelligence source insert conflict did not return a row');
        assertRequestHash(winner, requestHash);
        return this.snapshot(pg, winner, true);
      })
    );
  }

  async getSource(input: {
    tenant_id: string;
    session_id: string;
    source_id: string;
  }): Promise<IntelligenceSourceSnapshot | null> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM collaboration_intelligence_source_links
         WHERE id = $1 AND tenant_id = $2 AND session_id = $3`,
        [input.source_id, input.tenant_id, input.session_id]
      );
      return result.rows[0] ? this.snapshot(pg, decodeSourceLink(result.rows[0]), false) : null;
    });
  }

  async retrySource(input: {
    tenant_id: string;
    session_id: string;
    source_id: string;
  }): Promise<IntelligenceSourceSnapshot | null> {
    return withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const current = await this.getSource(input);
      if (!current) return null;
      const job = await this.processingService(pg).retryAttachment({
        tenant_id: input.tenant_id,
        attachment_id: current.attachment.id
      });
      if (!job) throw sourceError('intelligence source is not retryable', 409);
      await pg.query(
        `UPDATE collaboration_intelligence_source_links
         SET status = 'pending', error_code = '', processor_profile_id = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2 AND session_id = $3`,
        [input.source_id, input.tenant_id, input.session_id, job.provider_profile_id]
      );
      return this.getSource(input);
    });
  }

  private processingService(pg: PgQueryable): AttachmentProcessingService {
    return new AttachmentProcessingService({
      pg,
      resolveProvider: this.input.resolveProvider || createPolicyAttachmentProviderResolver({
        pg,
        registry: this.input.registry
      })
    });
  }

  private async resolveSource(
    pg: PgQueryable,
    tenantId: string,
    sourceType: IntelligenceSourceType,
    sourceRefId: string
  ): Promise<(EgressRecord | EvidenceRecord) & { business_ref_type: string; business_ref_id: string }> {
    if (sourceType === 'media_recording') {
      const recording = await this.input.getMediaRecording?.(sourceRefId);
      if (!recording) throw sourceError('intelligence recording source not found', 404);
      return recording;
    }
    const evidence = await new RemoteAssistanceStore(pg).getEvidence({
      tenant_id: tenantId,
      evidence_id: sourceRefId
    });
    if (!evidence) throw sourceError('intelligence recording source not found', 404);
    return evidence;
  }

  private async snapshot(
    pg: PgQueryable,
    source: IntelligenceSourceLink,
    replayed: boolean
  ): Promise<IntelligenceSourceSnapshot> {
    const message = await new CollaborationStore(pg).getMessage({
      tenant_id: source.tenant_id,
      message_id: source.message_id
    });
    if (!message) throw new Error('intelligence source message is missing');
    const processing = new AttachmentProcessingService({ pg });
    const attachment = await processing.getAttachment({
      tenant_id: source.tenant_id,
      attachment_id: source.attachment_id
    });
    if (!attachment) throw new Error('intelligence source attachment is missing');
    const job = await processing.getJobForAttachment({
      tenant_id: source.tenant_id,
      attachment_id: source.attachment_id
    });
    return {
      source: { ...source, status: sourceStatus(job), error_code: job?.error_code || source.error_code },
      message,
      attachment,
      job,
      replayed
    };
  }
}

function materialForSource(source: EgressRecord | EvidenceRecord): ResolvedSource {
  if ('format' in source) {
    if (!['stopped', 'completed'].includes(source.status)) {
      throw sourceError('media recording is not complete', 409);
    }
    if (source.deleted_at || source.object_status === 'deleted') {
      throw sourceError('intelligence recording source not found', 404);
    }
    if (!source.storage_url) throw sourceError('media recording object is unavailable', 422);
    return {
      storage_url: source.storage_url,
      filename: `${source.id}.${source.format}`,
      content_type: contentTypeForRecording(source),
      size_bytes: Math.max(0, Number(source.file_size_bytes || 0)),
      checksum: '',
      attachment_kind: source.has_video ? 'screen_recording' : 'audio'
    };
  }
  if (!['audio_recording', 'video_recording', 'screen_recording'].includes(source.kind)) {
    throw sourceError('remote evidence is not a recording', 422);
  }
  if (!source.storage_url) throw sourceError('remote recording object is unavailable', 422);
  const contentType = evidenceContentType(source);
  return {
    storage_url: source.storage_url,
    filename: `${source.id}.${extensionForContentType(contentType)}`,
    content_type: contentType,
    size_bytes: Math.max(0, Number(source.metadata.size_bytes || 0)),
    checksum: source.checksum,
    attachment_kind: source.kind === 'audio_recording' ? 'audio' : 'screen_recording'
  };
}

function contentTypeForRecording(recording: EgressRecord): string {
  if (recording.format === 'wav') return 'audio/wav';
  if (recording.format === 'ogg') return 'audio/ogg';
  if (recording.format === 'mp4') return recording.has_video ? 'video/mp4' : 'audio/mp4';
  if (recording.format === 'webm') return recording.has_video ? 'video/webm' : 'audio/webm';
  return 'audio/ogg';
}

function evidenceContentType(evidence: EvidenceRecord): string {
  const configured = String(evidence.metadata.content_type || '').trim();
  if (/^(?:audio|video)\/[a-zA-Z0-9.+-]+$/.test(configured)) return configured;
  const extension = evidence.storage_url.split('?')[0].split('.').pop()?.toLowerCase();
  if (extension === 'mp4') return 'video/mp4';
  if (extension === 'wav') return 'audio/wav';
  if (extension === 'ogg') return 'audio/ogg';
  return evidence.kind === 'audio_recording' ? 'audio/webm' : 'video/webm';
}

function extensionForContentType(contentType: string): string {
  if (contentType === 'video/mp4') return 'mp4';
  if (contentType === 'audio/wav') return 'wav';
  if (contentType === 'audio/ogg') return 'ogg';
  return 'webm';
}

function sourceStatus(job: CollaborationAttachmentProcessingJob | null): IntelligenceSourceLink['status'] {
  return job?.status || 'pending';
}

async function sourceByIdempotencyKey(
  pg: PgQueryable,
  tenantId: string,
  idempotencyKey: string
): Promise<IntelligenceSourceLink | null> {
  const result = await pg.query(
    `SELECT * FROM collaboration_intelligence_source_links
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  return result.rows[0] ? decodeSourceLink(result.rows[0]) : null;
}

async function sourceByIdentity(
  pg: PgQueryable,
  input: { tenant_id: string; session_id: string; source_type: string; source_ref_id: string }
): Promise<IntelligenceSourceLink | null> {
  const result = await pg.query(
    `SELECT * FROM collaboration_intelligence_source_links
     WHERE tenant_id = $1 AND session_id = $2 AND source_type = $3 AND source_ref_id = $4`,
    [input.tenant_id, input.session_id, input.source_type, input.source_ref_id]
  );
  return result.rows[0] ? decodeSourceLink(result.rows[0]) : null;
}

function decodeSourceLink(row: Record<string, unknown>): IntelligenceSourceLink {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    source_type: String(row.source_type) as IntelligenceSourceType,
    source_ref_id: String(row.source_ref_id),
    message_id: String(row.message_id),
    attachment_id: String(row.attachment_id),
    processor_profile_id: String(row.processor_profile_id || ''),
    content_type: String(row.content_type || ''),
    checksum: String(row.checksum || ''),
    status: String(row.status || 'pending') as IntelligenceSourceLink['status'],
    error_code: String(row.error_code || ''),
    created_by: String(row.created_by || ''),
    idempotency_key: String(row.idempotency_key || ''),
    request_hash: String(row.request_hash || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || row.created_at || '')
  };
}

function normalizeImport(input: {
  tenant_id: string;
  session_id: string;
  source_type: IntelligenceSourceType;
  source_ref_id: string;
  actor_identity: string;
  idempotency_key: string;
}) {
  const sourceType = String(input.source_type || '').trim();
  if (sourceType !== 'media_recording' && sourceType !== 'remote_recording') {
    throw sourceError('source_type must be media_recording or remote_recording', 400);
  }
  const sourceRefId = requiredId(input.source_ref_id, 'source_ref_id');
  if (sourceRefId.includes('://') || sourceRefId.includes('/') || sourceRefId.includes('\\')) {
    throw sourceError('source_ref_id is invalid', 400);
  }
  return {
    tenant_id: requiredId(input.tenant_id, 'tenant_id'),
    session_id: requiredId(input.session_id, 'session_id'),
    source_type: sourceType,
    source_ref_id: sourceRefId,
    actor_identity: requiredText(input.actor_identity, 'actor_identity', 200),
    idempotency_key: requiredText(input.idempotency_key, 'idempotency_key', 100)
  } as const;
}

function requiredId(value: unknown, field: string): string {
  const id = requiredText(value, field, 200);
  if (!/^[a-zA-Z0-9._:-]+$/.test(id)) throw sourceError(`${field} is invalid`, 400);
  return id;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) throw sourceError(`${field} is invalid`, 400);
  return text;
}

function assertRequestHash(source: IntelligenceSourceLink, expected: string): void {
  if (source.request_hash !== expected) throw sourceError('idempotency key payload conflict', 409);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

export async function syncIntelligenceSourceForAttachment(
  pg: PgQueryable,
  input: {
    tenant_id: string;
    attachment_id: string;
    job: CollaborationAttachmentProcessingJob;
  }
): Promise<IntelligenceSourceLink | null> {
  return withPgTenant(pg, input.tenant_id, async (scopedPg) => {
    const result = await scopedPg.query(
      `UPDATE collaboration_intelligence_source_links
       SET status = $3, error_code = $4, processor_profile_id = $5, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND attachment_id = $2
       RETURNING *`,
      [
        input.tenant_id,
        input.attachment_id,
        input.job.status,
        input.job.error_code,
        input.job.provider_profile_id
      ]
    );
    return result.rows[0] ? decodeSourceLink(result.rows[0]) : null;
  });
}
