import {
  sanitizeProviderMetadata,
  sanitizeProviderRequestId
} from './provider-safety.js';

export type AttachmentProcessor = 'ocr' | 'asr';
export type AttachmentProviderMode = 'self_hosted' | 'third_party';
export type AttachmentMediaMode = 'text' | 'video_frame_sampling';
export type AttachmentVisualObservationType = 'qr_code' | 'barcode' | 'text_region';

export interface AttachmentVisualObservation {
  type: AttachmentVisualObservationType;
  value: string;
  symbology?: string;
  confidence?: number;
  frame_timestamp_ms?: number;
  page?: number;
  metadata?: Record<string, unknown>;
}

export interface AttachmentSpeechWord {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence?: number;
}

export interface AttachmentSpeechSegment {
  segment_id: string;
  speaker_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  language?: string;
  confidence?: number;
  words?: AttachmentSpeechWord[];
}

export interface AttachmentTextExtractionInput {
  attachment_id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  filename: string;
  content_type: string;
  source_ref: string;
  storage_url?: string;
  content: Buffer;
  media_mode?: AttachmentMediaMode;
  frame_interval_ms?: number;
  max_frames?: number;
}

export interface AttachmentTextExtractionResult {
  text: string;
  confidence?: number;
  language?: string;
  provider_request_id?: string;
  metadata?: Record<string, unknown>;
  observations?: AttachmentVisualObservation[];
  speech_segments?: AttachmentSpeechSegment[];
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
      if (input.source_ref !== `ivekit://attachment/${input.attachment_id}`) {
        throw new AttachmentProviderError(
          `${config.processor} provider source reference is invalid`,
          'provider_source_ref_invalid',
          false
        );
      }
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
      form.set('source_ref', input.source_ref);
      const mediaMode = input.media_mode || (
        input.content_type.toLowerCase().startsWith('video/') ? 'video_frame_sampling' : 'text'
      );
      form.set('media_mode', mediaMode);
      if (mediaMode === 'video_frame_sampling') {
        form.set('frame_interval_ms', String(boundedInteger(
          input.frame_interval_ms, 2_000, 500, 60_000, 'frame_interval_ms'
        )));
        form.set('max_frames', String(boundedInteger(
          input.max_frames, 120, 1, 600, 'max_frames'
        )));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'manual',
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
        payload = await readBoundedJson(response, 1_048_576, config.processor);
      } catch (error) {
        if (error instanceof AttachmentProviderError) throw error;
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
          : {}),
        ...('observations' in payload
          ? { observations: normalizeObservations(payload.observations, config.token || '') }
          : {}),
        ...(config.processor === 'asr' && 'segments' in payload
          ? { speech_segments: normalizeSpeechSegments(payload.segments) }
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

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new AttachmentProviderError(
      `${field} is invalid`,
      'provider_input_invalid',
      false
    );
  }
  return resolved;
}

function normalizeObservations(value: unknown, token: string): AttachmentVisualObservation[] {
  if (!Array.isArray(value) || value.length > 500) throw invalidObservationResponse();
  return value.map((item) => normalizeObservation(item, token));
}

function normalizeObservation(value: unknown, token: string): AttachmentVisualObservation {
  if (!isRecord(value)) throw invalidObservationResponse();
  const type = String(value.type || '') as AttachmentVisualObservationType;
  if (type !== 'qr_code' && type !== 'barcode' && type !== 'text_region') {
    throw invalidObservationResponse();
  }
  if (typeof value.value !== 'string' || !value.value.trim() || Buffer.byteLength(value.value, 'utf8') > 4_096) {
    throw invalidObservationResponse();
  }
  const symbology = String(value.symbology || '').trim().toUpperCase();
  if (symbology && !/^[A-Z0-9_.-]{1,32}$/.test(symbology)) throw invalidObservationResponse();
  const confidence = optionalBoundedNumber(value.confidence, 0, 1);
  const frameTimestamp = optionalBoundedInteger(value.frame_timestamp_ms, 0, 86_400_000);
  const page = optionalBoundedInteger(value.page, 1, 10_000);
  return {
    type,
    value: value.value,
    ...(symbology ? { symbology } : {}),
    ...(confidence != null ? { confidence } : {}),
    ...(frameTimestamp != null ? { frame_timestamp_ms: frameTimestamp } : {}),
    ...(page != null ? { page } : {}),
    ...(isRecord(value.metadata)
      ? { metadata: sanitizeProviderMetadata(value.metadata, { secretValues: [token] }) }
      : {})
  };
}

function optionalBoundedNumber(value: unknown, min: number, max: number): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw invalidObservationResponse();
  return parsed;
}

function optionalBoundedInteger(value: unknown, min: number, max: number): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw invalidObservationResponse();
  return parsed;
}

function invalidObservationResponse(): AttachmentProviderError {
  return new AttachmentProviderError(
    'attachment provider returned invalid observations',
    'provider_invalid_response',
    false
  );
}

function normalizeSpeechSegments(value: unknown): AttachmentSpeechSegment[] {
  if (!Array.isArray(value) || value.length > 2_000) throw invalidSpeechSegmentResponse();
  return value.map(normalizeSpeechSegment);
}

function normalizeSpeechSegment(value: unknown): AttachmentSpeechSegment {
  if (!isRecord(value)) throw invalidSpeechSegmentResponse();
  const segmentId = boundedSpeechIdentifier(value.segment_id, 'segment');
  const speakerId = boundedSpeechIdentifier(value.speaker_id, 'speaker');
  const startMs = requiredBoundedInteger(value.start_ms, 0, 604_800_000);
  const endMs = requiredBoundedInteger(value.end_ms, 0, 604_800_000);
  if (endMs < startMs) throw invalidSpeechSegmentResponse();
  const text = boundedSpeechText(value.text, 8_192);
  const language = optionalSpeechLanguage(value.language);
  const confidence = optionalBoundedNumber(value.confidence, 0, 1);
  const words = value.words == null ? undefined : normalizeSpeechWords(value.words, startMs, endMs);
  return {
    segment_id: segmentId,
    speaker_id: speakerId,
    start_ms: startMs,
    end_ms: endMs,
    text,
    ...(language ? { language } : {}),
    ...(confidence != null ? { confidence } : {}),
    ...(words ? { words } : {})
  };
}

function normalizeSpeechWords(value: unknown, segmentStartMs: number, segmentEndMs: number): AttachmentSpeechWord[] {
  if (!Array.isArray(value) || value.length > 500) throw invalidSpeechSegmentResponse();
  return value.map((word) => {
    if (!isRecord(word)) throw invalidSpeechSegmentResponse();
    const startMs = requiredBoundedInteger(word.start_ms, segmentStartMs, segmentEndMs);
    const endMs = requiredBoundedInteger(word.end_ms, segmentStartMs, segmentEndMs);
    if (endMs < startMs) throw invalidSpeechSegmentResponse();
    const confidence = optionalBoundedNumber(word.confidence, 0, 1);
    return {
      text: boundedSpeechText(word.text, 256),
      start_ms: startMs,
      end_ms: endMs,
      ...(confidence != null ? { confidence } : {})
    };
  });
}

function boundedSpeechIdentifier(value: unknown, fallbackPrefix: string): string {
  const text = String(value || '').trim();
  if (!text || text.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(text)) {
    throw new AttachmentProviderError(
      `${fallbackPrefix} identifier is invalid`,
      'provider_invalid_response',
      false
    );
  }
  return text;
}

function boundedSpeechText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw invalidSpeechSegmentResponse();
  }
  return value.trim();
}

function optionalSpeechLanguage(value: unknown): string {
  const language = String(value || '').trim();
  if (!language) return '';
  if (language.length > 35) throw invalidSpeechSegmentResponse();
  try {
    const canonical = Intl.getCanonicalLocales(language)[0];
    if (!canonical) throw new Error('missing language');
    return canonical;
  } catch {
    throw invalidSpeechSegmentResponse();
  }
}

function requiredBoundedInteger(value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw invalidSpeechSegmentResponse();
  return parsed;
}

function invalidSpeechSegmentResponse(): AttachmentProviderError {
  return new AttachmentProviderError(
    'asr provider returned invalid speech segments',
    'provider_invalid_response',
    false
  );
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  processor: AttachmentProcessor
): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AttachmentProviderError(
      `${processor} provider response is too large`,
      'provider_response_too_large',
      false,
      response.status
    );
  }
  if (!response.body) {
    throw new AttachmentProviderError(
      `${processor} provider returned invalid JSON`,
      'provider_invalid_response',
      false,
      response.status
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AttachmentProviderError(
          `${processor} provider response is too large`,
          'provider_response_too_large',
          false,
          response.status
        );
      }
      chunks.push(value);
    }
    return JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
    ) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
