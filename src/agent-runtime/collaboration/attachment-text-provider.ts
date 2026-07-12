import {
  sanitizeProviderMetadata,
  sanitizeProviderRequestId
} from './provider-safety.js';

export type AttachmentProcessor = 'ocr' | 'asr';
export type AttachmentProviderMode = 'self_hosted' | 'third_party';
export interface AttachmentTextExtractionInput {
  attachment_id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  filename: string;
  content_type: string;
  storage_url: string;
  content: Buffer;
}

export interface AttachmentTextExtractionResult {
  text: string;
  confidence?: number;
  language?: string;
  provider_request_id?: string;
  metadata?: Record<string, unknown>;
}

export interface AttachmentTextProvider {
  processor: AttachmentProcessor;
  name: string;
  mode: AttachmentProviderMode;
  profile_id?: string;
  extract(input: AttachmentTextExtractionInput): Promise<AttachmentTextExtractionResult>;
}

export interface HttpAttachmentTextProviderConfig {
  processor: AttachmentProcessor;
  mode: AttachmentProviderMode;
  baseUrl: string;
  endpoint: string;
  token?: string;
  timeoutMs?: number;
  name?: string;
  profileId?: string;
  fetch?: typeof fetch;
}

export class AttachmentProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = 'AttachmentProviderError';
  }
}

export function createHttpAttachmentTextProvider(
  config: HttpAttachmentTextProviderConfig
): AttachmentTextProvider {
  const baseUrl = String(config.baseUrl || '').trim();
  if (!baseUrl) throw new Error(`${config.processor} provider baseUrl is required`);
  const timeoutMs = boundedTimeout(config.timeoutMs ?? 30_000);
  const fetchImpl = config.fetch || fetch;
  const endpoint = new URL(config.endpoint.replace(/^\//, ''), ensureTrailingSlash(baseUrl)).toString();

  return {
    processor: config.processor,
    name: config.name || `${config.mode}-${config.processor}`,
    mode: config.mode,
    ...(config.profileId ? { profile_id: config.profileId } : {}),
    async extract(input) {
      const form = new FormData();
      form.set(
        'file',
        new Blob([new Uint8Array(input.content)], {
          type: input.content_type || 'application/octet-stream'
        }),
        input.filename || `${input.attachment_id}.bin`
      );
      form.set('attachment_id', input.attachment_id);
      form.set('tenant_id', input.tenant_id);
      form.set('session_id', input.session_id);
      form.set('message_id', input.message_id);
      form.set('storage_url', input.storage_url);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: config.token ? { authorization: `Bearer ${config.token}` } : undefined,
          body: form,
          signal: controller.signal
        });
      } catch (error) {
        const timedOut = controller.signal.aborted;
        throw new AttachmentProviderError(
          timedOut ? `${config.processor} provider timed out` : `${config.processor} provider request failed`,
          timedOut ? 'provider_timeout' : 'provider_unavailable',
          true
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new AttachmentProviderError(
          `${config.processor} provider returned HTTP ${response.status}`,
          `provider_http_${response.status}`,
          response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
          response.status
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new AttachmentProviderError(
          `${config.processor} provider returned invalid JSON`,
          'provider_invalid_response',
          false,
          response.status
        );
      }
      if (!isRecord(payload) || typeof payload.text !== 'string') {
        throw new AttachmentProviderError(
          `${config.processor} provider response is missing text`,
          'provider_invalid_response',
          false,
          response.status
        );
      }
      const confidence = Number(payload.confidence);
      return {
        text: payload.text.slice(0, 200_000),
        ...(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? { confidence } : {}),
        ...(typeof payload.language === 'string' ? { language: payload.language.trim().slice(0, 35) } : {}),
        ...(typeof payload.request_id === 'string'
          ? { provider_request_id: sanitizeProviderRequestId(payload.request_id) }
          : typeof payload.provider_request_id === 'string'
            ? { provider_request_id: sanitizeProviderRequestId(payload.provider_request_id) }
            : {}),
        ...(isRecord(payload.metadata)
          ? { metadata: sanitizeProviderMetadata(payload.metadata, { secretValues: [config.token || ''] }) }
          : {})
      };
    }
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 1_000 || value > 300_000) {
    throw new Error('attachment provider timeout must be between 1000 and 300000 ms');
  }
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
