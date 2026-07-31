import type { BrandKbStore } from './brand-kb-store.js';

export function createBrandKbTools(store: BrandKbStore) {
  return {
    'brand_kb.upsert_entity': {
      description: '添加或更新品牌实体（品牌/产品/服务/团队/资质/定价/渠道）',
      execute: (input: Record<string, unknown>): Record<string, unknown> => {
        const entityId = store.upsertEntity({
          tenant_id: String(input.tenant_id),
          workspace_id: String(input.workspace_id ?? 'default'),
          entity_type: input.entity_type as 'brand',
          entity_name: String(input.entity_name),
          entity_description: input.entity_description ? String(input.entity_description) : undefined,
          entity_metadata: (input.entity_metadata as Record<string, unknown>) ?? {},
          source_url: input.source_url ? String(input.source_url) : undefined,
          verified: Boolean(input.verified ?? false),
        });
        return { entity_id: entityId, status: 'ok' };
      },
    },

    'brand_kb.list_entities': {
      description: '列出品牌实体',
      execute: (input: Record<string, unknown>): Record<string, unknown> => {
        const entities = store.listEntities({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
        });
        return { entities, count: entities.length };
      },
    },

    'brand_kb.upsert_fact_card': {
      description: '添加品牌事实卡片（定义/数据点/对比/how-to/案例结果/资质）',
      execute: (input: Record<string, unknown>): Record<string, unknown> => {
        const cardId = store.upsertFactCard({
          tenant_id: String(input.tenant_id),
          workspace_id: String(input.workspace_id ?? 'default'),
          fact_type: input.fact_type as 'definition',
          fact_content: String(input.fact_content),
          fact_evidence: input.fact_evidence ? String(input.fact_evidence) : undefined,
          source_url: input.source_url ? String(input.source_url) : undefined,
          citability_score: typeof input.citability_score === 'number' ? input.citability_score : 0.5,
          verified: Boolean(input.verified ?? false),
          entity_ids: Array.isArray(input.entity_ids) ? input.entity_ids.map(String) : [],
        });
        return { fact_card_id: cardId, status: 'ok' };
      },
    },

    'brand_kb.list_fact_cards': {
      description: '列出事实卡片，可按最低可引用性评分过滤',
      execute: (input: Record<string, unknown>): Record<string, unknown> => {
        const cards = store.listFactCards({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          min_citability: typeof input.min_citability === 'number' ? input.min_citability : 0,
        });
        return { fact_cards: cards, count: cards.length };
      },
    },

    'brand_kb.upsert_case': {
      description: '添加品牌真实案例',
      execute: (input: Record<string, unknown>): Record<string, unknown> => {
        const caseId = store.upsertCase({
          tenant_id: String(input.tenant_id),
          workspace_id: String(input.workspace_id ?? 'default'),
          case_title: String(input.case_title),
          customer_profile: input.customer_profile ? String(input.customer_profile) : undefined,
          problem_description: input.problem_description ? String(input.problem_description) : undefined,
          solution_description: input.solution_description ? String(input.solution_description) : undefined,
          outcome_metrics: (input.outcome_metrics as Record<string, unknown>) ?? {},
          outcome_quote: input.outcome_quote ? String(input.outcome_quote) : undefined,
          source_url: input.source_url ? String(input.source_url) : undefined,
        });
        return { case_id: caseId, status: 'ok' };
      },
    },

    'brand_kb.upsert_faq': {
      description: '添加品牌 FAQ 条目（从外呼异议积累）',
      execute: (input: Record<string, unknown>): Record<string, unknown> => {
        const faqId = store.upsertFaqEntry({
          tenant_id: String(input.tenant_id),
          workspace_id: String(input.workspace_id ?? 'default'),
          question: String(input.question),
          answer: String(input.answer),
          objection_type: (input.objection_type as 'price') ?? 'other',
          call_outcome_source_id: input.call_outcome_source_id ? String(input.call_outcome_source_id) : undefined,
        });
        return { faq_id: faqId, status: 'ok' };
      },
    },

    'brand_kb.get_completeness': {
      description: '获取知识库完整度评分和缺失项建议',
      execute: (input: Record<string, unknown>): Record<string, unknown> => {
        const completeness = store.computeAndSaveCompleteness({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
        });
        return { completeness };
      },
    },

    'brand_kb.get_script_context': {
      description: '获取用于话术生成的品牌知识库上下文（top facts/cases/FAQ）',
      execute: (input: Record<string, unknown>): Record<string, unknown> => {
        const ctx = store.buildScriptKbContext({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
        });
        return { script_kb_context: ctx };
      },
    },
  };
}

export type BrandKbTools = ReturnType<typeof createBrandKbTools>;
