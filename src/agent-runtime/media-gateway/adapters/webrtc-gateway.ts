/**
 * WebRTC media gateway — agents and H5 customers connect directly to LiveKit
 * via a token. This is the active gateway today.
 */
import { issueLiveKitToken } from '../../livekit/token-service.js';
import { createMediaInvite } from '../../livekit/invite-token.js';
import type {
  MediaGatewayAdapter,
  MediaGatewayDefinition,
  MediaJoinContext,
  MediaJoinPlan
} from '../media-gateway-registry.js';

export const WEBRTC_GATEWAY_DEFINITION: MediaGatewayDefinition = {
  channel: 'webrtc',
  description: 'Direct WebRTC join via LiveKit token (agent browser, customer H5).',
  status: 'active',
  supports_video: true,
  roles: ['agent', 'customer']
};

export function createWebRtcGateway(): MediaGatewayAdapter {
  return {
    async prepareJoin(ctx: MediaJoinContext): Promise<MediaJoinPlan> {
      const token = await issueLiveKitToken({
        room_name: ctx.roomName,
        identity: ctx.identity,
        role: ctx.role,
        tenant_id: ctx.tenantId
      });

      // Customers get an H5 join path they can open in a browser; agents are
      // already in the workbench and connect with the token directly.
      let joinPath: string | undefined;
      if (ctx.role === 'customer') {
        const params = new URLSearchParams({
          room: ctx.roomName,
          tenant_id: ctx.tenantId
        });
        const invite = createMediaInvite({
          tenantId: ctx.tenantId,
          roomName: ctx.roomName,
          role: 'customer',
          media: ctx.media
        });
        if (invite) {
          params.set('expires_at', invite.expires_at);
          params.set('invite', invite.invite);
        }
        joinPath = `/video?${params.toString()}`;
      }

      return { mode: 'webrtc', channel: 'webrtc', token, joinPath };
    }
  };
}
