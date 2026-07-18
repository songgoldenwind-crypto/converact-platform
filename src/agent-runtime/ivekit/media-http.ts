import { createHash } from 'node:crypto';

import { resolveAuthContext } from '../../middleware/auth.js';
import { getPostgresOrNull, pgId, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { wsBroadcastToUsers } from '../../ws.js';
import { createLiveKitMediaModule, issueSupervisorToken } from '../livekit/index.js';
import { MediaCallService } from '../livekit/media-call-service.js';
import { MediaCallStore } from '../livekit/media-call-store.js';
import {
  MediaQualityService,
  mediaQualityServiceOptionsFromEnv
} from '../livekit/media-quality-service.js';
import { MediaQualityStore } from '../livekit/media-quality-store.js';
import {
  observeMediaConnectionEvent,
  observeMediaQualityReport,
  observeMediaQualityTransition
} from '../livekit/media-quality-metrics.js';
import {
  createConfiguredLiveKitModerationProvider,
  LiveKitModerationService,
  type LiveKitModerationProvider,
  type LiveKitModerationProviderResolver,
  type LiveKitModerationResult
} from '../livekit/livekit-moderation-service.js';
import {
  isLiveKitBrowserJoinConfigured,
  isLiveKitConfigured,
  readLiveKitConfig
} from '../livekit/config.js';
import { liveKitConfigForPlacement } from '../livekit/token-service.js';
import type { RecordingAuditEvent } from '../livekit/media-http.js';
import type {
  EgressRecord,
  LiveKitEgressJob,
  LiveKitRecordingMode,
  LiveKitRecordingTrackSelector,
  MediaBusinessRef,
  MediaRoomPurpose,
  RecordingFormat,
  RecordingObjectContentResult,
  RecordingObjectStreamResult,
  RecordingObjectDeleteResult
} from '../livekit/types.js';
import type { LiveKitEgressPlacementPort } from './placement/livekit-egress-placement.js';
import type {
  IveKitMediaConnectionEventInput,
  IveKitMediaConnectionEventResult,
  IveKitMediaCallAction,
  IveKitMediaQualitySnapshotInput,
  IveKitMediaQualityTransition,
  IveKitMediaCallSnapshot,
  IveKitMediaTrackSource
} from '../livekit/types.js';
import type { MediaChannel } from '../media-gateway/index.js';
import { IveKitTenantEventJournal } from './tenant-event-store.js';
import type {
  MediaCallPlacementPort,
  MediaCallPlacementReservation
} from '../livekit/media-call-service.js';
import type { LiveKitWebhookResult } from '../livekit/types.js';

export interface RouteIveKitMediaApiOptions {
  pg?: PgQueryable;
  commandPg?: PgQueryable;
  mediaQualityService?: Pick<
    MediaQualityService,
    'reportQuality' | 'reportConnectionEvent' | 'getSummary' | 'prune'
  >;
  eventStore?: Pick<IveKitTenantEventJournal, 'append'>;
  moderationProvider?: LiveKitModerationProvider;
  onRecordingStarted?: (recording: EgressRecord, context: { roomName: string }) => Promise<unknown>;
  onRecordingCompleted?: (recording: EgressRecord, context: { roomName: string }) => Promise<unknown>;
  resolveRecordingObject?: (recording: EgressRecord) => Promise<RecordingObjectContentResult>;
  resolveRecordingObjectStream?: (recording: EgressRecord) => Promise<RecordingObjectStreamResult>;
  deleteRecordingObject?: (recording: EgressRecord) => Promise<RecordingObjectDeleteResult>;
  resolveRecordingRetentionDays?: (tenantId: string) => number | Promise<number>;
  onRecordingDeleted?: (
    recording: EgressRecord,
    context: { actorId: string; source?: string }
  ) => void | Promise<unknown>;
  onRecordingAudit?: (event: RecordingAuditEvent) => void | Promise<void>;
  placement?: MediaCallPlacementPort;
  egressPlacement?: LiveKitEgressPlacementPort;
  placementWorkerId?: string;
  preparedMediaCallPlacement?: PreparedMediaCallPlacement;
}

export interface PreparedMediaCallPlacement {
  tenant_id: string;
  call_id: string;
  reservation: MediaCallPlacementReservation;
}

export async function prepareIveKitMediaCallPlacement(
  method: string,
  routePath: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitMediaApiOptions
): Promise<PreparedMediaCallPlacement | null> {
  if (!options.placement ||
      method !== 'POST' ||
      routePath !== '/api/ivekit/media/calls') {
    return null;
  }
  const ctx = requireAuth(headers);
  const input = bodyRecord(body);
  const businessRef = optionalBusinessRef(ctx.tenantId, input);
  if (!businessRef) throw badRequest('business_ref is required');
  const actorIdentity = mediaActorIdentity(ctx, headers);
  if (!actorIdentity) throw badRequest('authenticated media call identity is required');
  const participantIdentities = Array.isArray(input.participant_identities)
    ? input.participant_identities.map((identity) => String(identity || '').trim()).filter(Boolean)
    : [];
  const invitees = [...new Set(participantIdentities)]
    .filter((identity) => identity !== actorIdentity);
  const callId = pgId('mcall');
  return {
    tenant_id: ctx.tenantId,
    call_id: callId,
    reservation: await options.placement.reserve({
      tenant_id: ctx.tenantId,
      interaction_id: callId,
      media: String(input.media || 'video') === 'voice' ? 'voice' : 'video',
      participant_count: invitees.length + 1,
      business_ref: businessRef,
      idempotency_key: headerValue(headers, 'idempotency-key') || `media-call:${callId}`
    })
  };
}

function requireMediaCallPg(pg: PgQueryable | undefined): PgQueryable {
  if (!pg) throw Object.assign(new Error('postgres is required for iveKit media calls'), { status: 503 });
  return pg;
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 404 });
}

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

function requireRecordingCleanupRole(role: string): void {
  if (role === 'owner' || role === 'admin' || role === 'system') return;
  throw Object.assign(new Error('recording retention cleanup requires admin role'), { status: 403 });
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function requiredBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${key} is required`);
  return value.trim();
}

function optionalBodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalBodyNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${key} must be a number`);
  return parsed;
}

function optionalQueryNumber(value: string | null): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest('query value must be a number');
  return parsed;
}

function optionalBodyRecord(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = body[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function optionalRecordingMode(body: Record<string, unknown>): LiveKitRecordingMode | undefined {
  return optionalBodyString(body, 'recording_mode') as LiveKitRecordingMode | undefined;
}

function optionalRecordingTracks(body: Record<string, unknown>): LiveKitRecordingTrackSelector[] | undefined {
  const value = body.tracks;
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw badRequest('tracks must be an array');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw badRequest('track selector must be an object');
    }
    const track = entry as Record<string, unknown>;
    return {
      trackId: requiredBodyString(track, 'track_id'),
      kind: String(track.kind || '') as LiveKitRecordingTrackSelector['kind'],
      source: String(track.source || 'unknown') as LiveKitRecordingTrackSelector['source']
    };
  });
}

function optionalBusinessRef(tenantId: string, input: Record<string, unknown>): MediaBusinessRef | null {
  const raw = optionalBodyRecord(input, 'business_ref');
  const type = String(raw?.type || input.business_ref_type || '').trim();
  const id = String(raw?.id || input.business_ref_id || '').trim();
  if (!raw && !type && !id) return null;
  if (!type || !id) throw badRequest('business_ref.type and business_ref.id are required');
  const refTenant = String(raw?.tenant_id || tenantId).trim();
  if (refTenant !== tenantId) throw badRequest('business_ref tenant mismatch');
  return {
    tenant_id: tenantId,
    type,
    id,
    display_name: raw?.display_name ? String(raw.display_name) : undefined,
    metadata: optionalBodyRecord(raw || {}, 'metadata') || optionalBodyRecord(input, 'business_ref_metadata') || {}
  };
}

function roomBusinessRef(room: { tenant_id: string; metadata: Record<string, unknown> }): MediaBusinessRef | null {
  const raw = room.metadata.business_ref;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const type = String(value.type || '').trim();
  const id = String(value.id || '').trim();
  if (!type || !id) return null;
  return {
    tenant_id: room.tenant_id,
    type,
    id,
    display_name: value.display_name ? String(value.display_name) : undefined,
    metadata: optionalBodyRecord(value, 'metadata') || {}
  };
}

function requireTenantRoom(
  media: ReturnType<typeof createLiveKitMediaModule>,
  input: { tenantId: string; roomName: string; requireOpen?: boolean }
) {
  const room = media.rooms.getRoomByName(input.roomName);
  if (!room || room.tenant_id !== input.tenantId) throw notFound('media room not found');
  if (input.requireOpen && room.status === 'closed') {
    throw Object.assign(new Error('media room is closed'), { status: 409 });
  }
  return room;
}

function requireTenantRecording<T extends { tenant_id?: string }>(recording: T | null, tenantId: string): T {
  if (!recording || recording.tenant_id !== tenantId) throw notFound('media recording not found');
  return recording;
}

function publicRecording(recording: EgressRecord): Omit<EgressRecord, 'storage_url'> {
  const { storage_url: _storageUrl, ...safe } = recording;
  return safe;
}

function publicRecordingPage(page: {
  items: EgressRecord[];
  next_cursor: string | null;
  has_more: boolean;
}) {
  return { ...page, items: page.items.map(publicRecording) };
}

function publicEgressJob(job: LiveKitEgressJob): Record<string, unknown> {
  const {
    storage_url: _storageUrl,
    reservation_id: _reservationId,
    owner_epoch: _ownerEpoch,
    provider_observed_at: _providerObservedAt,
    provider_missing_count: _providerMissingCount,
    reconcile_attempts: _reconcileAttempts,
    reconcile_after: _reconcileAfter,
    reconcile_lease_until: _reconcileLeaseUntil,
    reconcile_worker_id: _reconcileWorkerId,
    ...safe
  } = job;
  return safe;
}

async function closeTerminalEgressPlacement(
  media: ReturnType<typeof createLiveKitMediaModule>,
  result: LiveKitWebhookResult,
  options: RouteIveKitMediaApiOptions
): Promise<void> {
  if (!result.recording || !result.egress_job_id || !options.egressPlacement || !options.pg) return;
  const job = media.recordings.getEgressJob(result.recording.id, result.egress_job_id);
  if (!job || !['completed', 'failed', 'stopped'].includes(job.status) ||
      !job.reservation_id || !job.owner_epoch) return;
  try {
    await options.egressPlacement.closeJobById(options.pg, {
      tenant_id: job.tenant_id,
      job_id: job.id,
      reservation_id: job.reservation_id,
      owner_epoch: job.owner_epoch,
      reason: `livekit_egress_${job.status}`
    });
  } catch (cause) {
    const error = Object.assign(new Error('LiveKit Egress placement release failed'), {
      status: 503,
      retryable: true,
      cause
    });
    throw error;
  }
}

function capabilities(
  tenantId: string,
  media: ReturnType<typeof createLiveKitMediaModule>
) {
  const livekitConfig = readLiveKitConfig();
  const livekitUrl = livekitConfig.url || '';
  const livekitPublicUrl = livekitConfig.publicUrl || '';
  const livekitApiKey = livekitConfig.apiKey || '';
  const livekitApiSecret = livekitConfig.apiSecret || '';
  const inviteSecret = String(process.env.OPC_MEDIA_INVITE_SECRET || process.env.LIVEKIT_MEDIA_INVITE_SECRET || '').trim();
  const minioAccessKey = String(process.env.MINIO_ACCESS_KEY || '').trim();
  const minioSecretKey = String(process.env.MINIO_SECRET_KEY || '').trim();
  const sipReady = media.gateways.get('sip_volte').definition.status === 'active';

  return {
    provider: 'livekit',
    tenant_id: tenantId,
    capabilities: {
      calls: true,
      rooms: true,
      tokens: true,
      join: true,
      participants: true,
      host_moderation: true,
      recording: true,
      recording_object_check: true,
      recording_export: true,
      recording_retention_cleanup: true,
      quality_observability: true,
      connection_rejoin_events: true,
      webhooks: true,
      web_assist: true,
      sip_volte: sipReady ? 'ready' : 'planned'
    },
    config: {
      livekit_url_configured: Boolean(livekitUrl),
      livekit_public_url_configured: Boolean(livekitPublicUrl),
      livekit_server_configured: isLiveKitConfigured(livekitConfig),
      livekit_browser_join_ready: isLiveKitBrowserJoinConfigured(livekitConfig),
      livekit_api_key_configured: Boolean(livekitApiKey),
      livekit_api_secret_configured: Boolean(livekitApiSecret),
      invite_secret_configured: Boolean(inviteSecret),
      egress_configured: Boolean(minioAccessKey && minioSecretKey)
    }
  };
}

export async function routeIveKitMediaApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  rawBody: string | Buffer = '',
  headers: Record<string, string | string[] | undefined> = {},
  options: RouteIveKitMediaApiOptions = {}
): Promise<unknown | undefined> {
  const routePath = path.split('?')[0];
  if (!routePath.startsWith('/api/ivekit/media')) return undefined;

  const media = createLiveKitMediaModule({
    db,
    recordingDependencies: {
      resolveRecordingObject: options.resolveRecordingObject,
      resolveRecordingObjectStream: options.resolveRecordingObjectStream,
      deleteRecordingObject: options.deleteRecordingObject,
      resolveRetentionDays: options.resolveRecordingRetentionDays,
      ...(options.placement && options.pg
        ? {
            resolveLiveKitConfig: async (
              input: {
                tenant_id: string;
                media_call_id: string;
                room_name: string;
              },
              base: ReturnType<typeof readLiveKitConfig>
            ) => {
              if (!input.media_call_id) return base;
              const placement = await options.placement!.resolveOwner(
                options.pg!,
                {
                  tenant_id: input.tenant_id,
                  interaction_id: input.media_call_id
                }
              );
              return liveKitConfigForPlacement(base, placement);
            }
          }
        : {}),
      ...(options.egressPlacement && options.pg
        ? {
            reserveEgressJob: (input: import('../livekit/types.js').LiveKitEgressPlacementInput) =>
              options.egressPlacement!.reserveJob(options.pg!, input),
            activateEgressJob: (reservation: import('../livekit/types.js').LiveKitEgressPlacementReservation) =>
              options.egressPlacement!.activateJob(options.pg!, reservation),
            closeEgressJob: (
              reservation: import('../livekit/types.js').LiveKitEgressPlacementReservation,
              reason: string
            ) => options.egressPlacement!.closeJob(options.pg!, reservation, reason)
          }
        : {})
    }
  });

  if (routePath === '/api/ivekit/media/webhooks/livekit' && method === 'POST') {
    const authHeader = headerValue(headers, 'authorization');
    const rawBodyText = rawBody
      ? String(rawBody)
      : typeof body === 'string'
        ? body
        : JSON.stringify(body || {});
    const result = await media.webhooks.handleWebhook(rawBodyText, authHeader || undefined);
    await revokeTerminalCallRevival(rawBodyText, result, options);
    await closeTerminalEgressPlacement(media, result, options);
    if (result.recording) await broadcastMediaRecording(options.pg, 'ivekit.media.recording.updated', result.recording);
    if (!result.recording || result.recording.status !== 'completed' || !options.onRecordingCompleted) {
      return result.recording ? { ...result, recording: publicRecording(result.recording) } : result;
    }
    const evidence = await options.onRecordingCompleted(result.recording, {
      roomName: result.room_name || result.recording.business_ref?.id || ''
    });
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      return { ...result, recording: publicRecording(result.recording) };
    }
    const evidenceRecord = evidence as { id?: unknown };
    const linked = evidenceRecord.id
      ? media.recordings.setEvidenceRecordId(result.recording.id, String(evidenceRecord.id)) || result.recording
      : result.recording;
    return {
      ...result,
      recording: publicRecording(linked),
      evidence_record_id: evidenceRecord.id ? String(evidenceRecord.id) : '',
      evidence_record: evidence
    };
  }

  const ctx = requireAuth(headers);

  const moderationProvider = liveKitModerationProviderSource(options);
  const moderationCommandPg = options.commandPg || getPostgresOrNull() || options.pg;
  const mediaCallStore = () => new MediaCallStore(requireMediaCallPg(options.pg));
  const mediaModerationService = () => new LiveKitModerationService(
    mediaCallStore(),
    moderationProvider,
    { commandPg: moderationCommandPg }
  );
  const mediaCallService = () => {
    const moderation = mediaModerationService();
    return new MediaCallService(mediaCallStore(), {
      beforeTerminalTransition: (snapshot) => moderation.revokeForTerminal(snapshot),
      placement: options.placement
    });
  };
  const qualityService = () => options.mediaQualityService || new MediaQualityService(
    new MediaQualityStore(requireMediaCallPg(options.pg)),
    mediaQualityServiceOptionsFromEnv()
  );
  const durableEventStore = options.eventStore || (() => {
    const eventPg = getPostgresOrNull();
    return eventPg ? new IveKitTenantEventJournal(eventPg) : undefined;
  })();
  const requireRecordingCallAccess = async (
    callId: string | undefined,
    hostOnly = false,
    expectedRoomName?: string
  ) => {
    if (ctx.role === 'system') return;
    if (!callId) throw notFound('media recording not found');
    const snapshot = await withPgTenant(requireMediaCallPg(options.pg), ctx.tenantId, (tenantPg) =>
      new MediaCallStore(tenantPg).snapshot(ctx.tenantId, callId)
    );
    if (!snapshot) throw notFound('media recording not found');
    if (expectedRoomName && snapshot.call.room_name !== expectedRoomName) {
      throw notFound('media recording not found');
    }
    requireMediaCallReadAccess(ctx, headers, snapshot);
    if (!hostOnly) return;
    const identity = mediaActorIdentity(ctx, headers);
    const participant = snapshot.participants.find((item) => item.identity === identity && item.status !== 'removed');
    if (participant?.role !== 'host') throw Object.assign(new Error('recording command requires host role'), { status: 403 });
  };

  if (routePath === '/api/ivekit/media/calls' && method === 'POST') {
    const input = bodyRecord(body);
    const businessRef = optionalBusinessRef(ctx.tenantId, input);
    if (!businessRef) throw badRequest('business_ref is required');
    const actorIdentity = mediaActorIdentity(ctx, headers);
    if (!actorIdentity) throw badRequest('authenticated media call identity is required');
    const participantIdentities = Array.isArray(input.participant_identities)
      ? input.participant_identities.map((identity) => String(identity || '').trim()).filter(Boolean)
      : [];
    const prepared = options.preparedMediaCallPlacement;
    if (prepared && prepared.tenant_id !== ctx.tenantId) {
      throw badRequest('prepared media placement tenant mismatch');
    }
    const snapshot = await mediaCallService().createCall({
      tenant_id: ctx.tenantId,
      call_id: prepared?.call_id,
      initiated_by: actorIdentity,
      media: String(input.media || 'video') === 'voice' ? 'voice' : 'video',
      participant_identities: participantIdentities,
      business_ref: businessRef,
      title: optionalBodyString(input, 'title'),
      metadata: bodyRecord(input.metadata),
      ring_timeout_seconds: optionalBodyNumber(input, 'ring_timeout_seconds'),
      idempotency_key: headerValue(headers, 'idempotency-key'),
      placement_reservation: prepared?.reservation
    });
    return {
      status: 201,
      data: snapshot,
      afterCommit: () => Promise.all([
        broadcastMediaCall(ctx.tenantId, 'ivekit.media.call.created', snapshot),
        reconcileDurableMediaCallPlacement(
          options.placement,
          ctx.tenantId,
          snapshot.call.id
        )
      ])
    };
  }

  const mediaCallMatch = routePath.match(/^\/api\/ivekit\/media\/calls\/([^/]+)(?:\/([^/]+))?$/);
  if (mediaCallMatch) {
    const callId = decodeURIComponent(mediaCallMatch[1]);
    const action = mediaCallMatch[2] || '';
    const calls = mediaCallService();

    if (!action && method === 'GET') {
      const snapshot = await calls.getCall(ctx.tenantId, callId);
      if (!snapshot) throw notFound('media call not found');
      requireMediaCallReadAccess(ctx, headers, snapshot);
      return { data: snapshot };
    }

    if (action === 'participants' && method === 'GET') {
      const snapshot = await calls.getCall(ctx.tenantId, callId);
      if (!snapshot) throw notFound('media call not found');
      requireMediaCallReadAccess(ctx, headers, snapshot);
      return {
        data: {
          items: snapshot.participants,
          next_cursor: null,
          has_more: false
        }
      };
    }

    if (action === 'qos' && method === 'GET') {
      const snapshot = await calls.getCall(ctx.tenantId, callId);
      if (!snapshot) throw notFound('media call not found');
      requireMediaCallReadAccess(ctx, headers, snapshot);
      const summary = await qualityService().getSummary({
        tenant_id: ctx.tenantId,
        call_id: callId,
        limit: optionalQueryNumber(url.searchParams.get('limit'))
      });
      if (!summary) throw notFound('media call not found');
      return { data: summary };
    }

    if (action === 'qos' && method === 'POST') {
      const input = bodyRecord(body);
      const snapshot = await calls.getCall(ctx.tenantId, callId);
      if (!snapshot) throw notFound('media call not found');
      requireMediaCallReadAccess(ctx, headers, snapshot);
      const snapshots = Array.isArray(input.snapshots)
        ? input.snapshots as IveKitMediaQualitySnapshotInput[]
        : [];
      if (ctx.role !== 'system') {
        const actorIdentity = mediaActorIdentity(ctx, headers);
        if (snapshots.some((item) => String(item?.participant_identity || '').trim() !== actorIdentity)) {
          throw Object.assign(new Error('QoS participant identity must match authenticated user'), { status: 403 });
        }
      }
      const result = await qualityService().reportQuality({
        tenant_id: ctx.tenantId,
        call_id: callId,
        snapshots
      });
      observeMediaQualityReport(snapshots, result);
      result.transitions.forEach(observeMediaQualityTransition);
      return {
        status: 202,
        data: result,
        ...(result.transitions.length === 0
          ? {}
          : {
            afterCommit: () => publishMediaQualityTransitions(
              ctx.tenantId,
              snapshot,
              result.transitions,
              durableEventStore
            )
          })
      };
    }

    if (action === 'connection-events' && method === 'POST') {
      const input = bodyRecord(body) as unknown as IveKitMediaConnectionEventInput;
      const snapshot = await calls.getCall(ctx.tenantId, callId);
      if (!snapshot) throw notFound('media call not found');
      requireMediaCallReadAccess(ctx, headers, snapshot);
      if (
        ctx.role !== 'system'
        && String(input.participant_identity || '').trim() !== mediaActorIdentity(ctx, headers)
      ) {
        throw Object.assign(
          new Error('connection participant identity must match authenticated user'),
          { status: 403 }
        );
      }
      const result = await qualityService().reportConnectionEvent({
        tenant_id: ctx.tenantId,
        call_id: callId,
        event: input
      });
      observeMediaConnectionEvent(result);
      return {
        status: result.replayed ? 200 : 202,
        data: result,
        ...(result.replayed
          ? {}
          : {
            afterCommit: () => publishMediaConnectionEvent(
              ctx.tenantId,
              snapshot,
              result,
              durableEventStore
            )
          })
      };
    }

    if (action === 'actions' && method === 'POST') {
      const input = bodyRecord(body);
      const actorIdentity = mediaActorIdentity(ctx, headers);
      if (!actorIdentity) throw badRequest('authenticated media call identity is required');
      const transition = await calls.transition({
        tenant_id: ctx.tenantId,
        call_id: callId,
        action: mediaCallAction(input.action),
        actor_identity: actorIdentity,
        actor_is_system: ctx.role === 'system',
        idempotency_key: headerValue(headers, 'idempotency-key'),
        reason: optionalBodyString(input, 'reason'),
        metadata: bodyRecord(input.metadata)
      });
      return {
        status: 201,
        data: transition.snapshot,
        ...(transition.replayed
          ? {}
          : {
              afterCommit: () => Promise.all([
                broadcastMediaCallTransition(ctx.tenantId, transition.snapshot),
                reconcileMediaCallPlacement(options.placement, transition)
              ])
            })
      };
    }

    if (action === 'join' && method === 'POST') {
      const input = bodyRecord(body);
      const actorIdentity = mediaActorIdentity(ctx, headers);
      const identity = String(input.identity || actorIdentity).trim();
      if (!identity) throw badRequest('identity is required');
      if (ctx.role !== 'system' && identity !== actorIdentity) {
        throw Object.assign(new Error('media identity must match authenticated user'), { status: 403 });
      }
      return calls.withJoinAuthorization(ctx.tenantId, callId, identity, async (snapshot, participant) => {
        const recovery = mediaPlacementRecovery(input.recovery);
        const placement = options.placement
          ? recovery && options.placement.recoverOwner
            ? await options.placement.recoverOwner(
                requireMediaCallPg(options.pg),
                {
                  tenant_id: ctx.tenantId,
                  interaction_id: callId,
                  expected_owner_epoch: recovery.previous_owner_epoch,
                  expected_reservation_id: recovery.previous_reservation_id,
                  worker_id: options.placementWorkerId ||
                    'media-join-recovery'
                }
              )
            : await options.placement.resolveOwner(
                requireMediaCallPg(options.pg),
                {
                  tenant_id: ctx.tenantId,
                  interaction_id: callId
                }
              )
          : undefined;
        if (participant.role === 'observer') {
          const token = await issueSupervisorToken({
            room_name: snapshot.call.room_name,
            identity,
            mode: 'listen',
            tenant_id: ctx.tenantId,
            placement
          });
          return {
            status: 201,
            data: {
              mode: 'webrtc',
              channel: 'webrtc',
              token,
              roomName: snapshot.call.room_name,
              role: participant.role
            }
          };
        }
        const plan = await media.gateways.prepareJoin('webrtc', {
          tenantId: ctx.tenantId,
          roomName: snapshot.call.room_name,
          identity,
          role: participant.role === 'host' ? 'agent' : 'customer',
          media: snapshot.call.media,
          metadata: bodyRecord(input.metadata),
          placement
        });
        const { joinPath: _legacyJoinPath, ...callBoundPlan } = plan.mode === 'webrtc' ? plan : {
          ...plan,
          joinPath: undefined
        };
        return {
          status: 201,
          data: { ...callBoundPlan, roomName: snapshot.call.room_name, role: participant.role }
        };
      });
    }
  }

  if (routePath === '/api/ivekit/media/capabilities' && method === 'GET') {
    return { data: capabilities(ctx.tenantId, media) };
  }

  if (routePath === '/api/ivekit/media/moderation/recover' && method === 'POST') {
    if (ctx.role !== 'system') {
      throw Object.assign(new Error('system role required for media moderation recovery'), { status: 403 });
    }
    const input = bodyRecord(body);
    const moderation = mediaModerationService();
    const summary = await moderation.recoverPending(
      ctx.tenantId,
      optionalBodyNumber(input, 'limit') || 25
    );
    return { data: summary };
  }

  if (routePath === '/api/ivekit/media/rooms' && method === 'POST') {
    const input = bodyRecord(body);
    const businessRef = optionalBusinessRef(ctx.tenantId, input);
    const metadata = {
      ...bodyRecord(input.metadata),
      ...(businessRef ? { business_ref: businessRef } : {})
    };
    const room = await media.rooms.createRoom({
      tenant_id: ctx.tenantId,
      purpose: (optionalBodyString(input, 'purpose') || 'video_service') as MediaRoomPurpose,
      call_session_id: optionalBodyString(input, 'call_session_id'),
      room_name: optionalBodyString(input, 'room_name'),
      metadata
    });
    return { status: 201, data: room };
  }

  const moderationMatch = routePath.match(
    /^\/api\/ivekit\/media\/rooms\/([^/]+)\/participants\/([^/]+)\/(mute|remove)$/
  );
  if (moderationMatch && method === 'POST') {
    const roomName = decodeURIComponent(moderationMatch[1]);
    const participantIdentity = decodeURIComponent(moderationMatch[2]);
    const action = moderationMatch[3];
    const input = bodyRecord(body);
    const actorIdentity = mediaModerationActorIdentity(ctx, headers);
    const idempotencyKey = headerValue(headers, 'idempotency-key');
    const moderation = mediaModerationService();
    const result = action === 'mute'
      ? await moderation.mute({
        tenant_id: ctx.tenantId,
        room_name: roomName,
        participant_identity: participantIdentity,
        actor_identity: actorIdentity,
        actor_is_system: ctx.role === 'system',
        idempotency_key: idempotencyKey,
        track_sid: String(input.track_sid || ''),
        source: String(input.source || '') as IveKitMediaTrackSource,
        muted: input.muted as true,
        metadata: bodyRecord(input.metadata)
      })
      : await moderation.remove({
        tenant_id: ctx.tenantId,
        room_name: roomName,
        participant_identity: participantIdentity,
        actor_identity: actorIdentity,
        actor_is_system: ctx.role === 'system',
        idempotency_key: idempotencyKey,
        reason: optionalBodyString(input, 'reason'),
        metadata: bodyRecord(input.metadata)
      });
    const call = await mediaCallStore().getCallByRoom(ctx.tenantId, roomName);
    const recipients = call
      ? (await mediaCallStore().listParticipants(ctx.tenantId, call.id)).map((participant) => participant.identity)
      : [];
    return {
      status: 201,
      data: result,
      afterCommit: async () => {
        try {
          await moderation.completeCommand(ctx.tenantId, idempotencyKey, result);
        } finally {
          await broadcastMediaModeration(ctx.tenantId, recipients, result);
        }
      }
    };
  }

  const roomMatch = routePath.match(/^\/api\/ivekit\/media\/rooms\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (roomMatch) {
    const roomName = decodeURIComponent(roomMatch[1]);
    const section = roomMatch[2] || '';
    const action = roomMatch[3] || '';

    if (!section && method === 'GET') {
      return { data: requireTenantRoom(media, { tenantId: ctx.tenantId, roomName }) };
    }

    if (section === 'close' && method === 'POST') {
      requireTenantRoom(media, { tenantId: ctx.tenantId, roomName });
      return { status: 201, data: media.rooms.closeRoom(roomName) };
    }

    if (section === 'join' && method === 'POST') {
      if (ctx.role !== 'system') {
        throw Object.assign(new Error('system role required for legacy media room join'), { status: 403 });
      }
      requireTenantRoom(media, { tenantId: ctx.tenantId, roomName, requireOpen: true });
      const input = bodyRecord(body);
      const role = String(input.role || 'customer') === 'customer' ? 'customer' : 'agent';
      const plan = await media.joins.prepareJoin(
        (optionalBodyString(input, 'channel') || 'webrtc') as MediaChannel,
        {
          tenantId: ctx.tenantId,
          roomName,
          identity: requiredBodyString(input, 'identity'),
          role,
          media: String(input.media || 'video') === 'voice' ? 'voice' : 'video',
          metadata: bodyRecord(input.metadata)
        }
      );
      return { status: 201, data: { ...plan, roomName, role } };
    }

    if (section === 'participants' && !action && method === 'GET') {
      requireTenantRoom(media, { tenantId: ctx.tenantId, roomName });
      return {
        data: media.participants.listByRoom(roomName, {
          includeLeft: url.searchParams.get('include_left') === '1',
          limit: Number(url.searchParams.get('limit') || 100)
        })
      };
    }

    if (section === 'recordings' && action === 'start' && method === 'POST') {
      const input = bodyRecord(body);
      const mediaCallId = optionalBodyString(input, 'media_call_id');
      const startRecording = async (defaultBusinessRef: MediaBusinessRef | null, callBound: boolean) => {
        const businessRef = optionalBusinessRef(ctx.tenantId, input) || defaultBusinessRef;
        const callSessionId = optionalBodyString(input, 'call_session_id') ||
          (businessRef?.type === 'call_session' ? businessRef.id : null);
        if (!callSessionId && !mediaCallId && !businessRef) {
          throw badRequest('media_call_id, call_session_id, or business_ref is required');
        }
        const recordingInput = {
          format: optionalBodyString(input, 'format') as RecordingFormat | undefined,
          hasVideo: Boolean(input.has_video),
          recordingMode: optionalRecordingMode(input),
          tracks: optionalRecordingTracks(input),
          audioTrackId: optionalBodyString(input, 'audio_track_id'),
          videoTrackId: optionalBodyString(input, 'video_track_id'),
          businessRef,
          retentionUntil: optionalBodyString(input, 'retention_until'),
          retentionDays: optionalBodyNumber(input, 'retention_days'),
          mediaCallId
        };
        return callBound
          ? media.recordings.startCallRecording(ctx.tenantId, callSessionId, roomName, {
            ...recordingInput,
            mediaCallId: mediaCallId!
          })
          : media.recordings.startRecording(ctx.tenantId, callSessionId, roomName, recordingInput);
      };
      const recording = mediaCallId
        ? await mediaCallService().withRecordingStartAuthorization(
          ctx.tenantId,
          mediaCallId,
          {
            actor_identity: mediaActorIdentity(ctx, headers),
            actor_is_system: ctx.role === 'system',
            room_name: roomName
          },
          (snapshot) => startRecording(snapshot.call.business_ref, true)
        )
        : await (async () => {
          const room = requireTenantRoom(media, { tenantId: ctx.tenantId, roomName, requireOpen: true });
          await requireRecordingCallAccess(undefined, true, roomName);
          return startRecording(roomBusinessRef(room), false);
        })();
      await broadcastMediaRecording(options.pg, 'ivekit.media.recording.started', recording);
      if (!options.onRecordingStarted) return { status: 201, data: publicRecording(recording) };
      const evidence = await options.onRecordingStarted(recording, { roomName });
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        return { status: 201, data: publicRecording(recording) };
      }
      const evidenceRecord = evidence as { id?: unknown };
      const linked = evidenceRecord.id
        ? media.recordings.setEvidenceRecordId(recording.id, String(evidenceRecord.id)) || recording
        : recording;
      return {
        status: 201,
        data: {
          ...publicRecording(linked),
          evidence_record_id: evidenceRecord.id ? String(evidenceRecord.id) : '',
          evidence_record: evidence
        }
      };
    }
  }

  if (routePath === '/api/ivekit/media/recordings' && method === 'GET') {
    const listInput = {
      limit: Number(url.searchParams.get('limit') || 50),
      cursor: url.searchParams.get('cursor') || undefined,
      mediaCallId: url.searchParams.get('call_id') || undefined,
      roomName: url.searchParams.get('room_name') || undefined,
      businessRefType: url.searchParams.get('business_ref_type') || undefined,
      businessRefId: url.searchParams.get('business_ref_id') || undefined,
      status: (url.searchParams.get('status') || undefined) as import('../livekit/types.js').MediaRecordingStatus | undefined
    };
    await requireRecordingCallAccess(listInput.mediaCallId, false);
    return {
      data: url.searchParams.get('page') === '1'
        ? publicRecordingPage(media.recordings.listRecordingsPage(ctx.tenantId, listInput))
        : media.recordings.listRecordings(ctx.tenantId, listInput).map(publicRecording)
    };
  }

  if (routePath === '/api/ivekit/media/recordings/retention/cleanup' && method === 'POST') {
    requireRecordingCleanupRole(ctx.role);
    const input = bodyRecord(body);
    const dryRun = input.dry_run !== false;
    if (!dryRun && input.confirm !== true) {
      throw badRequest('confirm: true is required for recording retention cleanup');
    }
    const result = await media.recordings.cleanupExpiredRecordings(ctx.tenantId, {
      before: optionalBodyString(input, 'before'),
      limit: optionalBodyNumber(input, 'limit'),
      dryRun,
      onDeleted: options.onRecordingDeleted
        ? async (recording, deleteResult) => {
            await options.onRecordingDeleted!(recording, {
              actorId: ctx.userId,
              source: deleteResult.source
            });
          }
        : undefined
    });
    if (!dryRun && options.onRecordingAudit) {
      for (const item of result.results) {
        if (item.status !== 'deleted' && item.status !== 'not_found') continue;
        const recording = media.recordings.getRecording(item.recording_id);
        if (!recording) continue;
        await options.onRecordingAudit(recordingAuditEvent(
          recording,
          ctx.userId,
          'media.recording.retention_deleted',
          { source: item.source }
        ));
      }
    }
    return { data: result };
  }

  const recordingJobObjectMatch = routePath.match(
    /^\/api\/ivekit\/media\/recordings\/([^/]+)\/jobs\/([^/]+)\/(object|export)$/
  );
  if (recordingJobObjectMatch && method === 'GET') {
    const recordingId = decodeURIComponent(recordingJobObjectMatch[1]);
    const jobId = decodeURIComponent(recordingJobObjectMatch[2]);
    const recording = requireTenantRecording(media.recordings.getRecording(recordingId), ctx.tenantId);
    await requireRecordingCallAccess(recording.media_call_id, false);
    if (recordingJobObjectMatch[3] === 'object') {
      const inspection = await media.recordings.inspectJobObject(recordingId, jobId);
      if (!inspection) throw notFound('media recording job not found');
      await options.onRecordingAudit?.(recordingAuditEvent(
        recording,
        ctx.userId,
        'media.recording.object_checked',
        inspection
      ));
      return { data: inspection };
    }
    const exported = await media.recordings.exportJobObject(recordingId, jobId);
    if (!exported) throw notFound('media recording job not found');
    if (!exported.readable || (!exported.content && !exported.stream)) {
      throw Object.assign(new Error(`recording object is not readable: ${exported.status}`), { status: 409 });
    }
    await options.onRecordingAudit?.(recordingAuditEvent(
      recording,
      ctx.userId,
      'media.recording.exported',
      exported
    ));
    return {
      data: exported.stream || exported.content,
      contentType: exported.content_type,
      filename: exported.filename,
      headers: {
        'content-disposition': `attachment; filename="${exported.filename}"`
      }
    };
  }

  const recordingMatch = routePath.match(/^\/api\/ivekit\/media\/recordings\/([^/]+)(?:\/([^/]+))?$/);
  if (recordingMatch) {
    const recordingId = decodeURIComponent(recordingMatch[1]);
    const action = recordingMatch[2] || '';
    if (!action && method === 'GET') {
      const recording = requireTenantRecording(media.recordings.getRecording(recordingId), ctx.tenantId);
      await requireRecordingCallAccess(recording.media_call_id, false);
      return { data: publicRecording(recording) };
    }
    if (action === 'jobs' && method === 'GET') {
      const recording = requireTenantRecording(media.recordings.getRecording(recordingId), ctx.tenantId);
      await requireRecordingCallAccess(recording.media_call_id, false);
      return {
        data: media.recordings.listEgressJobs(recording.id).map(publicEgressJob)
      };
    }
    if (action === 'object' && method === 'GET') {
      const recording = requireTenantRecording(media.recordings.getRecording(recordingId), ctx.tenantId);
      await requireRecordingCallAccess(recording.media_call_id, false);
      const inspection = await media.recordings.inspectObject(recordingId);
      if (!inspection) throw notFound('media recording not found');
      await options.onRecordingAudit?.(recordingAuditEvent(
        recording,
        ctx.userId,
        'media.recording.object_checked',
        inspection
      ));
      return { data: inspection };
    }
    if (action === 'export' && method === 'GET') {
      const recording = requireTenantRecording(media.recordings.getRecording(recordingId), ctx.tenantId);
      await requireRecordingCallAccess(recording.media_call_id, false);
      const exported = await media.recordings.exportObject(recordingId);
      if (!exported) throw notFound('media recording not found');
      if (!exported.readable || (!exported.content && !exported.stream)) {
        throw Object.assign(new Error(`recording object is not readable: ${exported.status}`), { status: 409 });
      }
      await options.onRecordingAudit?.(recordingAuditEvent(
        recording,
        ctx.userId,
        'media.recording.exported',
        exported
      ));
      return {
        data: exported.stream || exported.content,
        contentType: exported.content_type,
        filename: exported.filename,
        headers: {
          'content-disposition': `attachment; filename="${exported.filename}"`
        }
      };
    }
    if (action === 'stop' && method === 'POST') {
      const recording = requireTenantRecording(
        media.recordings.getRecordingByEgressId(recordingId) || media.recordings.getRecording(recordingId),
        ctx.tenantId
      );
      await requireRecordingCallAccess(recording.media_call_id, true);
      const stopped = recording.egress_id
        ? await media.recordings.stopRecording(recording.egress_id)
        : recording;
      if (stopped) await broadcastMediaRecording(options.pg, 'ivekit.media.recording.updated', stopped);
      return { status: 201, data: stopped ? publicRecording(stopped) : stopped };
    }
  }

  return undefined;
}

function mediaPlacementRecovery(value: unknown): {
  previous_owner_epoch: string;
  previous_reservation_id: string;
} | null {
  if (value === undefined || value === null) return null;
  const input = bodyRecord(value);
  const previousOwnerEpoch = String(input.previous_owner_epoch || '').trim();
  const previousReservationId = String(input.previous_reservation_id || '').trim();
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(previousOwnerEpoch) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(previousReservationId)) {
    throw badRequest('invalid media placement recovery identity');
  }
  return {
    previous_owner_epoch: previousOwnerEpoch,
    previous_reservation_id: previousReservationId
  };
}

async function reconcileMediaCallPlacement(
  placement: MediaCallPlacementPort | undefined,
  transition: import('../livekit/media-call-service.js').MediaCallTransitionResult
): Promise<void> {
  if (!placement || !transition.placement_reconcile) return;
  await placement.reconcileOne({
    tenant_id: transition.placement_reconcile.tenant_id,
    interaction_id: transition.placement_reconcile.interaction_id,
    worker_id: mediaPlacementWorkerId()
  });
}

async function reconcileDurableMediaCallPlacement(
  placement: MediaCallPlacementPort | undefined,
  tenantId: string,
  interactionId: string
): Promise<void> {
  if (!placement) return;
  await placement.reconcileOne({
    tenant_id: tenantId,
    interaction_id: interactionId,
    worker_id: mediaPlacementWorkerId()
  });
}

function mediaPlacementWorkerId(): string {
  const instance = String(
    process.env.OPC_IVEKIT_INSTANCE_ID || process.env.HOSTNAME || process.pid
  );
  return `media:${createHash('sha256').update(instance).digest('hex').slice(0, 32)}`;
}

async function revokeTerminalCallRevival(
  rawBody: string,
  verifiedResult: { event?: unknown; room_name?: unknown },
  options: RouteIveKitMediaApiOptions
): Promise<void> {
  if (!options.pg || verifiedResult.event !== 'participant_joined') return;
  const event = parseLiveKitWebhookBody(rawBody);
  const roomName = String(event.room?.name || '');
  if (!roomName || verifiedResult.room_name !== roomName) return;
  const tenantId = String(
    parseWebhookMetadata(event.participant?.metadata).tenant_id ||
    parseWebhookMetadata(event.room?.metadata).tenant_id ||
    ''
  ).trim();
  if (!tenantId) return;
  await withPgTenant(options.pg, tenantId, async (pg) => {
    const store = new MediaCallStore(pg);
    const call = await store.getCallByRoom(tenantId, roomName, { forUpdate: true });
    if (!call || !['rejected', 'cancelled', 'timed_out', 'ended', 'failed'].includes(call.status)) return;
    const participants = await store.listParticipants(tenantId, call.id);
    const moderation = new LiveKitModerationService(
      store,
      liveKitModerationProviderSource(options)
    );
    await moderation.revokeForTerminal({ call, participants });
  });
}

function liveKitModerationProviderSource(
  options: RouteIveKitMediaApiOptions
): LiveKitModerationProvider | LiveKitModerationProviderResolver | null {
  if (options.moderationProvider) return options.moderationProvider;
  if (!options.placement || !options.pg) {
    return createConfiguredLiveKitModerationProvider();
  }
  return async (context) => {
    const placement = await options.placement!.resolveOwner(options.pg!, {
      tenant_id: context.tenant_id,
      interaction_id: context.call_id
    });
    return createConfiguredLiveKitModerationProvider(
      liveKitConfigForPlacement(readLiveKitConfig(), placement)
    );
  };
}

function parseLiveKitWebhookBody(rawBody: string): {
  room?: { name?: unknown; metadata?: unknown };
  participant?: { metadata?: unknown };
} {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as {
        room?: { name?: unknown; metadata?: unknown };
        participant?: { metadata?: unknown };
      }
      : {};
  } catch {
    return {};
  }
}

function parseWebhookMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mediaCallAction(value: unknown): IveKitMediaCallAction {
  const action = String(value || '').trim();
  if (!['ring', 'accept', 'reject', 'cancel', 'timeout', 'activate', 'end', 'fail'].includes(action)) {
    throw badRequest('unsupported media call action');
  }
  return action as IveKitMediaCallAction;
}

function mediaActorIdentity(
  ctx: ReturnType<typeof requireAuth>,
  headers: Record<string, string | string[] | undefined>
): string {
  return (ctx.role === 'system' ? headerValue(headers, 'x-user-id') : ctx.userId).trim() || ctx.userId;
}

function mediaModerationActorIdentity(
  ctx: ReturnType<typeof requireAuth>,
  headers: Record<string, string | string[] | undefined>
): string {
  if (ctx.role !== 'system') {
    const identity = ctx.userId.trim();
    if (!identity) throw badRequest('authenticated media call identity is required');
    return identity;
  }
  const representedActor = headerValue(headers, 'x-user-id').trim();
  if (!representedActor) throw badRequest('X-User-Id is required for system media moderation');
  return representedActor;
}

function requireMediaCallReadAccess(
  ctx: ReturnType<typeof requireAuth>,
  headers: Record<string, string | string[] | undefined>,
  snapshot: IveKitMediaCallSnapshot
): void {
  if (ctx.role === 'system') return;
  const identity = mediaActorIdentity(ctx, headers);
  if (!snapshot.participants.some((participant) => participant.identity === identity && participant.status !== 'removed')) {
    throw notFound('media call not found');
  }
}

async function broadcastMediaCallTransition(tenantId: string, snapshot: IveKitMediaCallSnapshot): Promise<void> {
  const recipients = snapshot.participants.map((participant) => participant.identity);
  await broadcastMediaCall(tenantId, 'ivekit.media.call.updated', snapshot);
  await Promise.all(snapshot.participants.map((participant) =>
    wsBroadcastToUsers(tenantId, recipients, 'ivekit.media.participant.updated', {
      call_id: snapshot.call.id,
      identity: participant.identity,
      role: participant.role,
      status: participant.status
    })
  ));
  if (['rejected', 'cancelled', 'timed_out', 'ended', 'failed'].includes(snapshot.call.status)) {
    await broadcastMediaCall(tenantId, 'ivekit.media.call.ended', snapshot);
  }
}

function broadcastMediaCall(
  tenantId: string,
  event: 'ivekit.media.call.created' | 'ivekit.media.call.updated' | 'ivekit.media.call.ended',
  snapshot: IveKitMediaCallSnapshot
): Promise<void> {
  return wsBroadcastToUsers(tenantId, snapshot.participants.map((participant) => participant.identity), event, {
    call_id: snapshot.call.id,
    room_name: snapshot.call.room_name,
    status: snapshot.call.status
  });
}

async function publishMediaQualityTransitions(
  tenantId: string,
  snapshot: IveKitMediaCallSnapshot,
  transitions: IveKitMediaQualityTransition[],
  eventStore?: Pick<IveKitTenantEventJournal, 'append'>
): Promise<void> {
  const recipients = snapshot.participants
    .filter((participant) => participant.status !== 'removed')
    .map((participant) => participant.identity);
  for (const transition of transitions) {
    const data = {
      call_id: transition.call_id,
      participant_identity: transition.participant_identity,
      connection_revision: transition.connection_revision,
      quality_state: transition.to,
      quality_level: transition.quality_level,
      sampled_at: transition.sampled_at
    };
    const type = `ivekit.media.qos.${transition.event_type}`;
    const idempotencyKey = mediaEventIdempotencyKey('media-qos', [
      transition.call_id,
      transition.participant_identity,
      transition.connection_revision,
      transition.event_type,
      transition.sampled_at
    ]);
    await eventStore?.append({
      tenant_id: tenantId,
      type,
      data,
      audience_user_ids: recipients,
      idempotency_key: idempotencyKey
    });
    await wsBroadcastToUsers(tenantId, recipients, type, data, {
      idempotency_key: idempotencyKey
    });
  }
}

async function publishMediaConnectionEvent(
  tenantId: string,
  snapshot: IveKitMediaCallSnapshot,
  result: IveKitMediaConnectionEventResult,
  eventStore?: Pick<IveKitTenantEventJournal, 'append'>
): Promise<void> {
  const recipients = snapshot.participants
    .filter((participant) => participant.status !== 'removed')
    .map((participant) => participant.identity);
  const data = {
    call_id: result.event.call_id,
    participant_identity: result.event.participant_identity,
    event_id: result.event.event_id,
    event_type: result.event.event_type,
    connection_revision: result.event.connection_revision,
    connection_state: result.event.connection_state,
    reason_code: result.event.reason_code,
    occurred_at: result.event.occurred_at
  };
  const type = `ivekit.media.connection.${result.event.event_type}`;
  const idempotencyKey = mediaEventIdempotencyKey('media-connection', [
    result.event.call_id,
    result.event.event_id
  ]);
  await eventStore?.append({
    tenant_id: tenantId,
    type,
    data,
    audience_user_ids: recipients,
    idempotency_key: idempotencyKey
  });
  await wsBroadcastToUsers(tenantId, recipients, type, data, {
    idempotency_key: idempotencyKey
  });
}

function mediaEventIdempotencyKey(namespace: string, parts: readonly unknown[]): string {
  const digest = createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex');
  return `${namespace}:${digest}`;
}

function broadcastMediaModeration(
  tenantId: string,
  recipients: string[],
  result: LiveKitModerationResult
): Promise<void> {
  return wsBroadcastToUsers(tenantId, recipients, 'ivekit.media.participant.moderated', {
    room_name: result.room_name,
    participant_identity: result.participant_identity,
    action: result.action,
    status: result.status,
    actor_identity: result.actor_identity,
    ...(result.track_sid ? { track_sid: result.track_sid } : {}),
    ...(result.source ? { source: result.source } : {}),
    ...(result.muted ? { muted: true } : {}),
    ...(result.reason ? { reason: result.reason } : {})
  });
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(match) ? String(match[0] || '') : String(match || '');
}

async function broadcastMediaRecording(
  pg: PgQueryable | undefined,
  event: 'ivekit.media.recording.started' | 'ivekit.media.recording.updated',
  recording: EgressRecord
): Promise<void> {
  if (!pg || !recording.media_call_id) return;
  const snapshot = await withPgTenant(pg, recording.tenant_id, (tenantPg) =>
    new MediaCallStore(tenantPg).snapshot(recording.tenant_id, recording.media_call_id!)
  );
  if (!snapshot) return;
  await wsBroadcastToUsers(
    recording.tenant_id,
    snapshot.participants.map((participant) => participant.identity),
    event,
    { recording_id: recording.id, call_id: recording.media_call_id, status: recording.status }
  );
}

function recordingAuditEvent(
  recording: EgressRecord,
  actorId: string,
  action: RecordingAuditEvent['action'],
  details: { source?: string; size_bytes?: number; checksum?: string }
): RecordingAuditEvent {
  return {
    tenant_id: recording.tenant_id,
    actor_id: actorId,
    action,
    recording_id: recording.id,
    business_ref_type: recording.business_ref_type,
    business_ref_id: recording.business_ref_id,
    status: recording.status,
    ...(details.source ? { source: details.source } : {}),
    ...(details.size_bytes != null ? { size_bytes: details.size_bytes } : {}),
    ...(details.checksum ? { checksum: details.checksum } : {})
  };
}
