import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { isLiveKitConfigured, readLiveKitConfig, requireLiveKitPublicUrl } from './config.js';
import type { LiveKitConfig } from './config.js';

export type LiveKitParticipantRole = 'agent' | 'customer';
export type SupervisorTokenMode = 'listen' | 'barge' | 'whisper';

export interface LiveKitPlacementContext {
  interaction_id: string;
  reservation_id: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  profile_id: string;
  snapshot_version: number;
  placement_generation?: number;
  livekit_url: string;
}

export interface IssueLiveKitTokenInput {
  room_name: string;
  identity: string;
  role: LiveKitParticipantRole;
  tenant_id?: string;
  ttl_seconds?: number;
  placement?: LiveKitPlacementContext;
}

export interface IssueSupervisorTokenInput {
  room_name: string;
  identity: string;
  mode: SupervisorTokenMode;
  tenant_id?: string;
  ttl_seconds?: number;
  placement?: LiveKitPlacementContext;
}

export interface LiveKitTokenResult {
  token: string;
  livekit_url: string;
  room_name: string;
  configured: boolean;
  placement?: LiveKitPlacementContext;
}

export async function issueLiveKitToken(
  input: IssueLiveKitTokenInput,
  config: LiveKitConfig = readLiveKitConfig()
): Promise<LiveKitTokenResult> {
  const ttlSeconds = input.ttl_seconds ?? 1800;
  const roomName = input.room_name;
  const identity = input.identity;
  const placement = validatedPlacement(input.placement);

  if (!isLiveKitConfigured(config)) {
    requireNonProductionFallback(config);
    return {
      token: `dev-token:${roomName}:${identity}:${input.role}`,
      livekit_url: placement?.livekit_url ||
        config.publicUrl || config.url || 'ws://localhost:7880',
      room_name: roomName,
      configured: false,
      ...(placement ? { placement } : {})
    };
  }

  const token = new AccessToken(config.apiKey!, config.apiSecret!, {
    identity,
    ttl: ttlSeconds,
    metadata: JSON.stringify({
      tenant_id: input.tenant_id || '',
      role: input.role,
      ...(placement ? { placement: tokenPlacement(placement) } : {})
    })
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: input.role === 'agent'
  });

  return {
    token: await token.toJwt(),
    livekit_url: placement?.livekit_url || requireLiveKitPublicUrl(config),
    room_name: roomName,
    configured: true,
    ...(placement ? { placement } : {})
  };
}

export async function issueSupervisorToken(
  input: IssueSupervisorTokenInput,
  config: LiveKitConfig = readLiveKitConfig()
): Promise<LiveKitTokenResult> {
  const ttlSeconds = input.ttl_seconds ?? 1800;
  const roomName = input.room_name;
  const identity = input.identity;
  const placement = validatedPlacement(input.placement);

  if (!isLiveKitConfigured(config)) {
    requireNonProductionFallback(config);
    return {
      token: `dev-token:${roomName}:${identity}:supervisor_${input.mode}`,
      livekit_url: placement?.livekit_url ||
        config.publicUrl || config.url || 'ws://localhost:7880',
      room_name: roomName,
      configured: false,
      ...(placement ? { placement } : {})
    };
  }

  const canPublish = input.mode === 'barge' || input.mode === 'whisper';
  const token = new AccessToken(config.apiKey!, config.apiSecret!, {
    identity,
    ttl: ttlSeconds,
    metadata: JSON.stringify({
      tenant_id: input.tenant_id || '',
      role: 'supervisor',
      supervisor_mode: input.mode,
      ...(placement ? { placement: tokenPlacement(placement) } : {})
    })
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish,
    canSubscribe: true,
    canPublishData: input.mode === 'whisper',
    hidden: input.mode === 'listen'
  });

  return {
    token: await token.toJwt(),
    livekit_url: placement?.livekit_url || requireLiveKitPublicUrl(config),
    room_name: roomName,
    configured: true,
    ...(placement ? { placement } : {})
  };
}

export function createLiveKitRoomClient(config: LiveKitConfig = readLiveKitConfig()) {
  if (!isLiveKitConfigured(config)) return null;
  return new RoomServiceClient(config.url!, config.apiKey!, config.apiSecret!);
}

export function liveKitConfigForPlacement(
  config: LiveKitConfig,
  placementValue: LiveKitPlacementContext
): LiveKitConfig {
  const placement = validatedPlacement(placementValue)!;
  const adminUrl = new URL(placement.livekit_url);
  adminUrl.protocol = adminUrl.protocol === 'wss:' ? 'https:' : 'http:';
  return {
    ...config,
    url: adminUrl.toString().replace(/\/$/, ''),
    publicUrl: placement.livekit_url
  };
}

function requireNonProductionFallback(config: LiveKitConfig): void {
  if ((config.nodeEnv || process.env.NODE_ENV) === 'production') {
    throw new Error('LiveKit server configuration is required in production');
  }
}

function validatedPlacement(
  value: LiveKitPlacementContext | undefined
): LiveKitPlacementContext | undefined {
  if (!value) return undefined;
  for (const [field, item] of Object.entries({
    interaction_id: value.interaction_id,
    reservation_id: value.reservation_id,
    region_id: value.region_id,
    zone_id: value.zone_id,
    cell_id: value.cell_id,
    owner_node_id: value.owner_node_id
  })) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(String(item || ''))) {
      throw new Error(`invalid LiveKit placement ${field}`);
    }
  }
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(value.profile_id) ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(value.owner_epoch) ||
      !Number.isSafeInteger(value.snapshot_version) ||
      value.snapshot_version < 1 ||
      (value.placement_generation !== undefined &&
        (!Number.isSafeInteger(value.placement_generation) ||
          value.placement_generation < 1))) {
    throw new Error('invalid LiveKit placement identity');
  }
  const url = new URL(value.livekit_url);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password ||
      url.hash) {
    throw new Error('invalid LiveKit placement URL');
  }
  return Object.freeze({
    ...value,
    livekit_url: url.toString().replace(/\/$/, '')
  });
}

function tokenPlacement(
  placement: LiveKitPlacementContext
): Omit<LiveKitPlacementContext, 'livekit_url'> {
  const { livekit_url: _livekitUrl, ...identity } = placement;
  return identity;
}
