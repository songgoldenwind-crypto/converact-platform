import { all, id, one, run } from '../../../db.js';

export interface TransferQueueEntry {
  id: string;
  tenant_id: string;
  call_session_id: string;
  room_name: string;
  customer_name: string;
  customer_phone: string;
  customer_summary: string;
  intent_score: number;
  priority: number;
  enqueued_at: string;
  assigned_seat_id: string | null;
  assigned_at: string | null;
  expired_at: string | null;
  status: 'waiting' | 'assigned' | 'expired' | 'cancelled';
}

export class TransferQueueStore {
  constructor(private readonly db: unknown) {}

  enqueue(input: {
    tenant_id: string;
    call_session_id: string;
    room_name?: string;
    customer_name?: string;
    customer_phone?: string;
    customer_summary?: string;
    intent_score?: number;
    priority?: number;
  }): TransferQueueEntry {
    const entryId = id('tq');
    run(
      this.db,
      `INSERT INTO transfer_queue
        (id, tenant_id, call_session_id, room_name, customer_name, customer_phone, customer_summary, intent_score, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        input.tenant_id,
        input.call_session_id,
        input.room_name || '',
        input.customer_name || '',
        input.customer_phone || '',
        input.customer_summary || '',
        input.intent_score ?? 0,
        input.priority ?? 5
      ]
    );
    return this.get(entryId)!;
  }

  listWaiting(tenantId: string): TransferQueueEntry[] {
    return all(
      this.db,
      `SELECT * FROM transfer_queue
       WHERE tenant_id = ? AND status = 'waiting'
       ORDER BY priority DESC, enqueued_at ASC`,
      [tenantId]
    ).map(decodeEntry);
  }

  get(entryId: string): TransferQueueEntry | null {
    const row = one(this.db, 'SELECT * FROM transfer_queue WHERE id = ?', [entryId]);
    return row ? decodeEntry(row) : null;
  }

  assign(entryId: string, tenantId: string, seatId: string): TransferQueueEntry | null {
    const result = run(
      this.db,
      `UPDATE transfer_queue
       SET status = 'assigned', assigned_seat_id = ?, assigned_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ? AND status = 'waiting'`,
      [seatId, entryId, tenantId]
    );
    if (Number(result?.changes || 0) === 0) return null;
    return this.get(entryId);
  }

  cancelByCallSession(tenantId: string, callSessionId: string): void {
    run(
      this.db,
      `UPDATE transfer_queue SET status = 'cancelled'
       WHERE tenant_id = ? AND call_session_id = ? AND status = 'waiting'`,
      [tenantId, callSessionId]
    );
  }
}

function decodeEntry(row: Record<string, unknown>): TransferQueueEntry {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_session_id: String(row.call_session_id),
    room_name: String(row.room_name || ''),
    customer_name: String(row.customer_name || ''),
    customer_phone: String(row.customer_phone || ''),
    customer_summary: String(row.customer_summary || ''),
    intent_score: Number(row.intent_score ?? 0),
    priority: Number(row.priority ?? 5),
    enqueued_at: String(row.enqueued_at),
    assigned_seat_id: row.assigned_seat_id ? String(row.assigned_seat_id) : null,
    assigned_at: row.assigned_at ? String(row.assigned_at) : null,
    expired_at: row.expired_at ? String(row.expired_at) : null,
    status: String(row.status) as TransferQueueEntry['status']
  };
}
