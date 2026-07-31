import { all, id, json, one, parseJson, run } from '../../db.js';
import type { HookManager } from '../hooks/hook-manager.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

export interface QuotaUsage extends JsonRecord {
  tenant_id: string;
  quota_key: string;
  period: string;
  period_key: string;
  used: number;
  hard_limit: number | null;
  soft_limit: number | null;
  status: string;
}

export interface QuotaDecision extends JsonRecord {
  decision: 'allow' | 'warn' | 'deny';
  usage: QuotaUsage;
  amount: number;
  reason: string;
}

export class QuotaStore {
  db: unknown;
  runStore: AuditStoreLike | null;

  constructor(db: unknown, runStore: AuditStoreLike | null = null) {
    this.db = db;
    this.runStore = runStore;
  }

  upsertLimit(input: JsonRecord): JsonRecord | null {
    const limit = {
      id: input.id || id('quota'),
      tenant_id: input.tenant_id,
      quota_key: input.quota_key,
      period: input.period || 'monthly',
      hard_limit: Number(input.hard_limit),
      soft_limit: Number(input.soft_limit ?? Math.floor(Number(input.hard_limit) * 0.8)),
      status: input.status || 'active',
      created_by: input.created_by || input.actor_id || 'system'
    };
    run(
      this.db,
      `INSERT INTO tenant_quota_limits
        (id, tenant_id, quota_key, period, hard_limit, soft_limit, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, quota_key, period) DO UPDATE SET
         hard_limit = excluded.hard_limit,
         soft_limit = excluded.soft_limit,
         status = excluded.status,
         updated_at = CURRENT_TIMESTAMP`,
      [
        limit.id,
        limit.tenant_id,
        limit.quota_key,
        limit.period,
        limit.hard_limit,
        limit.soft_limit,
        limit.status,
        limit.created_by
      ]
    );
    this.runStore?.audit?.(limit.tenant_id, 'quota.limit_upserted', 'tenant_quota_limit', limit.quota_key, limit, limit.created_by);
    return this.getLimit(limit.tenant_id, limit.quota_key, limit.period);
  }

  getLimit(tenantId: string, quotaKey: string, period = 'monthly'): JsonRecord | null {
    return one(
      this.db,
      'SELECT * FROM tenant_quota_limits WHERE tenant_id = ? AND quota_key = ? AND period = ? AND status = ?',
      [tenantId, quotaKey, period, 'active']
    );
  }

  listLimits(tenantId: string): JsonRecord[] {
    return all(this.db, 'SELECT * FROM tenant_quota_limits WHERE tenant_id = ? ORDER BY quota_key ASC', [tenantId]);
  }

  getUsage({ tenant_id, quota_key, period = 'monthly', period_key = periodKey(period) }: JsonRecord): QuotaUsage {
    const row = one(
      this.db,
      `SELECT COALESCE(SUM(amount), 0) AS used
       FROM usage_ledger
       WHERE tenant_id = ? AND quota_key = ? AND period_key = ?`,
      [tenant_id, quota_key, period_key]
    );
    const limit = this.getLimit(tenant_id, quota_key, period);
    return {
      tenant_id,
      quota_key,
      period,
      period_key,
      used: Number(row.used || 0),
      hard_limit: limit ? Number(limit.hard_limit) : null,
      soft_limit: limit ? Number(limit.soft_limit) : null,
      status: classifyUsage(Number(row.used || 0), limit)
    };
  }

  check(input: JsonRecord): QuotaDecision {
    const amount = Number(input.amount ?? 1);
    const period = input.period || 'monthly';
    const usage = this.getUsage({
      tenant_id: input.tenant_id,
      quota_key: input.quota_key,
      period,
      period_key: input.period_key || periodKey(period)
    });
    if (usage.hard_limit === null) return { decision: 'allow', usage, amount, reason: 'no quota limit configured' };
    if (usage.used + amount > usage.hard_limit) {
      return {
        decision: 'deny',
        usage,
        amount,
        reason: `${input.quota_key} quota exceeded: ${usage.used + amount}/${usage.hard_limit}`
      };
    }
    if (usage.soft_limit !== null && usage.used + amount >= usage.soft_limit) {
      return {
        decision: 'warn',
        usage,
        amount,
        reason: `${input.quota_key} quota approaching limit: ${usage.used + amount}/${usage.hard_limit}`
      };
    }
    return { decision: 'allow', usage, amount, reason: 'within quota' };
  }

  assertWithinLimit(input: JsonRecord): QuotaDecision {
    const decision = this.check(input);
    this.recordPolicyDecision({
      tenant_id: input.tenant_id,
      actor_id: input.actor_id || 'system',
      decision: decision.decision === 'deny' ? 'deny' : decision.decision,
      reason: decision.reason,
      tool_id: input.tool_id || '',
      risk_level: input.risk_level || '',
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      tool_call_id: input.tool_call_id || null,
      metadata: { quota_key: input.quota_key, amount: decision.amount, usage: decision.usage }
    });
    if (decision.decision === 'deny') throw quotaError(decision.reason);
    return decision;
  }

  recordUsage(input: JsonRecord): JsonRecord | null {
    const amount = Number(input.amount ?? 1);
    if (!amount) return null;
    const period = input.period || 'monthly';
    const row = {
      id: input.id || id('usage'),
      tenant_id: input.tenant_id,
      quota_key: input.quota_key,
      amount,
      period_key: input.period_key || periodKey(period),
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      tool_call_id: input.tool_call_id || null,
      model_call_id: input.model_call_id || null,
      metadata: input.metadata || {}
    };
    run(
      this.db,
      `INSERT INTO usage_ledger
        (id, tenant_id, quota_key, amount, period_key, workflow_run_id, agent_run_id, tool_call_id, model_call_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.quota_key,
        row.amount,
        row.period_key,
        row.workflow_run_id,
        row.agent_run_id,
        row.tool_call_id,
        row.model_call_id,
        json(row.metadata)
      ]
    );
    return row;
  }

  listUsage({ tenant_id, quota_key = null, period_key = null, limit = 100 }: JsonRecord): JsonRecord[] {
    const clauses = ['tenant_id = ?'];
    const params = [tenant_id];
    if (quota_key) {
      clauses.push('quota_key = ?');
      params.push(quota_key);
    }
    if (period_key) {
      clauses.push('period_key = ?');
      params.push(period_key);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM usage_ledger WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params
    ).map((row) => ({ ...row, metadata: parseJson(row.metadata) }));
  }

  recordPolicyDecision(input: JsonRecord): void {
    run(
      this.db,
      `INSERT INTO policy_decisions
        (id, tenant_id, actor_id, decision_type, decision, reason, tool_id, risk_level,
         required_permissions, workflow_run_id, agent_run_id, tool_call_id, metadata)
       VALUES (?, ?, ?, 'quota', ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
      [
        id('policy'),
        input.tenant_id,
        input.actor_id || 'system',
        input.decision,
        input.reason || '',
        input.tool_id || '',
        input.risk_level || '',
        input.workflow_run_id || null,
        input.agent_run_id || null,
        input.tool_call_id || null,
        json(input.metadata || {})
      ]
    );
  }
}

export function registerQuotaHooks(hookManager: HookManager, quotaStore: QuotaStore): void {
  hookManager.on('before_tool_call', (payload) => {
    quotaStore.assertWithinLimit({
      tenant_id: payload.context.tenantId,
      actor_id: payload.context.userId,
      quota_key: 'monthly_tool_calls',
      amount: payload.tool.quota?.cost || 1,
      tool_id: payload.tool.tool_id,
      risk_level: payload.tool.risk_level,
      workflow_run_id: payload.context.workflowRunId,
      agent_run_id: payload.context.agentRunId,
      tool_call_id: payload.toolCall?.id
    });
  });

  hookManager.on('after_tool_call', (payload) => {
    if (payload.result?.status !== 'success') return;
    quotaStore.recordUsage({
      tenant_id: payload.context.tenantId,
      quota_key: 'monthly_tool_calls',
      amount: payload.tool.quota?.cost || 1,
      workflow_run_id: payload.context.workflowRunId,
      agent_run_id: payload.context.agentRunId,
      tool_call_id: payload.toolCall?.id,
      metadata: { tool_id: payload.tool.tool_id, risk_level: payload.tool.risk_level }
    });
    if (payload.tool.category === 'external_action') {
      quotaStore.recordUsage({
        tenant_id: payload.context.tenantId,
        quota_key: 'external_messages',
        amount: 1,
        workflow_run_id: payload.context.workflowRunId,
        agent_run_id: payload.context.agentRunId,
        tool_call_id: payload.toolCall?.id,
        metadata: { tool_id: payload.tool.tool_id }
      });
    }
  });

  hookManager.on('before_model_call', (payload) => {
    quotaStore.assertWithinLimit({
      tenant_id: payload.context.tenantId,
      actor_id: payload.context.userId,
      quota_key: 'monthly_model_tokens',
      amount: 1,
      workflow_run_id: payload.context.workflowRunId,
      agent_run_id: payload.context.agentRunId,
      metadata: { provider: payload.request.provider, model: payload.request.model }
    });
  });

  hookManager.on('after_model_call', (payload) => {
    const totalTokens = Number(payload.result?.output?.usage?.total_tokens || payload.modelCall?.usage?.total_tokens || 0);
    quotaStore.recordUsage({
      tenant_id: payload.context.tenantId,
      quota_key: 'monthly_model_tokens',
      amount: totalTokens,
      workflow_run_id: payload.context.workflowRunId,
      agent_run_id: payload.context.agentRunId,
      model_call_id: payload.modelCall?.id,
      metadata: { provider: payload.request.provider, model: payload.request.model, purpose: payload.request.purpose || 'default' }
    });
  });
}

function periodKey(period: string): string {
  const date = new Date();
  if (period === 'daily') return date.toISOString().slice(0, 10);
  if (period === 'lifetime') return 'lifetime';
  return date.toISOString().slice(0, 7);
}

function classifyUsage(used: number, limit: JsonRecord | null): string {
  if (!limit) return 'unlimited';
  if (used >= Number(limit.hard_limit)) return 'blocked';
  if (used >= Number(limit.soft_limit)) return 'warning';
  return 'ok';
}

function quotaError(message: string): Error {
  const error = new Error(message);
  error.name = 'QuotaExceededError';
  error.status = 429;
  return error;
}
