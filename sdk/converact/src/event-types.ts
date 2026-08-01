export type ConveractFabricEventVisibilityScope =
  | 'tenant'
  | 'chat_session'
  | 'media_call'
  | 'remote_session';

export type ConveractFabricEventSnapshotReason =
  | 'invalid_cursor'
  | 'cursor_tenant_mismatch'
  | 'cursor_expired';

export interface ConveractFabricEvent<T = unknown> {
  event_id: string;
  cursor: string;
  tenant_id: string;
  type: string;
  data: T;
  timestamp: string;
  expires_at: string;
  visibility_scope: ConveractFabricEventVisibilityScope;
  visibility_ref_id: string;
  audience_user_ids: string[];
}

export interface ConveractFabricEventPage<T = unknown> {
  items: ConveractFabricEvent<T>[];
  next_cursor: string;
  has_more: boolean;
  snapshot_required: boolean;
  reason?: ConveractFabricEventSnapshotReason;
}

export interface ConveractFabricEventPageInput {
  cursor: string;
  limit?: number;
}

export interface ConveractFabricEventReplayInput extends ConveractFabricEventPageInput {
  max_pages?: number;
}

export interface ConveractFabricEventReplayResult<T = unknown> extends ConveractFabricEventPage<T> {
  pages: number;
}

export interface ConveractFabricIntegrationEventFamily {
  id: 'chat' | 'file' | 'intelligence' | 'media' | 'notification' | 'provider' | 'remote' | 'voice';
  patterns: string[];
}

export interface ConveractFabricIntegrationEventCatalog {
  schema_version: 1;
  envelope_schema_version: 1;
  webhook_signature_version: 'v1';
  pattern_syntax: 'exact_or_trailing_wildcard';
  compatibility: 'additive';
  max_payload_bytes: number;
  families: ConveractFabricIntegrationEventFamily[];
}

export interface ConveractFabricIntegrationEventEnvelope<T = unknown> {
  schema_version: 1;
  event_id: string;
  event_type: string;
  tenant_id: string;
  occurred_at: string;
  business_ref: { type: string; id: string } | null;
  visibility: {
    scope: ConveractFabricEventVisibilityScope;
    ref_id: string;
    audience_user_ids: string[];
  };
  data: T;
}

export interface ConveractFabricWebhookDeliveryEnvelope<T = unknown> {
  id: string;
  event: string;
  tenant_id: string;
  timestamp: string;
  business_ref: { type: string; id: string };
  data: ConveractFabricIntegrationEventEnvelope<T>;
}

export type ConveractFabricEventWebhookSubscriptionStatus = 'active' | 'paused' | 'archived';

export interface ConveractFabricEventWebhookSubscription {
  id: string;
  endpoint_id: string;
  name: string;
  event_patterns: string[];
  status: ConveractFabricEventWebhookSubscriptionStatus;
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

export interface ConveractFabricEventWebhookSubscriptionPage {
  items: ConveractFabricEventWebhookSubscription[];
  next_cursor: string | null;
}

export interface ConveractFabricCreateEventWebhookSubscriptionInput {
  endpoint_id: string;
  name: string;
  event_patterns: string[];
}

export interface ConveractFabricUpdateEventWebhookSubscriptionInput {
  expected_revision: number;
  name?: string;
  event_patterns?: string[];
  status?: 'active' | 'paused';
}
