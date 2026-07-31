import type { NotificationReceiptReconciliationRepository } from './ports.js';
import { observeNotificationReceiptReconciliation } from './metrics.js';

export interface NotificationReceiptReconciliationBatchInput {
  repository: NotificationReceiptReconciliationRepository;
  now: Date;
  tenant_limit: number;
  batch_size: number;
}

export interface NotificationReceiptReconciliationBatchSummary {
  tenants: number;
  receipts: number;
  delivered: number;
  failed: number;
  pending: number;
  unchanged: number;
}

export async function runNotificationReceiptReconciliationBatch(
  input: NotificationReceiptReconciliationBatchInput
): Promise<NotificationReceiptReconciliationBatchSummary> {
  if (!Number.isFinite(input.now.getTime())) throw new Error('valid now is required');
  const tenantLimit = bounded(input.tenant_limit, 1, 1000);
  const batchSize = bounded(input.batch_size, 1, 500);
  const tenants = await input.repository.listReceiptTenants(tenantLimit);
  const summary: NotificationReceiptReconciliationBatchSummary = {
    tenants: tenants.length, receipts: 0, delivered: 0, failed: 0, pending: 0, unchanged: 0
  };
  for (const tenantId of tenants) {
    const receipts = await input.repository.listPendingReceipts(tenantId, batchSize);
    summary.receipts += receipts.length;
    for (const receipt of receipts) {
      const outcome = await input.repository.reconcileReceipt(receipt);
      summary[outcome] += 1;
      observeNotificationReceiptReconciliation(outcome);
    }
  }
  return summary;
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`value must be an integer between ${min} and ${max}`);
  }
  return value;
}
