import { resolveBrandEnv } from '../../../config/converact-env.js';
import { readMetadata } from '../metadata-helpers.js';

import type { VoiceStore } from '../../voice/voice-store.js';
import { broadcastCallHold, broadcastCallResumed } from '../../../call-center-events.js';
import { holdRustpbxLeg, resumeRustpbxLeg } from '../rustpbx-call-control.js';

export interface CallHoldResult {
  call_session_id: string;
  on_hold: boolean;
  hold_started_at?: string;
  rustpbx?: { applied: boolean; error?: string };
}

export class CallHoldService {
  constructor(private readonly voiceStore: VoiceStore) {}

  async hold(
    tenantId: string,
    callSessionId: string,
    seatId: string,
    holdMusicUrl?: string | null
  ): Promise<CallHoldResult> {
    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    const metadata = readMetadata(session);
    const musicUrl =
      holdMusicUrl ||
      (typeof metadata.hold_music_url === 'string' ? metadata.hold_music_url : null) ||
      resolveBrandEnv(process.env, 'DEFAULT_HOLD_MUSIC_URL') ||
      null;
    const holdStartedAt = new Date().toISOString();
    this.voiceStore.updateCallSession(tenantId, callSessionId, {
      metadata: {
        ...metadata,
        on_hold: true,
        hold_started_at: holdStartedAt,
        hold_by_seat_id: seatId,
        hold_music_url: musicUrl
      }
    });

    const rustpbx = await holdRustpbxLeg(this.voiceStore, tenantId, callSessionId, musicUrl);
    if (!rustpbx.applied && rustpbx.error !== 'no rustpbx_call_id') {
      console.warn('[call-hold] RWI hold not applied:', rustpbx.error);
    }

    broadcastCallHold(tenantId, { call_session_id: callSessionId, seat_id: seatId });
    return {
      call_session_id: callSessionId,
      on_hold: true,
      hold_started_at: holdStartedAt,
      rustpbx: { applied: rustpbx.applied, error: rustpbx.error }
    };
  }

  async resume(tenantId: string, callSessionId: string, seatId: string): Promise<CallHoldResult> {
    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    const metadata = readMetadata(session);
    this.voiceStore.updateCallSession(tenantId, callSessionId, {
      metadata: {
        ...metadata,
        on_hold: false,
        hold_resumed_at: new Date().toISOString(),
        hold_by_seat_id: seatId
      }
    });

    const rustpbx = await resumeRustpbxLeg(this.voiceStore, tenantId, callSessionId);
    if (!rustpbx.applied && rustpbx.error !== 'no rustpbx_call_id') {
      console.warn('[call-hold] RWI unhold not applied:', rustpbx.error);
    }

    broadcastCallResumed(tenantId, { call_session_id: callSessionId, seat_id: seatId });
    return {
      call_session_id: callSessionId,
      on_hold: false,
      rustpbx: { applied: rustpbx.applied, error: rustpbx.error }
    };
  }
}

