import { all, id, one, run } from '../../../db.js';

export interface PostCallSurvey {
  id: string;
  tenant_id: string;
  call_session_id: string;
  campaign_id: string | null;
  score: number | null;
  comment: string | null;
  channel: string;
  created_at: string;
}

export class PostCallSurveyStore {
  constructor(private readonly db: unknown) {}

  createSurvey(input: {
    tenant_id: string;
    call_session_id: string;
    campaign_id?: string | null;
    score?: number | null;
    comment?: string | null;
    channel?: string;
  }): PostCallSurvey {
    const surveyId = id('csat');
    run(
      this.db,
      `INSERT INTO post_call_surveys (id, tenant_id, call_session_id, campaign_id, score, comment, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        surveyId,
        input.tenant_id,
        input.call_session_id,
        input.campaign_id || null,
        input.score ?? null,
        input.comment || null,
        input.channel || 'ivr'
      ]
    );
    return this.getSurvey(surveyId)!;
  }

  getSurvey(surveyId: string): PostCallSurvey | null {
    const row = one(this.db, 'SELECT * FROM post_call_surveys WHERE id = ?', [surveyId]);
    return row ? decode(row) : null;
  }

  listSurveys(tenantId: string, limit = 100): PostCallSurvey[] {
    return all(
      this.db,
      'SELECT * FROM post_call_surveys WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
      [tenantId, limit]
    ).map(decode);
  }

  getAverageScore(tenantId: string, campaignId: string | null = null): number {
    const params: (string | number)[] = [tenantId];
    let sql = 'SELECT AVG(score) AS avg_score FROM post_call_surveys WHERE tenant_id = ? AND score IS NOT NULL';
    if (campaignId) {
      sql += ' AND campaign_id = ?';
      params.push(campaignId);
    }
    const row = one(this.db, sql, params);
    return row?.avg_score != null ? Number(row.avg_score) : 0;
  }
}

export function buildPostCallSurveyIvrPrompt(): string {
  return '感谢您的来电。请为本次服务打分：按 1 非常不满意，到 5 非常满意。';
}

function decode(row: Record<string, unknown>): PostCallSurvey {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_session_id: String(row.call_session_id),
    campaign_id: row.campaign_id ? String(row.campaign_id) : null,
    score: row.score != null ? Number(row.score) : null,
    comment: row.comment ? String(row.comment) : null,
    channel: String(row.channel || 'ivr'),
    created_at: String(row.created_at)
  };
}
