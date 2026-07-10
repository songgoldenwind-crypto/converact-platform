import type { RemoteConsentScope } from './types.js';
import type { RustDeskDisconnectReason } from './rustdesk-device-command-store.js';
import type { RustDeskPhysicalDisconnectSummary } from './rustdesk-physical-disconnect.js';
import type { RemoteGatewayProvider, RemoteGatewaySessionInput, RemoteGatewayTarget } from './remote-gateway-adapter.js';
import { rustDeskGatewayEventValidationError } from './rustdesk-gateway-event.js';

export interface RemoteGatewayCreateInput {
  target: RemoteGatewayTarget;
  permissions: readonly RemoteConsentScope[];
  actor_identity: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteGatewayEndInput {
  external_id: string;
  actor_identity: string;
  reason?: RustDeskDisconnectReason;
}

export interface RemoteGatewayEndResult {
  physical_disconnect?: RustDeskPhysicalDisconnectSummary;
}

export interface RemoteGatewayAuditInput {
  external_id: string;
  since?: string;
}

export interface RemoteGatewayAuditAppendInput {
  external_id: string;
  event_type: string;
  actor_identity: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteGatewayAuditEvent {
  external_id: string;
  event_type: string;
  actor_identity: string;
  target: string;
  metadata: Record<string, unknown>;
  occurred_at: string;
}

export interface RemoteGatewayClient {
  readonly provider: RemoteGatewayProvider;
  createSession(input: RemoteGatewayCreateInput): Promise<RemoteGatewaySessionInput>;
  endSession(input: RemoteGatewayEndInput): Promise<RemoteGatewayEndResult | void>;
  listAuditEvents(input: RemoteGatewayAuditInput): Promise<RemoteGatewayAuditEvent[]>;
}

export interface InMemoryRemoteGatewayClientInput {
  provider: RemoteGatewayProvider;
  base_url: string;
}

export interface RemoteGatewayHttpClientInput {
  base_url: string;
  api_token: string;
  create_path?: string;
  session_path?: string;
  audit_path?: string;
  fetch?: typeof fetch;
}

export interface MeshCentralGatewayClientInput extends RemoteGatewayHttpClientInput {}

export interface GuacamoleGatewayClientInput extends RemoteGatewayHttpClientInput {}

export interface RustDeskGatewayClientInput extends RemoteGatewayHttpClientInput {}

export interface InMemoryRemoteGatewaySession {
  external_id: string;
  status: 'active' | 'ended';
  descriptor: RemoteGatewaySessionInput;
}

export class InMemoryRemoteGatewayClient implements RemoteGatewayClient {
  readonly provider: RemoteGatewayProvider;
  private readonly baseUrl: string;
  private readonly sessions = new Map<string, InMemoryRemoteGatewaySession>();
  private readonly events = new Map<string, RemoteGatewayAuditEvent[]>();
  private sequence = 0;

  constructor(input: InMemoryRemoteGatewayClientInput) {
    this.provider = input.provider;
    this.baseUrl = String(input.base_url || '').replace(/\/+$/, '');
  }

  async createSession(input: RemoteGatewayCreateInput): Promise<RemoteGatewaySessionInput> {
    const target = remoteGatewayTarget(input.target);
    const permissions = remoteGatewayPermissions(input.permissions);
    const actorIdentity = remoteGatewayRequiredString(input.actor_identity, 'actor_identity is required');
    const externalId = `${this.provider}_${++this.sequence}`;
    const descriptor: RemoteGatewaySessionInput = {
      provider: this.provider,
      external_id: externalId,
      launch_url: `${this.baseUrl}/remote/${this.provider}/${target.type}/${target.id}`,
      target,
      permissions,
      metadata: input.metadata
    };
    this.sessions.set(externalId, { external_id: externalId, status: 'active', descriptor });
    await this.appendAuditEvent({
      external_id: externalId,
      event_type: 'remote.gateway_session.created',
      actor_identity: actorIdentity,
      metadata: { target_type: target.type, target_id: target.id }
    });
    return descriptor;
  }

  async endSession(input: RemoteGatewayEndInput): Promise<void> {
    const externalId = remoteGatewayRequiredString(input.external_id, 'external_id is required');
    const actorIdentity = remoteGatewayRequiredString(input.actor_identity, 'actor_identity is required');
    const session = this.sessions.get(externalId);
    if (session) {
      session.status = 'ended';
    }
    await this.appendAuditEvent({
      external_id: externalId,
      event_type: 'remote.gateway_session.ended',
      actor_identity: actorIdentity
    });
  }

  async listAuditEvents(input: RemoteGatewayAuditInput): Promise<RemoteGatewayAuditEvent[]> {
    const externalId = remoteGatewayRequiredString(input.external_id, 'external_id is required');
    const since = remoteGatewayOptionalIsoTimestamp(input.since);
    const events = [...(this.events.get(externalId) || [])];
    if (!since) return events;
    const sinceMs = new Date(since).getTime();
    return events.filter((event) => new Date(event.occurred_at).getTime() > sinceMs);
  }

  async appendAuditEvent(input: RemoteGatewayAuditAppendInput): Promise<RemoteGatewayAuditEvent> {
    const event: RemoteGatewayAuditEvent = {
      external_id: input.external_id,
      event_type: input.event_type,
      actor_identity: input.actor_identity,
      target: input.external_id,
      metadata: input.metadata || {},
      occurred_at: new Date(Date.now() + this.nextTick()).toISOString()
    };
    const events = this.events.get(input.external_id) || [];
    events.push(event);
    this.events.set(input.external_id, events);
    return event;
  }

  getSession(externalId: string): InMemoryRemoteGatewaySession | null {
    return this.sessions.get(externalId) || null;
  }

  private nextTick(): number {
    this.sequence += 1;
    return this.sequence;
  }
}

export function createInMemoryRemoteGatewayClient(
  input: InMemoryRemoteGatewayClientInput
): InMemoryRemoteGatewayClient {
  return new InMemoryRemoteGatewayClient(input);
}

interface HttpRemoteGatewayClientConfig {
  provider: RemoteGatewayProvider;
  error_label: string;
  input: RemoteGatewayHttpClientInput;
  default_create_path: string;
  default_session_path: string;
  default_audit_path: string;
}

class HttpRemoteGatewayClient implements RemoteGatewayClient {
  readonly provider: RemoteGatewayProvider;
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly createPath: string;
  private readonly sessionPath: string;
  private readonly auditPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly errorLabel: string;

  constructor(config: HttpRemoteGatewayClientConfig) {
    this.provider = config.provider;
    this.errorLabel = config.error_label;
    this.baseUrl = remoteGatewayHttpBaseUrl(config.input.base_url);
    this.apiToken = remoteGatewayRequiredString(config.input.api_token, 'api_token is required');
    this.createPath = config.input.create_path || config.default_create_path;
    this.sessionPath = config.input.session_path || config.default_session_path;
    this.auditPath = config.input.audit_path || config.default_audit_path;
    this.fetchImpl = config.input.fetch || globalThis.fetch;
  }

  async createSession(input: RemoteGatewayCreateInput): Promise<RemoteGatewaySessionInput> {
    const target = remoteGatewayTarget(input.target);
    const permissions = remoteGatewayPermissions(input.permissions);
    const actorIdentity = remoteGatewayRequiredString(input.actor_identity, 'actor_identity is required');
    const payload = await this.request<Record<string, unknown>>(this.createPath, {
      method: 'POST',
      body: JSON.stringify({
        target,
        permissions,
        actor_identity: actorIdentity,
        metadata: input.metadata || {}
      })
    });
    const externalId = String(payload.external_id || '');
    const launchUrl = String(payload.launch_url || '');
    if (!externalId) throw Object.assign(new Error(`${this.errorLabel} gateway response missing external_id`), { status: 502 });
    if (!launchUrl) throw Object.assign(new Error(`${this.errorLabel} gateway response missing launch_url`), { status: 502 });
    if (this.provider === 'rustdesk') {
      validateRustDeskLaunchUrl(externalId, launchUrl, this.errorLabel);
    }
    return {
      provider: this.provider,
      external_id: externalId,
      launch_url: launchUrl,
      target: (payload.target as RemoteGatewayTarget | undefined) || target,
      permissions: (payload.permissions as RemoteConsentScope[] | undefined) || permissions,
      metadata: {
        ...(input.metadata || {}),
        ...((payload.metadata as Record<string, unknown> | undefined) || {})
      }
    };
  }

  async endSession(input: RemoteGatewayEndInput): Promise<void> {
    const externalId = remoteGatewayRequiredString(input.external_id, 'external_id is required');
    const actorIdentity = remoteGatewayRequiredString(input.actor_identity, 'actor_identity is required');
    await this.request(this.pathFor(this.sessionPath, externalId), {
      method: 'DELETE',
      body: JSON.stringify({
        actor_identity: actorIdentity,
        ...(input.reason ? { reason: input.reason } : {})
      })
    });
  }

  async listAuditEvents(input: RemoteGatewayAuditInput): Promise<RemoteGatewayAuditEvent[]> {
    const externalId = remoteGatewayRequiredString(input.external_id, 'external_id is required');
    const since = remoteGatewayOptionalIsoTimestamp(input.since);
    const path = this.pathFor(this.auditPath, externalId);
    const url = since ? `${path}?since=${encodeURIComponent(since)}` : path;
    const payload = await this.request<Record<string, unknown>>(url, { method: 'GET' });
    if (!Array.isArray(payload.events)) {
      throw Object.assign(new Error(`${this.errorLabel} gateway audit response events must be an array`), {
        status: 502
      });
    }
    return payload.events.map((event) => this.decodeAuditEvent(externalId, event));
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        'content-type': 'application/json'
      }
    });
    if (!response.ok) {
      const detail = await responseErrorDetail(response);
      const message = `${this.errorLabel} gateway request failed: ${response.status}${detail ? ` ${detail}` : ''}`;
      throw Object.assign(new Error(message), {
        status: response.status
      });
    }
    if (response.status === 204) return undefined as T;
    return responseJson<T>(response, this.errorLabel);
  }

  private pathFor(template: string, externalId: string): string {
    return template.replace(':external_id', encodeURIComponent(externalId));
  }

  private decodeAuditEvent(externalId: string, raw: unknown): RemoteGatewayAuditEvent {
    const row = (raw || {}) as Record<string, unknown>;
    const eventType = String(row.event_type || '').trim();
    if (!eventType) {
      throw Object.assign(new Error(`${this.errorLabel} gateway audit event missing event_type`), {
        status: 502
      });
    }
    const occurredAt = String(row.occurred_at || '').trim();
    if (!occurredAt) {
      throw Object.assign(new Error(`${this.errorLabel} gateway audit event missing occurred_at`), {
        status: 502
      });
    }
    if (!Number.isFinite(Date.parse(occurredAt))) {
      throw Object.assign(new Error(`${this.errorLabel} gateway audit event invalid occurred_at`), {
        status: 502
      });
    }
    const rawExternalId = String(row.external_id || '').trim();
    if (rawExternalId && rawExternalId !== externalId) {
      throw Object.assign(new Error(`${this.errorLabel} gateway audit event external_id must match requested session`), {
        status: 502
      });
    }
    const actorIdentity = String(row.actor_identity || '').trim();
    if (!actorIdentity) {
      throw Object.assign(new Error(`${this.errorLabel} gateway audit event missing actor_identity`), {
        status: 502
      });
    }
    const metadata = row.metadata ?? {};
    if (!isRecord(metadata)) {
      throw Object.assign(new Error(`${this.errorLabel} gateway audit event metadata must be an object`), {
        status: 502
      });
    }
    if (this.provider === 'rustdesk') {
      const eventValidationError = rustDeskGatewayEventValidationError(eventType, metadata);
      if (eventValidationError) {
        throw Object.assign(new Error(`${this.errorLabel} gateway audit event invalid: ${eventValidationError}`), {
          status: 502
        });
      }
    }
    return {
      external_id: rawExternalId || externalId,
      event_type: eventType,
      actor_identity: actorIdentity,
      target: String(row.target || externalId),
      metadata,
      occurred_at: occurredAt
    };
  }
}

export class MeshCentralGatewayClient extends HttpRemoteGatewayClient {
  constructor(input: MeshCentralGatewayClientInput) {
    super({
      provider: 'meshcentral',
      error_label: 'MeshCentral',
      input,
      default_create_path: '/api/opc/meshcentral/sessions',
      default_session_path: '/api/opc/meshcentral/sessions/:external_id',
      default_audit_path: '/api/opc/meshcentral/sessions/:external_id/audit'
    });
  }
}

export class GuacamoleGatewayClient extends HttpRemoteGatewayClient {
  constructor(input: GuacamoleGatewayClientInput) {
    super({
      provider: 'guacamole',
      error_label: 'Guacamole',
      input,
      default_create_path: '/api/opc/guacamole/sessions',
      default_session_path: '/api/opc/guacamole/sessions/:external_id',
      default_audit_path: '/api/opc/guacamole/sessions/:external_id/audit'
    });
  }
}

export class RustDeskGatewayClient extends HttpRemoteGatewayClient {
  constructor(input: RustDeskGatewayClientInput) {
    super({
      provider: 'rustdesk',
      error_label: 'RustDesk',
      input,
      default_create_path: '/api/opc/rustdesk/sessions',
      default_session_path: '/api/opc/rustdesk/sessions/:external_id',
      default_audit_path: '/api/opc/rustdesk/sessions/:external_id/audit'
    });
  }
}

export function createMeshCentralGatewayClient(
  input: MeshCentralGatewayClientInput
): MeshCentralGatewayClient {
  return new MeshCentralGatewayClient(input);
}

export function createGuacamoleGatewayClient(
  input: GuacamoleGatewayClientInput
): GuacamoleGatewayClient {
  return new GuacamoleGatewayClient(input);
}

export function createRustDeskGatewayClient(
  input: RustDeskGatewayClientInput
): RustDeskGatewayClient {
  return new RustDeskGatewayClient(input);
}

async function responseErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    return errorDetailFromBody(text);
  } catch {
    return '';
  }
}

function errorDetailFromBody(text: string): string {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const detail = payload.error || payload.message || payload.detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  } catch {
    // Fall through to raw text for non-JSON upstream errors.
  }
  return text.slice(0, 500);
}

async function responseJson<T>(response: Response, errorLabel: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw Object.assign(new Error(`${errorLabel} gateway response invalid JSON`), {
      status: 502
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function remoteGatewayRequiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw Object.assign(new Error(message), { status: 400 });
  return normalized;
}

function remoteGatewayTarget(value: RemoteGatewayTarget): RemoteGatewayTarget {
  const target = value || { type: 'device', id: '' };
  return {
    type: String(target.type || 'device').trim() || 'device',
    id: remoteGatewayRequiredString(target.id, 'target id is required'),
    display_name: target.display_name ? String(target.display_name).trim() : undefined
  };
}

function remoteGatewayPermissions(value: readonly RemoteConsentScope[] | undefined): RemoteConsentScope[] {
  const permissions = Array.isArray(value)
    ? value.map((permission) => String(permission).trim()).filter(Boolean)
    : [];
  if (!permissions.length) throw Object.assign(new Error('permissions required'), { status: 400 });
  return permissions as RemoteConsentScope[];
}

function remoteGatewayHttpBaseUrl(value: unknown): string {
  const baseUrl = remoteGatewayRequiredString(value, 'base_url is required').replace(/\/+$/, '');
  let protocol = '';
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    throw Object.assign(new Error('base_url must be http(s)'), { status: 400 });
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw Object.assign(new Error('base_url must be http(s)'), { status: 400 });
  }
  return baseUrl;
}

function remoteGatewayOptionalIsoTimestamp(value: string | undefined): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  if (!Number.isFinite(Date.parse(normalized))) {
    throw Object.assign(new Error('since must be an ISO timestamp'), { status: 400 });
  }
  return normalized;
}

function validateRustDeskLaunchUrl(externalId: string, launchUrl: string, errorLabel: string): void {
  let parsed: URL;
  try {
    parsed = new URL(launchUrl);
  } catch {
    throw Object.assign(new Error(`${errorLabel} gateway launch_url must be a valid URL`), { status: 502 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error(`${errorLabel} gateway launch_url must be http(s)`), {
      external_id: externalId,
      status: 502
    });
  }
  if (parsed.pathname !== '/remote/rustdesk/launch') {
    throw Object.assign(new Error(`${errorLabel} gateway launch_url path must be /remote/rustdesk/launch`), {
      external_id: externalId,
      status: 502
    });
  }
  const sessionId = String(parsed.searchParams.get('session_id') || '').trim();
  if (sessionId !== externalId) {
    throw Object.assign(new Error(`${errorLabel} gateway launch_url session_id must match external_id`), {
      external_id: externalId,
      status: 502
    });
  }
  const token = String(parsed.searchParams.get('token') || '').trim();
  if (!token) {
    throw Object.assign(new Error(`${errorLabel} gateway launch_url token is required`), {
      external_id: externalId,
      status: 502
    });
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    throw Object.assign(new Error(`${errorLabel} gateway launch_url token must be a 64 character hex HMAC`), {
      external_id: externalId,
      status: 502
    });
  }
  const expiresAt = String(parsed.searchParams.get('expires_at') || '').trim();
  if (!expiresAt) {
    throw Object.assign(new Error(`${errorLabel} gateway launch_url expires_at is required`), {
      external_id: externalId,
      status: 502
    });
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw Object.assign(new Error(`${errorLabel} gateway launch_url expires_at must be a future ISO timestamp`), {
      external_id: externalId,
      status: 502
    });
  }
}
