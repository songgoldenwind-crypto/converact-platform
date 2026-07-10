import { all, id, json, one, parseJson, run } from '../../../db.js';
import { searchRecordings } from '../agent-tools/recording-search.js';

const KEYWORD_STOP = new Set(['的', '了', '是', '在', '我', '你', '他', 'the', 'a', 'and', 'to', 'is', 'it']);

export interface BatchAnalyzeFilters {
  tenant_id: string;
  q?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

export interface BatchAnalyzeResult {
  recording_count: number;
  keyword_trends: Array<{ term: string; count: number }>;
  anomalies: Array<{ call_session_id: string; reason: string }>;
  avg_duration_ms: number;
}

export function createBatchJob(db: unknown, filters: BatchAnalyzeFilters): string {
  const jobId = id('rbatch');
  run(
    db,
    `INSERT INTO recording_batch_jobs (id, tenant_id, status, filters) VALUES (?, ?, 'pending', ?)`,
    [jobId, filters.tenant_id, json(filters)]
  );
  return jobId;
}

export function getBatchJob(db: unknown, jobId: string) {
  const row = one(db, 'SELECT * FROM recording_batch_jobs WHERE id = ?', [jobId]);
  if (!row) return null;
  return {
    id: String((row as { id: string }).id),
    tenant_id: String((row as { tenant_id: string }).tenant_id),
    status: String((row as { status: string }).status),
    filters: parseJson(String((row as { filters: string }).filters || '{}'), {}),
    result: parseJson(String((row as { result: string }).result || '{}'), {}),
    recording_count: Number((row as { recording_count: number }).recording_count || 0),
    error: (row as { error: string | null }).error ? String((row as { error: string }).error) : null,
    created_at: String((row as { created_at: string }).created_at),
    completed_at: (row as { completed_at: string | null }).completed_at
      ? String((row as { completed_at: string }).completed_at)
      : null
  };
}

export async function runBatchRecordingAnalysis(db: unknown, jobId: string): Promise<BatchAnalyzeResult> {
  const job = getBatchJob(db, jobId);
  if (!job) throw Object.assign(new Error('job not found'), { status: 404 });

  run(db, `UPDATE recording_batch_jobs SET status = 'running' WHERE id = ?`, [jobId]);

  try {
    const filters = job.filters as BatchAnalyzeFilters;
    const recordings = searchRecordings(db, {
      tenant_id: filters.tenant_id,
      q: filters.q,
      date_from: filters.date_from,
      date_to: filters.date_to,
      limit: filters.limit || 200
    });

    const keywordCounts = new Map<string, number>();
    const anomalies: Array<{ call_session_id: string; reason: string }> = [];
    let totalDuration = 0;
    let durationCount = 0;

    for (const rec of recordings) {
      if (rec.duration_ms != null) {
        totalDuration += rec.duration_ms;
        durationCount++;
      }
      if (rec.duration_ms != null && rec.duration_ms > 3_600_000) {
        anomalies.push({ call_session_id: rec.call_session_id, reason: '超长录音 >1h' });
      }

      const turns = all(
        db,
        'SELECT content FROM ai_conversation_turns WHERE call_session_id = ? ORDER BY turn_index ASC LIMIT 50',
        [rec.call_session_id]
      );
      const text = turns.map((t) => String((t as { content: string }).content)).join(' ');
      for (const term of tokenize(text)) {
        keywordCounts.set(term, (keywordCounts.get(term) || 0) + 1);
      }

      const angry = ['投诉', '愤怒', 'refund', 'angry', 'terrible'];
      if (angry.some((w) => text.toLowerCase().includes(w))) {
        anomalies.push({ call_session_id: rec.call_session_id, reason: '负面情绪关键词' });
      }
    }

    const keyword_trends = [...keywordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([term, count]) => ({ term, count }));

    const result: BatchAnalyzeResult = {
      recording_count: recordings.length,
      keyword_trends,
      anomalies: anomalies.slice(0, 50),
      avg_duration_ms: durationCount ? Math.round(totalDuration / durationCount) : 0
    };

    run(
      db,
      `UPDATE recording_batch_jobs SET status = 'completed', result = ?, recording_count = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [json(result), recordings.length, jobId]
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(
      db,
      `UPDATE recording_batch_jobs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [message, jobId]
    );
    throw err;
  }
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const words = text.toLowerCase().split(/[\s,.;:!?，。；：！？\n]+/).filter(Boolean);
  for (const w of words) {
    if (w.length < 2 || KEYWORD_STOP.has(w)) continue;
    tokens.push(w);
  }
  const cjk = text.match(/[\u4e00-\u9fff]{2,4}/g) || [];
  for (const seg of cjk) {
    if (!KEYWORD_STOP.has(seg)) tokens.push(seg);
  }
  return tokens;
}
