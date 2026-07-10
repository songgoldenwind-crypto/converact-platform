import { all, id, json, one, parseJson, run } from '../../../db.js';
import type { QmScores } from './qm-policy.js';

export interface QmEvaluation {
  id: string;
  tenant_id: string;
  call_session_id: string;
  evaluator: string;
  scores: QmScores;
  violations: string[];
  summary: string;
  recommendation: string;
  overall_score: number;
  evaluated_at: string;
  created_at: string;
}

export interface CreateQmEvaluationInput {
  tenant_id: string;
  call_session_id: string;
  evaluator?: string;
  scores: QmScores;
  violations?: string[];
  summary: string;
  recommendation?: string;
  overall_score: number;
}

export interface QmDashboard {
  total_evaluations: number;
  average_score: number;
  violation_count: number;
  score_distribution: { bucket: string; count: number }[];
  recent_low_scores: QmEvaluation[];
}

export interface QmDashboardViewModel {
  score_distribution: { range: string; count: number }[];
  low_score_calls: Array<{ id: string; phone: string; score: number; reason: string }>;
  dimension_averages: Array<{ dimension: string; score: number }>;
  overall_average: number;
  total_evaluations: number;
  violation_count: number;
}

export interface QmAppeal {
  id: string;
  tenant_id: string;
  evaluation_id: string;
  call_session_id: string;
  appellant_user_id: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewer_user_id: string | null;
  resolution_notes: string | null;
  created_at: string;
  resolved_at: string | null;
}

export class QmStore {
  constructor(private readonly db: unknown) {
    (db as { exec(sql: string): void }).exec(`
      CREATE TABLE IF NOT EXISTS qm_evaluations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        call_session_id TEXT NOT NULL,
        evaluator TEXT NOT NULL DEFAULT 'llm',
        scores TEXT NOT NULL DEFAULT '{}',
        violations TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        recommendation TEXT NOT NULL DEFAULT '',
        overall_score REAL NOT NULL DEFAULT 0,
        evaluated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_qm_evaluations_tenant ON qm_evaluations(tenant_id, evaluated_at);
      CREATE INDEX IF NOT EXISTS idx_qm_evaluations_session ON qm_evaluations(call_session_id);
    `);
  }

  createEvaluation(input: CreateQmEvaluationInput): QmEvaluation {
    const evalId = id('qmeval');
    const now = new Date().toISOString();
    run(
      this.db,
      `INSERT INTO qm_evaluations
        (id, tenant_id, call_session_id, evaluator, scores, violations, summary, recommendation, overall_score, evaluated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evalId,
        input.tenant_id,
        input.call_session_id,
        input.evaluator ?? 'llm',
        json(input.scores),
        json(input.violations ?? []),
        input.summary,
        input.recommendation ?? '',
        input.overall_score,
        now,
        now
      ]
    );
    return {
      id: evalId,
      tenant_id: input.tenant_id,
      call_session_id: input.call_session_id,
      evaluator: input.evaluator ?? 'llm',
      scores: input.scores,
      violations: input.violations ?? [],
      summary: input.summary,
      recommendation: input.recommendation ?? '',
      overall_score: input.overall_score,
      evaluated_at: now,
      created_at: now
    };
  }

  getEvaluation(evalId: string): QmEvaluation | null {
    const row = one(this.db, 'SELECT * FROM qm_evaluations WHERE id = ?', [evalId]);
    return row ? decodeEvaluation(row) : null;
  }

  getEvaluationBySession(callSessionId: string): QmEvaluation | null {
    const row = one(
      this.db,
      'SELECT * FROM qm_evaluations WHERE call_session_id = ? ORDER BY evaluated_at DESC LIMIT 1',
      [callSessionId]
    );
    return row ? decodeEvaluation(row) : null;
  }

  listEvaluations(
    tenantId: string,
    opts?: { limit?: number; minScore?: number; maxScore?: number }
  ): QmEvaluation[] {
    const conditions = ['tenant_id = ?'];
    const params: (string | number)[] = [tenantId];

    if (opts?.minScore != null) {
      conditions.push('overall_score >= ?');
      params.push(opts.minScore);
    }
    if (opts?.maxScore != null) {
      conditions.push('overall_score <= ?');
      params.push(opts.maxScore);
    }

    const limit = opts?.limit ?? 50;
    const sql = `SELECT * FROM qm_evaluations WHERE ${conditions.join(' AND ')} ORDER BY evaluated_at DESC LIMIT ?`;
    params.push(limit);

    return all(this.db, sql, params).map(decodeEvaluation);
  }

  getDashboard(tenantId: string): QmDashboard {
    const stats = one(
      this.db,
      `SELECT COUNT(*) AS total, COALESCE(AVG(overall_score), 0) AS avg_score
       FROM qm_evaluations WHERE tenant_id = ?`,
      [tenantId]
    );

    const violationRow = one(
      this.db,
      `SELECT COUNT(*) AS cnt FROM qm_evaluations
       WHERE tenant_id = ? AND violations != '[]'`,
      [tenantId]
    );

    const buckets = all(
      this.db,
      `SELECT
        CASE
          WHEN overall_score >= 0.9 THEN '0.9-1.0'
          WHEN overall_score >= 0.7 THEN '0.7-0.9'
          WHEN overall_score >= 0.5 THEN '0.5-0.7'
          ELSE '0.0-0.5'
        END AS bucket,
        COUNT(*) AS count
       FROM qm_evaluations WHERE tenant_id = ?
       GROUP BY bucket ORDER BY bucket DESC`,
      [tenantId]
    );

    const lowScores = all(
      this.db,
      `SELECT * FROM qm_evaluations WHERE tenant_id = ? AND overall_score < 0.5
       ORDER BY evaluated_at DESC LIMIT 5`,
      [tenantId]
    ).map(decodeEvaluation);

    return {
      total_evaluations: Number(stats?.total ?? 0),
      average_score: Number(stats?.avg_score ?? 0),
      violation_count: Number(violationRow?.cnt ?? 0),
      score_distribution: buckets.map((b) => ({
        bucket: String(b.bucket),
        count: Number(b.count)
      })),
      recent_low_scores: lowScores
    };
  }

  getDashboardViewModel(tenantId: string): QmDashboardViewModel {
    const dashboard = this.getDashboard(tenantId);
    const rows = all(
      this.db,
      'SELECT scores FROM qm_evaluations WHERE tenant_id = ?',
      [tenantId]
    );

    const totals = {
      politeness: 0,
      compliance: 0,
      problem_resolution: 0,
      upsell_effectiveness: 0,
      script_adherence: 0
    };
    let count = 0;
    for (const row of rows) {
      const scores = parseJson<Record<string, number>>(String((row as { scores: string }).scores), {});
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
        totals[key] += Number(scores[key] || 0);
      }
      count += 1;
    }

    const dimension_averages = (Object.keys(totals) as (keyof typeof totals)[]).map((dimension) => ({
      dimension,
      score: count > 0 ? (totals[dimension] / count) * 100 : 0
    }));

    const low_score_calls = dashboard.recent_low_scores.map((item) => ({
      id: item.call_session_id,
      phone: item.call_session_id.slice(-8),
      score: Math.round(item.overall_score * 100),
      reason: item.violations[0] || item.summary || '低分通话'
    }));

    return {
      score_distribution: dashboard.score_distribution.map((item) => ({
        range: item.bucket,
        count: item.count
      })),
      low_score_calls,
      dimension_averages,
      overall_average: dashboard.average_score * 100,
      total_evaluations: dashboard.total_evaluations,
      violation_count: dashboard.violation_count
    };
  }

  createAppeal(input: {
    tenant_id: string;
    evaluation_id: string;
    call_session_id: string;
    appellant_user_id: string;
    reason: string;
  }): QmAppeal {
    const appealId = id('qmappeal');
    run(
      this.db,
      `INSERT INTO qm_appeals
        (id, tenant_id, evaluation_id, call_session_id, appellant_user_id, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [
        appealId,
        input.tenant_id,
        input.evaluation_id,
        input.call_session_id,
        input.appellant_user_id,
        input.reason
      ]
    );
    return this.getAppeal(appealId)!;
  }

  getAppeal(appealId: string): QmAppeal | null {
    const row = one(this.db, 'SELECT * FROM qm_appeals WHERE id = ?', [appealId]);
    return row ? decodeAppeal(row as Record<string, unknown>) : null;
  }

  listAppeals(tenantId: string, status: QmAppeal['status'] | null = null): QmAppeal[] {
    const params: string[] = [tenantId];
    let sql = 'SELECT * FROM qm_appeals WHERE tenant_id = ?';
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    return all(this.db, sql, params).map((row) => decodeAppeal(row as Record<string, unknown>));
  }

  resolveAppeal(
    appealId: string,
    tenantId: string,
    reviewerUserId: string,
    status: 'approved' | 'rejected',
    notes: string | null
  ): QmAppeal | null {
    run(
      this.db,
      `UPDATE qm_appeals
       SET status = ?, reviewer_user_id = ?, resolution_notes = ?, resolved_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`,
      [status, reviewerUserId, notes, appealId, tenantId]
    );
    return this.getAppeal(appealId);
  }
}

function decodeAppeal(row: Record<string, unknown>): QmAppeal {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    evaluation_id: String(row.evaluation_id),
    call_session_id: String(row.call_session_id),
    appellant_user_id: String(row.appellant_user_id),
    reason: String(row.reason),
    status: String(row.status) as QmAppeal['status'],
    reviewer_user_id: row.reviewer_user_id ? String(row.reviewer_user_id) : null,
    resolution_notes: row.resolution_notes ? String(row.resolution_notes) : null,
    created_at: String(row.created_at),
    resolved_at: row.resolved_at ? String(row.resolved_at) : null
  };
}

function decodeEvaluation(row: Record<string, unknown>): QmEvaluation {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_session_id: String(row.call_session_id),
    evaluator: String(row.evaluator),
    scores: parseJson<QmScores>(row.scores as string, {
      politeness: 0,
      compliance: 0,
      problem_resolution: 0,
      upsell_effectiveness: 0,
      script_adherence: 0
    }),
    violations: parseJson<string[]>(row.violations as string, []),
    summary: String(row.summary),
    recommendation: String(row.recommendation),
    overall_score: Number(row.overall_score),
    evaluated_at: String(row.evaluated_at),
    created_at: String(row.created_at)
  };
}
