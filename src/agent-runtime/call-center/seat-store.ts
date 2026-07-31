import { all, id, json, one, parseJson, run } from '../../db.js';
import type { AgentSeatStatus } from './types.js';
import { AGENT_SEAT_AVAILABLE_STATUSES } from './types.js';

export interface AgentSeatRow {
  id: string;
  tenant_id: string;
  user_id: string;
  display_name: string;
  status: AgentSeatStatus;
  skills: string[];
  current_call_session_id: string | null;
  livekit_identity: string;
  rustpbx_extension: string;
  last_heartbeat_at: string | null;
}

export class AgentSeatStore {
  constructor(private readonly db: unknown) {}

  listSeats(tenantId: string): AgentSeatRow[] {
    return all(
      this.db,
      `SELECT * FROM agent_seats WHERE tenant_id = ? ORDER BY display_name ASC`,
      [tenantId]
    ).map(decodeSeat);
  }

  countIdleSeats(tenantId: string, skills: string[] = []): number {
    const seats = this.listSeats(tenantId).filter((seat) =>
      AGENT_SEAT_AVAILABLE_STATUSES.has(seat.status)
    );
    if (!skills.length) return seats.length;
    return seats.filter((seat) => skills.every((skill) => seat.skills.includes(skill))).length;
  }

  findAvailableSeat(tenantId: string, skills: string[] = []): AgentSeatRow | null {
    const candidates = this.listSeats(tenantId).filter((seat) =>
      AGENT_SEAT_AVAILABLE_STATUSES.has(seat.status)
    );
    const filtered = skills.length
      ? candidates.filter((seat) => skills.every((skill) => seat.skills.includes(skill)))
      : candidates;
    return filtered[0] || null;
  }

  upsertSeat(input: {
    tenant_id: string;
    user_id: string;
    display_name: string;
    skills?: string[];
    rustpbx_extension?: string;
    livekit_identity?: string;
  }): AgentSeatRow {
    const existing = one(this.db, 'SELECT * FROM agent_seats WHERE tenant_id = ? AND user_id = ?', [
      input.tenant_id,
      input.user_id
    ]);
    if (existing) {
      run(
        this.db,
        `UPDATE agent_seats
         SET display_name = ?, skills = ?, rustpbx_extension = COALESCE(?, rustpbx_extension),
             livekit_identity = COALESCE(?, livekit_identity), updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND user_id = ?`,
        [
          input.display_name,
          json(input.skills || parseJson(existing.skills, [])),
          input.rustpbx_extension || null,
          input.livekit_identity || null,
          input.tenant_id,
          input.user_id
        ]
      );
      return this.getSeatByUser(input.tenant_id, input.user_id)!;
    }
    const seatId = id('seat');
    run(
      this.db,
      `INSERT INTO agent_seats
        (id, tenant_id, user_id, display_name, skills, rustpbx_extension, livekit_identity)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        seatId,
        input.tenant_id,
        input.user_id,
        input.display_name,
        json(input.skills || []),
        input.rustpbx_extension || '',
        input.livekit_identity || `seat_${seatId}`
      ]
    );
    return this.getSeat(seatId)!;
  }

  updateStatus(tenantId: string, seatId: string, status: AgentSeatStatus, callSessionId: string | null = null): AgentSeatRow | null {
    run(
      this.db,
      `UPDATE agent_seats
       SET status = ?, current_call_session_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [status, callSessionId, tenantId, seatId]
    );
    return this.getSeat(seatId);
  }

  heartbeat(tenantId: string, seatId: string): AgentSeatRow | null {
    run(
      this.db,
      `UPDATE agent_seats
       SET last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [tenantId, seatId]
    );
    return this.getSeat(seatId);
  }

  getSeat(seatId: string): AgentSeatRow | null {
    const row = one(this.db, 'SELECT * FROM agent_seats WHERE id = ?', [seatId]);
    return row ? decodeSeat(row) : null;
  }

  /** Tenant-scoped seat lookup — throws 403 if seat belongs to another tenant. */
  getSeatForTenant(tenantId: string, seatId: string): AgentSeatRow | null {
    const row = one(this.db, 'SELECT * FROM agent_seats WHERE id = ? AND tenant_id = ?', [seatId, tenantId]);
    return row ? decodeSeat(row) : null;
  }

  /** Assert seat belongs to tenant; throws 403 if mismatch or not found. */
  assertSeatOwnership(tenantId: string, seatId: string): AgentSeatRow {
    const seat = this.getSeatForTenant(tenantId, seatId);
    if (!seat) {
      throw Object.assign(new Error(`seat ${seatId} not found for tenant ${tenantId}`), { status: 403 });
    }
    return seat;
  }

  getSeatByUser(tenantId: string, userId: string): AgentSeatRow | null {
    const row = one(this.db, 'SELECT * FROM agent_seats WHERE tenant_id = ? AND user_id = ?', [tenantId, userId]);
    return row ? decodeSeat(row) : null;
  }
}

function decodeSeat(row: Record<string, unknown>): AgentSeatRow {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    user_id: String(row.user_id),
    display_name: String(row.display_name),
    status: String(row.status) as AgentSeatStatus,
    skills: parseJson<string[]>(String(row.skills), []),
    current_call_session_id: row.current_call_session_id ? String(row.current_call_session_id) : null,
    livekit_identity: String(row.livekit_identity || ''),
    rustpbx_extension: String(row.rustpbx_extension || ''),
    last_heartbeat_at: row.last_heartbeat_at ? String(row.last_heartbeat_at) : null
  };
}
