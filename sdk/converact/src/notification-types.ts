import type { IveKitSdkBusinessRef } from './types.js';

export type IveKitNotificationChannel = 'in_app' | 'webhook' | 'email' | 'sms';
export type IveKitNotificationPriority = 'low' | 'normal' | 'high' | 'urgent';
export type IveKitNotificationInboxAction = 'read' | 'unread' | 'archive' | 'unarchive';

export interface IveKitNotificationCapabilities {
  schema_version: number;
  channels: Record<IveKitNotificationChannel | 'mobile_push', boolean>;
  inbox: boolean;
  templates: boolean;
  preferences: boolean;
  provider_receipts: boolean;
  durable_delivery: boolean;
  administration: boolean;
  delivery_operations: boolean;
  active_health_checks: boolean;
}

export interface IveKitCreateNotificationInput {
  event_type: string;
  recipient: { kind: 'user' | 'external' | 'endpoint'; ref: string };
  targets: Array<{ channel: IveKitNotificationChannel; recipient: string; endpoint_id?: string }>;
  content: unknown;
  content_projection?: Record<string, unknown>;
  priority?: IveKitNotificationPriority;
  force_delivery?: boolean;
  locale?: string;
  template?: { id: string; revision: number };
  business_ref: IveKitSdkBusinessRef;
  correlation_id?: string;
  policy?: Record<string, unknown>;
  scheduled_at?: string;
  retention_until?: string | null;
  max_attempts?: number;
}

export interface IveKitNotification {
  id: string;
  tenant_id: string;
  event_type: string;
  recipient_kind: string;
  recipient_ref: string;
  channels: IveKitNotificationChannel[];
  locale: string;
  template_id: string | null;
  template_revision: number | null;
  content_projection: Record<string, unknown>;
  priority: IveKitNotificationPriority;
  force_delivery: boolean;
  business_ref: IveKitSdkBusinessRef;
  requested_by: string;
  correlation_id: string;
  state: string;
  scheduled_at: string;
  retention_until: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface IveKitNotificationDelivery {
  id: string;
  notification_id: string;
  channel: IveKitNotificationChannel;
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

export interface IveKitNotificationCreateResult {
  created: boolean;
  notification: IveKitNotification;
  deliveries: IveKitNotificationDelivery[];
}

export interface IveKitNotificationInboxItem {
  id: string;
  tenant_id: string;
  notification_id: string;
  user_id: string;
  projection: Record<string, unknown>;
  priority: IveKitNotificationPriority;
  read_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IveKitNotificationInboxPage {
  items: IveKitNotificationInboxItem[];
  next_cursor: string | null;
}

export interface IveKitNotificationPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface IveKitNotificationEndpoint {
  id: string;
  tenant_id: string;
  name: string;
  channel: Exclude<IveKitNotificationChannel, 'in_app'>;
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

export type IveKitCreateNotificationEndpointInput = Omit<
  IveKitNotificationEndpoint,
  'id' | 'tenant_id' | 'secret_configured' | 'signing_secret_configured' | 'health_status'
  | 'last_health_at' | 'revision' | 'created_by' | 'updated_by' | 'created_at' | 'updated_at'
> & { secret_ref?: string; signing_secret_ref?: string };

export interface IveKitNotificationEndpointListInput {
  channel?: Exclude<IveKitNotificationChannel, 'in_app'>;
  status?: 'active' | 'paused' | 'degraded' | 'disabled' | 'archived';
  limit?: number;
  cursor?: string;
}

export interface IveKitNotificationEndpointTestInput {
  event_type: string;
  recipient: string;
  content: unknown;
  content_projection?: Record<string, unknown>;
  business_ref?: IveKitSdkBusinessRef;
  correlation_id?: string;
}

export interface IveKitNotificationTemplate {
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

export interface IveKitNotificationTemplateVersion {
  tenant_id: string;
  template_id: string;
  revision: number;
  locale: string;
  channels: IveKitNotificationChannel[];
  content: Record<string, unknown>;
  content_hash: string;
  published: boolean;
  created_by: string;
  created_at: string;
  published_at: string | null;
}

export interface IveKitNotificationTemplateSnapshot {
  template: IveKitNotificationTemplate;
  version: IveKitNotificationTemplateVersion;
}

export interface IveKitNotificationTemplateListInput {
  status?: IveKitNotificationTemplate['status'];
  limit?: number;
  cursor?: string;
}

export interface IveKitNotificationTemplateVersionListInput {
  locale?: string;
  limit?: number;
  cursor?: string;
}

export interface IveKitNotificationDeliveryListInput {
  notification_id?: string;
  endpoint_id?: string;
  channel?: IveKitNotificationChannel;
  state?: string;
  limit?: number;
  cursor?: string;
}

export interface IveKitRetryNotificationDeliveryInput {
  expected_state: 'failed' | 'dead_letter' | 'uncertain';
  allow_uncertain?: boolean;
}

export interface IveKitNotificationPreference {
  tenant_id: string;
  user_id: string;
  event_type: string;
  channel: IveKitNotificationChannel;
  enabled: boolean;
  locale: string;
  quiet_hours: Record<string, unknown>;
  revision: number;
  created_at: string;
  updated_at: string;
}
