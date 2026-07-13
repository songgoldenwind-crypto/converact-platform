import { safeVoiceProviderPayload } from '../canonical.js';
import { VOICE_CAPABILITIES } from '../deployment-profile-service.js';
import { VoiceError } from '../errors.js';
import type {
  VoiceManagementApplyInput,
  VoiceManagementApplyResult,
  VoiceManagementPort,
  VoiceSecretResolver
} from '../ports.js';
import type {
  VoiceCapability,
  VoiceProviderCapabilities
} from '../types.js';

export interface RustPbxManagementPaths {
  health: string;
  version: string;
  ami_health: string;
  ami_dialog: string;
  ami_sipflow: string;
  trunk_apply: string;
  trunk_test: string;
  did_apply: string;
  extension_apply: string;
  route_evaluate: string;
  route_reload: string;
  recording_lookup: string;
}

export interface RustPbxManagementClientOptions {
  base_url: string;
  profile_id: string;
  config_hash: string;
  service_token_ref: string;
  secret_resolver: VoiceSecretResolver;
  paths: RustPbxManagementPaths;
  internal_service?: boolean;
  production?: boolean;
  timeout_ms?: number;
  max_response_bytes?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface JsonRecord {
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const SECRET_PURPOSE = 'rustpbx_management';

export class RustPbxManagementClient implements VoiceManagementPort {
  readonly #baseUrl: URL;
  readonly #profileId: string;
  readonly #configHash: string;
  readonly #serviceTokenRef: string;
  readonly #secretResolver: VoiceSecretResolver;
  readonly #paths: RustPbxManagementPaths;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: RustPbxManagementClientOptions) {
    this.#baseUrl = validatedBaseUrl(options.base_url, options.production === true, options.internal_service === true);
    this.#profileId = boundedIdentifier(options.profile_id);
    this.#configHash = validatedConfigHash(options.config_hash);
    if (typeof options.service_token_ref !== 'string' || options.service_token_ref.length > 512) {
      throw validationError();
    }
    this.#serviceTokenRef = options.service_token_ref;
    this.#secretResolver = options.secret_resolver;
    this.#paths = validatedPaths(options.paths);
    this.#timeoutMs = boundedInteger(options.timeout_ms, DEFAULT_TIMEOUT_MS, 10, 120_000);
    this.#maxResponseBytes = boundedInteger(options.max_response_bytes, DEFAULT_MAX_RESPONSE_BYTES, 64, 4 * 1024 * 1024);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async preflight(): Promise<VoiceProviderCapabilities> {
    const capabilities = emptyCapabilities();
    let health: JsonRecord;
    try {
      health = await this.#request('health', 'GET');
    } catch (error) {
      if (error instanceof VoiceError && error.code === 'capability_unavailable') {
        return this.#capabilities('not-available', capabilities);
      }
      throw error;
    }
    const version = await this.#request('version', 'GET');
    const amiHealth = await this.#optionalProbe('ami_health');
    capabilities.management_http = health.ready === true;
    capabilities.postgres_backend = health.database === 'postgres';
    applyAdvertisedCapabilities(capabilities, health.capabilities);
    applyAdvertisedCapabilities(capabilities, amiHealth?.capabilities);
    return this.#capabilities(boundedOptionalString(version.version, 128) || 'unknown', capabilities);
  }

  async applyTrunk(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    return this.#apply('trunk_apply', input);
  }

  async testTrunk(input: { resource_id: string }): Promise<{
    ready: boolean;
    error_code: string;
    safe_diagnostics: Record<string, unknown>;
  }> {
    const resourceId = boundedIdentifier(input.resource_id);
    const response = await this.#request('trunk_test', 'POST', { resource_id: resourceId }, resourceId);
    return {
      ready: response.ready === true,
      error_code: boundedOptionalString(response.error_code, 128),
      safe_diagnostics: safeVoiceProviderPayload(response)
    };
  }

  async applyDid(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    return this.#apply('did_apply', input);
  }

  async applyExtension(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    return this.#apply('extension_apply', input);
  }

  async applyRoute(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    return this.#apply('route_evaluate', input);
  }

  async lookupDialog(input: { provider_call_id: string }): Promise<{
    state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    provider_state: string;
    provider_call_id?: string;
    safe_diagnostics: Record<string, unknown>;
  }> {
    const providerCallId = boundedIdentifier(input.provider_call_id);
    const response = await this.#request('ami_dialog', 'GET', undefined, providerCallId);
    const providerState = boundedOptionalString(response.state, 128) || 'unknown';
    const resolvedCallId = boundedOptionalString(
      response.provider_call_id ?? response.call_id,
      256
    );
    return {
      state: normalizedDialogState(providerState),
      provider_state: providerState,
      ...(resolvedCallId ? { provider_call_id: resolvedCallId } : {}),
      safe_diagnostics: safeVoiceProviderPayload(response)
    };
  }

  async lookupRecording(input: { provider_recording_id: string }): Promise<{
    state: 'processing' | 'available' | 'failed' | 'unknown';
    object_ref: string;
    safe_diagnostics: Record<string, unknown>;
  }> {
    const providerRecordingId = boundedIdentifier(input.provider_recording_id);
    const response = await this.#request('recording_lookup', 'GET', undefined, providerRecordingId);
    const providerState = boundedOptionalString(response.state, 128) || 'unknown';
    return {
      state: normalizedRecordingState(providerState),
      object_ref: boundedOptionalString(response.object_ref, 2048),
      safe_diagnostics: safeVoiceProviderPayload(response)
    };
  }

  async getSipFlow(providerCallId: string): Promise<{ items: unknown[]; safe_diagnostics: Record<string, unknown> }> {
    const response = await this.#request('ami_sipflow', 'GET', undefined, boundedIdentifier(providerCallId));
    return {
      items: Array.isArray(response.items) ? response.items.slice(0, 1_000) : [],
      safe_diagnostics: safeVoiceProviderPayload(response)
    };
  }

  async evaluateRoute(input: Record<string, unknown>): Promise<JsonRecord> {
    if (!isRecord(input)) throw validationError();
    return this.#request('route_evaluate', 'POST', input);
  }

  async reloadRoutes(): Promise<JsonRecord> {
    return this.#request('route_reload', 'POST');
  }

  async getAmiHealth(): Promise<JsonRecord> {
    return this.#request('ami_health', 'GET');
  }

  async #apply(
    path: 'trunk_apply' | 'did_apply' | 'extension_apply' | 'route_evaluate',
    input: VoiceManagementApplyInput
  ): Promise<VoiceManagementApplyResult> {
    const resourceId = boundedIdentifier(input.resource_id);
    if (!isRecord(input.desired_state)) throw validationError();
    const response = await this.#request(path, 'PUT', {
      resource_id: resourceId,
      desired_state: input.desired_state
    }, resourceId);
    const providerRef = boundedOptionalString(response.provider_ref, 512);
    if (!providerRef) throw protocolError();
    return {
      provider_ref: providerRef,
      provider_revision: boundedOptionalString(response.revision, 512),
      safe_diagnostics: safeVoiceProviderPayload(response)
    };
  }

  async #request(
    path: keyof RustPbxManagementPaths,
    method: 'GET' | 'POST' | 'PUT',
    body?: Record<string, unknown>,
    identifier?: string
  ): Promise<JsonRecord> {
    const token = await this.#secretResolver.resolve(this.#serviceTokenRef, SECRET_PURPOSE);
    const url = resolvePath(this.#baseUrl, this.#paths[path], identifier);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new VoiceError({ code: 'provider_timeout', retryable: true, status: 504 });
      }
      throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw classifiedHttpError(response.status);
    }
    const value = await readBoundedJson(response, this.#maxResponseBytes);
    if (!isRecord(value)) throw protocolError();
    return value;
  }

  async #optionalProbe(path: keyof RustPbxManagementPaths): Promise<JsonRecord | null> {
    try {
      return await this.#request(path, 'GET');
    } catch (error) {
      if (error instanceof VoiceError && error.code === 'capability_unavailable') return null;
      throw error;
    }
  }

  #capabilities(providerVersion: string, capabilities: Record<VoiceCapability, boolean>): VoiceProviderCapabilities {
    return {
      profile_id: this.#profileId,
      provider: 'rustpbx',
      provider_version: providerVersion,
      capabilities,
      checked_at: this.#now().toISOString(),
      config_hash: this.#configHash
    };
  }
}

function validatedBaseUrl(value: unknown, production: boolean, internalService: boolean): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw validationError();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw validationError();
  }
  if (production && url.protocol !== 'https:' && !internalService) throw validationError();
  return url;
}

function validatedConfigHash(value: unknown): string {
  const hash = String(value ?? '');
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw validationError();
  return hash.toLowerCase();
}

function validatedPaths(input: RustPbxManagementPaths): RustPbxManagementPaths {
  if (!isRecord(input)) throw validationError();
  const output = {} as RustPbxManagementPaths;
  for (const key of [
    'health', 'version', 'ami_health', 'ami_dialog', 'ami_sipflow', 'trunk_apply',
    'trunk_test', 'did_apply', 'extension_apply', 'route_evaluate', 'route_reload', 'recording_lookup'
  ] as const) {
    output[key] = validatedPath(input[key]);
  }
  return output;
}

function validatedPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('#')) {
    throw validationError();
  }
  if (/\{(?!id\})[^}]*\}/.test(value)) throw validationError();
  const rawPath = value.split('?')[0];
  for (const rawSegment of rawPath.split('/')) {
    let segment = rawSegment;
    try {
      segment = decodeURIComponent(segment);
      segment = decodeURIComponent(segment);
    } catch {
      throw validationError();
    }
    if (segment === '.' || segment === '..') throw validationError();
  }
  let parsed: URL;
  try {
    parsed = new URL(value, 'https://rustpbx.invalid');
  } catch {
    throw validationError();
  }
  if (parsed.origin !== 'https://rustpbx.invalid') throw validationError();
  for (const key of parsed.searchParams.keys()) {
    if (/(?:auth|credential|password|secret|token|api[-_]?key)/i.test(key)) throw validationError();
  }
  return value;
}

function resolvePath(baseUrl: URL, configuredPath: string, identifier?: string): URL {
  const path = configuredPath.includes('{id}')
    ? configuredPath.replaceAll('{id}', encodeURIComponent(boundedIdentifier(identifier)))
    : configuredPath;
  return new URL(path, baseUrl);
}

function boundedIdentifier(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function boundedOptionalString(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw protocolError();
  }
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) throw validationError();
  return resolved;
}

function emptyCapabilities(): Record<VoiceCapability, boolean> {
  return Object.fromEntries(VOICE_CAPABILITIES.map((capability) => [capability, false])) as Record<VoiceCapability, boolean>;
}

function applyAdvertisedCapabilities(output: Record<VoiceCapability, boolean>, value: unknown): void {
  if (!isRecord(value)) return;
  for (const capability of VOICE_CAPABILITIES) {
    if (value[capability] === true) output[capability] = true;
  }
}

function normalizedDialogState(value: string): 'pending' | 'succeeded' | 'failed' | 'unknown' {
  if (['active', 'answered', 'completed', 'connected', 'ended'].includes(value.toLowerCase())) return 'succeeded';
  if (['created', 'dialing', 'ringing', 'trying', 'pending'].includes(value.toLowerCase())) return 'pending';
  if (['failed', 'rejected', 'cancelled', 'timeout', 'timed_out'].includes(value.toLowerCase())) return 'failed';
  return 'unknown';
}

function normalizedRecordingState(value: string): 'processing' | 'available' | 'failed' | 'unknown' {
  if (['created', 'pending', 'processing', 'uploading'].includes(value.toLowerCase())) return 'processing';
  if (['available', 'ready', 'completed'].includes(value.toLowerCase())) return 'available';
  if (['failed', 'deleted', 'unavailable'].includes(value.toLowerCase())) return 'failed';
  return 'unknown';
}

function classifiedHttpError(status: number): VoiceError {
  if (status === 401 || status === 403) {
    return new VoiceError({ code: 'provider_auth_failed', status });
  }
  if (status === 404) return new VoiceError({ code: 'capability_unavailable', status });
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new VoiceError({ code: 'provider_unavailable', retryable: true, status });
  }
  return new VoiceError({ code: 'provider_unavailable', status });
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new VoiceError({ code: 'provider_response_too_large', status: 502 });
  }
  if (!response.body) throw protocolError();
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
        throw new VoiceError({ code: 'provider_response_too_large', status: 502 });
      }
      chunks.push(value);
    }
    if (bytes === 0 && response.status === 204) return {};
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof VoiceError) throw error;
    throw protocolError();
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}

function protocolError(): VoiceError {
  return new VoiceError({ code: 'protocol_mismatch', status: 502 });
}
