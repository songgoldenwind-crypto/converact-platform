import type { IveKitSdkBusinessRef } from './types.js';

export type IveKitMediaKind = 'voice' | 'video';

export interface IveKitMediaCapabilities {
  provider: 'livekit';
  tenant_id: string;
  capabilities: {
    rooms: boolean;
    tokens: boolean;
    join: boolean;
    participants: boolean;
    recording: boolean;
    recording_object_check: boolean;
    recording_export: boolean;
    recording_retention_cleanup: boolean;
    webhooks: boolean;
    web_assist: boolean;
    sip_volte: 'ready' | 'planned';
  };
  config: {
    livekit_url_configured: boolean;
    livekit_public_url_configured: boolean;
    livekit_server_configured: boolean;
    livekit_browser_join_ready: boolean;
    livekit_api_key_configured: boolean;
    livekit_api_secret_configured: boolean;
    invite_secret_configured: boolean;
    egress_configured: boolean;
  };
}

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

export type IveKitMediaParticipantStatus =
  | 'invited'
  | 'ringing'
  | 'accepted'
  | 'joined'
  | 'declined'
  | 'left'
  | 'missed'
  | 'removed';

export type IveKitMediaCallRole = 'host' | 'participant' | 'observer';

export interface IveKitMediaCall {
  id: string;
  tenant_id: string;
  room_name: string;
  media: IveKitMediaKind;
  status: IveKitMediaCallStatus;
  initiated_by: string;
  business_ref: IveKitSdkBusinessRef;
  title: string;
  metadata: Record<string, unknown>;
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
  status: IveKitMediaParticipantStatus;
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

export interface IveKitCreateMediaCallInput {
  media: IveKitMediaKind;
  participant_identities: string[];
  business_ref: IveKitSdkBusinessRef;
  title?: string;
  ring_timeout_seconds?: number;
  metadata?: Record<string, unknown>;
}

export type IveKitMediaCallAction =
  | 'ring'
  | 'accept'
  | 'reject'
  | 'cancel'
  | 'timeout'
  | 'activate'
  | 'end'
  | 'fail';

export interface IveKitMediaCallActionInput {
  action: IveKitMediaCallAction;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface IveKitMediaJoinInput {
  identity: string;
  role: IveKitMediaCallRole;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export interface IveKitMediaCallParticipantListResult {
  items: IveKitMediaCallParticipant[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface IveKitMediaCursorPage<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export type IveKitMediaRoomPurpose =
  | 'ai_outbound'
  | 'video_service'
  | 'screen_share'
  | 'conference'
  | 'pstn_bridge';

export interface IveKitMediaRoom {
  id: string;
  tenant_id: string;
  room_name: string;
  room_sid: string;
  purpose: IveKitMediaRoomPurpose;
  status: 'created' | 'active' | 'closed';
  call_session_id: string | null;
  metadata: Record<string, unknown>;
}

export interface IveKitCreateMediaRoomInput {
  purpose?: IveKitMediaRoomPurpose;
  call_session_id?: string;
  room_name?: string;
  business_ref?: IveKitSdkBusinessRef;
  business_ref_type?: string;
  business_ref_id?: string;
  business_ref_metadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface IveKitMediaRoomJoinInput {
  identity: string;
  role?: 'agent' | 'customer';
  media?: IveKitMediaKind;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface IveKitMediaToken {
  token: string;
  livekit_url: string;
  room_name: string;
  configured: boolean;
}

export type IveKitMediaJoinPlan =
  | {
      mode: 'webrtc';
      channel: string;
      token: IveKitMediaToken;
      joinPath?: string;
      roomName: string;
      role: IveKitMediaCallRole | 'agent' | 'customer';
    }
  | {
      mode: 'sip_bridge';
      channel: string;
      sipDialTarget: string;
      trunk?: string;
      video: boolean;
      note: string;
      roomName: string;
      role: IveKitMediaCallRole | 'agent' | 'customer';
    };

export type IveKitMediaProviderParticipantRole =
  | 'agent'
  | 'customer'
  | 'supervisor'
  | 'ai'
  | 'sip'
  | 'unknown';

export interface IveKitMediaProviderParticipant {
  id: string;
  tenant_id: string;
  room_name: string;
  identity: string;
  role: IveKitMediaProviderParticipantRole;
  status: 'joined' | 'left';
  metadata: Record<string, unknown>;
  joined_at: string;
  left_at: string | null;
}

export type IveKitMediaTrackSource =
  | 'camera'
  | 'microphone'
  | 'screen_share'
  | 'screen_share_audio';

export interface IveKitMediaMuteInput {
  track_sid: string;
  source: IveKitMediaTrackSource;
  muted: true;
}

export interface IveKitMediaModerationResult {
  room_name: string;
  participant_identity: string;
  action: 'mute' | 'remove';
  status: 'applied' | 'already_applied';
  actor_identity: string;
  track_sid?: string;
  source?: IveKitMediaTrackSource;
  muted?: true;
  reason?: string;
}

export type IveKitMediaRecordingFormat = 'mp4' | 'webm' | 'wav' | 'ogg';
export type IveKitMediaRecordingStatus =
  | 'starting'
  | 'pending'
  | 'recording'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'deleted';
export type IveKitMediaRecordingObjectStatus =
  | 'unchecked'
  | 'readable'
  | 'missing_storage_url'
  | 'not_found'
  | 'forbidden'
  | 'unsupported'
  | 'fetch_failed'
  | 'deleted'
  | 'delete_failed';
export type IveKitMediaRecordingObjectSource = 'file' | 'http' | 's3' | 'local_upload' | 'local_path';

export interface IveKitMediaRecording {
  id: string;
  tenant_id: string;
  call_session_id: string;
  business_ref_type: string;
  business_ref_id: string;
  business_ref: IveKitSdkBusinessRef | null;
  source: 'livekit_egress' | 'rustpbx_sipflow';
  format: IveKitMediaRecordingFormat;
  storage_url: string;
  duration_ms: number | null;
  file_size_bytes: number | null;
  has_video: number;
  egress_id: string;
  status: IveKitMediaRecordingStatus;
  retention_until: string;
  object_status: IveKitMediaRecordingObjectStatus;
  object_checked_at: string | null;
  failure_code: string;
  completed_at: string | null;
  deleted_at: string | null;
  updated_at: string;
  created_at: string;
  evidence_record_id?: string;
  evidence_record?: Record<string, unknown>;
}

export interface IveKitStartMediaRecordingInput {
  call_session_id?: string;
  business_ref?: IveKitSdkBusinessRef;
  business_ref_type?: string;
  business_ref_id?: string;
  business_ref_metadata?: Record<string, unknown>;
  format?: IveKitMediaRecordingFormat;
  has_video?: boolean;
  retention_until?: string;
  retention_days?: number;
}

export interface IveKitMediaRecordingObjectInspection {
  status: Exclude<IveKitMediaRecordingObjectStatus, 'unchecked' | 'deleted' | 'delete_failed'>;
  readable: boolean;
  source?: IveKitMediaRecordingObjectSource;
  size_bytes: number;
  checksum: string;
}

export interface IveKitMediaRecordingRetentionInput {
  before?: string;
  limit?: number;
  dry_run?: boolean;
  confirm?: boolean;
}

export interface IveKitMediaRecordingRetentionResult {
  dry_run: boolean;
  candidates: number;
  deleted: number;
  failed: number;
  results: Array<{
    recording_id: string;
    status: 'deleted' | 'not_found' | 'unsupported' | 'delete_failed';
    source?: IveKitMediaRecordingObjectSource;
    error?: string;
  }>;
}
