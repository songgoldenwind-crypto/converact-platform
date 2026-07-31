import type { PgQueryable } from '../../db-pg.js';
import {
  rustDeskGatewayObservedOperationControllerRequirement
} from './rustdesk-gateway-event.js';
import { RustDeskControlLockStore } from './rustdesk-control-lock-store.js';
import { RustDeskDeviceStore, type RustDeskDevice } from './rustdesk-device-store.js';
import type { RustDeskEdgeCommandIdentity } from './rustdesk-edge-auth.js';
import { SecureFileStore } from './secure-file-store.js';
import {
  RustDeskGatewaySessionStore,
  type RustDeskGatewaySession
} from './rustdesk-gateway-session-store.js';
import {
  normalizeRustDeskOperationObservation,
  type RustDeskNativeOperationObservation
} from './rustdesk-operation-observation.js';
import { assertRustDeskCurrentOwnerBinding } from './rustdesk-owner-epoch.js';

const OBSERVATION_FIELDS = new Set([
  'external_id',
  'operation_id',
  'operation',
  'status',
  'observer',
  'source_adapter',
  'observed_at',
  'evidence_refs',
  'evidence_security',
  'provider_operation_id',
  'provider_session_id',
  'direction',
  'display_id',
  'byte_count',
  'checksum_sha256',
  'duration_ms',
  'reason',
  'status_detail',
  'control_version',
  'interaction_id',
  'reservation_id',
  'owner_epoch'
]);
const SOURCE_ADAPTERS = new Set(['native_client', 'rustdesk_log', 'companion_hook']);
const HEARTBEAT_FIELDS = new Set(['business_ref', 'runtime_status', 'seen_at', 'metadata']);
const HEARTBEAT_METADATA_FIELDS = new Set([
  'disconnect_command_capable',
  'observation_capable',
  'evidence_upload_capable',
  'native_evidence_capable',
  'command_poll_interval_ms',
  'observation_poll_interval_ms',
  'evidence_poll_interval_ms',
  'client_version',
  'os',
  'native_control_protocol'
]);

export interface RouteRustDeskEdgeObservationApiInput {
  pg: PgQueryable;
  method: string;
  routePath: string;
  body: unknown;
  identity: RustDeskEdgeCommandIdentity;
  onSessionChanged?: (
    session: RustDeskGatewaySession,
    actorIdentity: string
  ) => Promise<void>;
}

export function isRustDeskEdgeObservationRoute(method: string, routePath: string): boolean {
  return method === 'POST' && (
    routePath === '/api/ivekit/rustdesk/edge/heartbeat' ||
    /^\/api\/ivekit\/rustdesk\/devices\/[^/]+\/observations$/.test(routePath)
  );
}

export async function routeRustDeskEdgeObservationApi(
  input: RouteRustDeskEdgeObservationApiInput
): Promise<unknown | undefined> {
  if (input.method !== 'POST') return undefined;
  if (input.routePath === '/api/ivekit/rustdesk/edge/heartbeat') {
    return routeHeartbeat(input);
  }
  const observationMatch = input.routePath.match(
    /^\/api\/ivekit\/rustdesk\/devices\/([^/]+)\/observations$/
  );
  if (!observationMatch) return undefined;

  const deviceId = decodeURIComponent(observationMatch[1]);
  const devices = new RustDeskDeviceStore(input.pg);
  const device = await devices.getDevice({
    tenant_id: input.identity.tenant_id,
    device_id: deviceId
  });
  if (!activeIdentityDevice(device, input.identity.rustdesk_id)) {
    return { status: 404, data: { error: 'rustdesk device not found' } };
  }
  const body = strictObject(input.body, 'RustDesk edge observation body');
  const unknownBodyField = Object.keys(body).find((field) => field !== 'observations');
  if (unknownBodyField) {
    throw httpError(`unsupported RustDesk edge observation body field: ${unknownBodyField}`, 400);
  }
  if (!Array.isArray(body.observations) || body.observations.length < 1 || body.observations.length > 100) {
    throw httpError('RustDesk edge observations must contain from 1 to 100 items', 400);
  }

  const sessions = new RustDeskGatewaySessionStore(input.pg);
  const locks = new RustDeskControlLockStore(input.pg);
  const events = [];
  const changedSessions = new Map<string, { session: RustDeskGatewaySession; actor: string }>();
  for (const raw of body.observations) {
    const observation = edgeObservation(raw, input.identity, device!);
    const normalized = normalizeRustDeskOperationObservation(observation);
    const session = await sessions.getSession(normalized.external_id);
    if (!session || !sessionMatchesDevice(session, device!)) {
      throw httpError('rustdesk gateway session not found', 404);
    }
    assertRustDeskCurrentOwnerBinding(
      session,
      observation as unknown as Record<string, unknown>
    );
    await assertSecureEvidence(input.pg, observation, session, device!);
    assertObservationTime(normalized.occurred_at, session.created_at);
    let actorIdentity = input.identity.edge_instance_id;
    const controllerOperation = rustDeskGatewayObservedOperationControllerRequirement(
      normalized.event_type,
      normalized.metadata
    );
    if (Number(session.metadata.control_enforcement_version || 0) >= 1 && controllerOperation) {
      const ownership = await locks.getOwnership({
        tenant_id: input.identity.tenant_id,
        external_id: session.external_id
      });
      if (ownership.status !== 'owned' || !ownership.owner_identity) {
        throw httpError('RustDesk sensitive observation requires an active control owner', 409);
      }
      if (Number(normalized.metadata.control_version) !== ownership.version) {
        throw httpError('stale control ownership version', 409);
      }
      actorIdentity = ownership.owner_identity;
    }
    normalized.metadata.edge_instance_id = input.identity.edge_instance_id;
    normalized.actor_identity = actorIdentity;
    const event = await sessions.appendAuditEvent(normalized);
    if (!event) throw httpError('rustdesk gateway session not found', 404);
    events.push(event);
    changedSessions.set(session.external_id, { session, actor: actorIdentity });
  }
  for (const changed of changedSessions.values()) {
    await input.onSessionChanged?.(changed.session, changed.actor);
  }
  return {
    status: 201,
    data: {
      events,
      accepted: events.length
    }
  };
}

async function routeHeartbeat(input: RouteRustDeskEdgeObservationApiInput): Promise<unknown> {
  const body = strictObject(input.body, 'RustDesk edge heartbeat body');
  const unknown = Object.keys(body).find((field) => !HEARTBEAT_FIELDS.has(field));
  if (unknown) throw httpError(`unsupported RustDesk edge heartbeat field: ${unknown}`, 400);
  const businessRef = strictObject(body.business_ref, 'RustDesk edge heartbeat business_ref');
  const unknownRef = Object.keys(businessRef).find((field) => field !== 'type' && field !== 'id');
  if (unknownRef) throw httpError(`unsupported RustDesk edge heartbeat business_ref field: ${unknownRef}`, 400);
  const type = requiredString(businessRef.type, 'business_ref.type is required');
  const id = requiredString(businessRef.id, 'business_ref.id is required');
  const metadata = strictObject(body.metadata ?? {}, 'RustDesk edge heartbeat metadata');
  const unknownMetadata = Object.keys(metadata).find((field) => !HEARTBEAT_METADATA_FIELDS.has(field));
  if (unknownMetadata) {
    throw httpError(`unsupported RustDesk edge heartbeat metadata field: ${unknownMetadata}`, 400);
  }
  assertHeartbeatMetadata(metadata);

  const devices = new RustDeskDeviceStore(input.pg);
  const candidates = await devices.getByBusinessRef({
    tenant_id: input.identity.tenant_id,
    business_ref: {
      tenant_id: input.identity.tenant_id,
      type,
      id
    },
    limit: 50
  });
  const device = candidates.find((candidate) => activeIdentityDevice(
    candidate,
    input.identity.rustdesk_id
  ));
  if (!device) return { status: 404, data: { error: 'rustdesk device not found' } };
  const heartbeat = await devices.heartbeatDevice({
    tenant_id: input.identity.tenant_id,
    device_id: device.id,
    actor_identity: input.identity.edge_instance_id,
    runtime_status: body.runtime_status as 'online' | 'offline' | undefined,
    seen_at: body.seen_at === undefined ? undefined : String(body.seen_at),
    metadata: {
      ...metadata,
      edge_instance_id: input.identity.edge_instance_id,
      source: 'rustdesk-edge-device-token'
    }
  });
  if (!heartbeat) return { status: 404, data: { error: 'rustdesk device not found' } };
  return { status: 201, data: heartbeat };
}

function edgeObservation(
  value: unknown,
  identity: RustDeskEdgeCommandIdentity,
  device: RustDeskDevice
): RustDeskNativeOperationObservation {
  const observation = strictObject(value, 'RustDesk edge observation');
  const unknown = Object.keys(observation).find((field) => !OBSERVATION_FIELDS.has(field));
  if (unknown) throw httpError(`unsupported RustDesk edge observation field: ${unknown}`, 400);
  const sourceAdapter = requiredString(
    observation.source_adapter,
    'RustDesk edge observation source_adapter is required'
  );
  if (!SOURCE_ADAPTERS.has(sourceAdapter)) {
    throw httpError('RustDesk edge observation source_adapter is unsupported', 400);
  }
  const observer = String(observation.observer || '');
  const status = String(observation.status || '');
  if (status === 'not_observed') {
    if (observer !== 'none') throw httpError('RustDesk not_observed edge item must use observer none', 400);
  } else if (
    (sourceAdapter === 'companion_hook' && observer !== 'edge_adapter') ||
    (sourceAdapter !== 'companion_hook' && observer !== 'native_client')
  ) {
    throw httpError('RustDesk edge observation observer does not match source_adapter', 400);
  }
  assertEdgeEvidenceSecurity(observation);
  return {
    ...(observation as unknown as RustDeskNativeOperationObservation),
    actor_identity: identity.edge_instance_id,
    target: device.rustdesk_id,
    metadata: { source_adapter: sourceAdapter }
  };
}

function assertEdgeEvidenceSecurity(observation: Record<string, unknown>): void {
  const operation = String(observation.operation || '');
  const security = String(observation.evidence_security || '');
  if (operation === 'transfer_file' && !['ivekit_secure_file', 'native_unscanned'].includes(security)) {
    throw httpError('RustDesk transfer_file observation evidence_security is required', 400);
  }
  if (operation === 'record_screen' && !['ivekit_secure_file', 'local_only'].includes(security)) {
    throw httpError('RustDesk record_screen observation evidence_security is required', 400);
  }
  if (operation !== 'transfer_file' && operation !== 'record_screen' && security) {
    throw httpError('RustDesk observation evidence_security is unsupported for operation', 400);
  }
  if (security !== 'ivekit_secure_file') return;
  if (!Number.isSafeInteger(observation.byte_count) || Number(observation.byte_count) < 1) {
    throw httpError('RustDesk secure evidence observation byte_count is required', 400);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(observation.checksum_sha256 || ''))) {
    throw httpError('RustDesk secure evidence observation checksum_sha256 is required', 400);
  }
}

async function assertSecureEvidence(
  pg: PgQueryable,
  observation: RustDeskNativeOperationObservation,
  session: RustDeskGatewaySession,
  device: RustDeskDevice
): Promise<void> {
  if (observation.evidence_security !== 'ivekit_secure_file') return;
  const refs = (observation.evidence_refs || []).filter((ref) => ref.type === 'ivekit_secure_file');
  if (refs.length !== 1 || !refs[0].ref.startsWith('ivekit-secure-file://')) {
    throw httpError('RustDesk secure evidence observation ref is required', 400);
  }
  const fileId = refs[0].ref.slice('ivekit-secure-file://'.length);
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(fileId)) {
    throw httpError('RustDesk secure evidence observation ref is invalid', 400);
  }
  let file;
  try {
    file = await new SecureFileStore(pg).getFile(device.tenant_id, fileId);
  } catch {
    throw httpError('RustDesk secure evidence file not found', 404);
  }
  const expectedSessionId = String(session.metadata.collaboration_session_id || '');
  if (
    !expectedSessionId ||
    file.session_id !== expectedSessionId ||
    file.metadata.source !== 'rustdesk_companion_evidence' ||
    file.metadata.gateway_external_id !== session.external_id ||
    file.metadata.operation_id !== observation.operation_id ||
    file.metadata.rustdesk_device_id !== device.id ||
    ['initiated', 'uploading'].includes(file.status)
  ) {
    throw httpError('RustDesk secure evidence file does not match observation', 409);
  }
  const digest = `sha256:${file.sha256}`;
  if (
    refs[0].sha256 !== digest ||
    observation.checksum_sha256 !== digest ||
    observation.byte_count !== file.size_bytes
  ) {
    throw httpError('RustDesk secure evidence integrity does not match observation', 409);
  }
}

function activeIdentityDevice(device: RustDeskDevice | null, rustdeskId: string): device is RustDeskDevice {
  return Boolean(
    device &&
    device.status === 'active' &&
    !device.deactivated_at &&
    device.rustdesk_id === rustdeskId
  );
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

function assertObservationTime(observedAt: string | undefined, sessionCreatedAt: string): void {
  if (!observedAt) return;
  const value = Date.parse(observedAt);
  if (value > Date.now() + 5 * 60_000) {
    throw httpError('RustDesk edge observation occurred_at is too far in the future', 400);
  }
  if (value < Date.parse(sessionCreatedAt) - 5 * 60_000) {
    throw httpError('RustDesk edge observation predates the gateway session', 400);
  }
}

function assertHeartbeatMetadata(metadata: Record<string, unknown>): void {
  for (const field of [
    'disconnect_command_capable',
    'observation_capable',
    'evidence_upload_capable',
    'native_evidence_capable'
  ]) {
    if (metadata[field] !== undefined && typeof metadata[field] !== 'boolean') {
      throw httpError(`RustDesk edge heartbeat metadata.${field} must be boolean`, 400);
    }
  }
  for (const field of [
    'command_poll_interval_ms',
    'observation_poll_interval_ms',
    'evidence_poll_interval_ms'
  ]) {
    const value = metadata[field];
    if (value !== undefined && (!Number.isInteger(value) || Number(value) < 250 || Number(value) > 300_000)) {
      throw httpError(`RustDesk edge heartbeat metadata.${field} must be an integer from 250 to 300000`, 400);
    }
  }
  for (const field of ['client_version', 'os']) {
    const value = metadata[field];
    if (value !== undefined && !/^[A-Za-z0-9._+-]{1,64}$/.test(String(value))) {
      throw httpError(`RustDesk edge heartbeat metadata.${field} is invalid`, 400);
    }
  }
  if (
    metadata.native_control_protocol !== undefined &&
    metadata.native_control_protocol !== 'ivekit-rustdesk-native-control-v1' &&
    metadata.native_control_protocol !== 'ivekit-rustdesk-native-control-v2'
  ) {
    throw httpError('RustDesk edge heartbeat metadata.native_control_protocol is invalid', 400);
  }
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(`${name} must be a JSON object`, 400);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw httpError(message, 400);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) {
    throw httpError(`${message.replace(' is required', '')} is invalid`, 400);
  }
  return normalized;
}

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}
