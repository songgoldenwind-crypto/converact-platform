import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import {
  AttachmentProcessingService,
  type AttachmentProviderResolver
} from './attachment-processing.js';
import { CollaborationStore } from './collaboration-store.js';
import { SecureFileStore } from './secure-file-store.js';
import type { SecureFile } from './secure-file-types.js';
import type {
  CollaborationAttachmentProcessingJob,
  CollaborationMessage,
  CollaborationMessageAttachment,
  CollaborationMessageAttachmentKind
} from './types.js';

export interface RustDeskEvidenceIntelligenceResult {
  status: 'ignored' | 'not_ready' | 'unsupported' | 'enqueued';
  reason: string;
  message: CollaborationMessage | null;
  attachment: CollaborationMessageAttachment | null;
  jobs: CollaborationAttachmentProcessingJob[];
  replayed: boolean;
}

export interface RustDeskEvidenceIntelligenceReconcileSummary {
  candidates: number;
  enqueued: number;
  replayed: number;
  skipped: number;
  failed: number;
}

export class RustDeskEvidenceIntelligenceService {
  constructor(private readonly input: {
    pg: PgQueryable;
    resolveProvider?: AttachmentProviderResolver;
  }) {}

  async enqueueFile(file: SecureFile): Promise<RustDeskEvidenceIntelligenceResult> {
    if (file.metadata.source !== 'rustdesk_companion_evidence') {
      return skipped('ignored', 'not_rustdesk_evidence');
    }
    if (file.status !== 'ready' || file.threat_status !== 'clean') {
      return skipped('not_ready', `secure_file_${file.status}_${file.threat_status}`);
    }
    const attachmentKind = rustDeskAttachmentKind(file);
    if (!attachmentKind) return skipped('unsupported', 'unsupported_detected_mime');

    const context = evidenceContext(file);
    const payload = {
      secure_file_id: file.id,
      attachment_kind: attachmentKind,
      detected_mime: file.detected_mime,
      size_bytes: file.size_bytes,
      sha256: file.sha256,
      context
    };
    const requestHash = createHash('sha256')
      .update(stableJson(payload))
      .digest('hex');
    const store = new CollaborationStore(this.input.pg);
    const posted = await store.postOutgoingMessage({
      tenant_id: file.tenant_id,
      session_id: file.session_id,
      sender_identity: 'system',
      message_type: 'system',
      body: '',
      metadata: {
        internal_processing_only: true,
        source: 'rustdesk_secure_evidence',
        ...context
      },
      attachments: [{
        secure_file_id: file.id,
        kind: attachmentKind,
        storage_url: '',
        filename: file.filename,
        content_type: file.detected_mime,
        size_bytes: file.size_bytes,
        checksum: file.sha256,
        processing_status: 'pending',
        metadata: {
          internal_processing_only: true,
          source: 'rustdesk_secure_evidence',
          ...context
        }
      }],
      idempotency_key: `rustdesk-evidence-intelligence:${file.id}`,
      idempotency_payload_hash: requestHash,
      provider: 'local',
      provider_topic_id: '',
      provider_payload: '',
      provider_metadata: { mode: 'rustdesk_secure_evidence' },
      provider_delivery_status: 'not_required'
    });
    const attachment = posted.message.attachments[0];
    if (!attachment) throw new Error('RustDesk evidence processing attachment was not created');
    const jobs = await new AttachmentProcessingService({
      pg: this.input.pg,
      ...(this.input.resolveProvider ? { resolveProvider: this.input.resolveProvider } : {})
    }).enqueueMessage(posted.message, { automatic: true });
    return {
      status: 'enqueued',
      reason: '',
      message: posted.message,
      attachment,
      jobs,
      replayed: !posted.created
    };
  }

  async reconcileDue(input: {
    limit?: number;
    onEnqueued?: (
      file: SecureFile,
      result: RustDeskEvidenceIntelligenceResult
    ) => void | Promise<void>;
    onError?: (file: SecureFile) => void | Promise<void>;
  } = {}): Promise<RustDeskEvidenceIntelligenceReconcileSummary> {
    const fileStore = new SecureFileStore(this.input.pg);
    const files = await fileStore.listRustDeskEvidenceIntelligenceCandidates({ limit: input.limit });
    const summary: RustDeskEvidenceIntelligenceReconcileSummary = {
      candidates: files.length,
      enqueued: 0,
      replayed: 0,
      skipped: 0,
      failed: 0
    };
    for (const file of files) {
      try {
        const result = await this.enqueueFile(file);
        if (result.status !== 'enqueued') {
          if (result.status === 'unsupported' || result.status === 'ignored') {
            await fileStore.markRustDeskEvidenceIntelligenceReconciled({
              tenant_id: file.tenant_id,
              secure_file_id: file.id,
              status: result.status,
              reason: result.reason
            });
          }
          summary.skipped += 1;
          continue;
        }
        if (result.replayed) {
          summary.replayed += 1;
          continue;
        }
        summary.enqueued += 1;
        await input.onEnqueued?.(file, result);
      } catch {
        summary.failed += 1;
        await input.onError?.(file);
      }
    }
    return summary;
  }
}

function rustDeskAttachmentKind(file: SecureFile): CollaborationMessageAttachmentKind | null {
  if (file.kind === 'screen_recording') return 'screen_recording';
  if (file.detected_mime.startsWith('image/')) return 'image';
  if (file.detected_mime.startsWith('audio/')) return 'audio';
  if (file.detected_mime.startsWith('video/')) return 'video';
  if (file.detected_mime === 'application/pdf') return 'file';
  return null;
}

function evidenceContext(file: SecureFile): Record<string, unknown> {
  return {
    native_event_id: requiredMetadata(file, 'native_event_id'),
    gateway_external_id: requiredMetadata(file, 'gateway_external_id'),
    operation_id: requiredMetadata(file, 'operation_id'),
    authorization_scope: requiredMetadata(file, 'authorization_scope'),
    authorization_id: requiredMetadata(file, 'authorization_id'),
    observed_at: requiredMetadata(file, 'observed_at'),
    ...(file.metadata.direction ? { direction: String(file.metadata.direction) } : {}),
    ...(file.metadata.control_version === undefined
      ? {}
      : { control_version: Number(file.metadata.control_version) })
  };
}

function requiredMetadata(file: SecureFile, key: string): string {
  const value = String(file.metadata[key] || '').trim();
  if (!value) throw new Error(`RustDesk secure evidence metadata ${key} is required`);
  return value;
}

function skipped(
  status: RustDeskEvidenceIntelligenceResult['status'],
  reason: string
): RustDeskEvidenceIntelligenceResult {
  return { status, reason, message: null, attachment: null, jobs: [], replayed: false };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
