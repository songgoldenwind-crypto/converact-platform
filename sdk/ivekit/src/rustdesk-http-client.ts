import type {
  RemoteConsentScope,
  RemoteGatewayAuditEvent,
  RemoteToolSession,
  RustDeskClientConfig,
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
  const profile = evidenceRecord(value, 'terminal_profile');
  if (!Array.isArray(profile.observed)) throw invalidEvidence('terminal_profile.observed');
  return {
    ...profile,
    observed: profile.observed.map(projectRustDeskOperationEvidence)
  } as unknown as RustDeskTerminalProfile;
}

export function projectRustDeskDevice(value: unknown): RustDeskDevice {
  const device = evidenceRecord(value, 'device');
  if (device.terminal_profile === undefined) return device as unknown as RustDeskDevice;
  return {
    ...device,
    terminal_profile: projectRustDeskTerminalProfile(device.terminal_profile)
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
