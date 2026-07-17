import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AckPolicy,
  RetentionPolicy,
  StorageType,
  nanos
} from 'nats';

import {
  assertCapacityConsumerConfiguration,
  assertCapacityStreamConfiguration,
  LoadRunControlError
} from '../scripts/capacity/orchestrator/index.js';

test('existing JetStream stream must match bounded durable command configuration', () => {
  const expected = {
    subject: 'ivekit.capacity.command.>',
    max_age: nanos(7 * 86_400_000)
  };
  assert.doesNotThrow(() => assertCapacityStreamConfiguration({
    subjects: [expected.subject],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    max_age: expected.max_age
  }, expected));
  assert.throws(() => assertCapacityStreamConfiguration({
    subjects: [expected.subject],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    max_age: nanos(1_000)
  }, expected), (error: unknown) =>
    error instanceof LoadRunControlError &&
    error.code === 'capacity_stream_configuration_mismatch'
  );
});

test('existing JetStream consumer must match ACK, redelivery and pressure bounds', () => {
  const expected = {
    filter_subject: 'ivekit.capacity.command.tinode.worker-a',
    ack_wait: nanos(30_000),
    max_ack_pending: 128,
    max_deliver: 20
  };
  assert.doesNotThrow(() => assertCapacityConsumerConfiguration({
    filter_subject: expected.filter_subject,
    ack_policy: AckPolicy.Explicit,
    ack_wait: expected.ack_wait,
    max_ack_pending: expected.max_ack_pending,
    max_deliver: expected.max_deliver
  }, expected));
  assert.throws(() => assertCapacityConsumerConfiguration({
    filter_subject: expected.filter_subject,
    ack_policy: AckPolicy.Explicit,
    ack_wait: expected.ack_wait,
    max_ack_pending: 10_000,
    max_deliver: expected.max_deliver
  }, expected), (error: unknown) =>
    error instanceof LoadRunControlError &&
    error.code === 'capacity_consumer_configuration_mismatch'
  );
});
