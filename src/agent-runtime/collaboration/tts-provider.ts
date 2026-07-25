import { isIP } from 'node:net';

import {
  sanitizeProviderMetadata,
  sanitizeProviderRequestId
} from './provider-safety.js';
import type { IntelligenceProviderMode } from './intelligence-provider-registry.js';

export type TtsAudioEncoding = 'pcm_s16le' | 'pcmu' | 'pcma' | 'opus';

export interface TtsAudioFormat {
  encoding: TtsAudioEncoding;
  sample_rate_hz: 8_000 | 16_000 | 24_000 | 48_000;
  channels: 1 | 2;
}

export interface TtsSynthesisInput {
  tenant_id: string;
  interaction_id: string;
  text: string;
  language: string;
  voice: string;
  audio_format: TtsAudioFormat;
  idempotency_key: string;
  signal?: AbortSignal;
}

export interface TtsAudioChunk {
  sequence: number;
  duration_ms: number;
  audio: Buffer;
}

export interface TtsSynthesisResult {
  profile_id: string;
  provider_version: string;
  provider_request_id: string;
  audio_format: TtsAudioFormat;
  metadata: Record<string, unknown>;
  audio: AsyncIterable<TtsAudioChunk>;
  cancel(): void;
}

export interface TtsProvider {
  readonly name: string;
  readonly mode: IntelligenceProviderMode;
  readonly profile_id: string;
  synthesize(input: TtsSynthesisInput): Promise<TtsSynthesisResult>;
}

export interface HttpTtsProviderConfig {
  mode: IntelligenceProviderMode;
  baseUrl: string;
  endpoint?: string;
  token?: string;
  timeoutMs?: number;
  name?: string;
  profileId?: string;
  providerVersion?: string;
  fetch?: typeof fetch;
}

export class TtsProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status = 502
  ) {
    super(`TTS provider error: ${code}`);
    this.name = 'TtsProviderError';
  }
}

const MAX_TEXT_CHARACTERS = 100_000;
const MAX_TEXT_BYTES = 400_000;
const MAX_JSON_RESPONSE_BYTES = 4 * 1_024 * 1_024;
const MAX_STREAM_RESPONSE_BYTES = 64 * 1_024 * 1_024;
const MAX_SSE_EVENT_BYTES = 2 * 1_024 * 1_024;
const MAX_AUDIO_CHUNK_BYTES = 1_024 * 1_024;

export function createHttpTtsProvider(config: HttpTtsProviderConfig): TtsProvider {
  const endpoint = providerEndpoint(config.baseUrl, config.endpoint || '/v1/tts', config.mode);
  const timeoutMs = boundedInteger(config.timeoutMs ?? 30_000, 1_000, 300_000, 'timeout');
  const fetchImpl = config.fetch ?? fetch;
  return {
    name: boundedText(config.name || `${config.mode}-tts`, 100, 'name'),
    mode: config.mode,
    profile_id: optionalIdentifier(config.profileId),
    async synthesize(input) {
      const request = normalizeInput(input);
      const abort = createAbortScope(input.signal, timeoutMs);
      let streamOwnsAbort = false;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            ...(config.token ? { authorization: `Bearer ${config.token}` } : {})
          },
          body: JSON.stringify(request),
          signal: abort.signal
        });
        if (!response.ok) {
          throw ttsError(`provider_http_${response.status}`, retryableStatus(response.status), response.status);
        }
        const contentType = String(response.headers.get('content-type') || '')
          .split(';', 1)[0]
          .trim()
          .toLowerCase();
        if (contentType === 'application/json') {
          const payload = await readBoundedJson(response, MAX_JSON_RESPONSE_BYTES);
          return jsonResult(payload, request.audio_format, config, abort);
        }
        if (contentType === 'text/event-stream') {
          if (!response.body) throw ttsError('provider_invalid_response', false);
          assertDeclaredLength(response, MAX_STREAM_RESPONSE_BYTES);
          const result = streamingResult(response.body, request.audio_format, config, abort);
          streamOwnsAbort = true;
          return result;
        }
        throw ttsError('provider_invalid_response', false, response.status);
      } catch (error) {
        if (error instanceof TtsProviderError) throw error;
        throw abortError(abort, input.signal);
      } finally {
        if (!streamOwnsAbort) abort.dispose();
      }
    }
  };
}

function jsonResult(
  input: unknown,
  requestedFormat: TtsAudioFormat,
  config: HttpTtsProviderConfig,
  abort: AbortScope
): TtsSynthesisResult {
  if (!isRecord(input)) throw ttsError('provider_invalid_response', false);
  const format = normalizeResponseFormat(input.audio_format, requestedFormat);
  const audio = decodeBase64Audio(input.audio_base64);
  const chunk: TtsAudioChunk = {
    sequence: 0,
    duration_ms: boundedInteger(input.duration_ms ?? 1, 1, 3_600_000, 'duration'),
    audio
  };
  return {
    profile_id: optionalIdentifier(config.profileId),
    provider_version: optionalVersion(config.providerVersion),
    provider_request_id: sanitizeProviderRequestId(input.provider_request_id ?? input.request_id),
    audio_format: format,
    metadata: safeMetadata(input.metadata, config.token),
    audio: oneChunk(chunk),
    cancel: abort.abort
  };
}

function streamingResult(
  body: ReadableStream<Uint8Array>,
  requestedFormat: TtsAudioFormat,
  config: HttpTtsProviderConfig,
  abort: AbortScope
): TtsSynthesisResult {
  const result: TtsSynthesisResult = {
    profile_id: optionalIdentifier(config.profileId),
    provider_version: optionalVersion(config.providerVersion),
    provider_request_id: '',
    audio_format: requestedFormat,
    metadata: {},
    audio: emptyAudio(),
    cancel: abort.abort
  };
  result.audio = parseSseAudio(body, result, requestedFormat, config.token, abort);
  return result;
}

async function* parseSseAudio(
  body: ReadableStream<Uint8Array>,
  result: TtsSynthesisResult,
  requestedFormat: TtsAudioFormat,
  token: string | undefined,
  abort: AbortScope
): AsyncGenerator<TtsAudioChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let totalBytes = 0;
  let expectedSequence = 0;
  let metadataSeen = false;
  let doneSeen = false;
  try {
    while (!doneSeen) {
      const read = await reader.read();
      if (read.done) break;
      if (!read.value) continue;
      totalBytes += read.value.byteLength;
      if (totalBytes > MAX_STREAM_RESPONSE_BYTES) throw ttsError('provider_response_too_large', false);
      buffer += decoder.decode(read.value, { stream: true });
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BYTES) {
        throw ttsError('provider_response_too_large', false);
      }
      while (true) {
        const boundary = sseBoundary(buffer);
        if (!boundary) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseSseBlock(block);
        if (!event) continue;
        if (event.name === 'metadata') {
          if (metadataSeen || expectedSequence > 0) throw ttsError('provider_invalid_response', false);
          metadataSeen = true;
          result.audio_format = normalizeResponseFormat(event.data.audio_format, requestedFormat);
          result.provider_request_id = sanitizeProviderRequestId(
            event.data.provider_request_id ?? event.data.request_id
          );
          result.metadata = safeMetadata(event.data.metadata, token);
          continue;
        }
        if (event.name === 'audio') {
          if (!metadataSeen) throw ttsError('provider_invalid_response', false);
          const sequence = boundedInteger(event.data.sequence, 0, 0xffff_ffff, 'sequence');
          if (sequence !== expectedSequence) throw ttsError('provider_invalid_response', false);
          expectedSequence += 1;
          yield {
            sequence,
            duration_ms: boundedInteger(event.data.duration_ms, 1, 10_000, 'duration'),
            audio: decodeBase64Audio(event.data.audio_base64)
          };
          continue;
        }
        if (event.name === 'done') {
          doneSeen = true;
          break;
        }
        if (event.name === 'error') {
          throw providerEventError(event.data);
        }
      }
    }
    if (!metadataSeen || !doneSeen || expectedSequence < 1) {
      throw ttsError('provider_invalid_response', false);
    }
  } catch (error) {
    if (error instanceof TtsProviderError) throw error;
    throw abortError(abort);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    abort.dispose();
  }
}

function normalizeInput(input: TtsSynthesisInput): Omit<TtsSynthesisInput, 'signal' | 'tenant_id' | 'interaction_id'> {
  if (!isRecord(input)) throw ttsError('validation_failed', false, 422);
  requiredIdentifier(input.tenant_id);
  requiredIdentifier(input.interaction_id);
  const text = String(input.text || '').trim();
  if (!text) throw ttsError('tts_text_empty', false, 422);
  if (text.length > MAX_TEXT_CHARACTERS || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    throw ttsError('tts_text_too_large', false, 422);
  }
  return {
    text,
    language: language(input.language),
    voice: requiredIdentifier(input.voice),
    audio_format: audioFormat(input.audio_format),
    idempotency_key: idempotencyKey(input.idempotency_key)
  };
}

function normalizeResponseFormat(input: unknown, requested: TtsAudioFormat): TtsAudioFormat {
  const format = audioFormat(input);
  if (format.encoding !== requested.encoding
    || format.sample_rate_hz !== requested.sample_rate_hz
    || format.channels !== requested.channels) {
    throw ttsError('provider_invalid_response', false);
  }
  return format;
}

function audioFormat(value: unknown): TtsAudioFormat {
  if (!isRecord(value)
    || !['pcm_s16le', 'pcmu', 'pcma', 'opus'].includes(String(value.encoding))
    || ![8_000, 16_000, 24_000, 48_000].includes(Number(value.sample_rate_hz))
    || ![1, 2].includes(Number(value.channels))) {
    throw ttsError('validation_failed', false, 422);
  }
  return {
    encoding: value.encoding as TtsAudioEncoding,
    sample_rate_hz: Number(value.sample_rate_hz) as TtsAudioFormat['sample_rate_hz'],
    channels: Number(value.channels) as TtsAudioFormat['channels']
  };
}

function decodeBase64Audio(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_AUDIO_CHUNK_BYTES * 4 / 3) + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw ttsError('provider_invalid_response', false);
  }
  const audio = Buffer.from(value, 'base64');
  if (!audio.length || audio.byteLength > MAX_AUDIO_CHUNK_BYTES
    || audio.toString('base64') !== value) throw ttsError('provider_invalid_response', false);
  return audio;
}

function parseSseBlock(block: string): { name: string; data: Record<string, unknown> } | null {
  let name = 'message';
  const data: string[] = [];
  for (const line of block.replace(/\r/g, '').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) name = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(data.join('\n')); } catch { throw ttsError('provider_invalid_response', false); }
  if (!isRecord(parsed) || !/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) {
    throw ttsError('provider_invalid_response', false);
  }
  return { name, data: parsed };
}

function sseBoundary(value: string): { index: number; length: number } | null {
  const lf = value.indexOf('\n\n');
  const crlf = value.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function providerEventError(data: Record<string, unknown>): TtsProviderError {
  const code = safeCode(data.code);
  return ttsError(code, data.retryable === true, 502);
}

function providerEndpoint(baseUrlInput: string, endpointInput: string, mode: IntelligenceProviderMode): string {
  let base: URL;
  try { base = new URL(String(baseUrlInput || '').trim()); } catch { throw new Error('TTS baseUrl is invalid'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('TTS baseUrl is invalid');
  }
  if (mode === 'third_party' && base.protocol !== 'https:') throw new Error('third-party TTS requires HTTPS');
  if (mode === 'self_hosted' && base.protocol === 'http:' && !isPrivateOrContainerHost(base.hostname)) {
    throw new Error('self-hosted HTTP TTS requires a private or container host');
  }
  const endpoint = String(endpointInput || '').trim();
  if (!endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('..')
    || endpoint.includes('?') || endpoint.includes('#') || endpoint.includes('\\')) {
    throw new Error('TTS endpoint is invalid');
  }
  return new URL(endpoint.slice(1), base.toString().replace(/\/+$/, '') + '/').toString();
}

interface AbortScope {
  signal: AbortSignal;
  timedOut(): boolean;
  abort(): void;
  dispose(): void;
}

function createAbortScope(caller: AbortSignal | undefined, timeoutMs: number): AbortScope {
  const controller = new AbortController();
  let timeout = false;
  const onCallerAbort = () => controller.abort();
  if (caller?.aborted) controller.abort();
  else caller?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  let disposed = false;
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    abort: () => controller.abort(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    }
  };
}

function abortError(scope: AbortScope, caller?: AbortSignal): TtsProviderError {
  if (caller?.aborted || (scope.signal.aborted && !scope.timedOut())) {
    return ttsError('provider_cancelled', false, 499);
  }
  return ttsError(scope.timedOut() ? 'provider_timeout' : 'provider_unavailable', true, 503);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  assertDeclaredLength(response, maxBytes);
  if (!response.body) throw ttsError('provider_invalid_response', false);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw ttsError('provider_response_too_large', false);
      chunks.push(Buffer.from(value));
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed;
  } catch (error) {
    if (error instanceof TtsProviderError) throw error;
    throw ttsError('provider_invalid_response', false);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function assertDeclaredLength(response: Response, maxBytes: number): void {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw ttsError('provider_response_too_large', false, response.status);
  }
}

async function* oneChunk(chunk: TtsAudioChunk): AsyncGenerator<TtsAudioChunk> {
  yield chunk;
}

async function* emptyAudio(): AsyncGenerator<TtsAudioChunk> {}

function safeMetadata(value: unknown, token: string | undefined): Record<string, unknown> {
  return isRecord(value)
    ? sanitizeProviderMetadata(value, { secretValues: [token || ''] })
    : {};
}

function language(value: unknown): string {
  const text = String(value || '').trim();
  if (!text || text.length > 35) throw ttsError('language_invalid', false, 422);
  try {
    const normalized = Intl.getCanonicalLocales(text)[0];
    if (!normalized) throw new Error();
    return normalized;
  } catch {
    throw ttsError('language_invalid', false, 422);
  }
}

function requiredIdentifier(value: unknown): string {
  const text = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(text)) {
    throw ttsError('validation_failed', false, 422);
  }
  return text;
}

function optionalIdentifier(value: unknown): string {
  return value ? requiredIdentifier(value) : '';
}

function optionalVersion(value: unknown): string {
  const text = String(value || 'unspecified').trim();
  if (!text || text.length > 64 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error('TTS providerVersion is invalid');
  }
  return text;
}

function boundedText(value: unknown, max: number, field: string): string {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`TTS ${field} is invalid`);
  }
  return text;
}

function idempotencyKey(value: unknown): string {
  const text = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/.test(text)) {
    throw ttsError('validation_failed', false, 422);
  }
  return text;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    if (field === 'timeout') throw new Error('TTS timeout is invalid');
    throw ttsError('provider_invalid_response', false);
  }
  return Number(value);
}

function safeCode(value: unknown): string {
  return String(value || 'provider_unavailable')
    .trim().replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 100) || 'provider_unavailable';
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function ttsError(code: string, retryable: boolean, status = 502): TtsProviderError {
  return new TtsProviderError(safeCode(code), retryable, status);
}

function isPrivateOrContainerHost(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal')) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(host);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
