import type {
  RemoteConsentScope,
  RemoteGatewayAuditEvent,
  RemoteToolSession,
  RustDeskClientConfig,
  RustDeskClientDistributionArchitecture,
  RustDeskClientDistributionPlatform,
  RustDeskClientDistributionProfile,
  RustDeskClientVersion,
  RustDeskConfiguredFields,
  RustDeskDevice,
  RustDeskDeviceCommand,
  RustDeskDeviceCommandStatus,
  RustDeskDisconnectState,
  RustDeskGatewayLaunchPlan,
  RustDeskObservedOperation,
  RustDeskOperationDirection,
  RustDeskOperationEvidence,
  RustDeskOperationEvidenceMetadata,
  RustDeskOperationEvidenceReference,
  RustDeskOperationObserver,
  RustDeskPermissionScopes,
  RustDeskRuntimeCapabilities,
  RustDeskTerminalArchitecture,
  RustDeskTerminalPlatform,
  RustDeskTerminalProfile
} from './types.js';

export type IveKitRustDeskFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface IveKitRustDeskHttpClientInput {
  baseUrl: string;
  apiKey?: string;
  accessToken?: string;
  tenantId: string;
  userId?: string;
  timeoutMs?: number;
  fetch?: IveKitRustDeskFetch;
}

export interface IveKitRustDeskBusinessRefInput {
  tenant_id?: string;
  type: string;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterIveKitRustDeskDeviceInput {
  business_ref: IveKitRustDeskBusinessRefInput;
  rustdesk_id: string;
  display_name: string;
  metadata?: Record<string, unknown>;
}

export interface ListIveKitRustDeskDevicesByRefInput {
  business_ref: IveKitRustDeskBusinessRefInput;
  limit?: number;
}

export interface GetIveKitRustDeskClientProfileInput {
  platform: RustDeskClientDistributionPlatform;
  architecture: RustDeskClientDistributionArchitecture;
  client_version: string;
  expected_server_version: string;
  expected_server_key_fingerprint: string;
}

export interface HeartbeatIveKitRustDeskDeviceInput {
  actor_identity: string;
  runtime_status?: 'online' | 'offline';
  seen_at?: string;
  metadata?: Record<string, unknown>;
}

export interface StartIveKitRustDeskGatewaySessionInput {
  remote_session_id: string;
  device_id: string;
  actor_identity: string;
  permissions: RemoteConsentScope[];
  metadata?: Record<string, unknown>;
}

export interface RecordIveKitRustDeskGatewayEventInput {
  event_type: string;
  actor_identity: string;
  target?: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
  occurred_at?: string;
}

export interface ListIveKitRustDeskGatewayAuditEventsInput {
  since?: string;
}

export interface EndIveKitRustDeskGatewaySessionInput {
  actor_identity: string;
}

export interface IveKitRustDeskGatewayDisconnectState {
  required: true;
  status: RustDeskDeviceCommandStatus | 'unavailable';
  command: RustDeskDeviceCommand | null;
}

export interface IveKitRustDeskHttpClient {
  getClientConfig(): Promise<RustDeskClientConfig>;
  getClientProfile(input: GetIveKitRustDeskClientProfileInput): Promise<RustDeskClientDistributionProfile>;
  registerDevice(input: RegisterIveKitRustDeskDeviceInput): Promise<RustDeskDevice>;
  getDevice(deviceId: string): Promise<RustDeskDevice>;
  listDevicesByBusinessRef(input: ListIveKitRustDeskDevicesByRefInput): Promise<RustDeskDevice[]>;
  heartbeatDevice(deviceId: string, input: HeartbeatIveKitRustDeskDeviceInput): Promise<RustDeskDevice>;
  deactivateDevice(deviceId: string): Promise<RustDeskDevice>;
  startGatewaySession(input: StartIveKitRustDeskGatewaySessionInput): Promise<RemoteToolSession>;
  getGatewayLaunchPlan(externalId: string): Promise<RustDeskGatewayLaunchPlan>;
  recordGatewayEvent(
    externalId: string,
    input: RecordIveKitRustDeskGatewayEventInput
  ): Promise<RemoteGatewayAuditEvent>;
  listGatewayAuditEvents(
    externalId: string,
    input?: ListIveKitRustDeskGatewayAuditEventsInput
  ): Promise<RemoteGatewayAuditEvent[]>;
  endGatewaySession(externalId: string, input: EndIveKitRustDeskGatewaySessionInput): Promise<void>;
  getGatewayDisconnectState(externalId: string): Promise<RustDeskDisconnectState>;
}

export class IveKitRustDeskHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly payload: unknown
  ) {
    super(message);
    this.name = 'IveKitRustDeskHttpError';
  }
}

export function createIveKitRustDeskHttpClient(input: IveKitRustDeskHttpClientInput): IveKitRustDeskHttpClient {
  const baseUrl = validateBaseUrl(input.baseUrl);
  const apiKey = String(input.apiKey || '').trim();
  const accessToken = String(input.accessToken || '').trim();
  if (Boolean(apiKey) === Boolean(accessToken)) {
    throw new Error('exactly one of apiKey or accessToken is required');
  }
  const tenantId = requiredString(input.tenantId, 'tenantId is required');
  const userId = String(input.userId || '').trim();
  const timeoutMs = validTimeout(input.timeoutMs);
  const fetchImpl = input.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is required');

  const request = async <T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> => {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      ...(apiKey ? { 'x-api-key': apiKey } : { authorization: `Bearer ${accessToken}` }),
      'x-tenant-id': tenantId
    };
    if (apiKey && userId) headers['x-user-id'] = userId;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    init.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), init);
    } catch (error) {
      const message = controller.signal.aborted
        ? `${method} ${path} timed out after ${timeoutMs}ms`
        : `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new IveKitRustDeskHttpError(message, 0, method, path, null);
    } finally {
      clearTimeout(timer);
    }
    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw new IveKitRustDeskHttpError(
        `${method} ${path} failed with ${response.status}: ${errorDetail(payload)}`,
        response.status,
        method,
        path,
        payload
      );
    }
    return payload as T;
  };

  return {
    getClientConfig() {
      return request<RustDeskClientConfig>('GET', '/api/ivekit/rustdesk/client-config');
    },
    async getClientProfile(profileInput) {
      const expectedServerVersion = requiredString(
        profileInput.expected_server_version,
        'expected_server_version is required'
      );
      if (expectedServerVersion !== '1.1.15') {
        throw new Error('expected_server_version must equal 1.1.15');
      }
      const expectedFingerprint = requiredString(
        profileInput.expected_server_key_fingerprint,
        'expected_server_key_fingerprint is required'
      );
      if (!/^sha256:[a-f0-9]{16}$/.test(expectedFingerprint)) {
        throw new Error('expected_server_key_fingerprint is invalid');
      }
      const profile = await request<unknown>('GET', '/api/ivekit/rustdesk/client-profile', undefined, {
        platform: profileInput.platform,
        architecture: profileInput.architecture,
        client_version: profileInput.client_version,
        expected_server_version: expectedServerVersion,
        expected_server_key_fingerprint: expectedFingerprint
      });
      return await projectRustDeskClientDistributionProfile(profile, profileInput);
    },
    async registerDevice(device) {
      return projectRustDeskDevice(
        await request<RustDeskDevice>('POST', '/api/ivekit/rustdesk/devices', device)
      );
    },
    async getDevice(deviceId) {
      return projectRustDeskDevice(
        await request<RustDeskDevice>('GET', `/api/ivekit/rustdesk/devices/${encodeURIComponent(requiredString(deviceId, 'deviceId is required'))}`)
      );
    },
    async listDevicesByBusinessRef(input) {
      const businessRef = input.business_ref;
      const devices = await request<unknown>('GET', '/api/ivekit/rustdesk/devices/by-ref', undefined, {
        business_ref_type: requiredString(businessRef?.type, 'business_ref.type is required'),
        business_ref_id: requiredString(businessRef?.id, 'business_ref.id is required'),
        limit: input.limit === undefined ? '' : String(input.limit)
      });
      if (!Array.isArray(devices)) throw new Error('invalid RustDesk device list');
      return devices.map(projectRustDeskDevice);
    },
    async heartbeatDevice(deviceId, input) {
      return projectRustDeskDevice(
        await request<RustDeskDevice>(
          'POST',
          `/api/ivekit/rustdesk/devices/${encodeURIComponent(requiredString(deviceId, 'deviceId is required'))}/heartbeat`,
          input
        )
      );
    },
    async deactivateDevice(deviceId) {
      return projectRustDeskDevice(
        await request<RustDeskDevice>(
          'POST',
          `/api/ivekit/rustdesk/devices/${encodeURIComponent(requiredString(deviceId, 'deviceId is required'))}/deactivate`,
          {}
        )
      );
    },
    async startGatewaySession(input) {
      const session = await request<RemoteToolSession>('POST', '/api/ivekit/rustdesk/gateway-sessions', input);
      return projectEvidenceContainer(session, 'remote tool session');
    },
    async getGatewayLaunchPlan(externalId) {
      const plan = await request<RustDeskGatewayLaunchPlan>(
        'GET',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/launch`
      );
      return projectEvidenceContainer(plan, 'gateway launch plan');
    },
    async recordGatewayEvent(externalId, input) {
      const result = await request<{ event: RemoteGatewayAuditEvent }>(
        'POST',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/events`,
        input
      );
      return result.event;
    },
    async listGatewayAuditEvents(externalId, input = {}) {
      const result = await request<{ events: RemoteGatewayAuditEvent[] }>(
        'GET',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/audit`,
        undefined,
        { since: input.since || '' }
      );
      return result.events;
    },
    async endGatewaySession(externalId, input) {
      await request<null>(
        'DELETE',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}`,
        input
      );
    },
    async getGatewayDisconnectState(externalId) {
      const state = await request<RustDeskDisconnectState>(
        'GET',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/disconnect`
      );
      return projectRustDeskDisconnectState(state);
    }
  };
}

export async function projectRustDeskClientDistributionProfile(
  value: unknown,
  expected: GetIveKitRustDeskClientProfileInput,
  now = new Date()
): Promise<RustDeskClientDistributionProfile> {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw invalidDistribution('validation clock');
  const expectedServerVersion = distributionRequiredString(
    expected.expected_server_version,
    'expected_server_version is required'
  );
  const expectedFingerprint = distributionRequiredString(
    expected.expected_server_key_fingerprint,
    'expected_server_key_fingerprint is required'
  );
  if (expectedServerVersion !== '1.1.15') throw invalidDistribution('expected_server_version');
  if (!/^sha256:[a-f0-9]{16}$/.test(expectedFingerprint)) {
    throw invalidDistribution('expected_server_key_fingerprint');
  }
  const profile = distributionRecord(value, 'payload');
  const platform = distributionEnum(
    profile.platform,
    ['windows', 'macos', 'linux'] as const,
    'platform'
  );
  const architecture = distributionEnum(
    profile.architecture,
    ['x86_64', 'aarch64'] as const,
    'architecture'
  );
  if (!isSupportedDistributionTarget(platform, architecture)) throw invalidDistribution('tuple');
  if (platform !== expected.platform) throw invalidDistribution('platform drift');
  if (architecture !== expected.architecture) throw invalidDistribution('architecture drift');

  const clientVersion = distributionRecord(profile.client_version, 'client_version');
  if (
    clientVersion.exact !== '1.4.7' ||
    !Array.isArray(clientVersion.allowed) ||
    clientVersion.allowed.length !== 1 ||
    clientVersion.allowed[0] !== '1.4.7' ||
    expected.client_version !== '1.4.7'
  ) {
    throw invalidDistribution('client_version');
  }
  if (profile.server_version !== '1.1.15' || profile.server_version !== expectedServerVersion) {
    throw invalidDistribution('server_version drift');
  }

  const issuedAt = distributionTimestamp(profile.issued_at, 'issued_at');
  const expiresAt = distributionTimestamp(profile.expires_at, 'expires_at');
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (expiresAtMs <= nowMs) throw invalidDistribution('expired');
  if (issuedAtMs > nowMs + 60_000) throw invalidDistribution('issued_at');
  if (expiresAtMs <= issuedAtMs) throw invalidDistribution('expires_at');
  if (expiresAtMs - issuedAtMs < 60_000 || expiresAtMs - issuedAtMs > 3_600_000) {
    throw invalidDistribution('profile lifetime');
  }

  const manual = distributionRecord(profile.manual_fields, 'manual_fields');
  const manualFields = {
    id_server: distributionRequiredString(manual.id_server, 'manual_fields.id_server'),
    relay_server: distributionString(manual.relay_server, 'manual_fields.relay_server'),
    api_server: distributionString(manual.api_server, 'manual_fields.api_server'),
    key: distributionRequiredString(manual.key, 'manual_fields.key')
  };
  validateDistributionApiServer(manualFields.api_server);
  const derivedFingerprint = await distributionPublicKeyFingerprint(manualFields.key);

  const fingerprint = distributionRequiredString(
    profile.server_key_fingerprint,
    'server_key_fingerprint'
  );
  if (!/^sha256:[a-f0-9]{16,64}$/.test(fingerprint)) {
    throw invalidDistribution('server_key_fingerprint');
  }
  if (fingerprint !== derivedFingerprint) {
    throw invalidDistribution('public key fingerprint');
  }
  if (fingerprint !== expectedFingerprint) {
    throw invalidDistribution('server_key_fingerprint drift');
  }

  const protocol = distributionRecord(profile.protocol_handler, 'protocol_handler');
  if (protocol.supported !== true || protocol.user_initiated_only !== true) {
    throw invalidDistribution('protocol_handler');
  }
  const unattended = distributionRecord(profile.unattended_policy, 'unattended_policy');
  if (unattended.mode !== 'attended_only' || unattended.state !== 'not_configured') {
    throw invalidDistribution('unattended_policy');
  }

  return {
    platform,
    architecture,
    client_version: { exact: '1.4.7', allowed: ['1.4.7'] },
    server_version: '1.1.15',
    issued_at: issuedAt,
    expires_at: expiresAt,
    manual_fields: manualFields,
    server_key_fingerprint: fingerprint,
    protocol_handler: { supported: true, user_initiated_only: true },
    install_source: projectDistributionInstallSource(profile.install_source, platform, architecture),
    unattended_policy: { mode: 'attended_only', state: 'not_configured' }
  };
}

async function distributionPublicKeyFingerprint(value: string): Promise<string> {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw invalidDistribution('manual_fields.key');
  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw invalidDistribution('manual_fields.key');
  }
  if (binary.length !== 32 || globalThis.btoa(binary) !== value) {
    throw invalidDistribution('manual_fields.key');
  }
  if (!globalThis.crypto?.subtle) throw invalidDistribution('public key fingerprint');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex.slice(0, 16)}`;
}

function projectDistributionInstallSource(
  value: unknown,
  platform: RustDeskClientDistributionPlatform,
  architecture: RustDeskClientDistributionArchitecture
): RustDeskClientDistributionProfile['install_source'] {
  const source = distributionRecord(value, 'install_source');
  if (source.state === 'not_configured') return { state: 'not_configured' };
  if (source.state !== 'configured') throw invalidDistribution('install_source.state');
  const url = distributionArtifactUrl(source.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw invalidDistribution('install_source.url');
  }
  const filename = distributionArtifactFilename(source.filename);
  validateDistributionCanonicalUrlFilename(url, filename);
  const pathSegments = distributionArtifactPathSegments(url);
  const urlFilename = pathSegments.at(-1) || '';
  if (filename !== urlFilename) throw invalidDistribution('install_source.filename');
  validateDistributionArtifactReleasePath(url, pathSegments);
  validateDistributionArtifactIdentity(pathSegments.join('/'), filename, platform, architecture);
  const sha256 = distributionRequiredString(source.sha256, 'install_source.sha256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw invalidDistribution('install_source.sha256');
  return { state: 'configured', url: url.toString(), filename, sha256 };
}

const distributionArtifactExtensions: Record<string, readonly string[]> = {
  'windows/x86_64': ['.exe', '.msi'],
  'macos/x86_64': ['.dmg'],
  'macos/aarch64': ['.dmg'],
  'linux/x86_64': ['.deb'],
  'linux/aarch64': ['.deb']
};

const distributionArtifactArchitectureTokens: Record<RustDeskClientDistributionArchitecture, readonly string[]> = {
  x86_64: ['x86_64', 'amd64'],
  aarch64: ['aarch64', 'arm64']
};

function distributionArtifactUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f-\u009f]/.test(value)) {
    throw invalidDistribution('install_source.url');
  }
  try {
    return new URL(value);
  } catch {
    throw invalidDistribution('install_source.url');
  }
}

function distributionArtifactFilename(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9._+-]{1,255}$/.test(value)
  ) {
    throw invalidDistribution('install_source.filename');
  }
  return value;
}

function validateDistributionCanonicalUrlFilename(url: URL, filename: string): void {
  const rawFilename = url.pathname.split('/').filter(Boolean).at(-1) || '';
  if (rawFilename !== filename) throw invalidDistribution('install_source.filename');
}

function distributionArtifactPathSegments(url: URL): string[] {
  try {
    return url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw invalidDistribution('install_source.url');
  }
}

function validateDistributionArtifactReleasePath(url: URL, pathSegments: readonly string[]): void {
  const releaseDirectory = url.hostname.toLowerCase() === 'github.com' ? 'download' : 'releases';
  if (
    pathSegments.length < 3 ||
    pathSegments.at(-3) !== releaseDirectory ||
    pathSegments.at(-2) !== '1.4.7'
  ) {
    throw invalidDistribution('install_source.release');
  }
}

function validateDistributionArtifactIdentity(
  pathIdentity: string,
  filename: string,
  platform: RustDeskClientDistributionPlatform,
  architecture: RustDeskClientDistributionArchitecture
): void {
  const lower = filename.toLowerCase();
  const lowerIdentity = pathIdentity.toLowerCase();
  if (!distributionArtifactToken(lower, '1.4.7')) throw invalidDistribution('install_source.version');
  for (const version of distributionSemanticVersionTokens(lowerIdentity)) {
    if (version !== '1.4.7') throw invalidDistribution('install_source.version');
  }
  for (const candidate of ['windows', 'macos', 'linux'] as const) {
    if (candidate !== platform && distributionArtifactToken(lowerIdentity, candidate)) {
      throw invalidDistribution('install_source.platform');
    }
  }
  for (const candidate of ['x86_64', 'aarch64'] as const) {
    if (
      candidate !== architecture &&
      distributionArtifactArchitectureTokens[candidate].some((token) => distributionArtifactToken(lowerIdentity, token))
    ) {
      throw invalidDistribution('install_source.architecture');
    }
  }
  const extensions = distributionArtifactExtensions[`${platform}/${architecture}`] || [];
  const extension = extensions.find((candidate) => lower.endsWith(candidate));
  if (!extension) {
    throw invalidDistribution('install_source.extension');
  }
  if (filename !== `rustdesk-1.4.7-${architecture}${extension}`) {
    throw invalidDistribution('install_source.filename');
  }
}

function distributionSemanticVersionTokens(value: string): string[] {
  return Array.from(
    value.matchAll(/(?:^|[^0-9])(\d+\.\d+\.\d+)(?=$|[^0-9])/g),
    (match) => match[1]
  );
}

function distributionArtifactToken(filename: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(filename);
}

function isSupportedDistributionTarget(
  platform: RustDeskClientDistributionPlatform,
  architecture: RustDeskClientDistributionArchitecture
): boolean {
  return architecture === 'x86_64' || platform !== 'windows';
}

function distributionRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDistribution(field);
  return value as Record<string, unknown>;
}

function distributionEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalidDistribution(field);
  return value as T;
}

function distributionRequiredString(value: unknown, field: string): string {
  const result = distributionString(value, field).trim();
  if (!result) throw invalidDistribution(field);
  return result;
}

function distributionString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidDistribution(field);
  return value;
}

function distributionTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidDistribution(field);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalidDistribution(field);
  return value;
}

function validateDistributionApiServer(value: string): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidDistribution('manual_fields.api_server');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidDistribution('manual_fields.api_server');
  }
}

function invalidDistribution(field: string): Error {
  return new Error(`invalid RustDesk client distribution profile: ${field}`);
}

const evidenceOperations: readonly RustDeskObservedOperation[] = [
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard',
  'multi_display',
  'session_disconnect'
];
const evidenceObservers: readonly RustDeskOperationObserver[] = [
  'native_client',
  'edge_adapter',
  'operator',
  'qa'
];
const evidenceDirections: readonly RustDeskOperationDirection[] = [
  'upload',
  'download',
  'agent_to_device',
  'device_to_agent'
];
const terminalPlatforms: readonly RustDeskTerminalPlatform[] = ['windows', 'macos', 'linux'];
const terminalArchitectures: readonly RustDeskTerminalArchitecture[] = ['x86_64', 'aarch64', 'x86', 'armv7'];
const clientVersionSources: readonly RustDeskClientVersion['source'][] = [
  'terminal_heartbeat',
  'operator_report',
  'unknown'
];
const runtimeCapabilitySources: readonly RustDeskRuntimeCapabilities['source'][] = [
  'terminal_heartbeat',
  'native_observer',
  'operator_report',
  'unknown'
];
const capabilityAvailability = ['unknown', 'available', 'unavailable'] as const;
const remoteConsentScopes: readonly RemoteConsentScope[] = [
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
];

export function projectRustDeskOperationEvidence(value: unknown): RustDeskOperationEvidence {
  const evidence = evidenceRecord(value);
  const operationId = evidenceString(evidence.operation_id, 'operation_id');
  const operation = evidenceEnum(evidence.operation, evidenceOperations, 'operation');
  const metadata = projectEvidenceMetadata(evidence.metadata);
  const references = projectEvidenceReferences(evidence.evidence_refs);

  if (evidence.status === 'not_observed') {
    if (evidence.observer !== 'none' || evidence.observed_at !== null || references.length !== 0) {
      throw invalidEvidence('not_observed provenance');
    }
    return {
      operation_id: operationId,
      operation,
      status: 'not_observed',
      observer: 'none',
      observed_at: null,
      evidence_refs: [],
      metadata
    };
  }

  if (evidence.status !== 'observed_succeeded' && evidence.status !== 'observed_failed') {
    throw invalidEvidence('status');
  }
  const observer = evidenceEnum(evidence.observer, evidenceObservers, 'observer');
  const observedAt = evidenceString(evidence.observed_at, 'observed_at');
  if (Number.isNaN(Date.parse(observedAt)) || references.length === 0) {
    throw invalidEvidence('observed provenance');
  }

  return {
    operation_id: operationId,
    operation,
    status: evidence.status,
    observer,
    observed_at: observedAt,
    evidence_refs: references as [RustDeskOperationEvidenceReference, ...RustDeskOperationEvidenceReference[]],
    metadata
  };
}

export function projectRustDeskTerminalProfile(value: unknown): RustDeskTerminalProfile {
  const profile = terminalRecord(value, 'terminal_profile');
  const observed = profile.observed;
  if (!Array.isArray(observed)) throw invalidTerminalProfile('observed');
  return {
    device_id: terminalIdentifier(profile.device_id, 'device_id'),
    rustdesk_id: terminalIdentifier(profile.rustdesk_id, 'rustdesk_id'),
    platform: terminalEnum(profile.platform, terminalPlatforms, 'platform'),
    architecture: terminalEnum(profile.architecture, terminalArchitectures, 'architecture'),
    client_version: projectTerminalClientVersion(profile.client_version),
    configured: projectTerminalConfiguredFields(profile.configured),
    available: projectTerminalRuntimeCapabilities(profile.available),
    granted: projectTerminalPermissionScopes(profile.granted),
    observed: observed.map(projectRustDeskOperationEvidence),
    updated_at: terminalTimestamp(profile.updated_at, 'updated_at')
  };
}

function projectTerminalClientVersion(value: unknown): RustDeskClientVersion {
  const clientVersion = terminalRecord(value, 'client_version');
  return {
    product: terminalEnum(clientVersion.product, ['rustdesk'] as const, 'client_version.product'),
    version: terminalIdentifier(clientVersion.version, 'client_version.version'),
    channel: terminalEnum(clientVersion.channel, ['stable'] as const, 'client_version.channel'),
    source: terminalEnum(clientVersion.source, clientVersionSources, 'client_version.source'),
    reported_at: terminalNullableTimestamp(clientVersion.reported_at, 'client_version.reported_at')
  };
}

function projectTerminalConfiguredFields(value: unknown): RustDeskConfiguredFields {
  const configured = terminalRecord(value, 'configured');
  return {
    id_server_configured: terminalBoolean(configured.id_server_configured, 'configured.id_server_configured'),
    relay_server_configured: terminalBoolean(configured.relay_server_configured, 'configured.relay_server_configured'),
    api_server_configured: terminalBoolean(configured.api_server_configured, 'configured.api_server_configured'),
    public_key_configured: terminalBoolean(configured.public_key_configured, 'configured.public_key_configured'),
    server_key_fingerprint: terminalText(configured.server_key_fingerprint, 'configured.server_key_fingerprint')
  };
}

function projectTerminalRuntimeCapabilities(value: unknown): RustDeskRuntimeCapabilities {
  const available = terminalRecord(value, 'available');
  return {
    source: terminalEnum(available.source, runtimeCapabilitySources, 'available.source'),
    reported_at: terminalNullableTimestamp(available.reported_at, 'available.reported_at'),
    view_screen: terminalEnum(available.view_screen, capabilityAvailability, 'available.view_screen'),
    control_mouse_keyboard: terminalEnum(
      available.control_mouse_keyboard,
      capabilityAvailability,
      'available.control_mouse_keyboard'
    ),
    multi_display: terminalEnum(available.multi_display, capabilityAvailability, 'available.multi_display'),
    transfer_file: terminalEnum(available.transfer_file, capabilityAvailability, 'available.transfer_file'),
    clipboard: terminalEnum(available.clipboard, capabilityAvailability, 'available.clipboard'),
    record_screen: terminalEnum(available.record_screen, capabilityAvailability, 'available.record_screen'),
    session_disconnect: terminalEnum(
      available.session_disconnect,
      capabilityAvailability,
      'available.session_disconnect'
    )
  };
}

function projectTerminalPermissionScopes(value: unknown): RustDeskPermissionScopes {
  const granted = terminalRecord(value, 'granted');
  const requested = terminalScopeArray(granted.requested, 'granted.requested');
  const consented = terminalScopeArray(granted.consented, 'granted.consented');
  const grantedScopes = terminalScopeArray(granted.granted, 'granted.granted');
  const requestedSet = new Set(requested);
  const consentedSet = new Set(consented);
  if (consented.some((scope) => !requestedSet.has(scope))) throw invalidTerminalProfile('granted.consented');
  if (grantedScopes.some((scope) => !consentedSet.has(scope))) throw invalidTerminalProfile('granted.granted');
  return { requested, consented, granted: grantedScopes };
}

export function projectRustDeskDevice(value: unknown): RustDeskDevice {
  const device = evidenceRecord(value, 'device');
  if (device.terminal_profile === undefined) return device as unknown as RustDeskDevice;
  const terminalProfile = projectRustDeskTerminalProfile(device.terminal_profile);
  if (
    terminalProfile.device_id !== terminalIdentifier(device.id, 'device binding') ||
    terminalProfile.rustdesk_id !== terminalIdentifier(device.rustdesk_id, 'device binding')
  ) {
    throw invalidTerminalProfile('device binding');
  }
  return {
    ...device,
    terminal_profile: terminalProfile
  } as unknown as RustDeskDevice;
}

function projectEvidenceContainer<T extends RemoteToolSession | RustDeskGatewayLaunchPlan>(
  value: T,
  label: string
): T {
  const record = evidenceRecord(value, label);
  if (record.operation_evidence === undefined && record.disconnect_state === undefined) return value;
  const projected = { ...record };
  if (record.operation_evidence !== undefined) {
    if (!Array.isArray(record.operation_evidence)) throw invalidEvidence('operation_evidence');
    projected.operation_evidence = record.operation_evidence.map(projectRustDeskOperationEvidence);
  }
  if (record.disconnect_state !== undefined) {
    projected.disconnect_state = projectRustDeskDisconnectState(record.disconnect_state);
  }
  return projected as unknown as T;
}

function projectRustDeskDisconnectState(value: unknown): RustDeskDisconnectState {
  const state = disconnectRecord(value);
  const command = state.command;
  const concreteStatuses = ['pending', 'claimed', 'succeeded', 'failed'] as const;

  if (state.required !== true) throw invalidDisconnect('required');
  if (state.status === 'unavailable') {
    if (command !== null) throw invalidDisconnect('unavailable command');
  } else if (concreteStatuses.includes(state.status as (typeof concreteStatuses)[number])) {
    const commandRecord = disconnectRecord(command, 'command');
    if (commandRecord.status !== state.status) throw invalidDisconnect('command status');
  } else {
    throw invalidDisconnect('status');
  }

  const observationStatus = state.observation_status;
  if (observationStatus === undefined || observationStatus === 'not_observed') {
    if (state.observed === undefined) return value as RustDeskDisconnectState;
    const observed = projectRustDeskOperationEvidence(state.observed);
    if (observed.operation !== 'session_disconnect' || observed.status !== 'not_observed') {
      throw invalidDisconnect('not_observed evidence');
    }
    return { ...state, observed } as RustDeskDisconnectState;
  }
  if (observationStatus !== 'observed_disconnected' && observationStatus !== 'observed_connected') {
    throw invalidDisconnect('observation_status');
  }
  const observed = projectRustDeskOperationEvidence(state.observed);
  if (observed.operation !== 'session_disconnect' || observed.status === 'not_observed') {
    throw invalidDisconnect('observed evidence');
  }
  if (observationStatus === 'observed_disconnected' && observed.status !== 'observed_succeeded') {
    throw invalidDisconnect('observed_disconnected evidence');
  }
  if (observationStatus === 'observed_connected' && observed.status !== 'observed_failed') {
    throw invalidDisconnect('observed_connected evidence');
  }
  return { ...state, observed } as RustDeskDisconnectState;
}

function projectEvidenceMetadata(value: unknown): RustDeskOperationEvidenceMetadata {
  const source = evidenceRecord(value, 'metadata');
  const result: RustDeskOperationEvidenceMetadata = {};
  for (const key of [
    'external_id',
    'provider_operation_id',
    'provider_session_id',
    'target_id',
    'display_id',
    'reason',
    'status_detail'
  ] as const) {
    if (source[key] !== undefined) result[key] = evidenceString(source[key], `metadata.${key}`);
  }
  if (source.direction !== undefined) {
    result.direction = evidenceEnum(source.direction, evidenceDirections, 'metadata.direction');
  }
  for (const key of ['byte_count', 'duration_ms'] as const) {
    if (source[key] !== undefined) result[key] = evidenceNumber(source[key], `metadata.${key}`);
  }
  if (source.checksum_sha256 !== undefined) {
    result.checksum_sha256 = evidenceSha256(source.checksum_sha256, 'metadata.checksum_sha256');
  }
  return result;
}

function projectEvidenceReferences(value: unknown): RustDeskOperationEvidenceReference[] {
  if (!Array.isArray(value)) throw invalidEvidence('evidence_refs');
  return value.map((entry) => {
    const reference = evidenceRecord(entry, 'evidence_ref');
    return {
      type: evidenceString(reference.type, 'evidence_ref.type'),
      ref: evidenceString(reference.ref, 'evidence_ref.ref'),
      sha256: evidenceSha256(reference.sha256, 'evidence_ref.sha256')
    };
  });
}

function evidenceRecord(value: unknown, field = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidEvidence(field);
  return value as Record<string, unknown>;
}

function disconnectRecord(value: unknown, field = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidDisconnect(field);
  return value as Record<string, unknown>;
}

function terminalRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidTerminalProfile(field);
  return value as Record<string, unknown>;
}

function terminalIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidTerminalProfile(field);
  return value.trim();
}

function terminalText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidTerminalProfile(field);
  return value;
}

function terminalBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidTerminalProfile(field);
  return value;
}

function terminalEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalidTerminalProfile(field);
  return value as T;
}

function terminalScopeArray(value: unknown, field: string): RemoteConsentScope[] {
  if (!Array.isArray(value)) throw invalidTerminalProfile(field);
  return value.map((scope) => terminalEnum(scope, remoteConsentScopes, field));
}

function terminalNullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return terminalTimestamp(value, field);
}

function terminalTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidTerminalProfile(field);
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
  );
  if (!match || Number.isNaN(Date.parse(value))) throw invalidTerminalProfile(field);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    throw invalidTerminalProfile(field);
  }
  return value;
}

function evidenceString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidEvidence(field);
  return value;
}

function evidenceNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalidEvidence(field);
  return value;
}

function evidenceSha256(value: unknown, field: string): string {
  const checksum = evidenceString(value, field);
  if (!/^[a-f\d]{64}$/i.test(checksum)) throw invalidEvidence(field);
  return checksum;
}

function evidenceEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalidEvidence(field);
  return value as T;
}

function invalidEvidence(field: string): Error {
  return new Error(`invalid RustDesk operation evidence: ${field}`);
}

function invalidDisconnect(field: string): Error {
  return new Error(`invalid RustDesk disconnect state: ${field}`);
}

function invalidTerminalProfile(field: string): Error {
  return new Error(`invalid RustDesk terminal profile: ${field}`);
}

function validateBaseUrl(value: string): URL {
  const raw = requiredString(value, 'baseUrl is required');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use http(s)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('baseUrl must not include credentials, query, or fragment');
  }
  if (parsed.pathname !== '/') throw new Error('baseUrl must not include a path');
  return parsed;
}

function validTimeout(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isInteger(value) || value < 100 || value > 300_000) {
    throw new Error('timeoutMs must be an integer between 100 and 300000');
  }
  return value;
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorDetail(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    return String(record.error || record.message || JSON.stringify(record));
  }
  return String(payload || 'empty response');
}
