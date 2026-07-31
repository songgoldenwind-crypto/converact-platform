import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DialogRecoveryCapsuleCodec,
  type DialogRecoveryCapsulePayload
} from '../src/agent-runtime/converact/voice/dialog-recovery-capsule.js';
import {
  DialogTerminalShadowRepairWorker,
  type DialogTerminalShadowRepairClaim,
  type DialogTerminalShadowRepairStore
} from '../src/agent-runtime/converact/voice/dialog-terminal-shadow-repair.js';
import {
  dialogShadowPairHash,
  type DialogShadowRecord
} from '../src/agent-runtime/converact/voice/dialog-shadow.js';

const KEY = Buffer.alloc(32, 0x71);
const CDR_HASH = 'd'.repeat(64);

test('terminal repair commits only a CDR-bound terminal pair', async () => {
  const source = sourcePair();
  const store = new MemoryRepairStore(claim(source));
  const committed: Array<readonly [DialogShadowRecord, DialogShadowRecord]> = [];
  const worker = new DialogTerminalShadowRepairWorker({
    identity: repairIdentity(),
    store,
    shadow_reader: new MemoryRepairReader(source),
    recovery_codec: codec(),
    shadow_committer: {
      async commitPair(profile, records) {
        assert.equal(profile, 'VOICE-HA-T1');
        committed.push(structuredClone(records));
        return {
          status: 'committed' as const,
          pair_hash: dialogShadowPairHash(records),
          record_hashes: ['a'.repeat(64), 'b'.repeat(64)] as [string, string],
          fault_domains: ['zone-a-rack-1', 'zone-b-rack-1'],
          owner_epoch: records[0].owner_epoch,
          sequence: records[0].sequence
        };
      }
    },
    now: () => new Date('2026-07-27T01:00:00.000Z')
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    status: 'repaired',
    repair_id: 'repair-a'
  });
  assert.equal(committed.length, 1);
  const pair = committed[0]!;
  assert.equal(pair.every((record) =>
    record.state === 'terminated' &&
    record.terminal === true &&
    record.owner_node_id === 'rustpbx-b' &&
    record.owner_epoch === 8 &&
    record.sequence === 1 &&
    record.cdr_sequence === 77 &&
    record.terminal_cdr_payload_hash === CDR_HASH &&
    record.takeover_id === 'repair-a'
  ), true);
  assert.equal(store.completed.length, 1);
  assert.deepEqual(store.heartbeats, [{
    identity: repairIdentity(),
    heartbeat_at: '2026-07-27T01:00:00.000Z',
    lease_ttl_ms: 5_000
  }]);
  assert.equal(store.completed[0]!.terminal_cdr_payload_hash, CDR_HASH);
  assert.equal(store.completed[0]!.pair_hash, dialogShadowPairHash(pair));
  for (const record of pair) {
    const payload = codec().open(record.recovery_capsule!, {
      tenant_id: record.tenant_id,
      cell_id: record.cell_id,
      dialog_id: record.dialog_id,
      owner_epoch: record.owner_epoch,
      sequence: record.sequence
    });
    assert.equal(payload.cdr_sequence, 77);
  }
});

test('terminal repair restart replays the exact journal pair without resealing', async () => {
  const source = sourcePair();
  const existing = terminalPair(source);
  const store = new MemoryRepairStore(claim(source));
  let randomCalls = 0;
  const replayCodec = new DialogRecoveryCapsuleCodec({
    current: { key_id: 'repair-key', key: KEY },
    random_bytes: (size) => {
      randomCalls += 1;
      return Buffer.alloc(size, 0x72);
    }
  });
  const committed: Array<readonly [DialogShadowRecord, DialogShadowRecord]> = [];
  const worker = new DialogTerminalShadowRepairWorker({
    identity: repairIdentity(),
    store,
    shadow_reader: new MemoryRepairReader(source, existing),
    recovery_codec: replayCodec,
    shadow_committer: {
      async commitPair(_profile, records) {
        committed.push(structuredClone(records));
        return {
          status: 'committed' as const,
          pair_hash: dialogShadowPairHash(records),
          record_hashes: ['a'.repeat(64), 'b'.repeat(64)] as [string, string],
          fault_domains: ['zone-a-rack-1', 'zone-b-rack-1'],
          owner_epoch: records[0].owner_epoch,
          sequence: records[0].sequence
        };
      }
    }
  });

  const result = await worker.runOnce();

  assert.equal(result.status, 'repaired');
  assert.equal(randomCalls, 0, 'restart must reuse exact encrypted records');
  assert.deepEqual(
    committed[0],
    [...existing].sort((left, right) => left.dialog_id.localeCompare(right.dialog_id))
  );
  assert.equal(store.completed[0]!.pair_hash, dialogShadowPairHash(existing));
});

class MemoryRepairStore implements DialogTerminalShadowRepairStore {
  readonly heartbeats: Array<{
    identity: ReturnType<typeof repairIdentity>;
    heartbeat_at: string;
    lease_ttl_ms: number;
  }> = [];
  readonly completed: Array<{
    repair_id: string;
    pair_hash: string;
    terminal_cdr_payload_hash: string;
  }> = [];

  constructor(private readonly repair: DialogTerminalShadowRepairClaim) {}

  async heartbeatTerminalShadowRepairWorker(input: {
    identity: ReturnType<typeof repairIdentity>;
    heartbeat_at: Date;
    lease_ttl_ms: number;
  }) {
    this.heartbeats.push({
      identity: structuredClone(input.identity),
      heartbeat_at: input.heartbeat_at.toISOString(),
      lease_ttl_ms: input.lease_ttl_ms
    });
  }

  async pendingTenantIds() {
    return ['tenant-a'];
  }

  async claimTerminalShadowRepair() {
    return structuredClone(this.repair);
  }

  async completeTerminalShadowRepair(input: {
    claim: DialogTerminalShadowRepairClaim;
    records: readonly [DialogShadowRecord, DialogShadowRecord];
    pair_hash: string;
    completed_at: Date;
  }) {
    this.completed.push({
      repair_id: input.claim.repair_id,
      pair_hash: input.pair_hash,
      terminal_cdr_payload_hash: input.records[0].terminal_cdr_payload_hash!
    });
  }
}

class MemoryRepairReader {
  constructor(
    private readonly source: readonly [DialogShadowRecord, DialogShadowRecord],
    private readonly terminal?: readonly [DialogShadowRecord, DialogShadowRecord]
  ) {}

  async latestRecoveryPair(input: {
    takeover_id?: string;
    owner_node_id?: string;
    owner_epoch?: number;
  }): Promise<DialogShadowRecord[]> {
    if (input.takeover_id === 'repair-a') {
      return structuredClone(this.terminal ? [...this.terminal] : []);
    }
    return this.source
      .filter((record) =>
        record.owner_node_id === input.owner_node_id &&
        record.owner_epoch === input.owner_epoch
      )
      .map((record) => structuredClone(record));
  }

  async resolveRecoveryPair() {
    return null;
  }
}

function claim(
  source: readonly [DialogShadowRecord, DialogShadowRecord]
): DialogTerminalShadowRepairClaim {
  return {
    repair_id: 'repair-a',
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    source_owner_node_id: 'rustpbx-a',
    source_owner_fault_domain: 'zone-a-rack-1',
    source_owner_epoch: 7,
    source_pair_hash: dialogShadowPairHash(source),
    repair_owner_node_id: 'rustpbx-b',
    repair_owner_fault_domain: 'zone-b-rack-1',
    repair_owner_epoch: 8,
    terminal_cdr_sequence: 77,
    terminal_cdr_payload_hash: CDR_HASH,
    terminal_cdr_call_id: 'call-a',
    terminal_cdr_receipt_id: 'receipt-a',
    terminal_cdr_region_id: 'region-a',
    terminal_cdr_durability_contract_id: 'contract-a',
    claimed_at: '2026-07-27T00:59:59.000Z',
    expires_at: '2026-07-27T01:00:05.000Z'
  };
}

function repairIdentity() {
  return {
    spiffe_id:
      'spiffe://ivekit.internal/cells/cell-a/fault-domains/zone-b-rack-1/nodes/rustpbx-b',
    cell_id: 'cell-a',
    node_id: 'rustpbx-b',
    fault_domain: 'zone-b-rack-1'
  };
}

function codec() {
  return new DialogRecoveryCapsuleCodec({
    current: { key_id: 'repair-key', key: KEY },
    random_bytes: (size) => Buffer.alloc(size, 0x72)
  });
}

function sourcePair(): [DialogShadowRecord, DialogShadowRecord] {
  return [sourceRecord('caller'), sourceRecord('callee')];
}

function sourceRecord(leg: 'caller' | 'callee'): DialogShadowRecord {
  const payload = recoveryPayload(leg);
  return {
    schema_version: 2,
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    dialog_id: payload.dialog_id,
    call_id_hash: (leg === 'caller' ? 'a' : 'b').repeat(64),
    owner_node_id: 'rustpbx-a',
    owner_fault_domain: 'zone-a-rack-1',
    owner_epoch: 7,
    sequence: 4,
    state: 'terminating',
    local_tag: payload.local_tag,
    remote_tag: payload.remote_tag,
    route_set: payload.route_set,
    local_cseq: payload.local_cseq,
    remote_cseq: payload.remote_cseq,
    branch_hash: 'c'.repeat(64),
    final_response_hash: 'e'.repeat(64),
    auth_context_ref: 'auth-context-a',
    logical_offer_hash: 'a'.repeat(64),
    logical_answer_hash: 'b'.repeat(64),
    media_reservation_id: payload.media_reservation_id,
    provider_session_ref: payload.call_session_ref,
    cdr_sequence: payload.cdr_sequence,
    recorded_at: '2026-07-27T00:59:58.000Z',
    terminal: false,
    recovery_capsule: codec().seal(payload, {
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      dialog_id: payload.dialog_id,
      owner_epoch: 7,
      sequence: 4
    })
  };
}

function terminalPair(
  source: readonly [DialogShadowRecord, DialogShadowRecord]
): [DialogShadowRecord, DialogShadowRecord] {
  return source.map((record) => {
    const payload = codec().open(record.recovery_capsule!, {
      tenant_id: record.tenant_id,
      cell_id: record.cell_id,
      dialog_id: record.dialog_id,
      owner_epoch: record.owner_epoch,
      sequence: record.sequence
    });
    payload.cdr_sequence = 77;
    return {
      ...record,
      owner_node_id: 'rustpbx-b',
      owner_fault_domain: 'zone-b-rack-1',
      owner_epoch: 8,
      sequence: 1,
      state: 'terminated' as const,
      cdr_sequence: 77,
      recorded_at: '2026-07-27T01:00:00.000Z',
      terminal: true,
      terminal_cdr_payload_hash: CDR_HASH,
      takeover_id: 'repair-a',
      recovery_capsule: codec().seal(payload, {
        tenant_id: record.tenant_id,
        cell_id: record.cell_id,
        dialog_id: record.dialog_id,
        owner_epoch: 8,
        sequence: 1
      })
    };
  }) as [DialogShadowRecord, DialogShadowRecord];
}

function recoveryPayload(
  leg: 'caller' | 'callee'
): DialogRecoveryCapsulePayload {
  const caller = leg === 'caller';
  return {
    schema_version: 1,
    call_session_ref: 'call-session-a',
    interaction_id: 'interaction-a',
    dialog_id: caller ? 'dialog-caller' : 'dialog-callee',
    peer_dialog_id: caller ? 'dialog-callee' : 'dialog-caller',
    leg,
    dialog_role: caller ? 'uas' : 'uac',
    raw_call_id: `${leg}-call-id@example.invalid`,
    local_tag: `${leg}-local`,
    remote_tag: `${leg}-remote`,
    from_uri: 'sip:caller@example.invalid',
    to_uri: 'sip:callee@example.invalid',
    local_contact_uri: 'sip:rustpbx-a@example.internal:5060',
    remote_uri: 'sip:peer@example.invalid',
    remote_contact_uri: 'sip:peer@198.51.100.20:5060',
    route_set: ['sip:edge-a.internal:5061;transport=tls;lr'],
    local_cseq: caller ? 22 : 31,
    remote_cseq: caller ? 18 : 29,
    supports_100rel: true,
    media_reservation_id: `reservation/${leg}`,
    cdr_sequence: 76
  };
}
