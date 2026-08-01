export type ConveractFabricEventWebhookSubscriptionStatus = 'active' | 'paused' | 'archived';

export interface ConveractFabricEventWebhookSubscription {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  name: string;
  event_patterns: string[];
  status: ConveractFabricEventWebhookSubscriptionStatus;
  last_event_id: string;
  next_attempt_at: string;
  attempt_count: number;
  error_code: string;
  lease_token_hash: string;
  lease_until: string | null;
  worker_id: string;
  revision: number;
  idempotency_key: string;
  payload_hash: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateConveractFabricEventWebhookSubscriptionInput {
  tenant_id: string;
  actor: string;
  endpoint_id: string;
  name: string;
  event_patterns: readonly string[];
  idempotency_key: string;
}

export interface ConveractFabricEventWebhookSubscriptionCreateResult {
  subscription: ConveractFabricEventWebhookSubscription;
  created: boolean;
}

export interface ConveractFabricEventWebhookSubscriptionPage {
  items: ConveractFabricEventWebhookSubscription[];
  next_cursor: string | null;
}

export interface UpdateConveractFabricEventWebhookSubscriptionInput {
  tenant_id: string;
  actor: string;
  subscription_id: string;
  expected_revision: number;
  patch: {
    name?: string;
    event_patterns?: readonly string[];
    status?: 'active' | 'paused';
  };
}

export interface ConveractFabricIntegrationEventEnvelope<T = unknown> {
  schema_version: 1;
  event_id: string;
  event_type: string;
  tenant_id: string;
  occurred_at: string;
  business_ref: { type: string; id: string } | null;
  visibility: {
    scope: 'tenant' | 'chat_session' | 'media_call' | 'remote_session';
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

export interface ConveractFabricStoredIntegrationEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  visibility_scope: ConveractFabricIntegrationEventEnvelope['visibility']['scope'];
  visibility_ref_id: string;
  audience_user_ids: string[];
  payload: unknown;
  occurred_at: string;
  expires_at: string;
}
