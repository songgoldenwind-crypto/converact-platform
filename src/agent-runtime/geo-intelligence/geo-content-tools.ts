import type { GeoContentStore } from './geo-content-store.js';
import type { scoreGeoContent } from './geo-quality-scorer.js';

export function createGeoContentTools(store: GeoContentStore, qualityScorer: typeof scoreGeoContent) {
  return {
    'geo_content.mine_intent': {
      description: '挖掘意图包，生成问题聚类',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        const clusters = Array.isArray(input.question_clusters) ? input.question_clusters : [];
        const intentPackId = store.createIntentPack({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          platform_targets: Array.isArray(input.platform_targets) ? input.platform_targets.map(String) : [],
          question_clusters: clusters,
          content_opportunity_score: typeof input.content_opportunity_score === 'number' ? input.content_opportunity_score : 0,
        });
        return { intent_pack_id: intentPackId, clusters_count: clusters.length };
      },
    },

    'geo_content.create_plan': {
      description: '创建内容计划',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        const planId = store.createContentPlan({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          intent_pack_id: input.intent_pack_id ? String(input.intent_pack_id) : undefined,
          content_type: input.content_type as 'explainer',
          target_questions: Array.isArray(input.target_questions) ? input.target_questions.map(String) : [],
          kb_source_refs: Array.isArray(input.kb_source_refs) ? input.kb_source_refs.map(String) : [],
          competitor_refs: Array.isArray(input.competitor_refs) ? input.competitor_refs.map(String) : [],
          word_count_target: typeof input.word_count_target === 'number' ? input.word_count_target : 1000,
          heading_count_target: typeof input.heading_count_target === 'number' ? input.heading_count_target : 6,
          evidence_blocks_required: Array.isArray(input.evidence_blocks_required) ? input.evidence_blocks_required : [],
          priority: (input.priority as 'p1') ?? 'p1',
        });
        return { plan_id: planId };
      },
    },

    'geo_content.create_article': {
      description: '创建文章草稿并自动评分',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        const markdownContent = String(input.markdown_content ?? '');
        const title = String(input.title ?? '');
        const qualityScore = qualityScorer({ markdown_content: markdownContent, title });
        const articleId = store.createArticleDraft({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          content_plan_id: input.content_plan_id ? String(input.content_plan_id) : undefined,
          title,
          markdown_content: markdownContent,
          schema_org_json: (input.schema_org_json as Record<string, unknown>) ?? {},
          llms_txt_entry: input.llms_txt_entry ? String(input.llms_txt_entry) : '',
          og_meta: (input.og_meta as Record<string, unknown>) ?? {},
          geo_quality_score: qualityScore as unknown as Record<string, unknown>,
        });
        return { article_id: articleId, geo_quality_score: qualityScore };
      },
    },

    'geo_content.list_articles': {
      description: '列出文章草稿',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        const articles = store.listArticleDrafts({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          publish_status: input.publish_status ? String(input.publish_status) : undefined,
        });
        return { articles, count: articles.length };
      },
    },

    'geo_content.update_article_status': {
      description: '更新文章发布状态',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        store.updateArticleDraft(String(input.article_id), { publish_status: String(input.publish_status) });
        return { status: 'ok' };
      },
    },

    'geo_content.push_to_geoflow': {
      description: '推送文章到 GEOFlow',
      async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
        const article = store.getArticleDraft(String(input.article_id)) as Record<string, unknown> | null;
        if (!article) {
          const err = new Error('Article not found'); (err as NodeJS.ErrnoException).code = 'NOT_FOUND'; throw err;
        }
        const url = `${String(input.geoflow_api_url)}/api/v1/articles/push`;
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'authorization': `Bearer ${String(input.geoflow_api_key)}`,
            },
            body: JSON.stringify({
              title: article.title,
              content: article.markdown_content,
              schema_org_json: article.schema_org_json,
              llms_txt_entry: article.llms_txt_entry,
              og_meta: article.og_meta,
            }),
          });
          if (resp.ok) {
            const data = await resp.json() as Record<string, unknown>;
            const geoflowArticleId = String(data.id ?? data.article_id ?? '');
            store.updateArticleGeoflowStatus(String(input.article_id), 'pushed', geoflowArticleId || undefined);
            return { pushed: true, geoflow_article_id: geoflowArticleId };
          } else {
            store.updateArticleGeoflowStatus(String(input.article_id), 'failed');
            return { pushed: false, error: `HTTP ${resp.status}` };
          }
        } catch (err) {
          store.updateArticleGeoflowStatus(String(input.article_id), 'failed');
          return { pushed: false, error: String((err as Error).message) };
        }
      },
    },
  };
}

export type GeoContentTools = ReturnType<typeof createGeoContentTools>;
