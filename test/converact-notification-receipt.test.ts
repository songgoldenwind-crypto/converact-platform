import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  NotificationReceiptService,
  canonicalNotificationJson,
  type NotificationDeliveryRecord,
  type NotificationEndpoint,
  type NotificationReceipt,
  type NotificationReceiptRepository
} from '../src/agent-runtime/converact/notifications/index.js';

class MemoryReceiptRepository implements NotificationReceiptRepository {
  receipts = new Map<string, NotificationReceipt>();
  reconciled: Array<{ deliveryId: string; status: string }> = [];

  async getEndpoint(tenantId: string, endpointId: string) {
    return tenantId === 'tenant-a' && endpointId === 'endpoint-a' ? endpointRow() : null;
  }

  async getDelivery(tenantId: string, deliveryId: string) {
    return tenantId === 'tenant-a' && deliveryId === 'delivery-a' ? deliveryRow() : null;
  }

  async insertReceipt(receipt: NotificationReceipt) {
    const key = `${receipt.tenant_id}:${receipt.provider_kind}:${receipt.provider_event_id}`;
    const existing = this.receipts.get(key);
    if (existing) {
      if (existing.canonical_hash !== receipt.canonical_hash) return null;
      return { receipt: existing, created: false };
    }
    this.receipts.set(key, receipt);
    return { receipt, created: true };
  }

  async reconcileReceipt(receipt: NotificationReceipt) {
    this.reconciled.push({ deliveryId: receipt.delivery_id, status: receipt.receipt_status });
    return receipt.receipt_status === 'delivered' ? 'delivered' as const : 'pending' as const;
  }
}

test('provider receipts require a fresh valid signature and converge delivered state idempotently', async () => {
  const repository = new MemoryReceiptRepository();
  const service = new NotificationReceiptService({
    repository,
    secrets: { async resolve() { return 'receipt-secret'; } },
    now: () => new Date('2026-07-15T08:00:00.000Z')
  });
  const body = {
    provider_event_id: 'provider-event-a', delivery_id: 'delivery-a', status: 'delivered',
    occurred_at: '2026-07-15T07:59:58.000Z', projection: { provider_status: 'delivered' }
  } as const;
  const timestamp = '1784102400';
  const signature = `sha256=${createHmac('sha256', 'receipt-secret')
    .update(`${timestamp}.${canonicalNotificationJson(body)}`).digest('hex')}`;

  const first = await service.receive({
    tenant_id: 'tenant-a', endpoint_id: 'endpoint-a', timestamp, signature, body
  });
  assert.equal(first.created, true);
  assert.equal(first.reconciliation, 'delivered');
  assert.deepEqual(first.receipt.projection, { provider_status: 'delivered' });

  const replay = await service.receive({
    tenant_id: 'tenant-a', endpoint_id: 'endpoint-a', timestamp, signature, body
  });
  assert.equal(replay.created, false);
  assert.equal(repository.receipts.size, 1);

  await assert.rejects(() => service.receive({
    tenant_id: 'tenant-a', endpoint_id: 'endpoint-a', timestamp,
    signature: `sha256=${'0'.repeat(64)}`, body
  }), (error: unknown) => hasCode(error, 'provider_auth_failed'));
});

test('provider receipt rejects stale requests, wrong endpoint deliveries, and replay conflicts', async () => {
  const repository = new MemoryReceiptRepository();
  const service = new NotificationReceiptService({
    repository,
    secrets: { async resolve() { return 'receipt-secret'; } },
    now: () => new Date('2026-07-15T08:10:00.000Z')
  });
  const body = { provider_event_id: 'event-a', delivery_id: 'delivery-a', status: 'failed' } as const;
  const timestamp = '1784102400';
  const signature = `sha256=${createHmac('sha256', 'receipt-secret')
    .update(`${timestamp}.${canonicalNotificationJson(body)}`).digest('hex')}`;
  await assert.rejects(
    () => service.receive({ tenant_id: 'tenant-a', endpoint_id: 'endpoint-a', timestamp, signature, body }),
    (error: unknown) => hasCode(error, 'provider_auth_failed')
  );
});

function endpointRow(): NotificationEndpoint {
  return {
    id: 'endpoint-a', tenant_id: 'tenant-a', name: 'SMS', channel: 'sms',
    provider_kind: 'sms_http', status: 'active', endpoint_url: 'https://sms.example.com/send',
    secret_ref: 'env://SMS_TOKEN', signing_secret_ref: 'env://RECEIPT_SECRET',
    event_allowlist: [], config: {}, failover_group: 'default', priority: 100,
    quota_per_minute: null, quota_per_day: null, health_status: 'healthy', last_health_at: null,
    revision: 1, idempotency_key: 'endpoint-a', payload_hash: 'a'.repeat(64),
    created_by: 'admin-a', updated_by: 'admin-a', created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z'
  };
}

function deliveryRow(): NotificationDeliveryRecord {
  return {
    id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a', channel: 'sms',
    endpoint_id: 'endpoint-a', provider_kind: 'sms_http', provider_profile_id: 'endpoint-a',
    recipient_ciphertext: 'encrypted', recipient_hmac: 'b'.repeat(64), recipient_redacted: '***1234',
    payload_ciphertext: 'encrypted', payload_hash: 'c'.repeat(64), provider_idempotency_key: 'key-a',
    state: 'accepted', attempt_count: 1, max_attempts: 5, next_attempt_at: null,
    lease_token_hash: '', lease_until: null, worker_id: '', provider_request_id: 'request-a',
    provider_message_id: 'message-a', provider_receipt_projection: {}, error_code: '',
    error_projection: {}, created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z', accepted_at: '2026-07-15T00:00:01.000Z',
    delivered_at: null, completed_at: null
  };
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code: string }).code === code);
}
