import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IvrError,
  IvrPendingActionReconciliationWorker,
  IvrPendingActionWorker,
  type IvrPendingAction,
  type IvrPendingActionRepository
} from '../src/agent-runtime/converact/ivr/index.js';

test('IVR pending action worker claims and completes a durable action once', async () => {
  const actions = new MemoryActions([pendingAction()]);
  const worker = new IvrPendingActionWorker({
    actions,
    executor: { async execute(action) { return { echoed: action.payload.value }; } },
    worker_id: 'worker-a', now: fixedNow
  });
  const result = await worker.runTenant('tenant-a');
  assert.deepEqual(result, { claimed: 1, succeeded: 1, retry_wait: 0, uncertain: 0, failed: 0 });
  assert.equal(actions.items[0]?.state, 'succeeded');
  assert.deepEqual(actions.items[0]?.result, { echoed: 'ok' });
  assert.equal(actions.items[0]?.attempt_count, 1);
});

test('IVR pending action worker retries retryable failures with bounded backoff', async () => {
  const actions = new MemoryActions([pendingAction()]);
  const worker = new IvrPendingActionWorker({
    actions,
    executor: { async execute() {
      throw new IvrError({ code: 'internal_error', retryable: true, status: 503 });
    } },
    worker_id: 'worker-a', now: fixedNow, retry_base_ms: 1_000
  });
  const result = await worker.runTenant('tenant-a');
  assert.equal(result.retry_wait, 1);
  assert.equal(actions.items[0]?.state, 'retry_wait');
  assert.equal(actions.items[0]?.next_attempt_at, '2026-07-13T02:00:01.000Z');
  assert.equal(actions.items[0]?.error_code, 'internal_error');
});

test('IVR pending action worker makes provider timeouts uncertain and terminal errors failed', async () => {
  const actions = new MemoryActions([
    pendingAction({ id: 'timeout', idempotency_key: 'timeout' }),
    pendingAction({ id: 'terminal', idempotency_key: 'terminal' })
  ]);
  const worker = new IvrPendingActionWorker({
    actions,
    executor: { async execute(action) {
      if (action.id === 'timeout') throw new IvrError({ code: 'provider_timeout', retryable: true, status: 504 });
      throw new IvrError({ code: 'capability_unavailable', status: 501 });
    } },
    worker_id: 'worker-a', now: fixedNow
  });
  const result = await worker.runTenant('tenant-a');
  assert.equal(result.uncertain, 1);
  assert.equal(result.failed, 1);
  assert.equal(actions.items.find((item) => item.id === 'timeout')?.state, 'uncertain');
  assert.equal(actions.items.find((item) => item.id === 'terminal')?.state, 'failed');
});

test('IVR pending action worker resumes the session when a terminal failure is known', async () => {
  const actions = new MemoryActions([pendingAction()]);
  const failed: string[] = [];
  const worker = new IvrPendingActionWorker({
    actions,
    executor: { async execute() {
      throw new IvrError({ code: 'capability_unavailable', status: 501 });
    } },
    completion: {
      async complete() { throw new Error('not called'); },
      async fail(input) {
        failed.push(input.error_code);
        await actions.settle({
          tenant_id: input.action.tenant_id, action_id: input.action.id,
          worker_id: input.worker_id, state: 'failed', result: {},
          error_code: input.error_code, completed_at: fixedNow().toISOString()
        });
      }
    },
    worker_id: 'worker-a', now: fixedNow
  });
  const result = await worker.runTenant('tenant-a');
  assert.equal(result.failed, 1);
  assert.deepEqual(failed, ['capability_unavailable']);
  assert.equal(actions.items[0]?.state, 'failed');
});

test('IVR pending action worker never replays a successful effect when session completion fails', async () => {
  const actions = new MemoryActions([pendingAction()]);
  let executions = 0;
  const worker = new IvrPendingActionWorker({
    actions,
    executor: { async execute() { executions += 1; return { provider_action_id: 'provider-a' }; } },
    completion: { async complete() { throw new Error('database connection lost'); } },
    worker_id: 'worker-a', now: fixedNow
  });
  const result = await worker.runTenant('tenant-a');
  assert.equal(executions, 1);
  assert.equal(result.uncertain, 1);
  assert.equal(result.retry_wait, 0);
  assert.equal(actions.items[0]?.state, 'uncertain');
});

test('IVR pending action claim recovers expired leases and protects active leases', async () => {
  const actions = new MemoryActions([
    pendingAction({ id: 'expired', state: 'processing', worker_id: 'dead-worker',
      lease_until: '2026-07-13T01:59:59.000Z', attempt_count: 1 }),
    pendingAction({ id: 'active', state: 'processing', worker_id: 'active-worker',
      lease_until: '2026-07-13T02:01:00.000Z', attempt_count: 1 })
  ]);
  const claimed = await actions.claimDue({
    tenant_id: 'tenant-a', worker_id: 'worker-a', now: fixedNow().toISOString(), limit: 10, lease_ms: 30_000
  });
  assert.deepEqual(claimed.map((item) => item.id), ['expired']);
  assert.equal(actions.items.find((item) => item.id === 'expired')?.attempt_count, 2);
  assert.equal(actions.items.find((item) => item.id === 'active')?.worker_id, 'active-worker');
});

test('IVR reconciliation confirms outcomes without replaying the original action', async () => {
  const actions = new MemoryActions([
    pendingAction({ id: 'confirmed', state: 'uncertain', next_attempt_at: '2026-07-13T01:59:00.000Z' }),
    pendingAction({ id: 'unknown', state: 'uncertain', next_attempt_at: '2026-07-13T01:59:00.000Z' })
  ]);
  let originalExecutions = 0;
  const worker = new IvrPendingActionReconciliationWorker({
    actions,
    reconciler: { async reconcile(action) {
      return action.id === 'confirmed'
        ? { disposition: 'succeeded' as const, result: { provider_action_id: 'provider-a' } }
        : { disposition: 'unknown' as const, error_code: 'provider_result_unknown' };
    } },
    worker_id: 'reconcile-a', now: fixedNow, retry_ms: 5_000
  });
  const result = await worker.runTenant('tenant-a');
  assert.equal(originalExecutions, 0);
  assert.deepEqual(result, { claimed: 2, succeeded: 1, failed: 0, uncertain: 1 });
  assert.equal(actions.items.find((item) => item.id === 'confirmed')?.state, 'succeeded');
  assert.equal(actions.items.find((item) => item.id === 'unknown')?.state, 'uncertain');
  assert.equal(actions.items.find((item) => item.id === 'unknown')?.next_attempt_at, '2026-07-13T02:00:05.000Z');
  assert.equal(actions.items.every((item) => item.reconciliation_count === 1), true);
  void originalExecutions;
});

test('IVR reconciliation terminates an unknown action at its configured attempt ceiling', async () => {
  const actions = new MemoryActions([pendingAction({
    state: 'uncertain', next_attempt_at: '2026-07-13T01:59:00.000Z',
    reconciliation_count: 2
  })]);
  const worker = new IvrPendingActionReconciliationWorker({
    actions,
    reconciler: { async reconcile() {
      return { disposition: 'unknown' as const, error_code: 'provider_result_unknown' };
    } },
    worker_id: 'reconcile-a', now: fixedNow, max_reconciliations: 3
  });

  const result = await worker.runTenant('tenant-a');
  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1, uncertain: 0 });
  assert.equal(actions.items[0]?.state, 'failed');
  assert.equal(actions.items[0]?.error_code, 'provider_result_unknown');
  assert.equal(actions.items[0]?.next_attempt_at, null);
});

class MemoryActions implements IvrPendingActionRepository {
  readonly items: IvrPendingAction[];
  constructor(items: IvrPendingAction[]) { this.items = structuredClone(items); }

  async get(tenantId: string, actionId: string) {
    return structuredClone(this.items.find((item) => item.tenant_id === tenantId && item.id === actionId) ?? null);
  }

  async claimDue(input: { tenant_id: string; worker_id: string; now: string; limit: number; lease_ms: number }) {
    const now = input.now;
    const claimed = this.items.filter((item) => item.tenant_id === input.tenant_id
      && item.dispatch_mode === 'worker'
      && item.attempt_count < item.max_attempts
      && (item.state === 'pending'
        || (item.state === 'retry_wait' && (!item.next_attempt_at || item.next_attempt_at <= now))
        || (item.state === 'processing' && Boolean(item.lease_until) && item.lease_until! <= now)))
      .slice(0, input.limit);
    for (const item of claimed) {
      item.state = 'processing'; item.worker_id = input.worker_id; item.attempt_count += 1;
      item.lease_until = new Date(new Date(now).getTime() + input.lease_ms).toISOString();
    }
    return structuredClone(claimed);
  }
  async claimUncertain(input: { tenant_id: string; worker_id: string; now: string; limit: number; lease_ms: number }) {
    const claimed = this.items.filter((item) => item.tenant_id === input.tenant_id && item.state === 'uncertain'
      && (!item.next_attempt_at || item.next_attempt_at <= input.now)
      && (!item.lease_until || item.lease_until <= input.now)).slice(0, input.limit);
    for (const item of claimed) {
      item.worker_id = input.worker_id;
      item.lease_until = new Date(new Date(input.now).getTime() + input.lease_ms).toISOString();
      item.reconciliation_count += 1;
    }
    return structuredClone(claimed);
  }
  async release(input: { tenant_id: string; action_id: string; worker_id: string;
    state: 'retry_wait' | 'uncertain' | 'failed'; next_attempt_at: string | null; error_code: string; error_message: string }) {
    const item = this.items.find((candidate) => candidate.tenant_id === input.tenant_id && candidate.id === input.action_id
      && candidate.worker_id === input.worker_id);
    if (!item) throw new IvrError({ code: 'lease_lost' });
    Object.assign(item, input, { id: item.id, state: input.state, worker_id: '', lease_until: null,
      completed_at: input.state === 'failed' ? fixedNow().toISOString() : null });
    return structuredClone(item);
  }
  async findOpenForSession(tenantId: string, sessionId: string) {
    return structuredClone(this.items.find((item) => item.tenant_id === tenantId && item.session_id === sessionId
      && ['pending', 'processing', 'retry_wait', 'uncertain'].includes(item.state)) ?? null);
  }
  async insert(action: IvrPendingAction) { this.items.push(structuredClone(action)); return structuredClone(action); }
  async settle(input: { tenant_id: string; action_id: string; worker_id?: string; state: 'succeeded' | 'failed' | 'cancelled';
    result: Record<string, unknown>; error_code: string; completed_at: string }) {
    const item = this.items.find((candidate) => candidate.tenant_id === input.tenant_id && candidate.id === input.action_id
      && (!input.worker_id || candidate.worker_id === input.worker_id));
    if (!item) throw new IvrError({ code: 'lease_lost' });
    Object.assign(item, input, { id: item.id, state: input.state, worker_id: '', lease_until: null,
      updated_at: input.completed_at, completed_at: input.completed_at });
    return structuredClone(item);
  }
}

function pendingAction(patch: Partial<IvrPendingAction> = {}): IvrPendingAction {
  return {
    id: 'action-a', tenant_id: 'tenant-a', session_id: 'session-a', step_index: 0,
    node_id: 'webhook-a', action_kind: 'webhook', state: 'pending', dispatch_mode: 'worker',
    idempotency_key: 'action-a', payload_hash: 'a'.repeat(64), payload: { value: 'ok' }, result: {},
    attempt_count: 0, max_attempts: 3, next_attempt_at: null, lease_until: null, worker_id: '',
    provider_profile_id: '', provider_action_id: '', error_code: '', error_message: '', trace_id: 'trace-a',
    reconciliation_count: 0, created_at: '2026-07-13T01:00:00.000Z',
    updated_at: '2026-07-13T01:00:00.000Z', completed_at: null,
    ...patch
  };
}

function fixedNow(): Date { return new Date('2026-07-13T02:00:00.000Z'); }
