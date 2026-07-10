import type { MemoryEntryRow } from '../context/runtime-types.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import { MemoryStore } from './memory-store.js';

interface MemoryGroup {
  entity_key: string;
  memory_ids: string[];
}

interface ModelGatewayLike {
  complete: (context: JsonRecord, request: JsonRecord) => Promise<JsonRecord>;
}

export class MemorySummarizer {
  db: unknown;
  memoryStore: MemoryStore;
  maxGroups: number;
  modelGateway: ModelGatewayLike | null;

  constructor(db: unknown, memoryStore: MemoryStore, maxGroups = 3, modelGateway: ModelGatewayLike | null = null) {
    this.db = db;
    this.memoryStore = memoryStore;
    this.maxGroups = maxGroups;
    this.modelGateway = modelGateway;
  }

  /** Run LLM summarization for heavily backlogged groups */
  async run(tenantId: string): Promise<number> {
    const groups = this.findHeavyGroups(tenantId, 3); // minGroupSize = 3
    let summarized = 0;

    for (const group of groups.slice(0, this.maxGroups)) {
      const { summary, fallbackReason } = await this.generateSummary(tenantId, group);
      if (summary) {
        const summaryMemory = this.memoryStore.write({
          tenant_id: tenantId,
          scope_type: 'tenant',
          scope_id: '',
          memory_type: 'summary',
          content: summary,
          entity_key: group.entity_key,
          fact_key: `summary:${group.entity_key}`,
          confidence: 0.9,
          metadata: {
            source_memory_ids: group.memory_ids,
            summary_type: 'entity_consolidation',
            fallback_reason: fallbackReason || null
          }
        });
        if (summaryMemory) {
          this.memoryStore.updateImportance(tenantId, summaryMemory.id, 0.9);
        }

        // Archive original memories (not superseded — keep for drill-down)
        for (const memoryId of group.memory_ids) {
          this.memoryStore.updateStatus(tenantId, memoryId, 'archived', {
            reason: 'summarized',
            summary_memory_id: summaryMemory?.id
          });
          this.memoryStore.updateSummaryParent(tenantId, memoryId, summaryMemory?.id || '');
        }

        summarized++;
      }
    }

    return summarized;
  }

  private findHeavyGroups(tenantId: string, minGroupSize: number): MemoryGroup[] {
    const entries = this.memoryStore.search({
      tenant_id: tenantId,
      status: 'active',
      limit: 500
    });

    const byEntity: Record<string, string[]> = {};
    for (const entry of entries) {
      if (!byEntity[entry.entity_key]) byEntity[entry.entity_key] = [];
      byEntity[entry.entity_key].push(entry.id);
    }

    return Object.entries(byEntity)
      .filter(([, ids]) => ids.length >= minGroupSize)
      .map(([entity_key, memory_ids]) => ({ entity_key, memory_ids }));
  }

  private async generateSummary(tenantId: string, group: MemoryGroup): Promise<{ summary: string | null; fallbackReason?: string }> {
    const memories = group.memory_ids
      .map((id) => this.memoryStore.get(tenantId, id))
      .filter(Boolean) as MemoryEntryRow[];

    if (!memories.length) return { summary: null };

    if (!this.modelGateway) {
      return { summary: fallbackConcatenation(group.entity_key, memories), fallbackReason: 'no_model_gateway' };
    }

    const prompt = buildSummaryPrompt(group.entity_key, memories);
    try {
      const result = await this.modelGateway.complete(
        { tenantId, purpose: 'memory_summarization' },
        {
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 300,
          purpose: 'memory_summarization'
        }
      );
      const parsed = parseStructuredCompletion(result);
      if (parsed && parsed.summary) {
        return { summary: parsed.summary };
      }
      const text = extractTextFromCompletion(result);
      if (text) {
        return { summary: text };
      }
      return { summary: fallbackConcatenation(group.entity_key, memories), fallbackReason: 'empty_completion' };
    } catch {
      return { summary: fallbackConcatenation(group.entity_key, memories), fallbackReason: 'llm_error' };
    }
  }
}

function fallbackConcatenation(entityKey: string, memories: MemoryEntryRow[]): string {
  const facts = [...new Set(memories.map((m) => m.content))];
  return `${entityKey} 的综合记忆：${facts.join('；')}`;
}

function parseStructuredCompletion(result: JsonRecord): { summary?: string } | null {
  try {
    const output = result.output as JsonRecord | undefined;
    if (!output) return null;
    const raw = typeof output.text === 'string'
      ? output.text
      : typeof output.content === 'string'
        ? output.content
        : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.summary === 'string') return { summary: parsed.summary };
    return null;
  } catch {
    return null;
  }
}

function buildSummaryPrompt(entityKey: string, memories: MemoryEntryRow[]): string {
  const lines = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
  return `你是记忆整理助手。请根据以下关于「${entityKey}」的记忆，生成一段简洁的综合摘要。

记忆列表：
${lines}

要求：
- 长度不超过 200 字
- 保留关键事实和偏好
- 去除重复信息
- 使用第三人称客观叙述

输出格式：请严格返回 JSON，格式如下：
{"summary": "你的摘要内容"}
不要输出任何前缀、解释或 Markdown 代码块。`;
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
