import type { MemoryEntryRow } from '../context/runtime-types.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import { MemoryStore } from './memory-store.js';
import { MemoryPromoter } from './memory-promoter.js';

interface ModelGatewayLike {
  complete: (context: JsonRecord, request: JsonRecord) => Promise<JsonRecord>;
}

export class MemoryWriteback {
  db: unknown;
  memoryStore: MemoryStore;
  memoryPromoter: MemoryPromoter;
  modelGateway: ModelGatewayLike | null;

  constructor(db: unknown, memoryStore: MemoryStore, memoryPromoter: MemoryPromoter, modelGateway: ModelGatewayLike | null = null) {
    this.db = db;
    this.memoryStore = memoryStore;
    this.memoryPromoter = memoryPromoter;
    this.modelGateway = modelGateway;
  }

  /** Phase completion: close resolved open_loops, create learnings */
  processPhaseCompletion(
    tenantId: string,
    runId: string,
    phase: string,
    outcomes: JsonRecord
  ): { closed: number; created: number } {
    const closed = this.closeResolvedOpenLoops(tenantId, runId, outcomes);
    const created = this.createLearnings(tenantId, runId, phase, outcomes);
    return { closed, created };
  }

  /** Call outcome: close corresponding open_loop, record learning */
  processCallOutcome(
    tenantId: string,
    runId: string,
    leadId: string,
    disposition: string,
    notes: string
  ): { closedLoopId?: string; createdLearningId?: string } {
    const openLoops = this.memoryStore.search({
      tenant_id: tenantId,
      scope_type: 'lead',
      scope_id: leadId,
      memory_type: 'open_loop',
      status: 'active',
      limit: 10
    });

    let closedLoopId: string | undefined;
    const newMemories = this.extractNewMemoriesFromCall(tenantId, leadId, disposition, notes);

    for (const loop of openLoops) {
      // Sync path: fact_key override detection
      if (this.isOpenLoopResolved(loop, newMemories)) {
        this.memoryStore.updateStatus(tenantId, loop.id, 'archived', {
          reason: 'resolved_by_call_outcome',
          disposition,
          resolution_type: 'fact_key_override'
        });
        closedLoopId = loop.id;
        continue;
      }

      // Async path: LLM judgment (non-blocking)
      this.llmJudgeOpenLoopResolution(loop, notes).then((resolved) => {
        if (resolved) {
          this.memoryStore.updateStatus(tenantId, loop.id, 'archived', {
            reason: 'resolved_by_call_outcome',
            disposition,
            resolution_type: 'llm_judged'
          });
        }
      }).catch(() => {
        // Silently ignore LLM failure
      });
    }

    // Extract learning from call
    const learning = this.extractLearningFromCall(disposition, notes);
    let createdLearningId: string | undefined;
    if (learning) {
      const candidate = this.memoryPromoter.propose({
        tenant_id: tenantId,
        scope_type: 'lead',
        scope_id: leadId,
        memory_type: 'learning',
        content: learning,
        confidence: 0.85,
        evidence_refs: [{ object_type: 'call_outcome', object_id: `${tenantId}:${leadId}` }]
      });
      if (candidate) {
        const approved = this.memoryPromoter.approve(tenantId, candidate.id as string);
        createdLearningId = (approved.memory as MemoryEntryRow)?.id;
      }
    }

    return { closedLoopId, createdLearningId };
  }

  /** Record a new preference: propose + auto-approve */
  recordPreference(
    tenantId: string,
    scopeType: string,
    scopeId: string,
    content: string,
    confidence: number
  ): MemoryEntryRow | null {
    const candidate = this.memoryPromoter.propose({
      tenant_id: tenantId,
      scope_type: scopeType,
      scope_id: scopeId,
      memory_type: 'preference',
      content,
      confidence
    });
    if (!candidate) return null;
    const result = this.memoryPromoter.approve(tenantId, candidate.id as string);
    return result.memory as MemoryEntryRow;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private closeResolvedOpenLoops(tenantId: string, runId: string, outcomes: JsonRecord): number {
    let closed = 0;

    // Explicit close by IDs
    const closedIds = Array.isArray(outcomes.closed_loop_ids) ? outcomes.closed_loop_ids as string[] : [];
    for (const loopId of closedIds) {
      const loop = this.memoryStore.get(tenantId, loopId);
      if (loop && loop.memory_type === 'open_loop' && loop.status === 'active') {
        this.memoryStore.updateStatus(tenantId, loopId, 'archived', {
          reason: 'resolved_by_phase_completion',
          resolution_type: 'explicit_close',
          run_id: runId
        });
        closed++;
      }
    }

    // Close by matched fact_keys
    const resolvedFactKeys = Array.isArray(outcomes.resolved_loop_fact_keys)
      ? (outcomes.resolved_loop_fact_keys as string[])
      : [];
    if (resolvedFactKeys.length) {
      const openLoops = this.memoryStore.search({
        tenant_id: tenantId,
        memory_type: 'open_loop',
        status: 'active',
        limit: 200
      });
      for (const loop of openLoops) {
        if (resolvedFactKeys.includes(loop.fact_key || '')) {
          this.memoryStore.updateStatus(tenantId, loop.id, 'archived', {
            reason: 'resolved_by_phase_completion',
            resolution_type: 'fact_key_match',
            run_id: runId
          });
          closed++;
        }
      }
    }

    return closed;
  }

  private createLearnings(tenantId: string, runId: string, phase: string, outcomes: JsonRecord): number {
    let created = 0;
    const evidenceRef = { object_type: 'phase_completion', object_id: `${tenantId}:${runId}` };

    const learningContents: string[] = [];
    if (Array.isArray(outcomes.learnings)) {
      for (const item of outcomes.learnings) {
        if (typeof item === 'string' && item.trim()) learningContents.push(item.trim());
      }
    }
    if (!learningContents.length && typeof outcomes.notes === 'string' && outcomes.notes.trim()) {
      learningContents.push(`[${phase}] ${outcomes.notes.trim()}`);
    }

    for (const content of learningContents) {
      const candidate = this.memoryPromoter.propose({
        tenant_id: tenantId,
        scope_type: 'tenant',
        scope_id: '',
        memory_type: 'learning',
        content,
        confidence: 0.85,
        evidence_refs: [evidenceRef],
        metadata: { phase, run_id: runId }
      });
      if (candidate) {
        this.memoryPromoter.approve(tenantId, candidate.id as string);
        created++;
      }
    }

    return created;
  }

  private extractNewMemoriesFromCall(
    tenantId: string,
    leadId: string,
    disposition: string,
    notes: string
  ): MemoryEntryRow[] {
    const memories: MemoryEntryRow[] = [];

    if (disposition === 'completed' || disposition === 'interested') {
      const learning = this.extractLearningFromCall(disposition, notes);
      if (learning) {
        const candidate = this.memoryPromoter.propose({
          tenant_id: tenantId,
          scope_type: 'lead',
          scope_id: leadId,
          memory_type: 'learning',
          content: learning,
          confidence: 0.85,
          evidence_refs: [{ object_type: 'call_outcome', object_id: `${tenantId}:${leadId}` }]
        });
        if (candidate) {
          const approved = this.memoryPromoter.approve(tenantId, candidate.id as string);
          if (approved.memory) memories.push(approved.memory as MemoryEntryRow);
        }
      }
    }

    return memories;
  }

  private isOpenLoopResolved(loop: MemoryEntryRow, newMemories: MemoryEntryRow[]): boolean {
    for (const mem of newMemories) {
      if (mem.fact_key === loop.fact_key && mem.memory_type !== 'open_loop') {
        return true;
      }
    }
    return false;
  }

  private async llmJudgeOpenLoopResolution(loop: MemoryEntryRow, callNotes: string): Promise<boolean> {
    if (!this.modelGateway) {
      this.memoryStore.runStore?.audit?.(loop.tenant_id, 'memory.llm_judge_fallback', 'memory_entry', loop.id, {
        reason: 'no_model_gateway'
      });
      return false;
    }

    const prompt = `Open loop: "${loop.content}"\nCall notes: "${callNotes}"\nHas this open loop been resolved? Answer yes/no only.`;
    try {
      const result = await this.modelGateway.complete(
        { tenantId: loop.tenant_id, purpose: 'open_loop_resolution' },
        {
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 10,
          purpose: 'open_loop_resolution'
        }
      );
      const text = extractTextFromCompletion(result);
      const resolved = /yes|是|已解决|resolved/.test(String(text || '').toLowerCase());
      this.memoryStore.runStore?.audit?.(loop.tenant_id, 'memory.llm_judge', 'memory_entry', loop.id, {
        resolved,
        text_preview: String(text || '').slice(0, 20)
      });
      return resolved;
    } catch {
      this.memoryStore.runStore?.audit?.(loop.tenant_id, 'memory.llm_judge_fallback', 'memory_entry', loop.id, {
        reason: 'llm_error'
      });
      return false;
    }
  }

  private extractLearningFromCall(disposition: string, notes: string): string | null {
    if (disposition === 'no_answer') return '该号码多次无人接听，建议更换渠道';
    if (disposition === 'not_interested') return '客户明确表示不感兴趣，短期内不宜再次触达';
    if (disposition === 'completed') return `通话完成，客户反馈：${notes.slice(0, 200)}`;
    return null;
  }
}

function extractTextFromCompletion(result: JsonRecord): string {
  const output = result.output as JsonRecord | undefined;
  if (typeof output?.text === 'string') return output.text.trim();
  if (typeof output?.content === 'string') return output.content.trim();
  if (Array.isArray(output?.choices) && typeof output.choices[0]?.message?.content === 'string') {
    return output.choices[0].message.content.trim();
  }
  return '';
}
