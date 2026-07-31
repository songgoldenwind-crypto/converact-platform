import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { ToolDefinition, ToolHandler } from '../runtime-domain-types.js';

interface RegisterableToolRegistry {
  register: (definition: ToolDefinition, handler: ToolHandler) => ToolDefinition;
}

export function registerMemoryTools(
  toolRegistry: RegisterableToolRegistry,
  { memoryStore, memoryPromoter, transcriptStore, memoryMaintenance, memoryWriteback }: JsonRecord
): void {
  toolRegistry.register(
    readMemoryTool({
      tool_id: 'memory.search',
      display_name: 'Recall ranked long-term memory',
      audit_event_name: 'tool.memory_search'
    }),
    async (input) =>
      memoryStore.retrieve({
        tenant_id: input.tenant_id,
        scopes: input.scopes || [],
        memory_type: input.memory_type || null,
        query: input.query || '',
        limit: input.limit || 20
      })
  );

  toolRegistry.register(
    readMemoryTool({
      tool_id: 'memory.recall',
      display_name: 'Recall long-term memory with source and lineage signals',
      audit_event_name: 'tool.memory_recall'
    }),
    async (input) =>
      memoryStore.retrieve({
        tenant_id: input.tenant_id,
        scopes: input.scopes || [],
        memory_type: input.memory_type || null,
        query: input.query || '',
        scan_limit: input.scan_limit || 300,
        limit: input.limit || 20
      })
  );

  toolRegistry.register(
    internalMemoryTool({
      tool_id: 'memory.propose',
      display_name: 'Propose memory candidate',
      audit_event_name: 'tool.memory_propose'
    }),
    async (input) => memoryPromoter.propose(input)
  );

  toolRegistry.register(
    internalMemoryTool({
      tool_id: 'memory.extract_candidates_from_transcript',
      display_name: 'Extract memory candidates from transcript',
      audit_event_name: 'tool.memory_extract_candidates_from_transcript'
    }),
    async (input) => ({ candidates: memoryPromoter.extractFromTranscript(input, transcriptStore) })
  );

  toolRegistry.register(
    internalMemoryTool({
      tool_id: 'memory.mark_status',
      display_name: 'Mark memory lifecycle status',
      audit_event_name: 'tool.memory_mark_status'
    }),
    async (input) =>
      memoryStore.updateStatus(input.tenant_id, input.memory_id, input.status, {
        reason: input.reason || '',
        actor_id: input.actor_id || 'system'
      })
  );

  toolRegistry.register(
    internalMemoryTool({
      tool_id: 'memory.synthesize_profile',
      display_name: 'Synthesize scoped memory profile',
      audit_event_name: 'tool.memory_synthesize_profile'
    }),
    async (input) => memoryStore.synthesizeProfile(input)
  );

  if (memoryMaintenance) {
    toolRegistry.register(
      internalMemoryTool({
        tool_id: 'memory.run_maintenance',
        display_name: 'Run memory maintenance cycle',
        audit_event_name: 'tool.memory_run_maintenance'
      }),
      async (input) => {
        const result = await memoryMaintenance.runMaintenanceCycle(input.tenant_id);
        return { result };
      }
    );
  }

  if (memoryWriteback) {
    toolRegistry.register(
      internalMemoryTool({
        tool_id: 'memory.process_call_outcome',
        display_name: 'Process call outcome and update memories',
        audit_event_name: 'tool.memory_process_call_outcome'
      }),
      async (input) => memoryWriteback.processCallOutcome(
        input.tenant_id,
        input.run_id,
        input.lead_id,
        input.disposition,
        input.notes || ''
      )
    );

    toolRegistry.register(
      internalMemoryTool({
        tool_id: 'memory.record_preference',
        display_name: 'Record a new preference memory',
        audit_event_name: 'tool.memory_record_preference'
      }),
      async (input) => memoryWriteback.recordPreference(
        input.tenant_id,
        input.scope_type || 'tenant',
        input.scope_id || '',
        input.content,
        input.confidence ?? 0.9
      )
    );
  }
}

function readMemoryTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'memory',
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

function internalMemoryTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'tool_id' | 'display_name' | 'audit_event_name'>): ToolDefinition {
  return {
    toolset: 'memory',
    category: 'internal_write',
    risk_level: 'R2',
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
