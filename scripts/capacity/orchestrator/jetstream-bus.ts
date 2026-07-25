import {
  AckPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager
} from '@nats-io/jetstream';
import {
  nanos,
  type Codec,
  type NatsConnection
} from '@nats-io/nats-core';
import {
  connect,
  type NodeConnectionOptions
} from '@nats-io/transport-node';

import {
  LoadRunControlError,
  type CapacityCommandBus,
  type CapacityCommandEnvelope,
  type CapacityStartShardCommand
} from './types.js';
import { validateStartShardCommand } from './worker.js';

export class JetStreamCapacityCommandBus implements CapacityCommandBus {
  readonly #connection: NatsConnection;
  readonly #streamName: string;
  readonly #subjectPrefix: string;
  readonly #codec = jsonCodec<CapacityStartShardCommand>();

  private constructor(input: {
    connection: NatsConnection;
    stream_name: string;
    subject_prefix: string;
  }) {
    this.#connection = input.connection;
    this.#streamName = input.stream_name;
    this.#subjectPrefix = input.subject_prefix;
  }

  static async connect(input: {
    connection_options: NodeConnectionOptions;
    stream_replicas: number;
    stream_name?: string;
    subject_prefix?: string;
    max_age_days?: number;
  }): Promise<JetStreamCapacityCommandBus> {
    const streamName = input.stream_name || 'IVEKIT_CAPACITY_COMMANDS';
    const subjectPrefix = input.subject_prefix || 'ivekit.capacity.command';
    validStreamName(streamName);
    validSubjectPrefix(subjectPrefix);
    const maxAgeDays = boundedInteger(input.max_age_days ?? 7, 1, 365, 'max_age_days');
    const streamReplicas = validReplicaCount(input.stream_replicas);
    const connection = await connect(input.connection_options);
    const manager = await jetstreamManager(connection);
    try {
      try {
        const info = await manager.streams.info(streamName);
        assertCapacityStreamConfiguration(info.config, {
          subject: `${subjectPrefix}.>`,
          max_age: nanos(maxAgeDays * 86_400_000),
          num_replicas: streamReplicas
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await manager.streams.add({
          name: streamName,
          subjects: [`${subjectPrefix}.>`],
          retention: RetentionPolicy.Workqueue,
          storage: StorageType.File,
          max_age: nanos(maxAgeDays * 86_400_000),
          num_replicas: streamReplicas
        });
      }
      return new JetStreamCapacityCommandBus({
        connection,
        stream_name: streamName,
        subject_prefix: subjectPrefix
      });
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  async publish(command: CapacityCommandEnvelope): Promise<void> {
    if (!command.subject.startsWith(`${this.#subjectPrefix}.`)) {
      throw new LoadRunControlError('command_subject_invalid', 400);
    }
    await jetstream(this.#connection).publish(
      command.subject,
      this.#codec.encode(command.payload),
      { msgID: command.payload.command_id }
    );
  }

  async close(): Promise<void> {
    await this.#connection.drain();
  }

  get streamName(): string {
    return this.#streamName;
  }
}

export class JetStreamCapacityCommandConsumer {
  readonly #connection: NatsConnection;
  readonly #streamName: string;
  readonly #consumerName: string;
  readonly #codec = jsonCodec<unknown>();
  readonly #retryDelayMs: number;
  readonly #ackProgressIntervalMs: number;

  private constructor(input: {
    connection: NatsConnection;
    stream_name: string;
    consumer_name: string;
    retry_delay_ms: number;
    ack_progress_interval_ms: number;
  }) {
    this.#connection = input.connection;
    this.#streamName = input.stream_name;
    this.#consumerName = input.consumer_name;
    this.#retryDelayMs = input.retry_delay_ms;
    this.#ackProgressIntervalMs = input.ack_progress_interval_ms;
  }

  static async connect(input: {
    connection_options: NodeConnectionOptions;
    stream_name?: string;
    subject_prefix?: string;
    fleet_id: string;
    worker_id: string;
    consumer_name?: string;
    ack_wait_ms?: number;
    retry_delay_ms?: number;
    max_ack_pending?: number;
  }): Promise<JetStreamCapacityCommandConsumer> {
    const streamName = input.stream_name || 'IVEKIT_CAPACITY_COMMANDS';
    const prefix = input.subject_prefix || 'ivekit.capacity.command';
    validStreamName(streamName);
    validSubjectPrefix(prefix);
    const ackWaitMs = boundedInteger(input.ack_wait_ms ?? 30_000, 1_000, 300_000, 'ack_wait_ms');
    const retryDelayMs = boundedInteger(input.retry_delay_ms ?? 1_000, 100, 60_000, 'retry_delay_ms');
    const maxAckPending = boundedInteger(input.max_ack_pending ?? 128, 1, 10_000, 'max_ack_pending');
    const consumerName = input.consumer_name ||
      `capacity-${durableToken(input.fleet_id)}-${durableToken(input.worker_id)}`;
    const filterSubject = `${prefix}.${input.fleet_id}.${input.worker_id}`;
    const connection = await connect(input.connection_options);
    const manager = await jetstreamManager(connection);
    try {
      try {
        const info = await manager.consumers.info(streamName, consumerName);
        assertCapacityConsumerConfiguration(info.config, {
          filter_subject: filterSubject,
          ack_wait: nanos(ackWaitMs),
          max_ack_pending: maxAckPending,
          max_deliver: 20
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await manager.consumers.add(streamName, {
          durable_name: consumerName,
          name: consumerName,
          ack_policy: AckPolicy.Explicit,
          ack_wait: nanos(ackWaitMs),
          max_deliver: 20,
          max_ack_pending: maxAckPending,
          filter_subject: filterSubject
        });
      }
      return new JetStreamCapacityCommandConsumer({
        connection,
        stream_name: streamName,
        consumer_name: consumerName,
        retry_delay_ms: retryDelayMs,
        ack_progress_interval_ms: Math.max(100, Math.floor(ackWaitMs / 3))
      });
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  async run(
    handler: { handle(command: CapacityStartShardCommand): Promise<void> },
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    const consumer = await jetstream(this.#connection)
      .consumers.get(this.#streamName, this.#consumerName);
    const messages = await consumer.consume();
    const stop = () => {
      void messages.close();
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    try {
      for await (const message of messages) {
        const progress = setInterval(() => {
          try {
            message.working();
          } catch {
            // The handler's PostgreSQL lease remains authoritative.
          }
        }, this.#ackProgressIntervalMs);
        progress.unref?.();
        try {
          const command = validateStartShardCommand(this.#codec.decode(message.data));
          await handler.handle(command);
          message.ack();
        } catch (error) {
          if (isPoisonCommand(error)) message.term(errorCode(error));
          else message.nak(this.#retryDelayMs);
        } finally {
          clearInterval(progress);
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', stop);
    }
  }

  async close(): Promise<void> {
    await this.#connection.drain();
  }
}

function jsonCodec<T>(): Codec<T> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    encode(value: T): Uint8Array {
      return encoder.encode(JSON.stringify(value));
    },
    decode(data: Uint8Array): T {
      return JSON.parse(decoder.decode(data)) as T;
    }
  };
}

export function assertCapacityStreamConfiguration(
  config: {
    subjects: string[];
    retention: RetentionPolicy;
    storage: StorageType;
    max_age: number;
    num_replicas: number;
  },
  expected: { subject: string; max_age: number; num_replicas: number }
): void {
  if (config.subjects.length !== 1 ||
      config.subjects[0] !== expected.subject ||
      config.retention !== RetentionPolicy.Workqueue ||
      config.storage !== StorageType.File ||
      config.max_age !== expected.max_age ||
      config.num_replicas !== expected.num_replicas) {
    throw new LoadRunControlError('capacity_stream_configuration_mismatch', 409);
  }
}

function validReplicaCount(value: number): number {
  if (value !== 1 && value !== 3 && value !== 5) {
    throw new LoadRunControlError('stream_replicas_invalid', 400);
  }
  return value;
}

export function assertCapacityConsumerConfiguration(
  config: {
    filter_subject?: string;
    ack_policy: AckPolicy;
    ack_wait?: number;
    max_ack_pending?: number;
    max_deliver?: number;
  },
  expected: {
    filter_subject: string;
    ack_wait: number;
    max_ack_pending: number;
    max_deliver: number;
  }
): void {
  if (config.filter_subject !== expected.filter_subject ||
      config.ack_policy !== AckPolicy.Explicit ||
      config.ack_wait !== expected.ack_wait ||
      config.max_ack_pending !== expected.max_ack_pending ||
      config.max_deliver !== expected.max_deliver) {
    throw new LoadRunControlError('capacity_consumer_configuration_mismatch', 409);
  }
}

function durableToken(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
  if (!normalized) throw new LoadRunControlError('consumer_name_invalid', 400);
  return normalized;
}

function isNotFound(error: unknown): boolean {
  const value = error as { code?: unknown; api_error?: { code?: unknown } };
  return Number(value?.code || value?.api_error?.code || 0) === 404;
}

function isPoisonCommand(error: unknown): boolean {
  return error instanceof LoadRunControlError && [
    'command_payload_invalid',
    'command_assignment_invalid',
    'command_target_mismatch',
    'command_lease_expired',
    'shard_id_invalid',
    'lease_epoch_invalid',
    'timestamp_invalid'
  ].includes(error.code);
}

function validStreamName(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new LoadRunControlError('stream_name_invalid', 400);
  }
}

function validSubjectPrefix(value: string): void {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value)) {
    throw new LoadRunControlError('subject_prefix_invalid', 400);
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new LoadRunControlError(`${field}_invalid`, 400);
  }
  return value;
}

function errorCode(error: unknown): string {
  const code = String((error as { code?: unknown })?.code || 'capacity_command_rejected');
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(code)
    ? code
    : 'capacity_command_rejected';
}
