import { createHash } from 'node:crypto';

import type { SecureFileService } from './secure-file-service.js';
import {
  replaceTinodeInboundAttachments,
  type TinodeInboundAttachment,
  type TinodeInboundNormalizedEvent
} from './tinode-inbound-protocol.js';
import type { TinodeInboundClaim } from './tinode-inbound-store.js';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export interface TinodeInboundAttachmentImporter {
  prepare(
    claim: TinodeInboundClaim,
    event: TinodeInboundNormalizedEvent
  ): Promise<TinodeInboundNormalizedEvent>;
}

export interface SecureTinodeInboundAttachmentImporterInput {
  secureFiles: SecureFileService;
  allowedHosts: string[];
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export class SecureTinodeInboundAttachmentImporter implements TinodeInboundAttachmentImporter {
  private readonly fetchImpl: typeof fetch;
  private readonly allowedHosts: Set<string>;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(private readonly input: SecureTinodeInboundAttachmentImporterInput) {
    this.fetchImpl = input.fetch || fetch;
    this.allowedHosts = new Set(input.allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
    this.maxBytes = boundedInteger(input.maxBytes ?? DEFAULT_MAX_BYTES, 1, 512 * 1024 * 1024, 'maxBytes');
    this.timeoutMs = boundedInteger(input.timeoutMs ?? 30_000, 250, 120_000, 'timeoutMs');
  }

  async prepare(
    claim: TinodeInboundClaim,
    event: TinodeInboundNormalizedEvent
  ): Promise<TinodeInboundNormalizedEvent> {
    if (event.kind !== 'data' || event.payload.attachments.length === 0) return event;
    const attachments: TinodeInboundAttachment[] = [];
    for (const [index, attachment] of event.payload.attachments.entries()) {
      attachments.push(await this.importAttachment(claim, event, attachment, index));
    }
    return replaceTinodeInboundAttachments(event, attachments);
  }

  private async importAttachment(
    claim: TinodeInboundClaim,
    event: TinodeInboundNormalizedEvent & { kind: 'data' },
    attachment: TinodeInboundAttachment,
    index: number
  ): Promise<TinodeInboundAttachment> {
    if (attachment.secure_file_id) return secureProjection(attachment);
    const sourceUrl = allowedUrl(attachment.storage_url, this.allowedHosts);
    const content = await this.download(sourceUrl);
    if (content.length === 0) throw importError('attachment_empty', false);
    const checksum = sha256(content);
    const idempotencyKey = `tinode-in:${sha256(`${claim.binding_id}:${event.provider_sequence}:${index}`).slice(0, 48)}`;
    const createPayload = {
      source: 'tinode_inbound',
      binding_id: claim.binding_id,
      provider_sequence: event.provider_sequence,
      attachment_index: index,
      kind: attachment.kind,
      filename: attachment.filename || `tinode-attachment-${index + 1}`,
      declared_mime: attachment.content_type || 'application/octet-stream',
      size_bytes: content.length,
      sha256: checksum
    };
    let file: Awaited<ReturnType<SecureFileService['createUpload']>>;
    try {
      file = await this.input.secureFiles.createUpload({
        tenant_id: claim.tenant_id,
        session_id: claim.session_id,
        created_by: 'tinode-inbound',
        kind: attachment.kind,
        filename: createPayload.filename,
        declared_mime: createPayload.declared_mime,
        upload_mode: 'single',
        expected_size_bytes: content.length,
        idempotency_key: idempotencyKey,
        payload_hash: sha256(stableJson(createPayload)),
        metadata: {
          source: 'tinode_inbound',
          binding_id_hash: sha256(claim.binding_id),
          provider_sequence: event.provider_sequence,
          attachment_index: index
        }
      });
      if (file.status === 'initiated' || file.status === 'uploading') {
        file = await this.input.secureFiles.uploadContent({
          tenant_id: claim.tenant_id,
          session_id: claim.session_id,
          secure_file_id: file.file_id,
          content,
          sha256: checksum
        });
      }
    } catch (error) {
      const status = Number((error as { status?: unknown })?.status || 0);
      throw importError(
        status >= 400 && status < 500
          ? 'attachment_secure_import_rejected'
          : 'attachment_secure_import_unavailable',
        !(status >= 400 && status < 500)
      );
    }
    if (file.sha256 && file.sha256 !== checksum) {
      throw importError('attachment_idempotency_checksum_conflict', false);
    }
    return {
      secure_file_id: file.file_id,
      kind: file.kind,
      filename: file.filename,
      content_type: file.detected_mime || file.declared_mime,
      size_bytes: file.size_bytes || file.received_size_bytes,
      checksum: file.sha256 || checksum,
      metadata: {
        source: 'tinode_inbound_secure_file',
        provider_sequence: event.provider_sequence,
        attachment_index: index
      }
    };
  }

  private async download(url: URL): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/octet-stream,*/*;q=0.8' }
      });
      if (response.status >= 300 && response.status < 400) {
        throw importError('attachment_redirect_rejected', false);
      }
      if (!response.ok) {
        throw importError(
          response.status >= 500 || response.status === 408 || response.status === 429
            ? 'attachment_source_unavailable'
            : 'attachment_source_rejected',
          response.status >= 500 || response.status === 408 || response.status === 429
        );
      }
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
        throw importError('attachment_too_large', false);
      }
      return readBoundedBody(response, this.maxBytes);
    } catch (error) {
      if (error instanceof TinodeInboundAttachmentImportError) throw error;
      if ((error as { name?: unknown })?.name === 'AbortError') {
        throw importError('attachment_source_timeout', true);
      }
      throw importError('attachment_source_unavailable', true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class TinodeInboundAttachmentImportError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super('Tinode inbound attachment import failed');
    this.name = 'TinodeInboundAttachmentImportError';
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      size += chunk.length;
      if (size > maxBytes) throw importError('attachment_too_large', false);
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function allowedUrl(value: unknown, allowedHosts: Set<string>): URL {
  let url: URL;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw importError('attachment_url_not_allowed', false);
  }
  if (
    url.protocol !== 'https:' ||
    Boolean(url.username || url.password) ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw importError('attachment_url_not_allowed', false);
  }
  return url;
}

function secureProjection(attachment: TinodeInboundAttachment): TinodeInboundAttachment {
  const { storage_url: _sourceUrl, ...safe } = attachment;
  return safe;
}

function importError(code: string, retryable: boolean): TinodeInboundAttachmentImportError {
  return new TinodeInboundAttachmentImportError(code, retryable);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return parsed;
}
