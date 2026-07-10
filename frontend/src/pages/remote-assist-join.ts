export interface RemoteAssistVerifyInput {
  tenantId: string;
  remoteSessionId: string;
  token: string;
}

export interface RemoteAssistEventInput extends RemoteAssistVerifyInput {
  eventType: string;
  payload?: Record<string, unknown>;
}

export interface RemoteAssistConsentInput extends RemoteAssistVerifyInput {
  scopes?: string[];
  expiresAt?: string;
}

export interface RemoteAssistRecordingStartInput extends RemoteAssistVerifyInput {
  format?: 'mp4' | 'webm' | 'wav' | 'ogg';
}

export interface RemoteAssistRecordingStopInput extends RemoteAssistVerifyInput {
  egressId: string;
}

export interface RemoteAssistVerifiedSession {
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  role: 'customer' | 'agent' | 'engineer';
  expires_at: string;
}

export interface RemoteAssistEvent {
  remote_session_id: string;
  actor_identity: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RemoteAssistConsentEvent {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  event_type: 'requested' | 'granted' | 'denied' | 'revoked' | 'expired';
  scopes: string[];
  expires_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface RemoteAssistEvidenceSummary {
  id: string;
  kind: string;
  storage_url?: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteAssistRecordingResult {
  id: string;
  tenant_id: string;
  format: string;
  storage_url: string;
  has_video: number;
  egress_id: string;
  evidence_record_id?: string;
  evidence_record?: RemoteAssistEvidenceSummary | null;
}

export interface RemoteAssistLiveKitToken {
  token: string;
  livekit_url?: string;
  url?: string;
  room_name: string;
}

export interface RemoteAssistMediaJoinPlan {
  mode: string;
  channel?: string;
  token: RemoteAssistLiveKitToken;
}

export interface RemoteAssistVerifyHttpResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface RemoteAssistVerifyFetchResult {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface RemoteAssistFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type RemoteAssistVerifyFetcher = (
  path: string,
  init?: RemoteAssistFetchInit
) => Promise<RemoteAssistVerifyFetchResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unwrapDataEnvelope(body: unknown): unknown {
  if (isRecord(body) && 'data' in body) return body.data;
  return body;
}

function errorMessageFromBody(body: unknown, status: number): string {
  if (isRecord(body)) {
    const error = body.error;
    if (typeof error === 'string' && error) return error;
    if (isRecord(error) && typeof error.message === 'string' && error.message) {
      return error.message;
    }
  }
  return `Remote Assist verify failed: ${status}`;
}

export function buildRemoteAssistVerifyPath(input: RemoteAssistVerifyInput): string {
  const params = new URLSearchParams({
    tenant_id: input.tenantId,
    token: input.token
  });
  return `/api/collaboration/remote-assistance/${encodeURIComponent(input.remoteSessionId)}/web-assist/verify?${params.toString()}`;
}

export function buildRemoteAssistEventPath(input: RemoteAssistEventInput): string {
  const params = new URLSearchParams({
    tenant_id: input.tenantId,
    token: input.token
  });
  return `/api/collaboration/remote-assistance/${encodeURIComponent(input.remoteSessionId)}/web-assist/events?${params.toString()}`;
}

export function buildRemoteAssistConsentGrantPath(input: RemoteAssistConsentInput): string {
  const params = new URLSearchParams({
    tenant_id: input.tenantId,
    token: input.token
  });
  return `/api/collaboration/remote-assistance/${encodeURIComponent(input.remoteSessionId)}/web-assist/consent/grant?${params.toString()}`;
}

export function buildRemoteAssistConsentRevokePath(input: RemoteAssistConsentInput): string {
  const params = new URLSearchParams({
    tenant_id: input.tenantId,
    token: input.token
  });
  return `/api/collaboration/remote-assistance/${encodeURIComponent(input.remoteSessionId)}/web-assist/consent/revoke?${params.toString()}`;
}

export function buildRemoteAssistRecordingStartPath(input: RemoteAssistVerifyInput): string {
  const params = new URLSearchParams({
    tenant_id: input.tenantId,
    token: input.token
  });
  return `/api/collaboration/remote-assistance/${encodeURIComponent(input.remoteSessionId)}/web-assist/recordings/start?${params.toString()}`;
}

export function buildRemoteAssistRecordingStopPath(input: RemoteAssistRecordingStopInput): string {
  const params = new URLSearchParams({
    tenant_id: input.tenantId,
    token: input.token
  });
  return `/api/collaboration/remote-assistance/${encodeURIComponent(input.remoteSessionId)}/web-assist/recordings/${encodeURIComponent(input.egressId)}/stop?${params.toString()}`;
}

export function buildRemoteAssistMediaJoinPath(input: RemoteAssistVerifyInput): string {
  const params = new URLSearchParams({
    tenant_id: input.tenantId,
    token: input.token
  });
  return `/api/collaboration/remote-assistance/${encodeURIComponent(input.remoteSessionId)}/web-assist/media/join?${params.toString()}`;
}

export function readRemoteAssistJoinVerification(
  result: RemoteAssistVerifyHttpResult
): RemoteAssistVerifiedSession {
  if (!result.ok) {
    throw new Error(errorMessageFromBody(result.body, result.status));
  }

  const payload = unwrapDataEnvelope(result.body);
  if (!isRecord(payload)) {
    throw new Error('invalid remote assist verify response');
  }
  const role = payload.role;
  if (
    typeof payload.tenant_id !== 'string' ||
    typeof payload.remote_session_id !== 'string' ||
    typeof payload.actor_identity !== 'string' ||
    (role !== 'customer' && role !== 'agent' && role !== 'engineer') ||
    typeof payload.expires_at !== 'string'
  ) {
    throw new Error('invalid remote assist verify response');
  }
  return payload as unknown as RemoteAssistVerifiedSession;
}

export function readRemoteAssistEventResult(result: RemoteAssistVerifyHttpResult): RemoteAssistEvent {
  if (!result.ok) {
    throw new Error(errorMessageFromBody(result.body, result.status));
  }

  const payload = unwrapDataEnvelope(result.body);
  if (!isRecord(payload)) {
    throw new Error('invalid remote assist event response');
  }
  if (
    typeof payload.remote_session_id !== 'string' ||
    typeof payload.actor_identity !== 'string' ||
    typeof payload.event_type !== 'string' ||
    !isRecord(payload.payload) ||
    typeof payload.created_at !== 'string'
  ) {
    throw new Error('invalid remote assist event response');
  }
  return payload as unknown as RemoteAssistEvent;
}

export function readRemoteAssistConsentEventResult(result: RemoteAssistVerifyHttpResult): RemoteAssistConsentEvent {
  if (!result.ok) {
    throw new Error(errorMessageFromBody(result.body, result.status));
  }

  const payload = unwrapDataEnvelope(result.body);
  if (!isRecord(payload)) {
    throw new Error('invalid remote assist consent response');
  }
  const eventType = payload.event_type;
  if (
    typeof payload.id !== 'string' ||
    typeof payload.tenant_id !== 'string' ||
    typeof payload.remote_session_id !== 'string' ||
    typeof payload.actor_identity !== 'string' ||
    (eventType !== 'requested' &&
      eventType !== 'granted' &&
      eventType !== 'denied' &&
      eventType !== 'revoked' &&
      eventType !== 'expired') ||
    !Array.isArray(payload.scopes) ||
    payload.scopes.some((scope) => typeof scope !== 'string') ||
    (typeof payload.expires_at !== 'string' && payload.expires_at !== null) ||
    !isRecord(payload.metadata) ||
    typeof payload.created_at !== 'string'
  ) {
    throw new Error('invalid remote assist consent response');
  }
  return payload as unknown as RemoteAssistConsentEvent;
}

export function readRemoteAssistRecordingResult(result: RemoteAssistVerifyHttpResult): RemoteAssistRecordingResult {
  if (!result.ok) {
    throw new Error(errorMessageFromBody(result.body, result.status));
  }

  const payload = unwrapDataEnvelope(result.body);
  if (!isRecord(payload)) {
    throw new Error('invalid remote assist recording response');
  }
  const evidence = payload.evidence_record;
  if (
    typeof payload.id !== 'string' ||
    typeof payload.tenant_id !== 'string' ||
    typeof payload.format !== 'string' ||
    typeof payload.storage_url !== 'string' ||
    typeof payload.has_video !== 'number' ||
    typeof payload.egress_id !== 'string' ||
    (payload.evidence_record_id != null && typeof payload.evidence_record_id !== 'string') ||
    (evidence != null && !isRecord(evidence))
  ) {
    throw new Error('invalid remote assist recording response');
  }
  if (isRecord(evidence) && (typeof evidence.id !== 'string' || typeof evidence.kind !== 'string')) {
    throw new Error('invalid remote assist recording response');
  }
  return payload as unknown as RemoteAssistRecordingResult;
}

export function readRemoteAssistMediaJoinPlan(result: RemoteAssistVerifyHttpResult): RemoteAssistMediaJoinPlan {
  if (!result.ok) {
    throw new Error(errorMessageFromBody(result.body, result.status));
  }

  const payload = unwrapDataEnvelope(result.body);
  if (!isRecord(payload) || !isRecord(payload.token)) {
    throw new Error('invalid remote assist media join response');
  }
  const token = payload.token;
  const tokenValue = token.token;
  const roomName = token.room_name;
  if (typeof tokenValue !== 'string' || typeof roomName !== 'string') {
    throw new Error('invalid remote assist media join response');
  }
  const liveKitUrl = token.livekit_url || token.url;
  if (!tokenValue.startsWith('dev-token:') && (typeof liveKitUrl !== 'string' || !liveKitUrl.trim())) {
    throw new Error('livekit url is required for remote assist media join response');
  }
  return payload as unknown as RemoteAssistMediaJoinPlan;
}

export async function fetchRemoteAssistJoinVerification(
  fetcher: RemoteAssistVerifyFetcher,
  input: RemoteAssistVerifyInput
): Promise<RemoteAssistVerifiedSession> {
  const response = await fetcher(buildRemoteAssistVerifyPath(input), { method: 'POST' });
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return readRemoteAssistJoinVerification({
    ok: response.ok,
    status: response.status,
    body
  });
}

export async function postRemoteAssistEvent(
  fetcher: RemoteAssistVerifyFetcher,
  input: RemoteAssistEventInput
): Promise<RemoteAssistEvent> {
  const response = await fetcher(buildRemoteAssistEventPath(input), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: input.eventType,
      payload: input.payload || {}
    })
  });
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return readRemoteAssistEventResult({
    ok: response.ok,
    status: response.status,
    body
  });
}

function consentBody(input: RemoteAssistConsentInput): string {
  const payload: Record<string, unknown> = {
    scopes: input.scopes || ['view_screen', 'record_screen']
  };
  if (input.expiresAt) payload.expires_at = input.expiresAt;
  return JSON.stringify(payload);
}

export async function postRemoteAssistConsentGrant(
  fetcher: RemoteAssistVerifyFetcher,
  input: RemoteAssistConsentInput
): Promise<RemoteAssistConsentEvent> {
  const response = await fetcher(buildRemoteAssistConsentGrantPath(input), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: consentBody(input)
  });
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return readRemoteAssistConsentEventResult({
    ok: response.ok,
    status: response.status,
    body
  });
}

export async function postRemoteAssistConsentRevoke(
  fetcher: RemoteAssistVerifyFetcher,
  input: RemoteAssistConsentInput
): Promise<RemoteAssistConsentEvent> {
  const response = await fetcher(buildRemoteAssistConsentRevokePath(input), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: consentBody(input)
  });
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return readRemoteAssistConsentEventResult({
    ok: response.ok,
    status: response.status,
    body
  });
}

export async function postRemoteAssistRecordingStart(
  fetcher: RemoteAssistVerifyFetcher,
  input: RemoteAssistRecordingStartInput
): Promise<RemoteAssistRecordingResult> {
  const response = await fetcher(buildRemoteAssistRecordingStartPath(input), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: input.format || 'mp4' })
  });
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return readRemoteAssistRecordingResult({
    ok: response.ok,
    status: response.status,
    body
  });
}

export async function postRemoteAssistRecordingStop(
  fetcher: RemoteAssistVerifyFetcher,
  input: RemoteAssistRecordingStopInput
): Promise<RemoteAssistRecordingResult> {
  const response = await fetcher(buildRemoteAssistRecordingStopPath(input), {
    method: 'POST'
  });
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return readRemoteAssistRecordingResult({
    ok: response.ok,
    status: response.status,
    body
  });
}

export async function fetchRemoteAssistMediaJoinPlan(
  fetcher: RemoteAssistVerifyFetcher,
  input: RemoteAssistVerifyInput
): Promise<RemoteAssistMediaJoinPlan> {
  const response = await fetcher(buildRemoteAssistMediaJoinPath(input));
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return readRemoteAssistMediaJoinPlan({
    ok: response.ok,
    status: response.status,
    body
  });
}
