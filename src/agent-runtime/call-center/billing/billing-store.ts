import { id, one, run } from '../../../db.js';
import { getPlanDefinition } from '../../../plan-definitions.js';

export interface BillingSubscription {
  id: string;
  tenant_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan_code: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
}

export interface CreateSubscriptionInput {
  tenant_id: string;
  plan_code?: string;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}

export interface BillingUsage {
  id: string;
  tenant_id: string;
  period: string;
  ai_minutes_used: number;
  tool_calls_used: number;
  seats_used: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  usage: {
    ai_minutes: { used: number; limit: number };
    tool_calls: { used: number; limit: number };
    seats: { used: number; limit: number };
  };
}

interface DatabaseLike {
  exec: (sql: string) => void;
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan_code TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  current_period_start TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_tenant ON billing_subscriptions(tenant_id);

CREATE TABLE IF NOT EXISTS billing_usage (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,
  ai_minutes_used REAL NOT NULL DEFAULT 0,
  tool_calls_used INTEGER NOT NULL DEFAULT 0,
  seats_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_period ON billing_usage(tenant_id, period);
`;

export class BillingStore {
  constructor(private readonly db: unknown) {
    (db as DatabaseLike).exec(MIGRATION_SQL);
  }

  getSubscription(tenantId: string): BillingSubscription | null {
    const row = one(this.db, 'SELECT * FROM billing_subscriptions WHERE tenant_id = ?', [tenantId]);
    return row ? decodeSubscription(row) : null;
  }

  /** Reverse lookup by Stripe customer ID — used by webhook handlers. */
  findTenantByCustomerId(customerId: string): string | null {
    const row = one(
      this.db,
      'SELECT tenant_id FROM billing_subscriptions WHERE stripe_customer_id = ?',
      [customerId]
    );
    return row ? String(row.tenant_id) : null;
  }

  createSubscription(input: CreateSubscriptionInput): BillingSubscription {
    const subId = id('sub');
    run(
      this.db,
      `INSERT INTO billing_subscriptions (id, tenant_id, plan_code, stripe_customer_id, stripe_subscription_id)
       VALUES (?, ?, ?, ?, ?)`,
      [
        subId,
        input.tenant_id,
        input.plan_code || 'free',
        input.stripe_customer_id ?? null,
        input.stripe_subscription_id ?? null
      ]
    );
    return this.getSubscription(input.tenant_id)!;
  }

  updateSubscription(tenantId: string, update: Partial<BillingSubscription>): BillingSubscription | null {
    const existing = this.getSubscription(tenantId);
    if (!existing) return null;

    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (update.plan_code !== undefined) { fields.push('plan_code = ?'); values.push(update.plan_code); }
    if (update.status !== undefined) { fields.push('status = ?'); values.push(update.status); }
    if (update.stripe_customer_id !== undefined) { fields.push('stripe_customer_id = ?'); values.push(update.stripe_customer_id); }
    if (update.stripe_subscription_id !== undefined) { fields.push('stripe_subscription_id = ?'); values.push(update.stripe_subscription_id); }
    if (update.current_period_start !== undefined) { fields.push('current_period_start = ?'); values.push(update.current_period_start); }
    if (update.current_period_end !== undefined) { fields.push('current_period_end = ?'); values.push(update.current_period_end); }

    if (!fields.length) return existing;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    run(this.db, `UPDATE billing_subscriptions SET ${fields.join(', ')} WHERE tenant_id = ?`, [...values, tenantId]);
    return this.getSubscription(tenantId);
  }

  getUsage(tenantId: string, period: string): BillingUsage | null {
    const row = one(this.db, 'SELECT * FROM billing_usage WHERE tenant_id = ? AND period = ?', [tenantId, period]);
    return row ? decodeUsage(row) : null;
  }

  incrementUsage(tenantId: string, field: 'ai_minutes_used' | 'tool_calls_used' | 'seats_used', amount: number): void {
    const period = currentPeriod();
    const existing = this.getUsage(tenantId, period);
    if (!existing) {
      const usageId = id('usage');
      run(
        this.db,
        `INSERT INTO billing_usage (id, tenant_id, period, ${field}) VALUES (?, ?, ?, ?)`,
        [usageId, tenantId, period, amount]
      );
      return;
    }
    run(
      this.db,
      `UPDATE billing_usage SET ${field} = ${field} + ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND period = ?`,
      [amount, tenantId, period]
    );
  }

  checkQuota(tenantId: string): QuotaCheckResult {
    const sub = this.getSubscription(tenantId);
    const planCode = sub?.plan_code || 'free';
    const plan = getPlanDefinition(planCode);

    const period = currentPeriod();
    const usage = this.getUsage(tenantId, period);
    const used = {
      ai_minutes: usage?.ai_minutes_used || 0,
      tool_calls: usage?.tool_calls_used || 0,
      seats: usage?.seats_used || 0
    };

    const result: QuotaCheckResult = {
      allowed: true,
      usage: {
        ai_minutes: { used: used.ai_minutes, limit: plan.monthlyAiMinutes },
        tool_calls: { used: used.tool_calls, limit: plan.monthlyToolCalls },
        seats: { used: used.seats, limit: plan.maxSeats }
      }
    };

    if (plan.monthlyAiMinutes === -1 && plan.monthlyToolCalls === -1 && plan.maxSeats === -1) {
      return result;
    }

    if (plan.monthlyAiMinutes !== -1 && used.ai_minutes >= plan.monthlyAiMinutes) {
      result.allowed = false;
      result.reason = `AI minutes quota exceeded: ${used.ai_minutes}/${plan.monthlyAiMinutes}`;
      return result;
    }
    if (plan.monthlyToolCalls !== -1 && used.tool_calls >= plan.monthlyToolCalls) {
      result.allowed = false;
      result.reason = `Tool calls quota exceeded: ${used.tool_calls}/${plan.monthlyToolCalls}`;
      return result;
    }
    if (plan.maxSeats !== -1 && used.seats >= plan.maxSeats) {
      result.allowed = false;
      result.reason = `Seats quota exceeded: ${used.seats}/${plan.maxSeats}`;
      return result;
    }

    return result;
  }
}

/** Current billing period string (YYYY-MM). Shared across billing module. */
export function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function decodeSubscription(row: Record<string, unknown>): BillingSubscription {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    stripe_customer_id: row.stripe_customer_id ? String(row.stripe_customer_id) : null,
    stripe_subscription_id: row.stripe_subscription_id ? String(row.stripe_subscription_id) : null,
    plan_code: String(row.plan_code),
    status: String(row.status),
    current_period_start: row.current_period_start ? String(row.current_period_start) : null,
    current_period_end: row.current_period_end ? String(row.current_period_end) : null
  };
}

function decodeUsage(row: Record<string, unknown>): BillingUsage {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    period: String(row.period),
    ai_minutes_used: Number(row.ai_minutes_used),
    tool_calls_used: Number(row.tool_calls_used),
    seats_used: Number(row.seats_used)
  };
}
