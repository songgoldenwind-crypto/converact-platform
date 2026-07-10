import { all, id, json, one, parseJson, run, type SqliteParams } from '../../db.js';
import type { CreateOutboundTaskInput, OutboundTaskStatus } from './types.js';

export interface OutboundTaskRow {
  id: string;
  tenant_id: string;
  lead_id: string;
  phone_number: string;
  channel: string;
  status: OutboundTaskStatus;
  strategy: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  priority: number;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown>;
  call_session_id: string | null;
  campaign_id?: string | null;
  campaign_contact_id?: string | null;
  created_at: string;
  updated_at: string;
}

export class OutboundTaskStore {
  constructor(private readonly db: unknown) {}

  createTask(input: CreateOutboundTaskInput): OutboundTaskRow {
    const taskId = id('otask');
    run(
      this.db,
      `INSERT INTO outbound_tasks
        (id, tenant_id, lead_id, phone_number, channel, strategy, max_attempts, priority, scheduled_at, campaign_id, campaign_contact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        input.tenant_id,
        input.lead_id ?? '',
        input.phone_number ?? '',
        input.channel ?? 'pstn_voice',
        json(input.strategy ?? {}),
        input.max_attempts ?? 3,
        input.priority ?? 5,
        input.scheduled_at ?? null,
        input.campaign_id ?? null,
        input.campaign_contact_id ?? null
      ]
    );
    return this.getTask(taskId)!;
  }

  listTasks(tenantId: string, status: OutboundTaskStatus | null = null, limit = 50): OutboundTaskRow[] {
    const conditions = ['tenant_id = ?'];
    const params: SqliteParams = [tenantId];
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM outbound_tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params
    ).map(decodeTask);
  }

  getTask(taskId: string): OutboundTaskRow | null {
    const row = one(this.db, 'SELECT * FROM outbound_tasks WHERE id = ?', [taskId]);
    return row ? decodeTask(row) : null;
  }

  findActiveTaskByPhone(tenantId: string, phoneNumber: string): OutboundTaskRow | null {
    const row = one(
      this.db,
      `SELECT * FROM outbound_tasks
       WHERE tenant_id = ? AND phone_number = ? AND status IN ('pending', 'dialing', 'connected')
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, phoneNumber]
    );
    return row ? decodeTask(row) : null;
  }

  updateTask(taskId: string, patch: Partial<{
    status: OutboundTaskStatus;
    attempt_count: number;
    started_at: string | null;
    completed_at: string | null;
    result: Record<string, unknown>;
    call_session_id: string | null;
    strategy: Record<string, unknown>;
  }>): OutboundTaskRow | null {
    const fields: string[] = [];
    const params: SqliteParams = [];
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = ?`);
      if (key === 'result' || key === 'strategy') {
        params.push(json(value));
      } else {
        params.push(value as string | number | null);
      }
    }
    if (!fields.length) return this.getTask(taskId);
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(taskId);
    run(this.db, `UPDATE outbound_tasks SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.getTask(taskId);
  }

  cancelTask(taskId: string): OutboundTaskRow | null {
    return this.updateTask(taskId, { status: 'cancelled', completed_at: new Date().toISOString() });
  }

  pickPendingTasks(limit = 10): OutboundTaskRow[] {
    return all(
      this.db,
      `SELECT * FROM outbound_tasks
       WHERE status = 'pending'
         AND (scheduled_at IS NULL OR datetime(scheduled_at) <= datetime('now'))
       ORDER BY priority DESC, created_at ASC
       LIMIT ?`,
      [limit]
    )
      .map(decodeTask)
      .filter((task) => {
        const strategy = task.strategy || {};
        if (String(strategy.dial_mode || '') === 'preview' && strategy.preview_confirmed !== true) {
          return false;
        }
        return true;
      });
  }

  confirmPreviewDial(taskId: string): OutboundTaskRow | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const strategy = { ...(task.strategy || {}), preview_confirmed: true };
    return this.updateTask(taskId, { strategy });
  }

  listPreviewTasksForSeat(tenantId: string, seatId: string, limit = 20): OutboundTaskRow[] {
    return all(
      this.db,
      `SELECT * FROM outbound_tasks
       WHERE tenant_id = ? AND status = 'pending'
       ORDER BY priority DESC, created_at ASC
       LIMIT ?`,
      [tenantId, limit]
    )
      .map(decodeTask)
      .filter((task) => {
        const strategy = task.strategy || {};
        return (
          String(strategy.dial_mode || '') === 'preview' &&
          String(strategy.assigned_seat_id || '') === seatId &&
          strategy.preview_confirmed !== true
        );
      });
  }
}

function decodeTask(row: Record<string, unknown>): OutboundTaskRow {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    lead_id: String(row.lead_id || ''),
    phone_number: String(row.phone_number),
    channel: String(row.channel),
    status: String(row.status) as OutboundTaskStatus,
    strategy: parseJson(String(row.strategy), {}),
    attempt_count: Number(row.attempt_count || 0),
    max_attempts: Number(row.max_attempts || 3),
    priority: Number(row.priority || 5),
    scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
    started_at: row.started_at ? String(row.started_at) : null,
    completed_at: row.completed_at ? String(row.completed_at) : null,
    result: parseJson(String(row.result), {}),
    call_session_id: row.call_session_id ? String(row.call_session_id) : null,
    campaign_id: row.campaign_id ? String(row.campaign_id) : null,
    campaign_contact_id: row.campaign_contact_id ? String(row.campaign_contact_id) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at || row.created_at)
  };
}
