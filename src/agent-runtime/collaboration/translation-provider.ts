import { createIntelligenceProviderRegistry } from './intelligence-provider-registry.js';
import {
  sanitizeProviderMetadata,
  sanitizeProviderRequestId
} from './provider-safety.js';

export type TranslationSourceType = 'message' | 'attachment';
export type TranslationProviderMode = 'self_hosted' | 'third_party';

export interface TranslationProviderInput {
  tenant_id: string;
  session_id: string;
  message_id: string;
  source_type: TranslationSourceType;
  source_ref_id: string;
  source_ref: string;
  text: string;
  source_language: string;
  target_language: string;
}

export interface TranslationProviderOutput {
  translated_text: string;
  detected_language?: string;
  confidence?: number;
  provider_request_id?: string;
  metadata?: Record<string, unknown>;
}

export interface TranslationProvider {
  name: string;
  mode: TranslationProviderMode;
  profile_id?: string;
  translate(input: TranslationProviderInput): Promise<TranslationProviderOutput>;
}

export interface HttpTranslationProviderConfig {
  mode: TranslationProviderMode;
  baseUrl: string;
  endpoint?: string;
  token?: string;
  timeoutMs?: number;
  name?: string;
  profileId?: string;
  fetch?: typeof fetch;
}

export class TranslationProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = 'TranslationProviderError';
  }
}

export function createHttpTranslationProvider(
  config: HttpTranslationProviderConfig
): TranslationProvider {
  const baseUrl = String(config.baseUrl || '').trim();
  if (!baseUrl) throw new Error('translation provider baseUrl is required');
  const endpoint = new URL(
    String(config.endpoint || '/v1/translate').replace(/^\//, ''),
    baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  ).toString();
  const timeoutMs = boundedTimeout(config.timeoutMs ?? 30_000);
  const fetchImpl = config.fetch || fetch;

  return {
    name: config.name || `${config.mode}-translation`,
    mode: config.mode,
    ...(config.profileId ? { profile_id: config.profileId } : {}),
    async translate(input) {
      validateSourceRef(input);
      const text = boundedSourceText(input.text);
      const sourceLanguage = normalizeLanguage(input.source_language, true, 'source_language');
      const targetLanguage = normalizeLanguage(input.target_language, false, 'target_language');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.token ? { authorization: `Bearer ${config.token}` } : {})
          },
          body: JSON.stringify({
            source_ref: input.source_ref,
            text,
            source_language: sourceLanguage,
            target_language: targetLanguage
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          throw providerError(
            `provider_http_${response.status}`,
            retryableStatus(response.status),
            response.status
          );
        }
        const payload = await readBoundedJson(response, 1_048_576);
        if (!isRecord(payload) || typeof payload.translated_text !== 'string') {
          throw providerError('provider_invalid_response', false, response.status);
        }
        const translatedText = payload.translated_text.trim().slice(0, 200_000);
        if (!translatedText) throw providerError('provider_invalid_response', false, response.status);
        const detectedLanguage = optionalLanguage(payload.detected_language);
        const confidence = boundedConfidence(payload.confidence);
        const requestId = sanitizeProviderRequestId(
          payload.provider_request_id ?? payload.request_id
        );
        return {
          translated_text: translatedText,
          ...(detectedLanguage ? { detected_language: detectedLanguage } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
          ...(requestId ? { provider_request_id: requestId } : {}),
          ...(isRecord(payload.metadata)
            ? { metadata: sanitizeProviderMetadata(payload.metadata, { secretValues: [config.token || ''] }) }
            : {})
        };
      } catch (error) {
        if (error instanceof TranslationProviderError) throw error;
        throw providerError(
          controller.signal.aborted ? 'provider_timeout' : 'provider_unavailable',
          true
        );
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

export function configuredTranslationProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch?: typeof fetch } = {}
): TranslationProvider | null {
  const registry = createIntelligenceProviderRegistry(env);
  const profile = registry.defaultProfile('translation');
  if (!profile) return null;
  return createHttpTranslationProvider({
    mode: profile.mode,
    baseUrl: profile.base_url,
    endpoint: profile.endpoint,
    token: registry.resolveToken(profile),
    timeoutMs: profile.timeout_ms,
    name: profile.name,
    profileId: profile.id,
    fetch: deps.fetch
  });
}

function validateSourceRef(input: TranslationProviderInput): void {
  const expected = `ivekit://${input.source_type}/${input.source_ref_id}`;
  if (!input.source_ref_id || input.source_ref !== expected) {
    throw providerError('provider_source_ref_invalid', false);
  }
  if (input.source_type === 'message' && input.source_ref_id !== input.message_id) {
    throw providerError('provider_source_ref_invalid', false);
  }
}

function boundedSourceText(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) throw providerError('translation_source_empty', false);
  if (Buffer.byteLength(text, 'utf8') > 800_000 || text.length > 200_000) {
    throw providerError('translation_source_too_large', false);
  }
  return text;
}

function normalizeLanguage(value: unknown, allowAuto: boolean, field: string): string {
  const language = String(value || '').trim();
  if (allowAuto && language.toLowerCase() === 'auto') return 'auto';
  if (!language || (!allowAuto && language.toLowerCase() === 'auto') || language.length > 35) {
    throw providerError(`${field}_invalid`, false);
  }
  try {
    const canonical = Intl.getCanonicalLocales(language)[0];
    if (!canonical) throw new Error('missing locale');
    return canonical;
  } catch {
    throw providerError(`${field}_invalid`, false);
  }
}

function optionalLanguage(value: unknown): string | undefined {
  const language = String(value || '').trim();
  if (!language) return undefined;
  try {
    return normalizeLanguage(language, false, 'detected_language');
  } catch {
    return undefined;
  }
}

function boundedConfidence(value: unknown): number | undefined {
  const confidence = Number(value);
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? confidence
    : undefined;
}

function boundedTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error('translation provider timeout must be between 1000 and 300000 ms');
  }
  return value;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function providerError(code: string, retryable: boolean, status?: number): TranslationProviderError {
  return new TranslationProviderError(`translation provider error: ${code}`, code, retryable, status);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw providerError('provider_response_too_large', false, response.status);
  }
  if (!response.body) throw providerError('provider_invalid_response', false, response.status);
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
        throw providerError('provider_response_too_large', false, response.status);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof TranslationProviderError) throw error;
    throw providerError('provider_invalid_response', false, response.status);
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
