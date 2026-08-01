import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DialogShadowError,
  DialogShadowQuorum,
  assertDialogShadowRecord,
  assertDialogShadowStreamEvidence,
  dialogShadowPairHash,
  dialogShadowRecordHash,
  type DialogShadowJournalPort,
  type DialogShadowRecord,
  type DialogShadowPairReplicaAck,
  type DialogShadowReplicaAck,
  type DialogShadowReplicationBus
} from '../src/agent-runtime/converact/voice/dialog-shadow.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

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

class MemoryJournal implements DialogShadowJournalPort {
  readonly records: DialogShadowRecord[] = [];

  async append(value: DialogShadowRecord) {
    this.records.push(structuredClone(value));
    return {
      status: 'committed' as const,
      record_hash: dialogShadowRecordHash(value)
    };
  }

  async appendPair(values: readonly [DialogShadowRecord, DialogShadowRecord]) {
    this.records.push(...structuredClone(values));
    return {
      status: 'committed' as const,
      pair_hash: dialogShadowPairHash(values),
      record_hashes: values.map(dialogShadowRecordHash).sort()
    };
  }
}

class FailingJournal extends MemoryJournal {
  override async append(): Promise<never> {
    throw new Error('disk full');
  }
}

class MemoryBus implements DialogShadowReplicationBus {
  acks: DialogShadowReplicaAck[] = [];
  health = [{
    cell_id: 'cell-a',
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1',
    durable: true,
    ready: true
  }];
  calls = 0;
  pairAcks: DialogShadowPairReplicaAck[] = [];
  pairCalls = 0;

  async replicate(): Promise<DialogShadowReplicaAck[]> {
    this.calls += 1;
    return structuredClone(this.acks);
  }

  async replicatePair(): Promise<DialogShadowPairReplicaAck[]> {
    this.pairCalls += 1;
    return structuredClone(this.pairAcks);
  }

  async replicaHealth() {
    return structuredClone(this.health);
  }
}

function recoveryPair(): [DialogShadowRecord, DialogShadowRecord] {
  const capsule = {
    schema_version: 1 as const,
    algorithm: 'A256GCM' as const,
    key_id: 'recovery-2026-07',
    nonce: Buffer.alloc(12, 0x11).toString('base64url'),
    ciphertext: Buffer.from('opaque').toString('base64url'),
    auth_tag: Buffer.alloc(16, 0x22).toString('base64url')
  };
  return ['dialog-caller', 'dialog-callee'].map((dialogId) => record({
    schema_version: 2,
    dialog_id: dialogId,
    provider_session_ref: 'call-session-a',
    recovery_capsule: capsule,
    takeover_id: 'dto-takeover-a'
  })) as [DialogShadowRecord, DialogShadowRecord];
}

function remotePairAck(
  pair: [DialogShadowRecord, DialogShadowRecord]
): DialogShadowPairReplicaAck {
  return {
    schema_version: 1,
    cell_id: 'cell-a',
    dialog_ids: pair.map((item) => item.dialog_id).sort() as [string, string],
    owner_epoch: pair[0].owner_epoch,
    sequence: pair[0].sequence,
    pair_hash: dialogShadowPairHash(pair),
    record_hashes: pair.map(dialogShadowRecordHash).sort() as [string, string],
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1',
    durable: true,
    acknowledged_at: '2026-07-26T00:00:01.010Z'
  };
}

function quorum(journal = new MemoryJournal(), bus = new MemoryBus()) {
  return {
    journal,
    bus,
    coordinator: new DialogShadowQuorum({
      local_journal: journal,
      replication_bus: bus,
      local_identity: {
        cell_id: 'cell-a',
        node_id: 'rustpbx-a',
        fault_domain: 'zone-a-rack-1'
      },
      required_fault_domains: 2
    })
  };
}

function remoteAck(value: DialogShadowRecord): DialogShadowReplicaAck {
  return {
    schema_version: 1,
    cell_id: value.cell_id,
    dialog_id: value.dialog_id,
    owner_epoch: value.owner_epoch,
    sequence: value.sequence,
    record_hash: dialogShadowRecordHash(value),
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1',
    durable: true,
    acknowledged_at: '2026-07-26T00:00:01.010Z'
  };
}

test('T1 commit requires matching durable ACKs from two fault domains', async () => {
  const value = record();
  const { coordinator, journal, bus } = quorum();
  bus.acks = [remoteAck(value)];

  const proof = await coordinator.commit('VOICE-HA-T1', value);

  assert.equal(journal.records.length, 1);
  assert.equal(bus.calls, 1);
  assert.equal(proof.status, 'committed');
  assert.deepEqual(proof.fault_domains, [
    'zone-a-rack-1',
    'zone-b-rack-1'
  ]);
  assert.equal(proof.record_hash, dialogShadowRecordHash(value));
});

test('T1 recovery pair reaches quorum through one atomic local and remote append', async () => {
  const pair = recoveryPair();
  const { coordinator, journal, bus } = quorum();
  bus.pairAcks = [remotePairAck(pair)];

  const proof = await coordinator.commitPair('VOICE-HA-T1', pair);

  assert.equal(journal.records.length, 2);
  assert.equal(bus.calls, 0);
  assert.equal(bus.pairCalls, 1);
  assert.deepEqual(proof, {
    status: 'committed',
    pair_hash: dialogShadowPairHash(pair),
    record_hashes: pair.map(dialogShadowRecordHash).sort(),
    fault_domains: ['zone-a-rack-1', 'zone-b-rack-1'],
    owner_epoch: 7,
    sequence: 1
  });
});

test('T1 commit rejects duplicate-domain, stale and mismatched ACKs', async () => {
  const value = record();
  for (const invalid of [
    { ...remoteAck(value), fault_domain: 'zone-a-rack-1' },
    { ...remoteAck(value), owner_epoch: 6 },
    { ...remoteAck(value), record_hash: HASH_D },
    { ...remoteAck(value), durable: false }
  ]) {
    const { coordinator, bus } = quorum();
    bus.acks = [invalid];
    await assert.rejects(
      coordinator.commit('VOICE-HA-T1', value),
      (error) => code(error) === 'dialog_shadow_quorum_unavailable'
    );
  }
});

test('ordinary voice bypasses shadow while unavailable shadow rejects only new T1', async () => {
  const { coordinator, journal, bus } = quorum();
  bus.health = [];

  assert.deepEqual(
    await coordinator.assertAdmission('VOICE-ORDINARY'),
    { status: 'not_required' }
  );
  assert.equal((await coordinator.commit('VOICE-ORDINARY', record())).status, 'not_required');
  assert.equal(journal.records.length, 0);
  assert.equal(bus.calls, 0);

  await assert.rejects(
    coordinator.assertAdmission('VOICE-HA-T1'),
    (error) => code(error) === 'dialog_shadow_quorum_unavailable'
  );
});

test('T1 commit maps local WAL failures to quorum unavailability', async () => {
  const { coordinator, bus } = quorum(new FailingJournal(), new MemoryBus());

  await assert.rejects(
    coordinator.commit('VOICE-HA-T1', record()),
    (error) => code(error) === 'dialog_shadow_quorum_unavailable'
  );
  assert.equal(bus.calls, 0);
});

test('dialog shadow records reject PII-bearing routes, secrets and unbounded bodies', () => {
  assert.throws(
    () => assertDialogShadowRecord(record({
      route_set: ['sip:+8613800138000@example.internal;lr']
    })),
    (error) => code(error) === 'dialog_shadow_record_invalid'
  );
  assert.throws(
    () => assertDialogShadowRecord({
      ...record(),
      authorization: 'Bearer private-token'
    } as DialogShadowRecord),
    (error) => code(error) === 'dialog_shadow_record_invalid'
  );
  assert.throws(
    () => assertDialogShadowRecord(record({
      route_set: [`sip:${'a'.repeat(4_096)}.internal;lr`]
    })),
    (error) => code(error) === 'dialog_shadow_record_invalid'
  );
});

test('JetStream evidence must prove file storage and cross-domain replicas', () => {
  assert.doesNotThrow(() => assertDialogShadowStreamEvidence({
    stream_name: 'IVEKIT_DIALOG_SHADOW',
    subject_prefix: 'ivekit.dialog_shadow',
    storage: 'file',
    num_replicas: 3,
    replica_fault_domains: [
      'zone-a-rack-1',
      'zone-b-rack-1',
      'zone-c-rack-1'
    ]
  }));
  assert.throws(
    () => assertDialogShadowStreamEvidence({
      stream_name: 'IVEKIT_DIALOG_SHADOW',
      subject_prefix: 'ivekit.dialog_shadow',
      storage: 'memory',
      num_replicas: 3,
      replica_fault_domains: [
        'zone-a-rack-1',
        'zone-b-rack-1',
        'zone-c-rack-1'
      ]
    }),
    (error) => code(error) === 'dialog_shadow_stream_invalid'
  );
  assert.throws(
    () => assertDialogShadowStreamEvidence({
      stream_name: 'IVEKIT_DIALOG_SHADOW',
      subject_prefix: 'ivekit.dialog_shadow',
      storage: 'file',
      num_replicas: 3,
      replica_fault_domains: [
        'zone-a-rack-1',
        'zone-a-rack-1',
        'zone-a-rack-1'
      ]
    }),
    (error) => code(error) === 'dialog_shadow_stream_invalid'
  );
});

function code(error: unknown): string {
  assert.ok(error instanceof DialogShadowError);
  return error.code;
}
