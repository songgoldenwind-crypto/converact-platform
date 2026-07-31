import { createHash } from 'node:crypto';

import { buildContextEnvelope } from '../core-kernel/index.js';
import { buildSessionPolicy } from './session-isolation.js';
import type { ContextCompressionTrace } from '../core-kernel/types.js';
import type {
  BusinessContext,
  ContextBuildInput,
  ContextPack,
  HookManagerLike,
  MemoryStoreLike,
  ProviderContextPack,
  ProviderStoreLike,
  RunStoreLike,
  SkillStoreLike,
  MemoryPack,
  MemorySummary
} from './runtime-types.js';

type MemoryCategory = 'facts' | 'learnings' | 'skills' | 'conditions' | 'openLoops' | 'profiles';

interface PrioritizedMemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;
  originalIndex: number;
  priority: number;
  rankScore: number;
  importanceScore?: number;
}

const MEMORY_CATEGORIES: MemoryCategory[] = [
  'facts',
  'learnings',
  'skills',
  'conditions',
  'openLoops',
  'profiles'
];

const DEFAULT_MEMORY_PRIORITY: MemoryCategory[] = [
  'facts',
  'profiles',
  'conditions',
  'learnings',
  'skills',
  'openLoops'
];

const PHASE_MEMORY_PRIORITY: Record<string, MemoryCategory[]> = {
  goal_created: DEFAULT_MEMORY_PRIORITY,
  lead_discovery_ready: ['conditions', 'profiles', 'facts', 'learnings', 'openLoops', 'skills'],
  lead_scored: ['conditions', 'profiles', 'learnings', 'facts', 'openLoops', 'skills'],
  script_ready: ['profiles', 'conditions', 'learnings', 'facts', 'openLoops', 'skills'],
  followup_queue_ready: ['openLoops', 'conditions', 'profiles', 'learnings', 'facts', 'skills'],
  calling_or_followup_running: ['openLoops', 'conditions', 'profiles', 'learnings', 'facts', 'skills'],
  outcomes_collected: ['openLoops', 'learnings', 'conditions', 'profiles', 'facts', 'skills'],
  review_ready: ['openLoops', 'learnings', 'conditions', 'profiles', 'facts', 'skills'],
  completed: ['learnings', 'openLoops', 'conditions', 'profiles', 'facts', 'skills'],
  blocked_needs_user_input: ['openLoops', 'conditions', 'profiles', 'learnings', 'facts', 'skills']
};

export class ContextBuilder {
  memoryStore: MemoryStoreLike | null;
  skillStore: SkillStoreLike | null;
  providerStore: ProviderStoreLike | null;
  runStore: RunStoreLike | null;
  hookManager: HookManagerLike | null;

  constructor({
    memoryStore = null,
    skillStore = null,
    providerStore = null,
    runStore = null,
    hookManager = null
  }: {
    memoryStore?: MemoryStoreLike | null;
    skillStore?: SkillStoreLike | null;
    providerStore?: ProviderStoreLike | null;
    runStore?: RunStoreLike | null;
    hookManager?: HookManagerLike | null;
  } = {}) {
    this.memoryStore = memoryStore;
    this.skillStore = skillStore;
    this.providerStore = providerStore;
    this.runStore = runStore;
    this.hookManager = hookManager;
  }

  build({
    tenantId,
    workspaceId = 'default',
    userId = 'system',
    channel = 'web_app',
    workflowRunId = null,
    agent,
    playbook,
    goal = '',
    businessContext = {}
  }: ContextBuildInput): ContextPack {
    this.hookManager?.runSync?.('before_context_build', {
      tenantId,
      workspaceId,
      userId,
      channel,
      workflowRunId,
      agent,
      playbook,
      goal,
      businessContext
    });
    const sessionPolicy = buildSessionPolicy({
      tenantId,
      workspaceId,
      channel,
      userId,
      agentId: agent.agent_id,
      workflowRunId,
      businessContext
    });
    const session = this.runStore?.ensureAgentSession?.({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      session_key: sessionPolicy.sessionKey,
      channel,
      sandbox_scope: sessionPolicy.sandboxScope,
      dm_scope: sessionPolicy.dmScope,
      business_object_type: sessionPolicy.businessObjectType,
      business_object_id: sessionPolicy.businessObjectId,
      agent_id: agent.agent_id
    });

    const providerPack: ProviderContextPack = this.providerStore?.buildContextPack?.({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      agent,
      playbook
    }) || {
      inventory_summary: [],
      active_policies: [],
      routing_hints: []
    };
    const memoryPack = normalizeMemoryPack(this.memoryStore?.buildPack?.({
      tenantId,
      workspaceId,
      agent,
      playbook,
      businessContext
    }));
    const phase = resolveContextPhase(businessContext);
    const prioritizedMemory = buildPrioritizedMemoryEntries(memoryPack, phase);

    // Split memory into category-keyed slices so compression drops low-priority
    // categories first (PhaseAwarePrioritizer: high-priority categories appear
    // earlier in retain, so they survive longer under char budget pressure).
    const memorySlices: Record<string, string[]> = {};
    for (const entry of prioritizedMemory) {
      const key = `memory_${entry.category}`;
      if (!memorySlices[key]) memorySlices[key] = [];
      memorySlices[key].push(entry.content);
    }
    // Retain order: follow phase priority — first category in retain survives longest
    const categoryRetainOrder = (PHASE_MEMORY_PRIORITY[phase] || DEFAULT_MEMORY_PRIORITY)
      .map((cat) => `memory_${cat}`);

    const contextEnvelope = buildContextEnvelope({
      tenantId,
      runId: workflowRunId || sessionPolicy.sessionKey,
      phase,
      slices: memorySlices,
      compression: {
        retain: categoryRetainOrder,
        maxChars: 512
      }
    });
    contextEnvelope.compression_trace = buildMemoryCompressionTrace(prioritizedMemory, contextEnvelope, phase, 512);
    this.runStore?.recordContextCompressionTrace?.({
      tenant_id: tenantId,
      workflow_run_id: workflowRunId || '',
      lead_acquisition_run_id: resolveLeadAcquisitionRunId(businessContext) || '',
      ...contextEnvelope.compression_trace
    });

    // I73: persist compression discard audit as a particle snapshot
    const leadRunId = resolveLeadAcquisitionRunId(businessContext) || '';
    const discardAudit = contextEnvelope.compression_trace?.discard_audit;
    if (discardAudit && leadRunId) {
      const payload = {
        phase,
        ...discardAudit
      };
      this.runStore?.recordLeadRunParticleSnapshot?.({
        tenant_id: tenantId,
        lead_acquisition_run_id: leadRunId,
        particle_key: 'compression_discard_audit',
        particle_version: 'v1',
        source_stage: 'context_build',
        source_ref: `phase:${phase}`,
        quality_status: contextEnvelope.compression_trace.critical_open_loops_retained === false ? 'warn' : 'pass',
        writeback_status: 'generated',
        payload_hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        payload
      });
    }

    const contextPack: ContextPack = {
      tenantId,
      workspaceId,
      userId,
      channel,
      session: {
        ...sessionPolicy,
        id: session?.id || null
      },
      agentId: agent.agent_id,
      agentVersion: agent.version,
      playbookId: playbook.playbook_id,
      workflowRunId,
      goal,
      businessContext,
      platformRules: [
        'All business reads and writes must stay within tenant scope.',
        'External publication, customer messaging, calling, budget and admin actions require approval.',
        'Artifacts are the durable output of agent work; chat text is not enough.'
      ],
      allowedToolsets: agent.allowed_toolsets || [],
      forbiddenTools: agent.forbidden_tools || [],
      skillPack: this.skillStore?.buildPack?.({ tenantId, workspaceId, agentId: agent.agent_id }) || [],
      providerPack,
      memoryPack,
      context_envelope: contextEnvelope,
      core_capability_state: {
        context: contextEnvelope
      }
    };
    this.hookManager?.runSync?.('after_context_build', { contextPack });
    return contextPack;
  }
}

function normalizeMemoryPack(memoryPack: MemoryPack | null | undefined): MemoryPack {
  return {
    facts: normalizeMemoryEntries(memoryPack?.facts),
    learnings: normalizeMemoryEntries(memoryPack?.learnings),
    skills: normalizeMemoryEntries(memoryPack?.skills),
    conditions: normalizeMemoryEntries(memoryPack?.conditions),
    openLoops: normalizeMemoryEntries(memoryPack?.openLoops),
    profiles: normalizeMemoryEntries(memoryPack?.profiles)
  };
}

function normalizeMemoryEntries(entries: MemorySummary[] | undefined): MemorySummary[] {
  return Array.isArray(entries) ? entries : [];
}

function resolveContextPhase(businessContext: BusinessContext): string {
  const rawPhase =
    businessContext.current_stage
    || businessContext.currentStage
    || businessContext.phase
    || businessContext.lead_acquisition_stage
    || 'goal_created';
  const phase = typeof rawPhase === 'string' && rawPhase.trim() ? rawPhase.trim() : 'goal_created';
  return PHASE_MEMORY_PRIORITY[phase] ? phase : 'goal_created';
}

function buildPrioritizedMemoryEntries(memoryPack: MemoryPack, phase: string): PrioritizedMemoryEntry[] {
  const priority = PHASE_MEMORY_PRIORITY[phase] || DEFAULT_MEMORY_PRIORITY;
  const priorityIndex = new Map(priority.map((category, index) => [category, index]));

    return MEMORY_CATEGORIES.flatMap((category) =>
      (memoryPack[category] || []).map((entry, originalIndex) => ({
        id: entry.id,
        category,
        content: entry.content,
        originalIndex,
        priority: priorityIndex.get(category) ?? priority.length,
        rankScore: resolveMemoryRank(entry),
        importanceScore: entry.importance_score ?? 0.5
      }))
    )
    .filter((entry) => typeof entry.content === 'string' && entry.content.length > 0)
    .sort((a, b) =>
      a.priority - b.priority
      || (b.importanceScore ?? 0) - (a.importanceScore ?? 0)
      || b.rankScore - a.rankScore
      || a.originalIndex - b.originalIndex
    );
}

function resolveMemoryRank(entry: MemorySummary): number {
  if (typeof entry.rank_score === 'number' && Number.isFinite(entry.rank_score)) {
    return entry.rank_score;
  }
  if (typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)) {
    return entry.confidence;
  }
  return 0;
}

function buildMemoryCompressionTrace(
  entries: PrioritizedMemoryEntry[],
  contextEnvelope: { compressed_context: Record<string, unknown> },
  phase: string,
  maxChars: number
): ContextCompressionTrace {
  // Reconstruct flattened compressed memory from category-keyed slices
  const compressed = contextEnvelope.compressed_context || {};
  const compressedMemory: string[] = [];
  for (const key of Object.keys(compressed)) {
    if (key.startsWith('memory_') && Array.isArray(compressed[key])) {
      for (const entry of compressed[key]) {
        if (typeof entry === 'string') compressedMemory.push(entry);
      }
    }
  }
  const retained: PrioritizedMemoryEntry[] = [];
  const discarded: PrioritizedMemoryEntry[] = [];

  for (const entry of entries) {
    if (compressedMemory.includes(entry.content)) {
      retained.push(entry);
    } else {
      discarded.push(entry);
    }
  }

  const openLoops = entries.filter((entry) => entry.category === 'openLoops');
  const retainedOpenLoopIds = new Set(retained.filter((entry) => entry.category === 'openLoops').map((entry) => entry.id));

  return {
    phase,
    max_chars: maxChars,
    total_before_chars: measureJsonChars({ memory: entries.map((entry) => entry.content) }),
    total_after_chars: measureJsonChars(contextEnvelope.compressed_context),
    retained_count: retained.length,
    discarded_count: discarded.length,
    retained_categories: uniqueCategories(retained),
    discarded_categories: uniqueCategories(discarded),
    retained_ids: retained.map((entry) => entry.id),
    discarded_ids: discarded.map((entry) => entry.id),
    critical_open_loops_retained: openLoops.every((entry) => retainedOpenLoopIds.has(entry.id)),
    discard_audit: discarded.length > 0 ? {
      discarded_categories: uniqueCategories(discarded),
      discarded_count: discarded.length,
      retained_count: retained.length,
      audited_at: new Date().toISOString()
    } : undefined
  };
}

function uniqueCategories(entries: PrioritizedMemoryEntry[]): string[] {
  return Array.from(new Set(entries.map((entry) => entry.category)));
}

function resolveLeadAcquisitionRunId(businessContext: BusinessContext): string | null {
  const rawRunId =
    businessContext.lead_acquisition_run_id
    || businessContext.leadAcquisitionRunId
    || businessContext.run_id
    || businessContext.runId;
  return typeof rawRunId === 'string' && rawRunId.trim() ? rawRunId.trim() : null;
}

function measureJsonChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
