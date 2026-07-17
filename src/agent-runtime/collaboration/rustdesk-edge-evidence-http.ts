import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import type { SecureFileService } from './secure-file-service.js';
import type { SecureFileStore } from './secure-file-store.js';
import type { RustDeskEdgeCommandIdentity } from './rustdesk-edge-auth.js';
import { RustDeskDeviceStore, type RustDeskDevice } from './rustdesk-device-store.js';
import {
  RustDeskGatewaySessionStore,
  type RustDeskGatewaySession
} from './rustdesk-gateway-session-store.js';
import {
  assertRustDeskCurrentOwnerBinding,
  rustDeskSessionOwnerBinding
} from './rustdesk-owner-epoch.js';

const CREATE_FIELDS = new Set([
  'native_event_id',
  'source_origin',
  'external_id',
  'operation_id',
  'authorization_scope',
  'authorization_id',
  'kind',
  'filename',
  'declared_mime',
  'upload_mode',
  'expected_size_bytes',
  'part_size_bytes',
  'observed_at',
  'direction',
  'control_version',
  'retention_until',
  'expires_at',
  'interaction_id',
  'reservation_id',
  'owner_epoch'
]);

export const RUSTDESK_EVIDENCE_FINALIZATION_GRACE_MS = 15 * 60_000;

export interface RouteRustDeskEdgeEvidenceApiInput {
  pg: PgQueryable;
  method: string;
  routePath: string;
  body: unknown;
  rawBody: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  identity: RustDeskEdgeCommandIdentity;
  secureFiles: SecureFileService;
  fileStore: SecureFileStore;
}

export function isRustDeskEdgeEvidenceRoute(method: string, routePath: string): boolean {
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return false;
  return /^\/api\/ivekit\/rustdesk\/devices\/[^/]+\/(?:evidence(?:\/|$)|evidence-context$)/.test(
    routePath
  );
}

export async function routeRustDeskEdgeEvidenceApi(
  input: RouteRustDeskEdgeEvidenceApiInput
): Promise<unknown | undefined> {
  const context = input.routePath.match(
    /^\/api\/ivekit\/rustdesk\/devices\/([^/]+)\/evidence-context$/
  );
  if (context) {
    if (input.method !== 'GET') return methodNotAllowed();
    const deviceId = decodeURIComponent(context[1]);
    const device = await activeIdentityDevice(input.pg, input.identity, deviceId);
    if (!device) return { status: 404, data: { error: 'rustdesk device not found' } };
    return { data: await nativeEvidenceContext(input.pg, device) };
  }
  const root = input.routePath.match(
    /^\/api\/ivekit\/rustdesk\/devices\/([^/]+)\/evidence(?:\/(.*))?$/
  );
  if (!root) return undefined;
  const deviceId = decodeURIComponent(root[1]);
  const tail = root[2] || '';
  const device = await activeIdentityDevice(input.pg, input.identity, deviceId);
  if (!device) return { status: 404, data: { error: 'rustdesk device not found' } };

  if (!tail && input.method === 'POST') {
    return createEvidence(input, device);
  }
  if (!tail) return methodNotAllowed();

  const partMatch = tail.match(/^([^/]+)\/parts\/(\d+)$/);
  const partsMatch = tail.match(/^([^/]+)\/parts$/);
  const contentMatch = tail.match(/^([^/]+)\/content$/);
  const completeMatch = tail.match(/^([^/]+)\/complete$/);
  const fileMatch = tail.match(/^([^/]+)$/);
  const fileId = decodeURIComponent(
    partMatch?.[1] || partsMatch?.[1] || contentMatch?.[1] || completeMatch?.[1] || fileMatch?.[1] || ''
  );
  if (!fileId) return methodNotAllowed();
  const file = await input.fileStore.getFile(input.identity.tenant_id, fileId);
  if (!edgeOwnsFile(file, input.identity, device)) {
    return { status: 404, data: { error: 'RustDesk evidence file not found' } };
  }
  await assertEvidenceFileCurrentOwner(input.pg, file);
  const common = {
    tenant_id: input.identity.tenant_id,
    session_id: file.session_id,
    secure_file_id: file.id
  };

  if (contentMatch && input.method === 'PUT') {
    const uploaded = await input.secureFiles.uploadContent({
      ...common,
      content: binaryBody(input.rawBody),
      sha256: requiredHeader(input.headers, 'x-content-sha256', 'X-Content-SHA256 is required')
    });
    return { data: { file: uploaded } };
  }
  if (partMatch && input.method === 'PUT') {
    const part = await input.secureFiles.uploadPart({
      ...common,
      part_number: Number(partMatch[2]),
      content: binaryBody(input.rawBody),
      sha256: requiredHeader(input.headers, 'x-content-sha256', 'X-Content-SHA256 is required')
    });
    return { data: { part } };
  }
  if (partsMatch && input.method === 'GET') {
    return { data: { parts: await input.secureFiles.listParts(common) } };
  }
  if (completeMatch && input.method === 'POST') {
    const body = strictObject(input.body, 'RustDesk evidence completion body');
    const unknown = Object.keys(body).find((field) => field !== 'size_bytes' && field !== 'sha256');
    if (unknown) throw httpError(`unsupported RustDesk evidence completion field: ${unknown}`, 400);
    const completed = await input.secureFiles.completeUpload({
      ...common,
      size_bytes: Number(body.size_bytes),
      sha256: String(body.sha256 || '')
    });
    return { data: { file: completed } };
  }
  if (fileMatch && input.method === 'GET') {
    return { data: { file: await input.secureFiles.getFile(common) } };
  }
  if (fileMatch && input.method === 'DELETE') {
    return { data: { file: await input.secureFiles.abortUpload(common) } };
  }
  return methodNotAllowed();
}

async function nativeEvidenceContext(pg: PgQueryable, device: RustDeskDevice) {
  const now = Date.now();
  const generatedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 30_000).toISOString();
  const sessions = new RustDeskGatewaySessionStore(pg);
  const candidates = (await sessions.listSessions({ tenant_id: device.tenant_id, limit: 200 }))
    .filter((session) => sessionMatchesDevice(session, device))
    .filter((session) => session.status === 'active' || (
      session.ended_at !== null &&
      now <= Date.parse(session.ended_at) + RUSTDESK_EVIDENCE_FINALIZATION_GRACE_MS
    ));
  const bindings: Array<Record<string, unknown>> = [];
  const ownerSessions = candidates.flatMap((session) => {
    const owner = rustDeskSessionOwnerBinding(session);
    return owner ? [{ external_id: session.external_id, ...owner }] : [];
  });
  for (const session of candidates) {
    const owner = rustDeskSessionOwnerBinding(session);
    const controllerRustDeskId = String(session.metadata.controller_rustdesk_id || '').trim();
    if (!controllerRustDeskId) continue;
    const events = await sessions.listAuditEvents({ external_id: session.external_id });
    for (const event of events || []) {
      if (event.event_type === 'remote.rustdesk.recording.started') {
        const operationId = String(event.metadata.recording_id || '').trim();
        if (!operationId || event.metadata.evidence_type !== 'screen_recording') continue;
        bindings.push(compact({
          kind: 'screen_recording',
          external_id: session.external_id,
          controller_rustdesk_id: controllerRustDeskId,
          operation_id: operationId,
          authorization_scope: 'session',
          authorization_id: session.external_id,
          started_at: event.occurred_at,
          valid_until: session.ended_at
            ? new Date(Date.parse(session.ended_at) + RUSTDESK_EVIDENCE_FINALIZATION_GRACE_MS).toISOString()
            : expiresAt,
          file_name: optionalEvidenceBindingString(event.metadata.file_name),
          declared_mime: optionalEvidenceBindingString(event.metadata.declared_mime),
          retention_until: optionalEvidenceBindingString(event.metadata.retention_until),
          ...(owner || {})
        }));
        continue;
      }
      if (event.event_type !== 'remote.rustdesk.file_transfer.started') continue;
      const operationId = String(event.metadata.transfer_id || '').trim();
      const authorizationId = String(event.metadata.operation_grant_id || '').trim();
      const direction = String(event.metadata.direction || '').trim();
      const controlVersion = Number(event.metadata.control_version);
      if (
        !operationId || !authorizationId ||
        (direction !== 'upload' && direction !== 'download') ||
        !Number.isSafeInteger(controlVersion) || controlVersion < 1
      ) continue;
      bindings.push(compact({
        kind: 'file',
        external_id: session.external_id,
        controller_rustdesk_id: controllerRustDeskId,
        operation_id: operationId,
        authorization_scope: 'operation',
        authorization_id: authorizationId,
        direction,
        control_version: controlVersion,
        started_at: event.occurred_at,
        valid_until: session.ended_at
          ? new Date(Date.parse(session.ended_at) + RUSTDESK_EVIDENCE_FINALIZATION_GRACE_MS).toISOString()
          : expiresAt,
        file_name: optionalEvidenceBindingString(event.metadata.file_name),
        declared_mime: optionalEvidenceBindingString(event.metadata.declared_mime),
        retention_until: optionalEvidenceBindingString(event.metadata.retention_until),
        ...(owner || {})
      }));
    }
  }
  bindings.sort((left, right) => String(left.started_at).localeCompare(String(right.started_at)));
  return {
    schema_version: 1,
    device_id: device.id,
    rustdesk_id: device.rustdesk_id,
    generated_at: generatedAt,
    expires_at: expiresAt,
    sessions: ownerSessions,
    bindings
  };
}

async function createEvidence(
  input: RouteRustDeskEdgeEvidenceApiInput,
  device: RustDeskDevice
): Promise<unknown> {
  const body = strictObject(input.body, 'RustDesk evidence body');
  const unknown = Object.keys(body).find((field) => !CREATE_FIELDS.has(field));
  if (unknown) throw httpError(`unsupported RustDesk evidence field: ${unknown}`, 400);
  const externalId = requiredString(body.external_id, 'RustDesk evidence external_id is required');
  const operationId = requiredString(body.operation_id, 'RustDesk evidence operation_id is required');
  const kind = String(body.kind || '');
  if (kind !== 'screen_recording' && kind !== 'file') {
    throw httpError('RustDesk evidence kind must be screen_recording or file', 400);
  }
  const uploadMode = String(body.upload_mode || '');
  if (uploadMode !== 'single' && uploadMode !== 'multipart') {
    throw httpError('RustDesk evidence upload_mode must be single or multipart', 400);
  }
  const session = await new RustDeskGatewaySessionStore(input.pg).getSession(externalId);
  if (!session || !sessionMatchesDevice(session, device)) {
    throw httpError('RustDesk gateway session not found', 404);
  }
  const ownerBinding = assertRustDeskCurrentOwnerBinding(session, body);
  const requiredPermission = kind === 'screen_recording' ? 'record_screen' : 'transfer_file';
  if (!session.permissions.includes(requiredPermission)) {
    throw httpError(`RustDesk evidence upload requires ${requiredPermission} permission`, 403);
  }
  const collaborationSessionId = requiredString(
    session.metadata.collaboration_session_id,
    'RustDesk gateway collaboration_session_id is required'
  );
  const idempotencyKey = requiredHeader(
    input.headers,
    'idempotency-key',
    'Idempotency-Key is required'
  );
  const nativeEventId = requiredString(
    body.native_event_id,
    'RustDesk evidence native_event_id is required'
  );
  if (body.source_origin !== 'rustdesk_native_event') {
    throw httpError('RustDesk evidence source_origin must be rustdesk_native_event', 400);
  }
  const authorizationScope = String(body.authorization_scope || '');
  const authorizationId = requiredString(
    body.authorization_id,
    'RustDesk evidence authorization_id is required'
  );
  const observedAt = requiredIso(body.observed_at, 'RustDesk evidence observed_at is required');
  assertRustDeskEvidenceSessionWindow(session, observedAt);
  const direction = body.direction === undefined ? undefined : String(body.direction);
  const controlVersion = body.control_version === undefined ? undefined : Number(body.control_version);
  if (kind === 'file') {
    if (authorizationScope !== 'operation') {
      throw httpError('RustDesk file evidence requires operation authorization', 403);
    }
    if (direction !== 'upload' && direction !== 'download') {
      throw httpError('RustDesk file evidence direction must be upload or download', 400);
    }
    if (!Number.isSafeInteger(controlVersion) || Number(controlVersion) < 1) {
      throw httpError('RustDesk file evidence control_version is required', 400);
    }
  } else {
    if (authorizationScope !== 'session' || authorizationId !== externalId) {
      throw httpError('RustDesk recording evidence requires gateway session authorization', 403);
    }
    if (direction !== undefined || controlVersion !== undefined) {
      throw httpError('RustDesk recording evidence must not include file control fields', 400);
    }
  }
  await assertAuthorizedNativeEvidence({
    session,
    operationId,
    kind,
    authorizationId,
    observedAt,
    direction,
    controlVersion,
    sessions: new RustDeskGatewaySessionStore(input.pg)
  });
  const normalized = {
    native_event_id: nativeEventId,
    source_origin: 'rustdesk_native_event',
    external_id: externalId,
    operation_id: operationId,
    authorization_scope: authorizationScope,
    authorization_id: authorizationId,
    kind,
    filename: requiredString(body.filename, 'RustDesk evidence filename is required'),
    declared_mime: body.declared_mime == null ? undefined : String(body.declared_mime),
    upload_mode: uploadMode,
    expected_size_bytes: Number(body.expected_size_bytes),
    part_size_bytes: body.part_size_bytes == null ? undefined : Number(body.part_size_bytes),
    observed_at: observedAt,
    direction,
    control_version: controlVersion,
    retention_until: optionalString(body.retention_until),
    expires_at: optionalString(body.expires_at)
  } as const;
  const file = await input.secureFiles.createUpload({
    tenant_id: input.identity.tenant_id,
    session_id: collaborationSessionId,
    created_by: input.identity.edge_instance_id,
    kind,
    filename: normalized.filename,
    declared_mime: normalized.declared_mime,
    upload_mode: uploadMode,
    expected_size_bytes: normalized.expected_size_bytes,
    part_size_bytes: normalized.part_size_bytes,
    idempotency_key: `rustdesk-edge:${device.id}:${input.identity.edge_instance_id}:${idempotencyKey}`,
    payload_hash: createHash('sha256').update(stableJson(normalized)).digest('hex'),
    retention_until: normalized.retention_until,
    expires_at: normalized.expires_at,
    metadata: {
      source: 'rustdesk_companion_evidence',
      source_origin: 'rustdesk_native_event',
      native_event_id: nativeEventId,
      gateway_external_id: session.external_id,
      operation_id: operationId,
      authorization_scope: authorizationScope,
      authorization_id: authorizationId,
      observed_at: observedAt,
      ...(direction ? { direction } : {}),
      ...(controlVersion === undefined ? {} : { control_version: controlVersion }),
      rustdesk_device_id: device.id,
      rustdesk_id: device.rustdesk_id,
      edge_instance_id: input.identity.edge_instance_id,
      evidence_security: 'ivekit_secure_file',
      ...(ownerBinding || {})
    }
  });
  return { status: 201, data: { file } };
}

async function assertAuthorizedNativeEvidence(input: {
  session: RustDeskGatewaySession;
  operationId: string;
  kind: string;
  authorizationId: string;
  observedAt: string;
  direction?: string;
  controlVersion?: number;
  sessions: RustDeskGatewaySessionStore;
}): Promise<void> {
  const events = await input.sessions.listAuditEvents({ external_id: input.session.external_id });
  const started = (events || []).find((event) => {
    if (new Date(event.occurred_at).getTime() > new Date(input.observedAt).getTime() + 5 * 60_000) {
      return false;
    }
    if (input.kind === 'screen_recording') {
      return event.event_type === 'remote.rustdesk.recording.started' &&
        event.metadata.recording_id === input.operationId &&
        event.metadata.evidence_type === 'screen_recording';
    }
    return event.event_type === 'remote.rustdesk.file_transfer.started' &&
      event.metadata.transfer_id === input.operationId &&
      event.metadata.direction === input.direction &&
      event.metadata.operation_grant_id === input.authorizationId &&
      Number(event.metadata.control_version) === input.controlVersion;
  });
  if (started) return;
  if (input.kind === 'screen_recording') {
    throw httpError('authorized screen recording start event is required', 403);
  }
  throw httpError('authorized file transfer start event is required', 403);
}

async function activeIdentityDevice(
  pg: PgQueryable,
  identity: RustDeskEdgeCommandIdentity,
  deviceId: string
): Promise<RustDeskDevice | null> {
  const device = await new RustDeskDeviceStore(pg).getDevice({
    tenant_id: identity.tenant_id,
    device_id: deviceId
  });
  return device && device.status === 'active' && !device.deactivated_at &&
    device.rustdesk_id === identity.rustdesk_id
    ? device
    : null;
}

function edgeOwnsFile(
  file: Awaited<ReturnType<SecureFileStore['getFile']>>,
  identity: RustDeskEdgeCommandIdentity,
  device: RustDeskDevice
): boolean {
  return file.tenant_id === identity.tenant_id &&
    file.metadata.source === 'rustdesk_companion_evidence' &&
    file.metadata.rustdesk_device_id === device.id &&
    file.metadata.rustdesk_id === identity.rustdesk_id &&
    file.metadata.edge_instance_id === identity.edge_instance_id;
}

async function assertEvidenceFileCurrentOwner(
  pg: PgQueryable,
  file: Awaited<ReturnType<SecureFileStore['getFile']>>
): Promise<void> {
  const externalId = requiredString(
    file.metadata.gateway_external_id,
    'RustDesk evidence gateway_external_id is required'
  );
  const session = await new RustDeskGatewaySessionStore(pg).getSession(externalId);
  if (!session || session.tenant_id !== file.tenant_id) {
    throw httpError('RustDesk gateway session not found', 404);
  }
  assertRustDeskCurrentOwnerBinding(session, file.metadata);
}

function sessionMatchesDevice(session: RustDeskGatewaySession, device: RustDeskDevice): boolean {
  if (session.tenant_id !== device.tenant_id) return false;
  const identities = new Set([
    String(session.target.id || '').trim(),
    String(session.metadata.rustdesk_device_id || '').trim(),
    String(session.metadata.rustdesk_id || '').trim(),
    String(session.metadata.target_id || '').trim()
  ].filter(Boolean));
  return identities.has(device.id) || identities.has(device.rustdesk_id);
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(`${name} must be a JSON object`, 400);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw httpError(message, 400);
  const result = value.trim();
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw httpError(message, 400);
  }
  return result;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return String(value);
}

function requiredIso(value: unknown, message: string): string {
  const result = requiredString(value, message);
  if (Number.isNaN(Date.parse(result))) throw httpError(message, 400);
  return new Date(result).toISOString();
}

export function assertRustDeskEvidenceSessionWindow(
  session: Pick<RustDeskGatewaySession, 'status' | 'created_at' | 'ended_at'>,
  observedAt: string,
  receivedAt = Date.now()
): void {
  const observed = Date.parse(observedAt);
  const created = Date.parse(session.created_at);
  if (observed < created - 5 * 60_000 || observed > receivedAt + 5 * 60_000) {
    throw httpError('RustDesk evidence observed_at is outside the gateway session time window', 400);
  }
  if (session.status === 'active') return;
  if (session.status !== 'ended' || !session.ended_at) {
    throw httpError('RustDesk gateway session is not active', 409);
  }
  const ended = Date.parse(session.ended_at);
  if (observed > ended + RUSTDESK_EVIDENCE_FINALIZATION_GRACE_MS) {
    throw httpError('RustDesk evidence was observed after the finalization grace period', 409);
  }
  if (receivedAt > ended + RUSTDESK_EVIDENCE_FINALIZATION_GRACE_MS) {
    throw httpError('RustDesk evidence finalization grace period has expired', 409);
  }
}

function requiredHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
  message: string
): string {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = Array.isArray(found?.[1]) ? found?.[1][0] : found?.[1];
  const result = String(value || '').trim();
  if (!result) throw httpError(message, 400);
  return result;
}

function binaryBody(value: string | Buffer): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw httpError('binary request body is required', 400);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function optionalEvidenceBindingString(value: unknown): string | undefined {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || undefined;
}

function methodNotAllowed(): Record<string, unknown> {
  return { status: 405, data: { error: 'method not allowed' } };
}

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}
