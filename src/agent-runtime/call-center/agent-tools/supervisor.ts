import { createLiveKitMediaModule } from '../../livekit/index.js';
import type { LiveKitRoomStore } from '../../livekit/room-store.js';
import type { VoiceStore } from '../../voice/voice-store.js';
import { broadcastCallEnded } from '../../../call-center-events.js';

export type SupervisorMode = 'listen' | 'barge' | 'whisper';

export interface SupervisorJoinInput {
  tenantId: string;
  supervisorUserId: string;
  callSessionId: string;
  mode: SupervisorMode;
}

export interface SupervisorJoinResult {
  call_session_id: string;
  room_name: string;
  mode: SupervisorMode;
  livekit: {
    token: string;
    livekit_url: string;
    configured: boolean;
  };
}

export class SupervisorService {
  constructor(
    private readonly voiceStore: VoiceStore,
    private readonly roomStore: LiveKitRoomStore
  ) {}

  async joinMonitor(input: SupervisorJoinInput): Promise<SupervisorJoinResult> {
    const session = this.voiceStore.getCallSession(input.tenantId, input.callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    const room =
      this.roomStore.getRoomByCallSession(input.callSessionId) ||
      (await this.roomStore.createRoom({
        tenant_id: input.tenantId,
        purpose: 'pstn_bridge',
        call_session_id: input.callSessionId,
        room_name: `${input.tenantId}-pstn_bridge-${input.callSessionId.slice(-8)}`
      }));

    const media = createLiveKitMediaModule({ db: this.roomStore.db });
    const token = await media.tokens.issueSupervisorToken({
      room_name: room.room_name,
      identity: `supervisor_${input.supervisorUserId}`,
      mode: input.mode,
      tenant_id: input.tenantId
    });

    const metadata =
      session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? { ...(session.metadata as Record<string, unknown>) }
        : {};
    const monitors = Array.isArray(metadata.supervisor_monitors)
      ? [...(metadata.supervisor_monitors as string[])]
      : [];
    if (!monitors.includes(input.supervisorUserId)) monitors.push(input.supervisorUserId);

    this.voiceStore.updateCallSession(input.tenantId, input.callSessionId, {
      metadata: {
        ...metadata,
        supervisor_monitors: monitors,
        last_supervisor_mode: input.mode
      }
    });

    return {
      call_session_id: input.callSessionId,
      room_name: room.room_name,
      mode: input.mode,
      livekit: {
        token: token.token,
        livekit_url: token.livekit_url,
        configured: token.configured
      }
    };
  }

  forceDisconnect(tenantId: string, callSessionId: string, seatId: string | null): void {
    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    this.voiceStore.updateCallSession(tenantId, callSessionId, {
      status: 'completed',
      ended_at: new Date().toISOString(),
      metadata: {
        ...(typeof session.metadata === 'object' && session.metadata ? session.metadata : {}),
        force_disconnected: true,
        force_disconnected_at: new Date().toISOString()
      }
    });

    broadcastCallEnded(tenantId, {
      call_session_id: callSessionId,
      seat_id: seatId || undefined,
      disposition: 'force_disconnected'
    });
  }
}
