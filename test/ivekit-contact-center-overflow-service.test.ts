import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactCenterOverflowService,
  type ContactCenterOverflowAction,
  type ContactCenterRepository,
  type ContactCenterUnitOfWork
} from '../src/agent-runtime/converact/contact-center/index.js';

test('Contact Center overflow moves a call into the configured queue idempotently', async () => {
  const fixture = setup(overflowAction({ action: 'queue', target_queue_id: 'queue-b' }));
  const summary = await fixture.service.processDue({
    tenant_id: 'tenant-a', limit: 10, retry_delay_ms: 5_000
  });
  assert.deepEqual(summary, { processed: 1, completed: 1, retried: 0, failed: 0 });
  assert.equal(fixture.persistedAction.state, 'completed');
  assert.equal(fixture.persistedAction.result_ref, 'entry-overflow-a');
  assert.deepEqual(fixture.insertedEntry, {
    id: 'entry-overflow-a', tenant_id: 'tenant-a', queue_id: 'queue-b', call_id: 'call-a',
    state: 'waiting', priority: 4, idempotency_key: 'overflow:overflow-a:queue',
    payload_hash: fixture.insertedEntry?.payload_hash,
    entered_at: '2026-07-13T00:05:00.000Z', offered_at: null, assigned_at: null,
    answered_at: null, ended_at: null, timeout_at: '2026-07-13T00:07:00.000Z',
    outcome_reason: '',
    metadata: { overflow_action_id: 'overflow-a', overflow_source_entry_id: 'entry-a' },
    revision: 1, created_at: '2026-07-13T00:05:00.000Z',
    updated_at: '2026-07-13T00:05:00.000Z'
  });
  assert.match(String(fixture.insertedEntry?.payload_hash || ''), /^[a-f0-9]{64}$/);
  assert.equal(fixture.voiceCommands.length, 0);
});

test('Contact Center overflow enqueues terminal Voice commands with stable idempotency', async () => {
  const fixture = setup(overflowAction({ action: 'voicemail', target: '7001' }));
  await fixture.service.processDue({ tenant_id: 'tenant-a', limit: 1, retry_delay_ms: 5_000 });
  assert.deepEqual(fixture.voiceCommands, [{
    tenant_id: 'tenant-a', call_id: 'call-a', action: 'voicemail', target: '7001',
    idempotency_key: 'overflow:overflow-a:voice'
  }]);
  assert.equal(fixture.persistedAction.state, 'completed');
  assert.equal(fixture.persistedAction.result_ref, 'voice-command-a');
});

test('Contact Center overflow retries safe failures and terminates at max attempts', async () => {
  const retryable = Object.assign(new Error('temporary'), {
    code: 'voice_unavailable', retryable: true
  });
  const fixture = setup(overflowAction({ action: 'hangup', max_attempts: 2 }), retryable);
  assert.deepEqual(await fixture.service.processDue({
    tenant_id: 'tenant-a', limit: 1, retry_delay_ms: 5_000
  }), { processed: 1, completed: 0, retried: 1, failed: 0 });
  assert.equal(fixture.persistedAction.state, 'retry_wait');
  assert.equal(fixture.persistedAction.scheduled_for, '2026-07-13T00:05:05.000Z');
  assert.equal(fixture.persistedAction.error_code, 'voice_unavailable');
  fixture.persistedAction = {
    ...fixture.persistedAction,
    state: 'pending', scheduled_for: '2026-07-13T00:05:00.000Z'
  };
  assert.deepEqual(await fixture.service.processDue({
    tenant_id: 'tenant-a', limit: 1, retry_delay_ms: 5_000
  }), { processed: 1, completed: 0, retried: 0, failed: 1 });
  assert.equal(fixture.persistedAction.state, 'failed');
  assert.equal(fixture.persistedAction.completed_at, '2026-07-13T00:05:00.000Z');
  assert.equal(JSON.stringify(fixture.persistedAction).includes('temporary'), false);
});

function setup(initial: ContactCenterOverflowAction, voiceError?: Error) {
  let persistedAction = structuredClone(initial);
  let insertedEntry: Record<string, unknown> | null = null;
  const voiceCommands: Array<Record<string, unknown>> = [];
  const repository = {
    async getNextDueOverflowAction() {
      return ['pending', 'retry_wait'].includes(persistedAction.state)
        ? structuredClone(persistedAction) : null;
    },
    async getQueue(_tenantId: string, queueId: string) {
      return queueId === 'queue-b' ? {
        id: 'queue-b', tenant_id: 'tenant-a', name: 'Overflow', routing_strategy: 'longest_idle',
        max_wait_seconds: 120, max_size: 10, callback_after_seconds: 0,
        overflow_action: 'none', overflow_queue_id: null, overflow_target: '',
        service_level_seconds: 20, status: 'active', metadata: {}, revision: 1,
        created_by: 'admin-a', updated_by: 'admin-a',
        created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
      } : null;
    },
    async countActiveEntries() { return 0; },
    async insertEntry(value: Record<string, unknown>) {
      insertedEntry = structuredClone(value);
      return structuredClone(value);
    },
    async updateOverflowAction(value: ContactCenterOverflowAction) {
      persistedAction = { ...structuredClone(value), revision: value.revision + 1 };
      return structuredClone(persistedAction);
    }
  } as unknown as ContactCenterRepository;
  const unitOfWork: ContactCenterUnitOfWork = {
    run: async (_tenantId, operation) => operation({ repository })
  };
  const service = new ContactCenterOverflowService({
    unit_of_work: unitOfWork,
    voice: {
      async enqueue(input) {
        voiceCommands.push(structuredClone(input));
        if (voiceError) throw voiceError;
        return { command_id: 'voice-command-a' };
      }
    },
    id: () => 'entry-overflow-a',
    now: () => new Date('2026-07-13T00:05:00.000Z')
  });
  return {
    service,
    voiceCommands,
    get insertedEntry() { return insertedEntry; },
    get persistedAction() { return persistedAction; },
    set persistedAction(value: ContactCenterOverflowAction) { persistedAction = value; }
  };
}

function overflowAction(
  input: Partial<ContactCenterOverflowAction> & Pick<ContactCenterOverflowAction, 'action'>
): ContactCenterOverflowAction {
  return {
    id: 'overflow-a', tenant_id: 'tenant-a', source_entry_id: 'entry-a',
    source_queue_id: 'queue-a', call_id: 'call-a', priority: 4, action: input.action,
    target_queue_id: null, target: '', state: 'pending', idempotency_key: 'overflow:entry-a',
    attempt_count: 0, max_attempts: 3, scheduled_for: '2026-07-13T00:05:00.000Z',
    result_ref: '', error_code: '', revision: 1,
    created_at: '2026-07-13T00:05:00.000Z', updated_at: '2026-07-13T00:05:00.000Z',
    completed_at: null,
    ...input
  };
}
