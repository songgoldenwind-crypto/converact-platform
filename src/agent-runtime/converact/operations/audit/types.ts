export type ConveractFabricAuditActorRole =
  | 'owner' | 'admin' | 'operator' | 'viewer' | 'system' | 'provider';
export type ConveractFabricAuditResult = 'succeeded' | 'failed' | 'denied' | 'accepted';
export type ConveractFabricAuditPolicyDecision = 'allow' | 'deny' | 'not_applicable';

export interface ConveractFabricAuditBusinessRef {
  type: string;
  id: string;
}

export interface ConveractFabricAuditRequest {
  tenant_id: string;
  actor_id: string;
  actor_role: ConveractFabricAuditActorRole;
  action: string;
  resource_type: string;
  resource_id: string;
  business_ref: ConveractFabricAuditBusinessRef;
  request_id: string;
  result: ConveractFabricAuditResult;
  policy_decision: ConveractFabricAuditPolicyDecision;
  source_ip?: string;
  metadata?: Readonly<Record<string, unknown>>;
  idempotency_key: string;
  occurred_at?: string;
  retention_until?: string | null;
  legal_hold?: boolean;
}

export interface ConveractFabricAuditAppendInput {
  tenant_id: string;
  actor_id: string;
  actor_role: ConveractFabricAuditActorRole;
  action: string;
  resource_type: string;
  resource_id: string;
  business_ref_type: string;
  business_ref_id: string;
  request_id: string;
  idempotency_key: string;
  result: ConveractFabricAuditResult;
  policy_decision: ConveractFabricAuditPolicyDecision;
  source_ip_hmac: string;
  metadata: Readonly<Record<string, unknown>>;
  occurred_at: string;
  retention_until: string | null;
  legal_hold: boolean;
}

export interface ConveractFabricAuditEvent extends ConveractFabricAuditAppendInput {
  id: string;
  previous_hash: string;
  event_hash: string;
  created_at: string;
}

export interface ConveractFabricAuditAppendResult {
  event: ConveractFabricAuditEvent;
  created: boolean;
}

export interface ConveractFabricAuditListInput {
  tenant_id: string;
  limit?: number;
  cursor?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
}

export interface ConveractFabricAuditPage {
  items: ConveractFabricAuditEvent[];
  next_cursor: string | null;
}
