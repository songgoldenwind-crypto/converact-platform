export type ConveractFabricAuditActorRole =
  | 'owner' | 'admin' | 'operator' | 'viewer' | 'system' | 'provider';
export type ConveractFabricAuditResult = 'succeeded' | 'failed' | 'denied' | 'accepted';
export type ConveractFabricAuditPolicyDecision = 'allow' | 'deny' | 'not_applicable';

export interface ConveractFabricAuditCapabilities {
  schema_version: number;
  tenant_scoped: boolean;
  immutable: boolean;
  hash_chained: boolean;
  jsonl_export: boolean;
  raw_source_ip_stored: boolean;
}

export interface ConveractFabricAuditEvent {
  id: string;
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
  metadata: Record<string, unknown>;
  occurred_at: string;
  retention_until: string | null;
  legal_hold: boolean;
  previous_hash: string;
  event_hash: string;
  created_at: string;
}

export interface ConveractFabricAuditListInput {
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
