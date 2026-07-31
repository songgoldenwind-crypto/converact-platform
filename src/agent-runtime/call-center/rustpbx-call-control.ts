import type { VoiceStore } from '../voice/voice-store.js';
import type { AgentSeatStore } from './seat-store.js';
import { getSharedRwiClient } from './rwi-shared.js';

export interface RustpbxCallControlResult {
  applied: boolean;
  rustpbx_call_id?: string;
  action: string;
  error?: string;
}

export async function holdRustpbxLeg(
  voiceStore: VoiceStore,
  tenantId: string,
  callSessionId: string,
  musicUrl?: string | null
): Promise<RustpbxCallControlResult> {
  const session = voiceStore.getCallSession(tenantId, callSessionId);
  const rustpbxCallId = session?.rustpbx_call_id ? String(session.rustpbx_call_id) : '';
  if (!rustpbxCallId) {
    return { applied: false, action: 'hold', error: 'no rustpbx_call_id' };
  }

  const client = await getSharedRwiClient();
  if (!client?.isConnected()) {
    return { applied: false, rustpbx_call_id: rustpbxCallId, action: 'hold', error: 'rwi_not_connected' };
  }

  try {
    await client.hold(rustpbxCallId, musicUrl ? { music_url: musicUrl } : undefined);
    if (musicUrl) {
      try {
        await client.playAudio(rustpbxCallId, musicUrl);
      } catch (error) {
        console.warn('[rustpbx] play_audio fallback after hold failed:', error);
      }
    }
    return { applied: true, rustpbx_call_id: rustpbxCallId, action: 'hold' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[rustpbx] hold failed:', message);
    return { applied: false, rustpbx_call_id: rustpbxCallId, action: 'hold', error: message };
  }
}

export async function resumeRustpbxLeg(
  voiceStore: VoiceStore,
  tenantId: string,
  callSessionId: string
): Promise<RustpbxCallControlResult> {
  const session = voiceStore.getCallSession(tenantId, callSessionId);
  const rustpbxCallId = session?.rustpbx_call_id ? String(session.rustpbx_call_id) : '';
  if (!rustpbxCallId) {
    return { applied: false, action: 'unhold', error: 'no rustpbx_call_id' };
  }

  const client = await getSharedRwiClient();
  if (!client?.isConnected()) {
    return { applied: false, rustpbx_call_id: rustpbxCallId, action: 'unhold', error: 'rwi_not_connected' };
  }

  try {
    await client.unhold(rustpbxCallId);
    return { applied: true, rustpbx_call_id: rustpbxCallId, action: 'unhold' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[rustpbx] unhold failed:', message);
    return { applied: false, rustpbx_call_id: rustpbxCallId, action: 'unhold', error: message };
  }
}

export async function bridgeRustpbxLeg(
  voiceStore: VoiceStore,
  seatStore: AgentSeatStore,
  tenantId: string,
  callSessionId: string,
  targetSeatId: string
): Promise<RustpbxCallControlResult> {
  const session = voiceStore.getCallSession(tenantId, callSessionId);
  const rustpbxCallId = session?.rustpbx_call_id ? String(session.rustpbx_call_id) : '';
  if (!rustpbxCallId) {
    return { applied: false, action: 'bridge', error: 'no rustpbx_call_id' };
  }

  const targetSeat = seatStore.getSeat(targetSeatId);
  if (!targetSeat || targetSeat.tenant_id !== tenantId) {
    return { applied: false, rustpbx_call_id: rustpbxCallId, action: 'bridge', error: 'target seat not found' };
  }

  const targetUri =
    targetSeat.rustpbx_extension
      ? `sip:${targetSeat.rustpbx_extension}@rustpbx.local`
      : `sip:seat-${targetSeat.id}@rustpbx.local`;

  const client = await getSharedRwiClient();
  if (!client?.isConnected()) {
    return { applied: false, rustpbx_call_id: rustpbxCallId, action: 'bridge', error: 'rwi_not_connected' };
  }

  try {
    await client.bridge(rustpbxCallId, targetUri);
    return { applied: true, rustpbx_call_id: rustpbxCallId, action: 'bridge' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[rustpbx] bridge failed:', message);
    return { applied: false, rustpbx_call_id: rustpbxCallId, action: 'bridge', error: message };
  }
}
