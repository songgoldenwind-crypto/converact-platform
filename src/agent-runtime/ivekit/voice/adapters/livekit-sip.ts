import { randomUUID } from 'node:crypto';

import { SipClient } from 'livekit-server-sdk';

import { canonicalVoicePayloadHash, safeVoiceProviderPayload } from '../canonical.js';
import { VoiceError } from '../errors.js';
import type {
  VoiceAddressProtector,
  VoiceCallRepository,
  VoiceConfigurationRepository,
  VoiceMediaBridgeCreateInput,
  VoiceMediaBridgePort,
  VoiceMediaBridgeResult,
  VoiceMediaCallPort,
  VoiceRecordingRepository,
  VoiceSecretResolver
} from '../ports.js';
import type { VoiceLiveKitBridge } from '../types.js';
import type { VoiceCall, VoiceCallCommand, VoiceDeploymentProfile } from '../types.js';

const LIVEKIT_SERVER_SDK_VERSION = '2.15.4';

export interface LiveKitSipClientPort {
  listSipOutboundTrunk(input?: { trunkIds?: string[] }): Promise<Array<{
    sipTrunkId?: string;
    name?: string;
  }>>;
  createSipParticipant(
    sipTrunkId: string,
    number: string,
    roomName: string,
    options?: {
      participantIdentity?: string;
      participantMetadata?: string;
      participantAttributes?: Record<string, string>;
      hidePhoneNumber?: boolean;
      waitUntilAnswered?: boolean;
      timeout?: number;
    }
  ): Promise<{
    participantId?: string;
    participantIdentity?: string;
    roomName?: string;
    sipCallId?: string;
  }>;
  transferSipParticipant(
    roomName: string,
    participantIdentity: string,
    transferTo: string,
    options?: { playDialtone?: boolean }
  ): Promise<void>;
}

export interface LiveKitSipParticipantLookupPort {
  find(roomName: string, participantIdentity: string): Promise<{
    participant_id: string;
    provider_call_id: string;
  } | null>;
}

export interface LiveKitSipBridgeAdapterOptions {
  profile_id: string;
  config_hash: string;
  client: LiveKitSipClientPort;
  bridges: Pick<VoiceRecordingRepository,
    'getBridge' | 'findBridgeByIdempotencyKey' | 'insertBridge' | 'updateBridge'>;
  participant_lookup?: LiveKitSipParticipantLookupPort;
  timeout_ms?: number;
  id?: () => string;
  now?: () => Date;
}

export interface CreateLiveKitSipBridgeAdapterOptions extends Omit<LiveKitSipBridgeAdapterOptions, 'client'> {
  host: string;
  api_key_ref: string;
  api_secret_ref: string;
  secret_resolver: VoiceSecretResolver;
  client_factory?: (host: string, apiKey: string, apiSecret: string) => LiveKitSipClientPort;
  production?: boolean;
}

export async function createLiveKitSipBridgeAdapter(
  options: CreateLiveKitSipBridgeAdapterOptions
): Promise<LiveKitSipBridgeAdapter> {
  const host = validatedHost(options.host, options.production === true);
  let apiKey: string;
  let apiSecret: string;
  try {
    apiKey = await options.secret_resolver.resolve(options.api_key_ref, 'livekit_sip_api_key');
    apiSecret = await options.secret_resolver.resolve(options.api_secret_ref, 'livekit_sip_api_secret');
  } catch (error) {
    if (error instanceof VoiceError) throw error;
    throw new VoiceError({ code: 'secret_unavailable', retryable: true, status: 503 });
  }
  const factory = options.client_factory
    ?? ((clientHost: string, key: string, secret: string) => new SipClient(clientHost, key, secret));
  const client = factory(host, apiKey, apiSecret);
  return new LiveKitSipBridgeAdapter({ ...options, client });
}

export class LiveKitSipBridgeAdapter implements VoiceMediaBridgePort {
  readonly #profileId: string;
  readonly #configHash: string;
  readonly #client: LiveKitSipClientPort;
  readonly #bridges: LiveKitSipBridgeAdapterOptions['bridges'];
  readonly #participantLookup?: LiveKitSipParticipantLookupPort;
  readonly #timeoutMs: number;
  readonly #id: () => string;
  readonly #now: () => Date;

  constructor(options: LiveKitSipBridgeAdapterOptions) {
    this.#profileId = boundedIdentifier(options.profile_id);
    this.#configHash = hash(options.config_hash);
    this.#client = options.client;
    this.#bridges = options.bridges;
    this.#participantLookup = options.participant_lookup;
    this.#timeoutMs = boundedInteger(options.timeout_ms, 10_000, 10, 120_000);
    this.#id = options.id ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async preflight(input: { sip_trunk_provider_ref: string }): Promise<{
    ready: boolean;
    provider: 'livekit_sip';
    provider_version: string;
    config_hash: string;
    safe_diagnostics: Record<string, unknown>;
  }> {
    const trunkId = boundedIdentifier(input.sip_trunk_provider_ref);
    let trunks: Awaited<ReturnType<LiveKitSipClientPort['listSipOutboundTrunk']>>;
    try {
      trunks = await withTimeout(
        this.#client.listSipOutboundTrunk({ trunkIds: [trunkId] }),
        this.#timeoutMs
      );
    } catch (error) {
      throw classifySdkError(error);
    }
    if (!Array.isArray(trunks)) throw new VoiceError({ code: 'protocol_mismatch', status: 502 });
    const trunk = trunks.find((candidate) => candidate?.sipTrunkId === trunkId);
    if (!trunk) throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    return {
      ready: true,
      provider: 'livekit_sip',
      provider_version: LIVEKIT_SERVER_SDK_VERSION,
      config_hash: this.#configHash,
      safe_diagnostics: safeVoiceProviderPayload({
        profile_id: this.#profileId,
        sip_trunk_id: trunkId,
        trunk_name: boundedOptionalText(trunk.name, 256)
      })
    };
  }

  async create(input: VoiceMediaBridgeCreateInput): Promise<VoiceMediaBridgeResult> {
    const request = validatedCreateInput(input);
    const requestHash = bridgeRequestHash(request, this.#profileId);
    const existing = await this.#bridges.findBridgeByIdempotencyKey(request.tenant_id, request.idempotency_key);
    if (existing) return replayResult(existing, requestHash);
    const timestamp = this.#now().toISOString();
    const candidate: VoiceLiveKitBridge = {
      id: boundedIdentifier(this.#id()),
      tenant_id: request.tenant_id,
      call_id: request.call_id,
      media_call_id: request.media_call_id,
      sip_participant_id: '',
      room_name: request.room_name,
      provider_bridge_id: '',
      status: 'pending',
      idempotency_key: request.idempotency_key,
      metadata: safeVoiceProviderPayload({
        request_hash: requestHash,
        livekit_profile_id: this.#profileId,
        participant_identity: request.participant_identity,
        sip_trunk_provider_ref: request.sip_trunk_provider_ref,
        destination_fingerprint: request.destination_fingerprint,
        business_ref: request.business_ref
      }),
      created_at: timestamp,
      updated_at: timestamp,
      ended_at: null
    };
    const inserted = await this.#bridges.insertBridge(candidate);
    if (inserted.id !== candidate.id) return replayResult(inserted, requestHash);
    const creating = await this.#bridges.updateBridge({
      ...inserted,
      status: 'creating',
      updated_at: this.#now().toISOString()
    });
    let participant: Awaited<ReturnType<LiveKitSipClientPort['createSipParticipant']>>;
    try {
      participant = await withTimeout(this.#client.createSipParticipant(
        request.sip_trunk_provider_ref,
        request.clear_destination,
        request.room_name,
        {
          participantIdentity: request.participant_identity,
          participantMetadata: JSON.stringify(safeVoiceProviderPayload({
            ivekit_voice_call_id: request.call_id,
            ivekit_media_call_id: request.media_call_id,
            business_ref_type: request.business_ref.type,
            business_ref_id: request.business_ref.id
          })),
          participantAttributes: {
            'ivekit.voice.call_id': request.call_id,
            'ivekit.media.call_id': request.media_call_id
          },
          hidePhoneNumber: true,
          waitUntilAnswered: false,
          timeout: Math.max(1, Math.ceil(this.#timeoutMs / 1_000))
        }
      ), this.#timeoutMs);
    } catch (error) {
      const classified = classifySdkError(error);
      if (classified.code !== 'provider_timeout') {
        await this.#bridges.updateBridge({
          ...creating,
          status: 'failed',
          metadata: { ...creating.metadata, error_code: classified.code },
          updated_at: this.#now().toISOString(),
          ended_at: this.#now().toISOString()
        }).catch(() => undefined);
      }
      throw classified;
    }
    let participantId: string;
    let participantIdentity: string;
    let roomName: string;
    let providerCallId: string;
    try {
      participantId = boundedIdentifier(participant.participantId);
      participantIdentity = safeParticipantIdentity(participant.participantIdentity);
      roomName = boundedIdentifier(participant.roomName);
      providerCallId = boundedIdentifier(participant.sipCallId);
    } catch {
      throw providerTimeout();
    }
    if (participantIdentity !== request.participant_identity || roomName !== request.room_name) {
      throw providerTimeout();
    }
    let active: VoiceLiveKitBridge;
    try {
      active = await this.#bridges.updateBridge({
        ...creating,
        sip_participant_id: participantId,
        provider_bridge_id: providerCallId,
        status: 'active',
        updated_at: this.#now().toISOString()
      });
    } catch {
      throw providerTimeout();
    }
    return bridgeResult(active, false, 'active');
  }

  async transfer(input: {
    tenant_id: string;
    bridge_id: string;
    room_name: string;
    participant_identity: string;
    clear_target: string;
    idempotency_key: string;
  }): Promise<{ provider_state: 'transferring' }> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const bridge = await this.#bridges.getBridge(tenantId, boundedIdentifier(input.bridge_id));
    if (!bridge || bridge.status !== 'active'
      || bridge.metadata.livekit_profile_id !== this.#profileId) {
      throw new VoiceError({ code: 'not_found', status: 404 });
    }
    const roomName = boundedIdentifier(input.room_name);
    const identity = safeParticipantIdentity(input.participant_identity);
    if (bridge.room_name !== roomName || bridge.metadata.participant_identity !== identity) {
      throw new VoiceError({ code: 'not_found', status: 404 });
    }
    const target = clearDestination(input.clear_target);
    boundedIdentifier(input.idempotency_key);
    try {
      await withTimeout(
        this.#client.transferSipParticipant(roomName, identity, target, { playDialtone: false }),
        this.#timeoutMs
      );
    } catch (error) {
      throw classifySdkError(error);
    }
    return { provider_state: 'transferring' };
  }

  async reconcile(input: { tenant_id: string; bridge_id: string }): Promise<VoiceMediaBridgeResult> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const bridge = await this.#bridges.getBridge(tenantId, boundedIdentifier(input.bridge_id));
    if (!bridge || bridge.metadata.livekit_profile_id !== this.#profileId) {
      throw new VoiceError({ code: 'not_found', status: 404 });
    }
    if (bridge.status === 'active' || bridge.status === 'completed'
      || bridge.status === 'failed' || bridge.status === 'cancelled') {
      return bridgeResult(bridge, true, bridge.status);
    }
    const identity = safeParticipantIdentity(bridge.metadata.participant_identity);
    if (!this.#participantLookup) return bridgeResult(bridge, true, 'unknown');
    let found: Awaited<ReturnType<LiveKitSipParticipantLookupPort['find']>>;
    try {
      found = await withTimeout(this.#participantLookup.find(bridge.room_name, identity), this.#timeoutMs);
    } catch (error) {
      throw classifySdkError(error);
    }
    if (!found) return bridgeResult(bridge, true, 'unknown');
    const active = await this.#bridges.updateBridge({
      ...bridge,
      sip_participant_id: boundedIdentifier(found.participant_id),
      provider_bridge_id: boundedIdentifier(found.provider_call_id),
      status: 'active',
      updated_at: this.#now().toISOString()
    });
    return bridgeResult(active, true, 'active');
  }

}

export class VoiceLiveKitBridgeService {
  constructor(private readonly options: {
    media_calls: VoiceMediaCallPort;
    bridge: VoiceMediaBridgePort;
  }) {}

  async create(input: {
    tenant_id: string;
    call_id: string;
    initiated_by: string;
    business_ref: { type: string; id: string };
    participant_identity: string;
    sip_trunk_provider_ref: string;
    clear_destination: string;
    destination_fingerprint: string;
    idempotency_key: string;
  }): Promise<VoiceMediaBridgeResult> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const callId = boundedIdentifier(input.call_id);
    const actor = boundedIdentifier(input.initiated_by);
    const identity = safeParticipantIdentity(input.participant_identity);
    const key = boundedIdentifier(input.idempotency_key);
    const businessRef = businessReference(input.business_ref);
    const media = await this.options.media_calls.ensureVoiceBridge({
      tenant_id: tenantId,
      voice_call_id: callId,
      initiated_by: actor,
      participant_identity: identity,
      idempotency_key: key,
      business_ref: { tenant_id: tenantId, ...businessRef }
    });
    return this.options.bridge.create({
      tenant_id: tenantId,
      call_id: callId,
      media_call_id: boundedIdentifier(media.media_call_id),
      room_name: boundedIdentifier(media.room_name),
      business_ref: businessRef,
      sip_trunk_provider_ref: boundedIdentifier(input.sip_trunk_provider_ref),
      clear_destination: clearDestination(input.clear_destination),
      destination_fingerprint: hash(input.destination_fingerprint),
      participant_identity: identity,
      idempotency_key: key
    });
  }
}

export class VoiceLiveKitBridgeCommandExecutor {
  constructor(private readonly options: {
    calls: VoiceCallRepository;
    configuration: VoiceConfigurationRepository;
    address_protector: VoiceAddressProtector;
    bridge: VoiceLiveKitBridgeService | ((profile: VoiceDeploymentProfile) => Promise<VoiceLiveKitBridgeService>);
  }) {}

  async execute(command: VoiceCallCommand): Promise<{
    provider_command_id: string;
    result: Record<string, unknown>;
  }> {
    if (command.kind !== 'livekit_bridge_create') {
      throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    }
    const call = required(await this.options.calls.get(command.tenant_id, command.call_id));
    const trunkId = boundedIdentifier(command.payload.sip_trunk_id);
    const trunk = required(await this.options.configuration.getTrunk(command.tenant_id, trunkId));
    const profile = required(await this.options.configuration.getProfile(command.tenant_id, trunk.profile_id));
    if (trunk.status !== 'active' || !trunk.provider_ref
      || profile.adapter !== 'livekit_sip'
      || (profile.status !== 'enabled' && profile.status !== 'degraded')) {
      throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    }
    const destination = required(await this.options.calls.getProtectedAddress(command.tenant_id, call.id, 'to'));
    const clearDestination = await this.options.address_protector.reveal(
      command.tenant_id,
      destination.ciphertext,
      destination.kind
    );
    const bridgeService = typeof this.options.bridge === 'function'
      ? await this.options.bridge(profile)
      : this.options.bridge;
    const result = await bridgeService.create({
      tenant_id: command.tenant_id,
      call_id: call.id,
      initiated_by: call.initiated_by,
      business_ref: call.business_ref,
      participant_identity: participantIdentityForCall(call),
      sip_trunk_provider_ref: trunk.provider_ref,
      clear_destination: clearDestination,
      destination_fingerprint: destination.hmac,
      idempotency_key: command.idempotency_key
    });
    if (result.state === 'pending' || result.state === 'creating' || result.state === 'unknown') {
      throw providerTimeout();
    }
    if (result.state !== 'active') {
      throw new VoiceError({ code: 'provider_unavailable', retryable: false, status: 502 });
    }
    if (call.media_call_id && call.media_call_id !== result.media_call_id) {
      throw new VoiceError({ code: 'idempotency_conflict', status: 409 });
    }
    if (!call.media_call_id) {
      try {
        await this.options.calls.update({
          ...call,
          media_call_id: result.media_call_id,
          revision: call.revision + 1,
          updated_at: new Date().toISOString()
        }, call.revision);
      } catch {
        throw providerTimeout();
      }
    }
    return {
      provider_command_id: result.bridge_id,
      result: safeVoiceProviderPayload({
        bridge_id: result.bridge_id,
        media_call_id: result.media_call_id,
        room_name: result.room_name,
        provider_participant_id: result.provider_participant_id,
        provider_call_id: result.provider_call_id,
        provider_state: result.provider_state
      })
    };
  }
}

export class VoiceLiveKitBridgeCommandReconciler {
  constructor(private readonly options: {
    bridges: Pick<VoiceRecordingRepository, 'findBridgeByIdempotencyKey'>;
    bridge: VoiceMediaBridgePort | ((profileId: string) => Promise<VoiceMediaBridgePort>);
  }) {}

  async reconcile(input: { call: VoiceCall; command: VoiceCallCommand }): Promise<{
    state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    provider_state?: string;
    media_call_id?: string;
  } | null> {
    if (input.command.kind !== 'livekit_bridge_create') return null;
    const bridge = await this.options.bridges.findBridgeByIdempotencyKey(
      input.command.tenant_id,
      input.command.idempotency_key
    );
    if (!bridge) return { state: 'unknown' };
    const profileId = boundedIdentifier(bridge.metadata.livekit_profile_id);
    const bridgePort = typeof this.options.bridge === 'function'
      ? await this.options.bridge(profileId)
      : this.options.bridge;
    const result = await bridgePort.reconcile({
      tenant_id: input.command.tenant_id,
      bridge_id: bridge.id
    });
    if (result.state === 'active' || result.state === 'completed') {
      return { state: 'succeeded', provider_state: input.call.state, media_call_id: result.media_call_id };
    }
    if (result.state === 'failed' || result.state === 'cancelled') {
      return { state: 'failed', provider_state: input.call.state };
    }
    return { state: result.state === 'unknown' ? 'unknown' : 'pending', provider_state: input.call.state };
  }
}

function validatedCreateInput(input: VoiceMediaBridgeCreateInput): VoiceMediaBridgeCreateInput {
  return {
    tenant_id: boundedIdentifier(input.tenant_id),
    call_id: boundedIdentifier(input.call_id),
    media_call_id: boundedIdentifier(input.media_call_id),
    room_name: boundedIdentifier(input.room_name),
    business_ref: businessReference(input.business_ref),
    sip_trunk_provider_ref: boundedIdentifier(input.sip_trunk_provider_ref),
    clear_destination: clearDestination(input.clear_destination),
    destination_fingerprint: hash(input.destination_fingerprint),
    participant_identity: safeParticipantIdentity(input.participant_identity),
    idempotency_key: boundedIdentifier(input.idempotency_key)
  };
}

function bridgeRequestHash(input: VoiceMediaBridgeCreateInput, profileId: string): string {
  return canonicalVoicePayloadHash({
    livekit_profile_id: profileId,
    tenant_id: input.tenant_id,
    call_id: input.call_id,
    media_call_id: input.media_call_id,
    room_name: input.room_name,
    business_ref: input.business_ref,
    sip_trunk_provider_ref: input.sip_trunk_provider_ref,
    destination_fingerprint: input.destination_fingerprint,
    participant_identity: input.participant_identity
  });
}

function participantIdentityForCall(call: VoiceCall): string {
  return `voice-sip-${canonicalVoicePayloadHash({ tenant_id: call.tenant_id, call_id: call.id }).slice(0, 32)}`;
}

function replayResult(bridge: VoiceLiveKitBridge, requestHash: string): VoiceMediaBridgeResult {
  if (bridge.metadata.request_hash !== requestHash) {
    throw new VoiceError({ code: 'idempotency_conflict', status: 409 });
  }
  return bridgeResult(bridge, true, bridge.status === 'creating' ? 'creating' : bridge.status);
}

function bridgeResult(
  bridge: VoiceLiveKitBridge,
  replayed: boolean,
  state: VoiceMediaBridgeResult['state']
): VoiceMediaBridgeResult {
  return {
    bridge_id: bridge.id,
    media_call_id: bridge.media_call_id,
    room_name: bridge.room_name,
    provider_participant_id: bridge.sip_participant_id,
    provider_call_id: bridge.provider_bridge_id,
    provider_state: state,
    state,
    replayed
  };
}

function businessReference(value: unknown): { type: string; id: string } {
  if (!isRecord(value)) throw validationError();
  return { type: boundedIdentifier(value.type), id: boundedIdentifier(value.id) };
}

function clearDestination(value: unknown): string {
  if (typeof value !== 'string') throw validationError();
  const result = value.trim();
  if (!result || result.length > 1_024 || /[\r\n\u0000]/.test(result)) throw validationError();
  return result;
}

function validatedHost(value: unknown, production: boolean): string {
  if (typeof value !== 'string' || value.length > 2_048) throw validationError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationError();
  }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && !production && isLoopback(url.hostname)))) throw validationError();
  return url.toString().replace(/\/$/, '');
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw validationError();
  return value;
}

function boundedIdentifier(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function safeParticipantIdentity(value: unknown): string {
  const result = boundedIdentifier(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(result)
    || /^\+?\d{7,}$/.test(result)
    || /^sips?:/i.test(result)) throw validationError();
  return result;
}

function boundedOptionalText(value: unknown, max: number): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return '';
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) throw validationError();
  return resolved;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(providerTimeout()), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function classifySdkError(error: unknown): VoiceError {
  if (error instanceof VoiceError) return error;
  const status = Number((error as { status?: unknown; statusCode?: unknown })?.status
    ?? (error as { statusCode?: unknown })?.statusCode ?? 0);
  const code = String((error as { code?: unknown })?.code ?? '').toLowerCase();
  if (status === 401 || status === 403 || code.includes('unauth') || code.includes('permission')) {
    return new VoiceError({ code: 'provider_auth_failed', status: 502 });
  }
  if (status === 408 || status === 429 || status >= 500
    || code.includes('timeout') || code.includes('abort') || code.includes('econn')
    || error instanceof TypeError) return providerTimeout();
  return new VoiceError({ code: 'provider_unavailable', retryable: false, status: 502 });
}

function providerTimeout(): VoiceError {
  return new VoiceError({ code: 'provider_timeout', retryable: true, status: 504 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new VoiceError({ code: 'not_found', status: 404 });
  return value;
}
