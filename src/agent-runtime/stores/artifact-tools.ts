import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { ToolDefinition, ToolHandler } from '../runtime-domain-types.js';

interface RegisterableToolRegistry {
  register: (definition: ToolDefinition, handler: ToolHandler) => ToolDefinition;
}

export function registerArtifactTools(toolRegistry: RegisterableToolRegistry, artifactStore: JsonRecord): void {
  toolRegistry.register(
    readArtifactTool({
      tool_id: 'artifact.list',
      display_name: 'List tenant artifacts',
      audit_event_name: 'tool.artifact_list'
    }),
    (input) => artifactStore.list(input)
  );

  toolRegistry.register(
    readArtifactTool({
      tool_id: 'artifact.get',
      display_name: 'Get tenant artifact',
      audit_event_name: 'tool.artifact_get'
    }),
    (input) => {
      if (!input.artifact_id) throw new Error('artifact_id is required');
      return artifactStore.get(input.tenant_id, input.artifact_id);
    }
  );

  toolRegistry.register(
    readArtifactTool({
      tool_id: 'artifact.review_list',
      display_name: 'List artifact reviews',
      audit_event_name: 'tool.artifact_review_list'
    }),
    (input) => {
      if (!input.artifact_id) throw new Error('artifact_id is required');
      return artifactStore.listReviews(input.tenant_id, input.artifact_id);
    }
  );

  toolRegistry.register(
    internalArtifactTool({
      tool_id: 'artifact.review',
      display_name: 'Review artifact',
      audit_event_name: 'tool.artifact_review'
    }),
    (input, context) => artifactStore.review({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );
}

function readArtifactTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'artifact',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['*'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

function internalArtifactTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'artifact',
    category: 'internal_write',
    risk_level: 'R1',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: false,
    allowed_agents: ['*'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}
