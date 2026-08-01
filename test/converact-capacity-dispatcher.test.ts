import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCapacityDispatcherSchema,
  capacityDispatcherConfig
} from '../scripts/converact-capacity-dispatcher.js';

test('capacity dispatcher config is bounded and does not default missing infrastructure', () => {
  const config = capacityDispatcherConfig({
    CONVERACT_DATABASE_URL: 'postgresql://ivekit:test@postgres/ivekit',
    NATS_URL: 'tls://nats-a:4222,tls://nats-b:4222',
    NATS_USER: 'capacity-dispatcher',
    NATS_PASSWORD: 'test-secret',
    NATS_TLS_MODE: 'required',
    NATS_TLS_CA_FILE: '/etc/nats/tls/ca.crt',
    NATS_TLS_CERT_FILE: '/etc/nats/tls/tls.crt',
    NATS_TLS_KEY_FILE: '/etc/nats/tls/tls.key',
    CONVERACT_FABRIC_CAPACITY_NATS_STREAM_REPLICAS: '3',
    CONVERACT_FABRIC_CAPACITY_DISPATCHER_ID: 'dispatcher-a',
    CONVERACT_FABRIC_CAPACITY_DISPATCH_INTERVAL_MS: '500',
    CONVERACT_FABRIC_CAPACITY_DISPATCH_LEASE_MS: '15000',
    CONVERACT_FABRIC_CAPACITY_DISPATCH_BATCH_SIZE: '250'
  });
  assert.equal(config.database_url, 'postgresql://ivekit:test@postgres/ivekit');
  assert.deepEqual(config.nats.servers, ['tls://nats-a:4222', 'tls://nats-b:4222']);
  assert.equal(config.nats.name, 'dispatcher-a');
  assert.equal(config.nats.user, 'capacity-dispatcher');
  assert.equal(config.nats.pass, 'test-secret');
  assert.deepEqual(config.nats.tls, {
    rejectUnauthorized: true,
    caFile: '/etc/nats/tls/ca.crt',
    certFile: '/etc/nats/tls/tls.crt',
    keyFile: '/etc/nats/tls/tls.key'
  });
  assert.equal(config.nats_stream_replicas, 3);
  assert.equal(config.dispatcher_id, 'dispatcher-a');
  assert.equal(config.interval_ms, 500);
  assert.equal(config.lease_ttl_ms, 15_000);
  assert.equal(config.batch_size, 250);

  assert.throws(() => capacityDispatcherConfig({}), /database/i);
  assert.throws(() => capacityDispatcherConfig({
    CONVERACT_DATABASE_URL: 'postgresql://postgres/converact',
    NATS_URL: 'nats://nats:4222',
    CONVERACT_FABRIC_CAPACITY_NATS_STREAM_REPLICAS: '1',
    CONVERACT_FABRIC_CAPACITY_DISPATCHER_ID: 'dispatcher-a',
    CONVERACT_FABRIC_CAPACITY_DISPATCH_LEASE_MS: '999'
  }), /numeric/i);
  assert.throws(() => capacityDispatcherConfig({
    CONVERACT_DATABASE_URL: 'postgresql://postgres/converact',
    NATS_URL: 'nats://nats:4222',
    CONVERACT_FABRIC_CAPACITY_DISPATCHER_ID: 'dispatcher-a',
    CONVERACT_FABRIC_CAPACITY_NATS_STREAM_REPLICAS: '2'
  }), /replicas/i);
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
