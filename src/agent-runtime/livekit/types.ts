import type {
  MediaChannel,
  MediaGatewayRegistry,
  MediaJoinContext,
  MediaJoinPlan
} from '../media-gateway/index.js';
import type { LiveKitConfig } from './config.js';
import type {
  IssueLiveKitTokenInput,
  IssueSupervisorTokenInput,
  LiveKitTokenResult
} from './token-service.js';

export type MediaRoomPurpose =
  | 'ai_outbound'
  | 'video_service'
  | 'screen_share'
  | 'conference'
  | 'pstn_bridge';

export type IveKitMediaCallStatus =
  | 'created'
  | 'ringing'
  | 'accepted'
  | 'active'
  | 'rejected'
  | 'cancelled'
  | 'timed_out'
  | 'ended'
  | 'failed';

export type IveKitMediaCallParticipantStatus =
  | 'invited'
  | 'ringing'
  | 'accepted'
  | 'joined'
  | 'declined'
  | 'left'
  | 'missed'
  | 'removed';

export type IveKitMediaCallRole = 'host' | 'participant' | 'observer';
export type IveKitMediaCallAction =
  | 'ring'
  | 'accept'
  | 'reject'
  | 'cancel'
  | 'timeout'
  | 'activate'
  | 'end'
  | 'fail';

export interface IveKitMediaCall {
  id: string;
  tenant_id: string;
  room_name: string;
  media: 'voice' | 'video';
  status: IveKitMediaCallStatus;
  initiated_by: string;
  business_ref: MediaBusinessRef;
  title: string;
  metadata: Record<string, unknown>;
  ring_timeout_seconds: number;
  ring_expires_at: string | null;
  accepted_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  end_reason: string;
  created_at: string;
  updated_at: string;
}

export interface IveKitMediaCallParticipant {
  id: string;
  tenant_id: string;
  call_id: string;
  identity: string;
  role: IveKitMediaCallRole;
  status: IveKitMediaCallParticipantStatus;
  display_name: string;
  metadata: Record<string, unknown>;
  invited_at: string;
  accepted_at: string | null;
  joined_at: string | null;
  left_at: string | null;
  updated_at: string;
}

export interface IveKitMediaCallSnapshot {
  call: IveKitMediaCall;
  participants: IveKitMediaCallParticipant[];
}

export type IveKitMediaTrackSource =
  | 'camera'
  | 'microphone'
  | 'screen_share'
  | 'screen_share_audio';

export interface IveKitMediaModerationActionRecord {
  id: string;
  tenant_id: string;
  call_id: string;
  room_name: string;
  participant_identity: string;
  action: 'mute' | 'remove';
  actor_identity: string;
  idempotency_key: string;
  payload_hash: string;
  track_sid: string;
  source: IveKitMediaTrackSource | '';
  muted: boolean | null;
  reason: string;
  metadata: Record<string, unknown>;
  result_snapshot: Record<string, unknown>;
  created_at: string;
}

export interface IveKitMediaModerationCommandRecord {
  id: string;
  tenant_id: string;
  call_id: string;
  room_name: string;
  participant_identity: string;
  action: 'mute' | 'remove';
  actor_identity: string;
  actor_is_system: boolean;
  idempotency_key: string;
  payload_hash: string;
  request_payload: Record<string, unknown>;
  status: 'pending' | 'completed' | 'failed';
  result_snapshot: Record<string, unknown> | null;
  error_code: string;
  error_message: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateMediaRoomInput {
  tenant_id: string;
  purpose: MediaRoomPurpose;
  call_session_id?: string | null;
  metadata?: Record<string, unknown>;
  room_name?: string;
}

export interface LiveKitRoomRow {
  id: string;
  tenant_id: string;
  room_name: string;
  room_sid: string;
  purpose: MediaRoomPurpose;
  status: 'created' | 'active' | 'closed';
  call_session_id: string | null;
  metadata: Record<string, unknown>;
}

export interface LiveKitRoomService {
  createRoom(input: CreateMediaRoomInput): Promise<LiveKitRoomRow>;
  getRoomByName(roomName: string): LiveKitRoomRow | null;
  getRoomByCallSession(callSessionId: string): LiveKitRoomRow | null;
  markRoomActive(roomName: string, roomSid?: string): LiveKitRoomRow | null;
  closeRoom(roomName: string): LiveKitRoomRow | null;
}

export type LiveKitParticipantStatus = 'joined' | 'left';

export type LiveKitMediaParticipantRole =
  | 'agent'
  | 'customer'
  | 'supervisor'
  | 'ai'
  | 'sip'
  | 'unknown';

export interface LiveKitParticipantRow {
  id: string;
  tenant_id: string;
  room_name: string;
  identity: string;
  role: LiveKitMediaParticipantRole;
  status: LiveKitParticipantStatus;
  metadata: Record<string, unknown>;
  joined_at: string;
  left_at: string | null;
}

export interface LiveKitParticipantService {
  upsertJoined(input: {
    tenant_id: string;
    room_name: string;
    identity: string;
    role?: LiveKitMediaParticipantRole;
    metadata?: Record<string, unknown>;
  }): LiveKitParticipantRow;
  markLeft(roomName: string, identity: string): LiveKitParticipantRow | null;
  upsertLeft(input: {
    tenant_id: string;
    room_name: string;
    identity: string;
    role?: LiveKitMediaParticipantRole;
    metadata?: Record<string, unknown>;
  }): LiveKitParticipantRow;
  markRoomLeft(roomName: string): number;
  getParticipant(roomName: string, identity: string): LiveKitParticipantRow | null;
  listByRoom(roomName: string, opts?: { includeLeft?: boolean; limit?: number }): LiveKitParticipantRow[];
}

export interface LiveKitTokenService {
  issueParticipantToken(input: IssueLiveKitTokenInput): Promise<LiveKitTokenResult>;
  issueSupervisorToken(input: IssueSupervisorTokenInput): Promise<LiveKitTokenResult>;
}

export interface MediaJoinService {
  prepareJoin(channel: MediaChannel, ctx: MediaJoinContext): Promise<MediaJoinPlan>;
}

export type RecordingFormat = 'mp4' | 'webm' | 'wav' | 'ogg';

export type MediaRecordingStatus =
  | 'starting'
  | 'pending'
  | 'recording'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'deleted';

export type MediaRecordingObjectStatus =
  | 'unchecked'
  | 'readable'
  | 'missing_storage_url'
  | 'not_found'
  | 'forbidden'
  | 'unsupported'
  | 'fetch_failed'
  | 'deleted'
  | 'delete_failed';

export type MediaRecordingObjectSource =
  | 'file'
  | 'http'
  | 's3'
  | 'local_upload'
  | 'local_path';

export interface RecordingObjectContentResult {
  status: Exclude<MediaRecordingObjectStatus, 'unchecked' | 'deleted' | 'delete_failed'>;
  content?: Buffer;
  source?: MediaRecordingObjectSource;
  error?: string;
}

export interface RecordingObjectDeleteResult {
  status: 'deleted' | 'not_found' | 'unsupported' | 'delete_failed';
  source?: MediaRecordingObjectSource;
  error?: string;
}

export interface RecordingObjectInspection {
  status: RecordingObjectContentResult['status'];
  readable: boolean;
  source?: MediaRecordingObjectSource;
  size_bytes: number;
  checksum: string;
}

export interface RecordingObjectExport extends RecordingObjectInspection {
  content?: Buffer;
  content_type: string;
  filename: string;
}

export interface RecordingRetentionCleanupResult {
  dry_run: boolean;
  candidates: number;
  deleted: number;
  failed: number;
  results: Array<{
    recording_id: string;
    status: RecordingObjectDeleteResult['status'];
    source?: MediaRecordingObjectSource;
    error?: string;
  }>;
}

export interface MediaBusinessRef {
  tenant_id: string;
  type: string;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export interface StartRecordingOptions {
  format?: RecordingFormat;
  hasVideo?: boolean;
  businessRef?: MediaBusinessRef | null;
  retentionUntil?: string | null;
  retentionDays?: number;
}

export interface EgressRecord {
  id: string;
  tenant_id: string;
  call_session_id: string;
  business_ref_type: string;
  business_ref_id: string;
  business_ref: MediaBusinessRef | null;
  source: 'livekit_egress' | 'rustpbx_sipflow';
  format: RecordingFormat;
  storage_url: string;
  duration_ms: number | null;
  file_size_bytes: number | null;
  has_video: number;
  egress_id: string;
  status: MediaRecordingStatus;
  retention_until: string;
  object_status: MediaRecordingObjectStatus;
  object_checked_at: string | null;
  failure_code: string;
  completed_at: string | null;
  deleted_at: string | null;
  updated_at: string;
  created_at: string;
}

export interface LiveKitEgressClientLike {
  startRoomCompositeEgress(
    roomName: string,
    output: unknown,
    options?: { audioOnly?: boolean }
  ): Promise<{ egressId?: string | null }>;
  stopEgress(egressId: string): Promise<unknown>;
}

export interface LiveKitRecordingDependencies {
  now?: () => Date;
  createEgressClient?: () => LiveKitEgressClientLike;
  resolveRetentionDays?: (tenantId: string) => number | Promise<number>;
  resolveRecordingObject?: (recording: EgressRecord) => Promise<RecordingObjectContentResult>;
  deleteRecordingObject?: (recording: EgressRecord) => Promise<RecordingObjectDeleteResult>;
}

export interface LiveKitRecordingServiceApi {
  startRecording(
    tenantId: string,
    callSessionId: string | null | undefined,
    roomName: string,
    opts?: StartRecordingOptions
  ): Promise<EgressRecord>;
  stopRecording(egressId: string): Promise<EgressRecord | null>;
  getRecording(recordingId: string): EgressRecord | null;
  getRecordingByEgressId(egressId: string): EgressRecord | null;
  getRecordingBySession(callSessionId: string): EgressRecord | null;
  listRecordings(tenantId: string, opts?: { limit?: number }): EgressRecord[];
  inspectObject(recordingId: string): Promise<RecordingObjectInspection | null>;
  exportObject(recordingId: string): Promise<RecordingObjectExport | null>;
  listRetentionCandidates(
    tenantId: string,
    opts?: { before?: string; limit?: number }
  ): EgressRecord[];
  cleanupExpiredRecordings(
    tenantId: string,
    opts?: {
      before?: string;
      limit?: number;
      dryRun?: boolean;
      onDeleted?: (
        recording: EgressRecord,
        result: RecordingObjectDeleteResult
      ) => void | Promise<void>;
    }
  ): Promise<RecordingRetentionCleanupResult>;
}

export interface LiveKitAgentDispatchService {
  dispatchAiAgent(
    roomName: string,
    metadata: Record<string, unknown>,
    agentName?: string
  ): Promise<boolean>;
}

export interface LiveKitWebhookResult {
  ok: boolean;
  ignored?: boolean;
  idempotent_replay?: boolean;
  event?: string;
  room_name?: string;
  recording?: EgressRecord;
}

export interface LiveKitWebhookService {
  handleWebhook(rawBody: string, authHeader?: string): Promise<LiveKitWebhookResult>;
}

export interface LiveKitParticipantEventSink {
  notifyParticipantJoined(roomName: string, identity: string): void;
}

export interface LiveKitRecordingEventSink {
  notifyRecordingCompleted(recording: EgressRecord, context: { roomName: string }): void | Promise<void>;
}

export interface LiveKitMediaModule {
  rooms: LiveKitRoomService;
  participants: LiveKitParticipantService;
  tokens: LiveKitTokenService;
  joins: MediaJoinService;
  recordings: LiveKitRecordingServiceApi;
  dispatch: LiveKitAgentDispatchService;
  webhooks: LiveKitWebhookService;
  gateways: MediaGatewayRegistry;
}

export interface LiveKitMediaModuleInput {
  db: unknown;
  config?: LiveKitConfig & { minioBucket?: string; recordingRetentionDays?: number };
  gateways?: MediaGatewayRegistry;
  participantEvents?: LiveKitParticipantEventSink;
  recordingEvents?: LiveKitRecordingEventSink;
  recordingDependencies?: LiveKitRecordingDependencies;
}
