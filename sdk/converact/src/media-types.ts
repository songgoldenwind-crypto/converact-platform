import type { ConveractFabricSdkBusinessRef } from './types.js';

export type ConveractFabricMediaKind = 'voice' | 'video';

export interface ConveractFabricMediaCapabilities {
  provider: 'livekit';
  tenant_id: string;
  capabilities: {
    calls: boolean;
    rooms: boolean;
    tokens: boolean;
    join: boolean;
    participants: boolean;
    host_moderation: boolean;
    recording: boolean;
    recording_object_check: boolean;
    recording_export: boolean;
    recording_retention_cleanup: boolean;
    ingress: boolean;
    quality_observability: boolean;
    connection_rejoin_events: boolean;
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
    ingress_configured: boolean;
  };
}

export type ConveractFabricMediaIngressInputType = 'rtmp' | 'whip' | 'url';

export interface ConveractFabricMediaIngress {
  ingress_id: string;
  name: string;
  stream_key: string;
  url: string;
  input_type: ConveractFabricMediaIngressInputType;
  enable_transcoding?: boolean;
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
  room_name: string;
  participant_identity: string;
  participant_name: string;
  participant_metadata: Record<string, unknown>;
  reusable: boolean;
  enabled?: boolean;
  state: Record<string, unknown> | null;
}

export interface ConveractFabricCreateMediaIngressInput {
  input_type: ConveractFabricMediaIngressInputType;
  name?: string;
  room_name: string;
  participant_identity: string;
  participant_name?: string;
  participant_metadata?: Record<string, unknown>;
  enable_transcoding?: boolean;
  url?: string;
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
}

export interface ConveractFabricUpdateMediaIngressInput {
  name?: string;
  room_name?: string;
  participant_identity?: string;
  participant_name?: string;
  participant_metadata?: Record<string, unknown>;
  enable_transcoding?: boolean;
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
}

export interface ConveractFabricCreateMediaIngressResult extends ConveractFabricMediaIngress {
  replayed: boolean;
}

export type ConveractFabricMediaCallStatus =
  | 'created'
  | 'ringing'
  | 'accepted'
  | 'active'
  | 'rejected'
  | 'cancelled'
  | 'timed_out'
  | 'ended'
  | 'failed';

export type ConveractFabricMediaParticipantStatus =
  | 'invited'
  | 'ringing'
  | 'accepted'
  | 'joined'
  | 'declined'
  | 'left'
  | 'missed'
  | 'removed';

export type ConveractFabricMediaCallRole = 'host' | 'participant' | 'observer';

export interface ConveractFabricMediaCall {
  id: string;
  tenant_id: string;
  room_name: string;
  media: ConveractFabricMediaKind;
  status: ConveractFabricMediaCallStatus;
  initiated_by: string;
  business_ref: ConveractFabricSdkBusinessRef;
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

export interface ConveractFabricMediaCallParticipant {
  id: string;
  tenant_id: string;
  call_id: string;
  identity: string;
  role: ConveractFabricMediaCallRole;
  status: ConveractFabricMediaParticipantStatus;
  display_name: string;
  metadata: Record<string, unknown>;
  invited_at: string;
  accepted_at: string | null;
  joined_at: string | null;
  left_at: string | null;
  connection_revision?: number;
  connection_state?: ConveractFabricMediaConnectionState;
  connection_updated_at?: string | null;
  last_disconnected_at?: string | null;
  last_rejoined_at?: string | null;
  quality_state?: ConveractFabricMediaQualityState;
  quality_degraded_streak?: number;
  quality_recovered_streak?: number;
  last_quality_level?: ConveractFabricMediaQualityLevel;
  last_quality_sample_id?: string;
  last_qos_at?: string | null;
  updated_at: string;
}

export interface ConveractFabricMediaCallSnapshot {
  call: ConveractFabricMediaCall;
  participants: ConveractFabricMediaCallParticipant[];
}

export type ConveractFabricMediaConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'rejoining'
  | 'failed';

export type ConveractFabricMediaConnectionEventType =
  | 'connected'
  | 'reconnecting'
  | 'reconnected'
  | 'disconnected'
  | 'rejoining'
  | 'rejoined'
  | 'failed';

export type ConveractFabricMediaQualityState = 'unknown' | 'good' | 'degraded';
export type ConveractFabricMediaQualityLevel = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

export interface ConveractFabricMediaQualitySnapshotInput {
  participant_identity: string;
  connection_revision: number;
  sample_id: string;
  track_source: ConveractFabricMediaTrackSource;
  quality_level: ConveractFabricMediaQualityLevel;
  rtt_ms?: number | null;
  jitter_ms?: number | null;
  packet_loss_ratio?: number | null;
  bitrate_bps?: number | null;
  quality_score?: number | null;
  sampled_at: string;
}

export interface ConveractFabricMediaQualitySnapshot extends ConveractFabricMediaQualitySnapshotInput {
  id: string;
  tenant_id: string;
  call_id: string;
  received_at: string;
}

export interface ConveractFabricMediaQualityParticipantState {
  tenant_id: string;
  call_id: string;
  identity: string;
  participant_status: ConveractFabricMediaParticipantStatus;
  connection_revision: number;
  connection_state: ConveractFabricMediaConnectionState;
  connection_updated_at: string | null;
  last_disconnected_at: string | null;
  last_rejoined_at: string | null;
  quality_state: ConveractFabricMediaQualityState;
  quality_degraded_streak: number;
  quality_recovered_streak: number;
  last_quality_level: ConveractFabricMediaQualityLevel;
  last_quality_sample_id: string;
  last_qos_at: string | null;
}

export interface ConveractFabricMediaQualityTransition {
  tenant_id: string;
  call_id: string;
  participant_identity: string;
  connection_revision: number;
  from: ConveractFabricMediaQualityState;
  to: 'good' | 'degraded';
  event_type: 'degraded' | 'recovered';
  quality_level: ConveractFabricMediaQualityLevel;
  sampled_at: string;
}

export interface ConveractFabricMediaQualityReportResult {
  accepted: number;
  replayed: number;
  participant_states: ConveractFabricMediaQualityParticipantState[];
  transitions: ConveractFabricMediaQualityTransition[];
}

export interface ConveractFabricMediaConnectionEventInput {
  participant_identity: string;
  event_id: string;
  connection_revision: number;
  event_type: ConveractFabricMediaConnectionEventType;
  reason_code?: string;
  occurred_at: string;
}

export interface ConveractFabricMediaConnectionEvent extends ConveractFabricMediaConnectionEventInput {
  id: string;
  tenant_id: string;
  call_id: string;
  reason_code: string;
  connection_state: ConveractFabricMediaConnectionState;
  received_at: string;
}

export interface ConveractFabricMediaConnectionEventResult {
  event: ConveractFabricMediaConnectionEvent;
  participant_state: ConveractFabricMediaQualityParticipantState;
  replayed: boolean;
}

export type ConveractFabricRealtimeSpeechSegmentKind = 'transcript' | 'translation';

export interface ConveractFabricRealtimeSpeechSegment {
  id: string;
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  media_source: 'rustpbx' | 'livekit';
  participant_id: string;
  track_id: string;
  purpose: 'live_captions' | 'live_translation';
  consent_ref: string;
  provider_profile_id: string;
  provider: string;
  provider_version: string;
  source_event_id: string;
  provider_session_id: string;
  sequence: number;
  kind: ConveractFabricRealtimeSpeechSegmentKind;
  segment_id: string;
  speaker_id: string;
  source_language: string;
  target_language: string;
  source_text: string;
  translated_text: string;
  confidence?: number;
  start_ms?: number;
  end_ms?: number;
  provider_request_id: string;
  latency_ms: Record<string, number>;
  safe_metadata: Record<string, unknown>;
  occurred_at: string;
  retention_until: string;
  created_at: string;
}

export type ConveractFabricRealtimeSpeechSegmentPage = ConveractFabricMediaCursorPage<ConveractFabricRealtimeSpeechSegment>;

export interface ConveractFabricMediaQualitySummary {
  tenant_id: string;
  call_id: string;
  generated_at: string;
  participants: ConveractFabricMediaQualityParticipantState[];
  recent_snapshots: ConveractFabricMediaQualitySnapshot[];
}

export interface ConveractFabricCreateMediaCallInput {
  media: ConveractFabricMediaKind;
  participant_identities: string[];
  business_ref: ConveractFabricSdkBusinessRef;
  title?: string;
  ring_timeout_seconds?: number;
  metadata?: Record<string, unknown>;
}

export type ConveractFabricMediaCallAction =
  | 'ring'
  | 'accept'
  | 'reject'
  | 'cancel'
  | 'timeout'
  | 'activate'
  | 'end'
  | 'fail';

export interface ConveractFabricMediaCallActionInput {
  action: ConveractFabricMediaCallAction;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ConveractFabricMediaJoinInput {
  identity: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
  recovery?: {
    previous_owner_epoch: string;
    previous_reservation_id: string;
  };
}

export interface ConveractFabricMediaCallParticipantListResult {
  items: ConveractFabricMediaCallParticipant[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ConveractFabricMediaCursorPage<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export type ConveractFabricMediaRoomPurpose =
  | 'ai_outbound'
  | 'video_service'
  | 'screen_share'
  | 'conference'
  | 'pstn_bridge';

export interface ConveractFabricMediaRoom {
  id: string;
  tenant_id: string;
  room_name: string;
  room_sid: string;
  purpose: ConveractFabricMediaRoomPurpose;
  status: 'created' | 'active' | 'closed';
  call_session_id: string | null;
  metadata: Record<string, unknown>;
}

export interface ConveractFabricCreateMediaRoomInput {
  purpose?: ConveractFabricMediaRoomPurpose;
  call_session_id?: string;
  room_name?: string;
  business_ref?: ConveractFabricSdkBusinessRef;
  business_ref_type?: string;
  business_ref_id?: string;
  business_ref_metadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ConveractFabricMediaRoomJoinInput {
  identity: string;
  role?: 'agent' | 'customer';
  media?: ConveractFabricMediaKind;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface ConveractFabricMediaPlacement {
  interaction_id: string;
  reservation_id: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  profile_id: string;
  snapshot_version: number;
  placement_generation?: number;
  livekit_url: string;
}

export interface ConveractFabricMediaToken {
  token: string;
  livekit_url: string;
  room_name: string;
  configured: boolean;
  placement?: ConveractFabricMediaPlacement;
}

export type ConveractFabricMediaJoinPlan =
  | {
      mode: 'webrtc';
      channel: string;
      token: ConveractFabricMediaToken;
      joinPath?: string;
      roomName: string;
      role: ConveractFabricMediaCallRole | 'agent' | 'customer';
    }
  | {
      mode: 'sip_bridge';
      channel: string;
      sipDialTarget: string;
      trunk?: string;
      video: boolean;
      note: string;
      roomName: string;
      role: ConveractFabricMediaCallRole | 'agent' | 'customer';
    };

export type ConveractFabricMediaProviderParticipantRole =
  | 'agent'
  | 'customer'
  | 'supervisor'
  | 'ai'
  | 'sip'
  | 'unknown';

export interface ConveractFabricMediaProviderParticipant {
  id: string;
  tenant_id: string;
  room_name: string;
  identity: string;
  role: ConveractFabricMediaProviderParticipantRole;
  status: 'joined' | 'left';
  metadata: Record<string, unknown>;
  joined_at: string;
  left_at: string | null;
}

export type ConveractFabricMediaTrackSource =
  | 'camera'
  | 'microphone'
  | 'screen_share'
  | 'screen_share_audio';

export interface ConveractFabricMediaMuteInput {
  track_sid: string;
  source: ConveractFabricMediaTrackSource;
  muted: true;
}

export interface ConveractFabricMediaModerationResult {
  room_name: string;
  participant_identity: string;
  action: 'mute' | 'remove';
  status: 'applied' | 'already_applied';
  actor_identity: string;
  track_sid?: string;
  source?: ConveractFabricMediaTrackSource;
  muted?: true;
  reason?: string;
}

export interface ConveractFabricMediaModerationRecoveryResult {
  examined: number;
  finalized: number;
  recovered: number;
  failed: number;
  results: ConveractFabricMediaModerationResult[];
}

export type ConveractFabricMediaRecordingFormat = 'mp4' | 'webm' | 'wav' | 'ogg';
export type ConveractFabricMediaRecordingMode = 'track' | 'track_composite' | 'room_composite';
export type ConveractFabricMediaRecordingStatus =
  | 'starting'
  | 'pending'
  | 'recording'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'deleted';
export type ConveractFabricMediaRecordingObjectStatus =
  | 'unchecked'
  | 'readable'
  | 'missing_storage_url'
  | 'not_found'
  | 'forbidden'
  | 'unsupported'
  | 'fetch_failed'
  | 'deleted'
  | 'delete_failed';
export type ConveractFabricMediaRecordingObjectSource = 'file' | 'http' | 's3' | 'local_upload' | 'local_path';

export interface ConveractFabricMediaRecording {
  id: string;
  tenant_id: string;
  call_session_id: string;
  media_call_id: string;
  room_name: string;
  business_ref_type: string;
  business_ref_id: string;
  business_ref: ConveractFabricSdkBusinessRef | null;
  source: 'livekit_egress' | 'rustpbx_sipflow';
  format: ConveractFabricMediaRecordingFormat;
  duration_ms: number | null;
  file_size_bytes: number | null;
  has_video: number;
  recording_mode?: ConveractFabricMediaRecordingMode;
  egress_id: string;
  status: ConveractFabricMediaRecordingStatus;
  retention_until: string;
  object_status: ConveractFabricMediaRecordingObjectStatus;
  object_checked_at: string | null;
  failure_code: string;
  completed_at: string | null;
  deleted_at: string | null;
  updated_at: string;
  created_at: string;
  evidence_record_id: string;
  evidence_record?: Record<string, unknown>;
}

export interface ConveractFabricMediaRecordingTrackSelector {
  track_id: string;
  kind: 'audio' | 'video';
  source: 'microphone' | 'camera' | 'screen_share' | 'screen_share_audio' | 'unknown';
}

export interface ConveractFabricMediaEgressJob {
  id: string;
  tenant_id: string;
  recording_id: string;
  job_sequence: number;
  room_name: string;
  recording_mode: ConveractFabricMediaRecordingMode;
  track_id: string;
  track_kind: string;
  track_source: string;
  audio_track_id: string;
  video_track_id: string;
  egress_id: string;
  status: Exclude<ConveractFabricMediaRecordingStatus, 'deleted'>;
  failure_code: string;
  reservation_id: string;
  owner_epoch: string;
  duration_ms: number | null;
  file_size_bytes: number | null;
  object_status: ConveractFabricMediaRecordingObjectStatus;
  object_checked_at: string | null;
  completed_at: string | null;
  deleted_at: string | null;
  updated_at: string;
  created_at: string;
}

export interface ConveractFabricStartMediaRecordingInput {
  call_session_id?: string;
  media_call_id?: string;
  business_ref?: ConveractFabricSdkBusinessRef;
  business_ref_type?: string;
  business_ref_id?: string;
  business_ref_metadata?: Record<string, unknown>;
  format?: ConveractFabricMediaRecordingFormat;
  has_video?: boolean;
  recording_mode?: ConveractFabricMediaRecordingMode;
  tracks?: ConveractFabricMediaRecordingTrackSelector[];
  audio_track_id?: string;
  video_track_id?: string;
  retention_until?: string;
  retention_days?: number;
}

export interface ConveractFabricMediaRecordingListInput {
  limit?: number;
  cursor?: string;
  call_id?: string;
  room_name?: string;
  business_ref_type?: string;
  business_ref_id?: string;
  status?: ConveractFabricMediaRecordingStatus;
}

export type ConveractFabricMediaRecordingPage = ConveractFabricMediaCursorPage<ConveractFabricMediaRecording>;

export interface ConveractFabricMediaRecordingObjectInspection {
  status: Exclude<ConveractFabricMediaRecordingObjectStatus, 'unchecked' | 'deleted' | 'delete_failed'>;
  readable: boolean;
  source?: ConveractFabricMediaRecordingObjectSource;
  size_bytes: number;
  checksum: string;
}

export interface ConveractFabricMediaRecordingRetentionInput {
  before?: string;
  limit?: number;
  dry_run?: boolean;
  confirm?: boolean;
}

export interface ConveractFabricMediaRecordingRetentionResult {
  dry_run: boolean;
  candidates: number;
  deleted: number;
  failed: number;
  results: Array<{
    recording_id: string;
    status: 'deleted' | 'not_found' | 'unsupported' | 'delete_failed';
    source?: ConveractFabricMediaRecordingObjectSource;
    error?: string;
  }>;
}
