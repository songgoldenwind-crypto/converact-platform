import { all, id, one, run } from '../../../db.js';

export function logKnowledgeQuery(
  db: unknown,
  input: {
    tenant_id: string;
    query: string;
    hit_count: number;
    confidence?: number | null;
    source_channel?: string;
  }
): void {
  run(
    db,
    `INSERT INTO knowledge_query_log (id, tenant_id, query, hit_count, confidence, source_channel)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id('kbq'),
      input.tenant_id,
      input.query,
      input.hit_count,
      input.confidence ?? null,
      input.source_channel || 'api'
    ]
  );
}

export function getKnowledgeAnalytics(db: unknown, tenantId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = all(
    db,
    `SELECT query, hit_count, confidence, source_channel, created_at
     FROM knowledge_query_log WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 500`,
    [tenantId, since]
  );

  const totalQueries = rows.length;
  const hits = rows.filter((r) => Number((r as { hit_count: number }).hit_count) > 0).length;
  const hitRate = totalQueries ? hits / totalQueries : 0;

  const queryFreq = new Map<string, number>();
  const missQueries = new Map<string, number>();
  for (const row of rows) {
    const q = String((row as { query: string }).query).trim().toLowerCase();
    queryFreq.set(q, (queryFreq.get(q) || 0) + 1);
    if (Number((row as { hit_count: number }).hit_count) === 0) {
      missQueries.set(q, (missQueries.get(q) || 0) + 1);
    }
  }

  const topQueries = [...queryFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([query, count]) => ({ query, count }));

  const gaps = [...missQueries.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([query, count]) => ({ query, miss_count: count }));

  const byChannel: Record<string, number> = {};
  for (const row of rows) {
    const ch = String((row as { source_channel: string }).source_channel || 'api');
    byChannel[ch] = (byChannel[ch] || 0) + 1;
  }

  return {
    period_days: days,
    total_queries: totalQueries,
    hit_rate: Math.round(hitRate * 1000) / 1000,
    top_queries: topQueries,
    content_gaps: gaps,
    by_channel: byChannel
  };
}
