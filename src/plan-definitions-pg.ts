import type { PgQueryable } from './db-pg.js';
import { pgId } from './db-pg.js';
import { getPlanDefinition } from './plan-definitions.js';

/**
 * Seed tenant_quota_limits in Postgres for a given plan.
 */
export async function seedQuotaLimitsForPlanPg(
  pg: PgQueryable,
  tenantId: string,
  planCode: string
): Promise<void> {
  const plan = getPlanDefinition(planCode);

  const quotas: Array<{ key: string; limit: number }> = [
    { key: 'ai_minutes', limit: plan.monthlyAiMinutes === -1 ? 0 : plan.monthlyAiMinutes },
    { key: 'tool_calls', limit: plan.monthlyToolCalls === -1 ? 0 : plan.monthlyToolCalls },
    { key: 'seats', limit: plan.maxSeats === -1 ? 0 : plan.maxSeats }
  ];

  for (const q of quotas) {
    await pg.query(
      `INSERT INTO tenant_quota_limits
         (id, tenant_id, quota_key, period, hard_limit, soft_limit, status, created_by)
       VALUES ($1, $2, $3, 'monthly', $4, $5, 'active', 'system')
       ON CONFLICT (tenant_id, quota_key, period) DO UPDATE SET
         hard_limit = EXCLUDED.hard_limit,
         soft_limit = EXCLUDED.soft_limit,
         updated_at = NOW()`,
      [pgId('quota'), tenantId, q.key, q.limit, Math.floor(q.limit * 0.8)]
    );
  }
}
