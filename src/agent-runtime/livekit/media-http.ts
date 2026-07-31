import { resolveBrandEnv } from '../../config/converact-env.js';
import { createLiveKitMediaModule } from './index.js';
import { isMediaInviteConfigured, verifyMediaInvite } from './invite-token.js';
import type {
  EgressRecord,
  LiveKitRecordingMode,
  LiveKitRecordingTrackSelector,
  MediaBusinessRef,
  MediaRoomPurpose,
  RecordingObjectContentResult,
  RecordingObjectDeleteResult
} from './types.js';
import type { MediaChannel } from '../media-gateway/index.js';
import { runWithPgTenantContextAsync } from '../../db-pg-tenant.js';

export interface RouteMediaApiOptions {
  onRecordingStarted?: (recording: EgressRecord, context: { roomName: string }) => Promise<unknown>;
  onRecordingCompleted?: (recording: EgressRecord, context: { roomName: string }) => Promise<unknown>;
  resolveRecordingObject?: (recording: EgressRecord) => Promise<RecordingObjectContentResult>;
  deleteRecordingObject?: (recording: EgressRecord) => Promise<RecordingObjectDeleteResult>;
  resolveRecordingRetentionDays?: (tenantId: string) => number | Promise<number>;
  onRecordingDeleted?: (
    recording: EgressRecord,
    context: { actorId: string; source?: string }
  ) => void | Promise<unknown>;
  onRecordingAudit?: (event: RecordingAuditEvent) => void | Promise<void>;
}

export interface RecordingAuditEvent {
  tenant_id: string;
  actor_id: string;
  action: 'media.recording.object_checked' | 'media.recording.exported' | 'media.recording.retention_deleted';
  recording_id: string;
  business_ref_type: string;
  business_ref_id: string;
  status: string;
  source?: string;
  size_bytes?: number;
  checksum?: string;
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw Object.assign(new Error(`${key} is required`), { status: 400 });
  return value;
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function unauthorized(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 401 });
}

function notFound(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 404 });
}

function conflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string {
  const found = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
  const value = Array.isArray(found?.[1]) ? found?.[1][0] : found?.[1];
  return String(value || '');
}

function mediaApiToken(): string {
  return resolveBrandEnv(process.env, 'MEDIA_API_TOKEN') || process.env.LIVEKIT_MEDIA_API_TOKEN || '';
}

function hasMediaServiceAuth(headers: Record<string, string | string[] | undefined>): boolean {
  const expected = mediaApiToken();
  if (!expected) return process.env.NODE_ENV !== 'production';
  const authorization = headerValue(headers, 'authorization');
  return authorization === `Bearer ${expected}`;
}

function hasExplicitMediaServiceAuth(headers: Record<string, string | string[] | undefined>): boolean {
  return Boolean(mediaApiToken()) && hasMediaServiceAuth(headers);
}

function requireMediaServiceAuth(headers: Record<string, string | string[] | undefined>): void {
  if (!mediaApiToken() && process.env.NODE_ENV === 'production') {
    throw unauthorized('media api token is required');
  }
  if (!hasMediaServiceAuth(headers)) {
    throw unauthorized('missing or invalid media api authorization');
  }
}

function requireCustomerInvite(
  url: URL,
  headers: Record<string, string | string[] | undefined>,
  input: { tenantId: string; roomName: string; media: 'voice' | 'video' }
): void {
  if (hasExplicitMediaServiceAuth(headers)) return;
  if (!isMediaInviteConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw unauthorized('media invite signing is required');
    }
    return;
  }
  const ok = verifyMediaInvite({
    tenantId: input.tenantId,
    roomName: input.roomName,
    role: 'customer',
    media: input.media,
    expiresAt: url.searchParams.get('expires_at'),
    invite: url.searchParams.get('invite')
  });
  if (!ok) throw unauthorized('missing or invalid media invite');
}

function requireJoinableRoom(
  media: ReturnType<typeof createLiveKitMediaModule>,
  input: { tenantId?: string; roomName: string }
): void {
  const room = media.rooms.getRoomByName(input.roomName);
  if (!room || (input.tenantId && room.tenant_id !== input.tenantId)) {
    throw notFound('media room not found');
  }
  if (room.status === 'closed') {
    throw conflict('media room is closed');
  }
}

function requireTenantScopedRoom(
  media: ReturnType<typeof createLiveKitMediaModule>,
  input: { tenantId: string; roomName: string }
) {
  const room = media.rooms.getRoomByName(input.roomName);
  if (!room || room.tenant_id !== input.tenantId) {
    throw notFound('media room not found');
  }
  return room;
}

function requireTenantScopedRecording<T extends { tenant_id?: string }>(
  recording: T | null,
  tenantId: string
): T {
  if (!recording || recording.tenant_id !== tenantId) {
    throw notFound('media recording not found');
  }
  return recording;
}

function requiredTenantQuery(url: URL): string {
  return requiredQuery(url, 'tenant_id');
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body is required');
  }
  return body as Record<string, unknown>;
}

function requiredBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${key} is required`);
  return value;
}

function optionalBodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalBodyNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${key} must be a number`);
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

function optionalBusinessRef(tenantId: string, body: Record<string, unknown>): MediaBusinessRef | null {
  const raw = optionalBodyRecord(body, 'business_ref');
  const type = String(raw?.type || body.business_ref_type || '').trim();
  const id = String(raw?.id || body.business_ref_id || '').trim();
  if (!raw && !type && !id) return null;
  if (!type || !id) throw badRequest('business_ref.type and business_ref.id are required');
  const refTenant = String(raw?.tenant_id || tenantId);
  if (refTenant !== tenantId) throw badRequest('business_ref tenant mismatch');
  return {
    tenant_id: tenantId,
    type,
    id,
    display_name: raw?.display_name ? String(raw.display_name) : undefined,
    metadata: optionalBodyRecord(raw || {}, 'metadata') || optionalBodyRecord(body, 'business_ref_metadata') || {}
  };
}

export async function routeMediaApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  rawBody: string | Buffer = '',
  headers: Record<string, string | string[] | undefined> = {},
  options: RouteMediaApiOptions = {}
): Promise<unknown | undefined> {
  const media = createLiveKitMediaModule({
    db,
    recordingDependencies: {
      resolveRecordingObject: options.resolveRecordingObject,
      deleteRecordingObject: options.deleteRecordingObject,
      resolveRetentionDays: options.resolveRecordingRetentionDays
    }
  });

  if (path === '/api/media/livekit/rooms' && method === 'POST') {
    requireMediaServiceAuth(headers);
    const input = bodyRecord(body);
    return media.rooms.createRoom({
      tenant_id: requiredBodyString(input, 'tenant_id'),
      purpose: requiredBodyString(input, 'purpose') as MediaRoomPurpose,
      call_session_id: optionalBodyString(input, 'call_session_id'),
      metadata: optionalBodyRecord(input, 'metadata'),
      room_name: optionalBodyString(input, 'room_name')
    });
  }

  if (path === '/api/media/livekit/token' && method === 'GET') {
    requireMediaServiceAuth(headers);
    const roomName = requiredQuery(url, 'room_name');
    const tenantId = requiredTenantQuery(url);
    requireJoinableRoom(media, { roomName, tenantId });
    return media.tokens.issueParticipantToken({
      room_name: roomName,
      identity: requiredQuery(url, 'identity'),
      role: (url.searchParams.get('role') || 'customer') as 'agent' | 'customer',
      tenant_id: tenantId
    });
  }

  if (path === '/api/media/livekit/join' && method === 'GET') {
    const role = (url.searchParams.get('role') || 'customer') as 'agent' | 'customer';
    const tenantId = requiredQuery(url, 'tenant_id');
    const roomName = requiredQuery(url, 'room_name');
    const mediaKind = url.searchParams.get('media') === 'voice' ? 'voice' : 'video';
    if (role !== 'customer') requireMediaServiceAuth(headers);
    else requireCustomerInvite(url, headers, { tenantId, roomName, media: mediaKind });
    return runWithPgTenantContextAsync({ tenantId }, async () => {
      requireJoinableRoom(media, { tenantId, roomName });
      return media.joins.prepareJoin((url.searchParams.get('channel') || 'webrtc') as MediaChannel, {
        tenantId,
        roomName,
        identity: requiredQuery(url, 'identity'),
        role,
        media: mediaKind
      });
    });
  }

  const roomMatch = path.match(/^\/api\/media\/livekit\/rooms\/([^/]+)$/);
  if (roomMatch && method === 'GET') {
    requireMediaServiceAuth(headers);
    return requireTenantScopedRoom(media, {
      roomName: decodeURIComponent(roomMatch[1]),
      tenantId: requiredTenantQuery(url)
    });
  }

  const closeRoomMatch = path.match(/^\/api\/media\/livekit\/rooms\/([^/]+)\/close$/);
  if (closeRoomMatch && method === 'POST') {
    requireMediaServiceAuth(headers);
    const roomName = decodeURIComponent(closeRoomMatch[1]);
    requireTenantScopedRoom(media, {
      roomName,
      tenantId: requiredTenantQuery(url)
    });
    return media.rooms.closeRoom(roomName);
  }

  if (path === '/api/media/livekit/agent-dispatch' && method === 'POST') {
    requireMediaServiceAuth(headers);
    const input = bodyRecord(body);
    const roomName = requiredBodyString(input, 'room_name');
    const tenantId = requiredBodyString(input, 'tenant_id');
    const agentName = optionalBodyString(input, 'agent_name') || 'ai-agent';
    const metadata = optionalBodyRecord(input, 'metadata') || {};
    if (typeof metadata.tenant_id === 'string' && metadata.tenant_id !== tenantId) {
      throw badRequest('metadata tenant mismatch');
    }
    requireJoinableRoom(media, { roomName, tenantId });
    const dispatchMetadata = {
      ...metadata,
      tenant_id: tenantId
    };
    const dispatched = await media.dispatch.dispatchAiAgent(
      roomName,
      dispatchMetadata,
      agentName
    );
    return {
      room_name: roomName,
      agent_name: agentName,
      dispatched
    };
  }

  if (path === '/api/media/webhooks/livekit' && method === 'POST') {
    const authHeader = headerValue(headers, 'authorization');
    const rawBodyText = rawBody ? String(rawBody) : JSON.stringify(body || {});
    const result = await media.webhooks.handleWebhook(rawBodyText, authHeader || undefined);
    if (!result.recording || !options.onRecordingCompleted) return result;
    const evidence = await options.onRecordingCompleted(result.recording, {
      roomName: result.room_name || result.recording.business_ref?.id || ''
    });
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return result;
    const evidenceRecord = evidence as { id?: unknown };
    return {
      ...result,
      evidence_record_id: evidenceRecord.id ? String(evidenceRecord.id) : '',
      evidence_record: evidence
    };
  }

  const participantsMatch = path.match(/^\/api\/media\/livekit\/rooms\/([^/]+)\/participants$/);
  if (participantsMatch && method === 'GET') {
    requireMediaServiceAuth(headers);
    const roomName = decodeURIComponent(participantsMatch[1]);
    requireTenantScopedRoom(media, {
      roomName,
      tenantId: requiredTenantQuery(url)
    });
    return media.participants.listByRoom(roomName, {
      includeLeft: url.searchParams.get('include_left') === '1',
      limit: Number(url.searchParams.get('limit') || 100)
    });
  }

  if (path === '/api/media/livekit/recordings/start' && method === 'POST') {
    requireMediaServiceAuth(headers);
    const input = bodyRecord(body);
    const tenantId = requiredBodyString(input, 'tenant_id');
    const roomName = requiredBodyString(input, 'room_name');
    const businessRef = optionalBusinessRef(tenantId, input);
    const callSessionId =
      optionalBodyString(input, 'call_session_id') || (businessRef?.type === 'call_session' ? businessRef.id : null);
    if (!callSessionId && !businessRef) {
      throw badRequest('call_session_id or business_ref is required');
    }
    requireJoinableRoom(media, { tenantId, roomName });
    const recording = await media.recordings.startRecording(
      tenantId,
      callSessionId,
      roomName,
      {
        format: optionalBodyString(input, 'format') as 'mp4' | 'webm' | 'wav' | 'ogg' | undefined,
        hasVideo: Boolean(input.has_video),
        recordingMode: optionalRecordingMode(input),
        tracks: optionalRecordingTracks(input),
        audioTrackId: optionalBodyString(input, 'audio_track_id'),
        videoTrackId: optionalBodyString(input, 'video_track_id'),
        businessRef,
        retentionUntil: optionalBodyString(input, 'retention_until'),
        retentionDays: optionalBodyNumber(input, 'retention_days')
      }
    );
    if (!options.onRecordingStarted) return recording;
    const evidence = await options.onRecordingStarted(recording, { roomName });
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return recording;
    const evidenceRecord = evidence as { id?: unknown };
    return {
      ...recording,
      evidence_record_id: evidenceRecord.id ? String(evidenceRecord.id) : '',
      evidence_record: evidence
    };
  }

  if (path === '/api/media/livekit/recordings' && method === 'GET') {
    requireMediaServiceAuth(headers);
    return media.recordings.listRecordings(requiredQuery(url, 'tenant_id'), {
      limit: Number(url.searchParams.get('limit') || 50)
    });
  }

  if (path === '/api/media/livekit/recordings/retention/cleanup' && method === 'POST') {
    requireMediaServiceAuth(headers);
    const input = bodyRecord(body);
    const tenantId = requiredBodyString(input, 'tenant_id');
    const dryRun = input.dry_run !== false;
    const actorId = headerValue(headers, 'x-actor-id') || 'retention-worker';
    if (!dryRun && input.confirm !== true) {
      throw badRequest('confirm: true is required for recording retention cleanup');
    }
    const result = await media.recordings.cleanupExpiredRecordings(tenantId, {
      before: optionalBodyString(input, 'before'),
      limit: optionalBodyNumber(input, 'limit'),
      dryRun,
      onDeleted: options.onRecordingDeleted
        ? async (recording, deleteResult) => {
            await options.onRecordingDeleted!(recording, {
              actorId,
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
          actorId,
          'media.recording.retention_deleted',
          { source: item.source }
        ));
      }
    }
    return result;
  }

  const recordingJobObjectMatch = path.match(
    /^\/api\/media\/livekit\/recordings\/([^/]+)\/jobs\/([^/]+)\/(object|export)$/
  );
  if (recordingJobObjectMatch && method === 'GET') {
    requireMediaServiceAuth(headers);
    const recording = requireTenantScopedRecording(
      media.recordings.getRecording(decodeURIComponent(recordingJobObjectMatch[1])),
      requiredTenantQuery(url)
    );
    const jobId = decodeURIComponent(recordingJobObjectMatch[2]);
    const actorId = headerValue(headers, 'x-actor-id') || 'media-service';
    if (recordingJobObjectMatch[3] === 'object') {
      const inspection = await media.recordings.inspectJobObject(recording.id, jobId);
      if (!inspection) throw notFound('media recording job not found');
      await options.onRecordingAudit?.(recordingAuditEvent(
        recording,
        actorId,
        'media.recording.object_checked',
        inspection
      ));
      return inspection;
    }
    const exported = await media.recordings.exportJobObject(recording.id, jobId);
    if (!exported) throw notFound('media recording job not found');
    if (!exported.readable || !exported.content) {
      throw conflict(`recording object is not readable: ${exported.status}`);
    }
    await options.onRecordingAudit?.(recordingAuditEvent(
      recording,
      actorId,
      'media.recording.exported',
      exported
    ));
    return {
      data: exported.content,
      contentType: exported.content_type,
      filename: exported.filename,
      headers: {
        'content-disposition': `attachment; filename="${exported.filename}"`
      }
    };
  }

  const recordingObjectMatch = path.match(/^\/api\/media\/livekit\/recordings\/([^/]+)\/(object|export)$/);
  if (recordingObjectMatch && method === 'GET') {
    requireMediaServiceAuth(headers);
    const recordingId = decodeURIComponent(recordingObjectMatch[1]);
    const action = recordingObjectMatch[2];
    const recording = requireTenantScopedRecording(
      media.recordings.getRecording(recordingId),
      requiredTenantQuery(url)
    );
    const actorId = headerValue(headers, 'x-actor-id') || 'media-service';
    if (action === 'object') {
      const inspection = await media.recordings.inspectObject(recording.id);
      if (!inspection) throw notFound('media recording not found');
      await options.onRecordingAudit?.(recordingAuditEvent(
        recording,
        actorId,
        'media.recording.object_checked',
        inspection
      ));
      return inspection;
    }

    const exported = await media.recordings.exportObject(recording.id);
    if (!exported) throw notFound('media recording not found');
    if (!exported.readable || !exported.content) {
      throw conflict(`recording object is not readable: ${exported.status}`);
    }
    await options.onRecordingAudit?.(recordingAuditEvent(
      recording,
      actorId,
      'media.recording.exported',
      exported
    ));
    return {
      data: exported.content,
      contentType: exported.content_type,
      filename: exported.filename,
      headers: {
        'content-disposition': `attachment; filename="${exported.filename}"`
      }
    };
  }

  const recordingMatch = path.match(/^\/api\/media\/livekit\/recordings\/([^/]+)$/);
  if (recordingMatch && method === 'GET') {
    requireMediaServiceAuth(headers);
    return requireTenantScopedRecording(
      media.recordings.getRecording(decodeURIComponent(recordingMatch[1])),
      requiredTenantQuery(url)
    );
  }

  const recordingJobsMatch = path.match(/^\/api\/media\/livekit\/recordings\/([^/]+)\/jobs$/);
  if (recordingJobsMatch && method === 'GET') {
    requireMediaServiceAuth(headers);
    const recording = requireTenantScopedRecording(
      media.recordings.getRecording(decodeURIComponent(recordingJobsMatch[1])),
      requiredTenantQuery(url)
    );
    return media.recordings.listEgressJobs(recording.id).map(({ storage_url: _storageUrl, ...job }) => job);
  }

  const stopRecordingMatch = path.match(/^\/api\/media\/livekit\/recordings\/([^/]+)\/stop$/);
  if (stopRecordingMatch && method === 'POST') {
    requireMediaServiceAuth(headers);
    const egressId = decodeURIComponent(stopRecordingMatch[1]);
    requireTenantScopedRecording(
      media.recordings.getRecordingByEgressId(egressId),
      requiredTenantQuery(url)
    );
    return media.recordings.stopRecording(egressId);
  }

  return undefined;
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
