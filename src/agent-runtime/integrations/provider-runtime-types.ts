import type { AuditStoreLike } from '../runtime-domain-types.js';

export type JsonRecord = Record<string, any>;
export type ProviderHealthStatus =
  | 'ready'
  | 'healthy'
  | 'configured'
  | 'configured_planned_adapter'
  | 'planned'
  | 'not_configured'
  | 'not_required'
  | 'reference_only'
  | 'degraded'
  | string;

export interface IntegrationCatalogEntry {
  id: string;
  name: string;
  category: string;
  source_type: string;
  license?: string;
  maturity?: string;
  stability_score: number;
  default_risk_level?: string;
  deployment_modes?: string[];
  capabilities: string[];
  adapter_status: string;
  adoption_tier?: string;
  recommended_use?: string;
  caution_notes?: string;
  config_required?: boolean;
}

export interface IntegrationCatalogLike {
  list: (input?: JsonRecord) => IntegrationCatalogEntry[];
  get: (id: string) => IntegrationCatalogEntry;
}

export interface IntegrationSecretRef {
  id: string;
  tenant_id: string;
  workspace_id: string;
  integration_id: string;
  secret_key: string;
  env_var_name: string;
  secret_fingerprint?: string;
  redacted_preview?: string;
  status: string;
}

export interface TenantIntegrationConfig {
  id: string;
  tenant_id: string;
  workspace_id: string;
  integration_id: string;
  status: string;
  config: JsonRecord;
  secret_ref_ids: string[];
  health_status?: string | null;
  last_checked_at?: string | null;
}

export interface RuntimeIntegrationConfig extends TenantIntegrationConfig {
  secret_refs: IntegrationSecretRef[];
  resolved_secrets: Record<string, string>;
  missing_secret_keys: string[];
  runtime_status: 'disabled' | 'missing_secrets' | 'ready';
  runtime_config: JsonRecord;
}

export interface IntegrationConfigStoreLike {
  upsertSecretRef?: (input: JsonRecord) => IntegrationSecretRef;
  upsertConfig?: (input: JsonRecord) => TenantIntegrationConfig;
  healthCheck: (input: JsonRecord) => TenantIntegrationConfig & { health: JsonRecord };
  resolveRuntimeConfig: (input: JsonRecord) => RuntimeIntegrationConfig;
  getConfig: (tenantId: string, workspaceId: string, integrationId: string) => TenantIntegrationConfig | null;
  listConfigs: (input: JsonRecord) => TenantIntegrationConfig[];
  getSecretRef?: (tenantId: string, workspaceId: string, integrationId: string, secretKey: string) => IntegrationSecretRef | null;
  getSecretRefById?: (tenantId: string, secretRefId: string) => IntegrationSecretRef | null;
}

export interface ProviderAdapterDefinition {
  integration_id: string;
  adapter_type: string;
  status: string;
  operations: string[];
}

export interface ProviderAdapterContext {
  tenant_id?: string;
  workspace_id?: string;
  integration_id?: string;
  input?: JsonRecord;
  config?: JsonRecord;
  secrets?: Record<string, string>;
}

export interface ProviderAdapter {
  health?: (context?: ProviderAdapterContext) => Promise<JsonRecord> | JsonRecord;
  execute: (operation: string, context?: ProviderAdapterContext) => Promise<JsonRecord> | JsonRecord;
}

export interface AdapterRegistryEntry {
  definition: ProviderAdapterDefinition;
  adapter: ProviderAdapter;
}

export interface AdapterRegistryLike {
  register: (definition: ProviderAdapterDefinition, adapter: ProviderAdapter) => void;
  get: (integrationId: string) => AdapterRegistryEntry;
  has: (integrationId: string) => boolean;
  list: () => ProviderAdapterDefinition[];
}

export interface ProviderPolicy {
  id: string;
  tenant_id: string;
  workspace_id: string;
  policy_id: string;
  name: string;
  description: string;
  use_case: string;
  category: string;
  capability: string;
  preferred_integration_ids: string[];
  blocked_integration_ids: string[];
  allow_fallback: boolean;
  min_stability: number | null;
  config: JsonRecord;
  status: string;
  updated_at: string;
}

export interface ProviderInventoryEntry {
  integration_id: string;
  workspace_id: string;
  name: string;
  category: string;
  source_type: string;
  license?: string;
  maturity?: string;
  stability_score: number;
  capabilities: string[];
  adapter_status: string;
  adapter_type: string;
  adapter_runtime_status: string;
  operations: string[];
  adoption_tier?: string;
  config_required: boolean;
  configured: boolean;
  config_status: string;
  health_status: ProviderHealthStatus;
  health_checked_at: string | null;
  latest_health_snapshot_id: string | null;
  secret_ref_count: number;
  recommended_use?: string;
  caution_notes?: string;
}

export interface ProviderSelectionCandidate extends ProviderInventoryEntry {
  selection_score: number;
}

export interface ProviderSelection {
  selected: ProviderSelectionCandidate | null;
  selection_basis: string;
  policy_overlay: ProviderPolicy | null;
  candidates: ProviderSelectionCandidate[];
}

export interface ProviderRegistryStoreOptions {
  db: unknown;
  integrationCatalog: IntegrationCatalogLike;
  adapterRegistry: AdapterRegistryLike;
  integrationConfigStore: IntegrationConfigStoreLike;
  runStore?: AuditStoreLike | null;
}
