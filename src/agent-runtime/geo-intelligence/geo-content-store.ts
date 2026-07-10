import { all, id, json, one, parseJson, run } from '../../db.js';

export class GeoContentStore {
  constructor(private db: unknown) {}

  createIntentPack(input: {
    tenant_id: string;
    workspace_id?: string;
    platform_targets?: string[];
    question_clusters?: unknown[];
    content_opportunity_score?: number;
  }): string {
    const packId = id('gci');
    run(this.db, `INSERT INTO tenant_geo_intent_packs (id, tenant_id, workspace_id, platform_targets, question_clusters, content_opportunity_score) VALUES (?, ?, ?, ?, ?, ?)`, [
      packId,
      input.tenant_id,
      input.workspace_id ?? 'default',
      json(input.platform_targets ?? []),
      json(input.question_clusters ?? []),
      input.content_opportunity_score ?? 0,
    ]);
    return packId;
  }

  listIntentPacks(input: { tenant_id: string; workspace_id?: string; limit?: number }): unknown[] {
    const ws = input.workspace_id ?? 'default';
    const limit = input.limit ?? 50;
    return all(this.db, `SELECT * FROM tenant_geo_intent_packs WHERE tenant_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?`, [input.tenant_id, ws, limit]).map((row: Record<string, unknown>) => ({
      ...row,
      platform_targets: parseJson(row.platform_targets as string, []),
      question_clusters: parseJson(row.question_clusters as string, []),
    }));
  }

  createContentPlan(input: {
    tenant_id: string;
    workspace_id?: string;
    intent_pack_id?: string;
    content_type: 'explainer' | 'comparison' | 'ranking' | 'faq_expansion' | 'how_to';
    target_questions?: string[];
    kb_source_refs?: string[];
    competitor_refs?: string[];
    word_count_target?: number;
    heading_count_target?: number;
    evidence_blocks_required?: unknown[];
    priority?: 'p0' | 'p1' | 'p2';
  }): string {
    const planId = id('gcp');
    run(this.db, `INSERT INTO tenant_geo_content_plans (id, tenant_id, workspace_id, intent_pack_id, content_type, target_questions, kb_source_refs, competitor_refs, word_count_target, heading_count_target, evidence_blocks_required, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      planId,
      input.tenant_id,
      input.workspace_id ?? 'default',
      input.intent_pack_id ?? null,
      input.content_type,
      json(input.target_questions ?? []),
      json(input.kb_source_refs ?? []),
      json(input.competitor_refs ?? []),
      input.word_count_target ?? 1000,
      input.heading_count_target ?? 6,
      json(input.evidence_blocks_required ?? []),
      input.priority ?? 'p1',
    ]);
    return planId;
  }

  listContentPlans(input: { tenant_id: string; workspace_id?: string; priority?: string; status?: string }): unknown[] {
    const ws = input.workspace_id ?? 'default';
    let sql = `SELECT * FROM tenant_geo_content_plans WHERE tenant_id = ? AND workspace_id = ?`;
    const params: unknown[] = [input.tenant_id, ws];
    if (input.priority) { sql += ` AND priority = ?`; params.push(input.priority); }
    if (input.status) { sql += ` AND status = ?`; params.push(input.status); }
    sql += ` ORDER BY priority, created_at DESC`;
    return all(this.db, sql, params as string[]).map((row: Record<string, unknown>) => ({
      ...row,
      target_questions: parseJson(row.target_questions as string, []),
      kb_source_refs: parseJson(row.kb_source_refs as string, []),
      competitor_refs: parseJson(row.competitor_refs as string, []),
      evidence_blocks_required: parseJson(row.evidence_blocks_required as string, []),
    }));
  }

  updateContentPlanStatus(planId: string, status: string): void {
    run(this.db, `UPDATE tenant_geo_content_plans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, planId]);
  }

  createArticleDraft(input: {
    tenant_id: string;
    workspace_id?: string;
    content_plan_id?: string;
    title: string;
    markdown_content?: string;
    schema_org_json?: Record<string, unknown>;
    llms_txt_entry?: string;
    og_meta?: Record<string, unknown>;
    geo_quality_score?: Record<string, unknown>;
  }): string {
    const articleId = id('gca');
    run(this.db, `INSERT INTO tenant_geo_article_drafts (id, tenant_id, workspace_id, content_plan_id, title, markdown_content, schema_org_json, llms_txt_entry, og_meta, geo_quality_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      articleId,
      input.tenant_id,
      input.workspace_id ?? 'default',
      input.content_plan_id ?? null,
      input.title,
      input.markdown_content ?? '',
      json(input.schema_org_json ?? {}),
      input.llms_txt_entry ?? '',
      json(input.og_meta ?? {}),
      json(input.geo_quality_score ?? {}),
    ]);
    return articleId;
  }

  updateArticleDraft(articleId: string, updates: {
    title?: string;
    markdown_content?: string;
    schema_org_json?: Record<string, unknown>;
    llms_txt_entry?: string;
    og_meta?: Record<string, unknown>;
    geo_quality_score?: Record<string, unknown>;
    publish_status?: string;
  }): void {
    const fields: string[] = [];
    const params: unknown[] = [];
    if (updates.title !== undefined) { fields.push('title = ?'); params.push(updates.title); }
    if (updates.markdown_content !== undefined) { fields.push('markdown_content = ?'); params.push(updates.markdown_content); }
    if (updates.schema_org_json !== undefined) { fields.push('schema_org_json = ?'); params.push(json(updates.schema_org_json)); }
    if (updates.llms_txt_entry !== undefined) { fields.push('llms_txt_entry = ?'); params.push(updates.llms_txt_entry); }
    if (updates.og_meta !== undefined) { fields.push('og_meta = ?'); params.push(json(updates.og_meta)); }
    if (updates.geo_quality_score !== undefined) { fields.push('geo_quality_score = ?'); params.push(json(updates.geo_quality_score)); }
    if (updates.publish_status !== undefined) { fields.push('publish_status = ?'); params.push(updates.publish_status); }
    if (!fields.length) return;
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(articleId);
    run(this.db, `UPDATE tenant_geo_article_drafts SET ${fields.join(', ')} WHERE id = ?`, params as string[]);
  }

  updateArticleGeoflowStatus(articleId: string, geoflowPushStatus: string, geoflowArticleId?: string): void {
    run(this.db, `UPDATE tenant_geo_article_drafts SET geoflow_push_status = ?, geoflow_article_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [geoflowPushStatus, geoflowArticleId ?? null, articleId]);
  }

  listArticleDrafts(input: { tenant_id: string; workspace_id?: string; publish_status?: string }): unknown[] {
    const ws = input.workspace_id ?? 'default';
    let sql = `SELECT * FROM tenant_geo_article_drafts WHERE tenant_id = ? AND workspace_id = ?`;
    const params: unknown[] = [input.tenant_id, ws];
    if (input.publish_status) { sql += ` AND publish_status = ?`; params.push(input.publish_status); }
    sql += ` ORDER BY created_at DESC`;
    return all(this.db, sql, params as string[]).map((row: Record<string, unknown>) => ({
      ...row,
      schema_org_json: parseJson(row.schema_org_json as string, {}),
      og_meta: parseJson(row.og_meta as string, {}),
      geo_quality_score: parseJson(row.geo_quality_score as string, {}),
    }));
  }

  getArticleDraft(articleId: string): unknown | null {
    const row = one(this.db, `SELECT * FROM tenant_geo_article_drafts WHERE id = ?`, [articleId]) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      ...row,
      schema_org_json: parseJson(row.schema_org_json as string, {}),
      og_meta: parseJson(row.og_meta as string, {}),
      geo_quality_score: parseJson(row.geo_quality_score as string, {}),
    };
  }
}
