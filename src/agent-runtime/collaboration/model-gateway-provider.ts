import { isIP } from 'node:net';

import { Ajv, type ValidateFunction } from 'ajv';

import type { IntelligenceProviderMode } from './intelligence-provider-registry.js';
import {
  sanitizeProviderMetadata,
  sanitizeProviderRequestId
} from './provider-safety.js';

export interface ModelGatewayInput {
  tenant_id: string;
  interaction_id: string;
  task: string;
  input: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  model_hint: string;
  temperature: number;
  max_output_tokens: number;
  idempotency_key: string;
  signal?: AbortSignal;
}

export interface ModelGatewayUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ModelGatewayOutput {
  output: unknown;
  profile_id: string;
  provider_version: string;
  provider_request_id: string;
  model: string;
  usage: ModelGatewayUsage;
  metadata: Record<string, unknown>;
}

export interface ModelGatewayProvider {
  readonly name: string;
  readonly mode: IntelligenceProviderMode;
  readonly profile_id: string;
  generate(input: ModelGatewayInput): Promise<ModelGatewayOutput>;
}

export interface HttpModelGatewayProviderConfig {
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

export class ModelGatewayProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status = 502
  ) {
    super(`model gateway provider error: ${code}`);
    this.name = 'ModelGatewayProviderError';
  }
}

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_SCHEMA_BYTES = 131_072;
const MAX_RESPONSE_BYTES = 2_097_152;
const MAX_SCHEMA_NODES = 2_000;
const MAX_SCHEMA_DEPTH = 20;

export function createHttpModelGatewayProvider(
  config: HttpModelGatewayProviderConfig
): ModelGatewayProvider {
  const endpoint = providerEndpoint(config.baseUrl, config.endpoint || '/v1/model', config.mode);
  const timeoutMs = boundedInteger(config.timeoutMs ?? 30_000, 1_000, 300_000, 'timeout');
  const fetchImpl = config.fetch ?? fetch;
  return {
    name: boundedText(config.name || `${config.mode}-model-gateway`, 100, 'name'),
    mode: config.mode,
    profile_id: optionalIdentifier(config.profileId),
    async generate(input) {
      const normalized = normalizeInput(input);
      const validate = compileOutputSchema(normalized.output_schema);
      const abort = createAbortScope(input.signal, timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(config.token ? { authorization: `Bearer ${config.token}` } : {})
          },
          body: JSON.stringify(normalized),
          signal: abort.signal
        });
        if (!response.ok) {
          throw modelError(
            `provider_http_${response.status}`,
            retryableStatus(response.status),
            response.status
          );
        }
        const payload = await readBoundedJson(response, MAX_RESPONSE_BYTES);
        if (!isRecord(payload) || !Object.hasOwn(payload, 'output')) {
          throw modelError('provider_invalid_response', false);
        }
        if (!validate(payload.output)) throw modelError('provider_schema_mismatch', false);
        return {
          output: cloneJson(payload.output),
          profile_id: optionalIdentifier(config.profileId),
          provider_version: optionalVersion(config.providerVersion),
          provider_request_id: sanitizeProviderRequestId(
            payload.provider_request_id ?? payload.request_id
          ),
          model: optionalSafeText(payload.model, 128),
          usage: normalizeUsage(payload.usage),
          metadata: safeMetadata(payload.metadata, config.token)
        };
      } catch (error) {
        if (error instanceof ModelGatewayProviderError) throw error;
        throw abortError(abort, input.signal);
      } finally {
        abort.dispose();
      }
    }
  };
}

function normalizeInput(input: ModelGatewayInput): {
  task: string;
  input: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  model_hint: string;
  temperature: number;
  max_output_tokens: number;
  idempotency_key: string;
} {
  if (!isRecord(input)) throw modelError('validation_failed', false, 422);
  requiredIdentifier(input.tenant_id);
  requiredIdentifier(input.interaction_id);
  const normalized = {
    task: taskName(input.task),
    input: normalizeJsonRecord(input.input, MAX_REQUEST_BYTES, 'model_input_invalid'),
    output_schema: normalizeSchema(input.output_schema),
    model_hint: optionalSafeText(input.model_hint, 128),
    temperature: boundedNumber(input.temperature, 0, 2, 'temperature'),
    max_output_tokens: boundedInteger(input.max_output_tokens, 1, 32_768, 'max_output_tokens'),
    idempotency_key: idempotencyKey(input.idempotency_key)
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_REQUEST_BYTES) {
    throw modelError('model_input_too_large', false, 422);
  }
  return normalized;
}

function normalizeSchema(input: unknown): Record<string, unknown> {
  const schema = normalizeJsonRecord(input, MAX_SCHEMA_BYTES, 'model_schema_invalid');
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
      throw modelError('model_schema_invalid', false, 422);
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && (typeof item !== 'string' || !item.startsWith('#'))) {
        throw modelError('model_schema_invalid', false, 422);
      }
      visit(item, depth + 1);
    }
  };
  visit(schema, 0);
  return schema;
}

function compileOutputSchema(schema: Record<string, unknown>): ValidateFunction {
  try {
    const ajv = new Ajv({
      allErrors: false,
      strict: true,
      validateFormats: false,
      allowUnionTypes: false,
      messages: false
    });
    return ajv.compile(schema);
  } catch {
    throw modelError('model_schema_invalid', false, 422);
  }
}

function normalizeJsonRecord(
  value: unknown,
  maxBytes: number,
  errorCode: string
): Record<string, unknown> {
  if (!isRecord(value)) throw modelError(errorCode, false, 422);
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw modelError(errorCode, false, 422); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw modelError(errorCode, false, 422);
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!isRecord(parsed)) throw modelError(errorCode, false, 422);
  return parsed;
}

function cloneJson(value: unknown): unknown {
  try { return JSON.parse(JSON.stringify(value)) as unknown; } catch {
    throw modelError('provider_invalid_response', false);
  }
}

function normalizeUsage(value: unknown): ModelGatewayUsage {
  if (!isRecord(value)) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: optionalInteger(value.input_tokens, 0, 1_000_000_000),
    output_tokens: optionalInteger(value.output_tokens, 0, 1_000_000_000)
  };
}

function safeMetadata(value: unknown, token: string | undefined): Record<string, unknown> {
  const sanitized = sanitizeProviderMetadata(value, { secretValues: [token || ''] });
  return dropContentMetadata(sanitized) as Record<string, unknown>;
}

function dropContentMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropContentMetadata);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/prompt|transcript|message|content|audio|pcm|frame|payload|response/.test(normalized)) continue;
    output[key] = dropContentMetadata(item);
  }
  return output;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw modelError('provider_response_too_large', false, response.status);
  }
  if (!response.body) throw modelError('provider_invalid_response', false, response.status);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw modelError('provider_response_too_large', false, response.status);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof ModelGatewayProviderError) throw error;
    throw modelError('provider_invalid_response', false, response.status);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function providerEndpoint(baseUrlInput: string, endpointInput: string, mode: IntelligenceProviderMode): string {
  let base: URL;
  try { base = new URL(String(baseUrlInput || '').trim()); } catch { throw new Error('model baseUrl is invalid'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('model baseUrl is invalid');
  }
  if (mode === 'third_party' && base.protocol !== 'https:') {
    throw new Error('third-party model gateway requires HTTPS');
  }
  if (mode === 'self_hosted' && base.protocol === 'http:' && !isPrivateOrContainerHost(base.hostname)) {
    throw new Error('self-hosted HTTP model gateway requires a private or container host');
  }
  const endpoint = String(endpointInput || '').trim();
  if (!endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('..')
    || endpoint.includes('?') || endpoint.includes('#') || endpoint.includes('\\')) {
    throw new Error('model endpoint is invalid');
  }
  return new URL(endpoint.slice(1), base.toString().replace(/\/+$/, '') + '/').toString();
}

interface AbortScope {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

function createAbortScope(caller: AbortSignal | undefined, timeoutMs: number): AbortScope {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (caller?.aborted) controller.abort();
  else caller?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    }
  };
}

function abortError(scope: AbortScope, caller?: AbortSignal): ModelGatewayProviderError {
  if (caller?.aborted || (scope.signal.aborted && !scope.timedOut())) {
    return modelError('provider_cancelled', false, 499);
  }
  return modelError(scope.timedOut() ? 'provider_timeout' : 'provider_unavailable', true, 503);
}

function taskName(value: unknown): string {
  const text = String(value || '');
  if (!/^[a-z][a-z0-9_.:-]{0,63}$/.test(text)) throw modelError('validation_failed', false, 422);
  return text;
}

function requiredIdentifier(value: unknown): string {
  const text = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(text)) {
    throw modelError('validation_failed', false, 422);
  }
  return text;
}

function optionalIdentifier(value: unknown): string {
  return value ? requiredIdentifier(value) : '';
}

function idempotencyKey(value: unknown): string {
  const text = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/.test(text)) {
    throw modelError('validation_failed', false, 422);
  }
  return text;
}

function optionalVersion(value: unknown): string {
  const text = String(value || 'unspecified').trim();
  if (!text || text.length > 64 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error('model providerVersion is invalid');
  }
  return text;
}

function optionalSafeText(value: unknown, max: number): string {
  const text = String(value || '').trim();
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw modelError('validation_failed', false, 422);
  }
  return text;
}

function boundedText(value: unknown, max: number, field: string): string {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`model ${field} is invalid`);
  }
  return text;
}

function boundedNumber(value: unknown, min: number, max: number, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw modelError(`${field}_invalid`, false, 422);
  }
  return number;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    if (field === 'timeout') throw new Error('model timeout is invalid');
    throw modelError(`${field}_invalid`, false, 422);
  }
  return Number(value);
}

function optionalInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) return 0;
  return Number(value);
}

function safeCode(value: unknown): string {
  return String(value || 'provider_error')
    .trim().replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 100) || 'provider_error';
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function modelError(code: string, retryable: boolean, status = 502): ModelGatewayProviderError {
  return new ModelGatewayProviderError(safeCode(code), retryable, status);
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
