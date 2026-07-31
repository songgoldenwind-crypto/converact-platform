/**
 * Token Budget Management for Cost Control
 *
 * Enforces daily token budgets per tenant to prevent cost overruns.
 * Tracks usage in optimization_stats with daily resets.
 *
 * Part of Phase 5C: State Management & Resilience
 */

import { one, run, id } from '../db.js';

export interface TokenBudgetConfig {
  tenant_id: string;
  daily_limit: number; // tokens/day, default 100000
  warning_threshold: number; // percent, default 80
  current_date: string; // YYYY-MM-DD UTC
  tokens_used: number; // cumulative for current date
  warning_sent: boolean; // whether 80% warning already sent
}

/**
 * Get or initialize token budget for a tenant
 * Returns config for current UTC date (auto-resets daily)
 */
export function getTokenBudget(db: any, tenantId: string): TokenBudgetConfig {
  const today = new Date().toISOString().split('T')[0];

  // Check optimization_stats for today's budget tracking
  // Query by DATE(recorded_at) to get today's entry
  const existing = one(
    db,
    `SELECT * FROM optimization_stats
     WHERE tenant_id = ? AND stat_type = 'token_budget'
     AND DATE(recorded_at) = DATE(?)
     ORDER BY recorded_at DESC LIMIT 1`,
    [tenantId, today]
  );

  if (existing) {
    return {
      tenant_id: tenantId,
      daily_limit: 100000, // Always use default for now
      warning_threshold: 80,
      current_date: today,
      tokens_used: existing.metric_value || 0,
      warning_sent: existing.note ? existing.note.includes('warning_sent') : false,
    };
  }

  // Initialize new daily budget entry
  return {
    tenant_id: tenantId,
    daily_limit: 100000, // default
    warning_threshold: 80,
    current_date: today,
    tokens_used: 0,
    warning_sent: false,
  };
}

/**
 * Check if tokens are available for AI generation
 * Returns { allowed: boolean, remaining: number, percent_used: number }
 */
export function canUseTokens(
  db: any,
  tenantId: string,
  estimatedTokens: number
): { allowed: boolean; remaining: number; percent_used: number; message?: string } {
  const budget = getTokenBudget(db, tenantId);

  const percentUsed = (budget.tokens_used / budget.daily_limit) * 100;
  const remaining = budget.daily_limit - budget.tokens_used;
  const allowed = remaining >= estimatedTokens;

  return {
    allowed,
    remaining,
    percent_used: Math.round(percentUsed * 10) / 10,
    message: allowed
      ? `OK: ${estimatedTokens} tokens available (${remaining} of ${budget.daily_limit} remaining)`
      : `OVER_BUDGET: Need ${estimatedTokens} but only ${remaining} available`,
  };
}

/**
 * Record token usage and update budget
 * Returns updated budget state
 */
export function recordTokenUsage(
  db: any,
  tenantId: string,
  tokensUsed: number,
  context?: { run_id?: string; model?: string }
): TokenBudgetConfig {
  const budget = getTokenBudget(db, tenantId);

  // Update cumulative usage
  const newTokensUsed = budget.tokens_used + tokensUsed;
  const percentUsed = (newTokensUsed / budget.daily_limit) * 100;

  // Save to optimization_stats
  run(
    db,
    `INSERT INTO optimization_stats (
      id, tenant_id, stat_type, metric_name, metric_value,
      note, recorded_at
    ) VALUES (?, ?, 'token_budget', 'daily_total', ?, ?, CURRENT_TIMESTAMP)`,
    [
      id('optstat'),
      tenantId,
      newTokensUsed,
      context && context.run_id ? `run_id=${context.run_id};model=${context.model || 'unknown'}` : 'auto',
    ]
  );

  // Check if warning threshold crossed and not already sent
  if (percentUsed >= budget.warning_threshold && !budget.warning_sent) {
    recordWarning(db, tenantId, percentUsed);
  }

  return {
    ...budget,
    tokens_used: newTokensUsed,
  };
}

/**
 * Record a token budget warning event
 */
function recordWarning(db: any, tenantId: string, percentUsed: number): void {
  run(
    db,
    `INSERT INTO optimization_stats (
      id, tenant_id, stat_type, metric_name, metric_value,
      note, recorded_at
    ) VALUES (?, ?, 'token_budget_warning', 'warning_triggered', ?, ?, CURRENT_TIMESTAMP)`,
    [
      id('optstat'),
      tenantId,
      percentUsed,
      `warning_sent=true;percent_used=${percentUsed.toFixed(1)}%`,
    ]
  );
}

/**
 * Reset daily budget for a tenant (called at midnight UTC)
 * Safe to call multiple times (idempotent)
 */
export function resetDailyBudget(db: any, tenantId: string): void {
  // Create fresh entry for today (0 usage) - will be created on first token usage
  // This is a no-op by design; entries created on demand
}

/**
 * Get daily budget summary for tenant
 */
export function getBudgetSummary(
  db: any,
  tenantId: string
): {
  daily_budget: number;
  tokens_used: number;
  percent_used: number;
  remaining: number;
  warning_active: boolean;
} {
  const budget = getTokenBudget(db, tenantId);
  const percent_used = (budget.tokens_used / budget.daily_limit) * 100;

  return {
    daily_budget: budget.daily_limit,
    tokens_used: budget.tokens_used,
    percent_used: Math.round(percent_used * 10) / 10,
    remaining: budget.daily_limit - budget.tokens_used,
    warning_active: percent_used >= budget.warning_threshold,
  };
}

/**
 * List all active tenant budgets (for dashboard/monitoring)
 */
export function listActiveBudgets(db: any): any[] {
  const today = new Date().toISOString().split('T')[0];

  return (
    db.prepare(
      `SELECT DISTINCT tenant_id FROM optimization_stats
       WHERE stat_type = 'token_budget' AND DATE(recorded_at) = DATE(?)`
    ).all(today) || []
  );
}

/**
 * Format token budget for logging
 */
export function formatTokenBudget(config: TokenBudgetConfig): string {
  const percent = (config.tokens_used / config.daily_limit) * 100;
  return `${config.tokens_used}/${config.daily_limit} tokens (${percent.toFixed(1)}%)`;
}
