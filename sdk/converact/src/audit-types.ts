export type IveKitAuditActorRole =
  | 'owner' | 'admin' | 'operator' | 'viewer' | 'system' | 'provider';
export type IveKitAuditResult = 'succeeded' | 'failed' | 'denied' | 'accepted';
export type IveKitAuditPolicyDecision = 'allow' | 'deny' | 'not_applicable';

export interface IveKitAuditCapabilities {
  schema_version: number;
  tenant_scoped: boolean;
  immutable: boolean;
  hash_chained: boolean;
  jsonl_export: boolean;
  raw_source_ip_stored: boolean;
}

export interface IveKitAuditEvent {
  id: string;
  tenant_id: string;
  actor_id: string;
  actor_role: IveKitAuditActorRole;
  action: string;
  resource_type: string;
  resource_id: string;
  business_ref_type: string;
  business_ref_id: string;
  request_id: string;
  idempotency_key: string;
  result: IveKitAuditResult;
  policy_decision: IveKitAuditPolicyDecision;
  source_ip_hmac: string;
  metadata: Record<string, unknown>;
  occurred_at: string;
  retention_until: string | null;
  legal_hold: boolean;
  previous_hash: string;
  event_hash: string;
  created_at: string;
}

export interface IveKitAuditListInput {
  limit?: number;
  cursor?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
}

export interface IveKitAuditPage {
  items: IveKitAuditEvent[];
  next_cursor: string | null;
}
