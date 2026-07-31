import { resolveBrandEnv } from '../../config/converact-env.js';
import {
  IngressAudioOptions,
  IngressClient,
  IngressInput,
  IngressVideoOptions,
  type IngressInfo
} from 'livekit-server-sdk';

import { isLiveKitConfigured, readLiveKitConfig } from './config.js';

export type LiveKitIngressInputType = 'rtmp' | 'whip' | 'url';

export interface LiveKitIngressOwnership {
  tenant_id: string;
  actor_id: string;
  idempotency_key_hash: string;
  request_hash: string;
}

export interface LiveKitIngressRecord {
  ingress_id: string;
  name: string;
  stream_key: string;
  url: string;
  input_type: LiveKitIngressInputType;
  enable_transcoding?: boolean;
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
  room_name: string;
  participant_identity: string;
  participant_name: string;
  participant_metadata: Record<string, unknown>;
  reusable: boolean;
  enabled?: boolean;
  state: Record<string, unknown> | null;
  ownership?: LiveKitIngressOwnership;
}

export interface LiveKitIngressCreateCommand {
  input_type: LiveKitIngressInputType;
  name?: string;
  room_name: string;
  participant_identity: string;
  participant_name?: string;
  participant_metadata?: Record<string, unknown>;
  enable_transcoding?: boolean;
  url?: string;
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
  ownership: LiveKitIngressOwnership;
}

export interface LiveKitIngressUpdateCommand {
  ingress_id: string;
  name: string;
  room_name: string;
  participant_identity: string;
  participant_name: string;
  participant_metadata: Record<string, unknown>;
  enable_transcoding?: boolean;
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
  ownership?: LiveKitIngressOwnership;
}

export interface LiveKitIngressProvider {
  create(input: LiveKitIngressCreateCommand): Promise<LiveKitIngressRecord>;
  list(input: { room_name?: string; ingress_id?: string }): Promise<LiveKitIngressRecord[]>;
  update(input: LiveKitIngressUpdateCommand): Promise<LiveKitIngressRecord>;
  delete(ingressId: string): Promise<LiveKitIngressRecord>;
}

type IngressAdminClient = Pick<
  IngressClient,
  'createIngress' | 'listIngress' | 'updateIngress' | 'deleteIngress'
>;

export class LiveKitSdkIngressProvider implements LiveKitIngressProvider {
  constructor(private readonly client: IngressAdminClient) {}

  async create(input: LiveKitIngressCreateCommand): Promise<LiveKitIngressRecord> {
    const info = await this.client.createIngress(inputEnum(input.input_type), {
      name: input.name,
      roomName: input.room_name,
      participantIdentity: input.participant_identity,
      participantName: input.participant_name,
      participantMetadata: encodeParticipantMetadata(input.participant_metadata, input.ownership),
      enableTranscoding: input.enable_transcoding,
      url: input.url,
      audio: input.audio ? IngressAudioOptions.fromJson(input.audio as never) : undefined,
      video: input.video ? IngressVideoOptions.fromJson(input.video as never) : undefined
    });
    return ingressRecord(info);
  }

  async list(input: { room_name?: string; ingress_id?: string }): Promise<LiveKitIngressRecord[]> {
    const items = await this.client.listIngress({
      roomName: input.room_name,
      ingressId: input.ingress_id
    });
    return items.map(ingressRecord);
  }

  async update(input: LiveKitIngressUpdateCommand): Promise<LiveKitIngressRecord> {
    const info = await this.client.updateIngress(input.ingress_id, {
      name: input.name,
      roomName: input.room_name,
      participantIdentity: input.participant_identity,
      participantName: input.participant_name,
      participantMetadata: encodeParticipantMetadata(input.participant_metadata, input.ownership),
      enableTranscoding: input.enable_transcoding,
      audio: input.audio ? IngressAudioOptions.fromJson(input.audio as never) : undefined,
      video: input.video ? IngressVideoOptions.fromJson(input.video as never) : undefined
    });
    return ingressRecord(info);
  }

  async delete(ingressId: string): Promise<LiveKitIngressRecord> {
    return ingressRecord(await this.client.deleteIngress(ingressId));
  }
}

export function createConfiguredLiveKitIngressProvider(
  env: NodeJS.ProcessEnv = process.env
): LiveKitIngressProvider | null {
  if (resolveBrandEnv(env, 'LIVEKIT_INGRESS_ENABLED') !== '1') return null;
  const config = readLiveKitConfig(env);
  if (!isLiveKitConfigured(config)) {
    throw new Error('LiveKit Ingress is enabled but LiveKit server credentials are incomplete');
  }
  const timeout = positiveInteger(resolveBrandEnv(env, 'LIVEKIT_INGRESS_REQUEST_TIMEOUT_MS'), 15_000);
  return new LiveKitSdkIngressProvider(new IngressClient(
    liveKitAdminUrl(config.url!),
    config.apiKey!,
    config.apiSecret!,
    { requestTimeout: timeout }
  ));
}

export function liveKitIngressConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveBrandEnv(env, 'LIVEKIT_INGRESS_ENABLED') === '1' && isLiveKitConfigured(readLiveKitConfig(env));
}

function ingressRecord(info: IngressInfo): LiveKitIngressRecord {
  const metadata = decodeParticipantMetadata(info.participantMetadata);
  return {
    ingress_id: info.ingressId,
    name: info.name,
    stream_key: info.streamKey,
    url: info.url,
    input_type: inputType(info.inputType),
    enable_transcoding: info.enableTranscoding,
    ...(info.audio ? { audio: info.audio.toJson() as Record<string, unknown> } : {}),
    ...(info.video ? { video: info.video.toJson() as Record<string, unknown> } : {}),
    room_name: info.roomName,
    participant_identity: info.participantIdentity,
    participant_name: info.participantName,
    participant_metadata: metadata.application,
    reusable: info.reusable,
    enabled: info.enabled,
    state: info.state ? info.state.toJson() as Record<string, unknown> : null,
    ...(metadata.ownership ? { ownership: metadata.ownership } : {})
  };
}

function encodeParticipantMetadata(
  application: Record<string, unknown> = {},
  ownership?: LiveKitIngressOwnership
): string {
  return JSON.stringify({
    ivekit: ownership ? { version: 1, ...ownership } : { version: 1 },
    application
  });
}

function decodeParticipantMetadata(value: string): {
  application: Record<string, unknown>;
  ownership?: LiveKitIngressOwnership;
} {
  if (!value) return { application: {} };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const application = record(parsed.application) || (record(parsed.ivekit) ? {} : parsed);
    const trusted = record(parsed.ivekit);
    if (!trusted) return { application };
    const ownership = {
      tenant_id: text(trusted.tenant_id),
      actor_id: text(trusted.actor_id),
      idempotency_key_hash: text(trusted.idempotency_key_hash),
      request_hash: text(trusted.request_hash)
    };
    if (Object.values(ownership).some((item) => !item)) return { application };
    return { application, ownership };
  } catch {
    return { application: {} };
  }
}

function inputEnum(value: LiveKitIngressInputType): IngressInput {
  if (value === 'rtmp') return IngressInput.RTMP_INPUT;
  if (value === 'whip') return IngressInput.WHIP_INPUT;
  return IngressInput.URL_INPUT;
}

function inputType(value: IngressInput): LiveKitIngressInputType {
  if (value === IngressInput.RTMP_INPUT) return 'rtmp';
  if (value === IngressInput.WHIP_INPUT) return 'whip';
  return 'url';
}

function liveKitAdminUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('LIVEKIT_URL must use ws://, wss://, http:// or https://');
  }
  return url.toString().replace(/\/$/, '');
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 120_000) {
    throw new Error('CONVERACT_LIVEKIT_INGRESS_REQUEST_TIMEOUT_MS must be between 100 and 120000');
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
