import { resolveAuthContext } from '../../middleware/auth.js';
import { createLiveKitMediaModule } from '../livekit/index.js';
import type { RecordingAuditEvent } from '../livekit/media-http.js';
import type {
  EgressRecord,
  MediaBusinessRef,
  MediaRoomPurpose,
  RecordingFormat,
  RecordingObjectContentResult,
  RecordingObjectDeleteResult
} from '../livekit/types.js';
import type { MediaChannel } from '../media-gateway/index.js';

export interface RouteIveKitMediaApiOptions {
  onRecordingStarted?: (recording: EgressRecord, context: { roomName: string }) => Promise<unknown>;
  resolveRecordingObject?: (recording: EgressRecord) => Promise<RecordingObjectContentResult>;
  deleteRecordingObject?: (recording: EgressRecord) => Promise<RecordingObjectDeleteResult>;
  resolveRecordingRetentionDays?: (tenantId: string) => number | Promise<number>;
  onRecordingDeleted?: (
    recording: EgressRecord,
    context: { actorId: string; source?: string }
  ) => void | Promise<unknown>;
  onRecordingAudit?: (event: RecordingAuditEvent) => void | Promise<void>;
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

function optionalBodyRecord(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = body[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
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

function capabilities(tenantId: string) {
  const livekitUrl = String(process.env.LIVEKIT_URL || process.env.OPC_LIVEKIT_URL || '').trim();
  const livekitApiKey = String(process.env.LIVEKIT_API_KEY || process.env.OPC_LIVEKIT_API_KEY || '').trim();
  const livekitApiSecret = String(process.env.LIVEKIT_API_SECRET || process.env.OPC_LIVEKIT_API_SECRET || '').trim();
  const inviteSecret = String(process.env.OPC_MEDIA_INVITE_SECRET || process.env.LIVEKIT_MEDIA_INVITE_SECRET || '').trim();
  const minioAccessKey = String(process.env.MINIO_ACCESS_KEY || '').trim();
  const minioSecretKey = String(process.env.MINIO_SECRET_KEY || '').trim();
  const sipReady = Boolean(
    livekitUrl &&
    livekitApiKey &&
    livekitApiSecret &&
    String(process.env.LIVEKIT_SIP_BRIDGE_TARGET || '').trim() &&
    String(process.env.RUSTPBX_LIVEKIT_TRUNK || '').trim() &&
    String(process.env.RUSTPBX_RWI_URL || '').trim() &&
    String(process.env.RUSTPBX_RWI_TOKEN || '').trim()
  );

  return {
    provider: 'livekit',
    tenant_id: tenantId,
    capabilities: {
      rooms: true,
      tokens: true,
      join: true,
      participants: true,
      recording: true,
      recording_object_check: true,
      recording_export: true,
      recording_retention_cleanup: true,
      webhooks: true,
      web_assist: true,
      sip_volte: sipReady ? 'ready' : 'planned'
    },
    config: {
      livekit_url_configured: Boolean(livekitUrl),
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
  _rawBody: string | Buffer = '',
  headers: Record<string, string | string[] | undefined> = {},
  options: RouteIveKitMediaApiOptions = {}
): Promise<unknown | undefined> {
  const routePath = path.split('?')[0];
  if (!routePath.startsWith('/api/ivekit/media')) return undefined;

  const ctx = requireAuth(headers);
  const media = createLiveKitMediaModule({
    db,
    recordingDependencies: {
      resolveRecordingObject: options.resolveRecordingObject,
      deleteRecordingObject: options.deleteRecordingObject,
      resolveRetentionDays: options.resolveRecordingRetentionDays
    }
  });

  if (routePath === '/api/ivekit/media/capabilities' && method === 'GET') {
    return { data: capabilities(ctx.tenantId) };
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
      const room = requireTenantRoom(media, { tenantId: ctx.tenantId, roomName, requireOpen: true });
      const input = bodyRecord(body);
      const businessRef = optionalBusinessRef(ctx.tenantId, input) || roomBusinessRef(room);
      const callSessionId =
        optionalBodyString(input, 'call_session_id') || (businessRef?.type === 'call_session' ? businessRef.id : null);
      if (!callSessionId && !businessRef) {
        return { status: 400, data: { error: 'call_session_id or business_ref is required' } };
      }
      const recording = await media.recordings.startRecording(ctx.tenantId, callSessionId, roomName, {
        format: optionalBodyString(input, 'format') as RecordingFormat | undefined,
        hasVideo: Boolean(input.has_video),
        businessRef,
        retentionUntil: optionalBodyString(input, 'retention_until'),
        retentionDays: optionalBodyNumber(input, 'retention_days')
      });
      if (!options.onRecordingStarted) return { status: 201, data: recording };
      const evidence = await options.onRecordingStarted(recording, { roomName });
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        return { status: 201, data: recording };
      }
      const evidenceRecord = evidence as { id?: unknown };
      return {
        status: 201,
        data: {
          ...recording,
          evidence_record_id: evidenceRecord.id ? String(evidenceRecord.id) : '',
          evidence_record: evidence
        }
      };
    }
  }

  if (routePath === '/api/ivekit/media/recordings' && method === 'GET') {
    return {
      data: media.recordings.listRecordings(ctx.tenantId, {
        limit: Number(url.searchParams.get('limit') || 50)
      })
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

  const recordingMatch = routePath.match(/^\/api\/ivekit\/media\/recordings\/([^/]+)(?:\/([^/]+))?$/);
  if (recordingMatch) {
    const recordingId = decodeURIComponent(recordingMatch[1]);
    const action = recordingMatch[2] || '';
    if (!action && method === 'GET') {
      return { data: requireTenantRecording(media.recordings.getRecording(recordingId), ctx.tenantId) };
    }
    if (action === 'object' && method === 'GET') {
      const recording = requireTenantRecording(media.recordings.getRecording(recordingId), ctx.tenantId);
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
      const exported = await media.recordings.exportObject(recordingId);
      if (!exported) throw notFound('media recording not found');
      if (!exported.readable || !exported.content) {
        throw Object.assign(new Error(`recording object is not readable: ${exported.status}`), { status: 409 });
      }
      await options.onRecordingAudit?.(recordingAuditEvent(
        recording,
        ctx.userId,
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
    if (action === 'stop' && method === 'POST') {
      requireTenantRecording(media.recordings.getRecordingByEgressId(recordingId), ctx.tenantId);
      return { status: 201, data: media.recordings.stopRecording(recordingId) };
    }
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
