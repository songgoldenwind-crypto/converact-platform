export type IveKitAuditActorRole =
  | 'owner' | 'admin' | 'operator' | 'viewer' | 'system' | 'provider';
export type IveKitAuditResult = 'succeeded' | 'failed' | 'denied' | 'accepted';
export type IveKitAuditPolicyDecision = 'allow' | 'deny' | 'not_applicable';

export interface IveKitAuditBusinessRef {
  type: string;
  id: string;
}

export interface IveKitAuditRequest {
  tenant_id: string;
  actor_id: string;
  actor_role: IveKitAuditActorRole;
  action: string;
  resource_type: string;
  resource_id: string;
  business_ref: IveKitAuditBusinessRef;
  request_id: string;
  result: IveKitAuditResult;
  policy_decision: IveKitAuditPolicyDecision;
  source_ip?: string;
  metadata?: Readonly<Record<string, unknown>>;
  idempotency_key: string;
  occurred_at?: string;
  retention_until?: string | null;
  legal_hold?: boolean;
}

export interface IveKitAuditAppendInput {
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
  metadata: Readonly<Record<string, unknown>>;
  occurred_at: string;
  retention_until: string | null;
  legal_hold: boolean;
}

export interface IveKitAuditEvent extends IveKitAuditAppendInput {
  id: string;
  previous_hash: string;
  event_hash: string;
  created_at: string;
}

export interface IveKitAuditAppendResult {
  event: IveKitAuditEvent;
  created: boolean;
}

export interface IveKitAuditListInput {
  tenant_id: string;
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
