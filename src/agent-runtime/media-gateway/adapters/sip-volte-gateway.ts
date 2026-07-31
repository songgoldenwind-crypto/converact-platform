import { resolveBrandEnv } from '../../../config/converact-env.js';
/**
 * SIP/VoLTE media gateway for 4G video customers:
 *
 *   客户手机 (VoLTE视频) → SIP → RustPBX → livekit-sip 网关 → LiveKit 房间
 *
 * Instead of issuing a WebRTC token, this gateway returns SIP dial
 * instructions. The orchestration layer hands these to RustPBX, which dials
 * the SIP target answered by the livekit-sip bridge container; the bridge
 * publishes the VoLTE media as tracks into the LiveKit room. From every other
 * participant's perspective the customer is just another participant.
 *
 * Activation is fail-closed. The process must explicitly enable the gateway
 * and provide every LiveKit, bridge, and RustPBX execution dependency.
 */
import type {
  MediaGatewayAdapter,
  MediaGatewayDefinition,
  MediaJoinContext,
  MediaJoinPlan
} from '../media-gateway-registry.js';

export interface SipVolteGatewayConfiguration {
  enabled: boolean;
  active: boolean;
  bridgeTarget: string;
  trunk: string;
  missingOrInvalid: readonly string[];
}

export function resolveSipVolteGatewayConfiguration(
  env: NodeJS.ProcessEnv = process.env
): SipVolteGatewayConfiguration {
  const bridgeTarget = String(env.LIVEKIT_SIP_BRIDGE_TARGET || '').trim();
  const trunk = String(env.RUSTPBX_LIVEKIT_TRUNK || '').trim();
  const missingOrInvalid: string[] = [];
  if (!validServiceUrl(env.LIVEKIT_URL, new Set(['http:', 'https:', 'ws:', 'wss:']))) {
    missingOrInvalid.push('LIVEKIT_URL');
  }
  if (!safeConfiguredValue(env.LIVEKIT_API_KEY)) missingOrInvalid.push('LIVEKIT_API_KEY');
  if (!safeConfiguredValue(env.LIVEKIT_API_SECRET)) missingOrInvalid.push('LIVEKIT_API_SECRET');
  if (!validSipTarget(bridgeTarget)) missingOrInvalid.push('LIVEKIT_SIP_BRIDGE_TARGET');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trunk)) {
    missingOrInvalid.push('RUSTPBX_LIVEKIT_TRUNK');
  }
  if (!validServiceUrl(env.RUSTPBX_RWI_URL, new Set(['http:', 'https:', 'ws:', 'wss:']))) {
    missingOrInvalid.push('RUSTPBX_RWI_URL');
  }
  if (!safeConfiguredValue(env.RUSTPBX_RWI_TOKEN)) missingOrInvalid.push('RUSTPBX_RWI_TOKEN');
  const enabled = resolveBrandEnv(env, 'SIP_VOLTE_ENABLED') === '1';
  return Object.freeze({
    enabled,
    active: enabled && missingOrInvalid.length === 0,
    bridgeTarget,
    trunk,
    missingOrInvalid: Object.freeze(missingOrInvalid)
  });
}

export function createSipVolteGatewayDefinition(
  config: SipVolteGatewayConfiguration
): MediaGatewayDefinition {
  return {
    channel: 'sip_volte',
    description: config.active
      ? '4G VoLTE video via SIP, RustPBX, and the LiveKit SIP bridge.'
      : '4G VoLTE video gateway is disabled or incompletely configured.',
    status: config.active ? 'active' : 'planned',
    supports_video: true,
    roles: ['customer']
  };
}

export function createSipVolteGateway(
  config: SipVolteGatewayConfiguration = resolveSipVolteGatewayConfiguration()
): MediaGatewayAdapter {
  return {
    prepareJoin(ctx: MediaJoinContext): MediaJoinPlan {
      if (!validSipTarget(config.bridgeTarget) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.trunk)) {
        throw Object.assign(new Error('sip_volte gateway configuration is incomplete'), { status: 503 });
      }

      return {
        mode: 'sip_bridge',
        channel: 'sip_volte',
        sipDialTarget: `${config.bridgeTarget};room=${encodeURIComponent(ctx.roomName)}`,
        trunk: config.trunk,
        video: ctx.media === 'video',
        note: 'RustPBX dials this target and LiveKit SIP publishes the negotiated media into the room.'
      };
    }
  };
}

function validSipTarget(value: string): boolean {
  if (!value || value.length > 512 || /[\u0000-\u0020\u007f;?#]/.test(value)) return false;
  const match = value.match(
    /^sips?:[A-Za-z0-9_.!~*'()+-]+@(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?)(?::([0-9]{1,5}))?$/
  );
  if (!match) return false;
  const port = match[2] ? Number(match[2]) : 5060;
  return port > 0 && port <= 65_535;
}

function validServiceUrl(value: unknown, protocols: ReadonlySet<string>): boolean {
  if (typeof value !== 'string' || !value || value.length > 2_048 || /[\u0000-\u0020\u007f]/.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return protocols.has(url.protocol) && Boolean(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function safeConfiguredValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
