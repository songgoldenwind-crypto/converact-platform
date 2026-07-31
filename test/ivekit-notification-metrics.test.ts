import assert from 'node:assert/strict';
import test from 'node:test';

import { notificationMetricDefinitions } from '../src/agent-runtime/ivekit/notifications/index.js';

test('notification metrics cover delivery, provider governance, receipts, queue and leases', () => {
  const names = notificationMetricDefinitions.map((metric) => metric.name);
  for (const name of [
    'opc_ivekit_notifications_created_total',
    'opc_ivekit_notification_delivery_attempts_total',
    'opc_ivekit_notification_provider_reservations_total',
    'opc_ivekit_notification_provider_results_total',
    'opc_ivekit_notification_receipt_reconciliations_total',
    'opc_ivekit_notification_queue_depth',
    'opc_ivekit_notification_queue_oldest_age_seconds',
    'opc_ivekit_notification_lease_lost_total',
    'opc_ivekit_notification_health_probes_total',
    'opc_ivekit_notification_health_probe_duration_seconds'
  ]) assert.equal(names.includes(name), true, name);
  assert.equal(notificationMetricDefinitions.some((metric) => metric.labels.includes('tenant_id')), false);
});
