import { createHash } from 'node:crypto';

import { MemoryPg } from '../../db-pg.js';
import { MediaCallStore } from './media-call-store.js';
import type {
  IveKitMediaCall,
  IveKitMediaCallAction,
  IveKitMediaCallParticipant,
  IveKitMediaCallSnapshot,
  MediaBusinessRef
} from './types.js';

export const ALLOWED_MEDIA_CALL_ACTIONS = {
  created: ['ring', 'cancel', 'fail'],
  ringing: ['accept', 'reject', 'cancel', 'timeout', 'fail'],
  accepted: ['activate', 'end', 'fail'],
  active: ['end', 'fail'],
  rejected: [],
  cancelled: [],
  timed_out: [],
  ended: [],
  failed: []
} as const satisfies Record<IveKitMediaCall['status'], readonly IveKitMediaCallAction[]>;

const memoryCallLockTails = new WeakMap<MemoryPg, Map<string, Promise<void>>>();

export interface MediaCallTransitionResult {
  snapshot: IveKitMediaCallSnapshot;
  replayed: boolean;
}

export class MediaCallService {
  constructor(private readonly store: MediaCallStore) {}

  createCall(input: {
    tenant_id: string;
    initiated_by: string;
    media: 'voice' | 'video';
    participant_identities: string[];
    business_ref: MediaBusinessRef;
    title?: string;
    metadata?: Record<string, unknown>;
    ring_timeout_seconds?: number;
  }): Promise<IveKitMediaCallSnapshot> {
    const actor = requiredIdentity(input.initiated_by, 'initiated_by');
    const businessRef = validatedBusinessRef(input.tenant_id, input.business_ref);
    if (input.media !== 'voice' && input.media !== 'video') throw badRequest('media must be voice or video');
    const ringTimeoutSeconds = input.ring_timeout_seconds ?? 30;
    if (!Number.isInteger(ringTimeoutSeconds) || ringTimeoutSeconds < 5 || ringTimeoutSeconds > 300) {
      throw badRequest('ring_timeout_seconds must be an integer between 5 and 300');
    }
    const invitees = [...new Set(input.participant_identities.map((identity) => identity.trim()))]
      .filter((identity) => identity && identity !== actor);
    return this.store.transaction(async (store) => {
      const call = await store.insertCall({
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
      return (await store.snapshot(input.tenant_id, call.id))!;
    });
  }

  getCall(tenantId: string, callId: string): Promise<IveKitMediaCallSnapshot | null> {
    return this.store.snapshot(tenantId, callId);
  }

  listParticipants(tenantId: string, callId: string): Promise<IveKitMediaCallParticipant[]> {
    return this.store.listParticipants(tenantId, callId);
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

  transition(input: {
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

    return this.withMemoryLock(`idempotency\u0000${input.tenant_id}\u0000${idempotencyKey}`, () =>
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

        const fromStatus = call.status;
        const now = new Date();
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
        return { snapshot, replayed: false };
        })
      )
    );
  }

  private withCallLock<T>(tenantId: string, callId: string, fn: () => Promise<T>): Promise<T> {
    return this.withMemoryLock(`call\u0000${tenantId}\u0000${callId}`, fn);
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
      next.status = 'accepted';
      next.accepted_at = iso;
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
    if (!participant || participant.role !== 'participant') {
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
