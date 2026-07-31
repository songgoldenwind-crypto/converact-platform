import { id, run } from './db.js';

export interface PlanDefinition {
  code: string;
  name: string;
  maxSeats: number;
  monthlyAiMinutes: number;
  monthlyToolCalls: number;
  features: string[];
  /** Stripe Price ID for monthly billing. Set via env STRIPE_PRICE_<PLAN>. */
  stripePriceId?: string;
}

export const PLAN_DEFINITIONS: Record<string, PlanDefinition> = {
  free: {
    code: 'free',
    name: 'Free',
    maxSeats: 2,
    monthlyAiMinutes: 100,
    monthlyToolCalls: 500,
    features: []
  },
  pro: {
    code: 'pro',
    name: 'Pro',
    maxSeats: 20,
    monthlyAiMinutes: 2000,
    monthlyToolCalls: 10000,
    features: ['qm']
  },
  enterprise: {
    code: 'enterprise',
    name: 'Enterprise',
    maxSeats: -1,
    monthlyAiMinutes: -1,
    monthlyToolCalls: -1,
    features: ['qm', 'rag', 'wfm', 'white_label']
  }
};

/** Resolve Stripe Price ID for a plan from env STRIPE_PRICE_PRO / STRIPE_PRICE_ENTERPRISE. */
export function getStripePriceId(planCode: string): string | null {
  if (planCode === 'free') return null;
  const envKey = `STRIPE_PRICE_${planCode.toUpperCase()}`;
  return process.env[envKey] || null;
}

export function getPlanDefinition(planCode: string): PlanDefinition {
  const plan = PLAN_DEFINITIONS[planCode];
  if (!plan) {
    throw Object.assign(new Error(`unknown plan code: ${planCode}`), { status: 400 });
  }
  return plan;
}

/**
 * Seed tenant_quota_limits rows for a given plan.
 * Uses UPSERT so it's safe to call multiple times.
 * A hard_limit of -1 means unlimited (stored as 0 — enforcement layer treats 0 as unlimited).
 */
export function seedQuotaLimitsForPlan(db: unknown, tenantId: string, planCode: string): void {
  const plan = getPlanDefinition(planCode);

  const quotas: Array<{ key: string; limit: number }> = [
    { key: 'ai_minutes', limit: plan.monthlyAiMinutes === -1 ? 0 : plan.monthlyAiMinutes },
    { key: 'tool_calls', limit: plan.monthlyToolCalls === -1 ? 0 : plan.monthlyToolCalls },
    { key: 'seats', limit: plan.maxSeats === -1 ? 0 : plan.maxSeats }
  ];

  for (const q of quotas) {
    run(
      db,
      `INSERT INTO tenant_quota_limits
        (id, tenant_id, quota_key, period, hard_limit, soft_limit, status, created_by)
       VALUES (?, ?, ?, 'monthly', ?, ?, 'active', 'system')
       ON CONFLICT(tenant_id, quota_key, period) DO UPDATE SET
         hard_limit = excluded.hard_limit,
         soft_limit = excluded.soft_limit,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('quota'),
        tenantId,
        q.key,
        q.limit,
        Math.floor(q.limit * 0.8),
        ]
    );
  }
}
