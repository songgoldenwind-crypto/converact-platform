import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactCenterError,
  ContactCenterQueueService,
  createContactCenterIvrQueuePort,
  type ContactCenterAgentPresence,
  type ContactCenterAssignment,
  type ContactCenterQueue,
  type ContactCenterQueueEntry,
  type ContactCenterRepository,
  type ContactCenterRoutingCandidate,
  type ContactCenterUnitOfWork
} from '../src/agent-runtime/ivekit/contact-center/index.js';

test('Contact Center enqueue is idempotent and rejects a changed payload', async () => {
  const fixture = setup();
  const first = await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 4,
    idempotency_key: 'enqueue-key'
  });
  const replay = await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 4,
    idempotency_key: 'enqueue-key'
  });
  assert.deepEqual(replay, first);
  assert.equal(first.position, 1);
  assert.equal(first.estimated_wait_seconds, 30);
  assert.equal(fixture.repository.entries.size, 1);
  fixture.repository.queue.status = 'disabled';
  assert.deepEqual(await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 4,
    idempotency_key: 'enqueue-key'
  }), first);
  await assert.rejects(
    () => fixture.service.enqueue({
      tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-b', priority: 4,
      idempotency_key: 'enqueue-key'
    }),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'conflict'
  );
});

test('Contact Center replays an existing offer after queue configuration changes', async () => {
  const fixture = setup();
  await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 0,
    idempotency_key: 'entry-key'
  });
  const offered = await fixture.service.offerNext({
    tenant_id: 'tenant-a', queue_id: 'queue-a', idempotency_key: 'offer-key', offer_ttl_seconds: 20
  });
  fixture.repository.queue.status = 'disabled';
  assert.deepEqual(await fixture.service.offerNext({
    tenant_id: 'tenant-a', queue_id: 'queue-a', idempotency_key: 'offer-key', offer_ttl_seconds: 20
  }), offered);
});

test('Contact Center enqueue fails closed when the queue is disabled or full', async () => {
  const fixture = setup({ max_size: 1 });
  await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 0,
    idempotency_key: 'key-a'
  });
  await assert.rejects(
    () => fixture.service.enqueue({
      tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-b', priority: 0,
      idempotency_key: 'key-b'
    }),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'capacity_exhausted'
  );
  fixture.repository.queue.status = 'disabled';
  await assert.rejects(
    () => fixture.service.enqueue({
      tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-c', priority: 0,
      idempotency_key: 'key-c'
    }),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'conflict'
  );
});

test('Contact Center ACD offer, reject, accept, connect, and complete converge atomically', async () => {
  const fixture = setup();
  const queued = await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 0,
    idempotency_key: 'entry-key'
  });
  const offered = await fixture.service.offerNext({
    tenant_id: 'tenant-a', queue_id: 'queue-a', idempotency_key: 'offer-key', offer_ttl_seconds: 20
  });
  assert.equal(offered?.entry.id, queued.entry.id);
  assert.equal(offered?.assignment.agent_id, 'agent-b');
  assert.equal(fixture.repository.entries.get(queued.entry.id)?.state, 'offered');
  assert.equal(fixture.repository.presences.get('agent-b')?.active_voice_count, 1);

  await fixture.service.rejectOffer({
    tenant_id: 'tenant-a', assignment_id: offered!.assignment.id, agent_id: 'agent-b', reason: 'declined'
  });
  assert.equal(fixture.repository.entries.get(queued.entry.id)?.state, 'waiting');
  assert.equal(fixture.repository.presences.get('agent-b')?.active_voice_count, 0);

  const second = await fixture.service.offerNext({
    tenant_id: 'tenant-a', queue_id: 'queue-a', idempotency_key: 'offer-key-2', offer_ttl_seconds: 20
  });
  assert.equal(second?.assignment.agent_id, 'agent-a');
  assert.equal(second?.assignment.attempt, 2);
  await fixture.service.acceptOffer({
    tenant_id: 'tenant-a', assignment_id: second!.assignment.id, agent_id: 'agent-a'
  });
  await fixture.service.connectAssignment({ tenant_id: 'tenant-a', assignment_id: second!.assignment.id });
  await fixture.service.completeAssignment({ tenant_id: 'tenant-a', assignment_id: second!.assignment.id });
  assert.equal(fixture.repository.entries.get(queued.entry.id)?.state, 'completed');
  assert.equal(fixture.repository.assignments.get(second!.assignment.id)?.state, 'completed');
  assert.equal(fixture.repository.presences.get('agent-a')?.state, 'after_call');
  assert.equal(fixture.repository.presences.get('agent-a')?.active_voice_count, 0);
  assert.equal(fixture.repository.entries.get(queued.entry.id)?.outcome_reason, '');
});

test('Contact Center rejects an offer action from the wrong agent', async () => {
  const fixture = setup();
  await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 0,
    idempotency_key: 'entry-key'
  });
  const offered = await fixture.service.offerNext({
    tenant_id: 'tenant-a', queue_id: 'queue-a', idempotency_key: 'offer-key', offer_ttl_seconds: 20
  });
  await assert.rejects(
    () => fixture.service.acceptOffer({
      tenant_id: 'tenant-a', assignment_id: offered!.assignment.id, agent_id: 'agent-a'
    }),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'not_found'
  );
  assert.equal(fixture.repository.assignments.get(offered!.assignment.id)?.state, 'offered');
});

test('Contact Center rejects acceptance after the offer deadline without mutating state', async () => {
  const fixture = setup();
  await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 0,
    idempotency_key: 'entry-key'
  });
  const offered = await fixture.service.offerNext({
    tenant_id: 'tenant-a', queue_id: 'queue-a', idempotency_key: 'offer-key', offer_ttl_seconds: 20
  });
  fixture.now = new Date('2026-07-13T00:00:21.000Z');
  await assert.rejects(
    () => fixture.service.acceptOffer({
      tenant_id: 'tenant-a', assignment_id: offered!.assignment.id,
      agent_id: offered!.assignment.agent_id
    }),
    (error: unknown) => error instanceof ContactCenterError && error.details.reason === 'offer_expired'
  );
  assert.equal(fixture.repository.assignments.get(offered!.assignment.id)?.state, 'offered');
  assert.equal(fixture.repository.entries.values().next().value?.state, 'offered');
});

test('Contact Center expires an unaccepted offer and releases its capacity slot', async () => {
  const fixture = setup();
  await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 0,
    idempotency_key: 'entry-key'
  });
  const offered = await fixture.service.offerNext({
    tenant_id: 'tenant-a', queue_id: 'queue-a', idempotency_key: 'offer-key', offer_ttl_seconds: 20
  });
  const expired = await fixture.service.expireOffers({ tenant_id: 'tenant-a', limit: 10 });
  assert.equal(expired, 0);
  fixture.now = new Date('2026-07-13T00:00:30.000Z');
  assert.equal(await fixture.service.expireOffers({ tenant_id: 'tenant-a', limit: 10 }), 1);
  assert.equal(fixture.repository.assignments.get(offered!.assignment.id)?.state, 'expired');
  assert.equal(fixture.repository.entries.values().next().value?.state, 'waiting');
  assert.equal(fixture.repository.presences.get(offered!.assignment.agent_id)?.active_voice_count, 0);
  assert.equal(fixture.repository.presences.get(offered!.assignment.agent_id)?.state, 'available');
});

test('Contact Center times out expired waiting entries and releases queue capacity', async () => {
  const fixture = setup({ max_size: 1 });
  const queued = await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 0,
    idempotency_key: 'entry-key'
  });
  fixture.now = new Date('2026-07-13T00:05:01.000Z');

  const timedOut = await fixture.service.timeoutWaitingEntries({
    tenant_id: 'tenant-a', limit: 10
  });

  assert.equal(timedOut.length, 1);
  assert.equal(timedOut[0]?.id, queued.entry.id);
  assert.equal(timedOut[0]?.state, 'timed_out');
  assert.equal(timedOut[0]?.ended_at, fixture.now.toISOString());
  assert.equal(timedOut[0]?.outcome_reason, 'max_wait_exceeded');
  assert.equal(await fixture.repository.countActiveEntries('tenant-a', 'queue-a'), 0);
  assert.deepEqual(await fixture.service.timeoutWaitingEntries({
    tenant_id: 'tenant-a', limit: 10
  }), []);
});

test('Contact Center exposes routable queues after expired offers are released', async () => {
  const fixture = setup();
  await fixture.service.enqueue({
    tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a', priority: 0,
    idempotency_key: 'entry-key'
  });
  await fixture.service.offerNext({
    tenant_id: 'tenant-a', queue_id: 'queue-a', idempotency_key: 'offer-key',
    offer_ttl_seconds: 20
  });
  fixture.now = new Date('2026-07-13T00:00:30.000Z');

  assert.equal(await fixture.service.expireOffers({ tenant_id: 'tenant-a', limit: 10 }), 1);
  assert.deepEqual(await fixture.service.listRoutableQueueIds({
    tenant_id: 'tenant-a', limit: 10
  }), ['queue-a']);
  const offered = await fixture.service.offerNext({
    tenant_id: 'tenant-a', queue_id: 'queue-a', idempotency_key: 'offer-key-2',
    offer_ttl_seconds: 20
  });
  assert.equal(offered?.assignment.attempt, 2);
});

test('Contact Center IVR queue port exposes only the stable enqueue result', async () => {
  const fixture = setup();
  const port = createContactCenterIvrQueuePort(fixture.service);
  const result = await port.enqueue({
    tenant_id: 'tenant-a', call_id: 'call-a', queue_id: 'queue-a', priority: 3,
    idempotency_key: 'ivr-key'
  });
  assert.equal(result.position, 1);
  assert.match(result.queue_entry_id, /^id-/);
});

class MemoryContactCenterRepository implements ContactCenterRepository {
  queue: ContactCenterQueue;
  readonly entries = new Map<string, ContactCenterQueueEntry>();
  readonly assignments = new Map<string, ContactCenterAssignment>();
  readonly presences = new Map<string, ContactCenterAgentPresence>();
  readonly candidates: ContactCenterRoutingCandidate[] = [];
  cursor: string | null = null;

  constructor(maxSize: number) {
    this.queue = {
      id: 'queue-a', tenant_id: 'tenant-a', name: 'Support', routing_strategy: 'round_robin',
      max_wait_seconds: 300, max_size: maxSize, callback_after_seconds: 120,
      overflow_action: 'none', overflow_queue_id: null, overflow_target: '', service_level_seconds: 20,
      status: 'active', metadata: {}, revision: 1,
      created_by: 'admin-a', updated_by: 'admin-a',
      created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
    };
    for (const agentId of ['agent-a', 'agent-b']) {
      const presence: ContactCenterAgentPresence = {
        tenant_id: 'tenant-a', agent_id: agentId, state: 'available', active_voice_count: 0,
        voice_capacity: 1, current_call_id: null, idle_since: '2026-07-13T00:00:00.000Z',
        heartbeat_at: '2026-07-13T00:00:00.000Z', session_ref: '', revision: 1,
        updated_at: '2026-07-13T00:00:00.000Z'
      };
      this.presences.set(agentId, presence);
      this.candidates.push({
        agent_id: agentId, presence_state: 'available', active_voice_count: 0, voice_capacity: 1,
        idle_since: presence.idle_since!, handled_count: 0, member_priority: 1, skills: {}
      });
    }
    this.cursor = 'agent-a';
  }

  async getQueue(_tenantId: string, queueId: string) { return queueId === this.queue.id ? structuredClone(this.queue) : null; }
  async findEntryByIdempotencyKey(_tenantId: string, key: string) {
    return structuredClone([...this.entries.values()].find((entry) => entry.idempotency_key === key) || null);
  }
  async countActiveEntries(_tenantId?: string, _queueId?: string) {
    return [...this.entries.values()].filter((entry) =>
      ['waiting', 'offered', 'assigned', 'answered'].includes(entry.state)
    ).length;
  }
  async insertEntry(entry: ContactCenterQueueEntry) { this.entries.set(entry.id, structuredClone(entry)); return structuredClone(entry); }
  async getEntry(_tenantId: string, id: string) { return structuredClone(this.entries.get(id) || null); }
  async getNextWaitingEntry() {
    return structuredClone([...this.entries.values()].filter((entry) => entry.state === 'waiting').sort((a, b) => b.priority - a.priority || a.entered_at.localeCompare(b.entered_at))[0] || null);
  }
  async updateEntry(entry: ContactCenterQueueEntry) {
    const next = { ...entry, revision: entry.revision + 1 };
    this.entries.set(entry.id, structuredClone(next));
    return structuredClone(next);
  }
  async positionOfEntry(_tenantId: string, _queueId: string, id: string) {
    return [...this.entries.values()].filter((entry) => ['waiting', 'offered'].includes(entry.state)).sort((a, b) => b.priority - a.priority || a.entered_at.localeCompare(b.entered_at)).findIndex((entry) => entry.id === id) + 1;
  }
  async averageHandleSeconds() { return 60; }
  async listRoutingCandidates() {
    return this.candidates.map((candidate) => {
      const presence = this.presences.get(candidate.agent_id)!;
      return { ...candidate, presence_state: presence.state, active_voice_count: presence.active_voice_count };
    });
  }
  async getRoutingCursor() { return this.cursor; }
  async setRoutingCursor(_tenantId: string, _queueId: string, agentId: string) { this.cursor = agentId; }
  async nextCapacitySlot(_tenantId: string, agentId: string) {
    const presence = this.presences.get(agentId)!;
    return presence.active_voice_count < presence.voice_capacity ? presence.active_voice_count + 1 : null;
  }
  async nextAssignmentAttempt(_tenantId: string, entryId: string) {
    return [...this.assignments.values()].filter((value) => value.queue_entry_id === entryId).length + 1;
  }
  async insertAssignment(value: ContactCenterAssignment) { this.assignments.set(value.id, structuredClone(value)); return structuredClone(value); }
  async findAssignmentByIdempotencyKey(_tenantId: string, key: string) {
    return structuredClone([...this.assignments.values()].find((value) => value.idempotency_key === key) || null);
  }
  async getAssignment(_tenantId: string, id: string) { return structuredClone(this.assignments.get(id) || null); }
  async updateAssignment(value: ContactCenterAssignment) {
    const next = { ...value, revision: value.revision + 1 };
    this.assignments.set(value.id, structuredClone(next));
    return structuredClone(next);
  }
  async getPresence(_tenantId: string, agentId: string) { return structuredClone(this.presences.get(agentId) || null); }
  async updatePresence(value: ContactCenterAgentPresence) {
    const next = { ...value, revision: value.revision + 1 };
    this.presences.set(value.agent_id, structuredClone(next));
    return structuredClone(next);
  }
  async listExpiredOffers(_tenantId: string, now: Date, limit: number) {
    return [...this.assignments.values()]
      .filter((value) => value.state === 'offered' && value.offer_expires_at <= now.toISOString())
      .slice(0, limit)
      .map((value) => structuredClone(value));
  }
  async listExpiredWaitingEntries(_tenantId: string, now: Date, limit: number) {
    return [...this.entries.values()]
      .filter((entry) => entry.state === 'waiting' && Boolean(entry.timeout_at) &&
        entry.timeout_at! <= now.toISOString())
      .sort((left, right) => left.timeout_at!.localeCompare(right.timeout_at!) ||
        left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }
  async listRoutableQueueIds(_tenantId: string, now: Date, limit: number) {
    const hasWaiting = [...this.entries.values()].some((entry) =>
      entry.queue_id === this.queue.id && entry.state === 'waiting' &&
      (!entry.timeout_at || entry.timeout_at > now.toISOString())
    );
    return hasWaiting && this.queue.status === 'active' ? [this.queue.id].slice(0, limit) : [];
  }
}

function setup(input: { max_size?: number } = {}) {
  const repository = new MemoryContactCenterRepository(input.max_size ?? 10);
  const unitOfWork: ContactCenterUnitOfWork = { run: async (_tenantId, operation) => operation({ repository }) };
  let id = 0;
  const fixture = {
    now: new Date('2026-07-13T00:00:00.000Z'),
    repository,
    service: null as unknown as ContactCenterQueueService
  };
  fixture.service = new ContactCenterQueueService(unitOfWork, {
    id: () => `id-${++id}`,
    now: () => fixture.now
  });
  return fixture;
}
