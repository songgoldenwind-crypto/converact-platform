import { readMetadata } from '../metadata-helpers.js';

import type { VoiceStore } from '../../voice/voice-store.js';
import type { AgentSeatStore } from '../seat-store.js';
import type { LiveKitRoomStore } from '../../livekit/room-store.js';
import { broadcastCallIncoming, broadcastCallTransferred } from '../../../call-center-events.js';
import { WarmTransferBridgeService } from './warm-transfer-bridge.js';

export type TransferMode = 'blind' | 'warm' | 'cancel_warm';

export interface TransferInput {
  tenantId: string;
  callSessionId: string;
  fromSeatId: string;
  targetSeatId: string;
  mode: TransferMode;
  reason?: string;
}

export interface TransferResult {
  call_session_id: string;
  mode: TransferMode;
  target_seat_id: string;
  status: 'completed' | 'pending' | 'cancelled';
}

export class CallTransferService {
  constructor(
    private readonly voiceStore: VoiceStore,
    private readonly seatStore: AgentSeatStore,
    private readonly roomStore: LiveKitRoomStore
  ) {}

  transfer(input: TransferInput): TransferResult {
    const session = this.voiceStore.getCallSession(input.tenantId, input.callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    const fromSeat = this.seatStore.getSeat(input.fromSeatId);
    const targetSeat = this.seatStore.getSeat(input.targetSeatId);
    if (!fromSeat || fromSeat.tenant_id !== input.tenantId) {
      throw Object.assign(new Error('source seat not found'), { status: 404 });
    }
    if (!targetSeat || targetSeat.tenant_id !== input.tenantId) {
      throw Object.assign(new Error('target seat not found'), { status: 404 });
    }

    const metadata = readMetadata(session);
    const room = this.roomStore.getRoomByCallSession(input.callSessionId);
    const roomName = room?.room_name || `${input.tenantId}-pstn_bridge-${input.callSessionId.slice(-8)}`;

    if (input.mode === 'cancel_warm') {
      this.voiceStore.updateCallSession(input.tenantId, input.callSessionId, {
        metadata: {
          ...metadata,
          warm_transfer_pending: false,
          warm_transfer_target_seat_id: null
        }
      });
      broadcastCallTransferred(input.tenantId, {
        call_session_id: input.callSessionId,
        from_seat_id: input.fromSeatId,
        to_seat_id: input.targetSeatId,
        mode: 'cancel_warm',
        status: 'cancelled'
      });
      return {
        call_session_id: input.callSessionId,
        mode: 'cancel_warm',
        target_seat_id: input.targetSeatId,
        status: 'cancelled'
      };
    }

    if (input.mode === 'warm') {
      this.voiceStore.updateCallSession(input.tenantId, input.callSessionId, {
        metadata: {
          ...metadata,
          warm_transfer_pending: true,
          warm_transfer_target_seat_id: input.targetSeatId,
          warm_transfer_from_seat_id: input.fromSeatId,
          transfer_reason: input.reason || 'warm_transfer'
        }
      });

      const bridge = new WarmTransferBridgeService(this.voiceStore, this.seatStore, this.roomStore);
      void bridge
        .prepareConsult(input.tenantId, input.callSessionId, input.fromSeatId, input.targetSeatId)
        .then(() => {
          // Consult room prepared successfully — update metadata to reflect readiness.
          const updated = this.voiceStore.getCallSession(input.tenantId, input.callSessionId);
          const meta = updated && typeof updated.metadata === 'object' && updated.metadata
            ? { ...(updated.metadata as Record<string, unknown>) } : {};
          this.voiceStore.updateCallSession(input.tenantId, input.callSessionId, {
            metadata: { ...meta, warm_transfer_consult_ready: true }
          });
        })
        .catch((error) => {
          console.warn('[warm-transfer] consult prepare failed:', error);
          // Write failure into metadata so frontend can detect and retry/abort.
          const updated = this.voiceStore.getCallSession(input.tenantId, input.callSessionId);
          const meta = updated && typeof updated.metadata === 'object' && updated.metadata
            ? { ...(updated.metadata as Record<string, unknown>) } : {};
          this.voiceStore.updateCallSession(input.tenantId, input.callSessionId, {
            metadata: {
              ...meta,
              warm_transfer_consult_ready: false,
              warm_transfer_error: error instanceof Error ? error.message : String(error)
            }
          });
        });

      broadcastCallIncoming(input.tenantId, {
        call_session_id: input.callSessionId,
        room_name: roomName,
        seat_id: input.targetSeatId,
        target_user_id: targetSeat.user_id,
        from: String(session.phone_redacted || ''),
        customer_summary: '协商转接 — 请先与坐席沟通',
        transfer_reason: input.reason || 'warm_transfer'
      });
      broadcastCallTransferred(input.tenantId, {
        call_session_id: input.callSessionId,
        from_seat_id: input.fromSeatId,
        to_seat_id: input.targetSeatId,
        mode: 'warm',
        status: 'pending'
      });
      return {
        call_session_id: input.callSessionId,
        mode: 'warm',
        target_seat_id: input.targetSeatId,
        status: 'pending'
      };
    }

    // blind transfer
    this.seatStore.updateStatus(input.tenantId, input.fromSeatId, 'wrap_up', null);
    this.seatStore.updateStatus(input.tenantId, input.targetSeatId, 'busy', input.callSessionId);
    this.voiceStore.updateCallSession(input.tenantId, input.callSessionId, {
      metadata: {
        ...metadata,
        assigned_seat_id: input.targetSeatId,
        transferred_from_seat_id: input.fromSeatId,
        transfer_reason: input.reason || 'blind_transfer',
        warm_transfer_pending: false
      }
    });

    broadcastCallIncoming(input.tenantId, {
      call_session_id: input.callSessionId,
      room_name: roomName,
      seat_id: input.targetSeatId,
      target_user_id: targetSeat.user_id,
      from: String(session.phone_redacted || ''),
      customer_summary: String(metadata.customer_summary || '盲转来电'),
      transfer_reason: input.reason || 'blind_transfer'
    });
    broadcastCallTransferred(input.tenantId, {
      call_session_id: input.callSessionId,
      from_seat_id: input.fromSeatId,
      to_seat_id: input.targetSeatId,
      mode: 'blind',
      status: 'completed'
    });

    return {
      call_session_id: input.callSessionId,
      mode: 'blind',
      target_seat_id: input.targetSeatId,
      status: 'completed'
    };
  }

  completeWarmTransfer(input: Omit<TransferInput, 'mode'>): TransferResult {
    const session = this.voiceStore.getCallSession(input.tenantId, input.callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    const metadata = readMetadata(session);
    if (!metadata.warm_transfer_pending) {
      throw Object.assign(new Error('no warm transfer pending'), { status: 409 });
    }

    const targetSeatId = String(metadata.warm_transfer_target_seat_id || input.targetSeatId);
    const fromSeatId = String(metadata.warm_transfer_from_seat_id || input.fromSeatId);
    const targetSeat = this.seatStore.getSeat(targetSeatId);
    if (!targetSeat) throw Object.assign(new Error('target seat not found'), { status: 404 });

    const bridge = new WarmTransferBridgeService(this.voiceStore, this.seatStore, this.roomStore);
    void bridge
      .completeBridge(input.tenantId, input.callSessionId, targetSeatId)
      .then(() => {
        // Bridge completed — clear any prior error.
        const updated = this.voiceStore.getCallSession(input.tenantId, input.callSessionId);
        const meta = updated && typeof updated.metadata === 'object' && updated.metadata
          ? { ...(updated.metadata as Record<string, unknown>) } : {};
        delete meta.warm_transfer_error;
        this.voiceStore.updateCallSession(input.tenantId, input.callSessionId, { metadata: meta });
      })
      .catch((error) => {
        console.warn('[warm-transfer] bridge failed:', error);
        // Write failure into metadata so frontend can detect and handle.
        const updated = this.voiceStore.getCallSession(input.tenantId, input.callSessionId);
        const meta = updated && typeof updated.metadata === 'object' && updated.metadata
          ? { ...(updated.metadata as Record<string, unknown>) } : {};
        this.voiceStore.updateCallSession(input.tenantId, input.callSessionId, {
          metadata: {
            ...meta,
            warm_transfer_error: error instanceof Error ? error.message : String(error)
          }
        });
      });

    this.seatStore.updateStatus(input.tenantId, fromSeatId, 'wrap_up', null);
    this.seatStore.updateStatus(input.tenantId, targetSeatId, 'busy', input.callSessionId);
    this.voiceStore.updateCallSession(input.tenantId, input.callSessionId, {
      metadata: {
        ...metadata,
        warm_transfer_pending: false,
        assigned_seat_id: targetSeatId,
        transfer_reason: input.reason || 'warm_transfer_complete',
        warm_transfer_phase: 'completed'
      }
    });

    broadcastCallTransferred(input.tenantId, {
      call_session_id: input.callSessionId,
      from_seat_id: fromSeatId,
      to_seat_id: targetSeatId,
      mode: 'warm',
      status: 'completed'
    });

    return {
      call_session_id: input.callSessionId,
      mode: 'warm',
      target_seat_id: targetSeatId,
      status: 'completed'
    };
  }
}

