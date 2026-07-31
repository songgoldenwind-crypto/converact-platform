import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatMutationOutcomeUnknownError,
  type ChatGateway,
  type ChatMutationInput,
  type ChatMutationResult
} from '../src/agent-runtime/collaboration/chat-gateway.js';
import { withCollaborationSessionLock } from '../src/agent-runtime/collaboration/collaboration-lock.js';
import { CollaborationMessageStateStore } from '../src/agent-runtime/collaboration/message-state-store.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { TinodeMessageDeliveryService } from '../src/agent-runtime/collaboration/tinode-message-delivery.js';
import {
  TinodeMessageMutationService,
  TinodeMessageMutationStore,
  type TinodeMessageMutationClaim,
  type TinodeMessageMutationStoreContract
} from '../src/agent-runtime/collaboration/tinode-message-mutation.js';
import { MemoryPg } from '../src/db-pg.js';

class FakeMutationStore implements TinodeMessageMutationStoreContract {
  readonly completed: string[] = [];
  readonly failures: Array<{
    id: string;
    terminal: boolean;
    nextAttemptAt: string | null;
    errorCode: string;
    errorMessage: string;
  }> = [];

  constructor(readonly claims: TinodeMessageMutationClaim[]) {}

  async listTenantIds(): Promise<string[]> {
    return [...new Set(this.claims.map((claim) => claim.tenant_id))];
  }

  async claimNext(input: { tenant_id: string }): Promise<TinodeMessageMutationClaim | null> {
    const index = this.claims.findIndex((claim) => claim.tenant_id === input.tenant_id);
    return index < 0 ? null : this.claims.splice(index, 1)[0] || null;
  }

  async complete(claim: TinodeMessageMutationClaim): Promise<boolean> {
    this.completed.push(claim.id);
    return true;
  }

  async fail(input: {
    claim: TinodeMessageMutationClaim;
    terminal: boolean;
    next_attempt_at: Date | null;
    error_code: string;
    error_message: string;
  }): Promise<boolean> {
    this.failures.push({
      id: input.claim.id,
      terminal: input.terminal,
      nextAttemptAt: input.next_attempt_at?.toISOString() || null,
      errorCode: input.error_code,
      errorMessage: input.error_message
    });
    return true;
  }
}

function claim(overrides: Partial<TinodeMessageMutationClaim> = {}): TinodeMessageMutationClaim {
  return {
    id: 'tmut_1',
    tenant_id: 'tenant_1',
    session_id: 'session_1',
    message_id: 'message_1',
    mutation_id: 'cmut_1',
    mutation_version: 1,
    action: 'edit',
    provider_topic_id: 'grp_1',
    target_provider_message_id: '12',
    body: 'edited body',
    attempt_count: 1,
    max_attempts: 3,
    claim_token: 'claim_1',
    recovered_from_processing: false,
    ...overrides
  };
}

test('Tinode mutation worker publishes native operations and completes durable claims', async () => {
  const store = new FakeMutationStore([
    claim(),
    claim({ id: 'tmut_2', mutation_id: 'cmut_2', mutation_version: 2, action: 'delete', body: '' })
  ]);
  const calls: ChatMutationInput[] = [];
  const service = new TinodeMessageMutationService({
    store,
    gateway: {
      provider: 'tinode',
      async mutateMessage(input): Promise<ChatMutationResult> {
        calls.push(input);
        return {
          provider: 'tinode',
          provider_topic_id: input.provider_topic_id,
          provider_operation_id: `op-${input.mutation_id}`,
          provider_sync_status: 'published',
          metadata: {}
        };
      }
    },
    now: () => new Date('2026-07-16T00:00:00.000Z')
  });

  const summary = await service.runDue({ limit: 10 });

  assert.deepEqual(summary, { examined: 2, delivered: 2, retry_wait: 0, dead_letter: 0, stale: 0 });
  assert.deepEqual(calls.map((item) => [item.action, item.target_provider_message_id]), [
    ['edit', '12'],
    ['delete', '12']
  ]);
  assert.deepEqual(store.completed, ['tmut_1', 'tmut_2']);
});

test('Tinode mutation worker retries bounded transient failures from provider completion time', async () => {
  const store = new FakeMutationStore([claim({ attempt_count: 1, max_attempts: 3 })]);
  const service = new TinodeMessageMutationService({
    store,
    gateway: {
      provider: 'tinode',
      async mutateMessage() {
        throw new Error('socket reset by peer token=must-not-leak');
      }
    },
    retryDelaysMs: [2_000, 10_000],
    now: () => new Date('2026-07-16T00:00:05.000Z')
  });

  const summary = await service.runDue({ tenant_id: 'tenant_1', limit: 1 });

  assert.equal(summary.retry_wait, 1);
  assert.deepEqual(store.failures, [{
    id: 'tmut_1',
    terminal: false,
    nextAttemptAt: '2026-07-16T00:00:07.000Z',
    errorCode: 'provider_unavailable',
    errorMessage: 'socket reset by peer token=[redacted]'
  }]);
});

test('Tinode mutation worker never automatically retries an edit with unknown publish outcome', async () => {
  const store = new FakeMutationStore([claim({ attempt_count: 1, max_attempts: 3 })]);
  const service = new TinodeMessageMutationService({
    store,
    gateway: {
      provider: 'tinode',
      async mutateMessage() {
        throw new ChatMutationOutcomeUnknownError('Tinode edit publish outcome is unknown');
      }
    }
  });

  const summary = await service.runDue({ tenant_id: 'tenant_1', limit: 1 });

  assert.deepEqual(summary, {
    examined: 1,
    delivered: 0,
    retry_wait: 0,
    dead_letter: 1,
    stale: 0
  });
  assert.equal(store.failures[0]?.terminal, true);
  assert.equal(store.failures[0]?.nextAttemptAt, null);
  assert.equal(store.failures[0]?.errorCode, 'provider_outcome_uncertain');
});

test('Tinode mutation worker reconciles an expired in-flight edit instead of publishing it again', async () => {
  const store = new FakeMutationStore([claim({ recovered_from_processing: true })]);
  let providerCalls = 0;
  const service = new TinodeMessageMutationService({
    store,
    gateway: {
      provider: 'tinode',
      async mutateMessage() {
        providerCalls += 1;
        throw new Error('must not be called');
      }
    }
  });

  const summary = await service.runDue({ tenant_id: 'tenant_1', limit: 1 });

  assert.equal(providerCalls, 0);
  assert.equal(summary.dead_letter, 1);
  assert.equal(store.failures[0]?.terminal, true);
  assert.equal(store.failures[0]?.errorCode, 'provider_outcome_uncertain');
});

test('Tinode mutation worker dead-letters the final attempt', async () => {
  const store = new FakeMutationStore([claim({ attempt_count: 3, max_attempts: 3 })]);
  const service = new TinodeMessageMutationService({
    store,
    gateway: {
      provider: 'tinode',
      async mutateMessage() {
        throw new Error('provider rejected mutation');
      }
    }
  });

  const summary = await service.runDue({ tenant_id: 'tenant_1', limit: 1 });

  assert.equal(summary.dead_letter, 1);
  assert.equal(store.failures[0]?.terminal, true);
  assert.equal(store.failures[0]?.nextAttemptAt, null);
});

test('mutation callback failures happen after durable completion and do not republish', async () => {
  const store = new FakeMutationStore([claim()]);
  let providerCalls = 0;
  const service = new TinodeMessageMutationService({
    store,
    gateway: {
      provider: 'tinode',
      async mutateMessage(input) {
        providerCalls += 1;
        return {
          provider: 'tinode',
          provider_topic_id: input.provider_topic_id,
          provider_operation_id: 'op-callback-committed',
          provider_sync_status: 'published',
          metadata: {}
        };
      }
    },
    onMutationUpdated: () => {
      throw new Error('mutation callback failed');
    }
  });

  await assert.rejects(
    () => service.runDue({ tenant_id: 'tenant_1', limit: 1 }),
    /mutation callback failed/
  );
  assert.deepEqual(store.completed, ['tmut_1']);
  assert.equal((await service.runDue({ tenant_id: 'tenant_1', limit: 1 })).examined, 0);
  assert.equal(providerCalls, 1);
});

test('real mutation worker holds a shared session lock through provider publish and completion', async () => {
  const pg = new MemoryPg();
  const sessions = new CollaborationStore(pg);
  const tenantId = 'tenant_mutation_lock';
  const session = await sessions.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'MUTATION-LOCK-1' }
  });
  await sessions.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'agent-mutation',
    role: 'agent'
  });
  let mutationEntered!: () => void;
  let releaseMutation!: () => void;
  const entered = new Promise<void>((resolve) => {
    mutationEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  const gateway: ChatGateway = {
    provider: 'tinode',
    async ensureTopic(input) {
      return {
        provider: 'tinode',
        provider_topic_id: `grp_${input.session_id}`,
        provider_status: 'bound',
        metadata: {}
      };
    },
    async ensureUser(input) {
      return { provider_user_id: `usr_${input.identity}`, metadata: {} };
    },
    async addParticipant() {},
    async removeParticipant() {},
    async publishMessage(input) {
      return {
        provider: 'tinode',
        provider_topic_id: input.provider_topic_id,
        provider_message_id: 'seq-mutation-source',
        provider_sync_status: 'published',
        metadata: {}
      };
    },
    async mutateMessage(input) {
      mutationEntered();
      await gate;
      return {
        provider: 'tinode',
        provider_topic_id: input.provider_topic_id,
        provider_operation_id: 'op-mutation-lock',
        provider_sync_status: 'published',
        metadata: {}
      };
    }
  };
  const delivered = await new TinodeMessageDeliveryService({
    pg,
    gateway,
    fileSecurityGate: null
  }).createAndDeliver({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'agent-mutation',
    message_type: 'text',
    body: 'before edit',
    provider_topic_id: 'grp_mutation_lock',
    provider_payload: 'before edit'
  });
  await new CollaborationMessageStateStore(pg).editMessage({
    tenant_id: tenantId,
    session_id: session.id,
    message_id: delivered.message.id,
    actor_identity: 'agent-mutation',
    body: 'after edit'
  });
  const worker = new TinodeMessageMutationService({
    pg,
    store: new TinodeMessageMutationStore(pg),
    gateway
  });

  const running = worker.runDue({ tenant_id: tenantId, limit: 1 });
  await entered;
  await assert.rejects(
    () => withCollaborationSessionLock(pg, {
      tenantId,
      sessionId: session.id,
      mode: 'exclusive'
    }, async () => undefined),
    (error: unknown) =>
      (error as { code?: string }).code === 'collaboration_session_busy'
  );
  releaseMutation();
  assert.equal((await running).delivered, 1);
  const outbox = await pg.query(
    'SELECT * FROM tinode_message_mutation_outbox WHERE tenant_id = $1 AND message_id = $2 ORDER BY mutation_version ASC',
    [tenantId, delivered.message.id]
  );
  assert.equal(outbox.rows[0]?.status, 'delivered');
  assert.equal(outbox.rows[0]?.provider_operation_id, 'op-mutation-lock');
});
