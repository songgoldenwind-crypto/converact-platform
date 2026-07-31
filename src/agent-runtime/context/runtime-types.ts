import type { ContextEnvelope } from '../core-kernel/types.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';

export type SandboxScope = 'tenant' | 'workspace' | 'agent' | 'workflow' | 'session' | 'business_object';
export type DmScope = 'per_user' | 'per_channel_thread' | 'per_business_object' | string;
export type MemoryScopeType = 'lead' | 'customer' | 'campaign' | 'workspace' | 'agent' | 'tenant' | 'skill' | string;

export interface BusinessContext {
  tenant_id?: string;
  tenantId?: string;
  business_object_type?: string;
  businessObjectType?: string;
  object_type?: string;
  objectType?: string;
  business_object_id?: string;
  businessObjectId?: string;
  object_id?: string;
  objectId?: string;
  campaign_id?: string;
  customer_id?: string;
  lead_id?: string;
  workflow_run_id?: string;
  sandbox_scope?: SandboxScope;
  dm_scope?: DmScope;
  [key: string]: unknown;
}

export interface BusinessObjectRef {
  type: string;
  id: string;
}

export interface SessionPolicyInput {
  tenantId: string;
  workspaceId?: string;
  channel?: string;
  userId?: string;
  agentId?: string;
  workflowRunId?: string | null;
  businessContext?: BusinessContext;
}

export interface SessionPolicy {
  tenantId: string;
  workspaceId: string;
  channel: string;
  agentId?: string;
  sandboxScope: SandboxScope;
  dmScope: DmScope;
  businessObjectType: string;
  businessObjectId: string;
  sessionKey: string;
}

export interface AgentDescriptor {
  agent_id: string;
  version?: string;
  allowed_toolsets?: string[];
  forbidden_tools?: string[];
}

export interface PlaybookDescriptor {
  playbook_id: string;
}

export interface RetrievalScope {
  scope_type: MemoryScopeType;
  scope_id: string;
}

export interface MemoryEntryRow {
  id: string;
  tenant_id: string;
  scope_type: string;
  scope_id: string;
  memory_type: string;
  content: string;
  entity_key?: string;
  fact_key?: string;
  evidence_object_type: string;
  evidence_object_id: string;
  source_refs?: unknown[];
  confidence: number;
  status: string;
  occurred_at?: string | null;
  known_at?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  supersedes_memory_id?: string | null;
  superseded_by_memory_id?: string | null;
  contradiction_group_id?: string;
  recall_count?: number;
  last_recalled_at?: string | null;
  importance_score?: number;
  protected?: number;
  summary_parent_id?: string;
  effective_known_at?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  rank_score?: number | null;
  rank_reason?: string;
  recall_path?: string[];
}

export interface MemorySummary {
  id: string;
  scope_type: string;
  scope_id: string;
  memory_type: string;
  content: string;
  entity_key: string;
  fact_key: string;
  confidence: number;
  status: string;
  rank_score: number | null;
  rank_reason: string;
  recall_path: string[];
  evidence: { object_type: string; object_id: string } | null;
  source_refs: unknown[];
  importance_score?: number;
  drill_down_memories?: MemorySummary[];
  temporal: {
    occurred_at: string | null;
    known_at: string | null;
    valid_from: string | null;
    valid_to: string | null;
  };
  lineage: {
    supersedes_memory_id: string | null;
    superseded_by_memory_id: string | null;
    contradiction_group_id: string;
  };
}

export interface MemoryPack {
  facts: MemorySummary[];
  learnings: MemorySummary[];
  skills: MemorySummary[];
  conditions?: MemorySummary[];
  openLoops?: MemorySummary[];
  profiles?: MemorySummary[];
}

export interface SkillStoreLike {
  buildPack?: (input: { tenantId: string; workspaceId: string; agentId: string }) => unknown[];
}

export interface ProviderContextPack {
  inventory_summary: unknown[];
  active_policies: unknown[];
  routing_hints: unknown[];
}

export interface ProviderStoreLike {
  buildContextPack?: (input: {
    tenant_id: string;
    workspace_id: string;
    agent: AgentDescriptor;
    playbook: PlaybookDescriptor;
  }) => ProviderContextPack;
}

export interface RunStoreLike {
  ensureAgentSession?: (input: {
    tenant_id: string;
    workspace_id: string;
    session_key: string;
    channel: string;
    sandbox_scope: string;
    dm_scope: string;
    business_object_type: string;
    business_object_id: string;
    agent_id: string;
  }) => { id?: string | null } | null;
  recordContextCompressionTrace?: (input: JsonRecord) => JsonRecord | null;
  recordLeadRunParticleSnapshot?: (input: JsonRecord) => JsonRecord | null;
}

export interface MemoryStoreLike {
  buildPack?: (input: {
    tenantId: string;
    workspaceId?: string;
    agent?: AgentDescriptor | null;
    playbook?: PlaybookDescriptor | null;
    businessContext?: BusinessContext;
  }) => MemoryPack;
}

export interface HookManagerLike {
  runSync?: (hook: string, payload: Record<string, unknown>) => void;
  run?: (hook: string, payload: Record<string, unknown>) => void | Promise<void>;
}

export interface ContextBuildInput {
  tenantId: string;
  workspaceId?: string;
  userId?: string;
  channel?: string;
  workflowRunId?: string | null;
  agent: AgentDescriptor;
  playbook: PlaybookDescriptor;
  goal?: string;
  businessContext?: BusinessContext;
}

export interface CoreCapabilityState {
  context: ContextEnvelope;
}

export interface ContextPack {
  tenantId: string;
  workspaceId: string;
  userId: string;
  channel: string;
  session: SessionPolicy & { id: string | null };
  agentId: string;
  agentVersion: string | undefined;
  playbookId: string;
  workflowRunId: string | null;
  goal: string;
  businessContext: BusinessContext;
  platformRules: string[];
  allowedToolsets: string[];
  forbiddenTools: string[];
  skillPack: unknown[];
  providerPack: ProviderContextPack;
  memoryPack: MemoryPack;
  context_envelope: ContextEnvelope;
  core_capability_state: CoreCapabilityState;
}
