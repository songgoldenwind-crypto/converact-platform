export type IveKitEventWebhookSubscriptionStatus = 'active' | 'paused' | 'archived';

export interface IveKitEventWebhookSubscription {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  name: string;
  event_patterns: string[];
  status: IveKitEventWebhookSubscriptionStatus;
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

export interface CreateIveKitEventWebhookSubscriptionInput {
  tenant_id: string;
  actor: string;
  endpoint_id: string;
  name: string;
  event_patterns: readonly string[];
  idempotency_key: string;
}

export interface IveKitEventWebhookSubscriptionCreateResult {
  subscription: IveKitEventWebhookSubscription;
  created: boolean;
}

export interface IveKitEventWebhookSubscriptionPage {
  items: IveKitEventWebhookSubscription[];
  next_cursor: string | null;
}

export interface UpdateIveKitEventWebhookSubscriptionInput {
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

export interface IveKitIntegrationEventEnvelope<T = unknown> {
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

export interface IveKitWebhookDeliveryEnvelope<T = unknown> {
  id: string;
  event: string;
  tenant_id: string;
  timestamp: string;
  business_ref: { type: string; id: string };
  data: IveKitIntegrationEventEnvelope<T>;
}

export interface IveKitStoredIntegrationEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  visibility_scope: IveKitIntegrationEventEnvelope['visibility']['scope'];
  visibility_ref_id: string;
  audience_user_ids: string[];
  payload: unknown;
  occurred_at: string;
  expires_at: string;
}
