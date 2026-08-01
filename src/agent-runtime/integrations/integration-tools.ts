import type { JsonRecord } from './provider-runtime-types.js';
import type { ToolDefinition, ToolHandler } from '../runtime-domain-types.js';

interface RegisterableToolRegistry {
  register: (definition: ToolDefinition, handler: ToolHandler) => ToolDefinition;
}

export function registerIntegrationTools(
  toolRegistry: RegisterableToolRegistry,
  integrationCatalog: JsonRecord,
  adapterRegistry: JsonRecord,
  integrationConfigStore: JsonRecord = {},
  providerRegistryStore: JsonRecord = {}
): void {
  toolRegistry.register(
    readTool({
      tool_id: 'integration.catalog_search',
      display_name: 'Search open-source integration catalog',
      toolset: 'integration',
      audit_event_name: 'tool.integration_catalog_search'
    }),
    (input) => integrationCatalog.list(input)
  );

  toolRegistry.register(
    readTool({
      tool_id: 'integration.recommend_stack',
      display_name: 'Recommend stable open-source integration stack',
      toolset: 'integration',
      audit_event_name: 'tool.integration_recommend_stack'
    }),
    (input) => {
      if (input?.stable_stack) return integrationCatalog.stableStackForConveract();
      return integrationCatalog.recommend(input || {});
    }
  );

  toolRegistry.register(
    readTool({
      tool_id: 'integration.adapter_status',
      display_name: 'List registered integration adapters',
      toolset: 'integration',
      audit_event_name: 'tool.integration_adapter_status'
    }),
    () => adapterRegistry.list()
  );

  toolRegistry.register(
    internalTool({
      tool_id: 'integration.secret_ref_upsert',
      display_name: 'Upsert integration secret reference',
      audit_event_name: 'tool.integration_secret_ref_upsert'
    }),
    (input) => integrationConfigStore.upsertSecretRef(input)
  );

  toolRegistry.register(
    internalTool({
      tool_id: 'integration.config_upsert',
      display_name: 'Upsert tenant integration config',
      audit_event_name: 'tool.integration_config_upsert'
    }),
    (input) => integrationConfigStore.upsertConfig(input)
  );

  toolRegistry.register(
    readTool({
      tool_id: 'integration.health_check',
      display_name: 'Check tenant integration health',
      tenant_scope_required: true,
      audit_event_name: 'tool.integration_health_check'
    }),
    (input) => integrationConfigStore.healthCheck(input)
  );

  toolRegistry.register(
    readTool({
      tool_id: 'integration.provider_inventory',
      display_name: 'List tenant provider inventory',
      tenant_scope_required: true,
      audit_event_name: 'tool.integration_provider_inventory'
    }),
    (input) => providerRegistryStore.listInventory(input)
  );

  toolRegistry.register(
    readTool({
      tool_id: 'integration.provider_select',
      display_name: 'Select best provider candidate',
      tenant_scope_required: true,
      audit_event_name: 'tool.integration_provider_select'
    }),
    (input) => providerRegistryStore.selectProvider(input)
  );

  toolRegistry.register(
    internalTool({
      tool_id: 'integration.provider_policy_upsert',
      display_name: 'Upsert tenant provider routing policy',
      audit_event_name: 'tool.integration_provider_policy_upsert'
    }),
    (input, context) => providerRegistryStore.upsertPolicy({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    readTool({
      tool_id: 'integration.provider_policy_list',
      display_name: 'List tenant provider routing policies',
      tenant_scope_required: true,
      audit_event_name: 'tool.integration_provider_policy_list'
    }),
    (input) => providerRegistryStore.listPolicies(input)
  );

  toolRegistry.register(
    internalTool({
      tool_id: 'integration.provider_health_snapshot',
      display_name: 'Create provider health snapshot',
      audit_event_name: 'tool.integration_provider_health_snapshot'
    }),
    (input, context) => providerRegistryStore.snapshotHealth({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    readTool({
      tool_id: 'integration.provider_health_snapshots',
      display_name: 'List provider health snapshots',
      tenant_scope_required: true,
      audit_event_name: 'tool.integration_provider_health_snapshots'
    }),
    (input) => providerRegistryStore.listHealthSnapshots(input)
  );
}

function readTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'integration',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['*'],
    forbidden_agents: [],
    tenant_scope_required: false,
    object_scope_required: false,
    ...overrides
  };
}

function internalTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'integration',
    category: 'internal_write',
    risk_level: 'R2',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'voice_agent', 'knowledge_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}
