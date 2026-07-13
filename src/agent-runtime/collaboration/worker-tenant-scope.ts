import type { PgQueryable } from '../../db-pg.js';

export type CollaborationWorkerQueue = 'tinode' | 'attachment' | 'quality' | 'translation';

export async function listCollaborationWorkerTenants(
  pg: PgQueryable,
  queue: CollaborationWorkerQueue,
  now: Date,
  limit: number
): Promise<string[]> {
  const result = await pg.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM opc_worker_tenant_ids($1, $2, $3)',
    [queue, now.toISOString(), limit]
  );
  return result.rows.map((row) => String(row.tenant_id)).filter(Boolean);
}
