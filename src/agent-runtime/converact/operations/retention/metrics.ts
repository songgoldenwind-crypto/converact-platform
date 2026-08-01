import { Counter } from 'prom-client';

import { metricsRegistry } from '../../../../metrics.js';
import type { ConveractFabricRetentionCategory } from './types.js';

const runs = new Counter({
  name: 'opc_ivekit_retention_runs_total',
  help: 'Total Converact Fabric retention run outcomes',
  labelNames: ['category', 'result'],
  registers: [metricsRegistry]
});

const records = new Counter({
  name: 'opc_ivekit_retention_records_total',
  help: 'Total Converact Fabric retention record outcomes',
  labelNames: ['category', 'result'],
  registers: [metricsRegistry]
});

export const converactFabricRetentionMetricDefinitions = [
  { name: 'opc_ivekit_retention_runs_total', labels: ['category', 'result'] },
  { name: 'opc_ivekit_retention_records_total', labels: ['category', 'result'] }
] as const;

export function observeConveractFabricRetentionRun(input: {
  category: ConveractFabricRetentionCategory;
  outcome: 'completed' | 'failed';
  summary: { deleted_count: number; held_count: number };
}): void {
  runs.labels(input.category, input.outcome).inc();
  if (input.summary.deleted_count) {
    records.labels(input.category, 'deleted').inc(input.summary.deleted_count);
  }
  if (input.summary.held_count) {
    records.labels(input.category, 'held').inc(input.summary.held_count);
  }
}
