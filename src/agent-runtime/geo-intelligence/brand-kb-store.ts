import { all, id, json, one, parseJson, run } from '../../db.js';
import type { BrandCase, BrandEntity, BrandFactCard, BrandFaqEntry, BrandKbCompleteness, ScriptKbContext } from './types.js';

type BrandEntityInput =
  Omit<BrandEntity, 'id' | 'created_at' | 'updated_at' | 'workspace_id' | 'entity_metadata'> &
  Partial<Pick<BrandEntity, 'workspace_id' | 'entity_metadata'>>;

type BrandFactCardInput =
  Omit<BrandFactCard, 'id' | 'created_at' | 'updated_at' | 'workspace_id' | 'entity_ids'> &
  Partial<Pick<BrandFactCard, 'workspace_id' | 'entity_ids'>>;

export class BrandKbStore {
  constructor(private db: unknown) {}

  // ─── Entities ────────────────────────────────────────────────────────────────

  upsertEntity(input: BrandEntityInput): string {
    const entityId = id('bke');
    run(
      this.db,
      `INSERT INTO tenant_brand_entities
         (id, tenant_id, workspace_id, entity_type, entity_name, entity_description,
          entity_metadata, source_url, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        entityId,
        input.tenant_id,
        input.workspace_id ?? 'default',
        input.entity_type,
        input.entity_name,
        input.entity_description ?? null,
        json(input.entity_metadata ?? {}),
        input.source_url ?? null,
        input.verified ? 1 : 0,
      ]
    );
    return entityId;
  }

  listEntities(input: { tenant_id: string; workspace_id?: string }): BrandEntity[] {
    const ws = input.workspace_id ?? 'default';
    return all(
      this.db,
      `SELECT * FROM tenant_brand_entities WHERE tenant_id = ? AND workspace_id = ? ORDER BY entity_type, entity_name`,
      [input.tenant_id, ws]
    ).map((row: Record<string, unknown>) => ({
      ...row,
      entity_metadata: parseJson(row.entity_metadata as string, {}),
      verified: Boolean(row.verified),
    })) as BrandEntity[];
  }

  // ─── Fact Cards ───────────────────────────────────────────────────────────────

  upsertFactCard(input: BrandFactCardInput): string {
    const cardId = id('bkf');
    run(
      this.db,
      `INSERT INTO tenant_brand_fact_cards
         (id, tenant_id, workspace_id, fact_type, fact_content, fact_evidence,
          source_url, citability_score, verified, entity_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        cardId,
        input.tenant_id,
        input.workspace_id ?? 'default',
        input.fact_type,
        input.fact_content,
        input.fact_evidence ?? null,
        input.source_url ?? null,
        input.citability_score,
        input.verified ? 1 : 0,
        json(input.entity_ids ?? []),
      ]
    );
    return cardId;
  }

  listFactCards(input: { tenant_id: string; workspace_id?: string; min_citability?: number }): BrandFactCard[] {
    const ws = input.workspace_id ?? 'default';
    const minCit = input.min_citability ?? 0;
    return all(
      this.db,
      `SELECT * FROM tenant_brand_fact_cards
       WHERE tenant_id = ? AND workspace_id = ? AND citability_score >= ?
       ORDER BY citability_score DESC`,
      [input.tenant_id, ws, minCit]
    ).map((row: Record<string, unknown>) => ({
      ...row,
      entity_ids: parseJson(row.entity_ids as string, []),
      verified: Boolean(row.verified),
    })) as BrandFactCard[];
  }

  // ─── Cases ───────────────────────────────────────────────────────────────────

  upsertCase(input: Omit<BrandCase, 'id' | 'created_at'>): string {
    const caseId = id('bkc');
    run(
      this.db,
      `INSERT INTO tenant_brand_cases
         (id, tenant_id, workspace_id, case_title, customer_profile, problem_description,
          solution_description, outcome_metrics, outcome_quote, source_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        caseId,
        input.tenant_id,
        input.workspace_id ?? 'default',
        input.case_title,
        input.customer_profile ?? null,
        input.problem_description ?? null,
        input.solution_description ?? null,
        json(input.outcome_metrics ?? {}),
        input.outcome_quote ?? null,
        input.source_url ?? null,
      ]
    );
    return caseId;
  }

  listCases(input: { tenant_id: string; workspace_id?: string; limit?: number }): BrandCase[] {
    const ws = input.workspace_id ?? 'default';
    const limit = input.limit ?? 50;
    return all(
      this.db,
      `SELECT * FROM tenant_brand_cases WHERE tenant_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
      [input.tenant_id, ws, limit]
    ).map((row: Record<string, unknown>) => ({
      ...row,
      outcome_metrics: parseJson(row.outcome_metrics as string, {}),
    })) as BrandCase[];
  }

  // ─── FAQ ─────────────────────────────────────────────────────────────────────

  upsertFaqEntry(input: Omit<BrandFaqEntry, 'id' | 'times_asked' | 'created_at' | 'updated_at'>): string {
    const faqId = id('bkq');
    run(
      this.db,
      `INSERT INTO tenant_brand_faq_entries
         (id, tenant_id, workspace_id, question, answer, objection_type,
          call_outcome_source_id, times_asked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        faqId,
        input.tenant_id,
        input.workspace_id ?? 'default',
        input.question,
        input.answer,
        input.objection_type,
        input.call_outcome_source_id ?? null,
      ]
    );
    return faqId;
  }

  incrementFaqAsked(faqId: string): void {
    run(this.db, `UPDATE tenant_brand_faq_entries SET times_asked = times_asked + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [faqId]);
  }

  listFaqEntries(input: { tenant_id: string; workspace_id?: string; objection_type?: string }): BrandFaqEntry[] {
    const ws = input.workspace_id ?? 'default';
    if (input.objection_type) {
      return all(
        this.db,
        `SELECT * FROM tenant_brand_faq_entries WHERE tenant_id = ? AND workspace_id = ? AND objection_type = ? ORDER BY times_asked DESC`,
        [input.tenant_id, ws, input.objection_type]
      ) as BrandFaqEntry[];
    }
    return all(
      this.db,
      `SELECT * FROM tenant_brand_faq_entries WHERE tenant_id = ? AND workspace_id = ? ORDER BY times_asked DESC`,
      [input.tenant_id, ws]
    ) as BrandFaqEntry[];
  }

  // ─── Completeness ─────────────────────────────────────────────────────────────

  computeAndSaveCompleteness(input: { tenant_id: string; workspace_id?: string }): BrandKbCompleteness {
    const ws = input.workspace_id ?? 'default';
    const { tenant_id } = input;

    const entityCount = (one(this.db, `SELECT COUNT(*) as c FROM tenant_brand_entities WHERE tenant_id = ? AND workspace_id = ?`, [tenant_id, ws])?.c ?? 0) as number;
    const factCount = (one(this.db, `SELECT COUNT(*) as c FROM tenant_brand_fact_cards WHERE tenant_id = ? AND workspace_id = ?`, [tenant_id, ws])?.c ?? 0) as number;
    const caseCount = (one(this.db, `SELECT COUNT(*) as c FROM tenant_brand_cases WHERE tenant_id = ? AND workspace_id = ?`, [tenant_id, ws])?.c ?? 0) as number;
    const faqCount = (one(this.db, `SELECT COUNT(*) as c FROM tenant_brand_faq_entries WHERE tenant_id = ? AND workspace_id = ?`, [tenant_id, ws])?.c ?? 0) as number;

    // Score: normalized against target counts (entity≥3, facts≥5, cases≥2, faq≥5)
    const entityScore = Math.min(Number(entityCount) / 3, 1);
    const factCardScore = Math.min(Number(factCount) / 5, 1);
    const caseScore = Math.min(Number(caseCount) / 2, 1);
    const faqScore = Math.min(Number(faqCount) / 5, 1);
    const overallScore = (entityScore + factCardScore + caseScore + faqScore) / 4;

    const missingItems: string[] = [];
    if (Number(entityCount) < 3) missingItems.push(`需要至少 3 个品牌实体（当前 ${entityCount}）`);
    if (Number(factCount) < 5) missingItems.push(`需要至少 5 条事实卡片（当前 ${factCount}）`);
    if (Number(caseCount) < 2) missingItems.push(`需要至少 2 个成功案例（当前 ${caseCount}）`);
    if (Number(faqCount) < 5) missingItems.push(`需要至少 5 条 FAQ（当前 ${faqCount}）`);

    const compId = id('bkx');
    run(
      this.db,
      `INSERT INTO tenant_brand_kb_completeness
         (id, tenant_id, workspace_id, entity_score, fact_card_score, case_score, faq_score, overall_score, missing_items, last_scored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(tenant_id, workspace_id) DO UPDATE SET
         entity_score = excluded.entity_score,
         fact_card_score = excluded.fact_card_score,
         case_score = excluded.case_score,
         faq_score = excluded.faq_score,
         overall_score = excluded.overall_score,
         missing_items = excluded.missing_items,
         last_scored_at = CURRENT_TIMESTAMP`,
      [compId, tenant_id, ws, entityScore, factCardScore, caseScore, faqScore, overallScore, json(missingItems)]
    );

    return {
      id: compId,
      tenant_id,
      workspace_id: ws,
      entity_score: entityScore,
      fact_card_score: factCardScore,
      case_score: caseScore,
      faq_score: faqScore,
      overall_score: overallScore,
      missing_items: missingItems,
      last_scored_at: new Date().toISOString(),
    };
  }

  getCompleteness(input: { tenant_id: string; workspace_id?: string }): BrandKbCompleteness | null {
    const ws = input.workspace_id ?? 'default';
    const row = one(
      this.db,
      `SELECT * FROM tenant_brand_kb_completeness WHERE tenant_id = ? AND workspace_id = ?`,
      [input.tenant_id, ws]
    ) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      tenant_id: String(row.tenant_id),
      workspace_id: String(row.workspace_id),
      entity_score: Number(row.entity_score),
      fact_card_score: Number(row.fact_card_score),
      case_score: Number(row.case_score),
      faq_score: Number(row.faq_score),
      overall_score: Number(row.overall_score),
      missing_items: parseJson(row.missing_items as string, []),
      last_scored_at: row.last_scored_at == null ? undefined : String(row.last_scored_at),
    };
  }

  // ─── Script Context ───────────────────────────────────────────────────────────

  buildScriptKbContext(input: { tenant_id: string; workspace_id?: string }): ScriptKbContext {
    const ws = input.workspace_id ?? 'default';
    const facts = this.listFactCards({ tenant_id: input.tenant_id, workspace_id: ws, min_citability: 0.6 });
    const cases = this.listCases({ tenant_id: input.tenant_id, workspace_id: ws, limit: 3 });
    const faqs = this.listFaqEntries({ tenant_id: input.tenant_id, workspace_id: ws });
    const completeness = this.getCompleteness({ tenant_id: input.tenant_id, workspace_id: ws });

    return {
      key_facts: facts.slice(0, 5).map((f) => ({
        fact_type: f.fact_type,
        fact_content: f.fact_content,
        fact_evidence: f.fact_evidence,
      })),
      top_cases: cases.map((c) => ({
        case_title: c.case_title,
        outcome_quote: c.outcome_quote,
        outcome_metrics: c.outcome_metrics,
      })),
      faq_answers: faqs.slice(0, 10).map((f) => ({
        question: f.question,
        answer: f.answer,
        objection_type: f.objection_type,
      })),
      kb_completeness_score: completeness?.overall_score ?? 0,
    };
  }
}
