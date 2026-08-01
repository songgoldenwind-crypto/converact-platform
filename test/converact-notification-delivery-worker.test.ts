import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NotificationError,
  runNotificationDeliveryBatch,
  type NotificationDeliveryClaimInput,
  type NotificationDeliveryFinishInput,
  type NotificationDeliveryProvider,
  type NotificationDeliveryRecord,
  type NotificationDeliveryRepository,
  type NotificationRecord
} from '../src/agent-runtime/converact/notifications/index.js';

class WorkerRepository implements NotificationDeliveryRepository {
  readonly finishes: NotificationDeliveryFinishInput[] = [];
  readonly claimLimits: number[] = [];
  private readonly pending: NotificationDeliveryRecord[];
  activeClaims = 0;
  maxActiveClaims = 0;
  readonly tenantShardIds: number[][] = [];
  readonly claimShardIds: number[][] = [];

  constructor(
    readonly deliveries: NotificationDeliveryRecord[],
    readonly notification: NotificationRecord = notificationRow()
  ) {
    this.pending = [...deliveries];
  }

  async create(): Promise<any> { throw new Error('not used'); }
  async listWorkerTenants(
    _now?: Date,
    _limit?: number,
    shardIds: readonly number[] = []
  ): Promise<string[]> {
    this.tenantShardIds.push([...shardIds]);
    return ['tenant-a'];
  }
  async claimDue(input: NotificationDeliveryClaimInput): Promise<NotificationDeliveryRecord[]> {
    this.claimLimits.push(input.limit);
    this.claimShardIds.push([...(input.shard_ids || [])]);
    const claimed = this.pending.splice(0, input.limit);
    this.activeClaims += claimed.length;
    this.maxActiveClaims = Math.max(this.maxActiveClaims, this.activeClaims);
    return claimed;
  }
  async getNotification(): Promise<NotificationRecord | null> { return this.notification; }
  async finishDelivery(input: NotificationDeliveryFinishInput): Promise<NotificationDeliveryRecord> {
    this.finishes.push(input);
    this.activeClaims -= 1;
    return deliveryRow({ id: input.delivery_id, state: input.state });
  }
}

const protector = {
  async protectContent(): Promise<any> { throw new Error('not used'); },
  async protectRecipient(): Promise<any> { throw new Error('not used'); },
  async revealContent(): Promise<unknown> { return { title: 'Notice', body: 'Body' }; },
  async revealRecipient(_tenant: string, _channel: string, ciphertext: string): Promise<string> {
    return ciphertext === 'recipient-b' ? 'second@example.com' : 'first@example.com';
  }
};

test('notification delivery batch maps delivered and accepted provider results without conflating them', async () => {
  const repository = new WorkerRepository([
    deliveryRow(),
    deliveryRow({ id: 'delivery-b', recipient_ciphertext: 'recipient-b' })
  ]);
  const provider: NotificationDeliveryProvider = {
    kind: 'controlled',
    channel: 'email',
    async deliver(input) {
      return input.delivery.id === 'delivery-a'
        ? { status: 'delivered', provider_message_id: 'message-a', receipt: { status: 250 } }
        : { status: 'accepted', provider_message_id: 'message-b', receipt: { queued: true } };
    }
  };

  const result = await runNotificationDeliveryBatch({
    repository,
    protector,
    resolveProvider: async () => provider,
    worker_id: 'worker-a',
    now: new Date('2026-07-15T00:00:00.000Z'),
    lease_ms: 30_000,
    batch_size: 10,
    shard_ids: [2, 6, 10],
    retry_delays_ms: [1_000, 5_000],
    lease_token_hash: () => 'a'.repeat(64)
  });

  assert.deepEqual(result, {
    tenants: 1, claimed: 2, delivered: 1, accepted: 1,
    retry_wait: 0, uncertain: 0, failed: 0, dead_letter: 0
  });
  assert.equal(repository.finishes[0].state, 'delivered');
  assert.equal(repository.finishes[1].state, 'accepted');
  assert.equal(repository.finishes[0].provider_kind, 'controlled');
  assert.equal(repository.maxActiveClaims, 1);
  assert.deepEqual(repository.claimLimits, [1, 1, 1]);
  assert.deepEqual(repository.tenantShardIds, [[2, 6, 10]]);
  assert.deepEqual(repository.claimShardIds, [
    [2, 6, 10],
    [2, 6, 10],
    [2, 6, 10]
  ]);
});

test('notification delivery batch applies bounded retries, dead-letter and uncertain outcomes', async () => {
  const repository = new WorkerRepository([
    deliveryRow({ id: 'retry', attempt_count: 1 }),
    deliveryRow({ id: 'exhausted', attempt_count: 5, max_attempts: 5 }),
    deliveryRow({ id: 'uncertain' }),
    deliveryRow({ id: 'terminal' })
  ]);
  const provider: NotificationDeliveryProvider = {
    kind: 'controlled',
    channel: 'email',
    async deliver(input) {
      if (input.delivery.id === 'uncertain') return { status: 'uncertain', error_code: 'provider_timeout' };
      if (input.delivery.id === 'terminal') return { status: 'terminal_failure', error_code: 'invalid_recipient' };
      return { status: 'retryable_failure', error_code: 'provider_unavailable', retry_after_ms: 3_000 };
    }
  };

  const result = await runNotificationDeliveryBatch({
    repository,
    protector,
    resolveProvider: async () => provider,
    worker_id: 'worker-a', now: new Date('2026-07-15T00:00:00.000Z'),
    lease_ms: 30_000, batch_size: 10, retry_delays_ms: [1_000, 5_000],
    lease_token_hash: () => 'b'.repeat(64)
  });

  assert.equal(result.retry_wait, 1);
  assert.equal(result.dead_letter, 1);
  assert.equal(result.uncertain, 1);
  assert.equal(result.failed, 1);
  assert.equal(repository.finishes.find((item) => item.delivery_id === 'retry')?.next_attempt_at?.toISOString(),
    '2026-07-15T00:00:03.000Z');
});

test('notification delivery batch retries resolver failures but treats thrown sends as uncertain', async () => {
  const resolverRepository = new WorkerRepository([deliveryRow()]);
  await runNotificationDeliveryBatch({
    repository: resolverRepository, protector,
    resolveProvider: async () => {
      throw new NotificationError({ code: 'provider_unavailable', retryable: true, status: 503 });
    },
    worker_id: 'worker-a', now: new Date('2026-07-15T00:00:00.000Z'),
    lease_ms: 30_000, batch_size: 10, retry_delays_ms: [1_000],
    lease_token_hash: () => 'c'.repeat(64)
  });
  assert.equal(resolverRepository.finishes[0].state, 'retry_wait');

  const sendRepository = new WorkerRepository([deliveryRow()]);
  await runNotificationDeliveryBatch({
    repository: sendRepository, protector,
    resolveProvider: async () => ({
      kind: 'controlled', channel: 'email',
      async deliver() { throw new Error('socket closed after write'); }
    }),
    worker_id: 'worker-a', now: new Date('2026-07-15T00:00:00.000Z'),
    lease_ms: 30_000, batch_size: 10, retry_delays_ms: [1_000],
    lease_token_hash: () => 'd'.repeat(64)
  });
  assert.equal(sendRepository.finishes[0].state, 'uncertain');
});

test('notification retry delay starts after provider execution completes', async () => {
  const repository = new WorkerRepository([deliveryRow({ id: 'slow-retry' })]);
  let current = new Date('2026-07-15T00:00:00.000Z');
  await runNotificationDeliveryBatch({
    repository,
    protector,
    resolveProvider: async () => ({
      kind: 'controlled', channel: 'email',
      async deliver() {
        current = new Date('2026-07-15T00:00:10.000Z');
        return { status: 'retryable_failure', error_code: 'provider_busy', retry_after_ms: 3_000 };
      }
    }),
    worker_id: 'worker-a', clock: () => current,
    lease_ms: 30_000, batch_size: 1, retry_delays_ms: [1_000],
    lease_token_hash: () => 'f'.repeat(64)
  });

  assert.equal(repository.finishes[0]?.next_attempt_at?.toISOString(),
    '2026-07-15T00:00:13.000Z');
  assert.equal(repository.finishes[0]?.now.toISOString(), '2026-07-15T00:00:10.000Z');
});

function notificationRow(): NotificationRecord {
  return {
    id: 'notification-a', tenant_id: 'tenant-a', event_type: 'example.created',
    recipient_kind: 'user', recipient_ref: 'user-a', channels: ['email'], locale: 'zh-CN',
    template_id: null, template_revision: null, content_ciphertext: 'content-a',
    content_projection: { title: 'Notice' }, priority: 'normal', force_delivery: false,
    business_ref_type: 'example', business_ref_id: 'example-a', requested_by: 'operator-a',
    correlation_id: '', idempotency_key: 'notification-a', payload_hash: 'a'.repeat(64),
    policy: {}, state: 'pending', scheduled_at: '2026-07-15T00:00:00.000Z',
    retention_until: null, created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z', completed_at: null
  };
}

function deliveryRow(overrides: Partial<NotificationDeliveryRecord> = {}): NotificationDeliveryRecord {
  return {
    id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a', channel: 'email',
    endpoint_id: null, provider_kind: 'unresolved', provider_profile_id: '',
    recipient_ciphertext: 'recipient-a', recipient_hmac: 'a'.repeat(64),
    recipient_redacted: 'f***@example.com', payload_ciphertext: 'content-a', payload_hash: 'b'.repeat(64),
    provider_idempotency_key: `notify_${'c'.repeat(64)}`, state: 'processing', attempt_count: 1,
    max_attempts: 5, next_attempt_at: null, lease_token_hash: 'd'.repeat(64),
    lease_until: '2026-07-15T00:00:30.000Z', worker_id: 'worker-a', provider_request_id: '',
    provider_message_id: '', provider_receipt_projection: {}, error_code: '', error_projection: {},
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    accepted_at: null, delivered_at: null, completed_at: null, ...overrides
  };
}
