/**
 * Platform task commands (createTask / completeTask / rescheduleTask).
 *
 * Extracted from lead-acquisition/queries/builders/platform-task-command-builders.ts.
 * The lead-acquisition specific hooks (memory promotion, run refresh, optimization writeback)
 * are now injected via wireTaskCompletionHooks so this module no longer hard-depends
 * on lead-acquisition or optimization-writeback.
 */
import { id, one, run } from '../db.js';
import {
  badRequest,
  enrichLead,
  ensureTenant,
  hoursFromNow,
  notFound,
  required
} from './scoring-utils.js';
import { trackEvent } from './events.js';

/**
 * Optional hook injection. When wireTaskCompletionHooks is called (e.g. from
 * services-bootstrap during legacy lead-acquisition phase), completeTask will
 * invoke these side effects. When unwired (production call-center only),
 * completeTask gracefully skips them.
 */
export interface TaskCompletionHooks {
  promoteTaskOutcomeMemory?: (
    db: unknown,
    tenantId: string,
    task: any,
    linkedLead: any,
    outcome: any,
    followupTask: any
  ) => void;
  refreshLeadAcquisitionRunsForTaskCompletion?: (
    db: unknown,
    tenantId: string,
    task: any,
    linkedLead: any
  ) => any[];
  leadStatusFromCompletion?: (result: string, currentStatus: string) => string;
  processOptimizationWriteback?: (
    db: unknown,
    tenantId: string,
    taskId: string,
    task: any,
    payload: { status: string; notes?: string; next_follow_up_date?: string }
  ) => Promise<void>;
}

const hooks: TaskCompletionHooks = {};

export function wireTaskCompletionHooks(next: TaskCompletionHooks): void {
  Object.assign(hooks, next);
}

export function defaultNextStepType(result: string): string {
  return ({
    contacted: 'followup',
    callback_requested: 'callback',
    appointment_booked: 'appointment',
    no_response: 'callback',
    completed: '',
    disqualified: '',
    won: ''
  } as Record<string, string>)[result] ?? '';
}

export function defaultDueHoursForStep(nextStepType: string): number {
  return ({
    callback: 4,
    appointment: 24,
    followup: 24
  } as Record<string, number>)[nextStepType] ?? 24;
}

export function normalizeTaskDueAt(value: unknown, fallbackHours: number): string {
  if (!value) return hoursFromNow(fallbackHours);
  const normalized = new Date(String(value));
  if (Number.isNaN(normalized.getTime())) {
    throw badRequest('invalid next_step_due_at');
  }
  return normalized.toISOString();
}

export function normalizeRescheduleDueAt(input: any = {}, previousDueAt = ''): string {
  if (input.due_at) return normalizeTaskDueAt(input.due_at, 24);
  const delayHours = Number(input.delay_hours || 0);
  if (!Number.isFinite(delayHours) || delayHours <= 0) {
    throw badRequest('delay_hours or due_at is required');
  }
  const previousTimestamp = Date.parse(String(previousDueAt || ''));
  const baseDate = Number.isFinite(previousTimestamp) && previousTimestamp > Date.now()
    ? new Date(previousTimestamp)
    : new Date();
  baseDate.setHours(baseDate.getHours() + delayHours);
  return baseDate.toISOString();
}

export function normalizeTaskOutcomeInput(input: any = {}) {
  const completionResult = String(input.completion_result || 'completed').trim() || 'completed';
  const allowedResults = new Set([
    'completed', 'contacted', 'callback_requested', 'appointment_booked',
    'no_response', 'disqualified', 'won'
  ]);
  if (!allowedResults.has(completionResult)) {
    throw badRequest('invalid completion_result');
  }
  const requestedStepType = String(input.next_step_type || '').trim();
  const defaultStepType = defaultNextStepType(completionResult);
  const nextStepType = requestedStepType === 'none' ? '' : (requestedStepType || defaultStepType);
  const allowedStepTypes = new Set(['', 'followup', 'callback', 'appointment']);
  if (!allowedStepTypes.has(nextStepType)) {
    throw badRequest('invalid next_step_type');
  }
  return {
    completion_result: completionResult,
    completion_reason: String(input.completion_reason || '').trim(),
    next_step_type: nextStepType,
    next_step_due_at: nextStepType ? normalizeTaskDueAt(input.next_step_due_at, defaultDueHoursForStep(nextStepType)) : null
  };
}

export function resolveLeadForTask(db: unknown, tenantId: string, task: any) {
  if (task.object_type === 'lead') {
    return one(db, 'SELECT * FROM leads WHERE tenant_id = ? AND id = ?', [tenantId, task.object_id]);
  }
  if (task.object_type === 'opportunity') {
    return one(
      db,
      `SELECT leads.*
         FROM opportunities
         JOIN leads ON leads.id = opportunities.lead_id
        WHERE opportunities.tenant_id = ? AND opportunities.id = ?`,
      [tenantId, task.object_id]
    );
  }
  return null;
}

export function updateLeadAfterTaskCompletion(
  db: unknown,
  tenantId: string,
  lead: any,
  outcome: any,
  followupTask: any
): void {
  if (!lead) return;
  const nextAction = followupTask
    ? `${humanNextStepLabel(outcome.next_step_type)}：${formatTaskDueText(followupTask.due_at)}`
    : nextActionFromCompletion(outcome.completion_result);
  // If lead-acquisition is unwired, fall back to keeping the existing status.
  const status = hooks.leadStatusFromCompletion
    ? hooks.leadStatusFromCompletion(outcome.completion_result, lead.status)
    : lead.status;
  run(
    db,
    'UPDATE leads SET status = ?, next_action = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ?',
    [status, nextAction, tenantId, lead.id]
  );
}

export function updateOpportunityAfterTaskCompletion(
  db: unknown,
  tenantId: string,
  opportunity: any,
  outcome: any
): void {
  if (!opportunity) return;
  const status = opportunityStatusFromCompletion(outcome.completion_result, opportunity.status);
  run(
    db,
    'UPDATE opportunities SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ?',
    [status, tenantId, opportunity.id]
  );
}

export function buildFollowupTaskTitle(task: any, outcome: any): string {
  const subject = task.title || '当前跟进';
  return ({
    callback: `按约回拨：${subject}`,
    appointment: `准备预约沟通：${subject}`,
    followup: `继续跟进：${subject}`
  } as Record<string, string>)[outcome.next_step_type] || `继续跟进：${subject}`;
}

export function followupPriority(priority: string, nextStepType: string): string {
  if (nextStepType === 'appointment') return 'P0';
  if (nextStepType === 'callback') return priority === 'P0' ? 'P0' : 'P1';
  return priority || 'P1';
}

export function opportunityStatusFromCompletion(result: string, currentStatus: string): string {
  return ({
    appointment_booked: 'booked',
    disqualified: 'lost',
    won: 'won',
    contacted: currentStatus || 'open',
    callback_requested: currentStatus || 'open',
    no_response: currentStatus || 'open',
    completed: currentStatus || 'open'
  } as Record<string, string>)[result] || currentStatus || 'open';
}

export function nextActionFromCompletion(result: string): string {
  return ({
    contacted: '已完成首次沟通，继续推进成交条件',
    callback_requested: '客户要求回拨，按约定时间再次联系',
    appointment_booked: '预约已确认，准备会前材料',
    no_response: '尚未接通，建议再次尝试联系',
    disqualified: '暂不主动跟进，保留来源与复盘信息',
    won: '已成交，转入成交后维护',
    completed: '当前任务已完成'
  } as Record<string, string>)[result] || '当前任务已完成';
}

export function humanNextStepLabel(nextStepType: string): string {
  return ({
    callback: '下次回拨',
    appointment: '预约沟通',
    followup: '下一步跟进'
  } as Record<string, string>)[nextStepType] || '下一步';
}

export function formatTaskDueText(value: unknown): string {
  if (!value) return '系统已安排';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '系统已安排';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

export function createTask(db: unknown, input: any) {
  ensureTenant(db, input.tenant_id);
  const task = {
    id: id('task'),
    tenant_id: input.tenant_id,
    object_type: required(input.object_type, 'object_type'),
    object_id: required(input.object_id, 'object_id'),
    title: required(input.title, 'title'),
    priority: input.priority || 'P2',
    due_at: input.due_at || hoursFromNow(input.due_hours || 24)
  };
  run(
    db,
    `INSERT INTO tasks (id, tenant_id, object_type, object_id, title, priority, due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [task.id, task.tenant_id, task.object_type, task.object_id, task.title, task.priority, task.due_at]
  );
  trackEvent(db, task.tenant_id, 'task_created', 'task', task.id, null, task);
  return one(db, 'SELECT * FROM tasks WHERE id = ?', [task.id]);
}

export function completeTask(db: unknown, tenantId: string, taskId: string, input: any = {}) {
  ensureTenant(db, tenantId);
  const task = one(db, 'SELECT * FROM tasks WHERE tenant_id = ? AND id = ?', [tenantId, taskId]);
  if (!task) throw notFound('task not found');
  const outcome = normalizeTaskOutcomeInput(input);
  const linkedLead = resolveLeadForTask(db, tenantId, task);
  const linkedOpportunity = task.object_type === 'opportunity'
    ? one(db, 'SELECT * FROM opportunities WHERE tenant_id = ? AND id = ?', [tenantId, task.object_id])
    : linkedLead?.status === 'opportunity'
      ? one(db, 'SELECT * FROM opportunities WHERE tenant_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 1', [tenantId, linkedLead.id])
      : null;
  const followupTask = outcome.next_step_type
    ? createTask(db, {
        tenant_id: tenantId,
        object_type: task.object_type,
        object_id: task.object_id,
        title: buildFollowupTaskTitle(task, outcome),
        priority: followupPriority(task.priority, outcome.next_step_type),
        due_at: outcome.next_step_due_at
      })
    : null;

  run(
    db,
    `UPDATE tasks
       SET status = ?, completion_result = ?, completion_reason = ?, next_step_type = ?, next_step_due_at = ?, followup_task_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      'done',
      outcome.completion_result,
      outcome.completion_reason,
      outcome.next_step_type,
      outcome.next_step_due_at,
      followupTask?.id || null,
      taskId
    ]
  );

  updateLeadAfterTaskCompletion(db, tenantId, linkedLead, outcome, followupTask);
  updateOpportunityAfterTaskCompletion(db, tenantId, linkedOpportunity, outcome);

  trackEvent(db, tenantId, 'task_completed', 'task', taskId, null, {
    completion_result: outcome.completion_result,
    completion_reason: outcome.completion_reason,
    next_step_type: outcome.next_step_type,
    next_step_due_at: outcome.next_step_due_at,
    followup_task_id: followupTask?.id || null
  });

  // Optional hooks (only fire if lead-acquisition or optimization writeback are wired).
  hooks.promoteTaskOutcomeMemory?.(db, tenantId, task, linkedLead, outcome, followupTask);
  const leadAcquisitionRuns =
    hooks.refreshLeadAcquisitionRunsForTaskCompletion?.(db, tenantId, task, linkedLead) ?? [];
  hooks.processOptimizationWriteback?.(db, tenantId, taskId, task, {
    status: outcome.completion_result || 'unknown',
    notes: outcome.completion_reason || undefined,
    next_follow_up_date: outcome.next_step_due_at || undefined
  })?.catch((error: any) => {
    console.warn(`[platform] Optimization writeback failed for task ${taskId}:`, error);
  });

  const completedTask = one(db, 'SELECT * FROM tasks WHERE id = ?', [taskId]);
  return {
    ...completedTask,
    task: completedTask,
    followup_task: followupTask,
    lead: linkedLead ? enrichLead(one(db, 'SELECT * FROM leads WHERE id = ?', [linkedLead.id])) : null,
    opportunity: linkedOpportunity ? one(db, 'SELECT * FROM opportunities WHERE id = ?', [linkedOpportunity.id]) : null,
    lead_acquisition_runs: leadAcquisitionRuns,
    auto_advancements: []
  };
}

export function rescheduleTask(db: unknown, tenantId: string, taskId: string, input: any = {}) {
  ensureTenant(db, tenantId);
  const task = one(db, 'SELECT * FROM tasks WHERE tenant_id = ? AND id = ?', [tenantId, taskId]);
  if (!task) throw notFound('task not found');
  if (task.status !== 'open') throw badRequest('only open tasks can be rescheduled');
  const dueAt = normalizeRescheduleDueAt(input, task.due_at);
  run(db, 'UPDATE tasks SET due_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [dueAt, taskId]);
  trackEvent(db, tenantId, 'task_rescheduled', 'task', taskId, null, {
    previous_due_at: task.due_at,
    due_at: dueAt,
    delay_hours: Number(input.delay_hours || 0) || null,
    reschedule_reason: String(input.reschedule_reason || '').trim()
  });
  return {
    ...one(db, 'SELECT * FROM tasks WHERE id = ?', [taskId]),
    previous_due_at: task.due_at
  };
}
