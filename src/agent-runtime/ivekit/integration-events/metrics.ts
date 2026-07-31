import { Counter, Gauge } from 'prom-client';

import { metricsRegistry } from '../../../metrics.js';
import type { IveKitEventWebhookBatchSummary } from './worker.js';

const operations = new Counter({
  name: 'opc_ivekit_event_webhook_operations_total',
  help: 'Total iveKit integration event webhook worker operations',
  labelNames: ['result'],
  registers: [metricsRegistry]
});

const oldestEventAge = new Gauge({
  name: 'opc_ivekit_event_webhook_oldest_event_age_seconds',
  help: 'Age of the oldest tenant event observed by the latest webhook worker batch',
  registers: [metricsRegistry]
});

export const integrationEventMetricDefinitions = [
  { name: 'opc_ivekit_event_webhook_operations_total', labels: ['result'] },
  { name: 'opc_ivekit_event_webhook_oldest_event_age_seconds', labels: [] }
] as const;

export function observeIveKitEventWebhookBatch(result: IveKitEventWebhookBatchSummary): void {
  increment('claimed', result.claimed);
  increment('scanned', result.scanned);
  increment('projected', result.projected);
  increment('filtered', result.filtered);
  increment('failed', result.failed);
  increment('lease_lost', result.lease_lost);
  oldestEventAge.set(nonNegative(result.oldest_event_age_seconds));
}

export function observeIveKitEventWebhookWorkerError(): void {
  operations.labels('worker_error').inc();
}

function increment(result: string, value: number): void {
  if (Number.isFinite(value) && value > 0) operations.labels(result).inc(value);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
