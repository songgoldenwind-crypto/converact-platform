import type { RemoteGatewayAuditEvent } from '../collaboration/remote-gateway-client.js';
import type { RustDeskClientConfig } from '../collaboration/rustdesk-client-config.js';
import type { RustDeskDevice } from '../collaboration/rustdesk-device-store.js';
import type {
  RustDeskDeviceCommand,
  RustDeskDeviceCommandStatus
} from '../collaboration/rustdesk-device-command-store.js';
import type { RustDeskGatewayLaunchPlan } from '../collaboration/rustdesk-launch-plan.js';
import type { RemoteConsentScope, RemoteToolSession } from '../collaboration/types.js';

export type IveKitRustDeskFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface IveKitRustDeskHttpClientInput {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  userId?: string;
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
  getGatewayDisconnectState(externalId: string): Promise<IveKitRustDeskGatewayDisconnectState>;
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
  const apiKey = requiredString(input.apiKey, 'apiKey is required');
  const tenantId = requiredString(input.tenantId, 'tenantId is required');
  const userId = String(input.userId || '').trim();
  const fetchImpl = input.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is required');

  const request = async <T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> => {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      'x-api-key': apiKey,
      'x-tenant-id': tenantId
    };
    if (userId) headers['x-user-id'] = userId;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(url.toString(), init);
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
    registerDevice(device) {
      return request<RustDeskDevice>('POST', '/api/ivekit/rustdesk/devices', device);
    },
    getDevice(deviceId) {
      return request<RustDeskDevice>('GET', `/api/ivekit/rustdesk/devices/${encodeURIComponent(requiredString(deviceId, 'deviceId is required'))}`);
    },
    listDevicesByBusinessRef(input) {
      const businessRef = input.business_ref;
      return request<RustDeskDevice[]>('GET', '/api/ivekit/rustdesk/devices/by-ref', undefined, {
        business_ref_type: requiredString(businessRef?.type, 'business_ref.type is required'),
        business_ref_id: requiredString(businessRef?.id, 'business_ref.id is required'),
        limit: input.limit === undefined ? '' : String(input.limit)
      });
    },
    heartbeatDevice(deviceId, input) {
      return request<RustDeskDevice>(
        'POST',
        `/api/ivekit/rustdesk/devices/${encodeURIComponent(requiredString(deviceId, 'deviceId is required'))}/heartbeat`,
        input
      );
    },
    deactivateDevice(deviceId) {
      return request<RustDeskDevice>(
        'POST',
        `/api/ivekit/rustdesk/devices/${encodeURIComponent(requiredString(deviceId, 'deviceId is required'))}/deactivate`,
        {}
      );
    },
    startGatewaySession(input) {
      return request<RemoteToolSession>('POST', '/api/ivekit/rustdesk/gateway-sessions', input);
    },
    getGatewayLaunchPlan(externalId) {
      return request<RustDeskGatewayLaunchPlan>(
        'GET',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/launch`
      );
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
    getGatewayDisconnectState(externalId) {
      return request<IveKitRustDeskGatewayDisconnectState>(
        'GET',
        `/api/ivekit/rustdesk/gateway-sessions/${encodeURIComponent(requiredString(externalId, 'externalId is required'))}/disconnect`
      );
    }
  };
}

function validateBaseUrl(value: string): URL {
  const raw = requiredString(value, 'baseUrl is required');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use http(s)');
  }
  return parsed;
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
