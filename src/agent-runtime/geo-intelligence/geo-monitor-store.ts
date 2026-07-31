import { all, id, json, one, parseJson, run } from '../../db.js';

export interface GeoVisibilityReport {
  report_id: string;
  period: 'weekly' | 'monthly';
  generated_at: string;
  overall_visibility_score: number;
  total_snapshots: number;
  cited_count: number;
  platform_breakdown: { platform: string; citation_rate: number; snapshot_count: number }[];
  fact_correction_count: number;
  recommended_actions: string[];
}

export class GeoMonitorStore {
  constructor(private db: unknown) {}

  createMonitoringTask(input: {
    tenant_id: string;
    workspace_id?: string;
    task_type: 'brand' | 'industry' | 'competitor' | 'intent';
    query_text: string;
    target_platforms?: string[];
    sampling_count?: number;
    schedule_cron?: string;
  }): string {
    const taskId = id('gmt');
    run(this.db, `INSERT INTO tenant_geo_monitoring_tasks (id, tenant_id, workspace_id, task_type, query_text, target_platforms, sampling_count, schedule_cron) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      taskId,
      input.tenant_id,
      input.workspace_id ?? 'default',
      input.task_type,
      input.query_text,
      json(input.target_platforms ?? ['deepseek','doubao','qianwen','kimi','yuanbao']),
      input.sampling_count ?? 3,
      input.schedule_cron ?? '0 0 * * 1',
    ]);
    return taskId;
  }

  listMonitoringTasks(input: { tenant_id: string; workspace_id?: string; active?: boolean }): unknown[] {
    const ws = input.workspace_id ?? 'default';
    let sql = `SELECT * FROM tenant_geo_monitoring_tasks WHERE tenant_id = ? AND workspace_id = ?`;
    const params: unknown[] = [input.tenant_id, ws];
    if (input.active !== undefined) { sql += ` AND active = ?`; params.push(input.active ? 1 : 0); }
    sql += ` ORDER BY created_at DESC`;
    return all(this.db, sql, params as string[]).map((row: Record<string, unknown>) => ({
      ...row,
      target_platforms: parseJson(row.target_platforms as string, []),
      active: Boolean(row.active),
    }));
  }

  recordSnapshot(input: {
    tenant_id: string;
    workspace_id?: string;
    monitoring_task_id?: string;
    platform: string;
    query_text: string;
    cited: boolean | number;
    citation_position?: number;
    citation_excerpt?: string;
    cited_url?: string;
    competitor_citations?: Record<string, unknown>;
  }): string {
    const snapId = id('gvs');
    run(this.db, `INSERT INTO tenant_geo_visibility_snapshots (id, tenant_id, workspace_id, monitoring_task_id, platform, query_text, cited, citation_position, citation_excerpt, cited_url, competitor_citations) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      snapId,
      input.tenant_id,
      input.workspace_id ?? 'default',
      input.monitoring_task_id ?? null,
      input.platform,
      input.query_text,
      input.cited ? 1 : 0,
      input.citation_position ?? null,
      input.citation_excerpt ?? null,
      input.cited_url ?? null,
      json(input.competitor_citations ?? {}),
    ]);
    return snapId;
  }

  listSnapshots(input: { tenant_id: string; workspace_id?: string; platform?: string; cited_only?: boolean; limit?: number }): unknown[] {
    const ws = input.workspace_id ?? 'default';
    const limit = input.limit ?? 100;
    let sql = `SELECT * FROM tenant_geo_visibility_snapshots WHERE tenant_id = ? AND workspace_id = ?`;
    const params: unknown[] = [input.tenant_id, ws];
    if (input.platform) { sql += ` AND platform = ?`; params.push(input.platform); }
    if (input.cited_only) { sql += ` AND cited = 1`; }
    sql += ` ORDER BY sampled_at DESC LIMIT ?`;
    params.push(limit);
    return all(this.db, sql, params as string[]).map((row: Record<string, unknown>) => ({
      ...row,
      cited: Boolean(row.cited),
      competitor_citations: parseJson(row.competitor_citations as string, {}),
    }));
  }

  createFactCorrectionEntry(input: {
    tenant_id: string;
    workspace_id?: string;
    snapshot_id?: string;
    platform?: string;
    ai_stated_fact: string;
    correct_fact_ref?: string;
    discrepancy_type: 'wrong_number' | 'wrong_claim' | 'outdated' | 'missing';
  }): string {
    const corrId = id('gfc');
    run(this.db, `INSERT INTO tenant_geo_fact_correction_queue (id, tenant_id, workspace_id, snapshot_id, platform, ai_stated_fact, correct_fact_ref, discrepancy_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      corrId,
      input.tenant_id,
      input.workspace_id ?? 'default',
      input.snapshot_id ?? null,
      input.platform ?? null,
      input.ai_stated_fact,
      input.correct_fact_ref ?? null,
      input.discrepancy_type,
    ]);
    return corrId;
  }

  listFactCorrections(input: { tenant_id: string; workspace_id?: string; correction_status?: string }): unknown[] {
    const ws = input.workspace_id ?? 'default';
    let sql = `SELECT * FROM tenant_geo_fact_correction_queue WHERE tenant_id = ? AND workspace_id = ?`;
    const params: unknown[] = [input.tenant_id, ws];
    if (input.correction_status) { sql += ` AND correction_status = ?`; params.push(input.correction_status); }
    sql += ` ORDER BY created_at DESC`;
    return all(this.db, sql, params as string[]) as unknown[];
  }

  updateCorrectionStatus(correctionId: string, status: string): void {
    run(this.db, `UPDATE tenant_geo_fact_correction_queue SET correction_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, correctionId]);
  }

  generateVisibilityReport(input: { tenant_id: string; workspace_id?: string; period: 'weekly' | 'monthly' }): GeoVisibilityReport {
    const ws = input.workspace_id ?? 'default';
    const days = input.period === 'weekly' ? 7 : 30;

    const snapshots = all(this.db,
      `SELECT * FROM tenant_geo_visibility_snapshots WHERE tenant_id = ? AND workspace_id = ? AND sampled_at > datetime('now', ?)`,
      [input.tenant_id, ws, `-${days} days`]
    ) as Record<string, unknown>[];

    const total = snapshots.length;
    const cited = snapshots.filter(s => Boolean(s.cited)).length;
    const overallScore = total > 0 ? cited / total : 0;

    // Platform breakdown
    const byPlatform = new Map<string, { cited: number; total: number }>();
    for (const snap of snapshots) {
      const platform = String(snap.platform);
      if (!byPlatform.has(platform)) byPlatform.set(platform, { cited: 0, total: 0 });
      const entry = byPlatform.get(platform)!;
      entry.total++;
      if (Boolean(snap.cited)) entry.cited++;
    }
    const platform_breakdown = Array.from(byPlatform.entries()).map(([platform, stats]) => ({
      platform,
      citation_rate: stats.total > 0 ? stats.cited / stats.total : 0,
      snapshot_count: stats.total,
    }));

    const correctionCount = (one(this.db,
      `SELECT COUNT(*) as c FROM tenant_geo_fact_correction_queue WHERE tenant_id = ? AND workspace_id = ? AND correction_status = 'pending'`,
      [input.tenant_id, ws]
    )?.c ?? 0) as number;

    const recommended_actions: string[] = [];
    if (overallScore < 0.3) recommended_actions.push('立即增加品牌内容覆盖');
    else if (overallScore < 0.6) recommended_actions.push('增加高质量内容以提升引用率');
    if (Number(correctionCount) > 0) recommended_actions.push(`处理 ${correctionCount} 条事实偏差`);
    if (total === 0) recommended_actions.push('开始监控品牌曝光度');

    return {
      report_id: id('gvr'),
      period: input.period,
      generated_at: new Date().toISOString(),
      overall_visibility_score: overallScore,
      total_snapshots: total,
      cited_count: cited,
      platform_breakdown,
      fact_correction_count: Number(correctionCount),
      recommended_actions,
    };
  }
}
