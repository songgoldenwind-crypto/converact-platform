import { all, id, json, one, parseJson, run } from '../../db.js';
import type { BrandKbStore } from './brand-kb-store.js';
import type { GeoMonitorStore } from './geo-monitor-store.js';
import type { GeoContentStore } from './geo-content-store.js';

export interface FlywheelReviewResult {
  review_id: string;
  triggered_at: string;
  outbound_to_geo_signals: { signal_type: string; source_ref: string; content_task_created: boolean; objection_type?: string }[];
  geo_to_outbound_signals: { signal_type: string; snapshot_ref: string; leads_updated: number; score_delta: number }[];
  kb_gap_tasks: { dimension: string; fill_priority: string; suggested_content: string }[];
  flywheel_health_score: number;
  created_at: string;
}

export class GeoFlywheelStore {
  constructor(
    private db: unknown,
    private brandKbStore: BrandKbStore,
    private geoMonitorStore: GeoMonitorStore,
    private geoContentStore: GeoContentStore
  ) {}

  runFlywheelReview(input: {
    tenant_id: string;
    workspace_id?: string;
    triggered_at?: string;
    source_ref?: string;
  }): FlywheelReviewResult {
    const ws = input.workspace_id ?? 'default';
    const { tenant_id } = input;
    const triggeredAt = input.triggered_at ?? 'manual';

    // 1. outbound_to_geo_signals: Check FAQ coverage for objection types
    const objectionTypes = ['price', 'trust', 'competitor', 'timing', 'need'] as const;
    const faqCounts = new Map<string, number>();
    for (const objType of objectionTypes) {
      const entries = this.brandKbStore.listFaqEntries({ tenant_id, workspace_id: ws, objection_type: objType });
      faqCounts.set(objType, entries.length);
    }
    const outbound_to_geo_signals = objectionTypes
      .filter(ot => (faqCounts.get(ot) ?? 0) === 0)
      .map(ot => ({
        signal_type: 'faq_gap',
        source_ref: `objection_${ot}`,
        content_task_created: false,
        objection_type: ot,
      }));

    // 2. geo_to_outbound_signals: Cited snapshots from last 7 days → update leads
    const citedSnapshots = all(
      this.db,
      `SELECT * FROM tenant_geo_visibility_snapshots WHERE tenant_id = ? AND workspace_id = ? AND cited = 1 AND sampled_at > datetime('now', '-7 days') LIMIT 20`,
      [tenant_id, ws]
    ) as Record<string, unknown>[];

    let leadsUpdatedTotal = 0;
    if (citedSnapshots.length > 0) {
      // Apply warmth bonus to leads (max 1 per flywheel review)
      // SQLite doesn't support LIMIT in UPDATE directly, use subquery
      const updateResult = run(
        this.db,
        `UPDATE leads SET score_total = MIN(score_total + 10, 100) 
         WHERE tenant_id = ? AND score_total < 100 
         AND id = (SELECT id FROM leads WHERE tenant_id = ? AND score_total < 100 LIMIT 1)`,
        [tenant_id, tenant_id]
      );
      leadsUpdatedTotal = (updateResult as { changes?: number })?.changes ?? 0;
    }

    const geo_to_outbound_signals = citedSnapshots.map(snap => ({
      signal_type: 'citation_signal',
      snapshot_ref: String(snap.id),
      leads_updated: leadsUpdatedTotal,
      score_delta: 10,
    }));

    // 3. kb_gap_tasks from completeness
    const completeness = this.brandKbStore.computeAndSaveCompleteness({ tenant_id, workspace_id: ws });
    const kb_gap_tasks = (completeness.missing_items ?? []).map((item: string) => ({
      dimension: 'entity',
      fill_priority: 'p0',
      suggested_content: item,
    }));

    // 4. flywheel_health_score
    const totalSnapshots = (one(
      this.db,
      `SELECT COUNT(*) as c FROM tenant_geo_visibility_snapshots WHERE tenant_id = ? AND workspace_id = ? AND sampled_at > datetime('now', '-7 days')`,
      [tenant_id, ws]
    )?.c ?? 0) as number;
    const citedCount = citedSnapshots.length;
    const visibilityRatio = Number(totalSnapshots) > 0 ? citedCount / Number(totalSnapshots) : 0;
    const contentPlans = this.geoContentStore.listContentPlans({ tenant_id, workspace_id: ws });
    const contentPlansScore = contentPlans.length > 0 ? 0.5 : 0;
    const flywheel_health_score = (completeness.overall_score + visibilityRatio + contentPlansScore) / 3;

    // 5. Save review
    const reviewId = id('gfw');
    const createdAt = new Date().toISOString();
    run(this.db, `INSERT INTO tenant_geo_flywheel_reviews (id, tenant_id, workspace_id, triggered_at, source_ref, outbound_to_geo_signals, geo_to_outbound_signals, kb_gap_tasks, flywheel_health_score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      reviewId,
      tenant_id,
      ws,
      triggeredAt,
      input.source_ref ?? null,
      json(outbound_to_geo_signals),
      json(geo_to_outbound_signals),
      json(kb_gap_tasks),
      flywheel_health_score,
      createdAt,
    ]);

    return {
      review_id: reviewId,
      triggered_at: triggeredAt,
      outbound_to_geo_signals,
      geo_to_outbound_signals,
      kb_gap_tasks,
      flywheel_health_score,
      created_at: createdAt,
    };
  }

  listFlywheelReviews(input: { tenant_id: string; workspace_id?: string; limit?: number }): unknown[] {
    const ws = input.workspace_id ?? 'default';
    const limit = input.limit ?? 50;
    return all(this.db, `SELECT * FROM tenant_geo_flywheel_reviews WHERE tenant_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?`, [input.tenant_id, ws, limit]).map((row: Record<string, unknown>) => ({
      ...row,
      outbound_to_geo_signals: parseJson(row.outbound_to_geo_signals as string, []),
      geo_to_outbound_signals: parseJson(row.geo_to_outbound_signals as string, []),
      kb_gap_tasks: parseJson(row.kb_gap_tasks as string, []),
    }));
  }
}
