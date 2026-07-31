import assert from 'node:assert/strict';
import test from 'node:test';

import { publishNotificationTenantEvent } from '../src/agent-runtime/converact/notifications/realtime.js';

test('notification realtime publisher preserves audience and producer idempotency key', async () => {
  const calls: unknown[][] = [];
  await publishNotificationTenantEvent({
    tenant_id: 'tenant-a',
    type: 'notification.delivery.updated',
    data: { notification_id: 'notification-a', state: 'delivered' },
    audience_user_ids: ['user-a'],
    idempotency_key: 'notification:delivery:stable-key'
  }, async (...args) => {
    calls.push(args);
  });

  assert.deepEqual(calls, [[
    'tenant-a',
    ['user-a'],
    'notification.delivery.updated',
    { notification_id: 'notification-a', state: 'delivered' },
    { idempotency_key: 'notification:delivery:stable-key' }
  ]]);
});
