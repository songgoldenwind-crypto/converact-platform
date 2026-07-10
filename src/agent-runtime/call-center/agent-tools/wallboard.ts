import { all, id, one, run } from '../../../db.js';
import { AgentSeatStore } from '../seat-store.js';
import { CallQueueStore } from '../inbound/call-queue.js';
import { AGENT_SEAT_AVAILABLE_STATUSES } from '../types.js';

export interface WallboardSnapshot {
  generated_at: string;
  seats: {
    total: number;
    idle: number;
    busy: number;
    away: number;
    wrap_up: number;
    offline: number;
  };
  queues: Array<{
    queue_id: string;
    queue_name: string;
    waiting_count: number;
    available_agents: number;
    estimated_wait_sec: number;
  }>;
  calls: {
    active_inbound: number;
    active_outbound: number;
  };
  sla: {
    service_level_pct: number;
    avg_wait_sec: number;
    answered_today: number;
    abandoned_today: number;
  };
}

export class WallboardService {
  constructor(
    private readonly db: unknown,
    private readonly seatStore: AgentSeatStore,
    private readonly queueStore: CallQueueStore
  ) {}

  getSnapshot(tenantId: string): WallboardSnapshot {
    const seats = this.seatStore.listSeats(tenantId);
    const queues = this.queueStore.listQueues(tenantId).map((queue) => {
      const available = seats.filter(
        (seat) =>
          AGENT_SEAT_AVAILABLE_STATUSES.has(seat.status) &&
          this.queueStore.listMemberSeatIds(queue.id).includes(seat.id)
      ).length;
      const status = this.queueStore.getQueueStatus(queue.id, available);
      return {
        queue_id: queue.id,
        queue_name: queue.name,
        waiting_count: status.waiting_count,
        available_agents: status.available_agents,
        estimated_wait_sec: status.estimated_wait_sec
      };
    });

    const activeInbound = one(
      this.db,
      `SELECT COUNT(*) AS c FROM voice_call_sessions
       WHERE tenant_id = ? AND direction = 'inbound' AND status IN ('ringing', 'active', 'planned')`,
      [tenantId]
    );
    const activeOutbound = one(
      this.db,
      `SELECT COUNT(*) AS c FROM voice_call_sessions
       WHERE tenant_id = ? AND direction = 'outbound' AND status IN ('ringing', 'active', 'dialing', 'planned')`,
      [tenantId]
    );

    const answered = one(
      this.db,
      `SELECT COUNT(*) AS c FROM queue_entries qe
       JOIN call_queues cq ON cq.id = qe.queue_id
       WHERE cq.tenant_id = ? AND qe.answered_at IS NOT NULL AND date(qe.answered_at) = date('now')`,
      [tenantId]
    );
    const abandoned = one(
      this.db,
      `SELECT COUNT(*) AS c FROM queue_entries qe
       JOIN call_queues cq ON cq.id = qe.queue_id
       WHERE cq.tenant_id = ? AND qe.abandoned_at IS NOT NULL AND date(qe.abandoned_at) = date('now')`,
      [tenantId]
    );

    const answeredCount = Number((answered as { c?: number })?.c || 0);
    const abandonedCount = Number((abandoned as { c?: number })?.c || 0);
    const totalHandled = answeredCount + abandonedCount;
    const serviceLevelPct =
      totalHandled > 0 ? Math.round((answeredCount / totalHandled) * 1000) / 10 : 100;

    const avgWaitRow = one(
      this.db,
      `SELECT AVG((julianday(answered_at) - julianday(entered_at)) * 86400) AS avg_wait
       FROM queue_entries qe
       JOIN call_queues cq ON cq.id = qe.queue_id
       WHERE cq.tenant_id = ? AND qe.answered_at IS NOT NULL AND date(qe.answered_at) = date('now')`,
      [tenantId]
    );

    return {
      generated_at: new Date().toISOString(),
      seats: {
        total: seats.length,
        idle: seats.filter((s) => s.status === 'idle').length,
        busy: seats.filter((s) => s.status === 'busy').length,
        away: seats.filter((s) => s.status === 'away').length,
        wrap_up: seats.filter((s) => s.status === 'wrap_up').length,
        offline: seats.filter((s) => s.status === 'offline').length
      },
      queues,
      calls: {
        active_inbound: Number((activeInbound as { c?: number })?.c || 0),
        active_outbound: Number((activeOutbound as { c?: number })?.c || 0)
      },
      sla: {
        service_level_pct: serviceLevelPct,
        avg_wait_sec: Math.round(Number((avgWaitRow as { avg_wait?: number })?.avg_wait || 0)),
        answered_today: answeredCount,
        abandoned_today: abandonedCount
      }
    };
  }
}

export function adjustQueueEntryPriority(
  db: unknown,
  tenantId: string,
  queueId: string,
  entryId: string,
  priority: number
): boolean {
  const queueStore = new CallQueueStore(db);
  const queue = queueStore.getQueue(queueId);
  if (!queue || queue.tenant_id !== tenantId) return false;
  const entry = queueStore.getEntry(entryId);
  if (!entry || entry.queue_id !== queueId) return false;
  run(db, 'UPDATE queue_entries SET priority = ? WHERE id = ?', [priority, entryId]);
  return true;
}

export function listWallboardAlerts(db: unknown, tenantId: string): Array<{ type: string; message: string }> {
  const service = new WallboardService(db, new AgentSeatStore(db), new CallQueueStore(db));
  const snapshot = service.getSnapshot(tenantId);
  const alerts: Array<{ type: string; message: string }> = [];
  for (const queue of snapshot.queues) {
    if (queue.waiting_count > 0 && queue.available_agents === 0) {
      alerts.push({ type: 'queue_overload', message: `队列 ${queue.queue_name} 有 ${queue.waiting_count} 人等待但无空闲坐席` });
    }
    if (queue.estimated_wait_sec > 120) {
      alerts.push({ type: 'long_wait', message: `队列 ${queue.queue_name} 预估等待超过 2 分钟` });
    }
  }
  if (snapshot.sla.service_level_pct < 80) {
    alerts.push({ type: 'sla_breach', message: `今日服务水平 ${snapshot.sla.service_level_pct}% 低于 80%` });
  }
  return alerts;
}
