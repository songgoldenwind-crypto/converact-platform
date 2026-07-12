import { createHash } from 'node:crypto';

import { MemoryPg, pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { resolveAuthContext } from '../../middleware/auth.js';
import { createObjectStorage, isLocalObjectStorage, readLocalUpload } from '../../storage/object-storage.js';
import { wsBroadcast, wsBroadcastToUsers } from '../../ws.js';
import { verifyWebAssistJoinToken } from '../ivekit/remote-assist-token.js';
import { IveKitUnifiedTimelineStore } from '../ivekit/unified-timeline-store.js';
import { createLiveKitMediaModule } from '../livekit/index.js';
import { MediaCallStore } from '../livekit/media-call-store.js';
import { recordMediaRecordingEvidence } from '../media-recording-evidence.js';
import {
  configuredChatGateway,
  TINODE_RECEIVE_ONLY_ACCESS_MODE,
  type ChatGateway
} from './chat-gateway.js';
import {
  AttachmentProcessingService,
  type AttachmentProcessingServiceInput
} from './attachment-processing.js';
import { configuredAsrProvider } from './asr-provider.js';
import type { CollaborationMessageAttachmentInput } from './collaboration-store.js';
import { createCollaborationModule } from './index.js';
import { configuredOcrProvider } from './ocr-provider.js';
import { PolicyFindingStore } from './policy-finding-store.js';
import { CollaborationMessageStateStore } from './message-state-store.js';
import {
  QualityReviewService,
  configuredQualityReviewProvider,
  type QualityReviewProvider,
  type QualityReviewServiceInput
} from './quality-review.js';
import {
  createGuacamoleGatewayClient,
  createMeshCentralGatewayClient,
  createRustDeskGatewayClient,
  type RemoteGatewayClient
} from './remote-gateway-client.js';
import type { RemoteGatewayProvider, RemoteGatewayTarget } from './remote-gateway-adapter.js';
import { RemoteAssistanceStore } from './remote-assistance-store.js';
import type {
  BusinessRef,
  CollaborationMessage,
  CollaborationParticipant,
  CollaborationParticipantRole,
  EvidenceKind,
  RemoteAssistanceSession,
  RemoteAssistanceMode,
  RemoteAuditEvent,
  RemoteConsentScope,
  RemoteToolProvider,
  RemoteToolSession
} from './types.js';
import {
  RustDeskGatewaySessionStore,
  type RustDeskGatewaySession
} from './rustdesk-gateway-session-store.js';
import { rustDeskClientConfig } from './rustdesk-client-config.js';
import { createRustDeskClientDistributionProfile } from './rustdesk-client-profile.js';
import {
  isRustDeskEdgeDeviceCommandRoute,
  routeRustDeskDeviceCommandApi
} from './rustdesk-device-command-http.js';
import { RustDeskDeviceStore } from './rustdesk-device-store.js';
import { verifyRustDeskEdgeCommandToken } from './rustdesk-edge-auth.js';
import { RustDeskPhysicalDisconnectService } from './rustdesk-physical-disconnect.js';
import {
  TinodeMessageDeliveryService,
  type TinodeMessageDeliveryServiceInput
} from './tinode-message-delivery.js';
import {
  assertRustDeskDeviceOnlineIfRequired,
  assertRustDeskPhysicalDisconnectCapableIfRequired,
  rustDeskRequirePhysicalDisconnect
} from './rustdesk-device-online.js';
import {
  rustDeskGatewayEventPermissionError,
  rustDeskGatewayEventValidationError
} from './rustdesk-gateway-event.js';
import {
  hasRustDeskGatewayAccessModeAlias,
  hasRustDeskGatewayUnattendedAlias,
  rustDeskGatewayAccessMode,
  rustDeskGatewayMetadata
} from './rustdesk-gateway-security.js';
import {
  isValidRustDeskLaunchToken,
  rustDeskLaunchHtml,
  rustDeskLaunchPlan,
  rustDeskLaunchUrl,
  rustDeskRuntimeMetadata
} from './rustdesk-launch-plan.js';

export interface RouteCollaborationApiOptions {
  db?: unknown;
  chatGateway?: ChatGateway;
  tinodeDelivery?: Pick<
    TinodeMessageDeliveryServiceInput,
    'now' | 'retryDelaysMs' | 'maxAttempts' | 'claimLeaseMs' | 'onDeliveryUpdated'
  >;
  attachmentProcessing?: Omit<AttachmentProcessingServiceInput, 'pg'>;
  qualityReview?: Omit<QualityReviewServiceInput, 'pg'>;
}

function requirePg(pg: PgQueryable | null): PgQueryable {
  if (!pg) {
    throw Object.assign(new Error('postgres is required for collaboration API'), { status: 503 });
  }
  return pg;
}

const memoryParticipantLockTails = new WeakMap<MemoryPg, Map<string, Promise<void>>>();

export async function withCollaborationParticipantLock<T>(
  pg: PgQueryable,
  input: { tenantId: string; sessionId: string; identity: string },
  fn: (lockedPg: PgQueryable) => Promise<T>
): Promise<T> {
  const lockKey = `${input.tenantId}\u0000${input.sessionId}\u0000${input.identity}`;
  if (pg instanceof MemoryPg) {
    let locks = memoryParticipantLockTails.get(pg);
    if (!locks) {
      locks = new Map();
      memoryParticipantLockTails.set(pg, locks);
    }
    const previous = locks.get(lockKey) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    locks.set(lockKey, current);
    await previous;
    try {
      return await fn(pg);
    } finally {
      release();
      if (locks.get(lockKey) === current) locks.delete(lockKey);
    }
  }
  return withPgTransaction(pg, async (transactionPg) => {
    const lock = await transactionPg.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS acquired',
      [`${input.tenantId}:${input.sessionId}`, input.identity]
    );
    if (lock.rows[0]?.acquired !== true) {
      throw Object.assign(new Error('collaboration participant update in progress; retry request'), {
        status: 409,
        code: 'collaboration_participant_busy',
        retryable: true
      });
    }
    return fn(transactionPg);
  });
}

function requireMediaDb(db: unknown): unknown {
  if (!db) {
    throw Object.assign(new Error('media database is required for Web Assist media join'), { status: 503 });
  }
  return db;
}

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string {
  const normalizedKey = key.toLowerCase();
  const value = headers[key] ?? headers[normalizedKey] ?? Object.entries(headers)
    .find(([name]) => name.toLowerCase() === normalizedKey)?.[1];
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function collaborationActorIdentity(
  ctx: ReturnType<typeof requireAuth>,
  headers: Record<string, string | string[] | undefined>
): string {
  if (ctx.role === 'system') return headerValue(headers, 'x-user-id').trim() || ctx.userId;
  return ctx.userId;
}

function collaborationRequestActorIdentity(
  ctx: ReturnType<typeof requireAuth>,
  headers: Record<string, string | string[] | undefined>,
  input: Record<string, unknown>
): string {
  const authenticated = collaborationActorIdentity(ctx, headers);
  const supplied = String(input.actor_identity || '').trim();
  const bearer = headerValue(headers, 'authorization').startsWith('Bearer ');
  if (bearer && supplied && supplied !== authenticated) {
    throw Object.assign(new Error('actor_identity must match authenticated identity'), { status: 403 });
  }
  return bearer ? authenticated : supplied || authenticated;
}

function canManageCollaborationParticipants(
  ctx: ReturnType<typeof requireAuth>,
  participant: CollaborationParticipant | null
): boolean {
  return ctx.role === 'system' || ctx.role === 'owner' || ctx.role === 'admin' ||
    participant?.role === 'supervisor' || participant?.role === 'admin';
}

function collaborationParticipantRole(value: unknown): CollaborationParticipantRole | null {
  const role = String(value || '').trim();
  return ['customer', 'agent', 'engineer', 'supervisor', 'ai', 'admin'].includes(role)
    ? role as CollaborationParticipantRole
    : null;
}

function creatorParticipantRole(ctx: ReturnType<typeof requireAuth>): CollaborationParticipantRole {
  if (ctx.role === 'owner' || ctx.role === 'admin') return 'admin';
  if (ctx.role === 'viewer') return 'customer';
  return 'agent';
}

function rustDeskPolicyMutationAuthorizationError(
  ctx: ReturnType<typeof requireAuth>,
  headers: Record<string, string | string[] | undefined>
) {
  const bearer = headerValue(headers, 'authorization').startsWith('Bearer ');
  if (bearer && (ctx.role === 'owner' || ctx.role === 'admin')) return null;
  return {
    status: 403,
    data: { error: 'RustDesk access policy changes require an owner or admin JWT' }
  };
}

function rustDeskPolicyInputError(
  input: Record<string, unknown>,
  action: 'configure' | 'revoke'
): string {
  if (containsSensitivePolicyField(input)) return 'sensitive access policy fields are not allowed';
  if ('approved_by' in input || 'approver' in input || 'actor_identity' in input || 'actor' in input) {
    return 'RustDesk access policy approver comes from authenticated context';
  }
  const allowed = action === 'configure'
    ? new Set(['mode', 'allowed_scopes', 'business_ref', 'expires_at', 'reason'])
    : new Set(['reason']);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) return `unsupported RustDesk access policy field: ${unknown}`;
  if (action === 'configure') {
    const businessRef = bodyObject(input.business_ref);
    const unknownRef = Object.keys(businessRef).find((key) => key !== 'type' && key !== 'id');
    if (unknownRef) return `unsupported RustDesk access policy business_ref field: ${unknownRef}`;
  }
  if (!String(input.reason || '').trim()) return 'reason is required';
  return '';
}

function containsSensitivePolicyField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSensitivePolicyField);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return /password|secret|token|credential/.test(normalized) || containsSensitivePolicyField(nested);
  });
}

async function routeRustDeskDeviceHeartbeat(input: {
  pg: PgQueryable;
  tenantId: string;
  deviceId: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  fallbackActorIdentity: string;
}): Promise<unknown> {
  const payload = bodyObject(input.body);
  const metadata = bodyObject(payload.metadata);
  let actorIdentity = String(payload.actor_identity || input.fallbackActorIdentity || '').trim();
  if (!actorIdentity) {
    return { status: 400, data: { error: 'actor_identity is required' } };
  }
  const devices = new RustDeskDeviceStore(input.pg);
  if (metadata.disconnect_command_capable === true) {
    const edgeToken = headerValue(input.headers, 'x-rustdesk-edge-token').trim();
    if (!edgeToken) {
      throw Object.assign(
        new Error('RustDesk edge command token is required for capable heartbeat'),
        { status: 401 }
      );
    }
    const identity = verifyRustDeskEdgeCommandToken(
      edgeToken,
      String(process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET || '')
    );
    const device = await devices.getDevice({
      tenant_id: input.tenantId,
      device_id: input.deviceId
    });
    if (
      identity.tenant_id !== input.tenantId ||
      !device ||
      device.rustdesk_id !== identity.rustdesk_id
    ) {
      throw Object.assign(new Error('rustdesk device not found'), { status: 404 });
    }
    actorIdentity = identity.edge_instance_id;
    metadata.edge_instance_id = identity.edge_instance_id;
  }
  const device = await devices.heartbeatDevice({
    tenant_id: input.tenantId,
    device_id: input.deviceId,
    actor_identity: actorIdentity,
    runtime_status: payload.runtime_status
      ? String(payload.runtime_status) as 'online' | 'offline'
      : undefined,
    seen_at: payload.seen_at ? String(payload.seen_at) : undefined,
    metadata
  });
  if (!device) return { status: 404, data: { error: 'rustdesk device not found' } };
  return { status: 201, data: device };
}

function requireRustDeskGatewayAuth(headers: Record<string, string | string[] | undefined>): null | { status: number; data: { error: string } } {
  const token = String(process.env.OPC_RUSTDESK_API_TOKEN || process.env.OPC_REMOTE_GATEWAY_API_TOKEN || '').trim();
  if (!token) return { status: 503, data: { error: 'RustDesk gateway token is not configured' } };
  const authorization = headerValue(headers, 'authorization');
  if (authorization !== `Bearer ${token}`) {
    return { status: 401, data: { error: 'invalid RustDesk gateway token' } };
  }
  return null;
}

function bodyObject(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function businessRefFromInput(tenantId: string, input: Record<string, unknown>): BusinessRef {
  const raw = bodyObject(input.business_ref);
  const type = String(raw.type || input.business_ref_type || '').trim();
  const id = String(raw.id || input.business_ref_id || '').trim();
  if (!type || !id) {
    throw Object.assign(new Error('business_ref.type and business_ref.id are required'), { status: 400 });
  }
  return {
    tenant_id: String(raw.tenant_id || tenantId),
    type,
    id,
    display_name: raw.display_name ? String(raw.display_name) : undefined,
    metadata: bodyObject(raw.metadata || input.business_ref_metadata)
  };
}

function queryBusinessRef(tenantId: string, url: URL): BusinessRef {
  const type = String(url.searchParams.get('business_ref_type') || '').trim();
  const id = String(url.searchParams.get('business_ref_id') || '').trim();
  if (!type || !id) {
    throw Object.assign(new Error('business_ref_type and business_ref_id are required'), { status: 400 });
  }
  return { tenant_id: tenantId, type, id };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

const REMOTE_CONSENT_SCOPES = new Set<RemoteConsentScope>([
  'view_screen',
  'control_mouse_keyboard',
  'record_screen',
  'transfer_file',
  'clipboard'
]);

function remoteConsentScopes(value: unknown): RemoteConsentScope[] {
  const scopes = stringArray(value);
  return scopes as RemoteConsentScope[];
}

function unsupportedRemoteConsentScope(scopes: readonly string[]): string {
  return scopes.find((scope) => !REMOTE_CONSENT_SCOPES.has(scope as RemoteConsentScope)) || '';
}

function unsupportedRemoteConsentScopeResponse(scopes: readonly string[]) {
  const unsupportedScope = unsupportedRemoteConsentScope(scopes);
  if (!unsupportedScope) return null;
  return { status: 400, data: { error: `unsupported remote consent scope: ${unsupportedScope}` } };
}

const CHAT_MESSAGE_TYPES = new Set(['text', 'image', 'video', 'file', 'system']);
const CHAT_ATTACHMENT_KINDS = new Set(['image', 'video', 'audio', 'file', 'screen_recording']);
const CHAT_ATTACHMENT_STATUSES = new Set(['pending', 'ready', 'failed']);
const ATTACHMENT_TEXT_METADATA_KEYS = [
  'ocr_text',
  'extracted_text',
  'transcript',
  'asr_text',
  'quality_text'
];

function chatMessageType(value: unknown): CollaborationMessage['message_type'] {
  const type = String(value || 'text').trim() || 'text';
  if (!CHAT_MESSAGE_TYPES.has(type)) {
    throw Object.assign(new Error('unsupported message_type'), { status: 400 });
  }
  return type as CollaborationMessage['message_type'];
}

function parseChatAttachments(value: unknown): CollaborationMessageAttachmentInput[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const raw = bodyObject(item);
    const kind = String(raw.kind || raw.type || 'file').trim() || 'file';
    if (!CHAT_ATTACHMENT_KINDS.has(kind)) {
      throw Object.assign(new Error('unsupported attachment kind'), { status: 400 });
    }
    const storageUrl = String(raw.storage_url || raw.url || '').trim();
    if (!storageUrl) {
      throw Object.assign(new Error('attachment storage_url required'), { status: 400 });
    }
    const processingStatus = String(raw.processing_status || 'ready').trim() || 'ready';
    if (!CHAT_ATTACHMENT_STATUSES.has(processingStatus)) {
      throw Object.assign(new Error('unsupported attachment processing_status'), { status: 400 });
    }
    return {
      kind: kind as CollaborationMessageAttachmentInput['kind'],
      storage_url: storageUrl,
      filename: raw.filename ? String(raw.filename) : undefined,
      content_type: raw.content_type ? String(raw.content_type) : undefined,
      size_bytes: raw.size_bytes == null ? undefined : Number(raw.size_bytes),
      checksum: raw.checksum ? String(raw.checksum) : undefined,
      processing_status: processingStatus as CollaborationMessageAttachmentInput['processing_status'],
      metadata: bodyObject(raw.metadata)
    };
  });
}

function providerMessageBody(messageType: CollaborationMessage['message_type'], body: string, attachments: CollaborationMessageAttachmentInput[]): string {
  if (body.trim()) return body.trim();
  const names = attachments.map((attachment) => attachment.filename || attachment.storage_url).filter(Boolean);
  if (names.length) return names.join('\n');
  return `[${messageType}]`;
}

function policyScanText(body: string, attachments: Array<{ metadata?: Record<string, unknown> }>): string {
  const chunks = [body];
  for (const attachment of attachments) {
    const metadata = attachment.metadata || {};
    for (const key of ATTACHMENT_TEXT_METADATA_KEYS) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim()) chunks.push(value);
    }
  }
  return chunks.join('\n');
}

function attachmentProcessingService(
  pg: PgQueryable,
  options: RouteCollaborationApiOptions
): AttachmentProcessingService {
  const configuredProviders = {
    ocr: configuredOcrProvider(),
    asr: configuredAsrProvider()
  };
  return new AttachmentProcessingService({
    pg,
    ...options.attachmentProcessing,
    providers: options.attachmentProcessing?.providers || configuredProviders
  });
}

function qualityReviewService(
  pg: PgQueryable,
  options: RouteCollaborationApiOptions
): { service: QualityReviewService; provider: QualityReviewProvider | null } {
  const provider = options.qualityReview?.provider === undefined
    ? configuredQualityReviewProvider()
    : options.qualityReview.provider;
  return {
    service: new QualityReviewService({
      pg,
      ...options.qualityReview,
      provider
    }),
    provider
  };
}

function qualityReviewAutoEnqueue(
  provider: QualityReviewProvider | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = String(env.OPC_QUALITY_REVIEW_AUTO_ENQUEUE || '').trim();
  if (value && value !== '0' && value !== '1') {
    throw new Error('OPC_QUALITY_REVIEW_AUTO_ENQUEUE must be 0 or 1');
  }
  return value === '1' || (value !== '0' && provider !== null);
}

function attachmentUploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES || '26214400';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1_073_741_824) {
    throw new Error('OPC_COLLABORATION_ATTACHMENT_MAX_BYTES must be an integer between 1 and 1073741824');
  }
  return value;
}

function attachmentContentTypeAllowed(kind: string, contentType: string): boolean {
  if (kind === 'image') return contentType.startsWith('image/');
  if (kind === 'audio') return contentType.startsWith('audio/');
  if (kind === 'video' || kind === 'screen_recording') return contentType.startsWith('video/');
  return Boolean(contentType);
}

function attachmentNeedsProcessing(kind: string): boolean {
  return kind === 'image' || kind === 'audio' || kind === 'video';
}

function configuredRemoteGatewayClient(env: NodeJS.ProcessEnv = process.env): RemoteGatewayClient {
  const provider = String(env.OPC_REMOTE_GATEWAY_PROVIDER || 'rustdesk').trim().toLowerCase() as RemoteGatewayProvider;
  const isRustDesk = provider === 'rustdesk';
  const baseUrl = String(
    (isRustDesk ? env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL : '') ||
    env.OPC_REMOTE_GATEWAY_BASE_URL ||
    ''
  ).trim();
  const apiToken = String(
    (isRustDesk ? env.OPC_RUSTDESK_API_TOKEN : '') ||
    env.OPC_REMOTE_GATEWAY_API_TOKEN ||
    ''
  ).trim();
  if (!provider || !baseUrl || !apiToken) {
    throw Object.assign(new Error('remote gateway provider, base URL and API token are required'), { status: 503 });
  }
  const input = {
    base_url: baseUrl,
    api_token: apiToken,
    create_path: env.OPC_REMOTE_GATEWAY_CREATE_PATH || undefined,
    session_path: env.OPC_REMOTE_GATEWAY_SESSION_PATH || undefined,
    audit_path: env.OPC_REMOTE_GATEWAY_AUDIT_PATH || undefined
  };
  if (provider === 'meshcentral') return createMeshCentralGatewayClient(input);
  if (provider === 'guacamole') return createGuacamoleGatewayClient(input);
  if (isRustDesk) return createRustDeskGatewayClient(input);
  throw Object.assign(new Error('unsupported remote gateway provider'), { status: 503 });
}

function remoteGatewayTargetFromInput(input: Record<string, unknown>): RemoteGatewayTarget {
  const raw = bodyObject(input.target);
  const id = String(raw.id || input.target_id || '').trim();
  if (!id) {
    throw Object.assign(new Error('remote gateway target id is required'), { status: 400 });
  }
  return {
    type: String(raw.type || input.target_type || 'device').trim() || 'device',
    id,
    display_name: raw.display_name ? String(raw.display_name) : undefined
  };
}

function tenantIdForRustDeskControlPlane(input: Record<string, unknown>): string {
  const metadata = bodyObject(input.metadata);
  return String(metadata.tenant_id || input.tenant_id || '').trim();
}

function createLocalRustDeskGatewayClient(pg: PgQueryable): RemoteGatewayClient {
  const store = new RustDeskGatewaySessionStore(pg);
  const physicalDisconnect = new RustDeskPhysicalDisconnectService(pg);
  return {
    provider: 'rustdesk',
    createSession: async (input) => {
      const metadata = rustDeskGatewayMetadata(input.metadata);
      const tenantId = String(metadata.tenant_id || '').trim();
      if (!tenantId) {
        throw Object.assign(new Error('tenant_id is required'), { status: 400 });
      }
      const externalId = pgId('rdgw');
      const session = await store.createSession({
        external_id: externalId,
        tenant_id: tenantId,
        target: input.target,
        permissions: [...input.permissions],
        actor_identity: input.actor_identity,
        launch_url: rustDeskLaunchUrl(externalId),
        metadata: rustDeskRuntimeMetadata({ metadata }, input.target)
      });
      return {
        provider: 'rustdesk',
        external_id: session.external_id,
        launch_url: session.launch_url,
        target: session.target,
        permissions: session.permissions,
        metadata: session.metadata
      };
    },
    endSession: async (input) => {
      const ended = await physicalDisconnect.endGatewaySession({
        external_id: input.external_id,
        actor_identity: input.actor_identity,
        requested_reason: input.reason || 'gateway_ended'
      });
      return { physical_disconnect: ended.physical_disconnect };
    },
    listAuditEvents: async (input) => {
      const events = await store.listAuditEvents(input);
      if (!events) throw Object.assign(new Error('rustdesk gateway session not found'), { status: 404 });
      return events;
    }
  };
}

async function syncLocalRustDeskGatewayTimeline(input: {
  module: CollaborationModule;
  pg: PgQueryable;
  tenantId: string;
  session: RustDeskGatewaySession;
  actorIdentity: string;
  endMatchingTool?: boolean;
}): Promise<void> {
  const remoteSessionId = String(input.session.metadata.remote_session_id || '').trim();
  if (!remoteSessionId) return;
  const remote = await requireRemoteSession(input.module.remote, input.tenantId, remoteSessionId);
  if (!remote) return;
  await input.module.remote.syncGatewayAuditEvents({
    tenant_id: input.tenantId,
    remote_session_id: remote.id,
    actor_identity: input.actorIdentity,
    client: createLocalRustDeskGatewayClient(input.pg),
    external_id: input.session.external_id
  });
  if (!input.endMatchingTool) return;
  const toolSessions = await input.module.remote.listToolSessions(remote.id, 100);
  const matchingTool = [...toolSessions].reverse().find((tool) =>
    tool.provider === 'rustdesk' &&
    tool.external_id === input.session.external_id
  );
  if (matchingTool && matchingTool.status !== 'ended') {
    await input.module.remote.endToolSession(matchingTool.id, input.actorIdentity);
  }
}

async function resolveRemoteGatewayRequest(input: {
  module: CollaborationModule;
  tenantId: string;
  provider: RemoteGatewayProvider;
  body: Record<string, unknown>;
}): Promise<{ target: RemoteGatewayTarget; metadata: Record<string, unknown>; deviceId?: string }> {
  const target = remoteGatewayTargetFromInput(input.body);
  const metadata = input.provider === 'rustdesk'
    ? rustDeskGatewayMetadata(input.body.metadata)
    : bodyObject(input.body.metadata);
  if (
    input.provider === 'rustdesk' &&
    rustDeskRequirePhysicalDisconnect() &&
    (target.type !== 'device' || metadata.rustdesk_target_mode === 'raw_id')
  ) {
    throw Object.assign(new Error('rustdesk physical disconnect requires a registered device'), { status: 409 });
  }
  if (input.provider !== 'rustdesk' || target.type !== 'device' || metadata.rustdesk_target_mode === 'raw_id') {
    return { target, metadata };
  }
  const device = await input.module.rustdeskDevices.getDevice({
    tenant_id: input.tenantId,
    device_id: target.id
  });
  if (!device || device.status !== 'active') {
    throw Object.assign(new Error('rustdesk device not found'), { status: 404 });
  }
  assertRustDeskDeviceOnlineIfRequired(device);
  assertRustDeskPhysicalDisconnectCapableIfRequired(device);
  return {
    target: {
      type: 'device',
      id: device.rustdesk_id,
      display_name: target.display_name || device.display_name
    },
    metadata: {
      ...metadata,
      rustdesk_target_mode: 'registered_device',
      rustdesk_device_id: device.id,
      rustdesk_id: device.rustdesk_id,
      target_id: device.id,
      target_display_name: device.display_name,
      rustdesk_device_runtime_status: device.runtime_status,
      rustdesk_device_last_seen_at: device.last_seen_at || '',
      rustdesk_device_last_seen_actor: device.last_seen_actor || '',
      business_ref_type: device.business_ref_type,
      business_ref_id: device.business_ref_id
    },
    deviceId: device.id
  };
}

function isConfiguredGatewayProvider(value: unknown): value is RemoteGatewayProvider {
  return value === 'meshcentral' || value === 'guacamole' || value === 'rustdesk';
}

function hasActiveGatewayToolSession(tools: RemoteToolSession[]): boolean {
  return tools.some((tool) => {
    const gatewayProvider = String(tool.metadata.gateway_provider || '');
    return tool.status === 'active' && isConfiguredGatewayProvider(gatewayProvider);
  });
}

function isGatewayToolSession(tool: RemoteToolSession): boolean {
  const gatewayProvider = String(tool.metadata.gateway_provider || '');
  return isConfiguredGatewayProvider(gatewayProvider);
}

async function remoteGatewayClientForToolSession(
  tool: RemoteToolSession,
  pg: PgQueryable | null
): Promise<RemoteGatewayClient> {
  if (tool.provider === 'rustdesk' && pg) {
    const session = await new RustDeskGatewaySessionStore(pg).getSession(tool.external_id);
    if (session && session.tenant_id === tool.tenant_id) {
      return createLocalRustDeskGatewayClient(pg);
    }
  }
  return configuredRemoteGatewayClient();
}

type CollaborationModule = ReturnType<typeof createCollaborationModule>;

function tinodeClientWsUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    String(env.TINODE_PUBLIC_WS_URL || '').trim() ||
    defaultTinodeClientWsUrl(String(env.TINODE_PUBLIC_BASE_URL || '').trim()) ||
    String(env.TINODE_WS_URL || '').trim() ||
    defaultTinodeClientWsUrl(String(env.TINODE_BASE_URL || '').trim());
  if (!raw) return '';
  const clientUrl = new URL(raw);
  const apiKey = String(env.TINODE_API_KEY || '').trim();
  if (apiKey && !clientUrl.searchParams.has('apikey')) {
    clientUrl.searchParams.set('apikey', apiKey);
  }
  return clientUrl.toString();
}

function defaultTinodeClientWsUrl(baseUrl: string): string {
  if (!baseUrl) return '';
  const url = new URL(baseUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  url.pathname = '/v0/channels';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function toWebAssistEvent(audit: RemoteAuditEvent) {
  return {
    id: audit.id,
    tenant_id: audit.tenant_id,
    remote_session_id: audit.remote_session_id,
    actor_identity: audit.actor_identity,
    event_type: String(audit.metadata.web_assist_event_type || audit.event_type),
    payload: (audit.metadata.payload as Record<string, unknown> | undefined) || {},
    created_at: audit.created_at
  };
}

function webAssistMediaRoomName(remote: RemoteAssistanceSession): string {
  const roomName = remote.metadata.media_room_name;
  if (typeof roomName !== 'string' || !roomName.trim()) {
    throw Object.assign(new Error('Web Assist media room is not configured'), { status: 409 });
  }
  return roomName;
}

function webAssistRecordingFormat(value: unknown): 'mp4' | 'webm' | 'wav' | 'ogg' {
  return value === 'webm' || value === 'wav' || value === 'ogg' ? value : 'mp4';
}

async function issueWebAssistMediaJoin(input: {
  db: unknown;
  tenantId: string;
  remote: RemoteAssistanceSession;
  identity: string;
  role: 'agent' | 'customer';
}) {
  if (input.remote.mode !== 'web_remote_assist') {
    return { status: 400, data: { error: 'remote session is not Web Assist' } };
  }
  const roomName = webAssistMediaRoomName(input.remote);
  const media = createLiveKitMediaModule({ db: requireMediaDb(input.db) });
  const plan = await media.joins.prepareJoin('webrtc', {
    tenantId: input.tenantId,
    roomName,
    identity: input.identity,
    role: input.role,
    media: 'video',
    metadata: { remote_session_id: input.remote.id }
  });
  return { data: plan };
}

function sameBusinessRef(left: BusinessRef, right: { type?: string; id?: string } | null): boolean {
  return Boolean(right) && left.type === right?.type && left.id === right?.id;
}

async function recordAndBroadcastWebAssistEvent(input: {
  module: CollaborationModule;
  tenantId: string;
  remote: RemoteAssistanceSession;
  actorIdentity: string;
  eventType: string;
  payload: unknown;
}) {
  const audit = await input.module.remote.recordAudit({
    tenant_id: input.tenantId,
    remote_session_id: input.remote.id,
    actor_identity: input.actorIdentity,
    event_type: `remote.web_assist.${input.eventType}`,
    target: input.remote.id,
    metadata: {
      web_assist_event_type: input.eventType,
      payload: bodyObject(input.payload)
    }
  });
  const event = toWebAssistEvent(audit);
  wsBroadcast(input.tenantId, 'remote.web_assist.event', event);
  return event;
}

function safeFilename(value: string | null): string {
  const fallback = `evidence-${Date.now()}.bin`;
  const raw = String(value || fallback).split(/[\\/]/).pop() || fallback;
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_') || fallback;
}

function collaborationStorageUrl(uploaded: { storage_url: string; key: string }): string {
  if (isLocalObjectStorage()) {
    return `/api/collaboration/media/${uploaded.key}`;
  }
  return uploaded.storage_url;
}

function iveKitChatStorageUrl(key: string): string {
  return `/api/ivekit/chat/objects/${encodeURIComponent(key)}`;
}

async function ensureSessionChatBinding(input: {
  module: CollaborationModule;
  gateway: ReturnType<typeof configuredChatGateway>;
  tenantId: string;
  sessionId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}) {
  let binding = await input.module.sessions.getChatBinding({
    tenant_id: input.tenantId,
    session_id: input.sessionId,
    provider: input.gateway.provider
  });
  if (binding) return binding;
  const topic = await input.gateway.ensureTopic({
    tenant_id: input.tenantId,
    session_id: input.sessionId,
    title: input.title,
    metadata: input.metadata
  });
  binding = await input.module.sessions.ensureChatBinding({
    tenant_id: input.tenantId,
    session_id: input.sessionId,
    provider: topic.provider,
    provider_topic_id: topic.provider_topic_id,
    provider_status: topic.provider_status,
    metadata: topic.metadata
  });
  return binding;
}

function decodeLocalMediaKey(routePath: string): string | null {
  const rawKey = decodeURIComponent(routePath.slice('/api/collaboration/media/'.length));
  return decodeStorageKey(rawKey);
}

function decodeStorageKey(rawKey: string): string | null {
  const parts = rawKey.split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    return null;
  }
  return parts.join('/');
}

async function requireRemoteSession(
  remote: ReturnType<typeof createCollaborationModule>['remote'],
  tenantId: string,
  remoteSessionId: string
) {
  const session = await remote.getSession(remoteSessionId);
  if (!session || session.tenant_id !== tenantId) return null;
  return session;
}

async function routeRustDeskControlPlane(
  pg: PgQueryable,
  method: string,
  routePath: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  tenantScope = ''
) {
  const authError = requireRustDeskGatewayAuth(headers);
  if (authError) return authError;

  const sessionMatch = routePath.match(/^\/api\/opc\/rustdesk\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!tenantScope) {
    if (routePath === '/api/opc/rustdesk/client-config' && method === 'GET') {
      const config = rustDeskClientConfig();
      if (config.public_key_error) return { status: 500, data: { error: config.public_key_error } };
      if (config.api_server_error) return { status: 500, data: { error: config.api_server_error } };
      return { data: config };
    }

    let tenantId = '';
    if (routePath === '/api/opc/rustdesk/sessions' && method === 'POST') {
      const input = bodyObject(body);
      rustDeskGatewayMetadata(input, 'RustDesk gateway request');
      const metadata = rustDeskGatewayMetadata(input.metadata);
      if (
        hasRustDeskGatewayAccessModeAlias(metadata) ||
        hasRustDeskGatewayUnattendedAlias(metadata)
      ) {
        return { status: 400, data: { error: 'RustDesk access_mode must be a top-level field' } };
      }
      const accessMode = rustDeskGatewayAccessMode(input.access_mode);
      if (accessMode === 'unattended') {
        return {
          status: 403,
          data: { error: 'unattended RustDesk creation requires the policy-aware iveKit route' }
        };
      }
      const requestedPermissions = stringArray(input.permissions || input.scopes);
      const unsupportedPermission = unsupportedRemoteConsentScope(requestedPermissions);
      if (unsupportedPermission) {
        return { status: 400, data: { error: `unsupported RustDesk permission scope: ${unsupportedPermission}` } };
      }
      if (!remoteConsentScopes(requestedPermissions).length) {
        return { status: 400, data: { error: 'permissions required' } };
      }
      if (!String(input.actor_identity || '').trim()) {
        return { status: 400, data: { error: 'actor_identity is required' } };
      }
      remoteGatewayTargetFromInput(input);
      tenantId = tenantIdForRustDeskControlPlane(input);
    } else if (routePath === '/api/opc/rustdesk/sessions' && method === 'GET') {
      tenantId = String(url.searchParams.get('tenant_id') || '').trim();
    } else if (sessionMatch) {
      const externalId = decodeURIComponent(sessionMatch[1]);
      const resolved = await new RustDeskGatewaySessionStore(pg).getSignedLaunchSession(externalId);
      if (!resolved) return { status: 404, data: { error: 'RustDesk gateway session not found' } };
      tenantId = resolved.tenant_id;
    } else {
      return undefined;
    }
    if (!tenantId) return { status: 400, data: { error: 'tenant_id is required' } };
    return withPgTenant(pg, tenantId, (scopedPg) =>
      routeRustDeskControlPlane(scopedPg, method, routePath, url, body, headers, tenantId)
    );
  }

  const store = new RustDeskGatewaySessionStore(pg);
  const physicalDisconnect = new RustDeskPhysicalDisconnectService(pg);

  if (routePath === '/api/opc/rustdesk/sessions' && method === 'POST') {
    const input = bodyObject(body);
    rustDeskGatewayMetadata(input, 'RustDesk gateway request');
    const inputMetadata = rustDeskGatewayMetadata(input.metadata);
    if (
      hasRustDeskGatewayAccessModeAlias(inputMetadata) ||
      hasRustDeskGatewayUnattendedAlias(inputMetadata)
    ) {
      return { status: 400, data: { error: 'RustDesk access_mode must be a top-level field' } };
    }
    const accessMode = rustDeskGatewayAccessMode(input.access_mode);
    if (accessMode === 'unattended') {
      return {
        status: 403,
        data: { error: 'unattended RustDesk creation requires the policy-aware iveKit route' }
      };
    }
    const requestedPermissions = stringArray(input.permissions || input.scopes);
    const unsupportedPermission = unsupportedRemoteConsentScope(requestedPermissions);
    if (unsupportedPermission) {
      return { status: 400, data: { error: `unsupported RustDesk permission scope: ${unsupportedPermission}` } };
    }
    const permissions = remoteConsentScopes(requestedPermissions);
    if (!permissions.length) return { status: 400, data: { error: 'permissions required' } };
    const actorIdentity = String(input.actor_identity || '').trim();
    if (!actorIdentity) return { status: 400, data: { error: 'actor_identity is required' } };
    const target = remoteGatewayTargetFromInput(input);
    const remoteSessionId = String(input.remote_session_id || '').trim();
    const deviceId = String(input.device_id || '').trim();
    if (remoteSessionId) {
      await new RemoteAssistanceStore(pg).authorizeRustDeskGatewayCreation({
        tenant_id: tenantScope,
        remote_session_id: remoteSessionId,
        target,
        permissions,
        access_mode: 'attended',
        device_id: deviceId || undefined,
        metadata: inputMetadata
      });
    }
    const metadata = rustDeskRuntimeMetadata(input, target);
    if (input.access_mode !== undefined) metadata.access_mode = accessMode;
    if (rustDeskRequirePhysicalDisconnect()) {
      const deviceId = String(metadata.rustdesk_device_id || '').trim();
      if (!deviceId) {
        throw Object.assign(new Error('rustdesk physical disconnect requires a registered device'), { status: 409 });
      }
      const device = await new RustDeskDeviceStore(pg).getDevice({
        tenant_id: tenantScope,
        device_id: deviceId
      });
      if (!device || device.status !== 'active' || device.rustdesk_id !== target.id) {
        throw Object.assign(new Error('rustdesk device not found'), { status: 404 });
      }
      assertRustDeskPhysicalDisconnectCapableIfRequired(device);
    }
    const externalId = pgId('rdgw');
    const session = await store.createSession({
      external_id: externalId,
      tenant_id: tenantScope,
      target,
      permissions,
      actor_identity: actorIdentity,
      launch_url: rustDeskLaunchUrl(externalId),
      metadata
    });
    return {
      status: 201,
      data: {
        external_id: session.external_id,
        launch_url: session.launch_url,
        target: session.target,
        permissions: session.permissions,
        metadata: session.metadata
      }
    };
  }

  if (routePath === '/api/opc/rustdesk/sessions' && method === 'GET') {
    const status = rustDeskGatewaySessionStatus(url.searchParams.get('status') || 'active');
    if (status === 'invalid') {
      return { status: 400, data: { error: 'status must be active, ended, or all' } };
    }
    const limit = rustDeskGatewaySessionLimit(url.searchParams.get('limit'));
    if (limit === 'invalid') {
      return { status: 400, data: { error: 'limit must be an integer from 1 to 200' } };
    }
    const sessions = await store.listSessions({
      tenant_id: tenantScope,
      status: status === 'all' ? undefined : status,
      limit
    });
    return { data: { sessions } };
  }

  if (sessionMatch) {
    const externalId = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2] || '';
    if (action === 'launch' && method === 'GET') {
      const session = await store.getSession(externalId);
      if (!session) return { status: 404, data: { error: 'RustDesk gateway session not found' } };
      return { data: rustDeskLaunchPlan(session) };
    }
    if (action === 'audit' && method === 'GET') {
      const since = rustDeskGatewaySince(url.searchParams.get('since'));
      if (since === 'invalid') {
        return { status: 400, data: { error: 'since must be an ISO timestamp' } };
      }
      const events = await store.listAuditEvents({
        external_id: externalId,
        since: since || undefined
      });
      if (!events) return { status: 404, data: { error: 'RustDesk gateway session not found' } };
      return { data: { events } };
    }
    if (action === 'events' && method === 'POST') {
      const input = bodyObject(body);
      const eventType = String(input.event_type || '').trim();
      if (!eventType) return { status: 400, data: { error: 'event_type is required' } };
      const actorIdentity = String(input.actor_identity || '').trim();
      if (!actorIdentity) return { status: 400, data: { error: 'actor_identity is required' } };
      const occurredAt = String(input.occurred_at || '').trim();
      if (occurredAt && Number.isNaN(new Date(occurredAt).getTime())) {
        return { status: 400, data: { error: 'occurred_at must be an ISO timestamp' } };
      }
      const metadata = rustDeskGatewayMetadata(input.metadata, 'RustDesk gateway event metadata');
      const eventValidationError = rustDeskGatewayEventValidationError(eventType, metadata);
      if (eventValidationError) return { status: 400, data: { error: eventValidationError } };
      const session = await store.getSession(externalId);
      if (!session) return { status: 404, data: { error: 'RustDesk gateway session not found' } };
      if (session.status !== 'active') {
        return { status: 409, data: { error: 'RustDesk gateway session is not active' } };
      }
      const permissionError = rustDeskGatewayEventPermissionError(eventType, metadata, session.permissions);
      if (permissionError) return { status: 403, data: { error: permissionError } };
      const event = await store.appendAuditEvent({
        external_id: externalId,
        event_type: eventType,
        actor_identity: actorIdentity,
        target: String(input.target || '').trim() || undefined,
        idempotency_key: String(input.idempotency_key || '').trim() || undefined,
        metadata,
        occurred_at: occurredAt || undefined
      });
      if (!event) return { status: 404, data: { error: 'RustDesk gateway session not found' } };
      return { status: 201, data: { event } };
    }
    if (!action && method === 'DELETE') {
      const input = bodyObject(body);
      const actorIdentity = String(input.actor_identity || '').trim();
      if (!actorIdentity) return { status: 400, data: { error: 'actor_identity is required' } };
      await physicalDisconnect.endGatewaySession({
        external_id: externalId,
        actor_identity: actorIdentity,
        requested_reason: String(input.reason || 'gateway_ended') as 'consent_revoked' | 'remote_session_ended' | 'tool_ended' | 'gateway_ended'
      });
      return { status: 204, data: null };
    }
  }

  return undefined;
}

function rustDeskGatewaySessionStatus(value: string): 'active' | 'ended' | 'all' | 'invalid' {
  const normalized = String(value || 'active').trim().toLowerCase();
  if (normalized === 'active' || normalized === 'ended' || normalized === 'all') return normalized;
  return 'invalid';
}

function rustDeskGatewaySessionLimit(value: string | null): number | 'invalid' {
  const raw = String(value || '').trim();
  if (!raw) return 50;
  if (!/^\d+$/.test(raw)) return 'invalid';
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return 'invalid';
  return limit;
}

function rustDeskGatewaySince(value: string | null): string | null | 'invalid' {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (Number.isNaN(new Date(raw).getTime())) return 'invalid';
  return raw;
}

async function routeRustDeskLaunchPage(pg: PgQueryable, url: URL) {
  const externalId = String(url.searchParams.get('session_id') || '').trim();
  if (!externalId) return { status: 400, data: { error: 'session_id is required' } };
  const token = String(url.searchParams.get('token') || '').trim();
  const expiresAt = String(url.searchParams.get('expires_at') || '').trim();
  if (!isValidRustDeskLaunchToken(externalId, token, expiresAt)) {
    return { status: 401, data: { error: 'invalid RustDesk launch token' } };
  }
  const session = await new RustDeskGatewaySessionStore(pg).getSignedLaunchSession(externalId);
  if (!session) return { status: 404, data: { error: 'RustDesk gateway session not found' } };
  if (session.status !== 'active') {
    return { status: 409, data: { error: 'RustDesk gateway session is not active' } };
  }
  return { html: rustDeskLaunchHtml(rustDeskLaunchPlan(session)) };
}

export async function routeCollaborationApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  options: RouteCollaborationApiOptions = {}
): Promise<unknown | undefined> {
  const routePath = path.split('?')[0];
  const isCollaborationRoute = routePath.startsWith('/api/collaboration/');
  const isIveKitRustDeskRoute = routePath.startsWith('/api/ivekit/rustdesk/');
  const isIveKitContextRoute = routePath.startsWith('/api/ivekit/context/');
  const isRustDeskControlPlaneRoute = routePath.startsWith('/api/opc/rustdesk/');
  const isRustDeskLaunchRoute = routePath === '/remote/rustdesk/launch';
  if (!isCollaborationRoute && !isIveKitRustDeskRoute && !isIveKitContextRoute &&
      !isRustDeskControlPlaneRoute && !isRustDeskLaunchRoute) {
    return undefined;
  }

  if (isRustDeskLaunchRoute) {
    if (method !== 'GET') return { status: 405, data: { error: 'method not allowed' } };
    return routeRustDeskLaunchPage(requirePg(pg), url);
  }

  const publicWebAssistVerifyMatch = routePath.match(
    /^\/api\/collaboration\/remote-assistance\/([^/]+)\/web-assist\/verify$/
  );
  if (publicWebAssistVerifyMatch && method === 'POST') {
    const input = bodyObject(body);
    const tenantId = String(input.tenant_id || url.searchParams.get('tenant_id') || '').trim();
    const tokenValue = String(input.token || url.searchParams.get('token') || '').trim();
    if (!tenantId || !tokenValue) {
      return { status: 400, data: { error: 'tenant_id and token are required' } };
    }
    const module = createCollaborationModule({ pg: requirePg(pg) });
    const remoteSessionId = decodeURIComponent(publicWebAssistVerifyMatch[1]);
    const remote = await module.remote.getSession(remoteSessionId);
    if (!remote || remote.tenant_id !== tenantId) {
      return { status: 404, data: { error: 'remote session not found' } };
    }
    if (remote.mode !== 'web_remote_assist') {
      return { status: 400, data: { error: 'remote session is not Web Assist' } };
    }
    const verified = verifyWebAssistJoinToken({
      tenant_id: tenantId,
      remote_session_id: remote.id,
      token: tokenValue
    });
    await module.remote.recordAudit({
      tenant_id: tenantId,
      remote_session_id: remote.id,
      actor_identity: verified.actor_identity,
      event_type: 'remote.web_assist.join_verified',
      target: remote.id,
      metadata: {
        role: verified.role,
        expires_at: verified.expires_at
      }
    });
    return {
      data: {
        tenant_id: verified.tenant_id,
        remote_session_id: verified.remote_session_id,
        actor_identity: verified.actor_identity,
        role: verified.role,
        expires_at: verified.expires_at
      }
    };
  }

  const publicWebAssistConsentMatch = routePath.match(
    /^\/api\/collaboration\/remote-assistance\/([^/]+)\/web-assist\/consent\/(grant|revoke)$/
  );
  if (publicWebAssistConsentMatch && method === 'POST') {
    const input = bodyObject(body);
    const tenantId = String(input.tenant_id || url.searchParams.get('tenant_id') || '').trim();
    const tokenValue = String(input.token || url.searchParams.get('token') || '').trim();
    if (!tenantId || !tokenValue) {
      return { status: 400, data: { error: 'tenant_id and token are required' } };
    }
    const requestedScopes = stringArray(input.scopes);
    const unsupportedScope = unsupportedRemoteConsentScopeResponse(requestedScopes);
    if (unsupportedScope) return unsupportedScope;
    const scopes = remoteConsentScopes(requestedScopes.length ? requestedScopes : ['view_screen', 'record_screen']);
    const module = createCollaborationModule({ pg: requirePg(pg) });
    const remoteSessionId = decodeURIComponent(publicWebAssistConsentMatch[1]);
    const remote = await module.remote.getSession(remoteSessionId);
    if (!remote || remote.tenant_id !== tenantId) {
      return { status: 404, data: { error: 'remote session not found' } };
    }
    if (remote.mode !== 'web_remote_assist') {
      return { status: 400, data: { error: 'remote session is not Web Assist' } };
    }
    const verified = verifyWebAssistJoinToken({
      tenant_id: tenantId,
      remote_session_id: remote.id,
      token: tokenValue
    });
    if (verified.role !== 'customer') {
      return { status: 403, data: { error: 'customer token required for Web Assist consent' } };
    }
    const action = publicWebAssistConsentMatch[2];
    const metadata = {
      ...bodyObject(input.metadata),
      source: 'web_assist_public',
      role: verified.role
    };
    if (action === 'grant') {
      return {
        status: 201,
        data: await module.remote.grantConsent({
          tenant_id: tenantId,
          remote_session_id: remote.id,
          actor_identity: verified.actor_identity,
          scopes,
          expires_at: input.expires_at ? String(input.expires_at) : verified.expires_at,
          metadata
        })
      };
    }
    return {
      status: 201,
      data: await module.remote.revokeConsent({
        tenant_id: tenantId,
        remote_session_id: remote.id,
        actor_identity: verified.actor_identity,
        scopes,
        metadata
      })
    };
  }

  const publicWebAssistRecordingStartMatch = routePath.match(
    /^\/api\/collaboration\/remote-assistance\/([^/]+)\/web-assist\/recordings\/start$/
  );
  if (publicWebAssistRecordingStartMatch && method === 'POST') {
    const input = bodyObject(body);
    const tenantId = String(input.tenant_id || url.searchParams.get('tenant_id') || '').trim();
    const tokenValue = String(input.token || url.searchParams.get('token') || '').trim();
    if (!tenantId || !tokenValue) {
      return { status: 400, data: { error: 'tenant_id and token are required' } };
    }
    const pgDb = requirePg(pg);
    const module = createCollaborationModule({ pg: pgDb });
    const remoteSessionId = decodeURIComponent(publicWebAssistRecordingStartMatch[1]);
    const remote = await module.remote.getSession(remoteSessionId);
    if (!remote || remote.tenant_id !== tenantId) {
      return { status: 404, data: { error: 'remote session not found' } };
    }
    if (remote.mode !== 'web_remote_assist') {
      return { status: 400, data: { error: 'remote session is not Web Assist' } };
    }
    const verified = verifyWebAssistJoinToken({
      tenant_id: tenantId,
      remote_session_id: remote.id,
      token: tokenValue
    });
    if (verified.role !== 'customer') {
      return { status: 403, data: { error: 'customer token required for Web Assist recording' } };
    }
    if (!(await module.remote.hasActiveConsent(remote.id))) {
      return { status: 403, data: { error: 'active consent required before starting Web Assist recording' } };
    }
    const roomName = webAssistMediaRoomName(remote);
    const media = createLiveKitMediaModule({ db: requireMediaDb(options.db) });
    const recording = await media.recordings.startRecording(tenantId, null, roomName, {
      format: webAssistRecordingFormat(input.format),
      hasVideo: true,
      businessRef: remote.business_ref
    });
    const evidence = await recordMediaRecordingEvidence(pgDb, recording, {
      roomName,
      createdBy: verified.actor_identity
    });
    await recordAndBroadcastWebAssistEvent({
      module,
      tenantId,
      remote,
      actorIdentity: verified.actor_identity,
      eventType: 'recording.started',
      payload: {
        recording_id: recording.id,
        egress_id: recording.egress_id,
        evidence_record_id: evidence?.id || ''
      }
    });
    return {
      status: 201,
      data: {
        ...recording,
        evidence_record_id: evidence?.id || '',
        evidence_record: evidence
      }
    };
  }

  const publicWebAssistRecordingStopMatch = routePath.match(
    /^\/api\/collaboration\/remote-assistance\/([^/]+)\/web-assist\/recordings\/([^/]+)\/stop$/
  );
  if (publicWebAssistRecordingStopMatch && method === 'POST') {
    const input = bodyObject(body);
    const tenantId = String(input.tenant_id || url.searchParams.get('tenant_id') || '').trim();
    const tokenValue = String(input.token || url.searchParams.get('token') || '').trim();
    if (!tenantId || !tokenValue) {
      return { status: 400, data: { error: 'tenant_id and token are required' } };
    }
    const module = createCollaborationModule({ pg: requirePg(pg) });
    const remoteSessionId = decodeURIComponent(publicWebAssistRecordingStopMatch[1]);
    const egressId = decodeURIComponent(publicWebAssistRecordingStopMatch[2]);
    const remote = await module.remote.getSession(remoteSessionId);
    if (!remote || remote.tenant_id !== tenantId) {
      return { status: 404, data: { error: 'remote session not found' } };
    }
    if (remote.mode !== 'web_remote_assist') {
      return { status: 400, data: { error: 'remote session is not Web Assist' } };
    }
    const verified = verifyWebAssistJoinToken({
      tenant_id: tenantId,
      remote_session_id: remote.id,
      token: tokenValue
    });
    if (verified.role !== 'customer') {
      return { status: 403, data: { error: 'customer token required for Web Assist recording' } };
    }
    const media = createLiveKitMediaModule({ db: requireMediaDb(options.db) });
    const recording = media.recordings.getRecordingByEgressId(egressId);
    if (!recording || recording.tenant_id !== tenantId || !sameBusinessRef(remote.business_ref, recording.business_ref)) {
      return { status: 404, data: { error: 'Web Assist recording not found' } };
    }
    const stopped = await media.recordings.stopRecording(egressId);
    await recordAndBroadcastWebAssistEvent({
      module,
      tenantId,
      remote,
      actorIdentity: verified.actor_identity,
      eventType: 'recording.stopped',
      payload: {
        recording_id: recording.id,
        egress_id: recording.egress_id
      }
    });
    return { status: 201, data: stopped || recording };
  }

  const publicWebAssistEventsMatch = routePath.match(
    /^\/api\/collaboration\/remote-assistance\/([^/]+)\/web-assist\/events$/
  );
  if (publicWebAssistEventsMatch && method === 'POST') {
    const input = bodyObject(body);
    const tenantId = String(input.tenant_id || url.searchParams.get('tenant_id') || '').trim();
    const tokenValue = String(input.token || url.searchParams.get('token') || '').trim();
    if (!tenantId || !tokenValue) {
      return { status: 400, data: { error: 'tenant_id and token are required' } };
    }
    const eventType = String(input.event_type || '').trim();
    if (!eventType) return { status: 400, data: { error: 'event_type required' } };
    const module = createCollaborationModule({ pg: requirePg(pg) });
    const remoteSessionId = decodeURIComponent(publicWebAssistEventsMatch[1]);
    const remote = await module.remote.getSession(remoteSessionId);
    if (!remote || remote.tenant_id !== tenantId) {
      return { status: 404, data: { error: 'remote session not found' } };
    }
    if (remote.mode !== 'web_remote_assist') {
      return { status: 400, data: { error: 'remote session is not Web Assist' } };
    }
    const verified = verifyWebAssistJoinToken({
      tenant_id: tenantId,
      remote_session_id: remote.id,
      token: tokenValue
    });
    if (!(await module.remote.hasActiveConsent(remote.id))) {
      return { status: 403, data: { error: 'active consent required before recording Web Assist event' } };
    }
    const event = await recordAndBroadcastWebAssistEvent({
      module,
      tenantId,
      remote,
      actorIdentity: verified.actor_identity,
      eventType,
      payload: input.payload
    });
    return { status: 201, data: event };
  }

  const publicWebAssistMediaJoinMatch = routePath.match(
    /^\/api\/collaboration\/remote-assistance\/([^/]+)\/web-assist\/media\/join$/
  );
  if (publicWebAssistMediaJoinMatch && method === 'GET') {
    const tenantId = String(url.searchParams.get('tenant_id') || '').trim();
    const tokenValue = String(url.searchParams.get('token') || '').trim();
    if (!tenantId || !tokenValue) {
      return { status: 400, data: { error: 'tenant_id and token are required' } };
    }
    const module = createCollaborationModule({ pg: requirePg(pg) });
    const remoteSessionId = decodeURIComponent(publicWebAssistMediaJoinMatch[1]);
    const remote = await module.remote.getSession(remoteSessionId);
    if (!remote || remote.tenant_id !== tenantId) {
      return { status: 404, data: { error: 'remote session not found' } };
    }
    const verified = verifyWebAssistJoinToken({
      tenant_id: tenantId,
      remote_session_id: remote.id,
      token: tokenValue
    });
    if (!(await module.remote.hasActiveConsent(remote.id))) {
      return { status: 403, data: { error: 'active consent required before joining Web Assist media' } };
    }
    return issueWebAssistMediaJoin({
      db: options.db,
      tenantId,
      remote,
      identity: verified.actor_identity,
      role: verified.role === 'customer' ? 'customer' : 'agent'
    });
  }

  if (isRustDeskEdgeDeviceCommandRoute(method, routePath)) {
    const edgeToken = headerValue(headers, 'x-rustdesk-edge-token').trim();
    if (!edgeToken) {
      return { status: 401, data: { error: 'RustDesk edge command token is required' } };
    }
    const edgeSecret = String(process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET || '');
    let edgeIdentity;
    try {
      edgeIdentity = verifyRustDeskEdgeCommandToken(edgeToken, edgeSecret);
    } catch (error) {
      const status = Number((error as { status?: unknown }).status || 401);
      return {
        status,
        data: { error: status === 503 ? (error as Error).message : 'invalid RustDesk edge command token' }
      };
    }
    return withPgTenant(requirePg(pg), edgeIdentity.tenant_id, async (scopedPg) => {
      const scopedModule = createCollaborationModule({ pg: scopedPg });
      return routeRustDeskDeviceCommandApi({
        pg: scopedPg,
        method,
        routePath,
        body,
        tenantId: edgeIdentity.tenant_id,
        actorIdentity: edgeIdentity.edge_instance_id,
        expectedRustDeskId: edgeIdentity.rustdesk_id,
        onCommandChanged: async (command) => {
          const session = await new RustDeskGatewaySessionStore(scopedPg).getSession(command.external_id);
          if (!session || session.tenant_id !== edgeIdentity.tenant_id) return;
          await syncLocalRustDeskGatewayTimeline({
            module: scopedModule,
            pg: scopedPg,
            tenantId: edgeIdentity.tenant_id,
            session,
            actorIdentity: edgeIdentity.edge_instance_id
          });
        }
      });
    });
  }

  if (isRustDeskControlPlaneRoute) {
    return routeRustDeskControlPlane(requirePg(pg), method, routePath, url, body, headers);
  }

  const ctx = requireAuth(headers);

  if (routePath === '/api/ivekit/rustdesk/client-profile' && method === 'GET') {
    return {
      data: createRustDeskClientDistributionProfile({
        platform: url.searchParams.get('platform'),
        architecture: url.searchParams.get('architecture'),
        client_version: url.searchParams.get('client_version'),
        expected_server_version: url.searchParams.get('expected_server_version'),
        expected_server_key_fingerprint: url.searchParams.get('expected_server_key_fingerprint')
      }),
      headers: {
        'cache-control': 'private, no-store',
        vary: 'Authorization, X-API-Key, X-Tenant-Id, Origin'
      }
    };
  }

  if (routePath.startsWith('/api/collaboration/media/') && method === 'GET') {
    if (!isLocalObjectStorage()) return { status: 404, data: { error: 'media not available' } };
    const key = decodeLocalMediaKey(routePath);
    if (!key || !key.startsWith(`${ctx.tenantId}/`)) {
      return { status: 404, data: { error: 'not found' } };
    }
    const buffer = readLocalUpload(key);
    if (!buffer) return { status: 404, data: { error: 'not found' } };
    return { contentType: 'application/octet-stream', data: buffer };
  }

  if (routePath.startsWith('/api/collaboration/ivekit-objects/') && method === 'GET') {
    const key = decodeURIComponent(routePath.slice('/api/collaboration/ivekit-objects/'.length));
    if (!key.startsWith(`${ctx.tenantId}/`) || !decodeStorageKey(key)) {
      return { status: 404, data: { error: 'not found' } };
    }
    const buffer = await createObjectStorage().download(key, attachmentUploadMaxBytes());
    if (!buffer) return { status: 404, data: { error: 'not found' } };
    return { contentType: 'application/octet-stream', data: buffer };
  }

  const module = createCollaborationModule({ pg: requirePg(pg) });

  if (routePath === '/api/ivekit/context/timeline') {
    if (method !== 'GET') return { status: 405, data: { error: 'method not allowed' } };
    const businessRef = queryBusinessRef(ctx.tenantId, url);
    const system = ctx.role === 'system';
    const identity = system ? '' : collaborationActorIdentity(ctx, headers);
    const [chatSessions, mediaCalls] = await Promise.all([
      module.sessions.listByBusinessRef({
        tenant_id: ctx.tenantId,
        business_ref: businessRef,
        identity: identity || undefined,
        limit: 50
      }),
      new MediaCallStore(requirePg(pg)).listByBusinessRef({
        tenant_id: ctx.tenantId,
        business_ref: businessRef,
        identity: identity || undefined,
        limit: 50
      })
    ]);
    if (!system && chatSessions.length === 0 && mediaCalls.length === 0) {
      return { status: 404, data: { error: 'business timeline not found' } };
    }
    const visibleChatIds = new Set(chatSessions.map((session) => session.id));
    const remoteSessions = (await module.remote.listByBusinessRef({
      tenant_id: ctx.tenantId,
      business_ref: businessRef,
      limit: 50
    })).filter((session) => system || visibleChatIds.has(session.collaboration_session_id));
    return {
      data: await new IveKitUnifiedTimelineStore(requirePg(pg)).list({
        tenant_id: ctx.tenantId,
        business_ref: businessRef,
        chat_session_ids: chatSessions.map((session) => session.id),
        media_call_ids: mediaCalls.map((call) => call.id),
        remote_session_ids: remoteSessions.map((session) => session.id),
        system,
        cursor: url.searchParams.get('cursor') || undefined,
        limit: optionalQueryNumber(url.searchParams.get('limit'))
      }),
      headers: {
        'cache-control': 'private, no-store',
        vary: 'Authorization, X-API-Key, X-Tenant-Id, X-User-Id, Origin'
      }
    };
  }

  if (routePath === '/api/ivekit/context/by-ref') {
    if (method !== 'GET') return { status: 405, data: { error: 'method not allowed' } };
    const businessRef = queryBusinessRef(ctx.tenantId, url);
    const system = ctx.role === 'system';
    const identity = system ? '' : collaborationActorIdentity(ctx, headers);
    const [chatSessions, mediaCalls] = await Promise.all([
      module.sessions.listByBusinessRef({
        tenant_id: ctx.tenantId,
        business_ref: businessRef,
        identity: identity || undefined,
        limit: 50
      }),
      new MediaCallStore(requirePg(pg)).listByBusinessRef({
        tenant_id: ctx.tenantId,
        business_ref: businessRef,
        identity: identity || undefined,
        limit: 50
      })
    ]);
    if (!system && chatSessions.length === 0 && mediaCalls.length === 0) {
      return { status: 404, data: { error: 'business context not found' } };
    }

    const visibleChatIds = new Set(chatSessions.map((session) => session.id));
    const remoteSessions = (await module.remote.listByBusinessRef({
      tenant_id: ctx.tenantId,
      business_ref: businessRef,
      limit: 50
    })).filter((session) => system || visibleChatIds.has(session.collaboration_session_id));
    const devices = system || chatSessions.length > 0
      ? await module.rustdeskDevices.getByBusinessRef({
        tenant_id: ctx.tenantId,
        business_ref: businessRef,
        limit: 50
      })
      : [];
    const [chatAuthorization, mediaAuthorization] = await Promise.all([
      Promise.all(chatSessions.map(async (session) => {
        const participants = await module.sessions.listParticipants({
          tenant_id: ctx.tenantId,
          session_id: session.id
        });
        return {
          session_id: session.id,
          viewer_role: participants.find((participant) => participant.identity === identity && !participant.left_at)?.role || null,
          participants: participants.map((participant) => ({
            identity: participant.identity,
            display_name: participant.display_name,
            role: participant.role,
            status: participant.left_at ? 'left' as const : 'active' as const
          }))
        };
      })),
      Promise.all(mediaCalls.map(async (call) => {
        const participants = await new MediaCallStore(requirePg(pg)).listParticipants(ctx.tenantId, call.id);
        const viewer = participants.find((participant) => participant.identity === identity);
        return {
          call_id: call.id,
          viewer_role: viewer?.role || null,
          viewer_status: viewer?.status || null,
          participants: participants.map((participant) => ({
            identity: participant.identity,
            display_name: participant.display_name,
            role: participant.role,
            status: participant.status
          }))
        };
      }))
    ]);
    const chatAuthorizationBySession = new Map(
      chatAuthorization.map((authorization) => [authorization.session_id, authorization])
    );
    const remoteAuthorization = await Promise.all(remoteSessions.map(async (remote) => {
      const [consent, tools] = await Promise.all([
        module.remote.getActiveConsent(remote.id),
        module.remote.listToolSessions(remote.id, 50)
      ]);
      const rustDeskTool = tools.find((tool) => tool.provider === 'rustdesk' && tool.status === 'active');
      const gateway = rustDeskTool
        ? await new RustDeskGatewaySessionStore(requirePg(pg)).getSession(rustDeskTool.external_id)
        : null;
      const controller = gateway?.status === 'active'
        ? await module.rustdeskControlLocks.getOwnership({
          tenant_id: ctx.tenantId,
          external_id: gateway.external_id
        })
        : null;
      return {
        remote_session_id: remote.id,
        viewer_role: chatAuthorizationBySession.get(remote.collaboration_session_id)?.viewer_role || null,
        consent: {
          active: Boolean(consent),
          scopes: consent?.scopes || [],
          expires_at: consent?.expires_at || null
        },
        gateway: gateway ? {
          external_id: gateway.external_id,
          status: gateway.status,
          permissions: gateway.permissions,
          controller: controller || {
            status: 'unowned',
            owner_identity: null,
            lease_expires_at: null,
            version: 0
          }
        } : null
      };
    }));

    return {
      data: {
        tenant_id: ctx.tenantId,
        business_ref: { type: businessRef.type, id: businessRef.id },
        viewer: { identity: identity || collaborationActorIdentity(ctx, headers), system },
        capabilities: {
          chat: system || chatSessions.length > 0,
          media: system || mediaCalls.length > 0,
          remote_assistance: system || remoteSessions.length > 0 || devices.length > 0
        },
        chat: {
          count: chatSessions.length,
          sessions: chatSessions.map((session) => ({
            id: session.id,
            title: session.title,
            status: session.status,
            created_at: session.created_at,
            updated_at: session.updated_at,
            closed_at: session.closed_at
          }))
        },
        media: {
          count: mediaCalls.length,
          calls: mediaCalls.map((call) => ({
            id: call.id,
            title: call.title,
            media: call.media,
            status: call.status,
            room_name: call.room_name,
            created_at: call.created_at,
            updated_at: call.updated_at,
            ended_at: call.ended_at
          }))
        },
        remote_assistance: {
          count: remoteSessions.length,
          sessions: remoteSessions.map((session) => ({
            id: session.id,
            collaboration_session_id: session.collaboration_session_id,
            status: session.status,
            mode: session.mode,
            adapter_provider: session.adapter_provider,
            created_at: session.created_at,
            started_at: session.started_at,
            ended_at: session.ended_at
          })),
          devices: devices.map((device) => ({
            id: device.id,
            display_name: device.display_name,
            status: device.status,
            runtime_status: device.runtime_status,
            last_seen_at: device.last_seen_at
          }))
        },
        authorization: {
          chat: chatAuthorization,
          media: mediaAuthorization,
          remote_assistance: remoteAuthorization
        }
      },
      headers: {
        'cache-control': 'private, no-store',
        vary: 'Authorization, X-API-Key, X-Tenant-Id, X-User-Id, Origin'
      }
    };
  }

  let activeSessionParticipant: CollaborationParticipant | null = null;
  const protectedSessionMatch = routePath.match(
    /^\/api\/collaboration\/sessions\/(?!by-ref(?:\/|$))([^/]+)/
  );
  if (protectedSessionMatch && ctx.role !== 'system') {
    const protectedSessionId = decodeURIComponent(protectedSessionMatch[1]);
    const protectedSession = await module.sessions.getSession(protectedSessionId);
    if (!protectedSession || protectedSession.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    const actorIdentity = collaborationActorIdentity(ctx, headers);
    const participants = await module.sessions.listParticipants({
      tenant_id: ctx.tenantId,
      session_id: protectedSessionId
    });
    activeSessionParticipant = participants.find((participant) =>
      participant.identity === actorIdentity && !participant.left_at
    ) || null;
    if (!activeSessionParticipant) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
  }

  if (routePath === '/api/collaboration/attachment-processing/run' && method === 'POST') {
    const input = bodyObject(body);
    const summary = await attachmentProcessingService(requirePg(pg), options).runDue({
      tenant_id: ctx.tenantId,
      limit: input.limit == null ? undefined : Number(input.limit)
    });
    return { status: 200, data: summary };
  }

  if (routePath === '/api/collaboration/quality-review/run' && method === 'POST') {
    const input = bodyObject(body);
    const quality = qualityReviewService(requirePg(pg), options);
    const summary = await quality.service.runDue({
      tenant_id: ctx.tenantId,
      limit: input.limit == null ? undefined : Number(input.limit)
    });
    return { status: 200, data: summary };
  }

  const attachmentRetryMatch = routePath.match(
    /^\/api\/collaboration\/sessions\/([^/]+)\/attachments\/([^/]+)\/retry$/
  );
  if (attachmentRetryMatch && method === 'POST') {
    const sessionId = decodeURIComponent(attachmentRetryMatch[1]);
    const attachmentId = decodeURIComponent(attachmentRetryMatch[2]);
    const collaboration = await module.sessions.getSession(sessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    const service = attachmentProcessingService(requirePg(pg), options);
    const attachment = await service.getAttachment({
      tenant_id: ctx.tenantId,
      attachment_id: attachmentId
    });
    if (!attachment || attachment.session_id !== sessionId) {
      return { status: 404, data: { error: 'collaboration attachment not found' } };
    }
    const job = await service.retryAttachment({
      tenant_id: ctx.tenantId,
      attachment_id: attachmentId
    });
    if (!job) return { status: 409, data: { error: 'attachment processing job is not retryable' } };
    return { status: 201, data: { attachment_id: attachmentId, job } };
  }

  const attachmentDownloadMatch = routePath.match(
    /^\/api\/collaboration\/sessions\/([^/]+)\/attachments\/([^/]+)\/download$/
  );
  if (attachmentDownloadMatch && method === 'GET') {
    const sessionId = decodeURIComponent(attachmentDownloadMatch[1]);
    const attachmentId = decodeURIComponent(attachmentDownloadMatch[2]);
    const collaboration = await module.sessions.getSession(sessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    const attachment = await attachmentProcessingService(requirePg(pg), options).getAttachment({
      tenant_id: ctx.tenantId,
      attachment_id: attachmentId
    });
    if (!attachment || attachment.session_id !== sessionId) {
      return { status: 404, data: { error: 'collaboration attachment not found' } };
    }
    const key = String(attachment.metadata.storage_key || '').trim();
    if (!key.startsWith(`${ctx.tenantId}/`) || !decodeStorageKey(key)) {
      return { status: 404, data: { error: 'attachment object not found' } };
    }
    const buffer = await createObjectStorage().download(key, attachmentUploadMaxBytes());
    if (!buffer) return { status: 404, data: { error: 'attachment object not found' } };
    return {
      contentType: attachment.content_type || 'application/octet-stream',
      headers: { 'content-disposition': `attachment; filename="${safeFilename(attachment.filename)}"` },
      data: buffer
    };
  }

  const findingReviewMatch = routePath.match(
    /^\/api\/collaboration\/sessions\/([^/]+)\/findings\/([^/]+)\/review$/
  );
  if (findingReviewMatch && method === 'POST') {
    const sessionId = decodeURIComponent(findingReviewMatch[1]);
    const findingId = decodeURIComponent(findingReviewMatch[2]);
    const collaboration = await module.sessions.getSession(sessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    const input = bodyObject(body);
    const reviewStatus = String(input.review_status || '').trim();
    if (!['confirmed', 'false_positive', 'resolved', 'escalated'].includes(reviewStatus)) {
      return { status: 400, data: { error: 'unsupported finding review_status' } };
    }
    const findings = new PolicyFindingStore(requirePg(pg));
    const existing = await findings.getFinding({ tenant_id: ctx.tenantId, finding_id: findingId });
    if (!existing || existing.session_id !== sessionId) {
      return { status: 404, data: { error: 'policy finding not found' } };
    }
    const actorIdentity = collaborationActorIdentity(ctx, headers);
    const participants = await module.sessions.listParticipants({
      tenant_id: ctx.tenantId,
      session_id: sessionId
    });
    const reviewer = participants.find((participant) =>
      participant.identity === actorIdentity && !participant.left_at
    );
    if (!reviewer || !['agent', 'engineer', 'supervisor', 'admin'].includes(reviewer.role)) {
      return { status: 403, data: { error: 'finding review requires an authorized active participant' } };
    }
    const reviewChanged = existing.review_status !== reviewStatus;
    const finding = await findings.reviewFinding({
      tenant_id: ctx.tenantId,
      finding_id: findingId,
      review_status: reviewStatus as 'confirmed' | 'false_positive' | 'resolved' | 'escalated',
      reviewed_by: actorIdentity,
      note: input.note ? String(input.note) : undefined,
      metadata: bodyObject(input.metadata)
    });
    const reviews = await findings.listReviews({ tenant_id: ctx.tenantId, finding_id: findingId });
    const payload = { session_id: sessionId, finding, review: reviewChanged ? reviews.at(-1) || null : null };
    if (reviewChanged) wsBroadcast(ctx.tenantId, 'collaboration.policy.finding_reviewed', payload);
    return { status: reviewChanged ? 201 : 200, data: payload };
  }

  if (
    method === 'GET' &&
    /^\/api\/ivekit\/rustdesk\/gateway-sessions\/[^/]+\/disconnect$/.test(routePath)
  ) {
    return withPgTenant(requirePg(pg), ctx.tenantId, async (scopedPg) =>
      routeRustDeskDeviceCommandApi({
        pg: scopedPg,
        method,
        routePath,
        body,
        tenantId: ctx.tenantId,
        actorIdentity: ctx.userId
      })
    );
  }

  if (isIveKitRustDeskRoute) {
    if (routePath === '/api/ivekit/rustdesk/client-config' && method === 'GET') {
      const config = rustDeskClientConfig();
      if (config.public_key_error) return { status: 500, data: { error: config.public_key_error } };
      if (config.api_server_error) return { status: 500, data: { error: config.api_server_error } };
      return { data: config };
    }

    if (routePath === '/api/ivekit/rustdesk/devices' && method === 'POST') {
      const input = bodyObject(body);
      const device = await module.rustdeskDevices.registerDevice({
        tenant_id: ctx.tenantId,
        business_ref: businessRefFromInput(ctx.tenantId, input),
        rustdesk_id: String(input.rustdesk_id || '').trim(),
        display_name: String(input.display_name || '').trim(),
        metadata: bodyObject(input.metadata)
      });
      return { status: 201, data: device };
    }

    if (routePath === '/api/ivekit/rustdesk/devices/by-ref' && method === 'GET') {
      const devices = await module.rustdeskDevices.getByBusinessRef({
        tenant_id: ctx.tenantId,
        business_ref: queryBusinessRef(ctx.tenantId, url),
        limit: Number(url.searchParams.get('limit') || 50)
      });
      return { data: devices };
    }

    const accessPolicyMatch = routePath.match(
      /^\/api\/ivekit\/rustdesk\/devices\/([^/]+)\/access-policy(?:\/(history|revoke))?$/
    );
    if (accessPolicyMatch) {
      const deviceId = decodeURIComponent(accessPolicyMatch[1]);
      const action = accessPolicyMatch[2] || '';
      return withPgTenant(requirePg(pg), ctx.tenantId, async (scopedPg) => {
        const scopedModule = createCollaborationModule({ pg: scopedPg });
        const device = await scopedModule.rustdeskDevices.getDevice({
          tenant_id: ctx.tenantId,
          device_id: deviceId
        });
        if (!device) return { status: 404, data: { error: 'rustdesk device not found' } };
        if (!action && method === 'GET') {
          return {
            data: await scopedModule.rustdeskAccessPolicies.getCurrentPolicy({
              tenant_id: ctx.tenantId,
              device_id: device.id
            })
          };
        }
        if (action === 'history' && method === 'GET') {
          return {
            data: await scopedModule.rustdeskAccessPolicies.listPolicyHistory({
              tenant_id: ctx.tenantId,
              device_id: device.id
            })
          };
        }
        if ((!action && method === 'PUT') || (action === 'revoke' && method === 'POST')) {
          const authorizationError = rustDeskPolicyMutationAuthorizationError(ctx, headers);
          if (authorizationError) return authorizationError;
          const idempotencyKey = headerValue(headers, 'idempotency-key').trim();
          if (!idempotencyKey) return { status: 400, data: { error: 'Idempotency-Key is required' } };
          const policyInput = bodyObject(body);
          const inputError = rustDeskPolicyInputError(
            policyInput,
            action === 'revoke' ? 'revoke' : 'configure'
          );
          if (inputError) return { status: 400, data: { error: inputError } };
          const result = action === 'revoke'
            ? await scopedModule.rustdeskAccessPolicies.revokePolicy({
                tenant_id: ctx.tenantId,
                device_id: device.id,
                approved_by: ctx.userId,
                reason: String(policyInput.reason),
                idempotency_key: idempotencyKey
              })
            : await scopedModule.rustdeskAccessPolicies.configurePolicy({
                tenant_id: ctx.tenantId,
                device_id: device.id,
                business_ref: {
                  type: String(bodyObject(policyInput.business_ref).type || ''),
                  id: String(bodyObject(policyInput.business_ref).id || '')
                },
                mode: String(policyInput.mode || '') as 'attended_only' | 'unattended_allowed',
                allowed_scopes: remoteConsentScopes(policyInput.allowed_scopes),
                approved_by: ctx.userId,
                reason: String(policyInput.reason),
                expires_at: policyInput.expires_at == null ? null : String(policyInput.expires_at),
                idempotency_key: idempotencyKey
              });
          return { status: result.replayed ? 200 : 201, data: result };
        }
        return { status: 405, data: { error: 'method not allowed' } };
      });
    }

    const controlMatch = routePath.match(
      /^\/api\/ivekit\/rustdesk\/gateway-sessions\/([^/]+)\/control(?:\/(confirmations|acquire|heartbeat|release|transfer|operations))?$/
    );
    if (controlMatch) {
      const externalId = decodeURIComponent(controlMatch[1]);
      const action = controlMatch[2] || '';
      return withPgTenant(requirePg(pg), ctx.tenantId, async (scopedPg) => {
        const scopedModule = createCollaborationModule({ pg: scopedPg });
        const tool = await scopedModule.remote.getToolSessionByExternalId({
          tenant_id: ctx.tenantId,
          external_id: externalId
        });
        if (!tool || tool.provider !== 'rustdesk') {
          return { status: 404, data: { error: 'rustdesk gateway session not found' } };
        }
        const remote = await scopedModule.remote.getSession(tool.remote_session_id);
        if (!remote || remote.tenant_id !== ctx.tenantId) {
          return { status: 404, data: { error: 'rustdesk gateway session not found' } };
        }
        const participants = await scopedModule.sessions.listParticipants({
          tenant_id: ctx.tenantId,
          session_id: remote.collaboration_session_id
        });
        const activeParticipants = participants.filter((participant) => !participant.left_at);
        const actorIdentity = collaborationActorIdentity(ctx, headers);
        const actorParticipant = activeParticipants.find((participant) => participant.identity === actorIdentity);
        if (!actorParticipant) {
          return { status: 403, data: { error: 'active participant identity is required' } };
        }
        const input = bodyObject(body);
        const common = { tenant_id: ctx.tenantId, external_id: externalId, actor_identity: actorIdentity };
        if (!action && method === 'GET') {
          return { data: await scopedModule.rustdeskControlLocks.getOwnership(common) };
        }
        if (!['agent', 'engineer', 'supervisor', 'admin'].includes(actorParticipant.role)) {
          return { status: 403, data: { error: 'observer participants have view-only remote access' } };
        }
        if (action === 'confirmations' && method === 'POST') {
          const confirmation = await scopedModule.rustdeskControlLocks.issueConfirmation({
            ...common,
            operation: String(input.operation || '') as never,
            ttl_seconds: input.ttl_seconds === undefined ? undefined : Number(input.ttl_seconds)
          });
          return { status: 201, data: confirmation };
        }
        let ownership;
        if (action === 'acquire' && method === 'POST') {
          ownership = await scopedModule.rustdeskControlLocks.acquire({
            ...common,
            confirmation_id: String(input.confirmation_id || ''),
            lease_ms: input.lease_ms === undefined ? undefined : Number(input.lease_ms)
          });
        } else if (action === 'heartbeat' && method === 'POST') {
          ownership = await scopedModule.rustdeskControlLocks.heartbeat({
            ...common,
            version: Number(input.version),
            lease_ms: input.lease_ms === undefined ? undefined : Number(input.lease_ms)
          });
        } else if (action === 'release' && method === 'POST') {
          ownership = await scopedModule.rustdeskControlLocks.release({ ...common, version: Number(input.version) });
        } else if (action === 'transfer' && method === 'POST') {
          const target = String(input.to_identity || '').trim();
          if (!activeParticipants.some((participant) => participant.identity === target)) {
            return { status: 403, data: { error: 'control transfer target must be an active participant' } };
          }
          ownership = await scopedModule.rustdeskControlLocks.transfer({
            ...common,
            to_identity: target,
            confirmation_id: String(input.confirmation_id || ''),
            version: Number(input.version),
            lease_ms: input.lease_ms === undefined ? undefined : Number(input.lease_ms)
          });
        } else if (action === 'operations' && method === 'POST') {
          const authorization = await scopedModule.rustdeskControlLocks.confirmOperation({
            ...common,
            operation: String(input.operation || '') as never,
            confirmation_id: String(input.confirmation_id || ''),
            version: Number(input.version)
          });
          return { status: 201, data: authorization };
        } else {
          return { status: 405, data: { error: 'method not allowed' } };
        }
        wsBroadcastToUsers(
          ctx.tenantId,
          activeParticipants.map((participant) => participant.identity),
          'ivekit.rustdesk.control.updated',
          { external_id: externalId, ownership }
        );
        return { data: ownership };
      });
    }

    const iveKitDeviceMatch = routePath.match(/^\/api\/ivekit\/rustdesk\/devices\/([^/]+)(?:\/([^/]+))?$/);
    if (iveKitDeviceMatch) {
      const deviceId = decodeURIComponent(iveKitDeviceMatch[1]);
      const action = iveKitDeviceMatch[2] || '';
      if (!action && method === 'GET') {
        const device = await module.rustdeskDevices.getDevice({
          tenant_id: ctx.tenantId,
          device_id: deviceId
        });
        if (!device) return { status: 404, data: { error: 'rustdesk device not found' } };
        return { data: device };
      }
      if (action === 'heartbeat' && method === 'POST') {
        return withPgTenant(requirePg(pg), ctx.tenantId, (scopedPg) =>
          routeRustDeskDeviceHeartbeat({
            pg: scopedPg,
            tenantId: ctx.tenantId,
            deviceId,
            body,
            headers,
            fallbackActorIdentity: ''
          })
        );
      }
      if (action === 'deactivate' && method === 'POST') {
        const device = await module.rustdeskDevices.deactivateDevice({
          tenant_id: ctx.tenantId,
          device_id: deviceId
        });
        if (!device) return { status: 404, data: { error: 'rustdesk device not found' } };
        return { status: 201, data: device };
      }
    }

    if (routePath === '/api/ivekit/rustdesk/gateway-sessions' && method === 'POST') {
      const input = bodyObject(body);
      rustDeskGatewayMetadata(input, 'RustDesk gateway request');
      const remoteSessionId = String(input.remote_session_id || '').trim();
      const deviceId = String(input.device_id || '').trim();
      const actorIdentity = collaborationRequestActorIdentity(ctx, headers, input);
      if (!remoteSessionId) return { status: 400, data: { error: 'remote_session_id is required' } };
      if (!deviceId) return { status: 400, data: { error: 'device_id is required' } };
      if (!actorIdentity) return { status: 400, data: { error: 'actor_identity is required' } };
      const accessModeExplicit = input.access_mode !== undefined;
      if (accessModeExplicit && input.access_mode !== 'attended' && input.access_mode !== 'unattended') {
        return { status: 400, data: { error: 'access_mode must be attended or unattended' } };
      }
      const accessMode = rustDeskGatewayAccessMode(input.access_mode);
      const requestedPermissions = stringArray(input.permissions || input.scopes);
      const unsupportedPermission = unsupportedRemoteConsentScope(requestedPermissions);
      if (unsupportedPermission) {
        return { status: 400, data: { error: `unsupported RustDesk permission scope: ${unsupportedPermission}` } };
      }
      const permissions = remoteConsentScopes(requestedPermissions);
      if (!permissions.length) return { status: 400, data: { error: 'permissions required' } };
      const remote = await requireRemoteSession(module.remote, ctx.tenantId, remoteSessionId);
      if (!remote) return { status: 404, data: { error: 'remote session not found' } };
      const device = await module.rustdeskDevices.getDevice({
        tenant_id: ctx.tenantId,
        device_id: deviceId
      });
      if (!device || device.status !== 'active') return { status: 404, data: { error: 'rustdesk device not found' } };
      assertRustDeskDeviceOnlineIfRequired(device);
      assertRustDeskPhysicalDisconnectCapableIfRequired(device);
      const requestMetadata = rustDeskGatewayMetadata(input.metadata);
      if (requestMetadata.access_mode !== undefined) {
        return { status: 400, data: { error: 'RustDesk access_mode must be a top-level field' } };
      }
      const tool = await module.remote.startGatewayClientSession({
        tenant_id: ctx.tenantId,
        remote_session_id: remote.id,
        actor_identity: actorIdentity,
        client: createLocalRustDeskGatewayClient(requirePg(pg)),
        target: {
          type: 'device',
          id: device.rustdesk_id,
          display_name: device.display_name
        },
        permissions,
        access_mode: accessMode,
        device_id: device.id,
        metadata: {
          ...requestMetadata,
          ...(accessModeExplicit ? { access_mode: accessMode } : {}),
          tenant_id: ctx.tenantId,
          remote_session_id: remote.id,
          collaboration_session_id: remote.collaboration_session_id,
          rustdesk_target_mode: 'registered_device',
          control_enforcement_version: 1,
          rustdesk_device_id: device.id,
          rustdesk_id: device.rustdesk_id,
          target_id: device.id,
          target_display_name: device.display_name,
          rustdesk_device_runtime_status: device.runtime_status,
          rustdesk_device_last_seen_at: device.last_seen_at || '',
          rustdesk_device_last_seen_actor: device.last_seen_actor || '',
          business_ref_type: device.business_ref_type,
          business_ref_id: device.business_ref_id
        }
      });
      return {
        status: 201,
        data: accessMode === 'unattended' ? { ...tool, launch_url: '' } : tool
      };
    }

    const iveKitGatewayMatch = routePath.match(/^\/api\/ivekit\/rustdesk\/gateway-sessions\/([^/]+)(?:\/([^/]+))?$/);
    if (iveKitGatewayMatch) {
      const externalId = decodeURIComponent(iveKitGatewayMatch[1]);
      const action = iveKitGatewayMatch[2] || '';
      const store = new RustDeskGatewaySessionStore(requirePg(pg));
      const session = await store.getSession(externalId);
      if (!session || session.tenant_id !== ctx.tenantId) {
        return { status: 404, data: { error: 'rustdesk gateway session not found' } };
      }
      if (action === 'launch' && method === 'GET') {
        if (session.metadata.access_mode === 'unattended') {
          const confirmationId = String(url.searchParams.get('confirmation_id') || '').trim();
          if (!confirmationId) {
            return { status: 403, data: { error: 'fresh secondary confirmation required for unattended launch' } };
          }
          const actorIdentity = collaborationActorIdentity(ctx, headers);
          await withPgTenant(requirePg(pg), ctx.tenantId, async (scopedPg) => {
            await createCollaborationModule({ pg: scopedPg }).rustdeskControlLocks.confirmOperation({
              tenant_id: ctx.tenantId,
              external_id: externalId,
              actor_identity: actorIdentity,
              operation: 'unattended_launch',
              confirmation_id: confirmationId
            });
          });
        }
        return { data: rustDeskLaunchPlan(session) };
      }
      if (action === 'audit' && method === 'GET') {
        const since = rustDeskGatewaySince(url.searchParams.get('since'));
        if (since === 'invalid') {
          return { status: 400, data: { error: 'since must be an ISO timestamp' } };
        }
        const events = await store.listAuditEvents({
          external_id: session.external_id,
          since: since || undefined
        });
        return { data: { events: events || [] } };
      }
      if (action === 'events' && method === 'POST') {
        const input = bodyObject(body);
        const eventType = String(input.event_type || '').trim();
        if (!eventType) return { status: 400, data: { error: 'event_type is required' } };
        const actorIdentity = collaborationRequestActorIdentity(ctx, headers, input);
        const occurredAt = String(input.occurred_at || '').trim();
        if (occurredAt && Number.isNaN(new Date(occurredAt).getTime())) {
          return { status: 400, data: { error: 'occurred_at must be an ISO timestamp' } };
        }
        const metadata = bodyObject(input.metadata);
        const eventValidationError = rustDeskGatewayEventValidationError(eventType, metadata);
        if (eventValidationError) return { status: 400, data: { error: eventValidationError } };
        if (session.status !== 'active') {
          return { status: 409, data: { error: 'RustDesk gateway session is not active' } };
        }
        const permissionError = rustDeskGatewayEventPermissionError(eventType, metadata, session.permissions);
        if (permissionError) return { status: 403, data: { error: permissionError } };
        const event = await store.appendAuditEvent({
          external_id: externalId,
          event_type: eventType,
          actor_identity: actorIdentity,
          target: String(input.target || '').trim() || undefined,
          idempotency_key: String(input.idempotency_key || '').trim() || undefined,
          metadata,
          occurred_at: occurredAt || undefined
        });
        if (!event) return { status: 404, data: { error: 'rustdesk gateway session not found' } };
        await syncLocalRustDeskGatewayTimeline({
          module,
          pg: requirePg(pg),
          tenantId: ctx.tenantId,
          session,
          actorIdentity
        });
        return { status: 201, data: { event } };
      }
      if (!action && method === 'DELETE') {
        const input = bodyObject(body);
        const actorIdentity = collaborationRequestActorIdentity(ctx, headers, input);
        const ended = await module.rustdeskPhysicalDisconnect.endGatewaySession({
          tenant_id: ctx.tenantId,
          external_id: externalId,
          actor_identity: actorIdentity,
          requested_reason: 'gateway_ended'
        });
        await syncLocalRustDeskGatewayTimeline({
          module,
          pg: requirePg(pg),
          tenantId: ctx.tenantId,
          session: ended.session,
          actorIdentity,
          endMatchingTool: true
        });
        return { status: 204, data: null };
      }
    }

    return undefined;
  }

  if (routePath === '/api/collaboration/rustdesk/devices' && method === 'POST') {
    const input = bodyObject(body);
    const device = await module.rustdeskDevices.registerDevice({
      tenant_id: ctx.tenantId,
      business_ref: businessRefFromInput(ctx.tenantId, input),
      rustdesk_id: String(input.rustdesk_id || '').trim(),
      display_name: String(input.display_name || '').trim(),
      metadata: bodyObject(input.metadata)
    });
    return { status: 201, data: device };
  }

  if (routePath === '/api/collaboration/rustdesk/devices/by-ref' && method === 'GET') {
    const devices = await module.rustdeskDevices.getByBusinessRef({
      tenant_id: ctx.tenantId,
      business_ref: queryBusinessRef(ctx.tenantId, url),
      limit: Number(url.searchParams.get('limit') || 50)
    });
    return { data: devices };
  }

  const rustDeskDeviceMatch = routePath.match(/^\/api\/collaboration\/rustdesk\/devices\/([^/]+)(?:\/([^/]+))?$/);
  if (rustDeskDeviceMatch) {
    const deviceId = decodeURIComponent(rustDeskDeviceMatch[1]);
    const action = rustDeskDeviceMatch[2] || '';
    if (!action && method === 'GET') {
      const device = await module.rustdeskDevices.getDevice({
        tenant_id: ctx.tenantId,
        device_id: deviceId
      });
      if (!device) return { status: 404, data: { error: 'rustdesk device not found' } };
      return { data: device };
    }
    if (action === 'heartbeat' && method === 'POST') {
      return withPgTenant(requirePg(pg), ctx.tenantId, (scopedPg) =>
        routeRustDeskDeviceHeartbeat({
          pg: scopedPg,
          tenantId: ctx.tenantId,
          deviceId,
          body,
          headers,
          fallbackActorIdentity: ctx.userId || 'system'
        })
      );
    }
    if (action === 'deactivate' && method === 'POST') {
      const device = await module.rustdeskDevices.deactivateDevice({
        tenant_id: ctx.tenantId,
        device_id: deviceId
      });
      if (!device) return { status: 404, data: { error: 'rustdesk device not found' } };
      return { status: 201, data: device };
    }
  }

  if (routePath === '/api/collaboration/sessions' && method === 'POST') {
    const input = bodyObject(body);
    const sessionInput = {
      tenant_id: ctx.tenantId,
      business_ref: businessRefFromInput(ctx.tenantId, input),
      title: input.title ? String(input.title) : undefined,
      metadata: bodyObject(input.metadata)
    };
    if (ctx.role === 'system') {
      const session = await module.sessions.openSession(sessionInput);
      return { status: 201, data: session };
    }
    const session = await withPgTransaction(requirePg(pg), async (transactionPg) => {
      const transactionModule = createCollaborationModule({ pg: transactionPg });
      const created = await transactionModule.sessions.openSession(sessionInput);
      await transactionModule.sessions.addParticipant({
        tenant_id: ctx.tenantId,
        session_id: created.id,
        identity: collaborationActorIdentity(ctx, headers),
        role: creatorParticipantRole(ctx),
        display_name: input.creator_display_name ? String(input.creator_display_name) : undefined
      });
      return created;
    });
    return { status: 201, data: session };
  }

  if (routePath === '/api/collaboration/sessions' && method === 'GET') {
    const status = url.searchParams.get('status') || undefined;
    const sessions = await module.sessions.listSessions({
      tenant_id: ctx.tenantId,
      status: status as 'open' | 'closed' | undefined,
      business_ref_type: url.searchParams.get('business_ref_type') || undefined,
      business_ref_id: url.searchParams.get('business_ref_id') || undefined,
      query: url.searchParams.get('query') || undefined,
      identity: ctx.role === 'system' ? undefined : collaborationActorIdentity(ctx, headers),
      cursor: url.searchParams.get('cursor') || undefined,
      limit: optionalQueryNumber(url.searchParams.get('limit'))
    });
    const summaries = await module.sessions.listSessionSummaries({
      tenant_id: ctx.tenantId,
      session_ids: sessions.items.map((session) => session.id),
      identity: collaborationActorIdentity(ctx, headers)
    });
    return {
      data: {
        ...sessions,
        items: sessions.items.map((session) => ({
          ...session,
          summary: summaries.get(session.id) || {
            unread_count: 0,
            online_participant_count: 0,
            last_message: null
          }
        }))
      }
    };
  }

  if (routePath === '/api/collaboration/sessions/by-ref' && method === 'GET') {
    const sessions = await module.sessions.listByBusinessRef({
      tenant_id: ctx.tenantId,
      business_ref: queryBusinessRef(ctx.tenantId, url),
      identity: ctx.role === 'system' ? undefined : collaborationActorIdentity(ctx, headers),
      limit: Number(url.searchParams.get('limit') || 50)
    });
    return { data: sessions };
  }

  const reactionMatch = routePath.match(
    /^\/api\/collaboration\/sessions\/([^/]+)\/messages\/([^/]+)\/reactions(?:\/([^/]+))?$/
  );
  if (reactionMatch && ['GET', 'PUT', 'DELETE'].includes(method)) {
    const sessionId = decodeURIComponent(reactionMatch[1]);
    const messageId = decodeURIComponent(reactionMatch[2]);
    const emoji = reactionMatch[3] ? decodeURIComponent(reactionMatch[3]) : '';
    const collaboration = await module.sessions.getSession(sessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    if (method !== 'GET' && !emoji) return { status: 400, data: { error: 'emoji is required' } };
    const actorIdentity = collaborationActorIdentity(ctx, headers);
    const reactions = method === 'PUT'
      ? await module.sessions.addReaction({
        tenant_id: ctx.tenantId,
        session_id: sessionId,
        message_id: messageId,
        identity: actorIdentity,
        emoji
      })
      : method === 'DELETE'
        ? await module.sessions.removeReaction({
          tenant_id: ctx.tenantId,
          session_id: sessionId,
          message_id: messageId,
          identity: actorIdentity,
          emoji
        })
        : await module.sessions.listReactions({
          tenant_id: ctx.tenantId,
          session_id: sessionId,
          message_id: messageId
        });
    const payload = { session_id: sessionId, message_id: messageId, reactions, counts: reactionCounts(reactions) };
    if (method !== 'GET') wsBroadcast(ctx.tenantId, 'collaboration.message.reaction_updated', payload);
    return { status: method === 'PUT' ? 201 : 200, data: payload };
  }

  const pinMatch = routePath.match(/^\/api\/collaboration\/sessions\/([^/]+)\/pins(?:\/([^/]+))?$/);
  if (pinMatch && ['GET', 'PUT', 'DELETE'].includes(method)) {
    const sessionId = decodeURIComponent(pinMatch[1]);
    const messageId = pinMatch[2] ? decodeURIComponent(pinMatch[2]) : '';
    const collaboration = await module.sessions.getSession(sessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    if (method !== 'GET' && !messageId) return { status: 400, data: { error: 'message_id is required' } };
    const actorIdentity = collaborationActorIdentity(ctx, headers);
    const pins = method === 'PUT'
      ? await module.sessions.pinMessage({
        tenant_id: ctx.tenantId,
        session_id: sessionId,
        message_id: messageId,
        identity: actorIdentity
      })
      : method === 'DELETE'
        ? await module.sessions.unpinMessage({
          tenant_id: ctx.tenantId,
          session_id: sessionId,
          message_id: messageId,
          identity: actorIdentity
        })
        : await module.sessions.listPins({ tenant_id: ctx.tenantId, session_id: sessionId });
    const payload = { session_id: sessionId, message_id: messageId || undefined, pins };
    if (method !== 'GET') wsBroadcast(ctx.tenantId, 'collaboration.message.pin_updated', payload);
    return { status: method === 'PUT' ? 201 : 200, data: payload };
  }

  const messageDeliveryMatch = routePath.match(
    /^\/api\/collaboration\/sessions\/([^/]+)\/messages\/([^/]+)\/delivery(?:\/(retry))?$/
  );
  if (messageDeliveryMatch) {
    const sessionId = decodeURIComponent(messageDeliveryMatch[1]);
    const messageId = decodeURIComponent(messageDeliveryMatch[2]);
    const action = messageDeliveryMatch[3] || '';
    if ((action === 'retry' && method !== 'POST') || (!action && method !== 'GET')) {
      return { status: 405, data: { error: 'method not allowed' } };
    }
    const gateway = options.chatGateway || configuredChatGateway();
    const delivery = new TinodeMessageDeliveryService({
      pg: requirePg(pg),
      gateway,
      ...(options.tinodeDelivery || {})
    });
    const message = action === 'retry' && method === 'POST'
      ? await delivery.retryMessage({ tenant_id: ctx.tenantId, message_id: messageId })
      : !action && method === 'GET'
        ? await delivery.getMessage({ tenant_id: ctx.tenantId, message_id: messageId })
        : null;
    if (!message || message.session_id !== sessionId) {
      return { status: 404, data: { error: 'collaboration message not found' } };
    }
    const attempts = await delivery.listAttempts({
      tenant_id: ctx.tenantId,
      message_id: message.id
    });
    return {
      data: {
        session_id: sessionId,
        message_id: message.id,
        delivery: message.provider_delivery,
        attempts
      }
    };
  }

  const messageQualityReviewMatch = routePath.match(
    /^\/api\/collaboration\/sessions\/([^/]+)\/messages\/([^/]+)\/quality-review$/
  );
  if (messageQualityReviewMatch && (method === 'GET' || method === 'POST')) {
    const sessionId = decodeURIComponent(messageQualityReviewMatch[1]);
    const messageId = decodeURIComponent(messageQualityReviewMatch[2]);
    const collaboration = await module.sessions.getSession(sessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    const message = await module.sessions.getMessage({
      tenant_id: ctx.tenantId,
      message_id: messageId
    });
    if (!message || message.session_id !== sessionId) {
      return { status: 404, data: { error: 'collaboration message not found' } };
    }
    const quality = qualityReviewService(requirePg(pg), options);
    const job = method === 'POST'
      ? await quality.service.enqueueMessage({ tenant_id: ctx.tenantId, message_id: messageId })
      : await quality.service.getJob({ tenant_id: ctx.tenantId, message_id: messageId });
    return {
      status: method === 'POST' ? 201 : 200,
      data: { session_id: sessionId, message_id: messageId, job }
    };
  }

  const messageReceiptMatch = routePath.match(
    /^\/api\/collaboration\/sessions\/([^/]+)\/messages\/([^/]+)\/receipts$/
  );
  if (messageReceiptMatch && (method === 'GET' || method === 'POST')) {
    const sessionId = decodeURIComponent(messageReceiptMatch[1]);
    const messageId = decodeURIComponent(messageReceiptMatch[2]);
    const collaboration = await module.sessions.getSession(sessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    const message = await module.sessions.getMessage({
      tenant_id: ctx.tenantId,
      message_id: messageId
    });
    if (!message || message.session_id !== sessionId) {
      return { status: 404, data: { error: 'collaboration message not found' } };
    }
    const states = new CollaborationMessageStateStore(requirePg(pg));
    if (method === 'GET') {
      const receipts = await states.listReceipts({
        tenant_id: ctx.tenantId,
        session_id: sessionId,
        message_id: messageId
      });
      return { data: { session_id: sessionId, message_id: messageId, receipts } };
    }
    const input = bodyObject(body);
    const actorIdentity = collaborationActorIdentity(ctx, headers);
    const identity = String(input.identity || actorIdentity || '').trim();
    if (!actorIdentity || identity !== actorIdentity) {
      return { status: 403, data: { error: 'receipt identity must match authenticated user' } };
    }
    const status = String(input.status || '').trim();
    if (status !== 'delivered' && status !== 'read') {
      return { status: 400, data: { error: 'receipt status must be delivered or read' } };
    }
    const source = String(input.source || 'ivekit').trim();
    if (source !== 'ivekit' && source !== 'tinode' && source !== 'system') {
      return { status: 400, data: { error: 'unsupported receipt source' } };
    }
    const receipts = await states.markReceiptThrough({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      message_id: messageId,
      identity,
      status,
      source,
      provider_sequence: input.provider_sequence == null ? undefined : Number(input.provider_sequence),
      metadata: bodyObject(input.metadata)
    });
    const unreadCount = await states.unreadCount({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      identity
    });
    const payload = {
      session_id: sessionId,
      message_id: messageId,
      identity,
      receipts,
      unread_count: unreadCount
    };
    wsBroadcast(ctx.tenantId, 'collaboration.message.receipt_updated', payload);
    return { status: 201, data: payload };
  }

  const messageMutationHistoryMatch = routePath.match(
    /^\/api\/collaboration\/sessions\/([^/]+)\/messages\/([^/]+)\/mutations$/
  );
  if (messageMutationHistoryMatch && method === 'GET') {
    const sessionId = decodeURIComponent(messageMutationHistoryMatch[1]);
    const messageId = decodeURIComponent(messageMutationHistoryMatch[2]);
    const collaboration = await module.sessions.getSession(sessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    const mutations = await new CollaborationMessageStateStore(requirePg(pg)).listMutations({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      message_id: messageId
    });
    return { data: { session_id: sessionId, message_id: messageId, mutations } };
  }

  const messageMutationMatch = routePath.match(
    /^\/api\/collaboration\/sessions\/([^/]+)\/messages\/([^/]+)$/
  );
  if (messageMutationMatch && (method === 'PATCH' || method === 'DELETE')) {
    const sessionId = decodeURIComponent(messageMutationMatch[1]);
    const messageId = decodeURIComponent(messageMutationMatch[2]);
    const collaboration = await module.sessions.getSession(sessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    const actorIdentity = collaborationActorIdentity(ctx, headers);
    const input = bodyObject(body);
    const states = new CollaborationMessageStateStore(requirePg(pg));
    const message = method === 'PATCH'
      ? await states.editMessage({
        tenant_id: ctx.tenantId,
        session_id: sessionId,
        message_id: messageId,
        actor_identity: actorIdentity,
        body: String(input.body || ''),
        reason: input.reason ? String(input.reason) : undefined
      })
      : await states.deleteMessage({
        tenant_id: ctx.tenantId,
        session_id: sessionId,
        message_id: messageId,
        actor_identity: actorIdentity,
        reason: input.reason ? String(input.reason) : undefined
      });
    const quality = qualityReviewService(requirePg(pg), options);
    const qualityReviewJob = method === 'PATCH' && qualityReviewAutoEnqueue(quality.provider)
      ? await quality.service.enqueueMessage({ tenant_id: ctx.tenantId, message_id: messageId })
      : method === 'DELETE'
        ? await quality.service.cancelMessage({
          tenant_id: ctx.tenantId,
          message_id: messageId,
          reason: input.reason ? String(input.reason) : undefined
        })
        : null;
    const mutations = await states.listMutations({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      message_id: messageId
    });
    const payload = {
      session_id: sessionId,
      message,
      mutation: mutations.at(-1) || null,
      quality_review_job: qualityReviewJob
    };
    wsBroadcast(
      ctx.tenantId,
      method === 'PATCH' ? 'collaboration.message.edited' : 'collaboration.message.deleted',
      payload
    );
    return { status: 200, data: payload };
  }

  const sessionChatMatch = routePath.match(/^\/api\/collaboration\/sessions\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (sessionChatMatch) {
    const collaborationSessionId = decodeURIComponent(sessionChatMatch[1]);
    const section = sessionChatMatch[2] || '';
    const action = sessionChatMatch[3] || '';
    const collaboration = await module.sessions.getSession(collaborationSessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    const input = bodyObject(body);

    if (section === 'close' && !action && method === 'POST') {
      const actorIdentity = collaborationActorIdentity(ctx, headers);
      const participants = await module.sessions.listParticipants({
        tenant_id: ctx.tenantId,
        session_id: collaboration.id
      });
      if (!participants.some((participant) => participant.identity === actorIdentity && !participant.left_at)) {
        return { status: 403, data: { error: 'active participant identity is required' } };
      }
      const gateway = options.chatGateway || configuredChatGateway();
      const binding = await module.sessions.getChatBinding({
        tenant_id: ctx.tenantId,
        session_id: collaboration.id
      });
      if (binding && binding.provider !== gateway.provider) {
        return { status: 503, data: { error: 'chat provider gateway is unavailable' } };
      }
      if (binding) {
        await Promise.all(participants.filter((participant) => !participant.left_at).map((participant) =>
          gateway.removeParticipant({
            tenant_id: ctx.tenantId,
            session_id: collaboration.id,
            provider_topic_id: binding.provider_topic_id,
            identity: participant.identity,
            display_name: participant.display_name,
            access_mode: 'N'
          })
        ));
      }
      const closed = await module.sessions.closeSession(collaboration.id);
      wsBroadcast(ctx.tenantId, 'collaboration.session.closed', {
        session_id: collaboration.id,
        session: closed,
        closed_by: actorIdentity
      });
      return { status: 200, data: closed };
    }

    if (section === 'realtime-state' && !action && method === 'GET') {
      const states = await new CollaborationMessageStateStore(requirePg(pg)).listRealtimeStates({
        tenant_id: ctx.tenantId,
        session_id: collaboration.id
      });
      return { data: { session_id: collaboration.id, states } };
    }

    if ((section === 'typing' || section === 'presence') && !action && method === 'POST') {
      const actorIdentity = collaborationActorIdentity(ctx, headers);
      const identity = String(input.identity || actorIdentity || '').trim();
      if (!actorIdentity || identity !== actorIdentity) {
        return { status: 403, data: { error: 'realtime identity must match authenticated user' } };
      }
      const states = new CollaborationMessageStateStore(requirePg(pg));
      const state = section === 'typing'
        ? await states.updateTyping({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          identity,
          typing: input.typing === true,
          ttl_ms: input.ttl_ms == null ? undefined : Number(input.ttl_ms)
        })
        : await states.updatePresence({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          identity,
          status: String(input.status || '') as 'online' | 'away' | 'offline',
          ttl_ms: input.ttl_ms == null ? undefined : Number(input.ttl_ms)
        });
      const payload = { session_id: collaboration.id, identity, state };
      wsBroadcast(
        ctx.tenantId,
        section === 'typing' ? 'collaboration.typing.updated' : 'collaboration.presence.updated',
        payload
      );
      return { status: 201, data: payload };
    }

    if (section === 'message-state' && !action && method === 'GET') {
      const identity = collaborationActorIdentity(ctx, headers);
      if (!identity) return { status: 400, data: { error: 'authenticated user identity is required' } };
      const states = new CollaborationMessageStateStore(requirePg(pg));
      const [unreadCount, receipts] = await Promise.all([
        states.unreadCount({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          identity
        }),
        states.listReceipts({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          identity
        })
      ]);
      return {
        data: {
          session_id: collaboration.id,
          identity,
          unread_count: unreadCount,
          receipts
        }
      };
    }

    if (section === 'findings' && !action && method === 'GET') {
      const findings = await new PolicyFindingStore(requirePg(pg)).listFindings({
        tenant_id: ctx.tenantId,
        session_id: collaboration.id,
        message_id: url.searchParams.get('message_id') || undefined,
        source: (url.searchParams.get('source') || undefined) as 'text' | 'ocr' | 'asr' | 'ai' | undefined,
        review_status: (url.searchParams.get('review_status') || undefined) as
          | 'pending'
          | 'confirmed'
          | 'false_positive'
          | 'resolved'
          | 'escalated'
          | undefined,
        limit: Number(url.searchParams.get('limit') || 100)
      });
      return { data: { session_id: collaboration.id, findings } };
    }

    if (section === 'findings' && action && method === 'GET') {
      const store = new PolicyFindingStore(requirePg(pg));
      const finding = await store.getFinding({
        tenant_id: ctx.tenantId,
        finding_id: decodeURIComponent(action)
      });
      if (!finding || finding.session_id !== collaboration.id) {
        return { status: 404, data: { error: 'policy finding not found' } };
      }
      const reviews = await store.listReviews({
        tenant_id: ctx.tenantId,
        finding_id: finding.id
      });
      return { data: { session_id: collaboration.id, finding, reviews } };
    }

    if (section === 'attachments' && action === 'upload' && method === 'POST') {
      const kind = String(url.searchParams.get('kind') || input.kind || 'file').trim();
      if (!CHAT_ATTACHMENT_KINDS.has(kind)) {
        return { status: 400, data: { error: 'unsupported attachment kind' } };
      }
      const content = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
      if (!content.length) return { status: 400, data: { error: 'attachment body required' } };
      if (content.length > attachmentUploadMaxBytes()) {
        return { status: 413, data: { error: 'attachment exceeds configured size limit' } };
      }
      const contentType = headerValue(headers, 'content-type').split(';')[0].trim().toLowerCase();
      if (!attachmentContentTypeAllowed(kind, contentType)) {
        return { status: 415, data: { error: 'attachment content type does not match kind' } };
      }
      const filename = String(url.searchParams.get('filename') || input.filename || `${pgId('attachment')}.bin`).trim();
      const uploaded = await createObjectStorage().upload({
        tenantId: ctx.tenantId,
        filename,
        body: content,
        contentType,
        keyPrefix: 'collaboration-attachments'
      });
      return {
        status: 201,
        data: {
          kind,
          storage_url: iveKitChatStorageUrl(uploaded.key),
          filename,
          content_type: contentType,
          size_bytes: content.length,
          checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
          processing_status: attachmentNeedsProcessing(kind) ? 'pending' : 'ready',
          metadata: { storage_key: uploaded.key }
        }
      };
    }

    if (section === 'attachments' && action && action !== 'upload' && method === 'GET') {
      const service = attachmentProcessingService(requirePg(pg), options);
      const attachment = await service.getAttachment({
        tenant_id: ctx.tenantId,
        attachment_id: decodeURIComponent(action)
      });
      if (!attachment || attachment.session_id !== collaboration.id) {
        return { status: 404, data: { error: 'collaboration attachment not found' } };
      }
      const job = await service.getJobForAttachment({
        tenant_id: ctx.tenantId,
        attachment_id: attachment.id
      });
      return { data: { attachment, job } };
    }

    if (section === 'participants' && action === 'leave' && method === 'POST') {
      const actorIdentity = collaborationActorIdentity(ctx, headers);
      const identity = String(input.identity || actorIdentity || '').trim();
      if (!identity) return { status: 400, data: { error: 'identity required' } };
      if (
        ctx.role !== 'system' &&
        identity !== actorIdentity &&
        !canManageCollaborationParticipants(ctx, activeSessionParticipant)
      ) {
        return { status: 403, data: { error: 'participant management requires an authorized role' } };
      }
      const participant = await withCollaborationParticipantLock(requirePg(pg), {
        tenantId: ctx.tenantId,
        sessionId: collaboration.id,
        identity
      }, async (lockedPg) => {
        const lockedModule = createCollaborationModule({ pg: lockedPg });
        const current = await lockedModule.sessions.leaveParticipant({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          identity
        });
        if (!current) return null;
        const gateway = options.chatGateway || configuredChatGateway();
        const binding = await lockedModule.sessions.getChatBinding({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          provider: gateway.provider
        });
        if (binding) {
          await gateway.removeParticipant({
            tenant_id: ctx.tenantId,
            session_id: collaboration.id,
            provider_topic_id: binding.provider_topic_id,
            identity,
            display_name: input.display_name ? String(input.display_name) : current.display_name,
            provider_user_id: input.provider_user_id ? String(input.provider_user_id) : undefined,
            access_mode: input.access_mode ? String(input.access_mode) : 'N'
          });
        }
        return current;
      });
      if (!participant) return { status: 404, data: { error: 'collaboration participant not found' } };
      wsBroadcast(ctx.tenantId, 'collaboration.participant.left', {
        session_id: collaboration.id,
        participant
      });
      return { status: 201, data: participant };
    }

    if (section === 'participants' && !action && method === 'POST') {
      const identity = String(input.identity || '').trim();
      if (!identity) return { status: 400, data: { error: 'identity required' } };
      if (!canManageCollaborationParticipants(ctx, activeSessionParticipant)) {
        return { status: 403, data: { error: 'participant management requires an authorized role' } };
      }
      const role = collaborationParticipantRole(input.role || 'customer');
      if (!role) return { status: 400, data: { error: 'unsupported participant role' } };
      const participant = await withCollaborationParticipantLock(requirePg(pg), {
        tenantId: ctx.tenantId,
        sessionId: collaboration.id,
        identity
      }, async (lockedPg) => {
        const lockedModule = createCollaborationModule({ pg: lockedPg });
        const gateway = options.chatGateway || configuredChatGateway();
        const binding = await ensureSessionChatBinding({
          module: lockedModule,
          gateway,
          tenantId: ctx.tenantId,
          sessionId: collaboration.id,
          title: collaboration.title
        });
        const providerUser = await gateway.ensureUser({
          tenant_id: ctx.tenantId,
          identity,
          display_name: input.display_name ? String(input.display_name) : undefined,
          provider_user_id: input.provider_user_id ? String(input.provider_user_id) : undefined
        });
        await gateway.addParticipant({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          provider_topic_id: binding.provider_topic_id,
          identity,
          display_name: input.display_name ? String(input.display_name) : undefined,
          provider_user_id: providerUser.provider_user_id
        });
        return lockedModule.sessions.addParticipant({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          identity,
          role,
          display_name: input.display_name ? String(input.display_name) : undefined,
          user_ref: input.user_ref ? businessRefFromInput(ctx.tenantId, input.user_ref as Record<string, unknown>) : undefined
        });
      });
      wsBroadcast(ctx.tenantId, 'collaboration.participant.joined', {
        session_id: collaboration.id,
        participant
      });
      return { status: 201, data: participant };
    }

    if (section === 'chat' && action === 'bind' && method === 'POST') {
      const gateway = options.chatGateway || configuredChatGateway();
      const binding = await ensureSessionChatBinding({
        module,
        gateway,
        tenantId: ctx.tenantId,
        sessionId: collaboration.id,
        title: collaboration.title,
        metadata: bodyObject(input.metadata)
      });
      return { status: 201, data: binding };
    }

    if (section === 'chat' && action === 'client-plan' && method === 'POST') {
      const actorIdentity = collaborationActorIdentity(ctx, headers);
      const identity = String(input.identity || actorIdentity || '').trim();
      if (!identity) return { status: 400, data: { error: 'identity required' } };
      if (ctx.role !== 'system' && identity !== actorIdentity) {
        return { status: 403, data: { error: 'chat identity must match authenticated user' } };
      }
      return withCollaborationParticipantLock(requirePg(pg), {
        tenantId: ctx.tenantId,
        sessionId: collaboration.id,
        identity
      }, async (lockedPg) => {
        const lockedModule = createCollaborationModule({ pg: lockedPg });
        const currentSession = await lockedModule.sessions.getSession(collaboration.id);
        if (!currentSession || currentSession.tenant_id !== ctx.tenantId) {
          return { status: 404, data: { error: 'collaboration session not found' } };
        }
        if (currentSession.status !== 'open') {
          return { status: 409, data: { error: 'collaboration session is closed' } };
        }
        const participants = await lockedModule.sessions.listParticipants({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id
        });
        const participant = participants.find((item) => item.identity === identity && !item.left_at);
        if (!participant) {
          return { status: 404, data: { error: 'active collaboration participant not found' } };
        }
        const gateway = options.chatGateway || configuredChatGateway();
        if (gateway.provider !== 'tinode') {
          return { status: 503, data: { error: 'Tinode chat gateway is not configured' } };
        }
        const binding = await ensureSessionChatBinding({
          module: lockedModule,
          gateway,
          tenantId: ctx.tenantId,
          sessionId: collaboration.id,
          title: currentSession.title
        });
        const user = await gateway.ensureUser({
          tenant_id: ctx.tenantId,
          identity,
          display_name: input.display_name ? String(input.display_name) : undefined,
          provider_user_id: input.provider_user_id ? String(input.provider_user_id) : undefined
        });
        if (!user.provider_auth_token) {
          return {
            status: 503,
            data: { error: 'Tinode user token unavailable; configure TINODE_USER_PASSWORD_SECRET or provide a token-capable provisioner' }
          };
        }
        await gateway.addParticipant({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          provider_topic_id: binding.provider_topic_id,
          identity,
          display_name: input.display_name ? String(input.display_name) : undefined,
          provider_user_id: user.provider_user_id,
          access_mode: TINODE_RECEIVE_ONLY_ACCESS_MODE
        });
        const clientWsUrl = tinodeClientWsUrl();
        if (!clientWsUrl) return { status: 503, data: { error: 'Tinode client websocket URL is not configured' } };
        return {
          status: 201,
          data: {
            provider: gateway.provider,
            provider_topic_id: binding.provider_topic_id,
            provider_user_id: user.provider_user_id,
            auth_token: user.provider_auth_token,
            ws_url: clientWsUrl,
            api_key: String(process.env.TINODE_API_KEY || ''),
            participant
          }
        };
      });
    }

    if (section === 'chat' && !action && method === 'GET') {
      return {
        data: await module.sessions.getChatSnapshot({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          limit: Number(url.searchParams.get('limit') || 100)
        })
      };
    }

    if (section === 'messages' && !action && method === 'GET') {
      const paged = ['direction', 'cursor', 'query'].some((key) => url.searchParams.has(key));
      if (paged) {
        return {
          data: await module.sessions.listMessagesPage({
            tenant_id: ctx.tenantId,
            session_id: collaboration.id,
            direction: (url.searchParams.get('direction') || 'before') as 'before' | 'after',
            query: url.searchParams.get('query') || undefined,
            cursor: url.searchParams.get('cursor') || undefined,
            limit: optionalQueryNumber(url.searchParams.get('limit'))
          })
        };
      }
      return {
        data: await module.sessions.listMessages({
          tenant_id: ctx.tenantId,
          session_id: collaboration.id,
          limit: Number(url.searchParams.get('limit') || 100)
        })
      };
    }

    if (section === 'messages' && !action && method === 'POST') {
      const bodyText = String(input.body || '').trim();
      const attachments = parseChatAttachments(input.attachments);
      if (!bodyText && attachments.length === 0) return { status: 400, data: { error: 'body or attachments required' } };
      const messageType = chatMessageType(input.message_type || (attachments[0]?.kind === 'image' ? 'image' : 'text'));
      const actorIdentity = collaborationActorIdentity(ctx, headers);
      const senderIdentity = String(input.sender_identity || actorIdentity || '').trim();
      if (!senderIdentity) return { status: 400, data: { error: 'sender_identity required' } };
      if (ctx.role !== 'system' && senderIdentity !== actorIdentity) {
        return { status: 403, data: { error: 'chat identity must match authenticated user' } };
      }

      const gateway = options.chatGateway || configuredChatGateway();
      const binding = await ensureSessionChatBinding({
        module,
        gateway,
        tenantId: ctx.tenantId,
        sessionId: collaboration.id,
        title: collaboration.title
      });
      const delivery = new TinodeMessageDeliveryService({
        pg: requirePg(pg),
        gateway,
        ...(options.tinodeDelivery || {})
      });
      const result = await delivery.createAndDeliver({
        tenant_id: ctx.tenantId,
        session_id: collaboration.id,
        sender_identity: senderIdentity,
        message_type: messageType,
        body: bodyText,
        original_language: input.original_language ? String(input.original_language) : undefined,
        metadata: {
          ...bodyObject(input.metadata),
          attachment_count: attachments.length
        },
        attachments,
        provider_topic_id: binding.provider_topic_id,
        provider_payload: providerMessageBody(messageType, bodyText, attachments),
        policy_text: policyScanText(bodyText, attachments),
        idempotency_key: headerValue(headers, 'idempotency-key') || String(input.idempotency_key || ''),
        reply_to_message_id: input.reply_to_message_id ? String(input.reply_to_message_id) : undefined,
        forwarded_from_message_id: input.forwarded_from_message_id
          ? String(input.forwarded_from_message_id)
          : undefined,
        mentions: stringArray(input.mentions)
      });
      const processingJobs = await attachmentProcessingService(requirePg(pg), options)
        .enqueueMessage(result.message);
      const quality = qualityReviewService(requirePg(pg), options);
      const qualityReviewJob = qualityReviewAutoEnqueue(quality.provider)
        ? await quality.service.enqueueMessage({
          tenant_id: ctx.tenantId,
          message_id: result.message.id
        })
        : null;
      const payload = {
        session_id: collaboration.id,
        message: result.message,
        policy: result.policy,
        binding,
        idempotency_replayed: result.replayed,
        attachment_processing_jobs: processingJobs,
        quality_review_job: qualityReviewJob
      };
      if (result.created) wsBroadcast(ctx.tenantId, 'collaboration.message.created', payload);
      if (result.created && result.policy.matched) {
        wsBroadcast(ctx.tenantId, 'collaboration.policy.matched', {
          session_id: collaboration.id,
          message_id: result.message.id,
          events: result.policy.events
        });
      }
      const deliveryStatus = result.message.provider_delivery.status;
      const status = result.replayed
        ? 200
        : deliveryStatus === 'pending' || deliveryStatus === 'publishing' || deliveryStatus === 'retry_wait'
          ? 202
          : deliveryStatus === 'failed'
            ? 502
            : 201;
      return { status, data: payload };
    }
  }

  if (routePath === '/api/collaboration/remote-assistance/sessions' && method === 'POST') {
    const input = bodyObject(body);
    const collaborationSessionId = String(input.collaboration_session_id || '').trim();
    if (!collaborationSessionId) {
      return { status: 400, data: { error: 'collaboration_session_id required' } };
    }
    const collaboration = await module.sessions.getSession(collaborationSessionId);
    if (!collaboration || collaboration.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'collaboration session not found' } };
    }
    const remote = await module.remote.createSession({
      tenant_id: ctx.tenantId,
      collaboration_session_id: collaboration.id,
      business_ref:
        input.business_ref || input.business_ref_type || input.business_ref_id
          ? businessRefFromInput(ctx.tenantId, input)
          : collaboration.business_ref,
      mode: String(input.mode || 'screen_share') as RemoteAssistanceMode,
      adapter_provider: input.adapter_provider ? String(input.adapter_provider) : undefined,
      started_by: input.started_by ? String(input.started_by) : ctx.userId,
      metadata: bodyObject(input.metadata)
    });
    return { status: 201, data: remote };
  }

  const remoteMatch = routePath.match(/^\/api\/collaboration\/remote-assistance\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!remoteMatch) return undefined;

  const remoteSessionId = decodeURIComponent(remoteMatch[1]);
  const section = remoteMatch[2] || '';
  const action = remoteMatch[3] || '';
  const remote = await requireRemoteSession(module.remote, ctx.tenantId, remoteSessionId);
  if (!remote) return { status: 404, data: { error: 'remote session not found' } };
  const input = bodyObject(body);
  const actorIdentity = collaborationRequestActorIdentity(ctx, headers, input);

  if (section === 'end' && method === 'POST') {
    const activeToolSessions = await module.remote.listToolSessions(remote.id);
    let physicalDisconnect: RemoteToolSession['physical_disconnect'];
    for (const tool of activeToolSessions) {
      if (tool.status === 'active' && isGatewayToolSession(tool)) {
        const endedTool = await module.remote.endGatewayClientSession({
          tool_session_id: tool.id,
          actor_identity: actorIdentity,
          client: await remoteGatewayClientForToolSession(tool, pg),
          reason: 'remote_session_ended'
        });
        physicalDisconnect ||= endedTool?.physical_disconnect;
      }
    }
    const endedRemote = await module.remote.endSession({
      remote_session_id: remote.id,
      actor_identity: actorIdentity
    });
    return {
      status: 201,
      data: endedRemote && physicalDisconnect
        ? { ...endedRemote, physical_disconnect: physicalDisconnect }
        : endedRemote
    };
  }

  if (section === 'timeline' && method === 'GET') {
    const [consentEvents, toolSessions, auditEvents, evidence] = await Promise.all([
      module.remote.listConsentEvents(remote.id),
      module.remote.listToolSessions(remote.id),
      module.remote.listAuditEvents({ tenant_id: ctx.tenantId, remote_session_id: remote.id }),
      module.remote.listEvidence({ tenant_id: ctx.tenantId, business_ref: remote.business_ref })
    ]);
    return {
      data: {
        session: remote,
        consent_events: consentEvents,
        tool_sessions: toolSessions,
        audit_events: auditEvents,
        evidence
      }
    };
  }

  if (section === 'consent' && method === 'POST') {
    const requestedScopes = stringArray(input.scopes);
    const unsupportedScope = unsupportedRemoteConsentScopeResponse(requestedScopes);
    if (unsupportedScope) return unsupportedScope;
    const scopes = remoteConsentScopes(requestedScopes);
    if (!scopes.length) return { status: 400, data: { error: 'scopes required' } };
    if (action === 'request') {
      return {
        status: 201,
        data: await module.remote.requestConsent({
          tenant_id: ctx.tenantId,
          remote_session_id: remote.id,
          actor_identity: actorIdentity,
          scopes,
          expires_at: input.expires_at ? String(input.expires_at) : null,
          metadata: bodyObject(input.metadata)
        })
      };
    }
    if (action === 'grant') {
      return {
        status: 201,
        data: await module.remote.grantConsent({
          tenant_id: ctx.tenantId,
          remote_session_id: remote.id,
          actor_identity: actorIdentity,
          scopes,
          expires_at: input.expires_at ? String(input.expires_at) : null,
          metadata: bodyObject(input.metadata)
        })
      };
    }
    if (action === 'deny') {
      return {
        status: 201,
        data: await module.remote.denyConsent({
          tenant_id: ctx.tenantId,
          remote_session_id: remote.id,
          actor_identity: actorIdentity,
          scopes,
          metadata: bodyObject(input.metadata)
        })
      };
    }
    if (action === 'revoke') {
      const activeToolSessions = await module.remote.listToolSessions(remote.id);
      return {
        status: 201,
        data: await module.remote.revokeConsent({
          tenant_id: ctx.tenantId,
          remote_session_id: remote.id,
          actor_identity: actorIdentity,
          scopes,
          gateway_client_for_tool: hasActiveGatewayToolSession(activeToolSessions)
            ? (tool) => isGatewayToolSession(tool)
              ? remoteGatewayClientForToolSession(tool, pg)
              : undefined
            : undefined,
          metadata: bodyObject(input.metadata)
        })
      };
    }
  }

  if (section === 'tools' && action === 'end' && method === 'POST') {
    const toolSessionId = String(input.tool_session_id || '').trim();
    if (!toolSessionId) return { status: 400, data: { error: 'tool_session_id required' } };
    const tool = await module.remote.getToolSession(toolSessionId);
    if (!tool || tool.tenant_id !== ctx.tenantId || tool.remote_session_id !== remote.id) {
      return { status: 404, data: { error: 'remote tool session not found' } };
    }
    const ended = isGatewayToolSession(tool)
      ? await module.remote.endGatewayClientSession({
        tool_session_id: tool.id,
        actor_identity: actorIdentity,
        client: await remoteGatewayClientForToolSession(tool, pg),
        reason: 'tool_ended'
      })
      : await module.remote.endToolSession(tool.id, actorIdentity);
    return { status: 201, data: ended };
  }

  if (section === 'tools' && action === 'gateway' && method === 'POST') {
    const requestedPermissions = stringArray(input.permissions || input.scopes);
    const unsupportedPermission = unsupportedRemoteConsentScope(requestedPermissions);
    if (unsupportedPermission) {
      return { status: 400, data: { error: `unsupported remote gateway permission scope: ${unsupportedPermission}` } };
    }
    const permissions = remoteConsentScopes(requestedPermissions);
    if (!permissions.length) return { status: 400, data: { error: 'permissions required' } };
    const gatewayClient = configuredRemoteGatewayClient();
    const accessMode = gatewayClient.provider === 'rustdesk'
      ? rustDeskGatewayAccessMode(input.access_mode)
      : undefined;
    if (gatewayClient.provider === 'rustdesk') {
      rustDeskGatewayMetadata(input, 'RustDesk gateway request');
      const requestMetadata = rustDeskGatewayMetadata(input.metadata);
      if (requestMetadata.access_mode !== undefined) {
        return { status: 400, data: { error: 'RustDesk access_mode must be a top-level field' } };
      }
    }
    const gatewayRequest = await resolveRemoteGatewayRequest({
      module,
      tenantId: ctx.tenantId,
      provider: gatewayClient.provider,
      body: input
    });
    const tool = await module.remote.startGatewayClientSession({
      tenant_id: ctx.tenantId,
      remote_session_id: remote.id,
      actor_identity: actorIdentity,
      client: gatewayClient,
      target: gatewayRequest.target,
      permissions,
      access_mode: accessMode,
      device_id: gatewayRequest.deviceId,
      metadata: gatewayRequest.metadata
    });
    return { status: 201, data: tool };
  }

  if (section === 'tools' && !action && method === 'POST') {
    const provider = String(input.provider || 'external_link') as RemoteToolProvider;
    if (provider === 'rustdesk') rustDeskGatewayMetadata(input, 'RustDesk gateway request');
    const tool = await module.remote.startToolSession({
      tenant_id: ctx.tenantId,
      remote_session_id: remote.id,
      actor_identity: actorIdentity,
      provider,
      external_id: input.external_id ? String(input.external_id) : undefined,
      launch_url: input.launch_url ? String(input.launch_url) : undefined,
      metadata: bodyObject(input.metadata)
    });
    return { status: 201, data: tool };
  }

  if (section === 'events' && method === 'POST') {
    if (remote.mode !== 'web_remote_assist') {
      return { status: 400, data: { error: 'remote session is not Web Assist' } };
    }
    const eventType = String(input.event_type || '').trim();
    if (!eventType) return { status: 400, data: { error: 'event_type required' } };
    if (!(await module.remote.hasActiveConsent(remote.id))) {
      throw Object.assign(new Error('active consent required before recording Web Assist event'), { status: 403 });
    }
    const event = await recordAndBroadcastWebAssistEvent({
      module,
      tenantId: ctx.tenantId,
      remote,
      actorIdentity,
      eventType,
      payload: input.payload
    });
    return { status: 201, data: event };
  }

  if (section === 'media' && action === 'join' && method === 'GET') {
    if (!(await module.remote.hasActiveConsent(remote.id))) {
      throw Object.assign(new Error('active consent required before joining Web Assist media'), { status: 403 });
    }
    return issueWebAssistMediaJoin({
      db: options.db,
      tenantId: ctx.tenantId,
      remote,
      identity: String(url.searchParams.get('identity') || actorIdentity),
      role: 'agent'
    });
  }

  if (section === 'audit' && action === 'gateway-sync' && method === 'POST') {
    const toolSessionId = String(input.tool_session_id || '').trim();
    if (!toolSessionId) return { status: 400, data: { error: 'tool_session_id required' } };
    const tool = await module.remote.getToolSession(toolSessionId);
    if (!tool || tool.tenant_id !== ctx.tenantId || tool.remote_session_id !== remote.id) {
      return { status: 404, data: { error: 'remote tool session not found' } };
    }
    const events = await module.remote.syncGatewayAuditEvents({
      tenant_id: ctx.tenantId,
      remote_session_id: remote.id,
      actor_identity: actorIdentity,
      client: await remoteGatewayClientForToolSession(tool, pg),
      external_id: tool.external_id,
      since: input.since ? String(input.since) : undefined
    });
    return { status: 201, data: { synced: events.length, events } };
  }

  if (section === 'audit' && method === 'POST') {
    if (!input.event_type) return { status: 400, data: { error: 'event_type required' } };
    return {
      status: 201,
      data: await module.remote.recordAudit({
        tenant_id: ctx.tenantId,
        remote_session_id: remote.id,
        actor_identity: actorIdentity,
        event_type: String(input.event_type),
        target: input.target ? String(input.target) : undefined,
        metadata: bodyObject(input.metadata)
      })
    };
  }

  if (section === 'evidence' && action === 'upload' && method === 'POST') {
    const buffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
    if (!buffer.length) return { status: 400, data: { error: 'empty body' } };
    const kind = String(url.searchParams.get('kind') || 'screen_recording') as EvidenceKind;
    const uploaded = await createObjectStorage().upload({
      tenantId: ctx.tenantId,
      filename: safeFilename(url.searchParams.get('filename')),
      body: buffer,
      contentType: String(headers['content-type'] || headers['Content-Type'] || 'application/octet-stream')
    });
    const evidence = await module.remote.recordEvidence({
      tenant_id: ctx.tenantId,
      business_ref: remote.business_ref,
      session_id: remote.id,
      kind,
      storage_url: collaborationStorageUrl(uploaded),
      checksum: `sha256:${createHash('sha256').update(buffer).digest('hex')}`,
      retention_until: url.searchParams.get('retention_until'),
      created_by: actorIdentity,
      metadata: {
        storage_key: uploaded.key,
        content_type: String(headers['content-type'] || headers['Content-Type'] || 'application/octet-stream')
      }
    });
    await module.remote.recordAudit({
      tenant_id: ctx.tenantId,
      remote_session_id: remote.id,
      actor_identity: actorIdentity,
      event_type: 'remote.evidence.recorded',
      target: evidence.id,
      metadata: { kind: evidence.kind, storage_url: evidence.storage_url }
    });
    return { status: 201, data: evidence };
  }

  if (section === 'evidence' && method === 'POST') {
    const kind = String(input.kind || 'remote_control_log') as EvidenceKind;
    const evidence = await module.remote.recordEvidence({
      tenant_id: ctx.tenantId,
      business_ref: remote.business_ref,
      session_id: remote.id,
      kind,
      storage_url: input.storage_url ? String(input.storage_url) : undefined,
      checksum: input.checksum ? String(input.checksum) : undefined,
      retention_until: input.retention_until ? String(input.retention_until) : null,
      created_by: actorIdentity,
      metadata: bodyObject(input.metadata)
    });
    await module.remote.recordAudit({
      tenant_id: ctx.tenantId,
      remote_session_id: remote.id,
      actor_identity: actorIdentity,
      event_type: 'remote.evidence.recorded',
      target: evidence.id,
      metadata: { kind: evidence.kind, storage_url: evidence.storage_url }
    });
    return { status: 201, data: evidence };
  }

  return undefined;
}

function optionalQueryNumber(value: string | null): number | undefined {
  return value == null || value === '' ? undefined : Number(value);
}

function reactionCounts(reactions: Array<{ emoji: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reaction of reactions) counts[reaction.emoji] = (counts[reaction.emoji] || 0) + 1;
  return counts;
}
