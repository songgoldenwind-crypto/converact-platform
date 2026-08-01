import type { ConveractFabricSdkBusinessRef } from './types.js';

export type ConveractFabricNotificationChannel = 'in_app' | 'webhook' | 'email' | 'sms';
export type ConveractFabricNotificationPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ConveractFabricNotificationInboxAction = 'read' | 'unread' | 'archive' | 'unarchive';

export interface ConveractFabricNotificationCapabilities {
  schema_version: number;
  channels: Record<ConveractFabricNotificationChannel | 'mobile_push', boolean>;
  inbox: boolean;
  templates: boolean;
  preferences: boolean;
  provider_receipts: boolean;
  durable_delivery: boolean;
  administration: boolean;
  delivery_operations: boolean;
  active_health_checks: boolean;
}

export interface ConveractFabricCreateNotificationInput {
  event_type: string;
  recipient: { kind: 'user' | 'external' | 'endpoint'; ref: string };
  targets: Array<{ channel: ConveractFabricNotificationChannel; recipient: string; endpoint_id?: string }>;
  content: unknown;
  content_projection?: Record<string, unknown>;
  priority?: ConveractFabricNotificationPriority;
  force_delivery?: boolean;
  locale?: string;
  template?: { id: string; revision: number };
  business_ref: ConveractFabricSdkBusinessRef;
  correlation_id?: string;
  policy?: Record<string, unknown>;
  scheduled_at?: string;
  retention_until?: string | null;
  max_attempts?: number;
}

export interface ConveractFabricNotification {
  id: string;
  tenant_id: string;
  event_type: string;
  recipient_kind: string;
  recipient_ref: string;
  channels: ConveractFabricNotificationChannel[];
  locale: string;
  template_id: string | null;
  template_revision: number | null;
  content_projection: Record<string, unknown>;
  priority: ConveractFabricNotificationPriority;
  force_delivery: boolean;
  business_ref: ConveractFabricSdkBusinessRef;
  requested_by: string;
  correlation_id: string;
  state: string;
  scheduled_at: string;
  retention_until: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ConveractFabricNotificationDelivery {
  id: string;
  notification_id: string;
  channel: ConveractFabricNotificationChannel;
  endpoint_id: string | null;
  provider_kind: string;
  provider_profile_id: string;
  recipient_redacted: string;
  state: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  provider_request_id: string;
  provider_message_id: string;
  provider_receipt_projection: Record<string, unknown>;
  error_code: string;
  error_projection: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
}

export interface ConveractFabricNotificationCreateResult {
  created: boolean;
  notification: ConveractFabricNotification;
  deliveries: ConveractFabricNotificationDelivery[];
}

export interface ConveractFabricNotificationInboxItem {
  id: string;
  tenant_id: string;
  notification_id: string;
  user_id: string;
  projection: Record<string, unknown>;
  priority: ConveractFabricNotificationPriority;
  read_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConveractFabricNotificationInboxPage {
  items: ConveractFabricNotificationInboxItem[];
  next_cursor: string | null;
}

export interface ConveractFabricNotificationPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ConveractFabricNotificationEndpoint {
  id: string;
  tenant_id: string;
  name: string;
  channel: Exclude<ConveractFabricNotificationChannel, 'in_app'>;
  provider_kind: 'webhook' | 'smtp' | 'email_http' | 'sms_http' | 'controlled';
  status: string;
  endpoint_url: string;
  secret_configured: boolean;
  signing_secret_configured: boolean;
  event_allowlist: string[];
  config: Record<string, unknown>;
  failover_group: string;
  priority: number;
  quota_per_minute: number | null;
  quota_per_day: number | null;
  health_status: string;
  last_health_at: string | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export type ConveractFabricCreateNotificationEndpointInput = Omit<
  ConveractFabricNotificationEndpoint,
  'id' | 'tenant_id' | 'secret_configured' | 'signing_secret_configured' | 'health_status'
  | 'last_health_at' | 'revision' | 'created_by' | 'updated_by' | 'created_at' | 'updated_at'
> & { secret_ref?: string; signing_secret_ref?: string };

export interface ConveractFabricNotificationEndpointListInput {
  channel?: Exclude<ConveractFabricNotificationChannel, 'in_app'>;
  status?: 'active' | 'paused' | 'degraded' | 'disabled' | 'archived';
  limit?: number;
  cursor?: string;
}

export interface ConveractFabricNotificationEndpointTestInput {
  event_type: string;
  recipient: string;
  content: unknown;
  content_projection?: Record<string, unknown>;
  business_ref?: ConveractFabricSdkBusinessRef;
  correlation_id?: string;
}

export interface ConveractFabricNotificationTemplate {
  id: string;
  tenant_id: string;
  template_key: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  draft_revision: number;
  published_revision: number | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ConveractFabricNotificationTemplateVersion {
  tenant_id: string;
  template_id: string;
  revision: number;
  locale: string;
  channels: ConveractFabricNotificationChannel[];
  content: Record<string, unknown>;
  content_hash: string;
  published: boolean;
  created_by: string;
  created_at: string;
  published_at: string | null;
}

export interface ConveractFabricNotificationTemplateSnapshot {
  template: ConveractFabricNotificationTemplate;
  version: ConveractFabricNotificationTemplateVersion;
}

export interface ConveractFabricNotificationTemplateListInput {
  status?: ConveractFabricNotificationTemplate['status'];
  limit?: number;
  cursor?: string;
}

export interface ConveractFabricNotificationTemplateVersionListInput {
  locale?: string;
  limit?: number;
  cursor?: string;
}

export interface ConveractFabricNotificationDeliveryListInput {
  notification_id?: string;
  endpoint_id?: string;
  channel?: ConveractFabricNotificationChannel;
  state?: string;
  limit?: number;
  cursor?: string;
}

export interface ConveractFabricRetryNotificationDeliveryInput {
  expected_state: 'failed' | 'dead_letter' | 'uncertain';
  allow_uncertain?: boolean;
}

export interface ConveractFabricNotificationPreference {
  tenant_id: string;
  user_id: string;
  event_type: string;
  channel: ConveractFabricNotificationChannel;
  enabled: boolean;
  locale: string;
  quiet_hours: Record<string, unknown>;
  revision: number;
  created_at: string;
  updated_at: string;
}
