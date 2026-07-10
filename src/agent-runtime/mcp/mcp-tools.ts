import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { ToolDefinition, ToolHandler } from '../runtime-domain-types.js';

interface RegisterableToolRegistry {
  register: (definition: ToolDefinition, handler: ToolHandler) => ToolDefinition;
}

export function registerMcpTools(toolRegistry: RegisterableToolRegistry, mcpServerStore: JsonRecord): void {
  toolRegistry.register(
    readMcpTool({
      tool_id: 'mcp.server_list',
      display_name: 'List tenant MCP servers',
      required_scopes: ['mcp:read'],
      audit_event_name: 'tool.mcp_server_list'
    }),
    (input) => mcpServerStore.listServers(input)
  );

  toolRegistry.register(
    internalMcpTool({
      tool_id: 'mcp.server_upsert',
      display_name: 'Upsert tenant MCP server',
      required_scopes: ['mcp:manage'],
      audit_event_name: 'tool.mcp_server_upsert'
    }),
    (input, context) => mcpServerStore.upsertServer({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    readMcpTool({
      tool_id: 'mcp.server_health_check',
      display_name: 'Check tenant MCP server health',
      required_scopes: ['mcp:read'],
      audit_event_name: 'tool.mcp_server_health_check'
    }),
    (input, context) => mcpServerStore.healthCheck({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    readMcpTool({
      tool_id: 'mcp.server_snapshots',
      display_name: 'List tenant MCP server snapshots',
      required_scopes: ['mcp:read'],
      audit_event_name: 'tool.mcp_server_snapshots'
    }),
    (input) => mcpServerStore.listSnapshots(input)
  );

  toolRegistry.register(
    readMcpTool({
      tool_id: 'mcp.server_select',
      display_name: 'Select tenant MCP server',
      required_scopes: ['mcp:read'],
      audit_event_name: 'tool.mcp_server_select'
    }),
    (input) => mcpServerStore.selectServer(input)
  );
}

function readMcpTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'mcp',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'knowledge_agent', 'analytics_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

function internalMcpTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'mcp',
    category: 'internal_write',
    risk_level: 'R2',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'knowledge_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}
