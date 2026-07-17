import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runNotificationReceiptReconciliationBatch,
  type NotificationReceipt,
  type NotificationReceiptReconciliationRepository
} from '../src/agent-runtime/ivekit/notifications/index.js';

class MemoryReceiptReconciliationRepository implements NotificationReceiptReconciliationRepository {
  async listReceiptTenants() { return ['tenant-a']; }
  async listPendingReceipts() {
    return [receipt('receipt-a', 'delivered'), receipt('receipt-b', 'failed')];
  }
  async reconcileReceipt(item: NotificationReceipt) {
    return item.receipt_status === 'delivered' ? 'delivered' as const : 'failed' as const;
  }
}

test('receipt reconciliation batch converges fast callbacks after delivery worker races', async () => {
  const summary = await runNotificationReceiptReconciliationBatch({
    repository: new MemoryReceiptReconciliationRepository(),
    now: new Date('2026-07-15T08:00:00.000Z'), tenant_limit: 10, batch_size: 20
  });
  assert.deepEqual(summary, {
    tenants: 1, receipts: 2, delivered: 1, failed: 1, pending: 0, unchanged: 0
  });
});

function receipt(id: string, status: 'delivered' | 'failed'): NotificationReceipt {
  return {
    id, tenant_id: 'tenant-a', delivery_id: `delivery-${id}`, provider_kind: 'sms_http',
    provider_event_id: `event-${id}`, receipt_status: status, canonical_hash: 'a'.repeat(64),
    projection: {}, occurred_at: null, received_at: '2026-07-15T07:59:59.000Z'
  };
}
