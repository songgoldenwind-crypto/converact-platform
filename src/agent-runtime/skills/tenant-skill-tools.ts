import type { JsonRecord } from '../integrations/provider-runtime-types.js';

interface RegisterableToolRegistry {
  register: (definition: JsonRecord, handler: (input: JsonRecord, context: JsonRecord) => unknown) => void;
}

interface TenantSkillStoreLike {
  listSkills: (input: JsonRecord) => unknown;
  upsertSkill: (input: JsonRecord) => unknown;
  proposeCandidate: (input: JsonRecord) => unknown;
  listCandidates: (input: JsonRecord) => unknown;
  reviewCandidate: (input: JsonRecord) => unknown;
}

export function registerTenantSkillTools(
  toolRegistry: RegisterableToolRegistry,
  tenantSkillStore: TenantSkillStoreLike
): void {
  toolRegistry.register(
    readSkillTool({
      tool_id: 'skill.tenant_list',
      display_name: 'List tenant skills',
      required_scopes: ['skill:read'],
      audit_event_name: 'tool.skill_tenant_list'
    }),
    (input) => tenantSkillStore.listSkills(input)
  );

  toolRegistry.register(
    internalSkillTool({
      tool_id: 'skill.tenant_upsert',
      display_name: 'Upsert tenant skill',
      required_scopes: ['skill:manage'],
      audit_event_name: 'tool.skill_tenant_upsert'
    }),
    (input) => tenantSkillStore.upsertSkill(input)
  );

  toolRegistry.register(
    internalSkillTool({
      tool_id: 'skill.candidate_propose',
      display_name: 'Propose tenant skill candidate',
      required_scopes: ['skill:write'],
      audit_event_name: 'tool.skill_candidate_propose'
    }),
    (input) => tenantSkillStore.proposeCandidate(input)
  );

  toolRegistry.register(
    readSkillTool({
      tool_id: 'skill.candidate_list',
      display_name: 'List tenant skill candidates',
      required_scopes: ['skill:read'],
      audit_event_name: 'tool.skill_candidate_list'
    }),
    (input) => tenantSkillStore.listCandidates(input)
  );

  toolRegistry.register(
    internalSkillTool({
      tool_id: 'skill.candidate_review',
      display_name: 'Review tenant skill candidate',
      required_scopes: ['skill:manage'],
      audit_event_name: 'tool.skill_candidate_review'
    }),
    (input, context) => tenantSkillStore.reviewCandidate({ ...input, actor_id: input.actor_id || context.userId || 'system' })
  );
}

function readSkillTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'skill',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'crm_agent', 'analytics_agent', 'knowledge_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

function internalSkillTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'skill',
    category: 'internal_write',
    risk_level: 'R2',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'crm_agent', 'analytics_agent', 'knowledge_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}
