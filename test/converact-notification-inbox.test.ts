import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InAppNotificationProvider,
  type NotificationInboxItem,
  type NotificationInboxRepository,
  type NotificationDeliveryRecord,
  type NotificationRecord
} from '../src/agent-runtime/converact/notifications/index.js';

class MemoryInbox implements Pick<NotificationInboxRepository, 'upsertInboxItem'> {
  readonly items: NotificationInboxItem[] = [];

  async upsertInboxItem(item: NotificationInboxItem): Promise<NotificationInboxItem> {
    const found = this.items.find((candidate) => candidate.tenant_id === item.tenant_id
      && candidate.notification_id === item.notification_id && candidate.user_id === item.user_id);
    if (found) return found;
    this.items.push(item);
    return item;
  }
}

test('in-app notification provider creates an idempotent safe inbox projection', async () => {
  const repository = new MemoryInbox();
  const provider = new InAppNotificationProvider({ repository });
  const input = {
    notification: notificationRow(),
    delivery: deliveryRow(),
    recipient: 'user-a',
    payload: { title: 'Notice', body: 'full private body' }
  };

  const first = await provider.deliver(input);
  const duplicate = await provider.deliver(input);

  assert.equal(first.status, 'delivered');
  assert.equal(duplicate.status, 'delivered');
  assert.equal(repository.items.length, 1);
  assert.deepEqual(repository.items[0].projection, {
    title: 'Projected title',
    event_type: 'example.created',
    business_ref: { type: 'example', id: 'example-a' },
    correlation_id: 'request-a'
  });
  assert.equal(JSON.stringify(repository.items[0]).includes('full private body'), false);
});

test('in-app notification provider rejects recipient mismatches without writing', async () => {
  const repository = new MemoryInbox();
  const result = await new InAppNotificationProvider({ repository }).deliver({
    notification: notificationRow(),
    delivery: deliveryRow(),
    recipient: 'user-b',
    payload: { title: 'Notice' }
  });

  assert.deepEqual(result, {
    status: 'terminal_failure',
    error_code: 'recipient_mismatch'
  });
  assert.equal(repository.items.length, 0);
});

function notificationRow(): NotificationRecord {
  return {
    id: 'notification-a', tenant_id: 'tenant-a', event_type: 'example.created',
    recipient_kind: 'user', recipient_ref: 'user-a', channels: ['in_app'], locale: 'zh-CN',
    template_id: null, template_revision: null, content_ciphertext: 'ciphertext',
    content_projection: { title: 'Projected title' }, priority: 'high', force_delivery: false,
    business_ref_type: 'example', business_ref_id: 'example-a', requested_by: 'operator-a',
    correlation_id: 'request-a', idempotency_key: 'notification-a', payload_hash: 'a'.repeat(64),
    policy: {}, state: 'pending', scheduled_at: '2026-07-15T00:00:00.000Z', retention_until: null,
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    completed_at: null
  };
}

function deliveryRow(): NotificationDeliveryRecord {
  return {
    id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a', channel: 'in_app',
    endpoint_id: null, provider_kind: 'unresolved', provider_profile_id: '',
    recipient_ciphertext: 'recipient', recipient_hmac: 'a'.repeat(64), recipient_redacted: 'u***-a',
    payload_ciphertext: 'payload', payload_hash: 'b'.repeat(64),
    provider_idempotency_key: `notify_${'c'.repeat(64)}`, state: 'processing', attempt_count: 1,
    max_attempts: 5, next_attempt_at: null, lease_token_hash: 'd'.repeat(64),
    lease_until: '2026-07-15T00:00:30.000Z', worker_id: 'worker-a', provider_request_id: '',
    provider_message_id: '', provider_receipt_projection: {}, error_code: '', error_projection: {},
    created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
    accepted_at: null, delivered_at: null, completed_at: null
  };
}
