import assert from 'node:assert/strict';
import test from 'node:test';

import { ShardLeaseRegistry } from '../scripts/capacity/shard-lease.js';

test('shard lease acquisition, renewal and takeover fence stale workers', () => {
  const registry = new ShardLeaseRegistry(['interaction/tinode_im/0-1000']);
  const first = registry.acquire({
    shardId: 'interaction/tinode_im/0-1000',
    workerId: 'tinode-worker-1',
    nowMs: 1_000,
    ttlMs: 5_000
  });

  assert.equal(first.lease_epoch, 1);
  assert.equal(first.expires_at_ms, 6_000);
  assert.doesNotThrow(() => registry.assertMayEmit(first.shard_id, first.worker_id, 1, 5_999));
  assert.throws(
    () => registry.acquire({
      shardId: first.shard_id,
      workerId: 'tinode-worker-2',
      nowMs: 5_000,
      ttlMs: 5_000
    }),
    /active lease/i
  );

  const renewed = registry.renew({
    shardId: first.shard_id,
    workerId: first.worker_id,
    leaseEpoch: first.lease_epoch,
    nowMs: 5_000,
    ttlMs: 5_000
  });
  assert.equal(renewed.lease_epoch, first.lease_epoch);
  assert.equal(renewed.expires_at_ms, 10_000);

  const takeover = registry.acquire({
    shardId: first.shard_id,
    workerId: 'tinode-worker-2',
    nowMs: 10_001,
    ttlMs: 5_000
  });
  assert.equal(takeover.lease_epoch, 2);
  assert.throws(
    () => registry.assertMayEmit(first.shard_id, first.worker_id, first.lease_epoch, 10_002),
    /stale|owner/i
  );
  assert.doesNotThrow(() => registry.assertMayEmit(
    takeover.shard_id,
    takeover.worker_id,
    takeover.lease_epoch,
    10_002
  ));
});

test('unknown shards, expired leases and invalid TTL fail closed', () => {
  const registry = new ShardLeaseRegistry(['known']);
  assert.throws(
    () => registry.acquire({ shardId: 'missing', workerId: 'worker', nowMs: 0, ttlMs: 1000 }),
    /unknown shard/i
  );
  assert.throws(
    () => registry.acquire({ shardId: 'known', workerId: 'worker', nowMs: 0, ttlMs: 0 }),
    /ttl/i
  );

  const lease = registry.acquire({ shardId: 'known', workerId: 'worker', nowMs: 0, ttlMs: 1000 });
  assert.throws(
    () => registry.assertMayEmit('known', 'worker', lease.lease_epoch, 1000),
    /expired/i
  );
});

