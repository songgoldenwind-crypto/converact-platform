import { all, id, one, run } from '../../../db.js';

export type QueueCallbackStatus = 'pending' | 'dialing' | 'completed' | 'failed' | 'cancelled';

export interface QueueCallbackRow {
  id: string;
  tenant_id: string;
  queue_id: string;
  call_session_id: string | null;
  phone_number: string;
  status: QueueCallbackStatus;
  created_at: string;
  completed_at: string | null;
}

function decodeCallback(row: Record<string, unknown>): QueueCallbackRow {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    queue_id: String(row.queue_id),
    call_session_id: row.call_session_id ? String(row.call_session_id) : null,
    phone_number: String(row.phone_number),
    status: String(row.status) as QueueCallbackStatus,
    created_at: String(row.created_at),
    completed_at: row.completed_at ? String(row.completed_at) : null
  };
}

export class QueueCallbackService {
  constructor(private readonly db: unknown) {}

  shouldOfferCallback(queueId: string, waitSec: number): boolean {
    const row = one(this.db, 'SELECT callback_after_sec FROM call_queues WHERE id = ?', [queueId]);
    const threshold = Number((row as { callback_after_sec?: number })?.callback_after_sec || 120);
    return waitSec >= threshold;
  }

  createCallback(input: {
    tenant_id: string;
    queue_id: string;
    call_session_id?: string | null;
    phone_number: string;
  }): QueueCallbackRow {
    const callbackId = id('qcb');
    run(
      this.db,
      `INSERT INTO queue_callbacks (id, tenant_id, queue_id, call_session_id, phone_number, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [callbackId, input.tenant_id, input.queue_id, input.call_session_id || null, input.phone_number]
    );
    return this.getCallback(callbackId)!;
  }

  getCallback(callbackId: string): QueueCallbackRow | null {
    const row = one(this.db, 'SELECT * FROM queue_callbacks WHERE id = ?', [callbackId]);
    return row ? decodeCallback(row as Record<string, unknown>) : null;
  }

  listPending(tenantId: string): QueueCallbackRow[] {
    return all(
      this.db,
      `SELECT * FROM queue_callbacks WHERE tenant_id = ? AND status = 'pending' ORDER BY created_at ASC`,
      [tenantId]
    ).map((row) => decodeCallback(row as Record<string, unknown>));
  }

  pickPending(limit = 10): QueueCallbackRow[] {
    return all(
      this.db,
      `SELECT * FROM queue_callbacks WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
      [limit]
    ).map((row) => decodeCallback(row as Record<string, unknown>));
  }

  markDialing(callbackId: string): QueueCallbackRow | null {
    run(this.db, `UPDATE queue_callbacks SET status = 'dialing' WHERE id = ?`, [callbackId]);
    return this.getCallback(callbackId);
  }

  markCompleted(callbackId: string): QueueCallbackRow | null {
    run(
      this.db,
      `UPDATE queue_callbacks SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [callbackId]
    );
    return this.getCallback(callbackId);
  }
}
