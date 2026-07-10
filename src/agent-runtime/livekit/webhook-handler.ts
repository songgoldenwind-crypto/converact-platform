import { WebhookReceiver } from 'livekit-server-sdk';
import { id, json, one, run } from '../../db.js';
import { runWithPgTenantContextAsync } from '../../db-pg-tenant.js';
import type { LiveKitParticipantStore } from './participant-store.js';
import type { LiveKitRoomStore } from './room-store.js';
import { readLiveKitConfig } from './config.js';
import type { LiveKitConfig } from './config.js';
import { decodeEgressRecord, resolveRecordingRetentionUntil } from './recording-service.js';
import type {
  EgressRecord,
  LiveKitMediaParticipantRole,
  LiveKitParticipantEventSink,
  LiveKitRecordingEventSink,
  LiveKitRoomRow,
  MediaBusinessRef,
  RecordingFormat
} from './types.js';

export interface LiveKitWebhookDeps {
  roomStore: LiveKitRoomStore;
  participantStore?: LiveKitParticipantStore;
  participantEvents?: LiveKitParticipantEventSink;
  recordingEvents?: LiveKitRecordingEventSink;
  config?: LiveKitConfig;
}

function isLiveKitWebhookAuthConfigured(config: LiveKitConfig): boolean {
  return Boolean(config.apiKey && config.apiSecret);
}

export function createLiveKitWebhookReceiver(config: LiveKitConfig = readLiveKitConfig()) {
  if (!isLiveKitWebhookAuthConfigured(config)) return null;
  return new WebhookReceiver(config.apiKey!, config.apiSecret!);
}

export async function handleLiveKitWebhook(rawBody: string, authHeader: string | undefined, deps: LiveKitWebhookDeps) {
  const config = deps.config || readLiveKitConfig();
  if (!isLiveKitWebhookAuthConfigured(config) && process.env.NODE_ENV === 'production') {
    throw Object.assign(new Error('livekit webhook credentials are required'), { status: 401 });
  }
  const receiver = createLiveKitWebhookReceiver(config);
  const event = receiver
    ? await receiver.receive(rawBody, authHeader)
    : JSON.parse(rawBody || '{}');

  const eventName = String(event.event || '');
  const room = event.room || {};
  const roomName = String(room.name || '');

  if (!roomName) return { ok: true, ignored: true };

  const processEvent = async () => {

  switch (eventName) {
    case 'room_started':
      deps.roomStore.markRoomActive(roomName, String(room.sid || ''));
      break;
    case 'room_finished':
      deps.roomStore.closeRoom(roomName);
      deps.participantStore?.markRoomLeft(roomName);
      break;
    case 'participant_joined': {
      const participant = event.participant || {};
      const identity = String(participant.identity || '');
      const roomRow = deps.roomStore.getRoomByName(roomName);
      if (roomRow?.status === 'closed') break;
      if (roomRow && identity) {
        const metadata = parseParticipantMetadata(participant.metadata);
        deps.participantStore?.upsertJoined({
          tenant_id: roomRow.tenant_id,
          room_name: roomName,
          identity,
          role: inferParticipantRole(identity, metadata),
          metadata
        });
      }
      deps.participantEvents?.notifyParticipantJoined(roomName, identity);
      break;
    }
    case 'participant_left': {
      const participant = event.participant || {};
      const identity = String(participant.identity || '');
      const roomRow = deps.roomStore.getRoomByName(roomName);
      if (roomRow && identity) {
        const metadata = parseParticipantMetadata(participant.metadata);
        deps.participantStore?.upsertLeft({
          tenant_id: roomRow.tenant_id,
          room_name: roomName,
          identity,
          role: inferParticipantRole(identity, metadata),
          metadata
        });
      } else if (identity) {
        deps.participantStore?.markLeft(roomName, identity);
      }
      break;
    }
    case 'egress_ended': {
      const egress = event.egressInfo || event.egress || {};
      const fileResults = egress.fileResults || egress.file_results || [];
      const file = fileResults[0] || {};
      const roomRow = deps.roomStore.getRoomByName(roomName);
      const businessRef = roomRow ? businessRefFromRoom(roomRow) : null;
      if (roomRow && businessRef) {
        const egressId = String(egress.egressId || egress.egress_id || '');
        if (!egressId) return { ok: true, ignored: true, event: eventName, room_name: roomName };
        const existing = egressId
          ? one(deps.roomStore.db, 'SELECT * FROM call_recordings WHERE egress_id = ?', [egressId])
          : null;
        const recordingId = existing ? String(existing.id) : id('crec');
        const format = normalizeRecordingFormat(file.fileType || file.file_type || 'mp4');
        const storageUrl = String(file.location || file.downloadUrl || file.download_url || '');
        const durationMs = normalizeDurationMs(file);
        const fileSizeBytes = Number(file.size || 0);
        const hasVideo = existing ? Number(existing.has_video || 0) : format === 'mp4' || format === 'webm' ? 1 : 0;
        const businessRefMetadata = json({
          display_name: businessRef.display_name || '',
          metadata: businessRef.metadata || {}
        });
        const idempotentReplay = Boolean(
          existing &&
          String(existing.status || '') === 'completed' &&
          String(existing.storage_url || '') === storageUrl &&
          Number(existing.duration_ms || 0) === durationMs &&
          Number(existing.file_size_bytes || 0) === fileSizeBytes
        );
        if (existing) {
          run(
            deps.roomStore.db,
            `UPDATE call_recordings
             SET call_session_id = COALESCE(call_session_id, ?),
                 business_ref_type = CASE WHEN business_ref_type != '' THEN business_ref_type ELSE ? END,
                 business_ref_id = CASE WHEN business_ref_id != '' THEN business_ref_id ELSE ? END,
                 business_ref_metadata = CASE WHEN business_ref_metadata != '' THEN business_ref_metadata ELSE ? END,
                 format = ?,
                 storage_url = ?,
                 duration_ms = ?,
                 file_size_bytes = ?,
                 has_video = ?,
                 status = 'completed',
                 failure_code = '',
                 completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              roomRow.call_session_id || null,
              businessRef.type,
              businessRef.id,
              businessRefMetadata,
              format,
              storageUrl,
              durationMs,
              fileSizeBytes,
              hasVideo,
              recordingId
            ]
          );
        } else {
          run(
            deps.roomStore.db,
            `INSERT INTO call_recordings
              (id, tenant_id, call_session_id, business_ref_type, business_ref_id, business_ref_metadata,
               source, format, storage_url, duration_ms, file_size_bytes, has_video, egress_id,
               status, retention_until, object_status, failure_code, completed_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'livekit_egress', ?, ?, ?, ?, ?, ?,
                     'completed', ?, 'unchecked', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(egress_id) WHERE egress_id != '' DO UPDATE SET
               storage_url = excluded.storage_url,
               duration_ms = excluded.duration_ms,
               file_size_bytes = excluded.file_size_bytes,
               has_video = excluded.has_video,
               status = 'completed',
               failure_code = '',
               completed_at = COALESCE(call_recordings.completed_at, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP`,
            [
              recordingId,
              roomRow.tenant_id,
              roomRow.call_session_id || null,
              businessRef.type,
              businessRef.id,
              businessRefMetadata,
              format,
              storageUrl,
              durationMs,
              fileSizeBytes,
              hasVideo,
              egressId,
              resolveRecordingRetentionUntil()
            ]
          );
        }
        const row = one(deps.roomStore.db, 'SELECT * FROM call_recordings WHERE egress_id = ?', [egressId]);
        const recording = row ? decodeEgressRecord(row) : undefined;
        if (recording) {
          if (!idempotentReplay) {
            await deps.recordingEvents?.notifyRecordingCompleted(recording, { roomName });
          }
          return {
            ok: true,
            event: eventName,
            room_name: roomName,
            recording,
            ...(idempotentReplay ? { idempotent_replay: true } : {})
          };
        }
      }
      break;
    }
    default:
      break;
  }

  return { ok: true, event: eventName, room_name: roomName };
  };

  const tenantId = String(parseParticipantMetadata(room.metadata).tenant_id || '').trim();
  if (tenantId) {
    return runWithPgTenantContextAsync({ tenantId }, processEvent);
  }
  if (process.env.NODE_ENV === 'production') {
    throw Object.assign(new Error('livekit room tenant metadata is required'), { status: 400 });
  }
  return processEvent();
}

function businessRefFromRoom(room: LiveKitRoomRow): MediaBusinessRef | null {
  const raw = room.metadata.business_ref;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const ref = raw as Record<string, unknown>;
    const type = String(ref.type || '').trim();
    const idValue = String(ref.id || '').trim();
    if (type && idValue) {
      return {
        tenant_id: String(ref.tenant_id || room.tenant_id),
        type,
        id: idValue,
        display_name: ref.display_name ? String(ref.display_name) : undefined,
        metadata: ref.metadata && typeof ref.metadata === 'object'
          ? (ref.metadata as Record<string, unknown>)
          : {}
      };
    }
  }
  if (!room.call_session_id) return null;
  return {
    tenant_id: room.tenant_id,
    type: 'call_session',
    id: room.call_session_id,
    metadata: {}
  };
}

function normalizeRecordingFormat(value: unknown): RecordingFormat {
  const format = String(value || 'mp4').toLowerCase();
  if (format === 'webm' || format === 'wav' || format === 'ogg') return format;
  return 'mp4';
}

function normalizeDurationMs(file: Record<string, unknown>): number {
  const explicitMs = file.durationMs ?? file.duration_ms;
  if (explicitMs != null) return Number(explicitMs || 0);
  const raw = Number(file.duration || 0);
  return raw > 86_400_000 ? Math.round(raw / 1_000_000) : raw;
}

function parseParticipantMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function inferParticipantRole(identity: string, metadata: Record<string, unknown>): LiveKitMediaParticipantRole {
  const role = String(metadata.role || '').toLowerCase();
  if (role === 'agent' || role === 'customer' || role === 'supervisor' || role === 'ai' || role === 'sip') {
    return role;
  }
  if (identity.startsWith('agent')) return 'agent';
  if (identity.startsWith('customer')) return 'customer';
  if (identity.startsWith('ai')) return 'ai';
  if (identity.startsWith('sip')) return 'sip';
  return 'unknown';
}
