import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { isLiveKitConfigured, readLiveKitConfig } from './config.js';
import type { LiveKitConfig } from './config.js';

export type LiveKitParticipantRole = 'agent' | 'customer';
export type SupervisorTokenMode = 'listen' | 'barge' | 'whisper';

export interface IssueLiveKitTokenInput {
  room_name: string;
  identity: string;
  role: LiveKitParticipantRole;
  tenant_id?: string;
  ttl_seconds?: number;
}

export interface IssueSupervisorTokenInput {
  room_name: string;
  identity: string;
  mode: SupervisorTokenMode;
  tenant_id?: string;
  ttl_seconds?: number;
}

export interface LiveKitTokenResult {
  token: string;
  livekit_url: string;
  room_name: string;
  configured: boolean;
}

export async function issueLiveKitToken(
  input: IssueLiveKitTokenInput,
  config: LiveKitConfig = readLiveKitConfig()
): Promise<LiveKitTokenResult> {
  const ttlSeconds = input.ttl_seconds ?? 1800;
  const roomName = input.room_name;
  const identity = input.identity;

  if (!isLiveKitConfigured(config)) {
    return {
      token: `dev-token:${roomName}:${identity}:${input.role}`,
      livekit_url: config.url || 'ws://localhost:7880',
      room_name: roomName,
      configured: false
    };
  }

  const token = new AccessToken(config.apiKey!, config.apiSecret!, {
    identity,
    ttl: ttlSeconds,
    metadata: JSON.stringify({ tenant_id: input.tenant_id || '', role: input.role })
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
    livekit_url: config.url!,
    room_name: roomName,
    configured: true
  };
}

export async function issueSupervisorToken(
  input: IssueSupervisorTokenInput,
  config: LiveKitConfig = readLiveKitConfig()
): Promise<LiveKitTokenResult> {
  const ttlSeconds = input.ttl_seconds ?? 1800;
  const roomName = input.room_name;
  const identity = input.identity;

  if (!isLiveKitConfigured(config)) {
    return {
      token: `dev-token:${roomName}:${identity}:supervisor_${input.mode}`,
      livekit_url: config.url || 'ws://localhost:7880',
      room_name: roomName,
      configured: false
    };
  }

  const canPublish = input.mode === 'barge' || input.mode === 'whisper';
  const token = new AccessToken(config.apiKey!, config.apiSecret!, {
    identity,
    ttl: ttlSeconds,
    metadata: JSON.stringify({
      tenant_id: input.tenant_id || '',
      role: 'supervisor',
      supervisor_mode: input.mode
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
    livekit_url: config.url!,
    room_name: roomName,
    configured: true
  };
}

export function createLiveKitRoomClient(config: LiveKitConfig = readLiveKitConfig()) {
  if (!isLiveKitConfigured(config)) return null;
  return new RoomServiceClient(config.url!, config.apiKey!, config.apiSecret!);
}
