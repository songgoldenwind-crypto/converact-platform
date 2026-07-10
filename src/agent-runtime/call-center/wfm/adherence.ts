import { all, id, one, run } from '../../../db.js';
import type { AgentSeatStore } from '../seat-store.js';
import type { WfmStore } from './wfm-store.js';

export interface AdherenceRow {
  seat_id: string;
  display_name: string;
  scheduled: boolean;
  shift_start: string | null;
  shift_end: string | null;
  actual_status: string;
  adherent: boolean;
  deviation_minutes: number;
}

export function computeScheduleAdherence(
  _db: unknown,
  seatStore: AgentSeatStore,
  wfmStore: WfmStore,
  tenantId: string,
  date: string
): AdherenceRow[] {
  const schedules = wfmStore.listSchedules(tenantId, date);
  const scheduleBySeat = new Map(schedules.map((s) => [s.agent_seat_id, s]));
  const seats = seatStore.listSeats(tenantId);
  const now = new Date();
  // Use Asia/Shanghai timezone instead of server-local getHours().
  // WFM schedules store shift_start/shift_end as "HH:MM" in Asia/Shanghai.
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(now);
  const nowHour = Number(tzParts.find((p) => p.type === 'hour')?.value || now.getHours()) % 24;
  const nowMin = Number(tzParts.find((p) => p.type === 'minute')?.value || now.getMinutes());
  const nowMinutes = nowHour * 60 + nowMin;

  return seats.map((seat) => {
    const sched = scheduleBySeat.get(seat.id);
    if (!sched || sched.status === 'cancelled') {
      return {
        seat_id: seat.id,
        display_name: seat.display_name,
        scheduled: false,
        shift_start: null,
        shift_end: null,
        actual_status: seat.status,
        adherent: true,
        deviation_minutes: 0
      };
    }

    const [sh, sm] = sched.shift_start.split(':').map(Number);
    const [eh, em] = sched.shift_end.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const inShift = nowMinutes >= startMin && nowMinutes <= endMin;
    const expectedOnDuty = inShift && seat.status !== 'offline' && seat.status !== 'away';
    const adherent = inShift ? expectedOnDuty : seat.status === 'offline' || seat.status === 'away';
    const deviation = inShift && !adherent ? Math.min(Math.abs(nowMinutes - startMin), 30) : 0;

    return {
      seat_id: seat.id,
      display_name: seat.display_name,
      scheduled: true,
      shift_start: sched.shift_start,
      shift_end: sched.shift_end,
      actual_status: seat.status,
      adherent,
      deviation_minutes: deviation
    };
  });
}

export interface ShiftSwapRequest {
  id: string;
  tenant_id: string;
  requester_seat_id: string;
  target_seat_id: string | null;
  schedule_id: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewer_user_id: string | null;
  resolution_notes: string | null;
  created_at: string;
  resolved_at: string | null;
}

export function createShiftSwapRequest(
  db: unknown,
  input: {
    tenant_id: string;
    requester_seat_id: string;
    schedule_id: string;
    target_seat_id?: string | null;
    reason: string;
  }
): ShiftSwapRequest {
  const swapId = id('swap');
  run(
    db,
    `INSERT INTO wfm_shift_swap_requests
      (id, tenant_id, requester_seat_id, target_seat_id, schedule_id, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      swapId,
      input.tenant_id,
      input.requester_seat_id,
      input.target_seat_id || null,
      input.schedule_id,
      input.reason
    ]
  );
  return getShiftSwapRequest(db, swapId)!;
}

export function listShiftSwapRequests(
  db: unknown,
  tenantId: string,
  status: 'pending' | 'approved' | 'rejected' | null = null
): ShiftSwapRequest[] {
  const params: (string | number)[] = [tenantId];
  let sql = 'SELECT * FROM wfm_shift_swap_requests WHERE tenant_id = ?';
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC LIMIT 100';
  return all(db, sql, params).map(decodeSwap);
}

export function resolveShiftSwapRequest(
  db: unknown,
  swapId: string,
  tenantId: string,
  reviewerUserId: string,
  status: 'approved' | 'rejected',
  notes: string | null
): ShiftSwapRequest | null {
  const result = run(
    db,
    `UPDATE wfm_shift_swap_requests
     SET status = ?, reviewer_user_id = ?, resolution_notes = ?, resolved_at = CURRENT_TIMESTAMP
     WHERE id = ? AND tenant_id = ?`,
    [status, reviewerUserId, notes, swapId, tenantId]
  );
  // Check affected rows — if 0, swap request doesn't exist or belongs to
  // another tenant. Previously returned the old record regardless.
  if (!result || result.changes === 0) return null;
  return getShiftSwapRequest(db, swapId);
}

function getShiftSwapRequest(db: unknown, swapId: string): ShiftSwapRequest | null {
  const row = one(db, 'SELECT * FROM wfm_shift_swap_requests WHERE id = ?', [swapId]);
  return row ? decodeSwap(row) : null;
}

function decodeSwap(row: Record<string, unknown>): ShiftSwapRequest {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    requester_seat_id: String(row.requester_seat_id),
    target_seat_id: row.target_seat_id ? String(row.target_seat_id) : null,
    schedule_id: String(row.schedule_id),
    reason: String(row.reason || ''),
    status: String(row.status) as ShiftSwapRequest['status'],
    reviewer_user_id: row.reviewer_user_id ? String(row.reviewer_user_id) : null,
    resolution_notes: row.resolution_notes ? String(row.resolution_notes) : null,
    created_at: String(row.created_at),
    resolved_at: row.resolved_at ? String(row.resolved_at) : null
  };
}
