import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NotificationDeliveryWorker,
  notificationDeliveryWorkerConfig
} from '../src/agent-runtime/converact/notifications/index.js';
import { startIveKitApplication } from '../src/agent-runtime/converact/application.js';
import { MemoryPg } from '../src/db-pg.js';

test('notification delivery worker config enables only with encryption keys or an explicit flag', () => {
  assert.equal(notificationDeliveryWorkerConfig({}).enabled, false);
  const keys = {
    OPC_IVEKIT_NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    OPC_IVEKIT_NOTIFICATION_HMAC_KEY: Buffer.alloc(32, 2).toString('base64')
  };
  const config = notificationDeliveryWorkerConfig({
    ...keys,
    OPC_IVEKIT_NOTIFICATION_BATCH_SIZE: '17',
    OPC_IVEKIT_NOTIFICATION_PARTITION_COUNT: '4',
    OPC_IVEKIT_NOTIFICATION_PARTITION_INDEX: '2',
    OPC_IVEKIT_NOTIFICATION_RETRY_DELAYS_MS: '1000,5000'
  });
  assert.equal(config.enabled, true);
  assert.equal(config.batch_size, 17);
  assert.equal(config.partition_count, 4);
  assert.equal(config.partition_index, 2);
  assert.equal(config.shard_ids.length, 256);
  assert.equal(config.shard_ids[0], 2);
  assert.equal(config.shard_ids.at(-1), 1022);
  assert.deepEqual(config.retry_delays_ms, [1_000, 5_000]);
  assert.throws(() => notificationDeliveryWorkerConfig({
    OPC_IVEKIT_NOTIFICATION_WORKER_ENABLED: '1'
  }));
  assert.throws(() => notificationDeliveryWorkerConfig({
    ...keys,
    OPC_IVEKIT_NOTIFICATION_PARTITION_COUNT: '2'
  }));
});

test('notification delivery worker coalesces concurrent runs and drains before stop', async () => {
  let calls = 0;
  let release: (() => void) | null = null;
  const worker = new NotificationDeliveryWorker({
    config: {
      enabled: true, interval_ms: 60_000, batch_size: 10,
      tenant_limit: 10, lease_ms: 30_000, retry_delays_ms: [1_000],
      partition_count: 1, partition_index: 0,
      shard_ids: Array.from({ length: 1024 }, (_, index) => index)
    },
    runBatch: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return {
        tenants: 0, claimed: 0, delivered: 0, accepted: 0,
        retry_wait: 0, uncertain: 0, failed: 0, dead_letter: 0
      };
    }
  });

  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release?.();
  await worker.stop();
  await first;
});

test('iveKit application owns notification worker lifecycle when configured', async () => {
  const events: string[] = [];
  const application = startIveKitApplication({
    pg: new MemoryPg(),
    env: {
      OPC_IVEKIT_NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      OPC_IVEKIT_NOTIFICATION_HMAC_KEY: Buffer.alloc(32, 2).toString('base64')
    },
    adapters: {
      startNotification: () => {
        events.push('start:notification');
        return { async stop() { events.push('stop:notification'); } };
      }
    }
  });
  await application.stop();
  assert.deepEqual(events, ['start:notification', 'stop:notification']);
});

test('iveKit application owns active notification health worker independently', async () => {
  const events: string[] = [];
  const application = startIveKitApplication({
    pg: new MemoryPg(),
    env: { OPC_IVEKIT_NOTIFICATION_HEALTH_WORKER_ENABLED: '1' },
    adapters: {
      startNotificationHealth: () => {
        events.push('start:notification-health');
        return { async stop() { events.push('stop:notification-health'); } };
      }
    }
  });
  await application.stop();
  assert.deepEqual(events, ['start:notification-health', 'stop:notification-health']);
});
