import { safeVoiceProviderPayload } from '../canonical.js';
import { VOICE_CAPABILITIES } from '../capabilities.js';
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
import { normalizeVoiceActionCapabilities, VOICE_CAPABILITY_SCHEMA_VERSION } from '../capabilities.js';

export interface RustPbxManagementPaths {
  management_health: string;
  ami_health: string;
  ami_dialogs: string;
  ami_sipflow: string;
  trunk_collection: string;
  trunk_item: string;
  trunk_test: string;
  trunk_reload: string;
  extension_collection: string;
  extension_item: string;
  route_evaluate: string;
  route_reload: string;
  recording_lookup: string;
}

export const DEFAULT_RUSTPBX_MANAGEMENT_PATHS: Readonly<RustPbxManagementPaths> = {
  management_health: '/api/pending-reloads',
  ami_health: '/ami/v1/health',
  ami_dialogs: '/ami/v1/dialogs',
  ami_sipflow: '/ami/v1/sipflow/flow/{id}',
  trunk_collection: '/api/sip-trunk',
  trunk_item: '/api/sip-trunk/{id}',
  trunk_test: '/api/diagnostics/trunks/options',
  trunk_reload: '/ami/v1/reload/trunks',
  extension_collection: '/api/extensions',
  extension_item: '/api/extensions/{id}',
  route_evaluate: '/api/diagnostics/routes/evaluate',
  route_reload: '/ami/v1/reload/routes',
  recording_lookup: '/api/call-records/{id}/metadata'
};

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
const RESOURCE_SECRET_PURPOSE = 'rustpbx_resource_credential';

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
    let management: JsonRecord;
    try {
      management = await this.#requestRecord('management_health', 'GET');
    } catch (error) {
      if (error instanceof VoiceError && error.code === 'capability_unavailable') {
        return this.#capabilities('not-available', capabilities);
      }
      throw error;
    }
    const amiHealth = await this.#requestRecord('ami_health', 'GET');
    capabilities.management_http = true;
    capabilities.json_rpc_routing = true;
    capabilities.postgres_backend = true;
    applyAdvertisedCapabilities(capabilities, management.capabilities);
    applyAdvertisedCapabilities(capabilities, amiHealth.capabilities);
    return this.#capabilities(providerVersion(amiHealth.version), capabilities);
  }

  async applyTrunk(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    const resourceId = boundedIdentifier(input.resource_id);
    const credentialRef = requiredSecretRef(input.desired_state.credential_secret_ref);
    const credential = await this.#secretResolver.resolve(credentialRef, RESOURCE_SECRET_PURPOSE);
    const payload = trunkProviderPayload(resourceId, input.desired_state, credential);
    let providerRef = optionalProviderRef(input.provider_ref);
    if (!providerRef) providerRef = await this.#findTrunkRef(String(payload.name));
    const response = providerRef
      ? await this.#requestRecord('trunk_item', 'PATCH', payload, providerRef)
      : await this.#requestRecord('trunk_collection', 'PUT', payload);
    if (!providerRef) providerRef = providerRefFromResponse(response);
    const reloaded = await this.#requestRecord('trunk_reload', 'POST');
    return {
      provider_ref: providerRef,
      provider_revision: '',
      safe_diagnostics: safeVoiceProviderPayload({ mutation: response, reload: reloaded })
    };
  }

  async testTrunk(input: {
    resource_id: string;
    provider_ref?: string;
    desired_state?: Record<string, unknown>;
  }): Promise<{
    ready: boolean;
    error_code: string;
    safe_diagnostics: Record<string, unknown>;
  }> {
    boundedIdentifier(input.resource_id);
    const desired = input.desired_state;
    if (!isRecord(desired)) throw validationError();
    const providerName = boundedText(desired.provider_name ?? input.resource_id, 120);
    const address = optionalText(desired.sip_server, 512);
    const transport = normalizedTransport(desired.transport);
    const response = await this.#requestRecord('trunk_test', 'POST', {
      trunk: providerName,
      ...(address ? { address } : {}),
      transport
    });
    return {
      ready: response.success === true,
      error_code: response.success === true ? '' : 'provider_probe_failed',
      safe_diagnostics: safeVoiceProviderPayload(response)
    };
  }

  async applyDid(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    const resourceId = boundedIdentifier(input.resource_id);
    const desired = plainRecord(input.desired_state);
    boundedE164(desired.e164);
    return localRouterResult('did', resourceId, '');
  }

  async applyExtension(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    const resourceId = boundedIdentifier(input.resource_id);
    const credentialRef = requiredSecretRef(input.desired_state.credential_secret_ref);
    const credential = await this.#secretResolver.resolve(credentialRef, RESOURCE_SECRET_PURPOSE);
    const payload = extensionProviderPayload(resourceId, input.desired_state, credential);
    let providerRef = optionalProviderRef(input.provider_ref);
    if (!providerRef) providerRef = await this.#findExtensionRef(String(payload.extension));
    const response = providerRef
      ? await this.#requestRecord('extension_item', 'PATCH', payload, providerRef)
      : await this.#requestRecord('extension_collection', 'PUT', payload);
    if (!providerRef) providerRef = providerRefFromResponse(response);
    return {
      provider_ref: providerRef,
      provider_revision: '',
      safe_diagnostics: safeVoiceProviderPayload(response)
    };
  }

  async applyRoute(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    const resourceId = boundedIdentifier(input.resource_id);
    const desired = plainRecord(input.desired_state);
    if (!isRecord(desired.rules)) throw validationError();
    const version = boundedIntegerValue(desired.version, 1, Number.MAX_SAFE_INTEGER);
    return localRouterResult('route', resourceId, String(version));
  }

  async lookupDialog(input: { provider_call_id: string }): Promise<{
    state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    provider_state: string;
    provider_call_id?: string;
    safe_diagnostics: Record<string, unknown>;
  }> {
    const providerCallId = boundedIdentifier(input.provider_call_id);
    const response = await this.#requestJson('ami_dialogs', 'GET');
    if (!Array.isArray(response)) throw protocolError();
    const found = response.find((value) => isRecord(value) && dialogMatches(value, providerCallId));
    if (!isRecord(found)) {
      return {
        state: 'unknown', provider_state: 'not_found',
        safe_diagnostics: { dialogs_checked: Math.min(response.length, 10_000) }
      };
    }
    const providerState = boundedOptionalString(found.state, 128) || 'unknown';
    const resolvedCallId = boundedOptionalString(
      found.provider_call_id ?? found.call_id ?? found.id,
      256
    );
    return {
      state: normalizedDialogState(providerState),
      provider_state: providerState,
      ...(resolvedCallId ? { provider_call_id: resolvedCallId } : {}),
      safe_diagnostics: safeVoiceProviderPayload({ state: providerState, provider_call_id: resolvedCallId })
    };
  }

  async lookupRecording(input: { provider_recording_id: string }): Promise<{
    state: 'processing' | 'available' | 'failed' | 'unknown';
    object_ref: string;
    safe_diagnostics: Record<string, unknown>;
  }> {
    const providerRecordingId = boundedIdentifier(input.provider_recording_id);
    const response = await this.#requestRecord('recording_lookup', 'GET', undefined, providerRecordingId);
    const providerState = boundedOptionalString(response.state, 128) || 'unknown';
    return {
      state: normalizedRecordingState(providerState),
      object_ref: boundedOptionalString(response.object_ref, 2048),
      safe_diagnostics: safeVoiceProviderPayload(response)
    };
  }

  async getSipFlow(providerCallId: string): Promise<{ items: unknown[]; safe_diagnostics: Record<string, unknown> }> {
    const response = await this.#requestRecord('ami_sipflow', 'GET', undefined, boundedIdentifier(providerCallId));
    return {
      items: Array.isArray(response.flow) ? response.flow.slice(0, 1_000) : [],
      safe_diagnostics: safeVoiceProviderPayload(response)
    };
  }

  async evaluateRoute(input: Record<string, unknown>): Promise<JsonRecord> {
    if (!isRecord(input)) throw validationError();
    return this.#requestRecord('route_evaluate', 'POST', input);
  }

  async reloadRoutes(): Promise<JsonRecord> {
    return this.#requestRecord('route_reload', 'POST');
  }

  async getAmiHealth(): Promise<JsonRecord> {
    return this.#requestRecord('ami_health', 'GET');
  }

  async #findTrunkRef(name: string): Promise<string> {
    const response = await this.#requestRecord('trunk_collection', 'POST', listQuery(name));
    const items = boundedItems(response.items);
    return exactProviderRef(items, (item) => item.name === name);
  }

  async #findExtensionRef(extension: string): Promise<string> {
    const response = await this.#requestRecord('extension_collection', 'POST', listQuery(extension));
    const items = boundedItems(response.items).map((item) => isRecord(item.extension) ? item.extension : item);
    return exactProviderRef(items, (item) => item.extension === extension);
  }

  async #requestRecord(
    path: keyof RustPbxManagementPaths,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    body?: Record<string, unknown>,
    identifier?: string
  ): Promise<JsonRecord> {
    const value = await this.#requestJson(path, method, body, identifier);
    if (!isRecord(value)) throw protocolError();
    return value;
  }

  async #requestJson(
    path: keyof RustPbxManagementPaths,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    body?: Record<string, unknown>,
    identifier?: string
  ): Promise<unknown> {
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
    return value;
  }

  #capabilities(providerVersion: string, capabilities: Record<VoiceCapability, boolean>): VoiceProviderCapabilities {
    return {
      profile_id: this.#profileId,
      provider: 'rustpbx',
      provider_version: providerVersion,
      capabilities,
      capability_schema_version: VOICE_CAPABILITY_SCHEMA_VERSION,
      action_capabilities: normalizeVoiceActionCapabilities(),
      checked_at: this.#now().toISOString(),
      config_hash: this.#configHash
    };
  }
}

function providerVersion(value: unknown): string {
  if (typeof value === 'string') return boundedOptionalString(value, 128) || 'unknown';
  if (isRecord(value)) {
    for (const candidate of [value.version, value.semver, value.build]) {
      if (typeof candidate === 'string' && candidate) return boundedOptionalString(candidate, 128);
    }
  }
  return 'unknown';
}

function trunkProviderPayload(
  resourceId: string,
  value: unknown,
  credential: string
): Record<string, unknown> {
  const input = plainRecord(value);
  const allowed = new Set([
    'provider_name', 'name', 'direction', 'transport', 'codecs', 'max_channels',
    'credential_secret_ref', 'status', 'sip_server', 'outbound_proxy', 'auth_username',
    'carrier', 'description', 'default_route_label', 'max_cps', 'max_call_duration',
    'allowed_ips', 'did_numbers', 'tags', 'incoming_from_user_prefix',
    'incoming_to_user_prefix', 'register_enabled', 'register_expires',
    'register_extra_headers', 'metadata'
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw validationError();
  const status = normalizedResourceStatus(input.status);
  const codecs = stringList(input.codecs, 16, 32);
  const payload: Record<string, unknown> = {
    name: boundedText(input.provider_name ?? resourceId, 120),
    display_name: boundedText(input.name, 160),
    status: status === 'active' ? 'healthy' : status === 'degraded' ? 'warning' : 'offline',
    direction: normalizedTrunkDirection(input.direction),
    sip_transport: normalizedTransport(input.transport),
    max_concurrent: boundedIntegerValue(input.max_channels, 1, 1_000_000),
    auth_password: boundedCredential(credential),
    is_active: status !== 'disabled',
    metadata: JSON.stringify({
      ...(isRecord(input.metadata) ? input.metadata : {}),
      ivekit_resource_id: resourceId,
      codecs
    })
  };
  for (const [source, target, max] of [
    ['sip_server', 'sip_server', 160],
    ['outbound_proxy', 'outbound_proxy', 160],
    ['auth_username', 'auth_username', 160],
    ['carrier', 'carrier', 160],
    ['description', 'description', 2_048],
    ['default_route_label', 'default_route_label', 160],
    ['incoming_from_user_prefix', 'incoming_from_user_prefix', 160],
    ['incoming_to_user_prefix', 'incoming_to_user_prefix', 160]
  ] as const) {
    const item = optionalText(input[source], max);
    if (item) payload[target] = item;
  }
  for (const field of ['max_cps', 'max_call_duration', 'register_expires'] as const) {
    if (input[field] !== undefined) payload[field] = boundedIntegerValue(input[field], 1, 2_147_483_647);
  }
  for (const field of ['allowed_ips', 'did_numbers', 'tags', 'register_extra_headers'] as const) {
    if (input[field] !== undefined) payload[field] = jsonFormValue(input[field]);
  }
  if (input.register_enabled !== undefined) payload.register_enabled = booleanValue(input.register_enabled);
  return payload;
}

function extensionProviderPayload(
  resourceId: string,
  value: unknown,
  credential: string
): Record<string, unknown> {
  const input = plainRecord(value);
  const allowed = new Set([
    'identity', 'extension', 'display_name', 'credential_secret_ref', 'permissions',
    'webrtc_enabled', 'status'
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw validationError();
  const permissions = plainRecord(input.permissions);
  const status = normalizedResourceStatus(input.status);
  const payload: Record<string, unknown> = {
    extension: boundedText(input.extension, 64),
    display_name: boundedText(input.display_name, 160),
    sip_password: boundedCredential(credential),
    login_disabled: status !== 'active',
    voicemail_disabled: permissions.voicemail_enabled === false,
    allow_guest_calls: permissions.allow_guest_calls === true,
    notes: JSON.stringify({
      ivekit_resource_id: resourceId,
      identity: boundedText(input.identity, 256),
      webrtc_enabled: booleanValue(input.webrtc_enabled)
    })
  };
  const email = optionalText(permissions.email, 320);
  if (email) payload.email = email;
  const forwardingMode = optionalText(permissions.call_forwarding_mode, 64);
  if (forwardingMode) payload.call_forwarding_mode = forwardingMode;
  const forwardingDestination = optionalText(permissions.call_forwarding_destination, 256);
  if (forwardingDestination) payload.call_forwarding_destination = forwardingDestination;
  if (permissions.call_forwarding_timeout !== undefined) {
    payload.call_forwarding_timeout = boundedIntegerValue(
      permissions.call_forwarding_timeout, 1, 86_400
    );
  }
  return payload;
}

function localRouterResult(
  resourceType: 'did' | 'route',
  resourceId: string,
  providerRevision: string
): VoiceManagementApplyResult {
  return {
    provider_ref: `ivekit-http-router:${resourceType}:${resourceId}`,
    provider_revision: providerRevision,
    safe_diagnostics: { authority: 'ivekit_http_router' }
  };
}

function listQuery(query: string): Record<string, unknown> {
  return { page: 1, per_page: 100, filters: { q: boundedText(query, 256) } };
}

function boundedItems(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.length > 1_000 || value.some((item) => !isRecord(item))) {
    throw protocolError();
  }
  return value as JsonRecord[];
}

function exactProviderRef(items: JsonRecord[], predicate: (item: JsonRecord) => boolean): string {
  const matches = items.filter(predicate);
  if (matches.length > 1) throw protocolError();
  return matches.length === 1 ? providerRefFromResponse(matches[0]) : '';
}

function providerRefFromResponse(value: JsonRecord): string {
  const id = value.id ?? value.provider_ref;
  if ((typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
    || (typeof id === 'string' && /^[1-9][0-9]{0,18}$/.test(id))) {
    return String(id);
  }
  throw protocolError();
}

function optionalProviderRef(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) throw validationError();
  return value;
}

function requiredSecretRef(value: unknown): string {
  if (typeof value !== 'string' || !/^env:\/\/[A-Z][A-Z0-9_]*$/.test(value)) throw validationError();
  return value;
}

function plainRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw validationError();
  return value;
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw validationError();
  const result = value.trim();
  if (!result || result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function optionalText(value: unknown, maxLength: number): string {
  if (value === undefined || value === null || value === '') return '';
  return boundedText(value, maxLength);
}

function boundedCredential(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw validationError();
  }
  return value;
}

function boundedE164(value: unknown): string {
  const result = boundedText(value, 32);
  if (!/^\+[1-9][0-9]{6,14}$/.test(result)) throw validationError();
  return result;
}

function boundedIntegerValue(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw validationError();
  return Number(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw validationError();
  return value;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maxItems) throw validationError();
  return [...new Set(value.map((item) => boundedText(item, maxLength)))];
}

function normalizedResourceStatus(value: unknown): 'active' | 'degraded' | 'disabled' {
  if (value === 'active' || value === 'applying' || value === 'draft') return 'active';
  if (value === 'degraded') return 'degraded';
  if (value === 'disabled' || value === 'archived') return 'disabled';
  throw validationError();
}

function normalizedTrunkDirection(value: unknown): 'inbound' | 'outbound' | 'bidirectional' {
  if (value === 'inbound' || value === 'outbound') return value;
  if (value === 'both') return 'bidirectional';
  throw validationError();
}

function normalizedTransport(value: unknown): 'udp' | 'tcp' | 'tls' {
  if (value === 'udp' || value === 'tcp' || value === 'tls') return value;
  throw validationError();
}

function jsonFormValue(value: unknown): string {
  if (typeof value === 'string') {
    const result = boundedText(value, 32_768);
    try {
      JSON.parse(result);
    } catch {
      throw validationError();
    }
    return result;
  }
  if (!Array.isArray(value) && !isRecord(value)) throw validationError();
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result, 'utf8') > 32_768) throw validationError();
  return result;
}

function dialogMatches(value: JsonRecord, providerCallId: string): boolean {
  return [value.id, value.call_id, value.provider_call_id, value.dialog_id]
    .some((candidate) => candidate === providerCallId);
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
    'management_health', 'ami_health', 'ami_dialogs', 'ami_sipflow', 'trunk_collection',
    'trunk_item', 'trunk_test', 'trunk_reload', 'extension_collection', 'extension_item',
    'route_evaluate', 'route_reload', 'recording_lookup'
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
  const normalized = value.trim().toLowerCase();
  if (['active', 'answered', 'completed', 'connected', 'confirmed', 'ended', 'talking', 'terminated'].includes(normalized)) return 'succeeded';
  if (['created', 'dialing', 'ringing', 'trying', 'pending', 'early'].includes(normalized)) return 'pending';
  if (['failed', 'rejected', 'cancelled', 'timeout', 'timed_out'].includes(normalized)) return 'failed';
  const rustPbxDialogState = normalized.match(/\((calling|early|confirmed|terminated)(?:\s[^()]*)?\)$/)?.[1];
  if (rustPbxDialogState === 'confirmed' || rustPbxDialogState === 'terminated') return 'succeeded';
  if (rustPbxDialogState === 'calling' || rustPbxDialogState === 'early') return 'pending';
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
