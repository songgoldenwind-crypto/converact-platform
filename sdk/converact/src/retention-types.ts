export type ConveractFabricRetentionCategory =
  | 'notifications' | 'audit' | 'rate_limit_buckets' | 'secure_files'
  | 'media_recordings' | 'tenant_events';

export interface ConveractFabricRetentionCapabilities {
  schema_version: number;
  policy_categories: ConveractFabricRetentionCategory[];
  legal_holds: boolean;
  distributed_worker: boolean;
  dry_run: boolean;
}

export interface ConveractFabricRetentionPolicy {
  tenant_id: string;
  category: ConveractFabricRetentionCategory;
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

export interface ConveractFabricLegalHold {
  id: string;
  tenant_id: string;
  category: ConveractFabricRetentionCategory;
  resource_type: string;
  resource_id: string;
  reason_code: string;
  status: 'active' | 'released';
  placed_by: string;
  released_by: string | null;
  placed_at: string;
  released_at: string | null;
}
