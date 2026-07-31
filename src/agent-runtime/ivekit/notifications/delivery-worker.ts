import { randomBytes } from 'node:crypto';

import { NotificationError } from './errors.js';
import type {
  NotificationContentProtector,
  NotificationDeliveryProvider,
  NotificationDeliveryRepository,
  NotificationProviderDeliveryResult,
  NotificationProviderResolver
} from './ports.js';
import type { NotificationDeliveryRecord } from './types.js';
import {
  observeNotificationDelivery,
  observeNotificationLeaseLost
} from './metrics.js';

export interface NotificationDeliveryBatchInput {
  repository: NotificationDeliveryRepository;
  protector: NotificationContentProtector;
  resolveProvider: NotificationProviderResolver;
  worker_id: string;
  now?: Date;
  clock?: () => Date;
  lease_ms: number;
  batch_size: number;
  tenant_limit?: number;
  shard_ids?: readonly number[];
  retry_delays_ms: readonly number[];
  lease_token_hash?: () => string;
}

export interface NotificationDeliveryBatchSummary {
  tenants: number;
  claimed: number;
  delivered: number;
  accepted: number;
  retry_wait: number;
  uncertain: number;
  failed: number;
  dead_letter: number;
}

export async function runNotificationDeliveryBatch(
  input: NotificationDeliveryBatchInput
): Promise<NotificationDeliveryBatchSummary> {
  const now = deliveryNow(input);
  const summary: NotificationDeliveryBatchSummary = {
    tenants: 0,
    claimed: 0,
    delivered: 0,
    accepted: 0,
    retry_wait: 0,
    uncertain: 0,
    failed: 0,
    dead_letter: 0
  };
  const tenantIds = await input.repository.listWorkerTenants(
    now,
    input.tenant_limit || 100,
    input.shard_ids
  );
  summary.tenants = tenantIds.length;
  for (const tenantId of tenantIds) {
    for (let claimed = 0; claimed < input.batch_size; claimed += 1) {
      const claimNow = deliveryNow(input);
      const claims = await input.repository.claimDue({
        tenant_id: tenantId,
        worker_id: input.worker_id,
        now: claimNow,
        lease_ms: input.lease_ms,
        limit: 1,
        lease_token_hash: (input.lease_token_hash || defaultLeaseTokenHash)(),
        shard_ids: input.shard_ids
      });
      const delivery = claims[0];
      if (!delivery) break;
      summary.claimed += 1;
      const state = await processDelivery(input, delivery, claimNow);
      summary[state] += 1;
    }
  }
  return summary;
}

async function processDelivery(
  input: NotificationDeliveryBatchInput,
  delivery: NotificationDeliveryRecord,
  now: Date
): Promise<keyof Pick<NotificationDeliveryBatchSummary,
  'delivered' | 'accepted' | 'retry_wait' | 'uncertain' | 'failed' | 'dead_letter'>> {
  const notification = await input.repository.getNotification(
    delivery.tenant_id,
    delivery.notification_id
  );
  if (!notification) {
    await finish(input, delivery, now, {
      status: 'terminal_failure',
      error_code: 'notification_not_found'
    });
    return 'failed';
  }

  let provider: NotificationDeliveryProvider;
  let recipient: string;
  let payload: unknown;
  try {
    provider = await input.resolveProvider(delivery, notification);
    if (provider.channel !== delivery.channel) {
      throw new NotificationError({ code: 'validation_failed', status: 500 });
    }
    [recipient, payload] = await Promise.all([
      input.protector.revealRecipient(
        delivery.tenant_id,
        delivery.channel,
        delivery.recipient_ciphertext
      ),
      input.protector.revealContent(delivery.tenant_id, delivery.payload_ciphertext)
    ]);
  } catch (error) {
    const retryable = error instanceof NotificationError && error.retryable;
    const result: NotificationProviderDeliveryResult = retryable
      ? { status: 'retryable_failure', error_code: error.code }
      : { status: 'terminal_failure', error_code: notificationErrorCode(error) };
    const state = result.status === 'retryable_failure' && delivery.attempt_count < delivery.max_attempts
      ? 'retry_wait'
      : result.status === 'retryable_failure' ? 'dead_letter' : 'failed';
    await finish(input, delivery, now, result);
    return state;
  }

  let result: NotificationProviderDeliveryResult;
  try {
    result = await provider.deliver({ notification, delivery, recipient, payload });
  } catch {
    result = { status: 'uncertain', error_code: 'provider_result_unknown' };
  }
  await finish(input, delivery, now, result, provider);
  return outcomeState(delivery, result);
}

async function finish(
  input: NotificationDeliveryBatchInput,
  delivery: NotificationDeliveryRecord,
  _claimedAt: Date,
  result: NotificationProviderDeliveryResult,
  provider?: NotificationDeliveryProvider
): Promise<void> {
  const state = outcomeState(delivery, result);
  const completedAt = deliveryNow(input);
  try {
    await input.repository.finishDelivery({
      tenant_id: delivery.tenant_id,
      delivery_id: delivery.id,
      worker_id: input.worker_id,
      state,
      now: completedAt,
      next_attempt_at: state === 'retry_wait'
        ? new Date(completedAt.getTime() + retryDelay(input.retry_delays_ms, delivery, result))
        : null,
      provider_kind: provider?.kind,
      provider_profile_id: provider?.profile_id,
      provider_request_id: result.provider_request_id,
      provider_message_id: result.provider_message_id,
      receipt_projection: result.receipt,
      error_code: result.error_code,
      error_projection: result.error
    });
    observeNotificationDelivery({
      channel: delivery.channel,
      provider: provider?.kind,
      result: state,
      error_code: result.error_code
    });
  } catch (error) {
    if (error instanceof NotificationError && error.code === 'lease_lost') {
      observeNotificationLeaseLost(delivery.channel);
    }
    throw error;
  }
}

function deliveryNow(input: NotificationDeliveryBatchInput): Date {
  return input.clock?.() || input.now || new Date();
}

function outcomeState(
  delivery: NotificationDeliveryRecord,
  result: NotificationProviderDeliveryResult
): 'accepted' | 'delivered' | 'retry_wait' | 'uncertain' | 'failed' | 'dead_letter' {
  if (result.status === 'accepted' || result.status === 'delivered' || result.status === 'uncertain') {
    return result.status;
  }
  if (result.status === 'terminal_failure') return 'failed';
  return delivery.attempt_count >= delivery.max_attempts ? 'dead_letter' : 'retry_wait';
}

function retryDelay(
  delays: readonly number[],
  delivery: NotificationDeliveryRecord,
  result: NotificationProviderDeliveryResult
): number {
  const configured = delays[Math.min(Math.max(delivery.attempt_count - 1, 0), delays.length - 1)] || 1_000;
  const requested = Number.isInteger(result.retry_after_ms)
    ? Math.max(0, Math.min(Number(result.retry_after_ms), 3_600_000))
    : 0;
  return Math.max(configured, requested);
}

function notificationErrorCode(error: unknown): string {
  return error instanceof NotificationError ? error.code : 'internal_error';
}

function defaultLeaseTokenHash(): string {
  return randomBytes(32).toString('hex');
}
