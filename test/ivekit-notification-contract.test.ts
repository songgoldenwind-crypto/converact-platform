import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('machine-readable OpenAPI and operations runbook cover notification administration', () => {
  const yaml = readFileSync('docs/openapi.yaml', 'utf8');
  for (const marker of [
    '/api/ivekit/notifications/capabilities:',
    '/api/ivekit/notifications/endpoints:',
    '/api/ivekit/notifications/endpoints/{endpoint_id}/test:',
    '/api/ivekit/notifications/templates/{template_id}/versions:',
    '/api/ivekit/notifications/deliveries/{delivery_id}/retry:',
    '/api/ivekit/notifications/provider-receipts/{endpoint_id}:',
    'IveKitNotificationEndpoint:',
    'IveKitNotificationDelivery:'
  ]) assert.match(yaml, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker);

  const runbook = readFileSync('docs/ivekit-notification-operations-runbook.md', 'utf8');
  for (const marker of [
    'failed/dead_letter',
    'allow_uncertain',
    'OPC_IVEKIT_NOTIFICATION_ENCRYPTION_KEY',
    'OPC_IVEKIT_NOTIFICATION_HEALTH_WORKER_ENABLED',
    'opc_ivekit_notification_queue_oldest_age_seconds',
    '真实 SMTP',
    'not_run'
  ]) assert.match(runbook, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker);
});
