import { all, one } from '../../../db.js';
import type { AgentSeatRow, AgentSeatStore } from '../seat-store.js';
import { AGENT_SEAT_AVAILABLE_STATUSES } from '../types.js';
import type { AcdStrategy } from './types.js';
import type { CallQueueStore } from './call-queue.js';
import { predictBestSeatRow } from '../routing/heuristic-router.js';

const roundRobinCursor = new Map<string, number>();

export interface AcdFindOptions {
  requiredSkills?: string[];
  vipPriority?: number;
}

export class AcdEngine {
  constructor(
    private readonly db: unknown,
    private readonly seatStore: AgentSeatStore,
    private readonly queueStore: CallQueueStore
  ) {}

  findBestSeat(queueId: string, strategy: AcdStrategy, options: AcdFindOptions = {}): AgentSeatRow | null {
    const memberSeatIds = this.queueStore.listMemberSeatIds(queueId);
    const tenantId = this.queueStore.getQueue(queueId)?.tenant_id;
    if (!tenantId) return null;

    let candidates = this.seatStore
      .listSeats(tenantId)
      .filter((seat) => AGENT_SEAT_AVAILABLE_STATUSES.has(seat.status));

    if (memberSeatIds.length) {
      const memberSet = new Set(memberSeatIds);
      candidates = candidates.filter((seat) => memberSet.has(seat.id));
    }

    const skills = options.requiredSkills || [];
    if (skills.length) {
      candidates = candidates.filter((seat) => skills.every((skill) => seat.skills.includes(skill)));
    }
    if (!candidates.length) return null;

    switch (strategy) {
      case 'least_calls':
        return this.pickLeastCalls(tenantId, candidates);
      case 'skill_priority':
        return this.pickSkillPriority(queueId, candidates);
      case 'round_robin':
        return this.pickRoundRobin(queueId, candidates);
      case 'predictive_heuristic': {
        const tenantId = this.queueStore.getQueue(queueId)?.tenant_id;
        if (!tenantId) return null;
        return (
          predictBestSeatRow(this.db, {
            tenant_id: tenantId,
            queue_id: queueId,
            required_skills: options.requiredSkills,
            vip_priority: options.vipPriority
          }) || this.pickLongestIdle(candidates)
        );
      }
      case 'longest_idle':
      default:
        return this.pickLongestIdle(candidates);
    }
  }

  countAvailableAgents(queueId: string, requiredSkills: string[] = []): number {
    const seat = this.findBestSeat(queueId, 'longest_idle', { requiredSkills });
    if (!seat) return 0;
    const tenantId = this.queueStore.getQueue(queueId)?.tenant_id;
    if (!tenantId) return 0;
    const memberSeatIds = new Set(this.queueStore.listMemberSeatIds(queueId));
    return this.seatStore.listSeats(tenantId).filter((item) => {
      if (!AGENT_SEAT_AVAILABLE_STATUSES.has(item.status)) return false;
      if (memberSeatIds.size && !memberSeatIds.has(item.id)) return false;
      if (requiredSkills.length && !requiredSkills.every((skill) => item.skills.includes(skill))) return false;
      return true;
    }).length;
  }

  private pickLongestIdle(candidates: AgentSeatRow[]): AgentSeatRow {
    // Pick the seat with the earliest heartbeat that is still recent enough
    // to be considered online. Seats with no heartbeat in the last 90 seconds
    // are treated as stale/offline and deprioritized to the end.
    // (Previously: sorted by earliest heartbeat unconditionally, which could
    //  assign calls to seats that had gone offline.)
    const STALE_THRESHOLD_MS = 90_000;
    const now = Date.now();
    return [...candidates].sort((a, b) => {
      const aTs = Date.parse(a.last_heartbeat_at || '') || 0;
      const bTs = Date.parse(b.last_heartbeat_at || '') || 0;
      const aStale = now - aTs > STALE_THRESHOLD_MS;
      const bStale = now - bTs > STALE_THRESHOLD_MS;
      // Non-stale seats come first; among non-stale, earliest heartbeat wins
      // (longest idle). Among stale, latest heartbeat wins (closest to online).
      if (aStale !== bStale) return aStale ? 1 : -1;
      return aStale ? bTs - aTs : aTs - bTs;
    })[0];
  }

  private pickLeastCalls(tenantId: string, candidates: AgentSeatRow[]): AgentSeatRow {
    const counts = new Map<string, number>();
    const rows = all(
      this.db,
      `SELECT metadata FROM voice_call_sessions
       WHERE tenant_id = ? AND direction = 'inbound' AND date(created_at) = date('now')`,
      [tenantId]
    );
    for (const row of rows) {
      const metadata = String((row as { metadata?: string }).metadata || '{}');
      try {
        const parsed = JSON.parse(metadata) as { assigned_seat_id?: string };
        if (parsed.assigned_seat_id) {
          counts.set(parsed.assigned_seat_id, (counts.get(parsed.assigned_seat_id) || 0) + 1);
        }
      } catch {
        // ignore malformed metadata
      }
    }
    return [...candidates].sort(
      (a, b) => (counts.get(a.id) || 0) - (counts.get(b.id) || 0) || a.display_name.localeCompare(b.display_name)
    )[0];
  }

  private pickSkillPriority(queueId: string, candidates: AgentSeatRow[]): AgentSeatRow {
    const priorities = new Map<string, number>();
    for (const seatId of this.queueStore.listMemberSeatIds(queueId)) {
      const row = one(this.db, 'SELECT priority FROM queue_members WHERE queue_id = ? AND seat_id = ?', [
        queueId,
        seatId
      ]);
      priorities.set(seatId, Number((row as { priority?: number })?.priority || 1));
    }
    return [...candidates].sort((a, b) => {
      const priorityDiff = (priorities.get(b.id) || 0) - (priorities.get(a.id) || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return this.pickLongestIdle([a, b]).id === a.id ? -1 : 1;
    })[0];
  }

  private pickRoundRobin(queueId: string, candidates: AgentSeatRow[]): AgentSeatRow {
    const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
    const cursor = roundRobinCursor.get(queueId) || 0;
    const seat = sorted[cursor % sorted.length];
    roundRobinCursor.set(queueId, (cursor + 1) % sorted.length);
    return seat;
  }
}
