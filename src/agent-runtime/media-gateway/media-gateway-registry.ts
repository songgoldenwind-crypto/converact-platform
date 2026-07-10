/**
 * Media Gateway Registry — pluggable participant-join layer for LiveKit rooms.
 *
 * The LiveKit room is the media hub. Participants (agents, customers, AI
 * avatars, future SIP/VoLTE legs) join via a "channel". This registry
 * decouples call orchestration (create room, notify, track presence) from
 * the channel-specific mechanism of bringing a participant into the room.
 *
 * Mirrors the ChannelAdapterRegistry pattern used for messaging channels.
 *
 * Adding a new channel (e.g. a video gateway between RustPBX and LiveKit for
 * 4G VoLTE) means registering a new adapter — orchestration code is unchanged.
 */
import type { LiveKitTokenResult } from '../livekit/token-service.js';

export type MediaChannel = 'webrtc' | 'sip_volte' | 'pstn_audio' | string;
export type MediaKind = 'voice' | 'video';
export type ParticipantRole = 'agent' | 'customer';

export interface MediaGatewayDefinition {
  channel: MediaChannel;
  /** Human-readable description of how this channel reaches participants. */
  description: string;
  status: 'active' | 'planned';
  supports_video: boolean;
  /** Which roles this gateway can bring into a room. */
  roles: ParticipantRole[];
}

export interface MediaJoinContext {
  tenantId: string;
  roomName: string;
  identity: string;
  role: ParticipantRole;
  media: MediaKind;
  /** Optional join base URL (for building H5 links) / phone (for SIP dial). */
  contact?: { phone?: string; joinBaseUrl?: string };
  metadata?: Record<string, unknown>;
}

/**
 * A join plan describes HOW a participant connects to the LiveKit room.
 * Discriminated on `mode`:
 *  - webrtc: the participant connects directly with a token (browser/H5)
 *  - sip_bridge: an external gateway (RustPBX) dials a SIP target that is
 *    bridged into the room (VoLTE/PSTN). Orchestration hands these dial
 *    instructions to the gateway rather than a token.
 */
export type MediaJoinPlan =
  | {
      mode: 'webrtc';
      channel: MediaChannel;
      token: LiveKitTokenResult;
      /** Relative H5 join path for customers; undefined for agents. */
      joinPath?: string;
    }
  | {
      mode: 'sip_bridge';
      channel: MediaChannel;
      /** SIP URI the external gateway should dial to enter the room. */
      sipDialTarget: string;
      /** RustPBX trunk to route through. */
      trunk?: string;
      /** Whether the bridge should negotiate video (vs audio-only). */
      video: boolean;
      note: string;
    };

export interface MediaGatewayAdapter {
  /** Prepare a participant to join the room (issue token or set up SIP dial). */
  prepareJoin(ctx: MediaJoinContext): Promise<MediaJoinPlan> | MediaJoinPlan;
}

export interface MediaGatewayEntry {
  definition: MediaGatewayDefinition;
  adapter: MediaGatewayAdapter;
}

export class MediaGatewayRegistry {
  private gateways: Map<string, MediaGatewayEntry>;

  constructor() {
    this.gateways = new Map();
  }

  register(definition: MediaGatewayDefinition, adapter: MediaGatewayAdapter): void {
    if (!definition?.channel) throw new Error('channel is required');
    if (this.gateways.has(definition.channel)) {
      throw new Error(`duplicate media gateway: ${definition.channel}`);
    }
    if (typeof adapter.prepareJoin !== 'function') {
      throw new Error(`prepareJoin is required for ${definition.channel}`);
    }
    this.gateways.set(definition.channel, { definition: Object.freeze(definition), adapter });
  }

  has(channel: string): boolean {
    return this.gateways.has(channel);
  }

  get(channel: string): MediaGatewayEntry {
    const entry = this.gateways.get(channel);
    if (!entry) throw new Error(`media gateway not registered: ${channel}`);
    return entry;
  }

  list(): MediaGatewayDefinition[] {
    return [...this.gateways.values()].map((e) => e.definition);
  }

  async prepareJoin(channel: MediaChannel, ctx: MediaJoinContext): Promise<MediaJoinPlan> {
    const { definition, adapter } = this.get(channel);
    if (definition.status !== 'active') {
      throw Object.assign(new Error(`media gateway '${channel}' is not active (status: ${definition.status})`), {
        status: 501
      });
    }
    if (!definition.roles.includes(ctx.role)) {
      throw Object.assign(new Error(`media gateway '${channel}' does not support role '${ctx.role}'`), {
        status: 400
      });
    }
    if (ctx.media === 'video' && !definition.supports_video) {
      throw Object.assign(new Error(`media gateway '${channel}' does not support video`), { status: 400 });
    }
    return adapter.prepareJoin(ctx);
  }
}
