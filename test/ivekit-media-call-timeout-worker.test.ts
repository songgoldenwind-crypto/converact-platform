import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MediaCallService } from '../src/agent-runtime/livekit/media-call-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import {
  mediaCallTimeoutWorkerConfig,
  runMediaCallTimeoutBatch
} from '../src/agent-runtime/livekit/media-call-timeout-worker.js';
import { MemoryPg } from '../src/db-pg.js';

test('media call timeout worker discovers tenants and expires due ringing calls', async () => {
  const pg = new MemoryPg();
  const ringNow = new Date('2026-07-12T10:00:00.000Z');
  const service = new MediaCallService(new MediaCallStore(pg), { now: () => ringNow });
  const created = await service.createCall({
    tenant_id: 'tenant-timeout-worker', initiated_by: 'host-1', media: 'video',
    participant_identities: ['guest-1'],
    business_ref: { tenant_id: 'tenant-timeout-worker', type: 'order', id: 'order-1', metadata: {} },
    ring_timeout_seconds: 30
  });
  await service.transition({
    tenant_id: 'tenant-timeout-worker', call_id: created.call.id, action: 'ring',
    actor_identity: 'host-1', idempotency_key: 'worker-ring'
  });
  const published: string[] = [];
  const summary = await runMediaCallTimeoutBatch({
    pg,
    now: new Date('2026-07-12T10:00:31.000Z'),
    tenantLimit: 100,
    batchSize: 25,
    onTimedOut: (snapshot) => { published.push(snapshot.call.id); }
  });

  assert.deepEqual(summary, { tenants: 1, scanned: 1, timed_out: 1, skipped: 0 });
  assert.deepEqual(published, [created.call.id]);
  assert.equal((await service.getCall('tenant-timeout-worker', created.call.id))?.call.status, 'timed_out');
});

test('media call timeout worker config is bounded and enabled by default', () => {
  assert.deepEqual(mediaCallTimeoutWorkerConfig({}), {
    enabled: true,
    intervalMs: 1_000,
    batchSize: 50,
    tenantLimit: 100
  });
  assert.throws(
    () => mediaCallTimeoutWorkerConfig({ OPC_MEDIA_CALL_TIMEOUT_INTERVAL_MS: '10' }),
    /between 250 and 60000/
  );
  assert.equal(mediaCallTimeoutWorkerConfig({ OPC_MEDIA_CALL_TIMEOUT_WORKER_ENABLED: '0' }).enabled, false);
});
