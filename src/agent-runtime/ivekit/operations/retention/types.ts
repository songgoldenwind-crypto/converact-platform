export type IveKitRetentionCategory =
  | 'notifications' | 'audit' | 'rate_limit_buckets' | 'secure_files'
  | 'media_recordings' | 'tenant_events';

export interface IveKitRetentionPolicy {
  tenant_id: string;
  category: IveKitRetentionCategory;
  enabled: boolean;
  retention_days: number;
  batch_size: number;
  interval_seconds: number;
  next_run_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface IveKitRetentionClaim {
  run_id: string;
  policy: IveKitRetentionPolicy;
  worker_id: string;
  cutoff_at: string;
  started_at: string;
}

export interface IveKitRetentionDeletionSummary {
  scanned_count: number;
  deleted_count: number;
  held_count: number;
}

export interface IveKitRetentionBatchSummary {
  tenants: number;
  claimed: number;
  completed: number;
  failed: number;
  scanned: number;
  deleted: number;
  held: number;
}

export interface IveKitLegalHold {
  id: string;
  tenant_id: string;
  category: IveKitRetentionCategory;
  resource_type: string;
  resource_id: string;
  reason_code: string;
  idempotency_key: string;
  status: 'active' | 'released';
  placed_by: string;
  released_by: string | null;
  placed_at: string;
  released_at: string | null;
}

export interface IveKitRetentionPolicyWrite {
  tenant_id: string;
  category: IveKitRetentionCategory;
  enabled: boolean;
  retention_days: number;
  batch_size: number;
  interval_seconds: number;
  expected_revision: number;
  actor: string;
  now: string;
}

export interface IveKitLegalHoldCreateInput {
  tenant_id: string;
  category: IveKitRetentionCategory;
  resource_type: string;
  resource_id: string;
  reason_code: string;
  idempotency_key: string;
  actor: string;
  now: string;
}
