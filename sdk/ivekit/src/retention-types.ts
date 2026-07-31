export type IveKitRetentionCategory =
  | 'notifications' | 'audit' | 'rate_limit_buckets' | 'secure_files'
  | 'media_recordings' | 'tenant_events';

export interface IveKitRetentionCapabilities {
  schema_version: number;
  policy_categories: IveKitRetentionCategory[];
  legal_holds: boolean;
  distributed_worker: boolean;
  dry_run: boolean;
}

export interface IveKitRetentionPolicy {
  tenant_id: string;
  category: IveKitRetentionCategory;
  enabled: boolean;
  retention_days: number;
  batch_size: number;
  interval_seconds: number;
  next_run_at: string;
  lease_active: boolean;
  lease_expires_at: string | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface IveKitLegalHold {
  id: string;
  tenant_id: string;
  category: IveKitRetentionCategory;
  resource_type: string;
  resource_id: string;
  reason_code: string;
  status: 'active' | 'released';
  placed_by: string;
  released_by: string | null;
  placed_at: string;
  released_at: string | null;
}
