import { all, id, json, one, parseJson, run } from '../../db.js';
import { verifyAndTune, DEFAULT_FEEDBACK_THRESHOLDS } from '../core-kernel/index.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

interface TriggerRunnerOptions {
  db: unknown;
  runtime: RuntimeLike;
  playbookRouter: PlaybookRouterLike;
  runStore?: AuditStoreLike | null;
}

interface RuntimeLike {
  runPlaybook: (input: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

interface PlaybookRouterLike {
  route: (input: JsonRecord) => JsonRecord;
}

export class TriggerRunner {
  db: unknown;
  runtime: RuntimeLike;
  playbookRouter: PlaybookRouterLike;
  runStore: AuditStoreLike | null;

  constructor({ db, runtime, playbookRouter, runStore = null }: TriggerRunnerOptions) {
    this.db = db;
    this.runtime = runtime;
    this.playbookRouter = playbookRouter;
    this.runStore = runStore;
  }

  async runEventTrigger(event: JsonRecord, options: JsonRecord = {}): Promise<JsonRecord> {
    const playbook = this.playbookRouter.route({
      intent: options.intent || event.event_name,
      goal: options.goal || event.event_name,
      preferred_agent_id: options.preferred_agent_id
    });
    return this.runtime.runPlaybook({
      tenant_id: event.tenant_id,
      playbook_id: playbook.playbook_id,
      goal: options.goal || `Handle event ${event.event_name}`,
      source: 'event_trigger',
      business_context: {
        event_id: event.id,
        object_type: event.object_type,
        object_id: event.object_id,
        ...(options.business_context || {})
      },
      ...options.input
    });
  }

  createScheduledTrigger(input: JsonRecord): JsonRecord | null {
    const now = new Date().toISOString();
    const trigger = {
      id: input.id || id('schedule'),
      tenant_id: input.tenant_id,
      name: input.name,
      trigger_type: input.trigger_type || 'heartbeat',
      status: input.status || 'active',
      playbook_id: input.playbook_id || null,
      intent: input.intent || '',
      goal: input.goal,
      interval_seconds: input.interval_seconds || 86400,
      next_run_at: input.next_run_at || now,
      input: input.input || {},
      created_by: input.created_by || 'system'
    };
    run(
      this.db,
      `INSERT INTO scheduled_triggers
        (id, tenant_id, name, trigger_type, status, playbook_id, intent, goal, interval_seconds, next_run_at, input, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trigger.id,
        trigger.tenant_id,
        trigger.name,
        trigger.trigger_type,
        trigger.status,
        trigger.playbook_id,
        trigger.intent,
        trigger.goal,
        trigger.interval_seconds,
        trigger.next_run_at,
        json(trigger.input),
        trigger.created_by
      ]
    );
    this.runStore?.audit(trigger.tenant_id, 'scheduled_trigger.created', 'scheduled_trigger', trigger.id, {
      trigger_type: trigger.trigger_type,
      playbook_id: trigger.playbook_id,
      interval_seconds: trigger.interval_seconds
    });
    return this.getScheduledTrigger(trigger.tenant_id, trigger.id);
  }

  getScheduledTrigger(tenantId: string, triggerId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM scheduled_triggers WHERE tenant_id = ? AND id = ?', [tenantId, triggerId]);
    return row ? decodeTrigger(row) : null;
  }

  updateScheduledTrigger(tenantId: string, triggerId: string, patch: JsonRecord = {}): JsonRecord | null {
    const current = this.getScheduledTrigger(tenantId, triggerId);
    if (!current) {
      return null;
    }
    run(
      this.db,
      `UPDATE scheduled_triggers
       SET name = ?, status = ?, goal = ?, interval_seconds = ?, next_run_at = ?, input = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [
        patch.name || current.name,
        patch.status || current.status,
        patch.goal || current.goal,
        Number(patch.interval_seconds || current.interval_seconds || 86400),
        patch.next_run_at || current.next_run_at,
        json(patch.input ?? current.input ?? {}),
        tenantId,
        triggerId
      ]
    );
    this.runStore?.audit(tenantId, 'scheduled_trigger.updated', 'scheduled_trigger', triggerId, {
      status: patch.status || current.status,
      interval_seconds: Number(patch.interval_seconds || current.interval_seconds || 86400)
    });
    return this.getScheduledTrigger(tenantId, triggerId);
  }

  listScheduledTriggers({ tenant_id, status = null, playbook_id = null, trigger_type = null, limit = 200 }: JsonRecord = {}): JsonRecord[] {
    const clauses = [];
    const params = [];
    if (tenant_id) {
      clauses.push('tenant_id = ?');
      params.push(tenant_id);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (playbook_id) {
      clauses.push('playbook_id = ?');
      params.push(playbook_id);
    }
    if (trigger_type) {
      clauses.push('trigger_type = ?');
      params.push(trigger_type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return all(
      this.db,
      `SELECT * FROM scheduled_triggers
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, Number(limit || 200)]
    ).map(decodeTrigger);
  }

  listDueTriggers({ tenant_id, now = new Date().toISOString(), limit = 20 }: JsonRecord = {}): JsonRecord[] {
    const sql = tenant_id
      ? `SELECT * FROM scheduled_triggers
         WHERE tenant_id = ? AND status = 'active' AND datetime(next_run_at) <= datetime(?)
         ORDER BY next_run_at ASC
         LIMIT ?`
      : `SELECT * FROM scheduled_triggers
         WHERE status = 'active' AND datetime(next_run_at) <= datetime(?)
         ORDER BY next_run_at ASC
         LIMIT ?`;
    const params = tenant_id ? [tenant_id, now, limit] : [now, limit];
    return all(this.db, sql, params).map(decodeTrigger);
  }

  async tick(options: JsonRecord = {}): Promise<JsonRecord> {
    const now = options.now || new Date().toISOString();
    const dueTriggers = this.listDueTriggers({
      tenant_id: options.tenant_id,
      now,
      limit: options.limit || 20
    });
    const results = [];
    for (const trigger of dueTriggers) {
      results.push(await this.runScheduledTrigger(trigger, { now, user_id: options.user_id || 'scheduler' }));
    }
    return {
      status: results.every((result) => result.status === 'completed') ? 'completed' : 'completed_with_failures',
      checked_at: now,
      due: dueTriggers.length,
      results
    };
  }

  async runScheduledTrigger(trigger: JsonRecord, options: JsonRecord = {}): Promise<JsonRecord> {
    const schedulerRunId = id('schrun');
    run(
      this.db,
      `INSERT INTO scheduler_runs
        (id, tenant_id, scheduled_trigger_id, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
      [schedulerRunId, trigger.tenant_id, trigger.id, options.now || new Date().toISOString()]
    );

    try {
      const playbookId = trigger.playbook_id || this.playbookRouter.route({
        intent: trigger.intent || trigger.goal,
        goal: trigger.goal
      }).playbook_id;
      const result = await this.runtime.runPlaybook({
        tenant_id: trigger.tenant_id,
        user_id: options.user_id || 'scheduler',
        playbook_id: playbookId,
        goal: trigger.goal,
        source: 'scheduled_trigger',
        ...trigger.input
      });
      const feedbackReceipt = buildFeedbackReceipt(trigger, result);
      const finishedAt = new Date().toISOString();
      const nextRunAt = new Date(Date.parse(options.now || finishedAt) + trigger.interval_seconds * 1000).toISOString();
      run(
        this.db,
        `UPDATE scheduler_runs
         SET status = 'completed', workflow_run_id = ?, result = ?, finished_at = ?
         WHERE tenant_id = ? AND id = ?`,
        [
          result.workflow_run.id,
          json({
            workflow_run_id: result.workflow_run.id,
            agent_run_id: result.agent_run.id,
            status: result.workflow_run.status,
            feedback_receipt: feedbackReceipt
          }),
          finishedAt,
          trigger.tenant_id,
          schedulerRunId
        ]
      );
      run(
        this.db,
        `UPDATE scheduled_triggers
         SET last_run_at = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND id = ?`,
        [finishedAt, nextRunAt, trigger.tenant_id, trigger.id]
      );
      return {
        id: schedulerRunId,
        trigger_id: trigger.id,
        workflow_run_id: result.workflow_run.id,
        status: 'completed',
        next_run_at: nextRunAt,
        feedback_receipt: feedbackReceipt
      };
    } catch (error: any) {
      const finishedAt = new Date().toISOString();
      run(
        this.db,
        `UPDATE scheduler_runs
         SET status = 'failed', error = ?, finished_at = ?
         WHERE tenant_id = ? AND id = ?`,
        [json({ name: error.name, message: error.message }), finishedAt, trigger.tenant_id, schedulerRunId]
      );
      return {
        id: schedulerRunId,
        trigger_id: trigger.id,
        status: 'failed',
        error: { name: error.name, message: error.message }
      };
    }
  }
}

function decodeTrigger(row: JsonRecord): JsonRecord {
  return {
    ...row,
    input: parseJson(row.input)
  };
}

function buildFeedbackReceipt(trigger: JsonRecord, result: JsonRecord): JsonRecord {
  const stepOutputs = Array.isArray(result.step_outputs) ? result.step_outputs : [];
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const contactedLeads = Math.max(stepOutputs.length, 1);
  return verifyAndTune({
    goal: String(trigger.goal || trigger.name || 'scheduled_trigger'),
    stage: `scheduled_${String(trigger.trigger_type || 'heartbeat')}`,
    receipt: {
      contacted_leads: contactedLeads,
      replied_leads: Math.min(stepOutputs.length, contactedLeads),
      booked_calls: Math.min(artifacts.length, contactedLeads),
      bounce_rate: 0
    },
    thresholds: DEFAULT_FEEDBACK_THRESHOLDS
  });
}
