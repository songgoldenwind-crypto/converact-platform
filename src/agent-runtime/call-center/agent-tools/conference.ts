import { readMetadata } from '../metadata-helpers.js';

import { createLiveKitMediaModule } from '../../livekit/index.js';
import type { LiveKitRoomStore } from '../../livekit/room-store.js';
import type { VoiceStore } from '../../voice/voice-store.js';

export interface ConferenceParticipant {
  identity: string;
  label: string;
  role: 'customer' | 'agent' | 'third_party';
  joined_at: string;
}

export interface AddConferenceParticipantInput {
  tenantId: string;
  callSessionId: string;
  seatId: string;
  participantIdentity: string;
  participantLabel?: string;
}

export interface ConferenceResult {
  call_session_id: string;
  room_name: string;
  participants: ConferenceParticipant[];
  invite?: { token: string; livekit_url: string; configured: boolean };
}

export class ConferenceService {
  constructor(
    private readonly voiceStore: VoiceStore,
    private readonly roomStore: LiveKitRoomStore
  ) {}

  async addParticipant(input: AddConferenceParticipantInput): Promise<ConferenceResult> {
    const session = this.voiceStore.getCallSession(input.tenantId, input.callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    let room = this.roomStore.getRoomByCallSession(input.callSessionId);
    if (!room) {
      const roomName = `${input.tenantId}-conf-${input.callSessionId.slice(-8)}`;
      room = await this.roomStore.createRoom({
        tenant_id: input.tenantId,
        purpose: 'conference',
        call_session_id: input.callSessionId,
        room_name: roomName,
        metadata: { conference: true }
      });
    }

    const metadata = readMetadata(session);
    const participants = Array.isArray(metadata.conference_participants)
      ? [...(metadata.conference_participants as ConferenceParticipant[])]
      : [];

    const identity = input.participantIdentity.trim();
    if (!identity) throw Object.assign(new Error('participant_identity is required'), { status: 400 });

    if (!participants.some((p) => p.identity === identity)) {
      participants.push({
        identity,
        label: input.participantLabel || identity,
        role: 'third_party',
        joined_at: new Date().toISOString()
      });
    }

    this.voiceStore.updateCallSession(input.tenantId, input.callSessionId, {
      metadata: {
        ...metadata,
        conference: true,
        conference_participants: participants,
        conference_host_seat_id: input.seatId
      }
    });

    const media = createLiveKitMediaModule({ db: this.roomStore.db });
    const token = await media.tokens.issueParticipantToken({
      room_name: room.room_name,
      identity,
      role: 'customer',
      tenant_id: input.tenantId
    });

    return {
      call_session_id: input.callSessionId,
      room_name: room.room_name,
      participants,
      invite: {
        token: token.token,
        livekit_url: token.livekit_url,
        configured: token.configured
      }
    };
  }
}
