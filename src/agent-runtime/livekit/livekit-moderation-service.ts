import { resolveBrandEnv } from '../../config/converact-env.js';
import { createHash } from 'node:crypto';

import { RoomServiceClient } from 'livekit-server-sdk';

import { MemoryPg, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { isLiveKitConfigured, readLiveKitConfig, type LiveKitConfig } from './config.js';
import { MediaCallStore } from './media-call-store.js';
import type {
  ConveractFabricMediaCallParticipant,
  ConveractFabricMediaCallSnapshot,
  ConveractFabricMediaModerationCommandRecord,
  ConveractFabricMediaTrackSource
} from './types.js';

export interface LiveKitModerationProvider {
  mutePublishedTrack(roomName: string, identity: string, trackSid: string, muted: boolean): Promise<unknown>;
  removeParticipant(
    roomName: string,
    identity: string,
    options: { revokeTokenTs: bigint }
  ): Promise<void>;
  closeRoom(roomName: string): Promise<void>;
}

export interface LiveKitModerationProviderContext {
  tenant_id: string;
  call_id: string;
  room_name: string;
}

export type LiveKitModerationProviderResolver = (
  context: LiveKitModerationProviderContext
) => LiveKitModerationProvider | null | Promise<LiveKitModerationProvider | null>;

export interface LiveKitModerationResult {
  room_name: string;
  participant_identity: string;
  action: 'mute' | 'remove';
  status: 'applied' | 'already_applied';
  actor_identity: string;
  track_sid?: string;
  source?: ConveractFabricMediaTrackSource;
  muted?: true;
  reason?: string;
}

const memoryModerationLocks = new WeakMap<MemoryPg, Map<string, Promise<void>>>();
const TRACK_SOURCES = new Set<ConveractFabricMediaTrackSource>([
  'camera',
  'microphone',
  'screen_share',
  'screen_share_audio'
]);

export class LiveKitModerationService {
  constructor(
    private readonly store: MediaCallStore,
    private readonly provider: LiveKitModerationProvider | LiveKitModerationProviderResolver | null,
    private readonly options: { commandPg?: PgQueryable } = {}
  ) {}

  mute(input: {
    tenant_id: string;
    room_name: string;
    participant_identity: string;
    actor_identity: string;
    actor_is_system?: boolean;
    idempotency_key: string;
    track_sid: string;
    source: ConveractFabricMediaTrackSource;
    muted: true;
    metadata?: Record<string, unknown>;
    recovery?: boolean;
  }): Promise<LiveKitModerationResult> {
    const trackSid = required(input.track_sid, 'track_sid');
    const idempotencyKey = required(input.idempotency_key, 'Idempotency-Key');
    const actorIdentity = required(input.actor_identity, 'actor_identity');
    if (input.muted !== true) throw badRequest('remote unmute is not supported');
    if (!TRACK_SOURCES.has(input.source)) throw badRequest('unsupported media track source');
    const payloadHash = moderationPayloadHash({
      action: 'mute',
      room_name: input.room_name,
      participant_identity: input.participant_identity,
      actor_identity: actorIdentity,
      track_sid: trackSid,
      source: input.source,
      muted: true,
      metadata: input.metadata || {}
    });
    return this.withMemoryLock(`idempotency\u0000${input.tenant_id}\u0000${idempotencyKey}`, () =>
      this.withMemoryLock(`room\u0000${input.tenant_id}\u0000${input.room_name}`, () =>
        this.store.transaction(async (store) => {
        const replay = await lockOrReplay(store, input.tenant_id, idempotencyKey, payloadHash);
        if (replay) return replay;
        const preflight = await authorizeModeration(store, input, false);
        const provider = requireProvider(await this.resolveProvider({
          tenant_id: input.tenant_id,
          call_id: preflight.snapshot.call.id,
          room_name: input.room_name
        }));
        await this.ensurePendingCommand({
          tenant_id: input.tenant_id,
          call_id: preflight.snapshot.call.id,
          room_name: input.room_name,
          participant_identity: preflight.target.identity,
          action: 'mute',
          actor_identity: actorIdentity,
          actor_is_system: Boolean(input.actor_is_system),
          idempotency_key: idempotencyKey,
          payload_hash: payloadHash,
          request_payload: moderationCommandPayload(input)
        });
        const { snapshot, target } = await authorizeModeration(store, input, true);
        try {
          await provider.mutePublishedTrack(input.room_name, target.identity, trackSid, true);
        } catch (error) {
          if (!input.recovery) await this.markCommandFailed(input.tenant_id, idempotencyKey, error);
          throw providerFailure('mute', error);
        }
        const result: LiveKitModerationResult = {
          room_name: input.room_name,
          participant_identity: target.identity,
          action: 'mute',
          status: 'applied',
          actor_identity: actorIdentity,
          track_sid: trackSid,
          source: input.source,
          muted: true
        };
        await store.insertModerationAction({
          tenant_id: input.tenant_id,
          call_id: snapshot.call.id,
          room_name: input.room_name,
          participant_identity: target.identity,
          action: 'mute',
          actor_identity: actorIdentity,
          idempotency_key: idempotencyKey,
          payload_hash: payloadHash,
          track_sid: trackSid,
          source: input.source,
          muted: true,
          metadata: input.metadata,
          result_snapshot: result as unknown as Record<string, unknown>
        });
        return result;
        })
      )
    );
  }

  remove(input: {
    tenant_id: string;
    room_name: string;
    participant_identity: string;
    actor_identity: string;
    actor_is_system?: boolean;
    idempotency_key: string;
    reason?: string;
    metadata?: Record<string, unknown>;
    recovery?: boolean;
  }): Promise<LiveKitModerationResult> {
    const reason = String(input.reason || '').trim();
    const idempotencyKey = required(input.idempotency_key, 'Idempotency-Key');
    const actorIdentity = required(input.actor_identity, 'actor_identity');
    const payloadHash = moderationPayloadHash({
      action: 'remove',
      room_name: input.room_name,
      participant_identity: input.participant_identity,
      actor_identity: actorIdentity,
      reason,
      metadata: input.metadata || {}
    });
    return this.withMemoryLock(`idempotency\u0000${input.tenant_id}\u0000${idempotencyKey}`, () =>
      this.withMemoryLock(`room\u0000${input.tenant_id}\u0000${input.room_name}`, () =>
        this.store.transaction(async (store) => {
        const replay = await lockOrReplay(store, input.tenant_id, idempotencyKey, payloadHash);
        if (replay) return replay;
        const preflight = await authorizeRemoval(store, input, false);
        if (isInactive(preflight.target)) {
          return moderationResult({ ...input, actor_identity: actorIdentity }, 'remove', 'already_applied', reason);
        }
        if (!isProviderActive(preflight.target)) throw conflict('media call participant is not active');
        const provider = requireProvider(await this.resolveProvider({
          tenant_id: input.tenant_id,
          call_id: preflight.call.id,
          room_name: input.room_name
        }));
        await this.ensurePendingCommand({
          tenant_id: input.tenant_id,
          call_id: preflight.call.id,
          room_name: input.room_name,
          participant_identity: preflight.target.identity,
          action: 'remove',
          actor_identity: actorIdentity,
          actor_is_system: Boolean(input.actor_is_system),
          idempotency_key: idempotencyKey,
          payload_hash: payloadHash,
          request_payload: moderationCommandPayload(input)
        });
        const { call, target } = await authorizeRemoval(store, input, true);
        if (isInactive(target)) {
          return moderationResult({ ...input, actor_identity: actorIdentity }, 'remove', 'already_applied', reason);
        }
        if (!isProviderActive(target)) throw conflict('media call participant is not active');
        try {
          await provider.removeParticipant(input.room_name, target.identity, {
            revokeTokenTs: revocationTimestamp()
          });
        } catch (error) {
          if (!input.recovery) await this.markCommandFailed(input.tenant_id, idempotencyKey, error);
          throw providerFailure('remove', error);
        }
        await store.updateParticipant({
          ...target,
          status: 'removed',
          left_at: new Date().toISOString()
        });
        const result = moderationResult(
          { ...input, actor_identity: actorIdentity },
          'remove',
          'applied',
          reason
        );
        await store.insertModerationAction({
          tenant_id: input.tenant_id,
          call_id: call.id,
          room_name: input.room_name,
          participant_identity: target.identity,
          action: 'remove',
          actor_identity: actorIdentity,
          idempotency_key: idempotencyKey,
          payload_hash: payloadHash,
          reason,
          metadata: input.metadata,
          result_snapshot: result as unknown as Record<string, unknown>
        });
        return result;
        })
      )
    );
  }

  completeCommand(
    tenantId: string,
    idempotencyKey: string,
    result: LiveKitModerationResult
  ): Promise<void> {
    return this.withCommandStore(tenantId, async (store) => {
      await store.updateModerationCommand({
        tenant_id: tenantId,
        idempotency_key: idempotencyKey,
        status: 'completed',
        result_snapshot: result as unknown as Record<string, unknown>
      });
    });
  }

  async recoverPending(tenantId: string, limit = 25): Promise<{
    examined: number;
    finalized: number;
    recovered: number;
    failed: number;
    results: LiveKitModerationResult[];
  }> {
    this.requireRecoveryPg();
    const commands = await this.withCommandStore(tenantId, (store) =>
      store.listPendingModerationCommands(tenantId, limit)
    );
    const summary = {
      examined: commands.length,
      finalized: 0,
      recovered: 0,
      failed: 0,
      results: [] as LiveKitModerationResult[]
    };
    for (const command of commands) {
      const audit = await this.withCommandStore(tenantId, (store) =>
        store.getModerationActionByIdempotencyKey(tenantId, command.idempotency_key)
      );
      if (audit) {
        await this.completeCommand(
          tenantId,
          command.idempotency_key,
          audit.result_snapshot as unknown as LiveKitModerationResult
        );
        summary.finalized += 1;
        continue;
      }
      try {
        const result = await this.executeRecoveryCommand(command);
        await this.completeCommand(tenantId, command.idempotency_key, result);
        summary.recovered += 1;
        summary.results.push(result);
      } catch (error) {
        summary.failed += 1;
        const status = Number((error as { status?: unknown }).status || 500);
        const retryable = (error as { retryable?: unknown }).retryable === true;
        if (status >= 400 && status < 500 && !retryable) {
          await this.markCommandFailed(tenantId, command.idempotency_key, error);
        }
      }
    }
    return summary;
  }

  private executeRecoveryCommand(
    command: ConveractFabricMediaModerationCommandRecord
  ): Promise<LiveKitModerationResult> {
    const recoveryPg = this.requireRecoveryPg();
    return withPgTenant(recoveryPg, command.tenant_id, async (pg) => {
      const service = new LiveKitModerationService(
        new MediaCallStore(pg),
        this.provider,
        { commandPg: recoveryPg }
      );
      const request = command.request_payload;
      return command.action === 'mute'
        ? service.mute({
          tenant_id: command.tenant_id,
          room_name: command.room_name,
          participant_identity: command.participant_identity,
          actor_identity: command.actor_identity,
          actor_is_system: command.actor_is_system,
          idempotency_key: command.idempotency_key,
          track_sid: String(request.track_sid || ''),
          source: String(request.source || '') as ConveractFabricMediaTrackSource,
          muted: request.muted as true,
          metadata: recordValue(request.metadata),
          recovery: true
        })
        : service.remove({
          tenant_id: command.tenant_id,
          room_name: command.room_name,
          participant_identity: command.participant_identity,
          actor_identity: command.actor_identity,
          actor_is_system: command.actor_is_system,
          idempotency_key: command.idempotency_key,
          reason: String(request.reason || ''),
          metadata: recordValue(request.metadata),
          recovery: true
        });
    });
  }

  private requireRecoveryPg(): PgQueryable {
    const pg = this.options.commandPg || this.store.pg;
    if (pg instanceof MemoryPg) return pg;
    const connection = pg as PgQueryable & { connect?: unknown; release?: unknown };
    if (typeof connection.connect !== 'function' || typeof connection.release === 'function') {
      throw Object.assign(new Error('media moderation recovery requires the root PostgreSQL pool'), {
        status: 503,
        code: 'media_moderation_recovery_pool_required'
      });
    }
    return pg;
  }

  private async ensurePendingCommand(
    input: Parameters<MediaCallStore['upsertModerationCommand']>[0]
  ): Promise<void> {
    await this.withCommandStore(input.tenant_id, async (store) => {
      const command = await store.upsertModerationCommand(input);
      if (command.payload_hash !== input.payload_hash) {
        throw conflict('Idempotency-Key was already used for another media moderation command');
      }
      if (command.status !== 'pending') {
        await store.updateModerationCommand({
          tenant_id: input.tenant_id,
          idempotency_key: input.idempotency_key,
          status: 'pending'
        });
      }
    });
  }

  private markCommandFailed(tenantId: string, idempotencyKey: string, error: unknown): Promise<void> {
    return this.withCommandStore(tenantId, async (store) => {
      await store.updateModerationCommand({
        tenant_id: tenantId,
        idempotency_key: idempotencyKey,
        status: 'failed',
        error_code: safeErrorCode((error as { code?: unknown }).code),
        error_message: 'media moderation command failed'
      });
    });
  }

  private withCommandStore<T>(
    tenantId: string,
    fn: (store: MediaCallStore) => Promise<T>
  ): Promise<T> {
    return withPgTenant(this.options.commandPg || this.store.pg, tenantId, (pg) =>
      fn(new MediaCallStore(pg))
    );
  }

  async revokeForTerminal(snapshot: ConveractFabricMediaCallSnapshot): Promise<void> {
    const provider = await this.resolveProvider({
      tenant_id: snapshot.call.tenant_id,
      call_id: snapshot.call.id,
      room_name: snapshot.call.room_name
    });
    if (!provider) {
      if (process.env.NODE_ENV === 'production') throw providerNotConfigured();
      return;
    }
    const revokeTokenTs = revocationTimestamp();
    try {
      for (const participant of snapshot.participants) {
        await provider.removeParticipant(snapshot.call.room_name, participant.identity, { revokeTokenTs });
      }
      await provider.closeRoom(snapshot.call.room_name);
    } catch (error) {
      throw providerFailure('close', error);
    }
  }

  private resolveProvider(
    context: LiveKitModerationProviderContext
  ): Promise<LiveKitModerationProvider | null> {
    return Promise.resolve(
      typeof this.provider === 'function'
        ? this.provider(context)
        : this.provider
    );
  }

  private withMemoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!(this.store.pg instanceof MemoryPg)) return fn();
    let locks = memoryModerationLocks.get(this.store.pg);
    if (!locks) {
      locks = new Map();
      memoryModerationLocks.set(this.store.pg, locks);
    }
    const previous = locks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    locks.set(key, current);
    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        release();
        if (locks!.get(key) === current) locks!.delete(key);
      }
    });
  }
}

export function createConfiguredLiveKitModerationProvider(
  config: LiveKitConfig = readLiveKitConfig()
): LiveKitModerationProvider | null {
  if (!isLiveKitConfigured(config)) return null;
  const timeoutSeconds = boundedTimeout(resolveBrandEnv(process.env, 'LIVEKIT_ADMIN_TIMEOUT_SECONDS'));
  const client = new RoomServiceClient(config.url!, config.apiKey!, config.apiSecret!, {
    requestTimeout: timeoutSeconds
  });
  return {
    mutePublishedTrack: (roomName, identity, trackSid, muted) =>
      client.mutePublishedTrack(roomName, identity, trackSid, muted),
    removeParticipant: async (roomName, identity, options) => {
      try {
        await client.removeParticipant(roomName, identity, options);
      } catch (error) {
        if (!isProviderNotFound(error)) throw error;
      }
    },
    closeRoom: async (roomName) => {
      try {
        await client.deleteRoom(roomName);
      } catch (error) {
        if (!isProviderNotFound(error)) throw error;
      }
    }
  };
}

async function lockOrReplay(
  store: MediaCallStore,
  tenantId: string,
  idempotencyKey: string,
  payloadHash: string
): Promise<LiveKitModerationResult | null> {
  if (!await store.tryLockIdempotencyKey(tenantId, idempotencyKey)) {
    throw Object.assign(conflict('media moderation idempotency key is currently in progress'), {
      code: 'media_moderation_idempotency_busy',
      retryable: true
    });
  }
  const existing = await store.getModerationActionByIdempotencyKey(tenantId, idempotencyKey);
  if (!existing) return null;
  if (existing.payload_hash !== payloadHash) {
    throw conflict('Idempotency-Key was already used for another media moderation action');
  }
  return existing.result_snapshot as unknown as LiveKitModerationResult;
}

function moderationPayloadHash(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function moderationCommandPayload(input: {
  track_sid?: string;
  source?: ConveractFabricMediaTrackSource;
  muted?: true;
  reason?: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...(input.track_sid ? { track_sid: input.track_sid } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.muted ? { muted: true } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    metadata: input.metadata || {}
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeErrorCode(value: unknown): string {
  const normalized = String(value || 'provider_failed').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return normalized.slice(0, 100) || 'provider_failed';
}

async function authorizeModeration(
  store: MediaCallStore,
  input: {
    tenant_id: string;
    room_name: string;
    participant_identity: string;
    actor_identity: string;
    actor_is_system?: boolean;
  },
  forUpdate: boolean
): Promise<{ snapshot: ConveractFabricMediaCallSnapshot; target: ConveractFabricMediaCallParticipant }> {
  const call = await store.getCallByRoom(input.tenant_id, input.room_name, { forUpdate });
  if (!call) throw notFound('media call not found');
  const participants = await store.listParticipants(input.tenant_id, call.id);
  authorizeActor(input.actor_identity, Boolean(input.actor_is_system), participants);
  assertModeratableCall(call.status);
  const target = participants.find((participant) => participant.identity === input.participant_identity);
  if (!target) throw notFound('media call participant not found');
  if (!isProviderActive(target)) throw conflict('media call participant is not active');
  return { snapshot: { call, participants }, target };
}

async function authorizeRemoval(
  store: MediaCallStore,
  input: {
    tenant_id: string;
    room_name: string;
    participant_identity: string;
    actor_identity: string;
    actor_is_system?: boolean;
  },
  forUpdate: boolean
): Promise<{ call: ConveractFabricMediaCallSnapshot['call']; target: ConveractFabricMediaCallParticipant }> {
  const call = await store.getCallByRoom(input.tenant_id, input.room_name, { forUpdate });
  if (!call) throw notFound('media call not found');
  const participants = await store.listParticipants(input.tenant_id, call.id);
  authorizeActor(input.actor_identity, Boolean(input.actor_is_system), participants);
  assertModeratableCall(call.status);
  const target = participants.find((participant) => participant.identity === input.participant_identity);
  if (!target) throw notFound('media call participant not found');
  if (!input.actor_is_system && target.role === 'host') {
    throw forbidden('a media call host cannot remove the host participant');
  }
  return { call, target };
}

function authorizeActor(
  actorIdentity: string,
  actorIsSystem: boolean,
  participants: ConveractFabricMediaCallParticipant[]
): void {
  const actor = required(actorIdentity, 'actor_identity');
  if (actorIsSystem) return;
  const participant = participants.find((item) => item.identity === actor);
  if (!participant || participant.role !== 'host' || isInactive(participant)) {
    throw forbidden('media call host role required');
  }
}

function assertModeratableCall(status: ConveractFabricMediaCallSnapshot['call']['status']): void {
  if (status !== 'accepted' && status !== 'active') {
    throw conflict('media call must be accepted before moderation');
  }
}

function isProviderActive(participant: ConveractFabricMediaCallParticipant): boolean {
  return participant.status === 'accepted' || participant.status === 'joined';
}

function isInactive(participant: ConveractFabricMediaCallParticipant): boolean {
  return ['left', 'declined', 'missed', 'removed'].includes(participant.status);
}

function moderationResult(
  input: { room_name: string; participant_identity: string; actor_identity: string },
  action: 'mute' | 'remove',
  status: 'applied' | 'already_applied',
  reason: string
): LiveKitModerationResult {
  return {
    room_name: input.room_name,
    participant_identity: input.participant_identity,
    action,
    status,
    actor_identity: required(input.actor_identity, 'actor_identity'),
    ...(reason ? { reason } : {})
  };
}

function requireProvider(provider: LiveKitModerationProvider | null): LiveKitModerationProvider {
  if (!provider) throw providerNotConfigured();
  return provider;
}

function providerNotConfigured(): Error & { status: number; code: string } {
  return Object.assign(new Error('LiveKit moderation is not configured'), {
    status: 503,
    code: 'livekit_moderation_not_configured'
  });
}

function providerFailure(action: string, cause: unknown): Error & {
  status: number;
  code: string;
  retryable: boolean;
  cause: unknown;
} {
  return Object.assign(new Error(`LiveKit ${action} operation failed`), {
    status: 502,
    code: 'livekit_moderation_provider_failed',
    retryable: true,
    cause
  });
}

function isProviderNotFound(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown };
  return Number(value?.status) === 404 || String(value?.code || '').toLowerCase() === 'not_found';
}

function boundedTimeout(value: string | undefined): number {
  const parsed = Number(value || 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 30 ? parsed : 10;
}

function revocationTimestamp(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000) + 1);
}

function required(value: string, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw badRequest(`${field} is required`);
  return normalized;
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function forbidden(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 403 });
}

function notFound(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 404 });
}

function conflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
}
