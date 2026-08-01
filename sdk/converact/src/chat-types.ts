export interface ConveractFabricChatBusinessRef {
  tenant_id?: string;
  type: string;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export interface ConveractFabricChatSession {
  id: string;
  tenant_id: string;
  business_ref_type: string;
  business_ref_id: string;
  business_ref: ConveractFabricChatBusinessRef;
  title: string;
  status: 'open' | 'closed';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  summary?: ConveractFabricChatSessionSummary;
}

export interface ConveractFabricChatSessionSummary {
  unread_count: number;
  online_participant_count: number;
  last_message: {
    id: string;
    body: string;
    sender_identity: string;
    message_type: ConveractFabricChatMessage['message_type'];
    created_at: string;
    deleted: boolean;
  } | null;
}

export interface ConveractFabricChatBinding {
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

export interface ConveractFabricChatParticipant {
  id: string;
  tenant_id: string;
  session_id: string;
  identity: string;
  role: 'customer' | 'agent' | 'engineer' | 'supervisor' | 'ai' | 'admin';
  display_name: string;
  user_ref_type: string;
  user_ref_id: string;
  joined_at: string;
  left_at: string | null;
}

export type ConveractFabricChatAttachmentKind = 'image' | 'video' | 'audio' | 'file' | 'screen_recording';
export type ConveractFabricChatAttachmentStatus = 'pending' | 'ready' | 'failed';
export type ConveractFabricChatAttachmentProcessor = 'ocr' | 'asr' | 'video_frame_ocr';
export type ConveractFabricChatAttachmentJobStatus =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type ConveractFabricAttachmentTransferPhase =
  | 'uploading'
  | 'uploaded'
  | 'attached'
  | 'processing_pending'
  | 'processing'
  | 'retry_wait'
  | 'completed'
  | 'failed'
  | 'provider_unconfigured'
  | 'cancelled';

export interface ConveractFabricChatAttachment {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  secure_file_id?: string;
  kind: ConveractFabricChatAttachmentKind;
  storage_url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum: string;
  processing_status: ConveractFabricChatAttachmentStatus;
  ocr_text: string;
  asr_text: string;
  extracted_text: string;
  processing_error_code: string;
  processed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type ConveractFabricChatDeliveryStatus =
  | 'not_required'
  | 'pending'
  | 'blocked_by_file_security'
  | 'blocked'
  | 'publishing'
  | 'retry_wait'
  | 'delivered'
  | 'failed';

export interface ConveractFabricChatDelivery {
  provider: string;
  provider_topic_id: string;
  provider_message_id: string;
  status: ConveractFabricChatDeliveryStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  last_error_code: string;
  last_error_message: string;
  delivered_at: string | null;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface ConveractFabricTinodeOperationsSnapshot {
  tenant_id: string;
  generated_at: string;
  delivery: {
    pending: number;
    publishing: number;
    retry_wait: number;
    failed: number;
    blocked_by_file_security: number;
    blocked: number;
    oldest_due_at: string | null;
    queue_lag_ms: number;
  };
  inbound: {
    cursors: number;
    active: number;
    error: number;
    paused: number;
    leased: number;
    max_cursor_lag_sequences: number;
    oldest_cursor_updated_at: string | null;
  };
  dead_letters: {
    open: number;
    retryable: number;
    terminal: number;
    oldest_open_at: string | null;
  };
}

export interface ConveractFabricTinodeDeadLetter {
  id: string;
  binding_id: string;
  event_id: string;
  event_kind: string;
  provider_sequence: number;
  provider_delete_id: number;
  error_code: string;
  error_message: string;
  payload_hash: string;
  retryable: boolean;
  retry_count: number;
  next_retry_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConveractFabricTinodeDeadLetterReplayResult {
  dead_letter: ConveractFabricTinodeDeadLetter;
  replay_id: string;
  replayed: boolean;
}

export interface ConveractFabricTinodeMutationDeadLetter {
  id: string;
  session_id: string;
  message_id: string;
  mutation_id: string;
  mutation_version: number;
  action: 'edit' | 'delete';
  attempt_count: number;
  max_attempts: number;
  error_code: string;
  error_message: string;
  created_at: string;
  updated_at: string;
}

export interface ConveractFabricTinodeMutationDeadLetterReplayResult {
  dead_letter: ConveractFabricTinodeMutationDeadLetter;
  replay_id: string;
  replayed: boolean;
}

export interface ConveractFabricChatProviderMutation {
  provider?: string;
  id?: string;
  mutation_id?: string;
  mutation_version?: number;
  action?: 'edit' | 'delete';
  status: 'not_required' | 'pending' | 'processing' | 'retry_wait' | 'delivered' | 'dead_letter';
  attempt_count?: number;
  max_attempts?: number;
  next_attempt_at?: string | null;
  provider_operation_id?: string;
  last_error_code?: string;
  last_error_message?: string;
  completed_at?: string | null;
  updated_at?: string;
}

export interface ConveractFabricChatMessage {
  id: string;
  tenant_id: string;
  session_id: string;
  sender_identity: string;
  message_type: 'text' | 'image' | 'video' | 'file' | 'system';
  body: string;
  original_language: string;
  metadata: Record<string, unknown>;
  attachments: ConveractFabricChatAttachment[];
  idempotency_key: string;
  provider_delivery: ConveractFabricChatDelivery;
  edit_version: number;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string;
  created_at: string;
  reply_to_message_id: string | null;
  forwarded_from_message_id: string | null;
  mentions: string[];
  reactions?: ConveractFabricChatReaction[];
  pinned?: boolean;
}

export interface ConveractFabricChatReceipt {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  identity: string;
  delivered_at: string | null;
  read_at: string | null;
  source: 'ivekit' | 'tinode' | 'system';
  provider_sequence: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ConveractFabricChatRealtimeState {
  id: string;
  tenant_id: string;
  session_id: string;
  identity: string;
  presence_status: 'online' | 'away' | 'offline';
  presence_expires_at: string | null;
  typing: boolean;
  typing_expires_at: string | null;
  last_seen_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ConveractFabricChatMutation {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  action: 'edit' | 'delete';
  actor_identity: string;
  version: number;
  before_body_hash: string;
  after_body_hash: string;
  reason: string;
  created_at: string;
}

export interface ConveractFabricPolicyEvent {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  policy_type: string;
  severity: 'low' | 'medium' | 'high';
  matched_text_hash: string;
  action: string;
  source: 'text' | 'ocr' | 'asr' | 'ai' | 'aggregate';
  source_ref_id: string;
  attachment_id: string;
  finding_id: string;
  detector_version: string;
  policy_version: string;
  evidence_snapshot_hash: string;
  content_version: number;
  created_at: string;
}

export interface ConveractFabricPolicyFinding {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  source: 'text' | 'ocr' | 'asr' | 'ai' | 'aggregate';
  source_ref_id: string;
  policy_type: string;
  severity: 'low' | 'medium' | 'high';
  matched_text_hash: string;
  fingerprint: string;
  action: string;
  confidence: number | null;
  rationale: string;
  review_status: 'pending' | 'confirmed' | 'false_positive' | 'resolved' | 'escalated';
  evidence_refs: Array<Record<string, unknown>>;
  detector_version: string;
  policy_version: string;
  evidence_snapshot_hash: string;
  content_version: number;
  reviewed_by: string;
  reviewed_at: string | null;
  review_note: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ConveractFabricPolicyFindingReview {
  id: string;
  tenant_id: string;
  finding_id: string;
  from_status: ConveractFabricPolicyFinding['review_status'];
  to_status: ConveractFabricPolicyFinding['review_status'];
  reviewed_by: string;
  note: string;
  note_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ConveractFabricChatReaction {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  identity: string;
  emoji: string;
  created_at: string;
}

export interface ConveractFabricChatPin {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  pinned_by: string;
  created_at: string;
}

export interface ConveractFabricChatReactionResult {
  session_id: string;
  message_id: string;
  reactions: ConveractFabricChatReaction[];
  counts: Record<string, number>;
}

export interface ConveractFabricChatPinResult {
  session_id: string;
  message_id?: string;
  pins: ConveractFabricChatPin[];
}

export interface ConveractFabricCursorPage<T = unknown> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ConveractFabricChatSessionListInput {
  status?: 'open' | 'closed';
  business_ref_type?: string;
  business_ref_id?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface ConveractFabricChatMessagePageInput {
  direction?: 'before' | 'after';
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface ConveractFabricChatClientPlan {
  provider: 'tinode' | 'local' | string;
  provider_topic_id: string;
  provider_user_id: string;
  auth_token: string;
  ws_url: string;
  api_key: string;
  participant: ConveractFabricChatParticipant;
}

export interface ConveractFabricChatSnapshot {
  session: ConveractFabricChatSession;
  binding: ConveractFabricChatBinding | null;
  participants: ConveractFabricChatParticipant[];
  messages: ConveractFabricChatMessage[];
  policy_events: ConveractFabricPolicyEvent[];
  policy_findings: ConveractFabricPolicyFinding[];
}

export interface ConveractFabricChatCapabilities {
  provider: string;
  tenant_id: string;
  capabilities: Record<string, boolean>;
  config: Record<string, unknown>;
  delivery_policy: Record<string, unknown>;
}

export interface ConveractFabricChatDeliveryResult {
  session_id: string;
  message_id: string;
  delivery: ConveractFabricChatDelivery;
  attempts: ConveractFabricChatDeliveryAttempt[];
}

export interface ConveractFabricChatDeliveryAttempt {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  attempt_number: number;
  provider: string;
  status: 'started' | 'delivered' | 'retry_wait' | 'failed' | 'lease_expired';
  provider_message_id: string;
  error_code: string;
  error_message: string;
  started_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
}

export interface ConveractFabricChatPostMessageResult {
  session_id?: string;
  message: ConveractFabricChatMessage;
  policy?: { matched: boolean; events: ConveractFabricPolicyEvent[]; findings?: ConveractFabricPolicyFinding[] };
  delivery?: ConveractFabricChatDelivery;
  quality_review_job?: ConveractFabricQualityReviewJob | null;
}

export interface ConveractFabricChatMessageState {
  session_id: string;
  identity: string;
  unread_count: number;
  receipts: ConveractFabricChatReceipt[];
}

export interface ConveractFabricChatReceiptResult {
  session_id: string;
  message_id: string;
  identity: string;
  receipts: ConveractFabricChatReceipt[];
  unread_count: number;
}

export interface ConveractFabricChatReceiptListResult {
  session_id: string;
  message_id: string;
  receipts: ConveractFabricChatReceipt[];
}

export interface ConveractFabricChatRealtimeResult {
  session_id: string;
  identity?: string;
  state?: ConveractFabricChatRealtimeState;
  states?: ConveractFabricChatRealtimeState[];
}

export interface ConveractFabricChatMutationResult {
  session_id: string;
  message: ConveractFabricChatMessage;
  mutation: ConveractFabricChatMutation | null;
  provider_mutation: ConveractFabricChatProviderMutation;
  quality_review_job: ConveractFabricQualityReviewJob | null;
}

export interface ConveractFabricChatMutationListResult {
  session_id: string;
  message_id: string;
  mutations: ConveractFabricChatMutation[];
}

export interface ConveractFabricChatAttachmentUploadDescriptor {
  secure_file_id?: string;
  kind: ConveractFabricChatAttachmentKind;
  storage_url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum: string;
  processing_status: ConveractFabricChatAttachmentStatus;
  metadata: Record<string, unknown>;
}

export type ConveractFabricSecureFileKind = ConveractFabricChatAttachmentKind;
export type ConveractFabricSecureFileUploadMode = 'single' | 'multipart';
export type ConveractFabricSecureFileStatus =
  | 'initiated'
  | 'uploading'
  | 'scanning'
  | 'processing'
  | 'ready'
  | 'quarantined'
  | 'failed'
  | 'expired';
export type ConveractFabricSecureFileThreatStatus = 'pending' | 'scanning' | 'clean' | 'infected' | 'error';

export interface ConveractFabricSecureFileDerivative {
  kind: 'image_thumbnail' | 'video_thumbnail' | 'video_transcode' | 'audio_transcode';
  status: 'pending' | 'processing' | 'retry_wait' | 'ready' | 'failed' | 'expired';
  mime: string;
  size_bytes: number;
  sha256: string;
  error_code: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ConveractFabricSecureFile {
  file_id: string;
  session_id: string;
  created_by: string;
  kind: ConveractFabricSecureFileKind;
  filename: string;
  extension: string;
  declared_mime: string;
  detected_mime: string;
  mime_conflict: boolean;
  status: ConveractFabricSecureFileStatus;
  threat_status: ConveractFabricSecureFileThreatStatus;
  failure_code: string;
  upload_mode: ConveractFabricSecureFileUploadMode;
  expected_size_bytes: number;
  received_size_bytes: number;
  part_size_bytes: number;
  size_bytes: number;
  sha256: string;
  scan_attempt_count: number;
  retention_until: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  derivatives: ConveractFabricSecureFileDerivative[];
}

export interface ConveractFabricCreateSecureFileInput {
  kind: ConveractFabricSecureFileKind;
  filename: string;
  declared_mime?: string;
  upload_mode: ConveractFabricSecureFileUploadMode;
  expected_size_bytes: number;
  part_size_bytes?: number;
  retention_until?: string | null;
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ConveractFabricSecureFilePart {
  part_number: number;
  size_bytes: number;
  sha256: string;
  status: 'staged' | 'uploaded' | 'committed' | 'aborted';
  created_at: string;
  updated_at: string;
}

export interface ConveractFabricChatAttachmentJob {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  attachment_id: string;
  processor: ConveractFabricChatAttachmentProcessor;
  status: ConveractFabricChatAttachmentJobStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  provider_profile_id: string;
  provider_mode: 'unconfigured' | 'self_hosted' | 'third_party';
  provider_name: string;
  error_code: string;
  error_message: string;
  output_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ConveractFabricChatAttachmentResult {
  attachment?: ConveractFabricChatAttachment;
  attachment_id?: string;
  job: ConveractFabricChatAttachmentJob | null;
  jobs?: ConveractFabricChatAttachmentJob[];
  observations?: ConveractFabricVisualObservation[];
}

export interface ConveractFabricVisualObservation {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  attachment_id: string;
  processor_job_id: string;
  observation_type: 'qr_code' | 'barcode' | 'text_region';
  value_hash: string;
  symbology: string;
  confidence: number | null;
  frame_timestamp_ms: number | null;
  page_number: number | null;
  metadata: Record<string, unknown>;
  detector_version: string;
  created_at: string;
}

export interface ConveractFabricPolicyFindingResult {
  session_id: string;
  finding: ConveractFabricPolicyFinding;
  reviews?: ConveractFabricPolicyFindingReview[];
  review?: ConveractFabricPolicyFindingReview | null;
}

export interface ConveractFabricPolicyFindingListResult {
  session_id: string;
  findings: ConveractFabricPolicyFinding[];
}

export interface ConveractFabricQualityReviewJob {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  input_hash: string;
  status: 'pending' | 'processing' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled';
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

export interface ConveractFabricQualityReviewResult {
  session_id: string;
  message_id: string;
  job: ConveractFabricQualityReviewJob | null;
}

export interface ConveractFabricWorkerRunResult {
  candidates?: number;
  claimed: number;
  succeeded?: number;
  retry_wait?: number;
  failed: number;
  [key: string]: unknown;
}

export interface ConveractFabricOpenChatSessionInput {
  business_ref: ConveractFabricChatBusinessRef;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface ConveractFabricChatParticipantInput {
  identity: string;
  role: string;
  display_name?: string;
  user_ref?: ConveractFabricChatBusinessRef;
}

export interface ConveractFabricChatMessageInput {
  sender_identity: string;
  message_type?: string;
  body?: string;
  original_language?: string;
  metadata?: Record<string, unknown>;
  attachments?: ConveractFabricChatAttachmentUploadDescriptor[];
  reply_to_message_id?: string;
  forwarded_from_message_id?: string;
  mentions?: string[];
}

export interface ConveractFabricChatClientPlanInput extends ConveractFabricChatParticipantInput {}

export interface ConveractFabricChatReceiptInput {
  identity?: string;
  status: 'delivered' | 'read';
  source?: 'ivekit' | 'tinode' | 'system';
  provider_sequence?: number;
  metadata?: Record<string, unknown>;
}

export interface ConveractFabricChatTypingInput {
  identity?: string;
  typing: boolean;
  ttl_ms?: number;
}

export interface ConveractFabricChatPresenceInput {
  identity?: string;
  status: 'online' | 'away' | 'offline';
  ttl_ms?: number;
}

export interface ConveractFabricChatEditInput {
  body: string;
  reason?: string;
}

export interface ConveractFabricChatDeleteInput {
  reason?: string;
}

export interface ConveractFabricPolicyFindingReviewInput {
  review_status: 'confirmed' | 'false_positive' | 'resolved' | 'escalated';
  note?: string;
  metadata?: Record<string, unknown>;
}
