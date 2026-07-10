/**
 * SIP/VoLTE media gateway — STUB (status: planned).
 *
 * Future path for 4G VoLTE video customers:
 *
 *   客户手机 (VoLTE视频) → SIP → RustPBX → livekit-sip 网关 → LiveKit 房间
 *
 * Instead of issuing a WebRTC token, this gateway returns SIP dial
 * instructions. The orchestration layer hands these to RustPBX, which dials
 * the SIP target answered by the livekit-sip bridge container; the bridge
 * publishes the VoLTE media as tracks into the LiveKit room. From every other
 * participant's perspective the customer is just another participant.
 *
 * Currently a stub: registered with status='planned' so the registry refuses
 * to use it until the SIP bridge is provisioned. The interface and dial-plan
 * shape are fixed here so wiring it up later requires no orchestration changes.
 *
 * To activate later:
 *   1. Provision the livekit-sip container with video support (see
 *      docker-compose.callcenter.yml + config/rustpbx.toml trunk livekit-bridge).
 *   2. Set RUSTPBX_LIVEKIT_TRUNK + LIVEKIT_SIP_BRIDGE_TARGET env vars.
 *   3. Flip status to 'active' and implement the real dial target resolution.
 */
import type {
  MediaGatewayAdapter,
  MediaGatewayDefinition,
  MediaJoinContext,
  MediaJoinPlan
} from '../media-gateway-registry.js';

export const SIP_VOLTE_GATEWAY_DEFINITION: MediaGatewayDefinition = {
  channel: 'sip_volte',
  description: '4G VoLTE video via SIP → RustPBX → livekit-sip bridge (planned).',
  status: 'planned',
  supports_video: true,
  roles: ['customer']
};

export function createSipVolteGateway(): MediaGatewayAdapter {
  return {
    prepareJoin(ctx: MediaJoinContext): MediaJoinPlan {
      // The bridge target is the SIP URI the livekit-sip container answers on.
      // RustPBX routes the VoLTE leg through its trunk to this target, which
      // joins the named LiveKit room.
      const bridgeTarget =
        process.env.LIVEKIT_SIP_BRIDGE_TARGET || 'sip:livekit-bridge@127.0.0.1:5061';
      const trunk = process.env.RUSTPBX_LIVEKIT_TRUNK || 'livekit-bridge';

      return {
        mode: 'sip_bridge',
        channel: 'sip_volte',
        // Room is encoded so the bridge knows which LiveKit room to join.
        sipDialTarget: `${bridgeTarget};room=${encodeURIComponent(ctx.roomName)}`,
        trunk,
        video: ctx.media === 'video',
        note:
          'VoLTE SIP bridge dial plan (stub). RustPBX dials this target; ' +
          'livekit-sip bridges the VoLTE media into the room.'
      };
    }
  };
}
