import { randomUUID } from 'node:crypto';

import { canonicalContactCenterPayloadHash } from './canonical.js';
import { ContactCenterError } from './errors.js';
import type { ContactCenterRepository, ContactCenterUnitOfWork } from './ports.js';
import { estimateQueueWaitSeconds, rankContactCenterAgents } from './routing.js';
import {
  canAcceptVoiceWork,
  transitionAssignment,
  transitionPresence,
  transitionQueueEntry
} from './state-machine.js';
import type {
  ContactCenterAgentPresence,
  ContactCenterAssignment,
  ContactCenterPage,
  ContactCenterQueueEntry,
  ContactCenterQueueEntryListInput,
  ContactCenterQueueEntrySnapshot,
  ContactCenterQueueEntryState
} from './types.js';

export interface ContactCenterEnqueueResult {
  entry: ContactCenterQueueEntry;
  position: number | null;
  estimated_wait_seconds: number;
}

export interface ContactCenterOfferResult {
  entry: ContactCenterQueueEntry;
  assignment: ContactCenterAssignment;
}

export class ContactCenterQueueService {
  readonly #unitOfWork: ContactCenterUnitOfWork;
  readonly #id: () => string;
  readonly #now: () => Date;

  constructor(
    unitOfWork: ContactCenterUnitOfWork,
    options: { id?: () => string; now?: () => Date } = {}
  ) {
    this.#unitOfWork = unitOfWork;
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  enqueue(input: {
    tenant_id: string;
    queue_id: string;
    call_id: string;
    priority: number;
    idempotency_key: string;
  }): Promise<ContactCenterEnqueueResult> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const queueId = identifier(input.queue_id, 'queue_id');
    const callId = identifier(input.call_id, 'call_id');
    const idempotencyKey = idempotency(input.idempotency_key);
    const priority = integer(input.priority, -100, 100, 'priority');
    const payloadHash = canonicalContactCenterPayloadHash({ queue_id: queueId, call_id: callId, priority });
    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const queue = required(await repository.getQueue(tenantId, queueId, { for_update: true }), 'queue');
      const replay = await repository.findEntryByIdempotencyKey(tenantId, idempotencyKey);
      if (replay) {
        if (replay.payload_hash !== payloadHash) throw conflict('idempotency_conflict');
        return this.#enqueueResult(repository, replay);
      }
      if (queue.status !== 'active') throw conflict('queue_not_active');
      if (await repository.countActiveEntries(tenantId, queueId) >= queue.max_size) {
        throw new ContactCenterError({ code: 'capacity_exhausted', details: { queue_id: queueId } });
      }
      const now = this.#now();
      const timestamp = now.toISOString();
      const entry = await repository.insertEntry({
        id: this.#id(), tenant_id: tenantId, queue_id: queueId, call_id: callId,
        state: 'waiting', priority, idempotency_key: idempotencyKey, payload_hash: payloadHash,
        entered_at: timestamp, offered_at: null, assigned_at: null, answered_at: null,
        ended_at: null, timeout_at: new Date(now.getTime() + queue.max_wait_seconds * 1_000).toISOString(),
        outcome_reason: '', metadata: {}, revision: 1, created_at: timestamp, updated_at: timestamp
      });
      return this.#enqueueResult(repository, entry);
    });
  }

  offerNext(input: {
    tenant_id: string;
    queue_id: string;
    idempotency_key: string;
    offer_ttl_seconds: number;
  }): Promise<ContactCenterOfferResult | null> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const queueId = identifier(input.queue_id, 'queue_id');
    const idempotencyKey = idempotency(input.idempotency_key);
    const ttl = integer(input.offer_ttl_seconds, 1, 300, 'offer_ttl_seconds');
    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const queue = required(await repository.getQueue(tenantId, queueId, { for_update: true }), 'queue');
      const replay = await repository.findAssignmentByIdempotencyKey(tenantId, idempotencyKey);
      if (replay) {
        const entry = required(await repository.getEntry(tenantId, replay.queue_entry_id), 'queue_entry');
        if (entry.queue_id !== queueId) throw conflict('idempotency_conflict');
        return { entry, assignment: replay };
      }
      if (queue.status !== 'active') throw conflict('queue_not_active');
      const entry = await repository.getNextWaitingEntry(tenantId, queueId);
      if (!entry) return null;
      const cursor = await repository.getRoutingCursor(tenantId, queueId);
      const candidates = rankContactCenterAgents(
        await repository.listRoutingCandidates(tenantId, queueId),
        { strategy: queue.routing_strategy, round_robin_after: cursor ?? undefined }
      );
      const selected = candidates[0];
      if (!selected) return null;
      const presence = required(
        await repository.getPresence(tenantId, selected.agent_id, { for_update: true }),
        'agent_presence'
      );
      if (!canAcceptVoiceWork(presence)) return null;
      const slot = await repository.nextCapacitySlot(tenantId, selected.agent_id);
      if (slot === null) return null;
      const now = this.#now();
      const timestamp = now.toISOString();
      const attempt = await repository.nextAssignmentAttempt(tenantId, entry.id);
      const assignment = await repository.insertAssignment({
        id: this.#id(), tenant_id: tenantId, queue_entry_id: entry.id,
        agent_id: selected.agent_id, capacity_slot: slot, state: 'offered', attempt,
        idempotency_key: idempotencyKey,
        offer_expires_at: new Date(now.getTime() + ttl * 1_000).toISOString(),
        accepted_at: null, connected_at: null, completed_at: null, outcome_reason: '',
        revision: 1, created_at: timestamp, updated_at: timestamp
      });
      const nextEntry = await repository.updateEntry({
        ...entry, state: transitionQueueEntry(entry.state, 'offer'), offered_at: timestamp,
        outcome_reason: '', updated_at: timestamp
      }, entry.revision);
      await repository.updatePresence({
        ...presence,
        state: transitionPresence(presence.state, 'reserve'),
        active_voice_count: presence.active_voice_count + 1,
        current_call_id: entry.call_id,
        idle_since: null,
        updated_at: timestamp
      }, presence.revision);
      await repository.setRoutingCursor(tenantId, queueId, selected.agent_id);
      return { entry: nextEntry, assignment };
    });
  }

  acceptOffer(input: { tenant_id: string; assignment_id: string; agent_id: string }): Promise<ContactCenterOfferResult> {
    return this.#changeAssignment({ ...input, event: 'accept' });
  }

  rejectOffer(input: {
    tenant_id: string;
    assignment_id: string;
    agent_id: string;
    reason?: string;
  }): Promise<ContactCenterOfferResult> {
    return this.#changeAssignment({ ...input, event: 'reject', reason: input.reason });
  }

  connectAssignment(input: { tenant_id: string; assignment_id: string; agent_id?: string }): Promise<ContactCenterOfferResult> {
    return this.#changeAssignment({ ...input, event: 'connect' });
  }

  completeAssignment(input: { tenant_id: string; assignment_id: string; agent_id?: string }): Promise<ContactCenterOfferResult> {
    return this.#changeAssignment({ ...input, event: 'complete' });
  }

  expireOffers(input: { tenant_id: string; limit: number }): Promise<number> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const limit = integer(input.limit, 1, 1_000, 'limit');
    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const assignments = await repository.listExpiredOffers(tenantId, this.#now(), limit);
      for (const assignment of assignments) {
        await this.#changeAssignmentInRepository(repository, assignment, 'expire');
      }
      return assignments.length;
    });
  }

  timeoutWaitingEntries(input: {
    tenant_id: string;
    limit: number;
  }): Promise<ContactCenterQueueEntry[]> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const limit = integer(input.limit, 1, 1_000, 'limit');
    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const entries = await repository.listExpiredWaitingEntries(tenantId, this.#now(), limit);
      const now = this.#now().toISOString();
      const timedOut: ContactCenterQueueEntry[] = [];
      for (const entry of entries) {
        timedOut.push(await repository.updateEntry({
          ...entry,
          state: transitionQueueEntry(entry.state, 'timeout'),
          ended_at: now,
          outcome_reason: 'max_wait_exceeded',
          updated_at: now
        }, entry.revision));
      }
      return timedOut;
    });
  }

  listRoutableQueueIds(input: { tenant_id: string; limit: number }): Promise<string[]> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const limit = integer(input.limit, 1, 1_000, 'limit');
    return this.#unitOfWork.run(tenantId, ({ repository }) =>
      repository.listRoutableQueueIds(tenantId, this.#now(), limit)
    );
  }

  listQueueEntries(
    input: ContactCenterQueueEntryListInput
  ): Promise<ContactCenterPage<ContactCenterQueueEntrySnapshot>> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const queueId = identifier(input.queue_id, 'queue_id');
    const limit = integer(input.limit ?? 50, 1, 200, 'limit');
    const state = input.state === undefined ? undefined : queueEntryState(input.state);
    const cursor = input.cursor === undefined ? undefined : boundedCursor(input.cursor);
    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      required(await repository.getQueue(tenantId, queueId), 'queue');
      const page = await repository.listEntries({
        tenant_id: tenantId,
        queue_id: queueId,
        limit,
        ...(state ? { state } : {}),
        ...(cursor ? { cursor } : {})
      });
      const assignments = await repository.listAssignmentsForEntries(
        tenantId,
        page.items.map((entry) => entry.id)
      );
      const byEntry = new Map<string, ContactCenterAssignment[]>();
      for (const assignment of assignments) {
        const history = byEntry.get(assignment.queue_entry_id) ?? [];
        history.push(assignment);
        byEntry.set(assignment.queue_entry_id, history);
      }
      return {
        items: page.items.map((entry) => ({
          entry,
          assignments: byEntry.get(entry.id) ?? []
        })),
        next_cursor: page.next_cursor
      };
    });
  }

  async #changeAssignment(input: {
    tenant_id: string;
    assignment_id: string;
    agent_id?: string;
    event: 'accept' | 'reject' | 'connect' | 'complete';
    reason?: string;
  }): Promise<ContactCenterOfferResult> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const assignmentId = identifier(input.assignment_id, 'assignment_id');
    const agentId = input.agent_id === undefined ? undefined : identifier(input.agent_id, 'agent_id');
    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const assignment = required(
        await repository.getAssignment(tenantId, assignmentId, { for_update: true }),
        'assignment'
      );
      if (agentId && assignment.agent_id !== agentId) throw new ContactCenterError({ code: 'not_found', status: 404 });
      if (input.event === 'accept' && assignment.offer_expires_at <= this.#now().toISOString()) {
        throw conflict('offer_expired');
      }
      return this.#changeAssignmentInRepository(repository, assignment, input.event, input.reason);
    });
  }

  async #changeAssignmentInRepository(
    repository: ContactCenterRepository,
    assignment: ContactCenterAssignment,
    event: 'accept' | 'reject' | 'expire' | 'connect' | 'complete',
    reason = ''
  ): Promise<ContactCenterOfferResult> {
    const entry = required(
      await repository.getEntry(assignment.tenant_id, assignment.queue_entry_id, { for_update: true }),
      'queue_entry'
    );
    const presence = required(
      await repository.getPresence(assignment.tenant_id, assignment.agent_id, { for_update: true }),
      'agent_presence'
    );
    const now = this.#now().toISOString();
    const nextAssignment = await repository.updateAssignment({
      ...assignment,
      state: transitionAssignment(assignment.state, event),
      accepted_at: event === 'accept' ? now : assignment.accepted_at,
      connected_at: event === 'connect' ? now : assignment.connected_at,
      completed_at: event === 'complete' ? now : assignment.completed_at,
      outcome_reason: reason || assignment.outcome_reason,
      updated_at: now
    }, assignment.revision);
    const queueEvent = event === 'accept' ? 'accept' : event === 'connect' ? 'answer' :
      event === 'complete' ? 'complete' : event;
    const nextEntry = await repository.updateEntry({
      ...entry,
      state: transitionQueueEntry(entry.state, queueEvent),
      assigned_at: event === 'accept' ? now : entry.assigned_at,
      answered_at: event === 'connect' ? now : entry.answered_at,
      ended_at: event === 'complete' ? now : entry.ended_at,
      outcome_reason: reason || entry.outcome_reason,
      updated_at: now
    }, entry.revision);
    if (event === 'reject' || event === 'expire' || event === 'complete') {
      const activeCount = Math.max(0, presence.active_voice_count - 1);
      const releaseEvent = event === 'complete' ? 'wrap_up' : 'release';
      await repository.updatePresence({
        ...presence,
        state: activeCount > 0 ? 'busy' : transitionPresence(presence.state, releaseEvent),
        active_voice_count: activeCount,
        current_call_id: activeCount > 0 ? presence.current_call_id : null,
        idle_since: activeCount > 0 ? null : now,
        updated_at: now
      }, presence.revision);
    }
    return { entry: nextEntry, assignment: nextAssignment };
  }

  async #enqueueResult(
    repository: ContactCenterRepository,
    entry: ContactCenterQueueEntry
  ): Promise<ContactCenterEnqueueResult> {
    const position = await repository.positionOfEntry(entry.tenant_id, entry.queue_id, entry.id);
    const candidates = await repository.listRoutingCandidates(entry.tenant_id, entry.queue_id);
    const capacity = candidates.reduce((total, candidate) => total + (
      canAcceptVoiceWork({
        state: candidate.presence_state,
        active_voice_count: candidate.active_voice_count,
        voice_capacity: candidate.voice_capacity
      }) ? candidate.voice_capacity - candidate.active_voice_count : 0
    ), 0);
    return {
      entry,
      position,
      estimated_wait_seconds: estimateQueueWaitSeconds({
        position: position || 1,
        average_handle_seconds: await repository.averageHandleSeconds(entry.tenant_id, entry.queue_id),
        available_agents: capacity
      })
    };
  }
}

function required<T>(value: T | null, resource: string): T {
  if (!value) throw new ContactCenterError({ code: 'not_found', status: 404, details: { resource } });
  return value;
}

function identifier(value: unknown, field: string): string {
  const output = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(output)) {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, details: { field } });
  }
  return output;
}

function idempotency(value: unknown): string {
  const output = String(value ?? '').trim();
  if (!/^[\x21-\x7e]{1,200}$/.test(output)) {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, details: { field: 'idempotency_key' } });
  }
  return output;
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  const output = Number(value);
  if (!Number.isInteger(output) || output < minimum || output > maximum) {
    throw new ContactCenterError({ code: 'validation_failed', status: 422, details: { field } });
  }
  return output;
}

function queueEntryState(value: unknown): ContactCenterQueueEntryState {
  const states: ContactCenterQueueEntryState[] = [
    'waiting', 'offered', 'assigned', 'answered', 'completed', 'abandoned',
    'timed_out', 'cancelled', 'overflowed', 'callback_requested'
  ];
  if (!states.includes(value as ContactCenterQueueEntryState)) {
    throw new ContactCenterError({
      code: 'validation_failed', status: 422, details: { field: 'state' }
    });
  }
  return value as ContactCenterQueueEntryState;
}

function boundedCursor(value: unknown): string {
  const cursor = typeof value === 'string' ? value : '';
  if (!cursor || cursor.length > 2_000 || /[\u0000-\u001f\u007f]/.test(cursor)) {
    throw new ContactCenterError({
      code: 'validation_failed', status: 422, details: { field: 'cursor' }
    });
  }
  return cursor;
}

function conflict(reason: string): ContactCenterError {
  return new ContactCenterError({ code: 'conflict', details: { reason } });
}
