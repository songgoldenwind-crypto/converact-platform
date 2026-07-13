import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactCenterCallbackService,
  ContactCenterError,
  type ContactCenterAgentPresence,
  type ContactCenterAssignment,
  type ContactCenterCallbackRecord,
  type ContactCenterQueue,
  type ContactCenterQueueEntry,
  type ContactCenterRepository,
  type ContactCenterUnitOfWork
} from '../src/agent-runtime/ivekit/contact-center/index.js';

test('Contact Center callback request encrypts the target and leaves the waiting queue atomically', async () => {
  const fixture = setup();
  const created = await fixture.service.request({
    tenant_id: 'tenant-a', queue_entry_id: 'entry-a', source_call_id: 'call-a',
    address: { kind: 'e164', value: '+8613900139000' },
    scheduled_for: '2026-07-13T00:05:00.000Z', max_attempts: 4,
    actor: 'agent-a',
    idempotency_key: 'callback-key-a'
  });

  assert.equal(created.callback.state, 'scheduled');
  assert.deepEqual(created.callback.address, { kind: 'e164', redacted: '+86******9000' });
  assert.deepEqual(created.callback.business_ref, { type: 'ticket', id: 'ticket-a' });
  assert.equal(fixture.entry.state, 'callback_requested');
  assert.equal(fixture.entry.outcome_reason, 'callback_requested');
  assert.equal(fixture.persisted?.address_ciphertext, 'cipher:+8613900139000');
  assert.equal(fixture.persisted?.requested_by, 'agent-a');
  assert.equal(JSON.stringify(created).includes('+8613900139000'), false);

  const replay = await fixture.service.request({
    tenant_id: 'tenant-a', queue_entry_id: 'entry-a', source_call_id: 'call-a',
    address: { kind: 'e164', value: '+8613900139000' },
    scheduled_for: '2026-07-13T00:05:00.000Z', max_attempts: 4,
    actor: 'agent-a',
    idempotency_key: 'callback-key-a'
  });
  assert.equal(replay.callback.id, created.callback.id);
  assert.equal(replay.replayed, true);

  await assert.rejects(() => fixture.service.request({
    tenant_id: 'tenant-a', queue_entry_id: 'entry-a', source_call_id: 'call-a',
    address: { kind: 'e164', value: '+8613800138000' },
    scheduled_for: '2026-07-13T00:05:00.000Z', max_attempts: 4,
    actor: 'agent-a',
    idempotency_key: 'callback-key-a'
  }), hasCode('idempotency_conflict'));
});

test('Contact Center callback request revokes an outstanding offer and releases agent capacity', async () => {
  const fixture = setup({ offered: true });
  await fixture.service.request({
    tenant_id: 'tenant-a', queue_entry_id: 'entry-a', source_call_id: 'call-a',
    address: { kind: 'e164', value: '+8613900139000' },
    actor: 'agent-a',
    idempotency_key: 'callback-key-a'
  });
  assert.equal(fixture.assignment?.state, 'revoked');
  assert.equal(fixture.assignment?.outcome_reason, 'callback_requested');
  assert.equal(fixture.presence.state, 'available');
  assert.equal(fixture.presence.active_voice_count, 0);
  assert.equal(fixture.presence.current_call_id, null);
});

test('Contact Center callback rejects a source call outside the queue entry and cancels before dialing', async () => {
  const fixture = setup();
  await assert.rejects(() => fixture.service.request({
    tenant_id: 'tenant-a', queue_entry_id: 'entry-a', source_call_id: 'call-b',
    address: { kind: 'e164', value: '+8613900139000' },
    actor: 'agent-a',
    idempotency_key: 'callback-key-a'
  }), hasCode('conflict'));

  const created = await fixture.service.request({
    tenant_id: 'tenant-a', queue_entry_id: 'entry-a', source_call_id: 'call-a',
    address: { kind: 'e164', value: '+8613900139000' },
    actor: 'agent-a',
    idempotency_key: 'callback-key-a'
  });
  const cancelled = await fixture.service.cancel({
    tenant_id: 'tenant-a', callback_id: created.callback.id,
    actor: 'agent-a', reason: 'customer_changed_mind'
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.failure_code, 'customer_changed_mind');
  assert.equal(cancelled.cancelled_by, 'agent-a');
  assert.equal(cancelled.completed_at, '2026-07-13T00:00:00.000Z');
});

test('Contact Center callback starts a due durable Voice call and reconciles its lifecycle', async () => {
  const fixture = setup();
  await fixture.service.request({
    tenant_id: 'tenant-a', queue_entry_id: 'entry-a', source_call_id: 'call-a',
    address: { kind: 'e164', value: '+8613900139000' },
    actor: 'agent-a',
    idempotency_key: 'callback-key-a'
  });
  const processed = await fixture.service.processDue({
    tenant_id: 'tenant-a', limit: 10, retry_delay_ms: 30_000
  });
  assert.deepEqual(processed, { processed: 1, started: 1, retried: 0, failed: 0 });
  assert.equal(fixture.persisted?.state, 'dialing');
  assert.equal(fixture.persisted?.outbound_call_id, 'outbound-a');
  assert.equal(fixture.persisted?.attempt_count, 1);
  assert.deepEqual(fixture.outboundCalls, [{
    callback_id: 'callback-a', clear_target: '+8613900139000', attempt: 1
  }]);

  fixture.setCallState('active');
  assert.equal((await fixture.service.reconcile({ tenant_id: 'tenant-a', limit: 10 })).updated, 1);
  assert.equal(fixture.persisted?.state, 'connected');
  fixture.setCallState('completed');
  fixture.setNow('2026-07-13T00:10:00.000Z');
  assert.equal((await fixture.service.reconcile({ tenant_id: 'tenant-a', limit: 10 })).updated, 1);
  assert.equal(fixture.persisted?.state, 'completed');
  assert.equal(fixture.persisted?.completed_at, '2026-07-13T00:10:00.000Z');
});

test('Contact Center callback retries retryable Voice failures and stops at max attempts', async () => {
  const retryable = Object.assign(new Error('voice secrets unavailable'), { retryable: true, code: 'secret_unavailable' });
  const fixture = setup({ voiceError: retryable });
  await fixture.service.request({
    tenant_id: 'tenant-a', queue_entry_id: 'entry-a', source_call_id: 'call-a',
    address: { kind: 'e164', value: '+8613900139000' }, max_attempts: 2,
    actor: 'agent-a',
    idempotency_key: 'callback-key-a'
  });
  const first = await fixture.service.processDue({
    tenant_id: 'tenant-a', limit: 10, retry_delay_ms: 30_000
  });
  assert.deepEqual(first, { processed: 1, started: 0, retried: 1, failed: 0 });
  assert.equal(fixture.persisted?.state, 'scheduled');
  assert.equal(fixture.persisted?.scheduled_for, '2026-07-13T00:00:30.000Z');

  fixture.setNow('2026-07-13T00:00:30.000Z');
  const second = await fixture.service.processDue({
    tenant_id: 'tenant-a', limit: 10, retry_delay_ms: 30_000
  });
  assert.deepEqual(second, { processed: 1, started: 0, retried: 0, failed: 1 });
  assert.equal(fixture.persisted?.state, 'failed');
  assert.equal(fixture.persisted?.failure_code, 'secret_unavailable');
});

function setup(input: { offered?: boolean; voiceError?: Error & { retryable?: boolean; code?: string } } = {}) {
  const queue: ContactCenterQueue = {
    id: 'queue-a', tenant_id: 'tenant-a', name: 'Support', routing_strategy: 'longest_idle',
    max_wait_seconds: 300, max_size: 100, callback_after_seconds: 120,
    overflow_action: 'none', overflow_queue_id: null, overflow_target: '', service_level_seconds: 20,
    status: 'active', metadata: {}, revision: 1, created_by: 'admin-a', updated_by: 'admin-a',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
  let entry: ContactCenterQueueEntry = {
    id: 'entry-a', tenant_id: 'tenant-a', queue_id: 'queue-a', call_id: 'call-a',
    state: input.offered ? 'offered' : 'waiting', priority: 0,
    idempotency_key: 'entry-key', payload_hash: 'a'.repeat(64),
    entered_at: '2026-07-13T00:00:00.000Z', offered_at: input.offered ? '2026-07-13T00:00:00.000Z' : null,
    assigned_at: null, answered_at: null, ended_at: null,
    timeout_at: '2026-07-13T00:05:00.000Z', outcome_reason: '', metadata: {}, revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
  let assignment: ContactCenterAssignment | null = input.offered ? {
    id: 'assignment-a', tenant_id: 'tenant-a', queue_entry_id: 'entry-a', agent_id: 'agent-a',
    capacity_slot: 1, state: 'offered', attempt: 1, idempotency_key: 'offer-key',
    offer_expires_at: '2026-07-13T00:00:20.000Z', accepted_at: null, connected_at: null,
    completed_at: null, outcome_reason: '', revision: 1,
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  } : null;
  let presence: ContactCenterAgentPresence = {
    tenant_id: 'tenant-a', agent_id: 'agent-a', state: input.offered ? 'busy' : 'available',
    active_voice_count: input.offered ? 1 : 0, voice_capacity: 1,
    current_call_id: input.offered ? 'call-a' : null,
    idle_since: input.offered ? null : '2026-07-13T00:00:00.000Z', heartbeat_at: null,
    session_ref: '', revision: 1, updated_at: '2026-07-13T00:00:00.000Z'
  };
  let persisted: ContactCenterCallbackRecord | null = null;
  let currentTime = new Date('2026-07-13T00:00:00.000Z');
  let callState = 'dialing';
  const outboundCalls: Array<Record<string, unknown>> = [];
  const repository = {
    async getQueue() { return structuredClone(queue); },
    async getEntry() { return structuredClone(entry); },
    async updateEntry(value: ContactCenterQueueEntry) {
      entry = { ...structuredClone(value), revision: value.revision + 1 };
      return structuredClone(entry);
    },
    async getActiveAssignmentForEntry() { return structuredClone(assignment); },
    async updateAssignment(value: ContactCenterAssignment) {
      assignment = { ...structuredClone(value), revision: value.revision + 1 };
      return structuredClone(assignment);
    },
    async getPresence() { return structuredClone(presence); },
    async updatePresence(value: ContactCenterAgentPresence) {
      presence = { ...structuredClone(value), revision: value.revision + 1 };
      return structuredClone(presence);
    },
    async findCallbackByIdempotencyKey(_tenantId: string, key: string) {
      return persisted?.idempotency_key === key ? structuredClone(persisted) : null;
    },
    async insertCallback(value: ContactCenterCallbackRecord) {
      persisted = structuredClone(value);
      return structuredClone(value);
    },
    async getCallback(_tenantId: string, id: string) {
      return persisted?.id === id ? structuredClone(persisted) : null;
    },
    async updateCallback(value: ContactCenterCallbackRecord) {
      persisted = { ...structuredClone(value), revision: value.revision + 1 };
      return structuredClone(persisted);
    },
    async getNextDueCallback(_tenantId: string, now: Date) {
      return persisted && ['requested', 'scheduled'].includes(persisted.state) &&
        (!persisted.scheduled_for || persisted.scheduled_for <= now.toISOString())
        ? structuredClone(persisted) : null;
    },
    async listCallbacksForReconciliation() {
      return persisted && ['dialing', 'connected'].includes(persisted.state) && persisted.outbound_call_id
        ? [structuredClone(persisted)] : [];
    }
  } as unknown as ContactCenterRepository;
  const unitOfWork: ContactCenterUnitOfWork = {
    run: async (_tenantId, operation) => operation({ repository })
  };
  const service = new ContactCenterCallbackService({
    unit_of_work: unitOfWork,
    address_protector: {
      async protect(_tenantId, value, kind) {
        return { ciphertext: `cipher:${value}`, hmac: `${kind}:${value}`.padEnd(64, '0').slice(0, 64), redacted: '+86******9000' };
      },
      async reveal(_tenantId, ciphertext) {
        return String(ciphertext).replace(/^cipher:/, '');
      }
    },
    voice: {
      async getSourceCall(tenantId, callId) {
        return {
          id: callId, tenant_id: tenantId, profile_id: 'profile-a', direction: 'inbound' as const,
          business_ref: { type: 'ticket', id: 'ticket-a' }
        };
      },
      async createOutbound(callInput) {
        outboundCalls.push({
          callback_id: callInput.callback.id,
          clear_target: callInput.clear_target,
          attempt: callInput.attempt
        });
        if (input.voiceError) throw input.voiceError;
        return { call_id: 'outbound-a' };
      },
      async getCallState() { return { state: callState, termination_reason: '' }; }
    },
    id: () => 'callback-a',
    now: () => currentTime
  });
  return {
    service,
    get entry() { return entry; },
    get assignment() { return assignment; },
    get presence() { return presence; },
    get persisted() { return persisted; },
    outboundCalls,
    setNow(value: string) { currentTime = new Date(value); },
    setCallState(value: string) { callState = value; }
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ContactCenterError && error.code === code;
}
