import { all, one, run } from '../../../db.js';
import type { VoiceStore } from '../../voice/voice-store.js';
import { broadcastCallIncoming } from '../../../call-center-events.js';
import type { AgentSeatStore } from '../seat-store.js';
import { readMetadata } from '../metadata-helpers.js';

export interface ParkResult {
  slot: number;
  call_session_id: string;
  tenant_id: string;
}

export class ParkPickupService {
  constructor(
    private readonly db: unknown,
    private readonly voiceStore: VoiceStore,
    private readonly seatStore: AgentSeatStore
  ) {}

  parkCall(tenantId: string, callSessionId: string, seatId: string, slot = 1): ParkResult {
    // Clean up stale park slots (calls that ended without pickup).
    this.cleanupStaleSlots(tenantId);

    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });
    if (slot < 1 || slot > 9) throw Object.assign(new Error('slot must be 1-9'), { status: 400 });

    const existing = one(this.db, 'SELECT slot FROM call_park_slots WHERE tenant_id = ? AND slot = ?', [
      tenantId,
      slot
    ]);
    if (existing) throw Object.assign(new Error('park slot occupied'), { status: 409 });

    run(
      this.db,
      `INSERT INTO call_park_slots (slot, tenant_id, call_session_id, parked_by_seat_id)
       VALUES (?, ?, ?, ?)`,
      [slot, tenantId, callSessionId, seatId]
    );

    const metadata = readMetadata(session);
    this.voiceStore.updateCallSession(tenantId, callSessionId, {
      metadata: { ...metadata, parked_slot: slot, parked_by_seat_id: seatId }
    });

    return { slot, call_session_id: callSessionId, tenant_id: tenantId };
  }

  pickupCall(tenantId: string, slot: number, seatId: string): ParkResult {
    const row = one(
      this.db,
      'SELECT * FROM call_park_slots WHERE tenant_id = ? AND slot = ?',
      [tenantId, slot]
    );
    if (!row) throw Object.assign(new Error('park slot empty'), { status: 404 });

    const callSessionId = String((row as { call_session_id: string }).call_session_id);
    run(this.db, 'DELETE FROM call_park_slots WHERE tenant_id = ? AND slot = ?', [tenantId, slot]);

    const seat = this.seatStore.getSeat(seatId);
    this.seatStore.updateStatus(tenantId, seatId, 'busy', callSessionId);

    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    broadcastCallIncoming(tenantId, {
      call_session_id: callSessionId,
      room_name: `${tenantId}-pstn_bridge-${callSessionId.slice(-8)}`,
      seat_id: seatId,
      target_user_id: seat?.user_id || '',
      from: String(session?.phone_redacted || ''),
      customer_summary: `驻留拾取 · 车位 ${slot}`,
      transfer_reason: 'park_pickup'
    });

    return { slot, call_session_id: callSessionId, tenant_id: tenantId };
  }

  /** Remove park slots whose call session has ended (no cleanup was done on hangup). */
  cleanupStaleSlots(tenantId: string): number {
    const slots = all(
      this.db,
      'SELECT slot, call_session_id FROM call_park_slots WHERE tenant_id = ?',
      [tenantId]
    );
    let cleaned = 0;
    for (const row of slots) {
      const callSessionId = String((row as { call_session_id: string }).call_session_id);
      const session = this.voiceStore.getCallSession(tenantId, callSessionId);
      if (!session || session.status === 'ended' || session.status === 'failed') {
        run(this.db, 'DELETE FROM call_park_slots WHERE tenant_id = ? AND call_session_id = ?', [
          tenantId,
          callSessionId
        ]);
        cleaned++;
      }
    }
    return cleaned;
  }
}
