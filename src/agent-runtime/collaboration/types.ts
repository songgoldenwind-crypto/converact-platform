import type { RustDeskPhysicalDisconnectSummary } from './rustdesk-physical-disconnect.js';

export type BusinessRefType =
  | 'call_session'
  | 'service_order'
  | 'support_ticket'
  | 'conversation'
  | string;

export interface BusinessRef {
  tenant_id: string;
  type: BusinessRefType;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export type CollaborationSessionStatus = 'open' | 'closed';

export interface CollaborationSession {
  id: string;
  tenant_id: string;
  business_ref_type: string;
  business_ref_id: string;
  business_ref: BusinessRef;
  status: CollaborationSessionStatus;
  title: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export type CollaborationParticipantRole =
  | 'customer'
  | 'agent'
  | 'engineer'
  | 'supervisor'
  | 'ai'
  | 'admin';

export interface CollaborationParticipant {
  id: string;
  tenant_id: string;
  session_id: string;
  identity: string;
  role: CollaborationParticipantRole;
  display_name: string;
  user_ref_type: string;
  user_ref_id: string;
  joined_at: string;
  left_at: string | null;
}

export type CollaborationMessageType = 'text' | 'image' | 'video' | 'file' | 'system';

export type CollaborationMessageAttachmentKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'screen_recording';

export type CollaborationMessageAttachmentStatus = 'pending' | 'ready' | 'failed';

export interface CollaborationMessageAttachment {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  kind: CollaborationMessageAttachmentKind;
  storage_url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum: string;
  processing_status: CollaborationMessageAttachmentStatus;
  ocr_text: string;
  asr_text: string;
  extracted_text: string;
  processing_error_code: string;
  processed_at: string | null;
  updated_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export type CollaborationAttachmentProcessor = 'ocr' | 'asr';
export type CollaborationAttachmentProcessingStatus =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface CollaborationAttachmentProcessingJob {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  attachment_id: string;
  processor: CollaborationAttachmentProcessor;
  status: CollaborationAttachmentProcessingStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  provider_mode: 'unconfigured' | 'self_hosted' | 'third_party';
  provider_name: string;
  error_code: string;
  error_message: string;
  output_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type CollaborationMessageProviderDeliveryStatus =
  | 'not_required'
  | 'pending'
  | 'publishing'
  | 'retry_wait'
  | 'delivered'
  | 'failed';

export interface CollaborationMessageProviderDelivery {
  provider: string;
  provider_topic_id: string;
  provider_message_id: string;
  status: CollaborationMessageProviderDeliveryStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  last_error_code: string;
  last_error_message: string;
  delivered_at: string | null;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export type CollaborationMessageDeliveryAttemptStatus =
  | 'started'
  | 'delivered'
  | 'retry_wait'
  | 'failed'
  | 'lease_expired';

export interface CollaborationMessageDeliveryAttempt {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  attempt_number: number;
  provider: string;
  status: CollaborationMessageDeliveryAttemptStatus;
  provider_message_id: string;
  error_code: string;
  error_message: string;
  started_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
}

export type CollaborationMessageReceiptStatus = 'delivered' | 'read';
export type CollaborationMessageReceiptSource = 'ivekit' | 'tinode' | 'system';

export interface CollaborationMessageReceipt {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  identity: string;
  delivered_at: string | null;
  read_at: string | null;
  source: CollaborationMessageReceiptSource;
  provider_sequence: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type CollaborationPresenceStatus = 'online' | 'away' | 'offline';

export interface CollaborationParticipantRealtimeState {
  id: string;
  tenant_id: string;
  session_id: string;
  identity: string;
  presence_status: CollaborationPresenceStatus;
  presence_expires_at: string | null;
  typing: boolean;
  typing_expires_at: string | null;
  last_seen_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CollaborationMessage {
  id: string;
  tenant_id: string;
  session_id: string;
  sender_identity: string;
  message_type: CollaborationMessageType;
  body: string;
  original_language: string;
  metadata: Record<string, unknown>;
  attachments: CollaborationMessageAttachment[];
  idempotency_key: string;
  provider_delivery: CollaborationMessageProviderDelivery;
  edit_version: number;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string;
  created_at: string;
}

export type CollaborationMessageMutationAction = 'edit' | 'delete';

export interface CollaborationMessageMutation {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  version: number;
  action: CollaborationMessageMutationAction;
  actor_identity: string;
  before_body_hash: string;
  after_body_hash: string;
  reason: string;
  created_at: string;
}

export interface CollaborationMessageTranslation {
  id: string;
  tenant_id: string;
  message_id: string;
  target_language: string;
  translated_body: string;
  provider: string;
  confidence: number | null;
  created_at: string;
}

export interface CollaborationChatBinding {
  id: string;
  tenant_id: string;
  session_id: string;
  provider: string;
  provider_topic_id: string;
  provider_status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type PolicySeverity = 'low' | 'medium' | 'high';

export interface CollaborationPolicyEvent {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  policy_type: string;
  severity: PolicySeverity;
  matched_text_hash: string;
  action: string;
  source: PolicyFindingSource;
  source_ref_id: string;
  attachment_id: string;
  finding_id: string;
  created_at: string;
}

export type PolicyFindingSource = 'text' | 'ocr' | 'asr' | 'ai';
export type PolicyFindingReviewStatus =
  | 'pending'
  | 'confirmed'
  | 'false_positive'
  | 'resolved'
  | 'escalated';

export interface PolicyEvidenceRef {
  type: string;
  id: string;
  [key: string]: unknown;
}

export interface CollaborationPolicyFinding {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  source: PolicyFindingSource;
  source_ref_id: string;
  policy_type: string;
  severity: PolicySeverity;
  matched_text_hash: string;
  fingerprint: string;
  action: string;
  confidence: number | null;
  rationale: string;
  evidence_refs: PolicyEvidenceRef[];
  review_status: PolicyFindingReviewStatus;
  reviewed_by: string;
  reviewed_at: string | null;
  review_note: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface CollaborationPolicyFindingReview {
  id: string;
  tenant_id: string;
  finding_id: string;
  from_status: PolicyFindingReviewStatus;
  to_status: PolicyFindingReviewStatus;
  reviewed_by: string;
  note: string;
  note_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PolicyScanResult {
  matched: boolean;
  events: CollaborationPolicyEvent[];
  findings: CollaborationPolicyFinding[];
}

export type CollaborationTimelineItem =
  | { type: 'participant'; item: CollaborationParticipant }
  | { type: 'message'; item: CollaborationMessage };

export interface CollaborationChatSnapshot {
  session: CollaborationSession;
  binding: CollaborationChatBinding | null;
  participants: CollaborationParticipant[];
  messages: CollaborationMessage[];
  policy_events: CollaborationPolicyEvent[];
  policy_findings: CollaborationPolicyFinding[];
}

export type RemoteAssistanceMode =
  | 'web_remote_assist'
  | 'screen_share'
  | 'third_party_remote_tool'
  | 'platform_remote_control'
  | 'remote_desktop_gateway';

export type RemoteAssistanceStatus = 'created' | 'active' | 'ended';

export interface RemoteAssistanceSession {
  id: string;
  tenant_id: string;
  collaboration_session_id: string;
  business_ref_type: string;
  business_ref_id: string;
  business_ref: BusinessRef;
  status: RemoteAssistanceStatus;
  mode: RemoteAssistanceMode;
  adapter_provider: string;
  started_by: string;
  started_at: string | null;
  ended_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  physical_disconnect?: RustDeskPhysicalDisconnectSummary;
}

export type RemoteConsentScope =
  | 'view_screen'
  | 'control_mouse_keyboard'
  | 'record_screen'
  | 'transfer_file'
  | 'clipboard';

export type RemoteConsentEventType = 'requested' | 'granted' | 'denied' | 'revoked' | 'expired';

export interface RemoteConsentEvent {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  event_type: RemoteConsentEventType;
  scopes: RemoteConsentScope[];
  expires_at: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
  physical_disconnect?: RustDeskPhysicalDisconnectSummary;
}

export type RemoteToolProvider =
  | 'teamviewer'
  | 'anydesk'
  | 'sunlogin'
  | 'rustdesk'
  | 'meshcentral'
  | 'guacamole'
  | 'zoom'
  | 'google_meet'
  | 'external_link'
  | string;

export interface RemoteToolSession {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  provider: RemoteToolProvider;
  external_id: string;
  launch_url: string;
  status: 'active' | 'ended';
  started_by: string;
  started_at: string;
  ended_at: string | null;
  metadata: Record<string, unknown>;
  physical_disconnect?: RustDeskPhysicalDisconnectSummary;
}

export interface RemoteAuditEvent {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  event_type: string;
  target: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export type EvidenceKind =
  | 'audio_recording'
  | 'video_recording'
  | 'screen_recording'
  | 'remote_control_log'
  | 'consent_grant'
  | 'consent_revocation'
  | 'chat_export'
  | 'file_snapshot';

export interface EvidenceRecord {
  id: string;
  tenant_id: string;
  business_ref_type: string;
  business_ref_id: string;
  session_id: string;
  kind: EvidenceKind;
  storage_url: string;
  checksum: string;
  retention_until: string | null;
  created_by: string;
  created_at: string;
  metadata: Record<string, unknown>;
}
