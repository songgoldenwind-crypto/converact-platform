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
  type Msg,
  type NatsConnection,
  type Subscription
} from '@nats-io/nats-core';
import {
  connect,
  type NodeConnectionOptions
} from '@nats-io/transport-node';

import {
  DialogShadowError,
  assertDialogShadowPair,
  assertDialogShadowStreamEvidence,
  assertDialogShadowRecord,
  dialogShadowPairHash,
  dialogShadowRecordHash,
  type DialogShadowJournalPort,
  type DialogShadowPairReplicaAck,
  type DialogShadowRecord,
  type DialogShadowReplicaAck,
  type DialogShadowReplicaHealth,
  type DialogShadowReplicationBus,
  type DialogShadowStreamEvidence
} from './dialog-shadow.js';

export interface DialogShadowJetStreamEnvelope {
  schema_version: 1;
  origin_node_id: string;
  record_hash: string;
  ack_subject: string;
  record: DialogShadowRecord;
}

export interface DialogShadowPairJetStreamEnvelope {
  schema_version: 2;
  origin_node_id: string;
  pair_hash: string;
  record_hashes: [string, string];
  ack_subject: string;
  records: [DialogShadowRecord, DialogShadowRecord];
}

type DialogShadowAnyJetStreamEnvelope =
  | DialogShadowJetStreamEnvelope
  | DialogShadowPairJetStreamEnvelope;

export interface DialogShadowJetStreamPort {
  publish(input: {
    subject: string;
    message_id: string;
    envelope: DialogShadowJetStreamEnvelope;
  }): Promise<void>;
  collectAcks(input: {
    subject: string;
    record_hash: string;
    timeout_ms: number;
    minimum_acks: number;
  }): Promise<DialogShadowReplicaAck[]>;
  publishPair(input: {
    subject: string;
    message_id: string;
    envelope: DialogShadowPairJetStreamEnvelope;
  }): Promise<void>;
  collectPairAcks(input: {
    subject: string;
    pair_hash: string;
    timeout_ms: number;
    minimum_acks: number;
  }): Promise<DialogShadowPairReplicaAck[]>;
  replicaHealth(input: {
    cell_id: string;
    timeout_ms: number;
  }): Promise<DialogShadowReplicaHealth[]>;
}

export class JetStreamDialogShadowReplicationBus
implements DialogShadowReplicationBus {
  readonly #port: DialogShadowJetStreamPort;
  readonly #cellId: string;
  readonly #originNodeId: string;
  readonly #subjectPrefix: string;
  readonly #ackTimeoutMs: number;
  readonly #minimumRemoteAcks: number;

  constructor(input: {
    port: DialogShadowJetStreamPort;
    cell_id: string;
    origin_node_id: string;
    subject_prefix?: string;
    ack_timeout_ms?: number;
    minimum_remote_acks?: number;
  }) {
    this.#port = input.port;
    this.#cellId = token(input.cell_id, 'cell_id');
    this.#originNodeId = token(input.origin_node_id, 'origin_node_id');
    this.#subjectPrefix = subjectPrefix(
      input.subject_prefix ?? 'ivekit.dialog_shadow'
    );
    this.#ackTimeoutMs = integer(
      input.ack_timeout_ms ?? 500,
      50,
      10_000,
      'ack_timeout_ms'
    );
    this.#minimumRemoteAcks = integer(
      input.minimum_remote_acks ?? 1,
      1,
      15,
      'minimum_remote_acks'
    );
  }

  async replicate(
    value: DialogShadowRecord,
    expectedHash: string
  ): Promise<DialogShadowReplicaAck[]> {
    const record = assertDialogShadowRecord(value);
    if (record.cell_id !== this.#cellId) {
      throw new Error('dialog_shadow_cell_mismatch');
    }
    const hash = dialogShadowRecordHash(record);
    if (hash !== expectedHash) {
      throw new Error('dialog_shadow_record_hash_mismatch');
    }
    const acknowledgementSubject =
      `${this.#subjectPrefix}.${this.#cellId}.acks.${hash}`;
    const collecting = this.#port.collectAcks({
      subject: acknowledgementSubject,
      record_hash: hash,
      timeout_ms: this.#ackTimeoutMs,
      minimum_acks: this.#minimumRemoteAcks
    });
    await this.#port.publish({
      subject: `${this.#subjectPrefix}.${this.#cellId}.records`,
      message_id: `${this.#cellId}:${hash}`,
      envelope: {
        schema_version: 1,
        origin_node_id: this.#originNodeId,
        record_hash: hash,
        ack_subject: acknowledgementSubject,
        record
      }
    });
    return collecting;
  }

  async replicatePair(
    values: readonly [DialogShadowRecord, DialogShadowRecord],
    expectedHash: string
  ): Promise<DialogShadowPairReplicaAck[]> {
    const records = assertDialogShadowPair(values);
    if (records.some((record) => record.cell_id !== this.#cellId)) {
      throw new Error('dialog_shadow_cell_mismatch');
    }
    const pairHash = dialogShadowPairHash(records);
    if (pairHash !== expectedHash) {
      throw new Error('dialog_shadow_pair_hash_mismatch');
    }
    const recordHashes = records.map(dialogShadowRecordHash).sort() as
      [string, string];
    const acknowledgementSubject =
      `${this.#subjectPrefix}.${this.#cellId}.pair_acks.${pairHash}`;
    const collecting = this.#port.collectPairAcks({
      subject: acknowledgementSubject,
      pair_hash: pairHash,
      timeout_ms: this.#ackTimeoutMs,
      minimum_acks: this.#minimumRemoteAcks
    });
    await this.#port.publishPair({
      subject: `${this.#subjectPrefix}.${this.#cellId}.records`,
      message_id: `${this.#cellId}:pair:${pairHash}`,
      envelope: {
        schema_version: 2,
        origin_node_id: this.#originNodeId,
        pair_hash: pairHash,
        record_hashes: recordHashes,
        ack_subject: acknowledgementSubject,
        records
      }
    });
    return collecting;
  }

  replicaHealth(): Promise<DialogShadowReplicaHealth[]> {
    return this.#port.replicaHealth({
      cell_id: this.#cellId,
      timeout_ms: this.#ackTimeoutMs
    });
  }
}

export class NatsDialogShadowJetStreamPort
implements DialogShadowJetStreamPort {
  readonly #connection: NatsConnection;
  readonly #streamName: string;
  readonly #consumerName: string;
  readonly #subjectPrefix: string;
  readonly #localIdentity: {
    cell_id: string;
    node_id: string;
    fault_domain: string;
  };
  readonly #journal: DialogShadowJournalPort;
  readonly #codec = jsonCodec<unknown>();
  readonly #abort = new AbortController();
  readonly #healthSubscription: Subscription;
  #consumerLoop: Promise<void> | null = null;
  #ready = true;

  private constructor(input: {
    connection: NatsConnection;
    stream_name: string;
    consumer_name: string;
    subject_prefix: string;
    local_identity: {
      cell_id: string;
      node_id: string;
      fault_domain: string;
    };
    journal: DialogShadowJournalPort;
  }) {
    this.#connection = input.connection;
    this.#streamName = input.stream_name;
    this.#consumerName = input.consumer_name;
    this.#subjectPrefix = input.subject_prefix;
    this.#localIdentity = input.local_identity;
    this.#journal = input.journal;
    this.#healthSubscription = this.#connection.subscribe(
      `${this.#subjectPrefix}.${this.#localIdentity.cell_id}.health`,
      {
        callback: (error, message) => {
          if (error) return;
          message.respond(this.#codec.encode(this.#health()));
        }
      }
    );
  }

  static async connect(input: {
    connection_options: NodeConnectionOptions;
    cell_id: string;
    node_id: string;
    fault_domain: string;
    journal: DialogShadowJournalPort;
    server_fault_domains: Record<string, string>;
    stream_name?: string;
    subject_prefix?: string;
    stream_replicas?: 3 | 5;
    max_age_ms?: number;
    placement_cluster?: string;
    placement_tags?: string[];
    ack_wait_ms?: number;
    max_ack_pending?: number;
  }): Promise<NatsDialogShadowJetStreamPort> {
    const localIdentity = {
      cell_id: token(input.cell_id, 'cell_id'),
      node_id: token(input.node_id, 'node_id'),
      fault_domain: token(input.fault_domain, 'fault_domain')
    };
    const streamName = streamNameValue(
      input.stream_name ?? 'IVEKIT_DIALOG_SHADOW'
    );
    const prefix = subjectPrefix(
      input.subject_prefix ?? 'ivekit.dialog_shadow'
    );
    const replicas = input.stream_replicas ?? 3;
    const maxAgeMs = integer(
      input.max_age_ms ?? 15 * 60 * 1000,
      60_000,
      24 * 60 * 60 * 1000,
      'max_age_ms'
    );
    const ackWaitMs = integer(
      input.ack_wait_ms ?? 2_000,
      250,
      60_000,
      'ack_wait_ms'
    );
    const maxAckPending = integer(
      input.max_ack_pending ?? 256,
      1,
      10_000,
      'max_ack_pending'
    );
    const placementTags = (input.placement_tags || []).map(
      (item) => token(item, 'placement_tag')
    );
    const placementCluster = input.placement_cluster === undefined
      ? ''
      : token(input.placement_cluster, 'placement_cluster');
    if (placementTags.length > 0 && !placementCluster) {
      throw new Error('dialog shadow placement cluster is required');
    }
    const connection = await connect(input.connection_options);
    const manager = await jetstreamManager(connection);
    try {
      let stream;
      try {
        stream = await manager.streams.info(streamName);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        stream = await manager.streams.add({
          name: streamName,
          subjects: [`${prefix}.*.records`],
          retention: RetentionPolicy.Limits,
          storage: StorageType.File,
          max_age: nanos(maxAgeMs),
          max_msgs_per_subject: 100_000,
          max_msg_size: 128 * 1024,
          duplicate_window: nanos(maxAgeMs),
          num_replicas: replicas,
          placement: placementTags.length > 0
            ? { cluster: placementCluster, tags: placementTags }
            : undefined
        });
      }
      assertNatsDialogShadowStream(stream, input.server_fault_domains);

      const consumerName = durableName(
        `dialog-shadow-${localIdentity.cell_id}-${localIdentity.node_id}`
      );
      try {
        const consumer = await manager.consumers.info(streamName, consumerName);
        assertConsumerConfiguration(consumer.config, {
          filter_subject: `${prefix}.${localIdentity.cell_id}.records`,
          ack_wait: nanos(ackWaitMs),
          max_ack_pending: maxAckPending
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
          filter_subject: `${prefix}.${localIdentity.cell_id}.records`
        });
      }

      const port = new NatsDialogShadowJetStreamPort({
        connection,
        stream_name: streamName,
        consumer_name: consumerName,
        subject_prefix: prefix,
        local_identity: localIdentity,
        journal: input.journal
      });
      port.#consumerLoop = port.#runConsumer().catch(() => {
        port.#ready = false;
      });
      return port;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  async publish(input: {
    subject: string;
    message_id: string;
    envelope: DialogShadowJetStreamEnvelope;
  }): Promise<void> {
    if (input.subject !==
        `${this.#subjectPrefix}.${this.#localIdentity.cell_id}.records` ||
        input.message_id.length > 255) {
      throw new Error('dialog_shadow_publish_identity_invalid');
    }
    await jetstream(this.#connection).publish(
      input.subject,
      this.#codec.encode(input.envelope),
      { msgID: input.message_id }
    );
  }

  async publishPair(input: {
    subject: string;
    message_id: string;
    envelope: DialogShadowPairJetStreamEnvelope;
  }): Promise<void> {
    if (input.subject !==
        `${this.#subjectPrefix}.${this.#localIdentity.cell_id}.records` ||
        input.message_id.length > 255) {
      throw new Error('dialog_shadow_pair_publish_identity_invalid');
    }
    await jetstream(this.#connection).publish(
      input.subject,
      this.#codec.encode(input.envelope),
      { msgID: input.message_id }
    );
  }

  async collectAcks(input: {
    subject: string;
    record_hash: string;
    timeout_ms: number;
    minimum_acks: number;
  }): Promise<DialogShadowReplicaAck[]> {
    const expectedSubject =
      `${this.#subjectPrefix}.${this.#localIdentity.cell_id}.acks.${input.record_hash}`;
    if (input.subject !== expectedSubject ||
        !/^[a-f0-9]{64}$/.test(input.record_hash)) {
      throw new Error('dialog_shadow_ack_subject_invalid');
    }
    const acknowledgements: DialogShadowReplicaAck[] = [];
    const nodes = new Set<string>();
    return new Promise<DialogShadowReplicaAck[]>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let subscription: Subscription | null = null;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        subscription?.unsubscribe();
        if (error) reject(error);
        else resolve(acknowledgements);
      };
      subscription = this.#connection.subscribe(input.subject, {
        callback: (error, message) => {
          if (error) {
            finish(error);
            return;
          }
          try {
            const acknowledgement = decodeReplicaAck(
              this.#codec.decode(message.data)
            );
            if (acknowledgement.record_hash !== input.record_hash ||
                nodes.has(acknowledgement.node_id)) return;
            nodes.add(acknowledgement.node_id);
            acknowledgements.push(acknowledgement);
            if (acknowledgements.length >= input.minimum_acks) finish();
          } catch {
            // Malformed ACKs cannot contribute to quorum.
          }
        }
      });
      timer = setTimeout(() => finish(), input.timeout_ms);
      timer.unref?.();
      this.#connection.flush().catch(finish);
    });
  }

  async collectPairAcks(input: {
    subject: string;
    pair_hash: string;
    timeout_ms: number;
    minimum_acks: number;
  }): Promise<DialogShadowPairReplicaAck[]> {
    const expectedSubject =
      `${this.#subjectPrefix}.${this.#localIdentity.cell_id}.pair_acks.${input.pair_hash}`;
    if (input.subject !== expectedSubject ||
        !/^[a-f0-9]{64}$/.test(input.pair_hash)) {
      throw new Error('dialog_shadow_pair_ack_subject_invalid');
    }
    const acknowledgements: DialogShadowPairReplicaAck[] = [];
    const nodes = new Set<string>();
    return new Promise<DialogShadowPairReplicaAck[]>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let subscription: Subscription | null = null;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        subscription?.unsubscribe();
        if (error) reject(error);
        else resolve(acknowledgements);
      };
      subscription = this.#connection.subscribe(input.subject, {
        callback: (error, message) => {
          if (error) {
            finish(error);
            return;
          }
          try {
            const acknowledgement = decodePairReplicaAck(
              this.#codec.decode(message.data)
            );
            if (acknowledgement.pair_hash !== input.pair_hash ||
                nodes.has(acknowledgement.node_id)) return;
            nodes.add(acknowledgement.node_id);
            acknowledgements.push(acknowledgement);
            if (acknowledgements.length >= input.minimum_acks) finish();
          } catch {
            // Malformed ACKs cannot contribute to quorum.
          }
        }
      });
      timer = setTimeout(() => finish(), input.timeout_ms);
      timer.unref?.();
      this.#connection.flush().catch(finish);
    });
  }

  async replicaHealth(input: {
    cell_id: string;
    timeout_ms: number;
  }): Promise<DialogShadowReplicaHealth[]> {
    if (input.cell_id !== this.#localIdentity.cell_id) {
      throw new Error('dialog_shadow_health_cell_mismatch');
    }
    const result: DialogShadowReplicaHealth[] = [];
    try {
      const messages = await this.#connection.requestMany(
        `${this.#subjectPrefix}.${input.cell_id}.health`,
        undefined,
        { strategy: 'timer', maxWait: input.timeout_ms }
      );
      for await (const message of messages) {
        try {
          result.push(decodeReplicaHealth(this.#codec.decode(message.data)));
        } catch {
          // Malformed health responses cannot contribute to admission.
        }
      }
    } catch {
      return [];
    }
    return result;
  }

  async close(): Promise<void> {
    this.#ready = false;
    this.#abort.abort();
    this.#healthSubscription.unsubscribe();
    await this.#consumerLoop;
    await this.#connection.drain();
  }

  isReady(): boolean {
    return this.#ready && !this.#connection.isClosed();
  }

  async #runConsumer(): Promise<void> {
    const consumer = await jetstream(this.#connection)
      .consumers.get(this.#streamName, this.#consumerName);
    const messages = await consumer.consume();
    const stop = () => {
      void messages.close();
    };
    this.#abort.signal.addEventListener('abort', stop, { once: true });
    try {
      for await (const message of messages) {
        try {
          const envelope = decodeEnvelope(this.#codec.decode(message.data));
          const acknowledgement = await applyDialogShadowEnvelope(envelope, {
            subject_prefix: this.#subjectPrefix,
            local_identity: this.#localIdentity,
            journal: this.#journal
          });
          if (acknowledgement) {
            this.#connection.publish(
              envelope.ack_subject,
              this.#codec.encode(acknowledgement)
            );
            await this.#connection.flush();
          }
          message.ack();
        } catch (error) {
          if (error instanceof DialogShadowError ||
              String((error as Error)?.message || '').includes('invalid')) {
            message.term('dialog_shadow_envelope_invalid');
          } else {
            message.nak(250);
          }
        }
      }
    } finally {
      this.#abort.signal.removeEventListener('abort', stop);
    }
  }

  #health(): DialogShadowReplicaHealth {
    return {
      cell_id: this.#localIdentity.cell_id,
      node_id: this.#localIdentity.node_id,
      fault_domain: this.#localIdentity.fault_domain,
      durable: true,
      ready: this.#ready
    };
  }
}

export async function applyDialogShadowEnvelope(
  value: DialogShadowAnyJetStreamEnvelope,
  input: {
    subject_prefix: string;
    local_identity: {
      cell_id: string;
      node_id: string;
      fault_domain: string;
    };
    journal: DialogShadowJournalPort;
    now?: () => Date;
  }
): Promise<DialogShadowReplicaAck | DialogShadowPairReplicaAck | null> {
  try {
    const envelope = decodeEnvelope(value);
    const prefix = subjectPrefix(input.subject_prefix);
    const local = {
      cell_id: token(input.local_identity.cell_id, 'cell_id'),
      node_id: token(input.local_identity.node_id, 'node_id'),
      fault_domain: token(input.local_identity.fault_domain, 'fault_domain')
    };
    if (envelope.schema_version === 2) {
      const records = assertDialogShadowPair(envelope.records);
      const pairHash = dialogShadowPairHash(records);
      const recordHashes = records.map(dialogShadowRecordHash).sort();
      if (records.some((record) => record.cell_id !== local.cell_id) ||
          envelope.pair_hash !== pairHash ||
          envelope.record_hashes.some(
            (hash, index) => hash !== recordHashes[index]
          ) ||
          envelope.ack_subject !==
            `${prefix}.${local.cell_id}.pair_acks.${pairHash}` ||
          !input.journal.appendPair) {
        throw new Error('pair identity mismatch');
      }
      if (envelope.origin_node_id === local.node_id) return null;
      const appended = await input.journal.appendPair(records);
      if (appended.pair_hash !== pairHash ||
          appended.record_hashes.some(
            (hash, index) => hash !== recordHashes[index]
          )) {
        throw new Error('pair journal hash mismatch');
      }
      const acknowledgedAt = (input.now || (() => new Date()))().toISOString();
      return {
        schema_version: 1,
        cell_id: local.cell_id,
        dialog_ids: records.map((record) => record.dialog_id).sort() as
          [string, string],
        owner_epoch: records[0].owner_epoch,
        sequence: records[0].sequence,
        pair_hash: pairHash,
        record_hashes: recordHashes as [string, string],
        node_id: local.node_id,
        fault_domain: local.fault_domain,
        durable: true,
        acknowledged_at: acknowledgedAt
      };
    }
    const record = assertDialogShadowRecord(envelope.record);
    const hash = dialogShadowRecordHash(record);
    if (record.cell_id !== local.cell_id ||
        envelope.record_hash !== hash ||
        envelope.ack_subject !==
          `${prefix}.${local.cell_id}.acks.${hash}`) {
      throw new Error('identity mismatch');
    }
    if (envelope.origin_node_id === local.node_id) return null;
    const appended = await input.journal.append(record);
    if (appended.record_hash !== hash) throw new Error('journal hash mismatch');
    const acknowledgedAt = (input.now || (() => new Date()))().toISOString();
    return {
      schema_version: 1,
      cell_id: local.cell_id,
      dialog_id: record.dialog_id,
      owner_epoch: record.owner_epoch,
      sequence: record.sequence,
      record_hash: hash,
      node_id: local.node_id,
      fault_domain: local.fault_domain,
      durable: true,
      acknowledged_at: acknowledgedAt
    };
  } catch (error) {
    throw new Error('dialog_shadow_envelope_invalid', { cause: error });
  }
}

export function assertNatsDialogShadowStream(
  value: {
    config: {
      name: string;
      subjects: string[];
      retention: string;
      storage: string;
      num_replicas: number;
    };
    cluster?: {
      leader?: string;
      replicas?: Array<{
        name: string;
        current: boolean;
        offline: boolean;
        lag: number;
      }>;
    };
  },
  serverFaultDomains: Record<string, string>
): DialogShadowStreamEvidence {
  try {
    const config = value.config;
    if (config.subjects.length !== 1 ||
        !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+\.\*\.records$/.test(config.subjects[0]) ||
        config.retention !== RetentionPolicy.Limits ||
        config.storage !== StorageType.File ||
        (config.num_replicas !== 3 && config.num_replicas !== 5)) {
      throw new Error('stream configuration mismatch');
    }
    const leader = String(value.cluster?.leader || '');
    const replicas = value.cluster?.replicas || [];
    if (!leader || replicas.length !== config.num_replicas - 1 ||
        replicas.some((peer) =>
          !peer.current || peer.offline || peer.lag !== 0
        )) {
      throw new Error('stream replica state mismatch');
    }
    const servers = [leader, ...replicas.map((peer) => peer.name)];
    const domains = servers.map((server) =>
      token(serverFaultDomains[server], 'server_fault_domain')
    );
    const suffix = '.*.records';
    const prefix = config.subjects[0].slice(0, -suffix.length);
    return assertDialogShadowStreamEvidence({
      stream_name: config.name,
      subject_prefix: prefix,
      storage: 'file',
      num_replicas: config.num_replicas,
      replica_fault_domains: domains
    });
  } catch (error) {
    throw new Error('dialog_shadow_stream_invalid', { cause: error });
  }
}

function decodeEnvelope(value: unknown): DialogShadowAnyJetStreamEnvelope {
  const record = strictObject(value);
  if (record.schema_version === 2) {
    exactKeys(record, [
      'schema_version',
      'origin_node_id',
      'pair_hash',
      'record_hashes',
      'ack_subject',
      'records'
    ]);
    if (!/^[a-f0-9]{64}$/.test(String(record.pair_hash || '')) ||
        !/^[A-Za-z0-9_.:-]{1,255}$/.test(String(record.ack_subject || '')) ||
        !Array.isArray(record.record_hashes) ||
        record.record_hashes.length !== 2 ||
        record.record_hashes.some(
          (hash) => !/^[a-f0-9]{64}$/.test(String(hash || ''))
        ) ||
        !Array.isArray(record.records) ||
        record.records.length !== 2) {
      throw new Error('dialog shadow pair envelope is invalid');
    }
    const records = assertDialogShadowPair(
      record.records as [DialogShadowRecord, DialogShadowRecord]
    );
    return {
      schema_version: 2,
      origin_node_id: token(record.origin_node_id, 'origin_node_id'),
      pair_hash: String(record.pair_hash),
      record_hashes: record.record_hashes.map(String).sort() as [string, string],
      ack_subject: String(record.ack_subject),
      records
    };
  }
  exactKeys(record, [
    'schema_version',
    'origin_node_id',
    'record_hash',
    'ack_subject',
    'record'
  ]);
  if (record.schema_version !== 1 ||
      !/^[a-f0-9]{64}$/.test(String(record.record_hash || '')) ||
      !/^[A-Za-z0-9_.:-]{1,255}$/.test(String(record.ack_subject || ''))) {
    throw new Error('dialog shadow envelope is invalid');
  }
  return {
    schema_version: 1,
    origin_node_id: token(record.origin_node_id, 'origin_node_id'),
    record_hash: String(record.record_hash),
    ack_subject: String(record.ack_subject),
    record: assertDialogShadowRecord(record.record as DialogShadowRecord)
  };
}

function decodePairReplicaAck(value: unknown): DialogShadowPairReplicaAck {
  const record = strictObject(value);
  exactKeys(record, [
    'schema_version',
    'cell_id',
    'dialog_ids',
    'owner_epoch',
    'sequence',
    'pair_hash',
    'record_hashes',
    'node_id',
    'fault_domain',
    'durable',
    'acknowledged_at'
  ]);
  if (record.schema_version !== 1 ||
      record.durable !== true ||
      !/^[a-f0-9]{64}$/.test(String(record.pair_hash || '')) ||
      !Array.isArray(record.dialog_ids) ||
      record.dialog_ids.length !== 2 ||
      !Array.isArray(record.record_hashes) ||
      record.record_hashes.length !== 2 ||
      record.record_hashes.some(
        (hash) => !/^[a-f0-9]{64}$/.test(String(hash || ''))
      )) {
    throw new Error('dialog shadow pair ACK is invalid');
  }
  const acknowledgedAt = String(record.acknowledged_at || '');
  if (!Number.isFinite(Date.parse(acknowledgedAt)) ||
      new Date(acknowledgedAt).toISOString() !== acknowledgedAt) {
    throw new Error('dialog shadow pair ACK time is invalid');
  }
  const dialogIds = record.dialog_ids.map(
    (value) => token(value, 'dialog_id')
  ).sort() as [string, string];
  return {
    schema_version: 1,
    cell_id: token(record.cell_id, 'cell_id'),
    dialog_ids: dialogIds,
    owner_epoch: integer(record.owner_epoch, 1, 0xffff_ffff, 'owner_epoch'),
    sequence: integer(record.sequence, 1, 0xffff_ffff, 'sequence'),
    pair_hash: String(record.pair_hash),
    record_hashes: record.record_hashes.map(String).sort() as [string, string],
    node_id: token(record.node_id, 'node_id'),
    fault_domain: token(record.fault_domain, 'fault_domain'),
    durable: true,
    acknowledged_at: acknowledgedAt
  };
}

function decodeReplicaAck(value: unknown): DialogShadowReplicaAck {
  const record = strictObject(value);
  exactKeys(record, [
    'schema_version',
    'cell_id',
    'dialog_id',
    'owner_epoch',
    'sequence',
    'record_hash',
    'node_id',
    'fault_domain',
    'durable',
    'acknowledged_at'
  ]);
  if (record.schema_version !== 1 ||
      record.durable !== true ||
      !/^[a-f0-9]{64}$/.test(String(record.record_hash || ''))) {
    throw new Error('dialog shadow ACK is invalid');
  }
  const acknowledgedAt = String(record.acknowledged_at || '');
  if (!Number.isFinite(Date.parse(acknowledgedAt)) ||
      new Date(acknowledgedAt).toISOString() !== acknowledgedAt) {
    throw new Error('dialog shadow ACK time is invalid');
  }
  return {
    schema_version: 1,
    cell_id: token(record.cell_id, 'cell_id'),
    dialog_id: token(record.dialog_id, 'dialog_id'),
    owner_epoch: integer(record.owner_epoch, 1, 0xffff_ffff, 'owner_epoch'),
    sequence: integer(record.sequence, 1, 0xffff_ffff, 'sequence'),
    record_hash: String(record.record_hash),
    node_id: token(record.node_id, 'node_id'),
    fault_domain: token(record.fault_domain, 'fault_domain'),
    durable: true,
    acknowledged_at: acknowledgedAt
  };
}

function decodeReplicaHealth(value: unknown): DialogShadowReplicaHealth {
  const record = strictObject(value);
  exactKeys(record, [
    'cell_id',
    'node_id',
    'fault_domain',
    'durable',
    'ready'
  ]);
  if (record.durable !== true || typeof record.ready !== 'boolean') {
    throw new Error('dialog shadow health is invalid');
  }
  return {
    cell_id: token(record.cell_id, 'cell_id'),
    node_id: token(record.node_id, 'node_id'),
    fault_domain: token(record.fault_domain, 'fault_domain'),
    durable: true,
    ready: record.ready
  };
}

function assertConsumerConfiguration(
  config: {
    filter_subject?: string;
    ack_policy: string;
    ack_wait?: number;
    max_ack_pending?: number;
    max_deliver?: number;
  },
  expected: {
    filter_subject: string;
    ack_wait: number;
    max_ack_pending: number;
  }
): void {
  if (config.filter_subject !== expected.filter_subject ||
      config.ack_policy !== AckPolicy.Explicit ||
      config.ack_wait !== expected.ack_wait ||
      config.max_ack_pending !== expected.max_ack_pending ||
      config.max_deliver !== 20) {
    throw new Error('dialog_shadow_consumer_configuration_mismatch');
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

function strictObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('object required');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length ||
      actual.some((item, index) => item !== wanted[index])) {
    throw new Error('fields mismatch');
  }
}

function streamNameValue(value: unknown): string {
  const result = String(value || '');
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(result)) {
    throw new Error('dialog shadow stream name is invalid');
  }
  return result;
}

function durableName(value: string): string {
  const result = value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
  if (!result) throw new Error('dialog shadow consumer name is invalid');
  return result;
}

function isNotFound(error: unknown): boolean {
  const value = error as { code?: unknown; api_error?: { code?: unknown } };
  return Number(value?.code || value?.api_error?.code || 0) === 404;
}

function token(value: unknown, field: string): string {
  const result = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(result)) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}

function subjectPrefix(value: unknown): string {
  const result = String(value || '');
  if (result.length > 200 ||
      !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(result)) {
    throw new Error('dialog shadow subject prefix is invalid');
  }
  return result;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${field} is invalid`);
  }
  return Number(value);
}
