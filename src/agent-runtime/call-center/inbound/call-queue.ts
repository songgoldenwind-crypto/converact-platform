import { all, id, one, run } from '../../../db.js';
import type { AcdStrategy, CallQueueRow, QueueEntryRow, QueueStatusSnapshot } from './types.js';

function decodeQueue(row: Record<string, unknown>): CallQueueRow {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name),
    strategy: String(row.strategy) as AcdStrategy,
    max_wait_sec: Number(row.max_wait_sec),
    max_size: Number(row.max_size),
    overflow_target: row.overflow_target ? String(row.overflow_target) : null,
    music_url: row.music_url ? String(row.music_url) : null,
    callback_after_sec: Number(row.callback_after_sec ?? 120),
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at)
  };
}

function decodeEntry(row: Record<string, unknown>): QueueEntryRow {
  return {
    id: String(row.id),
    queue_id: String(row.queue_id),
    call_session_id: String(row.call_session_id),
    position: Number(row.position),
    priority: Number(row.priority),
    assigned_seat_id: row.assigned_seat_id ? String(row.assigned_seat_id) : null,
    entered_at: String(row.entered_at),
    answered_at: row.answered_at ? String(row.answered_at) : null,
    abandoned_at: row.abandoned_at ? String(row.abandoned_at) : null
  };
}

export class CallQueueStore {
  constructor(private readonly db: unknown) {}

  createQueue(input: {
    tenant_id: string;
    name: string;
    strategy?: AcdStrategy;
    max_wait_sec?: number;
    max_size?: number;
    overflow_target?: string | null;
    music_url?: string | null;
    callback_after_sec?: number;
  }): CallQueueRow {
    const queueId = id('queue');
    run(
      this.db,
      `INSERT INTO call_queues
        (id, tenant_id, name, strategy, max_wait_sec, max_size, overflow_target, music_url, callback_after_sec, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        queueId,
        input.tenant_id,
        input.name,
        input.strategy || 'longest_idle',
        input.max_wait_sec ?? 300,
        input.max_size ?? 50,
        input.overflow_target || null,
        input.music_url || null,
        input.callback_after_sec ?? 120
      ]
    );
    return this.getQueue(queueId)!;
  }

  getQueue(queueId: string): CallQueueRow | null {
    const row = one(this.db, 'SELECT * FROM call_queues WHERE id = ?', [queueId]);
    return row ? decodeQueue(row as Record<string, unknown>) : null;
  }

  getQueueByName(tenantId: string, name: string): CallQueueRow | null {
    const row = one(this.db, 'SELECT * FROM call_queues WHERE tenant_id = ? AND name = ?', [tenantId, name]);
    return row ? decodeQueue(row as Record<string, unknown>) : null;
  }

  listQueues(tenantId: string): CallQueueRow[] {
    return all(this.db, 'SELECT * FROM call_queues WHERE tenant_id = ? ORDER BY name ASC', [tenantId]).map(
      (row) => decodeQueue(row as Record<string, unknown>)
    );
  }

  addMember(queueId: string, seatId: string, priority = 1): void {
    run(
      this.db,
      `INSERT INTO queue_members (queue_id, seat_id, priority) VALUES (?, ?, ?)
       ON CONFLICT(queue_id, seat_id) DO UPDATE SET priority = excluded.priority`,
      [queueId, seatId, priority]
    );
  }

  listMemberSeatIds(queueId: string): string[] {
    return all(
      this.db,
      `SELECT seat_id FROM queue_members WHERE queue_id = ? ORDER BY priority DESC`,
      [queueId]
    ).map((row) => String((row as Record<string, unknown>).seat_id));
  }

  countWaiting(queueId: string): number {
    const row = one(
      this.db,
      `SELECT COUNT(*) AS c FROM queue_entries
       WHERE queue_id = ? AND answered_at IS NULL AND abandoned_at IS NULL`,
      [queueId]
    );
    return Number((row as { c?: number })?.c || 0);
  }

  enqueue(queueId: string, callSessionId: string, priority = 0): QueueEntryRow {
    const waiting = this.countWaiting(queueId);
    const entryId = id('qentry');
    const position = waiting + 1;
    run(
      this.db,
      `INSERT INTO queue_entries (id, queue_id, call_session_id, position, priority)
       VALUES (?, ?, ?, ?, ?)`,
      [entryId, queueId, callSessionId, position, priority]
    );
    return this.getEntry(entryId)!;
  }

  getEntry(entryId: string): QueueEntryRow | null {
    const row = one(this.db, 'SELECT * FROM queue_entries WHERE id = ?', [entryId]);
    return row ? decodeEntry(row as Record<string, unknown>) : null;
  }

  getActiveEntryByCallSession(callSessionId: string, tenantId?: string): QueueEntryRow | null {
    const row = tenantId
      ? one(
          this.db,
          `SELECT qe.* FROM queue_entries qe
           JOIN call_queues cq ON cq.id = qe.queue_id
           WHERE qe.call_session_id = ? AND cq.tenant_id = ?
             AND qe.answered_at IS NULL AND qe.abandoned_at IS NULL
           ORDER BY qe.entered_at DESC LIMIT 1`,
          [callSessionId, tenantId]
        )
      : one(
          this.db,
          `SELECT * FROM queue_entries
           WHERE call_session_id = ? AND answered_at IS NULL AND abandoned_at IS NULL
           ORDER BY entered_at DESC LIMIT 1`,
          [callSessionId]
        );
    return row ? decodeEntry(row as Record<string, unknown>) : null;
  }

  listWaitingEntries(queueId: string): QueueEntryRow[] {
    return all(
      this.db,
      `SELECT * FROM queue_entries
       WHERE queue_id = ? AND answered_at IS NULL AND abandoned_at IS NULL
       ORDER BY priority DESC, position ASC`,
      [queueId]
    ).map((row) => decodeEntry(row as Record<string, unknown>));
  }

  assignSeat(entryId: string, seatId: string): QueueEntryRow | null {
    run(this.db, 'UPDATE queue_entries SET assigned_seat_id = ? WHERE id = ?', [seatId, entryId]);
    return this.getEntry(entryId);
  }

  markAnswered(entryId: string): QueueEntryRow | null {
    run(this.db, `UPDATE queue_entries SET answered_at = CURRENT_TIMESTAMP WHERE id = ?`, [entryId]);
    return this.getEntry(entryId);
  }

  abandonEntry(entryId: string): QueueEntryRow | null {
    run(this.db, `UPDATE queue_entries SET abandoned_at = CURRENT_TIMESTAMP WHERE id = ?`, [entryId]);
    return this.getEntry(entryId);
  }

  estimateWaitSec(queueId: string, position: number): number {
    // Use subquery so LIMIT applies to rows BEFORE aggregation.
    // (LIMIT on outer AVG query is a no-op — the aggregate returns one row.)
    const row = one(
      this.db,
      `SELECT AVG(
         (julianday(answered_at) - julianday(entered_at)) * 86400
       ) AS avg_wait
       FROM (
         SELECT answered_at, entered_at FROM queue_entries
         WHERE queue_id = ? AND answered_at IS NOT NULL
         ORDER BY answered_at DESC
         LIMIT 20
       )`,
      [queueId]
    );
    const avg = Number((row as { avg_wait?: number })?.avg_wait);
    const perCall = Number.isFinite(avg) && avg > 0 ? Math.round(avg) : 60;
    return Math.max(perCall, position * perCall);
  }

  getQueueStatus(queueId: string, availableAgents: number): QueueStatusSnapshot {
    const queue = this.getQueue(queueId);
    if (!queue) throw new Error('queue not found');
    const waiting = this.listWaitingEntries(queueId);
    const now = Date.now();
    const entries = waiting.map((entry) => ({
      entry_id: entry.id,
      call_session_id: entry.call_session_id,
      position: entry.position,
      priority: entry.priority,
      wait_sec: Math.max(0, Math.round((now - Date.parse(entry.entered_at)) / 1000))
    }));
    const avgWait =
      entries.length > 0
        ? Math.round(entries.reduce((sum, item) => sum + item.wait_sec, 0) / entries.length)
        : this.estimateWaitSec(queueId, 1);
    const headPosition = entries[0]?.position || 1;
    return {
      queue_id: queue.id,
      queue_name: queue.name,
      waiting_count: waiting.length,
      available_agents: availableAgents,
      avg_wait_sec: avgWait,
      estimated_wait_sec: this.estimateWaitSec(queueId, headPosition),
      entries
    };
  }
}
