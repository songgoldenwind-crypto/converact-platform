import { createHash } from 'node:crypto';

import { MemoryPg, pgId, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { MediaCallStore } from './media-call-store.js';
import type {
  IveKitMediaCall,
  IveKitMediaCallAction,
  IveKitMediaCallParticipant,
  IveKitMediaCallSnapshot,
  MediaBusinessRef
} from './types.js';
import type { LiveKitPlacementContext } from './token-service.js';

export const ALLOWED_MEDIA_CALL_ACTIONS = {
  created: ['ring', 'cancel', 'fail'],
  ringing: ['accept', 'reject', 'cancel', 'timeout', 'fail'],
  accepted: ['accept', 'activate', 'end', 'fail'],
  active: ['accept', 'end', 'fail'],
  rejected: [],
  cancelled: [],
  timed_out: [],
  ended: [],
  failed: []
} as const satisfies Record<IveKitMediaCall['status'], readonly IveKitMediaCallAction[]>;

export const MAX_MEDIA_CALL_PARTICIPANTS = 32;
export const MAX_MEDIA_CALL_INVITEE_IDENTITIES =
  MAX_MEDIA_CALL_PARTICIPANTS - 1;

const memoryCallLockTails = new WeakMap<MemoryPg, Map<string, Promise<void>>>();

export interface MediaCallTransitionResult {
  snapshot: IveKitMediaCallSnapshot;
  replayed: boolean;
  placement_reconcile?: {
    tenant_id: string;
    interaction_id: string;
    desired_state: 'active' | 'closed';
  };
}

export interface MediaCallPlacementReservation {
  interaction_id: string;
  value: unknown;
}

export type MediaCallPlacementAvailability =
  | {
      status: 'ready';
      reason: 'eligible_candidates';
      candidate_count: number;
      snapshot_version: number;
    }
  | {
      status: 'unavailable';
      reason: 'no_eligible_candidates';
      candidate_count: 0;
      snapshot_version: number;
    }
  | {
      status: 'unknown';
      reason: 'snapshot_unavailable';
      candidate_count: 0;
      snapshot_version: null;
    };

export interface MediaCallPlacementPort {
  availability?(input: {
    tenant_id: string;
    participant_count?: number;
  }): Promise<MediaCallPlacementAvailability>;
  reserve(input: {
    tenant_id: string;
    interaction_id: string;
    media: 'voice' | 'video';
    participant_count: number;
    business_ref: MediaBusinessRef;
    idempotency_key: string;
  }): Promise<MediaCallPlacementReservation>;
  persistReserved(
    pg: PgQueryable,
    reservation: MediaCallPlacementReservation
  ): Promise<void>;
  releaseUncommitted(reservation: MediaCallPlacementReservation): Promise<void>;
  requestState(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
      desired_state: 'active' | 'closed';
      reason: string;
    }
  ): Promise<void>;
  reconcileOne(input: {
    tenant_id: string;
    interaction_id: string;
    worker_id: string;
  }): Promise<{ outcome: 'idle' | 'succeeded' | 'retry_wait' | 'failed' }>;
  resolveOwner(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
    }
  ): Promise<LiveKitPlacementContext>;
  recoverOwner?(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
      expected_owner_epoch: string;
      expected_reservation_id: string;
      worker_id: string;
    }
  ): Promise<LiveKitPlacementContext>;
}

export interface MediaCallServiceOptions {
  now?: () => Date;
  onTimedOut?: (snapshot: IveKitMediaCallSnapshot) => void | Promise<void>;
  beforeTerminalTransition?: (
    snapshot: IveKitMediaCallSnapshot,
    context: { action: IveKitMediaCallAction; actor_identity: string; reason: string }
  ) => Promise<void>;
  placement?: MediaCallPlacementPort;
  placementWorkerId?: string;
}

const TERMINAL_MEDIA_CALL_ACTIONS = new Set<IveKitMediaCallAction>([
  'reject',
  'cancel',
  'timeout',
  'end',
  'fail'
]);

export class MediaCallService {
  constructor(
    private readonly store: MediaCallStore,
    private readonly options: MediaCallServiceOptions = {}
  ) {}

  async createCall(input: {
    tenant_id: string;
    initiated_by: string;
    media: 'voice' | 'video';
    participant_identities: string[];
    business_ref: MediaBusinessRef;
    title?: string;
    metadata?: Record<string, unknown>;
    ring_timeout_seconds?: number;
    idempotency_key?: string;
    call_id?: string;
    placement_reservation?: MediaCallPlacementReservation;
    beforeCreateCommit?: (
      pg: PgQueryable,
      snapshot: IveKitMediaCallSnapshot
    ) => Promise<void>;
  }): Promise<IveKitMediaCallSnapshot> {
    assertMediaCallParticipantLimit(input.participant_identities);
    const actor = requiredIdentity(input.initiated_by, 'initiated_by');
    const businessRef = validatedBusinessRef(input.tenant_id, input.business_ref);
    if (input.media !== 'voice' && input.media !== 'video') throw badRequest('media must be voice or video');
    const ringTimeoutSeconds = input.ring_timeout_seconds ?? 30;
    if (!Number.isInteger(ringTimeoutSeconds) || ringTimeoutSeconds < 5 || ringTimeoutSeconds > 300) {
      throw badRequest('ring_timeout_seconds must be an integer between 5 and 300');
    }
    const invitees = [...new Set(input.participant_identities.map((identity) => identity.trim()))]
      .filter((identity) => identity && identity !== actor);
    const callId = input.call_id
      ? requiredIdentity(input.call_id, 'call_id')
      : pgId('mcall');
    const ownsReservation = !input.placement_reservation;
    let reservation = input.placement_reservation;
    if (reservation && reservation.interaction_id !== callId) {
      throw badRequest('placement reservation interaction mismatch');
    }
    if (this.options.placement && !reservation) {
      reservation = await this.options.placement.reserve({
        tenant_id: input.tenant_id,
        interaction_id: callId,
        media: input.media,
        participant_count: invitees.length + 1,
        business_ref: businessRef,
        idempotency_key: String(input.idempotency_key || `media-call:${callId}`)
      });
    }
    try {
      return await this.store.transaction(async (store) => {
        const call = await store.insertCall({
          id: callId,
          tenant_id: input.tenant_id,
          media: input.media,
          initiated_by: actor,
          business_ref: businessRef,
          title: String(input.title || '').trim(),
          metadata: input.metadata || {},
          ring_timeout_seconds: ringTimeoutSeconds
        });
        await store.insertParticipant({
          tenant_id: input.tenant_id,
          call_id: call.id,
          identity: actor,
          role: 'host',
          status: 'joined'
        });
        for (const identity of invitees) {
          await store.insertParticipant({
            tenant_id: input.tenant_id,
            call_id: call.id,
            identity,
            role: 'participant',
            status: 'invited'
          });
        }
        if (this.options.placement && reservation) {
          await this.options.placement.persistReserved(store.pg, reservation);
          await this.options.placement.requestState(store.pg, {
            tenant_id: input.tenant_id,
            interaction_id: call.id,
            desired_state: 'active',
            reason: 'media_call_durable'
          });
        }
        const snapshot = (await store.snapshot(input.tenant_id, call.id))!;
        await input.beforeCreateCommit?.(store.pg, snapshot);
        return snapshot;
      });
    } catch (error) {
      if (ownsReservation && this.options.placement && reservation) {
        await this.options.placement.releaseUncommitted(reservation).catch((releaseError) => {
          console.error(
            '[media-call-placement] failed to release uncommitted reservation:',
            releaseError instanceof Error ? releaseError.message : String(releaseError)
          );
        });
      }
      throw error;
    }
  }

  ensureVoiceBridge(input: {
    tenant_id: string;
    voice_call_id: string;
    initiated_by: string;
    participant_identity: string;
    idempotency_key: string;
    business_ref: MediaBusinessRef;
  }): Promise<{ media_call_id: string; room_name: string }> {
    const tenantId = requiredIdentity(input.tenant_id, 'tenant_id');
    const voiceCallId = requiredIdentity(input.voice_call_id, 'voice_call_id');
    const actor = requiredIdentity(input.initiated_by, 'initiated_by');
    const participantIdentity = requiredIdentity(input.participant_identity, 'participant_identity');
    const idempotencyKey = requiredIdentity(input.idempotency_key, 'idempotency_key');
    const businessRef = validatedBusinessRef(tenantId, input.business_ref);
    const roomName = `ivekit-pstn-${createHash('sha256')
      .update(`${tenantId}\u0000${idempotencyKey}`)
      .digest('hex')
      .slice(0, 32)}`;
    const callId = `mcall_${createHash('sha256')
      .update(`${tenantId}\u0000${idempotencyKey}\u0000voice-bridge`)
      .digest('hex')
      .slice(0, 32)}`;
    return this.withMemoryLock(`voice-bridge\u0000${tenantId}\u0000${idempotencyKey}`, () =>
      this.ensureVoiceBridgeWithPlacement({
        tenantId,
        voiceCallId,
        actor,
        participantIdentity,
        idempotencyKey,
        businessRef,
        roomName,
        callId
      })
    );
  }

  private async ensureVoiceBridgeWithPlacement(input: {
    tenantId: string;
    voiceCallId: string;
    actor: string;
    participantIdentity: string;
    idempotencyKey: string;
    businessRef: MediaBusinessRef;
    roomName: string;
    callId: string;
  }): Promise<{ media_call_id: string; room_name: string }> {
    const existing = await withPgTenant(this.store.pg, input.tenantId, (tenantPg) =>
      new MediaCallStore(tenantPg).getCallByRoom(input.tenantId, input.roomName)
    );
    if (existing) {
      assertVoiceBridgeReplay(existing, input.voiceCallId, input.businessRef);
      await this.ensureExistingBridgePlacement(input.tenantId, existing.id);
      return { media_call_id: existing.id, room_name: existing.room_name };
    }
    const reservation = this.options.placement
      ? await this.options.placement.reserve({
          tenant_id: input.tenantId,
          interaction_id: input.callId,
          media: 'voice',
          participant_count: input.participantIdentity === input.actor ? 1 : 2,
          business_ref: input.businessRef,
          idempotency_key: `voice-bridge:${input.idempotencyKey}`
        })
      : undefined;
    let durablePlacement = false;
    try {
      const result = await withPgTenant(this.store.pg, input.tenantId, (tenantPg) =>
        new MediaCallStore(tenantPg).transaction(async (store) => {
          if (!await store.tryLockIdempotencyKey(
            input.tenantId,
            `voice-bridge:${input.idempotencyKey}`
          )) {
            throw Object.assign(conflict('voice bridge idempotency key is currently in progress'), {
              code: 'media_call_idempotency_busy',
              retryable: true
            });
          }
          const replay = await store.getCallByRoom(
            input.tenantId,
            input.roomName,
            { forUpdate: true }
          );
          if (replay) {
            assertVoiceBridgeReplay(replay, input.voiceCallId, input.businessRef);
            return {
              media_call_id: replay.id,
              room_name: replay.room_name,
              created: false
            };
          }
          const call = await store.insertCall({
            id: input.callId,
            tenant_id: input.tenantId,
            room_name: input.roomName,
            media: 'voice',
            initiated_by: input.actor,
            business_ref: input.businessRef,
            title: '',
            metadata: {
              bridge_kind: 'pstn',
              voice_call_id: input.voiceCallId
            },
            ring_timeout_seconds: 30
          });
          await store.insertParticipant({
            tenant_id: input.tenantId,
            call_id: call.id,
            identity: input.actor,
            role: 'host',
            status: 'joined'
          });
          if (input.participantIdentity !== input.actor) {
            await store.insertParticipant({
              tenant_id: input.tenantId,
              call_id: call.id,
              identity: input.participantIdentity,
              role: 'participant',
              status: 'invited',
              metadata: { participant_kind: 'sip' }
            });
          }
          if (this.options.placement && reservation) {
            await this.options.placement.persistReserved(store.pg, reservation);
            await this.options.placement.requestState(store.pg, {
              tenant_id: input.tenantId,
              interaction_id: call.id,
              desired_state: 'active',
              reason: 'voice_bridge_durable'
            });
          }
          return {
            media_call_id: call.id,
            room_name: call.room_name,
            created: true
          };
        })
      );
      if (this.options.placement && result.created) {
        durablePlacement = true;
        await this.options.placement.reconcileOne({
          tenant_id: input.tenantId,
          interaction_id: result.media_call_id,
          worker_id: this.options.placementWorkerId || 'voice-bridge-worker'
        });
      }
      return {
        media_call_id: result.media_call_id,
        room_name: result.room_name
      };
    } catch (error) {
      if (this.options.placement && reservation && !durablePlacement) {
        await this.options.placement.releaseUncommitted(reservation).catch(
          (releaseError) => {
            console.error(
              '[media-call-placement] failed to release voice bridge reservation:',
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError)
            );
          }
        );
      }
      throw error;
    }
  }

  private async ensureExistingBridgePlacement(
    tenantId: string,
    callId: string
  ): Promise<void> {
    if (!this.options.placement) return;
    try {
      await this.options.placement.resolveOwner(this.store.pg, {
        tenant_id: tenantId,
        interaction_id: callId
      });
    } catch {
      await this.options.placement.reconcileOne({
        tenant_id: tenantId,
        interaction_id: callId,
        worker_id: this.options.placementWorkerId || 'voice-bridge-worker'
      });
    }
  }

  getCall(tenantId: string, callId: string): Promise<IveKitMediaCallSnapshot | null> {
    return this.store.snapshot(tenantId, callId);
  }

  listParticipants(tenantId: string, callId: string): Promise<IveKitMediaCallParticipant[]> {
    return this.store.listParticipants(tenantId, callId);
  }

  async timeoutExpired(tenantId: string, limit = 25): Promise<{
    scanned: number;
    timed_out: number;
    skipped: number;
  }> {
    const now = this.now();
    const calls = await this.store.listExpiredRingingCalls(tenantId, now, limit);
    let timedOut = 0;
    let skipped = 0;
    for (const call of calls) {
      try {
        const transition = await this.transition({
          tenant_id: tenantId,
          call_id: call.id,
          action: 'timeout',
          actor_identity: 'media-timeout-worker',
          actor_is_system: true,
          idempotency_key: `media-timeout:${call.id}:${call.ring_expires_at}`,
          reason: 'ring_timeout'
        });
        if (transition.placement_reconcile && this.options.placement) {
          await this.options.placement.reconcileOne({
            tenant_id: transition.placement_reconcile.tenant_id,
            interaction_id: transition.placement_reconcile.interaction_id,
            worker_id: this.options.placementWorkerId || 'media-timeout-worker'
          });
        }
        await this.options.onTimedOut?.(transition.snapshot);
        timedOut += 1;
      } catch (cause) {
        const status = Number((cause as { status?: number }).status || 0);
        if (status !== 404 && status !== 409) throw cause;
        skipped += 1;
      }
    }
    return { scanned: calls.length, timed_out: timedOut, skipped };
  }

  withJoinAuthorization<T>(
    tenantId: string,
    callId: string,
    identity: string,
    fn: (
      snapshot: IveKitMediaCallSnapshot,
      participant: IveKitMediaCallParticipant
    ) => Promise<T>
  ): Promise<T> {
    return this.withCallLock(tenantId, callId, () =>
      this.store.transaction(async (store) => {
        const call = await store.getCall(tenantId, callId, { forUpdate: true });
        if (!call) throw notFound('media call not found');
        const participants = await store.listParticipants(tenantId, callId);
        const participant = participants.find((item) => item.identity === identity);
        if (call.status !== 'accepted' && call.status !== 'active') {
          throw conflict('media call must be accepted before join');
        }
        const mayJoin = participant?.role === 'host'
          ? participant.status === 'joined'
          : participant?.status === 'accepted' || participant?.status === 'joined';
        if (!participant || !mayJoin) throw notFound('active media call participant not found');
        return fn({ call, participants }, participant);
      })
    );
  }

  withRecordingStartAuthorization<T>(
    tenantId: string,
    callId: string,
    input: {
      actor_identity: string;
      actor_is_system?: boolean;
      room_name: string;
    },
    fn: (snapshot: IveKitMediaCallSnapshot) => Promise<T>
  ): Promise<T> {
    const actor = requiredIdentity(input.actor_identity, 'actor_identity');
    return this.withCallLock(tenantId, callId, () =>
      this.store.transaction(async (store) => {
        const call = await store.getCall(tenantId, callId, { forUpdate: true });
        if (!call || call.room_name !== input.room_name) throw notFound('media call not found');
        const participants = await store.listParticipants(tenantId, callId);
        if (call.status !== 'accepted' && call.status !== 'active') {
          throw conflict('media call must be accepted or active before recording');
        }
        if (!input.actor_is_system) {
          const participant = participants.find((item) => item.identity === actor && item.status !== 'removed');
          if (participant?.role !== 'host') {
            throw Object.assign(new Error('recording command requires host role'), { status: 403 });
          }
        }
        return fn({ call, participants });
      })
    );
  }

  async transition(input: {
    tenant_id: string;
    call_id: string;
    action: IveKitMediaCallAction;
    actor_identity: string;
    actor_is_system?: boolean;
    idempotency_key: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<MediaCallTransitionResult> {
    const actor = requiredIdentity(input.actor_identity, 'actor_identity');
    const idempotencyKey = requiredIdentity(input.idempotency_key, 'Idempotency-Key');
    const reason = String(input.reason || '').trim();
    const metadata = input.metadata || {};
    const payloadHash = createHash('sha256').update(JSON.stringify({
      call_id: input.call_id,
      action: input.action,
      actor_identity: actor,
      reason,
      metadata
    })).digest('hex');

    const result = await this.withMemoryLock(`idempotency\u0000${input.tenant_id}\u0000${idempotencyKey}`, () =>
      this.withCallLock(input.tenant_id, input.call_id, () =>
        this.store.transaction(async (store) => {
        if (!await store.tryLockIdempotencyKey(input.tenant_id, idempotencyKey)) {
          throw Object.assign(conflict('media call idempotency key is currently in progress'), {
            code: 'media_call_idempotency_busy',
            retryable: true
          });
        }
        const call = await store.getCall(input.tenant_id, input.call_id, { forUpdate: true });
        if (!call) throw notFound('media call not found');
        const existing = await store.getActionByIdempotencyKey(input.tenant_id, idempotencyKey);
        if (existing) {
          if (existing.call_id !== input.call_id || existing.payload_hash !== payloadHash) {
            throw conflict('Idempotency-Key was already used for another media call action');
          }
          return { snapshot: existing.result_snapshot, replayed: true };
        }
        const participants = await store.listParticipants(input.tenant_id, input.call_id);
        assertActionAuthorized(input.action, actor, Boolean(input.actor_is_system), participants);
        if (!(ALLOWED_MEDIA_CALL_ACTIONS[call.status] as readonly string[]).includes(input.action)) {
          throw conflict(`media call action '${input.action}' is not allowed from '${call.status}'`);
        }
        const now = this.now();
        if (input.action === 'timeout') {
          const expiry = call.ring_expires_at ? new Date(call.ring_expires_at).getTime() : Number.NaN;
          if (!Number.isFinite(expiry) || now.getTime() < expiry) {
            throw conflict('media call ring deadline has not expired');
          }
        }

        if (TERMINAL_MEDIA_CALL_ACTIONS.has(input.action)) {
          await this.options.beforeTerminalTransition?.(
            { call, participants },
            { action: input.action, actor_identity: actor, reason }
          );
        }

        const fromStatus = call.status;
        const nextCall = transitionCall(call, input.action, reason, now);
        const nextParticipants = participants.map((participant) =>
          transitionParticipant(participant, input.action, actor, now)
        );
        await store.updateCall(nextCall);
        for (const participant of nextParticipants) {
          const previous = participants.find((item) => item.id === participant.id)!;
          if (JSON.stringify(participant) !== JSON.stringify(previous)) {
            await store.updateParticipant(participant);
          }
        }
        const snapshot = (await store.snapshot(input.tenant_id, input.call_id))!;
        await store.insertAction({
          tenant_id: input.tenant_id,
          call_id: input.call_id,
          idempotency_key: idempotencyKey,
          payload_hash: payloadHash,
          action: input.action,
          actor_identity: actor,
          reason,
          metadata,
          from_status: fromStatus,
          to_status: snapshot.call.status,
          result_snapshot: snapshot
        });
        const desiredState = placementDesiredState(input.action);
        if (this.options.placement && desiredState) {
          await this.options.placement.requestState(store.pg, {
            tenant_id: input.tenant_id,
            interaction_id: input.call_id,
            desired_state: desiredState,
            reason: desiredState === 'active'
              ? 'media_call_activated'
              : `media_call_${snapshot.call.status}`
          });
        }
        return { snapshot, replayed: false };
        })
      )
    );
    const desiredState = result.replayed ? null : placementDesiredState(input.action);
    return desiredState
      ? {
          ...result,
          placement_reconcile: {
            tenant_id: input.tenant_id,
            interaction_id: input.call_id,
            desired_state: desiredState
          }
        }
      : result;
  }

  private withCallLock<T>(tenantId: string, callId: string, fn: () => Promise<T>): Promise<T> {
    return this.withMemoryLock(`call\u0000${tenantId}\u0000${callId}`, fn);
  }

  private now(): Date {
    return this.options.now?.() || new Date();
  }

  private withMemoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!(this.store.pg instanceof MemoryPg)) return fn();
    const pg = this.store.pg;
    let locks = memoryCallLockTails.get(pg);
    if (!locks) {
      locks = new Map();
      memoryCallLockTails.set(pg, locks);
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

function placementDesiredState(
  action: IveKitMediaCallAction
): 'active' | 'closed' | null {
  if (action === 'activate') return 'active';
  return TERMINAL_MEDIA_CALL_ACTIONS.has(action) ? 'closed' : null;
}

function transitionCall(
  call: IveKitMediaCall,
  action: IveKitMediaCallAction,
  reason: string,
  now: Date
): IveKitMediaCall {
  const iso = now.toISOString();
  const next = { ...call };
  switch (action) {
    case 'ring':
      next.status = 'ringing';
      next.ring_expires_at = new Date(now.getTime() + call.ring_timeout_seconds * 1_000).toISOString();
      break;
    case 'accept':
      if (call.status === 'ringing') {
        next.status = 'accepted';
        next.accepted_at = iso;
      }
      break;
    case 'reject':
      next.status = 'rejected';
      next.ended_at = iso;
      next.end_reason = reason || 'rejected';
      break;
    case 'cancel':
      next.status = 'cancelled';
      next.ended_at = iso;
      next.end_reason = reason || 'cancelled';
      break;
    case 'timeout':
      next.status = 'timed_out';
      next.ended_at = iso;
      next.end_reason = reason || 'ring_timeout';
      break;
    case 'activate':
      next.status = 'active';
      next.started_at = iso;
      break;
    case 'end':
      next.status = 'ended';
      next.ended_at = iso;
      next.end_reason = reason || 'ended';
      break;
    case 'fail':
      next.status = 'failed';
      next.ended_at = iso;
      next.end_reason = reason || 'failed';
      break;
  }
  return next;
}

function transitionParticipant(
  participant: IveKitMediaCallParticipant,
  action: IveKitMediaCallAction,
  actor: string,
  now: Date
): IveKitMediaCallParticipant {
  const iso = now.toISOString();
  const next = { ...participant };
  if (action === 'ring' && participant.role !== 'host' && participant.status === 'invited') {
    next.status = 'ringing';
  } else if (action === 'accept' && participant.identity === actor) {
    next.status = 'accepted';
    next.accepted_at = iso;
  } else if (action === 'reject' && participant.identity === actor) {
    next.status = 'declined';
    next.left_at = iso;
  } else if (action === 'activate' && participant.status === 'accepted') {
    next.status = 'joined';
    next.joined_at = iso;
  } else if ((action === 'timeout' || action === 'cancel') && participant.role !== 'host') {
    if (participant.status === 'invited' || participant.status === 'ringing') {
      next.status = 'missed';
      next.left_at = iso;
    }
  } else if (action === 'end' || action === 'fail') {
    if (participant.status === 'joined' || participant.status === 'accepted') {
      next.status = 'left';
      next.left_at = iso;
    }
  }
  return next;
}

function assertActionAuthorized(
  action: IveKitMediaCallAction,
  actor: string,
  system: boolean,
  participants: IveKitMediaCallParticipant[]
): void {
  const participant = participants.find((item) => item.identity === actor);
  if (action === 'accept' || action === 'reject') {
    if (!participant || participant.role !== 'participant' ||
        (participant.status !== 'invited' && participant.status !== 'ringing')) {
      throw Object.assign(new Error('only an invited participant may accept or reject'), { status: 403 });
    }
    return;
  }
  if (system) return;
  if (!participant) throw Object.assign(new Error('active media call participant required'), { status: 403 });
  if (participant.role !== 'host') {
    throw Object.assign(new Error('media call host role required'), { status: 403 });
  }
}

export function assertMediaCallParticipantLimit(
  participantIdentities: readonly unknown[]
): void {
  if (participantIdentities.length > MAX_MEDIA_CALL_INVITEE_IDENTITIES) {
    throw badRequest(
      `participant_identities must contain at most ${MAX_MEDIA_CALL_INVITEE_IDENTITIES} entries`
    );
  }
}

function validatedBusinessRef(tenantId: string, ref: MediaBusinessRef): MediaBusinessRef {
  if (!ref || !String(ref.type || '').trim() || !String(ref.id || '').trim()) {
    throw badRequest('business_ref.type and business_ref.id are required');
  }
  if (ref.tenant_id && ref.tenant_id !== tenantId) throw badRequest('business_ref tenant mismatch');
  return {
    tenant_id: tenantId,
    type: ref.type.trim(),
    id: ref.id.trim(),
    display_name: String(ref.display_name || '').trim() || undefined,
    metadata: ref.metadata || {}
  };
}

function assertVoiceBridgeReplay(
  call: IveKitMediaCall,
  voiceCallId: string,
  businessRef: MediaBusinessRef
): void {
  if (call.media !== 'voice'
    || call.metadata.bridge_kind !== 'pstn'
    || call.metadata.voice_call_id !== voiceCallId
    || call.business_ref.type !== businessRef.type
    || call.business_ref.id !== businessRef.id) {
    throw conflict('voice bridge idempotency key was already used for another call');
  }
}

function requiredIdentity(value: string, name: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw badRequest(`${name} is required`);
  return normalized;
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
}

function notFound(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 404 });
}
