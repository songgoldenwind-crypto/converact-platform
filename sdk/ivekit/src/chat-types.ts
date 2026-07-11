export interface IveKitChatBusinessRef {
  tenant_id?: string;
  type: string;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export interface IveKitChatSession {
  id: string;
  tenant_id: string;
  business_ref_type: string;
  business_ref_id: string;
  business_ref: IveKitChatBusinessRef;
  title: string;
  status: 'open' | 'closed';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  summary?: IveKitChatSessionSummary;
}

export interface IveKitChatSessionSummary {
  unread_count: number;
  online_participant_count: number;
  last_message: {
    id: string;
    body: string;
    sender_identity: string;
    message_type: IveKitChatMessage['message_type'];
    created_at: string;
    deleted: boolean;
  } | null;
}

export interface IveKitChatBinding {
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

export interface IveKitChatParticipant {
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

export type IveKitChatAttachmentKind = 'image' | 'video' | 'audio' | 'file' | 'screen_recording';
export type IveKitChatAttachmentStatus = 'pending' | 'ready' | 'failed';
export type IveKitChatAttachmentProcessor = 'ocr' | 'asr';
export type IveKitChatAttachmentJobStatus =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type IveKitAttachmentTransferPhase =
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

export interface IveKitChatAttachment {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  kind: IveKitChatAttachmentKind;
  storage_url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum: string;
  processing_status: IveKitChatAttachmentStatus;
  ocr_text: string;
  asr_text: string;
  extracted_text: string;
  processing_error_code: string;
  processed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type IveKitChatDeliveryStatus =
  | 'not_required'
  | 'pending'
  | 'publishing'
  | 'retry_wait'
  | 'delivered'
  | 'failed';

export interface IveKitChatDelivery {
  provider: string;
  provider_topic_id: string;
  provider_message_id: string;
  status: IveKitChatDeliveryStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  last_error_code: string;
  last_error_message: string;
  delivered_at: string | null;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface IveKitChatMessage {
  id: string;
  tenant_id: string;
  session_id: string;
  sender_identity: string;
  message_type: 'text' | 'image' | 'video' | 'file' | 'system';
  body: string;
  original_language: string;
  metadata: Record<string, unknown>;
  attachments: IveKitChatAttachment[];
  idempotency_key: string;
  provider_delivery: IveKitChatDelivery;
  edit_version: number;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string;
  created_at: string;
  reply_to_message_id: string | null;
  forwarded_from_message_id: string | null;
  mentions: string[];
  reactions?: IveKitChatReaction[];
  pinned?: boolean;
}

export interface IveKitChatReceipt {
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

export interface IveKitChatRealtimeState {
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

export interface IveKitChatMutation {
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

export interface IveKitPolicyEvent {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  policy_type: string;
  severity: 'low' | 'medium' | 'high';
  matched_text_hash: string;
  action: string;
  source: 'text' | 'ocr' | 'asr' | 'ai';
  source_ref_id: string;
  attachment_id: string;
  finding_id: string;
  created_at: string;
}

export interface IveKitPolicyFinding {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  source: 'text' | 'ocr' | 'asr' | 'ai';
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
  reviewed_by: string;
  reviewed_at: string | null;
  review_note: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface IveKitPolicyFindingReview {
  id: string;
  tenant_id: string;
  finding_id: string;
  from_status: IveKitPolicyFinding['review_status'];
  to_status: IveKitPolicyFinding['review_status'];
  reviewed_by: string;
  note: string;
  note_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface IveKitChatReaction {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  identity: string;
  emoji: string;
  created_at: string;
}

export interface IveKitChatPin {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  pinned_by: string;
  created_at: string;
}

export interface IveKitChatReactionResult {
  session_id: string;
  message_id: string;
  reactions: IveKitChatReaction[];
  counts: Record<string, number>;
}

export interface IveKitChatPinResult {
  session_id: string;
  message_id?: string;
  pins: IveKitChatPin[];
}

export interface IveKitCursorPage<T = unknown> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface IveKitChatSessionListInput {
  status?: 'open' | 'closed';
  business_ref_type?: string;
  business_ref_id?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface IveKitChatMessagePageInput {
  direction?: 'before' | 'after';
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface IveKitChatClientPlan {
  provider: 'tinode' | 'local' | string;
  provider_topic_id: string;
  provider_user_id: string;
  auth_token: string;
  ws_url: string;
  api_key: string;
  participant: IveKitChatParticipant;
}

export interface IveKitChatSnapshot {
  session: IveKitChatSession;
  binding: IveKitChatBinding | null;
  participants: IveKitChatParticipant[];
  messages: IveKitChatMessage[];
  policy_events: IveKitPolicyEvent[];
  policy_findings: IveKitPolicyFinding[];
}

export interface IveKitChatCapabilities {
  provider: string;
  tenant_id: string;
  capabilities: Record<string, boolean>;
  config: Record<string, unknown>;
  delivery_policy: Record<string, unknown>;
}

export interface IveKitChatDeliveryResult {
  session_id: string;
  message_id: string;
  delivery: IveKitChatDelivery;
  attempts: IveKitChatDeliveryAttempt[];
}

export interface IveKitChatDeliveryAttempt {
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

export interface IveKitChatPostMessageResult {
  session_id?: string;
  message: IveKitChatMessage;
  policy?: { matched: boolean; events: IveKitPolicyEvent[]; findings?: IveKitPolicyFinding[] };
  delivery?: IveKitChatDelivery;
  quality_review_job?: IveKitQualityReviewJob | null;
}

export interface IveKitChatMessageState {
  session_id: string;
  identity: string;
  unread_count: number;
  receipts: IveKitChatReceipt[];
}

export interface IveKitChatReceiptResult {
  session_id: string;
  message_id: string;
  identity: string;
  receipts: IveKitChatReceipt[];
  unread_count: number;
}

export interface IveKitChatReceiptListResult {
  session_id: string;
  message_id: string;
  receipts: IveKitChatReceipt[];
}

export interface IveKitChatRealtimeResult {
  session_id: string;
  identity?: string;
  state?: IveKitChatRealtimeState;
  states?: IveKitChatRealtimeState[];
}

export interface IveKitChatMutationResult {
  session_id: string;
  message: IveKitChatMessage;
  mutation: IveKitChatMutation | null;
  quality_review_job: IveKitQualityReviewJob | null;
}

export interface IveKitChatMutationListResult {
  session_id: string;
  message_id: string;
  mutations: IveKitChatMutation[];
}

export interface IveKitChatAttachmentUploadDescriptor {
  kind: IveKitChatAttachmentKind;
  storage_url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum: string;
  processing_status: IveKitChatAttachmentStatus;
  metadata: Record<string, unknown>;
}

export interface IveKitChatAttachmentJob {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  attachment_id: string;
  processor: IveKitChatAttachmentProcessor;
  status: IveKitChatAttachmentJobStatus;
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

export interface IveKitChatAttachmentResult {
  attachment?: IveKitChatAttachment;
  attachment_id?: string;
  job: IveKitChatAttachmentJob | null;
}

export interface IveKitPolicyFindingResult {
  session_id: string;
  finding: IveKitPolicyFinding;
  reviews?: IveKitPolicyFindingReview[];
  review?: IveKitPolicyFindingReview | null;
}

export interface IveKitPolicyFindingListResult {
  session_id: string;
  findings: IveKitPolicyFinding[];
}

export interface IveKitQualityReviewJob {
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

export interface IveKitQualityReviewResult {
  session_id: string;
  message_id: string;
  job: IveKitQualityReviewJob | null;
}

export interface IveKitWorkerRunResult {
  candidates?: number;
  claimed: number;
  succeeded?: number;
  retry_wait?: number;
  failed: number;
  [key: string]: unknown;
}

export interface IveKitOpenChatSessionInput {
  business_ref: IveKitChatBusinessRef;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface IveKitChatParticipantInput {
  identity: string;
  role: string;
  display_name?: string;
  user_ref?: IveKitChatBusinessRef;
}

export interface IveKitChatMessageInput {
  sender_identity: string;
  message_type?: string;
  body?: string;
  original_language?: string;
  metadata?: Record<string, unknown>;
  attachments?: IveKitChatAttachmentUploadDescriptor[];
  reply_to_message_id?: string;
  forwarded_from_message_id?: string;
  mentions?: string[];
}

export interface IveKitChatClientPlanInput extends IveKitChatParticipantInput {}

export interface IveKitChatReceiptInput {
  identity?: string;
  status: 'delivered' | 'read';
  source?: 'ivekit' | 'tinode' | 'system';
  provider_sequence?: number;
  metadata?: Record<string, unknown>;
}

export interface IveKitChatTypingInput {
  identity?: string;
  typing: boolean;
  ttl_ms?: number;
}

export interface IveKitChatPresenceInput {
  identity?: string;
  status: 'online' | 'away' | 'offline';
  ttl_ms?: number;
}

export interface IveKitChatEditInput {
  body: string;
  reason?: string;
}

export interface IveKitChatDeleteInput {
  reason?: string;
}

export interface IveKitPolicyFindingReviewInput {
  review_status: 'confirmed' | 'false_positive' | 'resolved' | 'escalated';
  note?: string;
  metadata?: Record<string, unknown>;
}
