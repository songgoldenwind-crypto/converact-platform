import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCapacityDispatcherSchema,
  capacityDispatcherConfig
} from '../scripts/ivekit-capacity-dispatcher.js';

test('capacity dispatcher config is bounded and does not default missing infrastructure', () => {
  const config = capacityDispatcherConfig({
    OPC_DATABASE_URL: 'postgresql://ivekit:test@postgres/ivekit',
    NATS_URL: 'nats://nats-a:4222,nats://nats-b:4222',
    OPC_IVEKIT_CAPACITY_DISPATCHER_ID: 'dispatcher-a',
    OPC_IVEKIT_CAPACITY_DISPATCH_INTERVAL_MS: '500',
    OPC_IVEKIT_CAPACITY_DISPATCH_LEASE_MS: '15000',
    OPC_IVEKIT_CAPACITY_DISPATCH_BATCH_SIZE: '250'
  });
  assert.deepEqual(config, {
    database_url: 'postgresql://ivekit:test@postgres/ivekit',
    nats_servers: ['nats://nats-a:4222', 'nats://nats-b:4222'],
    dispatcher_id: 'dispatcher-a',
    interval_ms: 500,
    lease_ttl_ms: 15_000,
    batch_size: 250
  });

  assert.throws(() => capacityDispatcherConfig({}), /database/i);
  assert.throws(() => capacityDispatcherConfig({
    OPC_DATABASE_URL: 'postgresql://postgres/ivekit',
    NATS_URL: 'nats://nats:4222',
    OPC_IVEKIT_CAPACITY_DISPATCHER_ID: 'dispatcher-a',
    OPC_IVEKIT_CAPACITY_DISPATCH_LEASE_MS: '999'
  }), /numeric/i);
});

test('capacity dispatcher refuses to start before migration 077 exists', async () => {
  await assert.rejects(
    () => assertCapacityDispatcherSchema({
      async query() {
        return { rows: [{ outbox: null }] };
      }
    }),
    /migration 077/i
  );
  await assert.doesNotReject(
    () => assertCapacityDispatcherSchema({
      async query() {
        return { rows: [{ outbox: 'ivekit_capacity_command_outbox' }] };
      }
    })
  );
});
