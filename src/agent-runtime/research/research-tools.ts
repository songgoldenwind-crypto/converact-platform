import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { ToolDefinition, ToolHandler } from '../runtime-domain-types.js';

interface RegisterableToolRegistry {
  register: (definition: ToolDefinition, handler: ToolHandler) => ToolDefinition;
}

export function registerResearchTools(toolRegistry: RegisterableToolRegistry, researchStore: JsonRecord): void {
  toolRegistry.register(
    readSearchTool({
      tool_id: 'search.session_list',
      display_name: 'List tenant search sessions',
      audit_event_name: 'tool.search_session_list'
    }),
    (input) => researchStore.listSearchSessions(input)
  );

  toolRegistry.register(
    internalSearchTool({
      tool_id: 'search.session_upsert',
      display_name: 'Upsert tenant search session',
      audit_event_name: 'tool.search_session_upsert'
    }),
    (input, context) => researchStore.upsertSearchSession({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    readSearchTool({
      tool_id: 'search.run_list',
      display_name: 'List tenant search runs',
      audit_event_name: 'tool.search_run_list'
    }),
    (input) => researchStore.listSearchRuns(input)
  );

  toolRegistry.register(
    internalSearchTool({
      tool_id: 'search.query',
      display_name: 'Run tenant cited search query',
      audit_event_name: 'tool.search_query'
    }),
    (input, context) => researchStore.runSearchQuery({ ...input, actor_id: input.actor_id || context.userId || 'system' }, context)
  );

  toolRegistry.register(
    readNotebookTool({
      tool_id: 'notebook.list',
      display_name: 'List tenant notebooks',
      audit_event_name: 'tool.notebook_list'
    }),
    (input) => researchStore.listNotebooks(input)
  );

  toolRegistry.register(
    internalNotebookTool({
      tool_id: 'notebook.upsert',
      display_name: 'Upsert tenant notebook',
      audit_event_name: 'tool.notebook_upsert'
    }),
    (input, context) => researchStore.upsertNotebook({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    internalNotebookTool({
      tool_id: 'notebook.attach_source',
      display_name: 'Attach tenant source to notebook',
      audit_event_name: 'tool.notebook_attach_source'
    }),
    (input, context) => researchStore.attachNotebookSource({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );

  toolRegistry.register(
    internalNotebookTool({
      tool_id: 'notebook.query_cited',
      display_name: 'Run notebook cited query',
      audit_event_name: 'tool.notebook_query_cited'
    }),
    (input, context) => researchStore.queryNotebook({ ...input, actor_id: input.actor_id || context.userId || 'system' }, context)
  );

  toolRegistry.register(
    internalNotebookTool({
      tool_id: 'notebook.generate_audio_overview_draft',
      display_name: 'Generate notebook audio overview draft',
      audit_event_name: 'tool.notebook_generate_audio_overview_draft'
    }),
    (input, context) =>
      researchStore.generateNotebookAudioOverviewDraft({ ...input, actor_id: input.actor_id || context.userId || 'system' }, context)
  );
}

function readSearchTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'search',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'knowledge_agent', 'crm_agent', 'analytics_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

function internalSearchTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'search',
    category: 'internal_write',
    risk_level: 'R1',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'knowledge_agent', 'crm_agent', 'analytics_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

function readNotebookTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'notebook',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'knowledge_agent', 'crm_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

function internalNotebookTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'notebook',
    category: 'internal_write',
    risk_level: 'R1',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'knowledge_agent', 'crm_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}
