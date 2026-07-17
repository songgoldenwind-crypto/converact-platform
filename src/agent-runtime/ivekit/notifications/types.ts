export type NotificationChannel = 'in_app' | 'webhook' | 'email' | 'sms';

export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';
export type NotificationRecipientKind = 'user' | 'external' | 'endpoint';
export type NotificationState =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'partial_failed'
  | 'failed'
  | 'cancelled';

export type NotificationEndpointChannel = Exclude<NotificationChannel, 'in_app'>;
export type NotificationEndpointProviderKind =
  | 'webhook'
  | 'smtp'
  | 'email_http'
  | 'sms_http'
  | 'controlled';
export type NotificationEndpointStatus = 'active' | 'paused' | 'degraded' | 'disabled' | 'archived';
export type NotificationEndpointHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';
export type NotificationTemplateStatus = 'draft' | 'published' | 'archived';

export type NotificationDeliveryState =
  | 'pending'
  | 'processing'
  | 'accepted'
  | 'retry_wait'
  | 'uncertain'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'dead_letter';

export type NotificationDeliveryTransition =
  | 'claim'
  | 'accept'
  | 'deliver'
  | 'retry'
  | 'mark_uncertain'
  | 'fail'
  | 'cancel'
  | 'dead_letter'
  | 'reconcile_delivered'
  | 'reconcile_failed';

export type NotificationErrorCode =
  | 'invalid_delivery_transition'
  | 'terminal_delivery_state'
  | 'validation_failed'
  | 'not_found'
  | 'idempotency_conflict'
  | 'revision_conflict'
  | 'lease_lost'
  | 'provider_auth_failed'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_result_unknown'
  | 'provider_rejected'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'compliance_denied'
  | 'secret_ref_invalid'
  | 'secret_unavailable';

export interface NotificationBusinessRef {
  type: string;
  id: string;
}

export interface NotificationRecord {
  id: string;
  tenant_id: string;
  event_type: string;
  recipient_kind: NotificationRecipientKind;
  recipient_ref: string;
  channels: NotificationChannel[];
  locale: string;
  template_id: string | null;
  template_revision: number | null;
  content_ciphertext: string;
  content_projection: Readonly<Record<string, unknown>>;
  priority: NotificationPriority;
  force_delivery: boolean;
  business_ref_type: string;
  business_ref_id: string;
  requested_by: string;
  correlation_id: string;
  idempotency_key: string;
  payload_hash: string;
  policy: Readonly<Record<string, unknown>>;
  state: NotificationState;
  scheduled_at: string;
  retention_until: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface NotificationDeliveryRecord {
  id: string;
  tenant_id: string;
  notification_id: string;
  channel: NotificationChannel;
  endpoint_id: string | null;
  provider_kind: string;
  provider_profile_id: string;
  recipient_ciphertext: string;
  recipient_hmac: string;
  recipient_redacted: string;
  payload_ciphertext: string;
  payload_hash: string;
  provider_idempotency_key: string;
  state: NotificationDeliveryState;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_token_hash: string;
  lease_until: string | null;
  worker_id: string;
  provider_request_id: string;
  provider_message_id: string;
  provider_receipt_projection: Readonly<Record<string, unknown>>;
  error_code: string;
  error_projection: Readonly<Record<string, unknown>>;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
}

export interface NotificationTargetInput {
  channel: NotificationChannel;
  recipient: string;
  endpoint_id?: string;
}

export interface CreateNotificationInput {
  tenant_id: string;
  event_type: string;
  recipient: { kind: NotificationRecipientKind; ref: string };
  targets: readonly NotificationTargetInput[];
  content: unknown;
  content_projection?: Readonly<Record<string, unknown>>;
  priority?: NotificationPriority;
  force_delivery?: boolean;
  locale?: string;
  template?: { id: string; revision: number };
  business_ref: NotificationBusinessRef;
  requested_by: string;
  correlation_id?: string;
  idempotency_key: string;
  policy?: Readonly<Record<string, unknown>>;
  scheduled_at?: string;
  retention_until?: string | null;
  max_attempts?: number;
}

export interface CreateNotificationRecord {
  notification: NotificationRecord;
  deliveries: NotificationDeliveryRecord[];
}

export interface NotificationCreateResult extends CreateNotificationRecord {
  created: boolean;
}

export interface NotificationDeliveryClaimInput {
  tenant_id: string;
  worker_id: string;
  now: Date;
  lease_ms: number;
  limit: number;
  lease_token_hash: string;
  shard_ids?: readonly number[];
}

export interface NotificationDeliveryFinishInput {
  tenant_id: string;
  delivery_id: string;
  worker_id: string;
  state: 'accepted' | 'delivered' | 'retry_wait' | 'uncertain' | 'failed' | 'dead_letter';
  now: Date;
  next_attempt_at?: Date | null;
  provider_kind?: string;
  provider_profile_id?: string;
  provider_request_id?: string;
  provider_message_id?: string;
  receipt_projection?: Readonly<Record<string, unknown>>;
  error_code?: string;
  error_projection?: Readonly<Record<string, unknown>>;
}

export interface NotificationInboxItem {
  id: string;
  tenant_id: string;
  notification_id: string;
  user_id: string;
  projection: Readonly<Record<string, unknown>>;
  priority: NotificationPriority;
  read_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface NotificationEndpointListInput {
  tenant_id: string;
  channel?: NotificationEndpointChannel;
  status?: NotificationEndpointStatus;
  limit?: number;
  cursor?: string;
}

export interface NotificationTemplateListInput {
  tenant_id: string;
  status?: NotificationTemplateStatus;
  limit?: number;
  cursor?: string;
}

export interface NotificationTemplateVersionListInput {
  tenant_id: string;
  template_id: string;
  locale?: string;
  limit?: number;
  cursor?: string;
}

export interface NotificationDeliveryListInput {
  tenant_id: string;
  notification_id?: string;
  endpoint_id?: string;
  channel?: NotificationChannel;
  state?: NotificationDeliveryState;
  limit?: number;
  cursor?: string;
}

export interface RetryNotificationDeliveryInput {
  tenant_id: string;
  delivery_id: string;
  actor: string;
  expected_state: 'failed' | 'dead_letter' | 'uncertain';
  allow_uncertain: boolean;
  operation_id: string;
  now: Date;
}

export interface ArchiveNotificationTemplateInput {
  tenant_id: string;
  template_id: string;
  actor: string;
  expected_revision: number;
}

export interface NotificationInboxListInput {
  tenant_id: string;
  user_id: string;
  limit?: number;
  cursor?: string;
  include_archived?: boolean;
}

export type NotificationInboxAction = 'read' | 'unread' | 'archive' | 'unarchive';

export interface NotificationInboxMutationInput {
  tenant_id: string;
  user_id: string;
  item_id: string;
  action: NotificationInboxAction;
  now: Date;
}

export interface NotificationEndpoint {
  id: string;
  tenant_id: string;
  name: string;
  channel: NotificationEndpointChannel;
  provider_kind: NotificationEndpointProviderKind;
  status: NotificationEndpointStatus;
  endpoint_url: string;
  secret_ref: string;
  signing_secret_ref: string;
  event_allowlist: string[];
  config: Readonly<Record<string, unknown>>;
  failover_group: string;
  priority: number;
  quota_per_minute: number | null;
  quota_per_day: number | null;
  health_status: NotificationEndpointHealth;
  last_health_at: string | null;
  revision: number;
  idempotency_key: string;
  payload_hash: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationEndpointCreateResult {
  endpoint: NotificationEndpoint;
  created: boolean;
}

export interface CreateNotificationEndpointInput {
  tenant_id: string;
  actor: string;
  name: string;
  channel: NotificationEndpointChannel;
  provider_kind: NotificationEndpointProviderKind;
  status?: NotificationEndpointStatus;
  endpoint_url?: string;
  secret_ref?: string;
  signing_secret_ref?: string;
  event_allowlist?: readonly string[];
  config?: Readonly<Record<string, unknown>>;
  failover_group?: string;
  priority?: number;
  quota_per_minute?: number | null;
  quota_per_day?: number | null;
  idempotency_key: string;
}

export type NotificationEndpointPatch = Partial<Pick<NotificationEndpoint,
  'name' | 'status' | 'endpoint_url' | 'secret_ref' | 'signing_secret_ref'
  | 'event_allowlist' | 'config' | 'failover_group' | 'priority'
  | 'quota_per_minute' | 'quota_per_day'>>;

export interface UpdateNotificationEndpointInput {
  tenant_id: string;
  endpoint_id: string;
  actor: string;
  expected_revision: number;
  patch: NotificationEndpointPatch;
}

export interface NotificationTemplate {
  id: string;
  tenant_id: string;
  template_key: string;
  description: string;
  status: NotificationTemplateStatus;
  draft_revision: number;
  published_revision: number | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationTemplateVersion {
  tenant_id: string;
  template_id: string;
  revision: number;
  locale: string;
  channels: NotificationChannel[];
  content: Readonly<Record<string, unknown>>;
  content_hash: string;
  published: boolean;
  created_by: string;
  created_at: string;
  published_at: string | null;
}

export interface NotificationTemplateSnapshot {
  template: NotificationTemplate;
  version: NotificationTemplateVersion;
}

export interface CreateNotificationTemplateInput {
  tenant_id: string;
  actor: string;
  template_key: string;
  description?: string;
  locale: string;
  channels: readonly NotificationChannel[];
  content: Readonly<Record<string, unknown>>;
}

export interface UpdateNotificationTemplateInput {
  tenant_id: string;
  actor: string;
  template_id: string;
  expected_revision: number;
  locale: string;
  channels: readonly NotificationChannel[];
  content: Readonly<Record<string, unknown>>;
  description?: string;
}

export interface PublishNotificationTemplateInput {
  tenant_id: string;
  actor: string;
  template_id: string;
  expected_revision: number;
  locale: string;
}

export interface NotificationPreference {
  tenant_id: string;
  user_id: string;
  event_type: string;
  channel: NotificationChannel;
  enabled: boolean;
  locale: string;
  quiet_hours: Readonly<Record<string, unknown>>;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface PutNotificationPreferenceInput {
  tenant_id: string;
  user_id: string;
  event_type: string;
  channel: NotificationChannel;
  enabled: boolean;
  locale?: string;
  quiet_hours?: Readonly<Record<string, unknown>>;
  expected_revision: number;
}

export type NotificationReceiptStatus = 'accepted' | 'delivered' | 'failed' | 'unknown';
export type NotificationReceiptReconciliation = 'delivered' | 'failed' | 'pending' | 'unchanged';

export interface NotificationReceipt {
  id: string;
  tenant_id: string;
  delivery_id: string;
  provider_kind: string;
  provider_event_id: string;
  receipt_status: NotificationReceiptStatus;
  canonical_hash: string;
  projection: Readonly<Record<string, unknown>>;
  occurred_at: string | null;
  received_at: string;
}

export interface NotificationReceiptPayload {
  provider_event_id: string;
  delivery_id: string;
  status: NotificationReceiptStatus;
  occurred_at?: string;
  projection?: Readonly<Record<string, unknown>>;
}

export interface ReceiveNotificationReceiptInput {
  tenant_id: string;
  endpoint_id: string;
  timestamp: string;
  signature: string;
  body: NotificationReceiptPayload;
}

export interface NotificationReceiptResult {
  receipt: NotificationReceipt;
  created: boolean;
  reconciliation: NotificationReceiptReconciliation;
}

export type NotificationEndpointReservationReason = 'quota_exhausted' | 'circuit_open';
export type NotificationEndpointResultOutcome = 'success' | 'failure';

export interface NotificationEndpointReservation {
  allowed: boolean;
  reason: NotificationEndpointReservationReason | null;
  retry_at: string | null;
}

export interface ReserveNotificationEndpointInput {
  endpoint: NotificationEndpoint;
  now: Date;
}

export interface RecordNotificationEndpointResultInput {
  endpoint: NotificationEndpoint;
  outcome: NotificationEndpointResultOutcome;
  now: Date;
}

export interface NotificationQueueMetric {
  state: NotificationDeliveryState;
  depth: number;
  oldest_age_seconds: number;
}
