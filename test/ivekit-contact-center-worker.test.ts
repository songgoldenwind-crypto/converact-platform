import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactCenterMaintenanceWorker,
  contactCenterMaintenanceWorkerConfig,
  runContactCenterMaintenanceBatch,
  type ContactCenterMaintenanceService
} from '../src/agent-runtime/ivekit/contact-center/index.js';
import { MemoryPg } from '../src/db-pg.js';

test('Contact Center maintenance batch expires, times out, then offers per tenant', async () => {
  const operations: string[] = [];
  const service: ContactCenterMaintenanceService = {
    async expireOffers(input) {
      operations.push(`expire:${input.tenant_id}:${input.limit}`);
      return 2;
    },
    async timeoutWaitingEntries(input) {
      operations.push(`timeout:${input.tenant_id}:${input.limit}`);
      return [{ id: 'entry-timeout' }] as never;
    },
    async listRoutableQueueIds(input) {
      operations.push(`list:${input.tenant_id}:${input.limit}`);
      return ['queue-a', 'queue-b'];
    },
    async offerNext(input) {
      operations.push(`offer:${input.queue_id}:${input.offer_ttl_seconds}`);
      return input.queue_id === 'queue-a' ? { assignment: { id: 'assignment-a' } } as never : null;
    }
  };

  const summary = await runContactCenterMaintenanceBatch({
    pg: new MemoryPg(), now: new Date('2026-07-13T09:00:00.000Z'),
    tenant_limit: 10, batch_size: 20, offer_ttl_seconds: 25,
    list_tenants: async () => ['tenant-a'],
    create_service: () => service,
    idempotency_key: (_tenantId, queueId) => `worker:${queueId}`
  });

  assert.deepEqual(summary, {
    tenants: 1, failed_tenants: 0, expired_offers: 2,
    timed_out_entries: 1, queues_scanned: 2, offers_created: 1
  });
  assert.deepEqual(operations, [
    'expire:tenant-a:20', 'timeout:tenant-a:20', 'list:tenant-a:20',
    'offer:queue-a:25', 'offer:queue-b:25'
  ]);
});

test('Contact Center maintenance batch isolates a tenant failure', async () => {
  const summary = await runContactCenterMaintenanceBatch({
    pg: new MemoryPg(), tenant_limit: 10, batch_size: 20, offer_ttl_seconds: 20,
    list_tenants: async () => ['tenant-bad', 'tenant-good'],
    create_service: (tenantId) => ({
      async expireOffers() {
        if (tenantId === 'tenant-bad') throw new Error('database unavailable');
        return 1;
      },
      async timeoutWaitingEntries() { return []; },
      async listRoutableQueueIds() { return []; },
      async offerNext() { return null; }
    }),
    on_tenant_error: () => undefined
  });
  assert.equal(summary.tenants, 2);
  assert.equal(summary.failed_tenants, 1);
  assert.equal(summary.expired_offers, 1);
});

test('Contact Center maintenance worker coalesces concurrent runs and stops cleanly', async () => {
  let release!: () => void;
  let calls = 0;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const worker = new ContactCenterMaintenanceWorker({
    config: {
      enabled: true, interval_ms: 1_000, tenant_limit: 10,
      batch_size: 20, offer_ttl_seconds: 20
    },
    async run_batch() {
      calls += 1;
      await blocked;
      return {
        tenants: 0, failed_tenants: 0, expired_offers: 0,
        timed_out_entries: 0, queues_scanned: 0, offers_created: 0
      };
    }
  });
  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(first, second);
  release();
  await first;
  await worker.stop();
  assert.equal(calls, 1);
});

test('Contact Center maintenance worker configuration is optional and bounded', () => {
  assert.deepEqual(contactCenterMaintenanceWorkerConfig({}), {
    enabled: false, interval_ms: 1_000, tenant_limit: 100,
    batch_size: 100, offer_ttl_seconds: 20
  });
  assert.equal(contactCenterMaintenanceWorkerConfig({
    OPC_IVEKIT_CONTACT_CENTER_WORKER_ENABLED: '1'
  }).enabled, true);
  assert.throws(() => contactCenterMaintenanceWorkerConfig({
    OPC_IVEKIT_CONTACT_CENTER_WORKER_ENABLED: 'yes'
  }), /must be 0 or 1/);
  assert.throws(() => contactCenterMaintenanceWorkerConfig({
    OPC_IVEKIT_CONTACT_CENTER_BATCH_SIZE: '0'
  }), /must be an integer/);
});
