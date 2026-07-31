import { readMetadata } from '../metadata-helpers.js';

import { createLiveKitMediaModule } from '../../livekit/index.js';
import type { LiveKitRoomStore } from '../../livekit/room-store.js';
import type { VoiceStore } from '../../voice/voice-store.js';
import type { AgentSeatStore } from '../seat-store.js';
import { ConferenceService } from './conference.js';
import { bridgeRustpbxLeg } from '../rustpbx-call-control.js';

export interface WarmConsultResult {
  call_session_id: string;
  consult_room_name: string;
  target_seat_id: string;
  target_invite?: { token: string; livekit_url: string; configured: boolean };
}

export interface WarmBridgeResult {
  call_session_id: string;
  room_name: string;
  rustpbx_bridge?: { applied: boolean; error?: string };
  livekit_bridge: boolean;
}

export class WarmTransferBridgeService {
  constructor(
    private readonly voiceStore: VoiceStore,
    private readonly seatStore: AgentSeatStore,
    private readonly roomStore: LiveKitRoomStore
  ) {}

  async prepareConsult(
    tenantId: string,
    callSessionId: string,
    fromSeatId: string,
    targetSeatId: string
  ): Promise<WarmConsultResult> {
    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    const targetSeat = this.seatStore.getSeat(targetSeatId);
    if (!targetSeat) throw Object.assign(new Error('target seat not found'), { status: 404 });

    let room = this.roomStore.getRoomByCallSession(callSessionId);
    if (!room) {
      const roomName = `${tenantId}-warm-${callSessionId.slice(-8)}`;
      room = await this.roomStore.createRoom({
        tenant_id: tenantId,
        purpose: 'conference',
        call_session_id: callSessionId,
        room_name: roomName,
        metadata: { warm_transfer: true, consult: true }
      });
    }

    const metadata = readMetadata(session);
    this.voiceStore.updateCallSession(tenantId, callSessionId, {
      metadata: {
        ...metadata,
        warm_transfer_consult_room: room.room_name,
        warm_transfer_from_seat_id: fromSeatId,
        warm_transfer_target_seat_id: targetSeatId,
        warm_transfer_phase: 'consult'
      }
    });

    const media = createLiveKitMediaModule({ db: this.roomStore.db });
    const token = await media.tokens.issueParticipantToken({
      room_name: room.room_name,
      identity: targetSeat.livekit_identity || `seat-${targetSeat.id}`,
      role: 'agent',
      tenant_id: tenantId
    });

    return {
      call_session_id: callSessionId,
      consult_room_name: room.room_name,
      target_seat_id: targetSeatId,
      target_invite: {
        token: token.token,
        livekit_url: token.livekit_url,
        configured: token.configured
      }
    };
  }

  async completeBridge(
    tenantId: string,
    callSessionId: string,
    targetSeatId: string
  ): Promise<WarmBridgeResult> {
    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    const targetSeat = this.seatStore.getSeat(targetSeatId);
    if (!targetSeat) throw Object.assign(new Error('target seat not found'), { status: 404 });

    const rustpbxBridge = await bridgeRustpbxLeg(
      this.voiceStore,
      this.seatStore,
      tenantId,
      callSessionId,
      targetSeatId
    );

    const conference = new ConferenceService(this.voiceStore, this.roomStore);
    const conf = await conference.addParticipant({
      tenantId,
      callSessionId,
      seatId: targetSeatId,
      participantIdentity: targetSeat.livekit_identity || `seat-${targetSeat.id}`,
      participantLabel: targetSeat.display_name
    });

    const metadata = readMetadata(session);
    this.voiceStore.updateCallSession(tenantId, callSessionId, {
      metadata: {
        ...metadata,
        warm_transfer_phase: 'bridged',
        warm_transfer_pending: false,
        assigned_seat_id: targetSeatId,
        conference: true,
        conference_participants: conf.participants
      }
    });

    return {
      call_session_id: callSessionId,
      room_name: conf.room_name,
      rustpbx_bridge: {
        applied: rustpbxBridge.applied,
        error: rustpbxBridge.error
      },
      livekit_bridge: true
    };
  }
}
