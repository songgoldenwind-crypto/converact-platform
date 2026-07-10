import { all, id, json, one, run } from '../../../db.js';
import { AgentSeatStore, type AgentSeatRow } from '../seat-store.js';
import { AGENT_SEAT_AVAILABLE_STATUSES } from '../types.js';
import { CallQueueStore } from '../inbound/call-queue.js';

export interface RoutingPredictionInput {
  tenant_id: string;
  queue_id?: string;
  required_skills?: string[];
  customer_phone?: string;
  vip_priority?: number;
}

export interface RoutingPrediction {
  seat_id: string | null;
  seat_display_name: string | null;
  confidence: number;
  factors: Record<string, number>;
  explanation: string;
}

export function predictBestSeat(db: unknown, input: RoutingPredictionInput): RoutingPrediction {
  const seatStore = new AgentSeatStore(db);
  const queueStore = new CallQueueStore(db);
  const memberSeatIds = input.queue_id ? queueStore.listMemberSeatIds(input.queue_id) : [];
  const skills = input.required_skills || [];

  let candidates = seatStore
    .listSeats(input.tenant_id)
    .filter((seat) => AGENT_SEAT_AVAILABLE_STATUSES.has(seat.status));

  if (memberSeatIds.length) {
    const memberSet = new Set(memberSeatIds);
    candidates = candidates.filter((seat) => memberSet.has(seat.id));
  }
  if (skills.length) {
    candidates = candidates.filter((seat) => skills.every((skill) => seat.skills.includes(skill)));
  }

  if (!candidates.length) {
    return {
      seat_id: null,
      seat_display_name: null,
      confidence: 0,
      factors: {},
      explanation: 'no available seats matching skills'
    };
  }

  const callCounts = loadSeatCallCounts(db, input.tenant_id);
  const qmScores = loadSeatQmScores(db, input.tenant_id);
  const now = Date.now();

  const ranked = candidates.map((seat) => {
    const skillMatch = skills.length
      ? skills.filter((s) => seat.skills.includes(s)).length / skills.length
      : 1;
    const idleMs = now - (Date.parse(seat.last_heartbeat_at || '') || now);
    const idleScore = Math.min(idleMs / 300_000, 1);
    const loadScore = 1 / (1 + (callCounts.get(seat.id) || 0));
    const qmScore = qmScores.get(seat.id) ?? 0.5;
    const vipBoost = (input.vip_priority || 0) > 0 && seat.skills.includes('vip') ? 0.15 : 0;

    const total =
      skillMatch * 0.35 + idleScore * 0.25 + loadScore * 0.2 + qmScore * 0.2 + vipBoost;

    return {
      seat,
      total,
      factors: {
        skill_match: skillMatch,
        idle_score: idleScore,
        load_score: loadScore,
        qm_score: qmScore,
        vip_boost: vipBoost
      }
    };
  });

  ranked.sort((a, b) => b.total - a.total);
  const best = ranked[0];

  logRoutingPrediction(db, {
    tenant_id: input.tenant_id,
    queue_id: input.queue_id || null,
    seat_id: best.seat.id,
    confidence: best.total,
    factors: best.factors
  });

  return {
    seat_id: best.seat.id,
    seat_display_name: best.seat.display_name,
    confidence: round(best.total),
    factors: Object.fromEntries(
      Object.entries(best.factors).map(([k, v]) => [k, round(v)])
    ),
    explanation: `heuristic: skill=${round(best.factors.skill_match)}, idle=${round(best.factors.idle_score)}, load=${round(best.factors.load_score)}, qm=${round(best.factors.qm_score)}`
  };
}

export function predictBestSeatRow(db: unknown, input: RoutingPredictionInput): AgentSeatRow | null {
  const prediction = predictBestSeat(db, input);
  if (!prediction.seat_id) return null;
  return new AgentSeatStore(db).getSeat(prediction.seat_id);
}

function loadSeatCallCounts(db: unknown, tenantId: string): Map<string, number> {
  const counts = new Map<string, number>();
  const rows = all(
    db,
    `SELECT metadata FROM voice_call_sessions
     WHERE tenant_id = ? AND direction = 'inbound' AND date(created_at) = date('now')`,
    [tenantId]
  );
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String((row as { metadata?: string }).metadata || '{}')) as {
        assigned_seat_id?: string;
      };
      if (parsed.assigned_seat_id) {
        counts.set(parsed.assigned_seat_id, (counts.get(parsed.assigned_seat_id) || 0) + 1);
      }
    } catch {
      // ignore malformed metadata
    }
  }
  return counts;
}

function loadSeatQmScores(db: unknown, tenantId: string): Map<string, number> {
  const scores = new Map<string, { sum: number; count: number }>();
  try {
    const rows = all(
      db,
      `SELECT v.metadata, q.overall_score
       FROM qm_evaluations q
       JOIN voice_call_sessions v ON v.id = q.call_session_id
       WHERE q.tenant_id = ?`,
      [tenantId]
    );
    for (const row of rows) {
      try {
        const metadata = JSON.parse(String((row as { metadata?: string }).metadata || '{}')) as {
          assigned_seat_id?: string;
        };
        const seatId = metadata.assigned_seat_id;
        if (!seatId) continue;
        const overall = Number((row as { overall_score: number }).overall_score);
        const bucket = scores.get(seatId) || { sum: 0, count: 0 };
        bucket.sum += overall;
        bucket.count += 1;
        scores.set(seatId, bucket);
      } catch {
        // ignore
      }
    }
  } catch {
    // qm table may not exist in minimal test DB
  }
  const result = new Map<string, number>();
  for (const [seatId, bucket] of scores) {
    result.set(seatId, bucket.sum / bucket.count);
  }
  return result;
}

function logRoutingPrediction(
  db: unknown,
  input: {
    tenant_id: string;
    queue_id: string | null;
    seat_id: string;
    confidence: number;
    factors: Record<string, number>;
  }
): void {
  run(
    db,
    `INSERT INTO routing_predictions (id, tenant_id, queue_id, recommended_seat_id, confidence, factors)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id('rout'),
      input.tenant_id,
      input.queue_id,
      input.seat_id,
      input.confidence,
      json(input.factors)
    ]
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
