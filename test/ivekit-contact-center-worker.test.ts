import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
      return [{ id: 'entry-timeout', state: 'timed_out' }] as never;
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
    callback_retry_delay_ms: 30_000, overflow_retry_delay_ms: 45_000,
    list_tenants: async () => ['tenant-a'],
    create_service: () => service,
    create_callback_service: () => ({
      async processDue(input) {
        operations.push(`callbacks:${input.tenant_id}:${input.retry_delay_ms}`);
        return { processed: 2, started: 1, retried: 1, failed: 0 };
      },
      async reconcile(input) {
        operations.push(`reconcile:${input.tenant_id}:${input.limit}`);
        return { scanned: 1, updated: 1 };
      }
    }),
    create_overflow_service: () => ({
      async processDue(input) {
        operations.push(`overflow:${input.tenant_id}:${input.retry_delay_ms}`);
        return { processed: 3, completed: 1, retried: 1, failed: 1 };
      }
    }),
    idempotency_key: (_tenantId, queueId) => `worker:${queueId}`
  });

  assert.deepEqual(summary, {
    tenants: 1, failed_tenants: 0, expired_offers: 2,
    timed_out_entries: 1, overflow_scheduled: 0,
    overflows_processed: 3, overflows_completed: 1,
    overflows_retried: 1, overflows_failed: 1,
    queues_scanned: 2, offers_created: 1,
    callbacks_processed: 2, callbacks_started: 1, callbacks_retried: 1,
    callbacks_failed: 0, callbacks_reconciled: 1
  });
  assert.deepEqual(operations, [
    'expire:tenant-a:20', 'timeout:tenant-a:20',
    'overflow:tenant-a:45000',
    'callbacks:tenant-a:30000', 'reconcile:tenant-a:20', 'list:tenant-a:20',
    'offer:queue-a:25', 'offer:queue-b:25'
  ]);
});

test('Contact Center maintenance batch isolates a tenant failure', async () => {
  const summary = await runContactCenterMaintenanceBatch({
    pg: new MemoryPg(), tenant_limit: 10, batch_size: 20, offer_ttl_seconds: 20,
    callback_retry_delay_ms: 30_000, overflow_retry_delay_ms: 30_000,
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
    create_callback_service: () => ({
      async processDue() { return { processed: 0, started: 0, retried: 0, failed: 0 }; },
      async reconcile() { return { scanned: 0, updated: 0 }; }
    }),
    create_overflow_service: () => ({
      async processDue() { return { processed: 0, completed: 0, retried: 0, failed: 0 }; }
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
      batch_size: 20, offer_ttl_seconds: 20, callback_retry_delay_ms: 30_000,
      overflow_retry_delay_ms: 30_000
    },
    async run_batch() {
      calls += 1;
      await blocked;
      return {
        tenants: 0, failed_tenants: 0, expired_offers: 0,
        timed_out_entries: 0, overflow_scheduled: 0,
        overflows_processed: 0, overflows_completed: 0,
        overflows_retried: 0, overflows_failed: 0,
        queues_scanned: 0, offers_created: 0,
        callbacks_processed: 0, callbacks_started: 0, callbacks_retried: 0,
        callbacks_failed: 0, callbacks_reconciled: 0
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
    batch_size: 100, offer_ttl_seconds: 20, callback_retry_delay_ms: 30_000,
    overflow_retry_delay_ms: 30_000
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

test('Contact Center callback and overflow retry configuration is wired across deployment surfaces', () => {
  for (const path of [
    '.env.example',
    'infra/env.example',
    'infra/ivekit/env.example',
    'services/ivekit-service/env.example',
    'infra/ivekit/docker-compose.yml',
    'infra/docker-compose.production.yml',
    'services/ivekit-service/docker-compose.yml',
    'infra/k8s/templates/opc-deployment.yaml'
  ]) {
    assert.match(
      readFileSync(path, 'utf8'),
      /OPC_IVEKIT_CONTACT_CENTER_CALLBACK_RETRY_DELAY_MS/,
      path
    );
    assert.match(
      readFileSync(path, 'utf8'),
      /OPC_IVEKIT_CONTACT_CENTER_OVERFLOW_RETRY_DELAY_MS/,
      path
    );
  }
  assert.match(readFileSync('infra/k8s/values.yaml', 'utf8'), /callbackRetryDelayMs: "30000"/);
  assert.match(readFileSync('infra/k8s/values.yaml', 'utf8'), /overflowRetryDelayMs: "30000"/);
});
