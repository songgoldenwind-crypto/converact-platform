import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dialogShadowPairHash,
  dialogShadowRecordHash,
  type DialogShadowPairReplicaAck,
  type DialogShadowRecord,
  type DialogShadowReplicaAck,
  type DialogShadowReplicaHealth
} from '../src/agent-runtime/converact/voice/dialog-shadow.js';
import {
  JetStreamDialogShadowReplicationBus,
  applyDialogShadowEnvelope,
  assertNatsDialogShadowStream,
  type DialogShadowJetStreamEnvelope,
  type DialogShadowPairJetStreamEnvelope,
  type DialogShadowJetStreamPort
} from '../src/agent-runtime/converact/voice/dialog-shadow-jetstream.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function record(
  overrides: Partial<DialogShadowRecord> = {}
): DialogShadowRecord {
  return {
    schema_version: 1,
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    dialog_id: 'dialog-a',
    call_id_hash: HASH_A,
    owner_node_id: 'rustpbx-a',
    owner_fault_domain: 'zone-a-rack-1',
    owner_epoch: 7,
    sequence: 1,
    state: 'early',
    local_tag: 'caller-tag',
    remote_tag: 'callee-tag',
    route_set: ['sip:edge-a.internal:5061;transport=tls;lr'],
    local_cseq: 1,
    remote_cseq: 1,
    branch_hash: HASH_B,
    final_response_hash: null,
    auth_context_ref: 'auth-context-a',
    logical_offer_hash: HASH_C,
    logical_answer_hash: null,
    media_reservation_id: 'reservation-a-caller',
    provider_session_ref: null,
    cdr_sequence: 1,
    recorded_at: '2026-07-26T00:00:01.000Z',
    terminal: false,
    ...overrides
  };
}

class MemoryPort implements DialogShadowJetStreamPort {
  published: Array<{
    subject: string;
    message_id: string;
    envelope: DialogShadowJetStreamEnvelope;
  }> = [];
  acknowledgements: DialogShadowReplicaAck[] = [];
  publishedPairs: Array<{
    subject: string;
    message_id: string;
    envelope: DialogShadowPairJetStreamEnvelope;
  }> = [];
  pairAcknowledgements: DialogShadowPairReplicaAck[] = [];
  health: DialogShadowReplicaHealth[] = [];

  async publish(input: {
    subject: string;
    message_id: string;
    envelope: DialogShadowJetStreamEnvelope;
  }): Promise<void> {
    this.published.push(structuredClone(input));
  }

  async collectAcks(): Promise<DialogShadowReplicaAck[]> {
    return structuredClone(this.acknowledgements);
  }

  async publishPair(input: {
    subject: string;
    message_id: string;
    envelope: DialogShadowPairJetStreamEnvelope;
  }): Promise<void> {
    this.publishedPairs.push(structuredClone(input));
  }

  async collectPairAcks(): Promise<DialogShadowPairReplicaAck[]> {
    return structuredClone(this.pairAcknowledgements);
  }

  async replicaHealth(): Promise<DialogShadowReplicaHealth[]> {
    return structuredClone(this.health);
  }
}

function recoveryRecord(
  dialogId: string,
  overrides: Partial<DialogShadowRecord> = {}
): DialogShadowRecord {
  return record({
    schema_version: 2,
    dialog_id: dialogId,
    provider_session_ref: 'call-session-a',
    recovery_capsule: {
      schema_version: 1,
      algorithm: 'A256GCM',
      key_id: 'recovery-2026-07',
      nonce: Buffer.alloc(12, 0x11).toString('base64url'),
      ciphertext: Buffer.from('opaque').toString('base64url'),
      auth_tag: Buffer.alloc(16, 0x22).toString('base64url')
    },
    ...overrides
  });
}

test('JetStream shadow bus publishes deterministic Cell-scoped identities', async () => {
  const port = new MemoryPort();
  const bus = new JetStreamDialogShadowReplicationBus({
    port,
    cell_id: 'cell-a',
    origin_node_id: 'rustpbx-a',
    subject_prefix: 'ivekit.dialog_shadow',
    ack_timeout_ms: 250,
    minimum_remote_acks: 1
  });
  const value = record();
  const hash = dialogShadowRecordHash(value);
  port.acknowledgements = [{
    schema_version: 1,
    cell_id: 'cell-a',
    dialog_id: 'dialog-a',
    owner_epoch: 7,
    sequence: 1,
    record_hash: hash,
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1',
    durable: true,
    acknowledged_at: '2026-07-26T00:00:01.010Z'
  }];

  assert.deepEqual(await bus.replicate(value, hash), port.acknowledgements);
  assert.equal(port.published.length, 1);
  assert.equal(
    port.published[0].subject,
    'ivekit.dialog_shadow.cell-a.records'
  );
  assert.equal(port.published[0].message_id, `cell-a:${hash}`);
  assert.equal(
    port.published[0].envelope.ack_subject,
    `ivekit.dialog_shadow.cell-a.acks.${hash}`
  );
  assert.equal(port.published[0].envelope.record_hash, hash);
});

test('JetStream shadow bus replicates a recovery pair as one message and one ACK', async () => {
  const port = new MemoryPort();
  const bus = new JetStreamDialogShadowReplicationBus({
    port,
    cell_id: 'cell-a',
    origin_node_id: 'rustpbx-a',
    subject_prefix: 'ivekit.dialog_shadow'
  });
  const pair = [
    recoveryRecord('dialog-caller'),
    recoveryRecord('dialog-callee')
  ] as const;
  const pairHash = dialogShadowPairHash(pair);
  const recordHashes = pair.map(dialogShadowRecordHash).sort() as [string, string];
  port.pairAcknowledgements = [{
    schema_version: 1,
    cell_id: 'cell-a',
    dialog_ids: ['dialog-callee', 'dialog-caller'],
    owner_epoch: 7,
    sequence: 1,
    pair_hash: pairHash,
    record_hashes: recordHashes,
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1',
    durable: true,
    acknowledged_at: '2026-07-26T00:00:01.010Z'
  }];

  assert.deepEqual(
    await bus.replicatePair(pair, pairHash),
    port.pairAcknowledgements
  );
  assert.equal(port.publishedPairs.length, 1);
  assert.equal(port.publishedPairs[0].message_id, `cell-a:pair:${pairHash}`);
  assert.equal(port.publishedPairs[0].envelope.pair_hash, pairHash);
  assert.deepEqual(
    port.publishedPairs[0].envelope.records.map((item) => item.dialog_id),
    ['dialog-callee', 'dialog-caller']
  );
});

test('JetStream shadow bus rejects cross-Cell publication and delegates health', async () => {
  const port = new MemoryPort();
  port.health = [{
    cell_id: 'cell-a',
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1',
    durable: true,
    ready: true
  }];
  const bus = new JetStreamDialogShadowReplicationBus({
    port,
    cell_id: 'cell-a',
    origin_node_id: 'rustpbx-a',
    subject_prefix: 'ivekit.dialog_shadow'
  });

  await assert.rejects(
    bus.replicate(record({ cell_id: 'cell-b' }), HASH_A),
    /dialog_shadow_cell_mismatch/
  );
  assert.deepEqual(await bus.replicaHealth(), port.health);
});

test('NATS stream proof requires current file replicas across fault domains', () => {
  const stream = {
    config: {
      name: 'IVEKIT_DIALOG_SHADOW',
      subjects: ['ivekit.dialog_shadow.*.records'],
      retention: 'limits',
      storage: 'file',
      num_replicas: 3
    },
    cluster: {
      leader: 'nats-a',
      replicas: [
        { name: 'nats-b', current: true, offline: false, lag: 0 },
        { name: 'nats-c', current: true, offline: false, lag: 0 }
      ]
    }
  };
  assert.deepEqual(
    assertNatsDialogShadowStream(stream, {
      'nats-a': 'zone-a-rack-1',
      'nats-b': 'zone-b-rack-1',
      'nats-c': 'zone-c-rack-1'
    }),
    {
      stream_name: 'IVEKIT_DIALOG_SHADOW',
      subject_prefix: 'ivekit.dialog_shadow',
      storage: 'file',
      num_replicas: 3,
      replica_fault_domains: [
        'zone-a-rack-1',
        'zone-b-rack-1',
        'zone-c-rack-1'
      ]
    }
  );
  assert.throws(
    () => assertNatsDialogShadowStream({
      ...stream,
      cluster: {
        ...stream.cluster,
        replicas: [
          { name: 'nats-b', current: false, offline: false, lag: 1 },
          { name: 'nats-c', current: true, offline: false, lag: 0 }
        ]
      }
    }, {
      'nats-a': 'zone-a-rack-1',
      'nats-b': 'zone-b-rack-1',
      'nats-c': 'zone-c-rack-1'
    }),
    /dialog_shadow_stream_invalid/
  );
});

test('replica ACK is created only after the remote WAL append succeeds', async () => {
  const value = record();
  const hash = dialogShadowRecordHash(value);
  const envelope: DialogShadowJetStreamEnvelope = {
    schema_version: 1,
    origin_node_id: 'rustpbx-a',
    record_hash: hash,
    ack_subject: `ivekit.dialog_shadow.cell-a.acks.${hash}`,
    record: value
  };
  let appended = false;
  const acknowledgement = await applyDialogShadowEnvelope(envelope, {
    subject_prefix: 'ivekit.dialog_shadow',
    local_identity: {
      cell_id: 'cell-a',
      node_id: 'rustpbx-b',
      fault_domain: 'zone-b-rack-1'
    },
    journal: {
      async append(candidate) {
        assert.deepEqual(candidate, value);
        appended = true;
        return { status: 'committed', record_hash: hash };
      }
    },
    now: () => new Date('2026-07-26T00:00:01.010Z')
  });
  assert.equal(appended, true);
  assert.deepEqual(acknowledgement, {
    schema_version: 1,
    cell_id: 'cell-a',
    dialog_id: 'dialog-a',
    owner_epoch: 7,
    sequence: 1,
    record_hash: hash,
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1',
    durable: true,
    acknowledged_at: '2026-07-26T00:00:01.010Z'
  });

  await assert.rejects(
    applyDialogShadowEnvelope({
      ...envelope,
      ack_subject: 'ivekit.dialog_shadow.cell-b.acks.bad'
    }, {
      subject_prefix: 'ivekit.dialog_shadow',
      local_identity: {
        cell_id: 'cell-a',
        node_id: 'rustpbx-b',
        fault_domain: 'zone-b-rack-1'
      },
      journal: {
        async append() {
          throw new Error('must not append');
        }
      }
    }),
    /dialog_shadow_envelope_invalid/
  );
});

test('recovery-pair ACK is created only after one atomic remote WAL append', async () => {
  const pair = [
    recoveryRecord('dialog-caller'),
    recoveryRecord('dialog-callee')
  ] as const;
  const pairHash = dialogShadowPairHash(pair);
  const recordHashes = pair.map(dialogShadowRecordHash).sort() as [string, string];
  const envelope: DialogShadowPairJetStreamEnvelope = {
    schema_version: 2,
    origin_node_id: 'rustpbx-a',
    pair_hash: pairHash,
    record_hashes: recordHashes,
    ack_subject: `ivekit.dialog_shadow.cell-a.pair_acks.${pairHash}`,
    records: [...pair].sort(
      (left, right) => left.dialog_id.localeCompare(right.dialog_id)
    ) as [DialogShadowRecord, DialogShadowRecord]
  };
  let appendPairCalls = 0;
  const acknowledgement = await applyDialogShadowEnvelope(envelope, {
    subject_prefix: 'ivekit.dialog_shadow',
    local_identity: {
      cell_id: 'cell-a',
      node_id: 'rustpbx-b',
      fault_domain: 'zone-b-rack-1'
    },
    journal: {
      async append() {
        throw new Error('single-record append must not be used');
      },
      async appendPair(candidate) {
        appendPairCalls += 1;
        assert.deepEqual(candidate, envelope.records);
        return {
          status: 'committed',
          pair_hash: pairHash,
          record_hashes: recordHashes
        };
      }
    },
    now: () => new Date('2026-07-26T00:00:01.010Z')
  });

  assert.equal(appendPairCalls, 1);
  assert.deepEqual(acknowledgement, {
    schema_version: 1,
    cell_id: 'cell-a',
    dialog_ids: ['dialog-callee', 'dialog-caller'],
    owner_epoch: 7,
    sequence: 1,
    pair_hash: pairHash,
    record_hashes: recordHashes,
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1',
    durable: true,
    acknowledged_at: '2026-07-26T00:00:01.010Z'
  });
});
