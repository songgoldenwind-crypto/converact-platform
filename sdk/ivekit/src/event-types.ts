export type IveKitEventVisibilityScope =
  | 'tenant'
  | 'chat_session'
  | 'media_call'
  | 'remote_session';

export type IveKitEventSnapshotReason =
  | 'invalid_cursor'
  | 'cursor_tenant_mismatch'
  | 'cursor_expired';

export interface IveKitEvent<T = unknown> {
  event_id: string;
  cursor: string;
  tenant_id: string;
  type: string;
  data: T;
  timestamp: string;
  expires_at: string;
  visibility_scope: IveKitEventVisibilityScope;
  visibility_ref_id: string;
  audience_user_ids: string[];
}

export interface IveKitEventPage<T = unknown> {
  items: IveKitEvent<T>[];
  next_cursor: string;
  has_more: boolean;
  snapshot_required: boolean;
  reason?: IveKitEventSnapshotReason;
}

export interface IveKitEventPageInput {
  cursor: string;
  limit?: number;
}

export interface IveKitEventReplayInput extends IveKitEventPageInput {
  max_pages?: number;
}

export interface IveKitEventReplayResult<T = unknown> extends IveKitEventPage<T> {
  pages: number;
}

export interface IveKitIntegrationEventFamily {
  id: 'chat' | 'file' | 'intelligence' | 'media' | 'notification' | 'provider' | 'remote' | 'voice';
  patterns: string[];
}

export interface IveKitIntegrationEventCatalog {
  schema_version: 1;
  envelope_schema_version: 1;
  webhook_signature_version: 'v1';
  pattern_syntax: 'exact_or_trailing_wildcard';
  compatibility: 'additive';
  max_payload_bytes: number;
  families: IveKitIntegrationEventFamily[];
}

export interface IveKitIntegrationEventEnvelope<T = unknown> {
  schema_version: 1;
  event_id: string;
  event_type: string;
  tenant_id: string;
  occurred_at: string;
  business_ref: { type: string; id: string } | null;
  visibility: {
    scope: IveKitEventVisibilityScope;
    ref_id: string;
    audience_user_ids: string[];
  };
  data: T;
}

export interface IveKitWebhookDeliveryEnvelope<T = unknown> {
  id: string;
  event: string;
  tenant_id: string;
  timestamp: string;
  business_ref: { type: string; id: string };
  data: IveKitIntegrationEventEnvelope<T>;
}

export type IveKitEventWebhookSubscriptionStatus = 'active' | 'paused' | 'archived';

export interface IveKitEventWebhookSubscription {
  id: string;
  endpoint_id: string;
  name: string;
  event_patterns: string[];
  status: IveKitEventWebhookSubscriptionStatus;
  last_event_id: string;
  next_attempt_at: string;
  attempt_count: number;
  error_code: string;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface IveKitEventWebhookSubscriptionPage {
  items: IveKitEventWebhookSubscription[];
  next_cursor: string | null;
}

export interface IveKitCreateEventWebhookSubscriptionInput {
  endpoint_id: string;
  name: string;
  event_patterns: string[];
}

export interface IveKitUpdateEventWebhookSubscriptionInput {
  expected_revision: number;
  name?: string;
  event_patterns?: string[];
  status?: 'active' | 'paused';
}
