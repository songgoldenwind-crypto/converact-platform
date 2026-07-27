import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  DialogRecoveryCapsuleCodec,
  type DialogRecoveryCapsulePayload
} from '../src/agent-runtime/ivekit/voice/dialog-recovery-capsule.js';
import {
  DialogOwnerTakeoverCoordinator,
  DialogOwnerTakeoverError,
  type DialogOwnerAuthorityRecord,
  type DialogOwnerShadowReader,
  type DialogOwnerTakeoverClaimWrite,
  type DialogOwnerTakeoverConsumeWrite,
  type DialogOwnerTakeoverStore
} from '../src/agent-runtime/ivekit/voice/dialog-owner-takeover.js';
import {
  dialogShadowPairHash,
  type
  DialogShadowRecord
} from '../src/agent-runtime/ivekit/voice/dialog-shadow.js';

const KEY = Buffer.alloc(32, 0x55);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const PEER = {
  spiffe_id:
    'spiffe://ivekit.internal/cells/cell-a/fault-domains/zone-b-rack-1/nodes/rustpbx-b',
  cell_id: 'cell-a',
  node_id: 'rustpbx-b',
  fault_domain: 'zone-b-rack-1'
};

class MemoryTakeoverStore implements DialogOwnerTakeoverStore {
  authority: DialogOwnerAuthorityRecord | null = null;
  readonly claims = new Map<string, DialogOwnerTakeoverClaimWrite>();
  readonly claimStates = new Map<string, {
    state: 'prepared' | 'shadow_prepared' | 'consumed';
    prepared_pair_hash: string | null;
  }>();

  async claim(input: DialogOwnerTakeoverClaimWrite) {
    const replay = this.claims.get(input.idempotency_key);
    if (replay) {
      if (replay.request_hash !== input.request_hash) {
        throw new DialogOwnerTakeoverError(
          'dialog_owner_takeover_idempotency_conflict',
          409
        );
      }
      const progress = this.claimStates.get(replay.takeover_id)!;
      const ownerEpoch = progress.state === 'consumed'
        ? this.authority!.owner_epoch
        : this.authority!.pending_owner_epoch!;
      return {
        authority: this.authority!,
        takeover_id: replay.takeover_id,
        owner_epoch: ownerEpoch,
        token_expires_at: replay.token_expires_at,
        token_key_id: replay.token_key_id,
        state: progress.state,
        replayed: true
      };
    }
    if (this.authority &&
        (this.authority.owner_node_id !== input.previous_owner_node_id ||
         this.authority.owner_epoch !== input.expected_owner_epoch)) {
      throw new DialogOwnerTakeoverError('dialog_owner_takeover_stale_owner', 409);
    }
    const ownerEpoch = Math.max(
      input.expected_owner_epoch,
      this.authority?.owner_epoch_high_watermark ?? 0
    ) + 1;
    this.authority = {
      tenant_id: input.tenant_id,
      cell_id: input.cell_id,
      call_session_ref: input.call_session_ref,
      profile: 'VOICE-HA-T1',
      owner_node_id: input.previous_owner_node_id,
      owner_fault_domain: input.previous_owner_fault_domain,
      owner_epoch: input.expected_owner_epoch,
      owner_epoch_high_watermark: ownerEpoch,
      shadow_pair_hash: input.shadow_pair_hash,
      terminal: false,
      terminal_shadow_pending: false,
      terminal_cdr_sequence: null,
      terminal_cdr_payload_hash: null,
      terminal_cdr_call_id: null,
      terminal_cdr_receipt_id: null,
      terminal_cdr_region_id: null,
      terminal_cdr_durability_contract_id: null,
      pending_takeover_id: input.takeover_id,
      pending_owner_node_id: input.owner_node_id,
      pending_owner_fault_domain: input.owner_fault_domain,
      pending_owner_epoch: ownerEpoch,
      pending_token_sha256: input.token_sha256,
      pending_expires_at: input.token_expires_at,
      revision: (this.authority?.revision ?? 0) + 1
    };
    this.claims.set(input.idempotency_key, structuredClone(input));
    this.claimStates.set(input.takeover_id, {
      state: 'prepared',
      prepared_pair_hash: null
    });
    return {
      authority: structuredClone(this.authority),
      takeover_id: input.takeover_id,
      owner_epoch: ownerEpoch,
      token_expires_at: input.token_expires_at,
      token_key_id: input.token_key_id,
      state: 'prepared' as const,
      replayed: false
    };
  }

  async consume(input: DialogOwnerTakeoverConsumeWrite) {
    const authority = this.authority;
    const progress = this.claimStates.get(input.takeover_id);
    if (progress?.state === 'consumed' &&
        progress.prepared_pair_hash === input.prepared_pair_hash &&
        authority?.owner_node_id === input.owner_node_id &&
        authority.owner_epoch === input.owner_epoch &&
        authority.pending_takeover_id === null) {
      return structuredClone(authority);
    }
    if (!authority ||
        progress?.state !== 'shadow_prepared' ||
        progress.prepared_pair_hash !== input.prepared_pair_hash ||
        authority.pending_takeover_id !== input.takeover_id ||
        authority.pending_owner_node_id !== input.owner_node_id ||
        authority.pending_owner_epoch !== input.owner_epoch ||
        authority.pending_token_sha256 !== input.token_sha256 ||
        Date.parse(authority.pending_expires_at!) <= input.consumed_at.getTime()) {
      throw new DialogOwnerTakeoverError('dialog_owner_takeover_token_invalid', 409);
    }
    this.claimStates.set(input.takeover_id, {
      state: 'consumed',
      prepared_pair_hash: input.prepared_pair_hash
    });
    this.authority = {
      ...authority,
      owner_node_id: authority.pending_owner_node_id!,
      owner_fault_domain: authority.pending_owner_fault_domain!,
      owner_epoch: authority.pending_owner_epoch!,
      shadow_pair_hash: input.prepared_pair_hash,
      pending_takeover_id: null,
      pending_owner_node_id: null,
      pending_owner_fault_domain: null,
      pending_owner_epoch: null,
      pending_token_sha256: null,
      pending_expires_at: null,
      revision: authority.revision + 1
    };
    return structuredClone(this.authority);
  }

  async getAuthority(): Promise<DialogOwnerAuthorityRecord | null> {
    return this.authority ? structuredClone(this.authority) : null;
  }

  async heartbeatNode(input: any) {
    return {
      ...input.identity,
      heartbeat_at: input.heartbeat_at.toISOString(),
      lease_expires_at: new Date(
        input.heartbeat_at.getTime() + input.lease_ttl_ms
      ).toISOString(),
      revision: 1
    };
  }

  async assertNodeLease(input: any) {
    return {
      ...input.identity,
      heartbeat_at: '2026-07-26T00:59:59.000Z',
      lease_expires_at: '2026-07-26T01:00:03.000Z',
      revision: 1
    };
  }

  async observeCommittedPair(input: any) {
    if (!this.authority) {
      throw new Error('authority unavailable');
    }
    this.authority = {
      ...this.authority,
      shadow_pair_hash: input.pair_hash,
      terminal: input.records[0].terminal,
      revision: this.authority.revision + 1
    };
    const takeoverId = input.records[0].takeover_id;
    if (takeoverId) {
      this.claimStates.set(takeoverId, {
        state: 'shadow_prepared',
        prepared_pair_hash: input.pair_hash
      });
    }
    return structuredClone(this.authority);
  }
}

function codec() {
  return new DialogRecoveryCapsuleCodec({
    current: { key_id: 'recovery-2026-07', key: KEY },
    random_bytes: (size) => Buffer.alloc(size, 0x66)
  });
}

function coordinator(store = new MemoryTakeoverStore()) {
  const reader = new MemoryShadowReader();
  return {
    store,
    reader,
    coordinator: new DialogOwnerTakeoverCoordinator({
      store,
      recovery_codec: codec(),
      shadow_reader: reader,
      now: () => new Date('2026-07-26T01:00:00.000Z'),
      id_factory: () => 'takeover-a',
      token_hmac_keys: { current: { key_id: 'recovery-2026-07', key: KEY } },
      token_ttl_ms: 5_000
    })
  };
}

class MemoryShadowReader implements DialogOwnerShadowReader {
  records: DialogShadowRecord[] = [record('caller'), record('callee')];

  async latestRecoveryPair(input: {
    tenant_id: string;
    cell_id: string;
    call_session_ref: string;
    owner_node_id?: string;
    owner_epoch?: number;
    takeover_id?: string;
  }): Promise<DialogShadowRecord[]> {
    return this.records.filter((value) =>
      value.tenant_id === input.tenant_id &&
      value.cell_id === input.cell_id &&
      value.provider_session_ref === input.call_session_ref &&
      (input.owner_node_id === undefined ||
       value.owner_node_id === input.owner_node_id) &&
      (input.owner_epoch === undefined ||
       value.owner_epoch === input.owner_epoch) &&
      (input.takeover_id === undefined ||
       value.takeover_id === input.takeover_id)
    );
  }

  async resolveRecoveryPair(input: {
    tenant_id: string;
    cell_id: string;
    dialog_id: string;
  }) {
    const matched = this.records.find((value) =>
      value.tenant_id === input.tenant_id &&
      value.cell_id === input.cell_id &&
      value.dialog_id === input.dialog_id
    );
    return matched?.provider_session_ref
      ? {
          call_session_ref: matched.provider_session_ref,
          records: await this.latestRecoveryPair({
            tenant_id: input.tenant_id,
            cell_id: input.cell_id,
            call_session_ref: matched.provider_session_ref
          })
        }
      : null;
  }
}

function productionCoordinator(store = new MemoryTakeoverStore()) {
  const reader = new MemoryShadowReader();
  return {
    store,
    reader,
    coordinator: new DialogOwnerTakeoverCoordinator({
      store,
      recovery_codec: codec(),
      shadow_reader: reader,
      now: () => new Date('2026-07-26T01:00:00.000Z'),
      id_factory: () => 'takeover-a',
      token_hmac_keys: { current: { key_id: 'recovery-2026-07', key: KEY } },
      token_ttl_ms: 5_000
    })
  };
}

test('production coordinator reads the authoritative latest pair instead of requiring client records', async () => {
  const store = new MemoryTakeoverStore();
  let reads = 0;
  const service = new DialogOwnerTakeoverCoordinator({
    store,
    recovery_codec: codec(),
    shadow_reader: {
      async latestRecoveryPair(input) {
        reads += 1;
        assert.deepEqual(input, {
          tenant_id: 'tenant-a',
          cell_id: 'cell-a',
          call_session_ref: 'call-session-a',
          owner_node_id: 'rustpbx-a',
          owner_epoch: 7
        });
        return [record('caller'), record('callee')];
      },
      async resolveRecoveryPair() {
        return {
          call_session_ref: 'call-session-a',
          records: [record('caller'), record('callee')]
        };
      }
    },
    now: () => new Date('2026-07-26T01:00:00.000Z'),
    id_factory: () => 'takeover-a',
    token_hmac_keys: { current: { key_id: 'recovery-2026-07', key: KEY } }
  });
  const claimed = await service.claimByDialog(claimInput());

  assert.ok(claimed.status === 'claimed');
  assert.equal(reads, 1);
  assert.equal(claimed.shadow_records.length, 2);
});

test('production discovery claim derives session and previous authority from dialog ID', async () => {
  const store = new MemoryTakeoverStore();
  const records = [record('caller'), record('callee')];
  const service = new DialogOwnerTakeoverCoordinator({
    store,
    recovery_codec: codec(),
    shadow_reader: {
      async resolveRecoveryPair(input) {
        assert.deepEqual(input, {
          tenant_id: 'tenant-a',
          cell_id: 'cell-a',
          dialog_id: 'dialog-caller'
        });
        return {
          call_session_ref: 'call-session-a',
          records
        };
      },
      async latestRecoveryPair(input) {
        assert.equal(input.call_session_ref, 'call-session-a');
        assert.equal(input.owner_node_id, 'rustpbx-a');
        assert.equal(input.owner_epoch, 7);
        return records;
      }
    },
    now: () => new Date('2026-07-26T01:00:00.000Z'),
    id_factory: () => 'takeover-a',
    token_hmac_keys: { current: { key_id: 'recovery-2026-07', key: KEY } }
  });

  const claimed = await service.claimByDialog({
    profile: 'VOICE-HA-T1',
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    dialog_id: 'dialog-caller',
    caller: PEER,
    idempotency_key: 'takeover-request-a',
    reason: 'owner_heartbeat_expired'
  });

  assert.equal(claimed.status, 'claimed');
  assert.equal(store.authority?.owner_node_id, 'rustpbx-a');
  assert.equal(store.authority?.owner_epoch, 7);
  assert.equal(store.authority?.call_session_ref, 'call-session-a');
});

function payload(
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
    raw_call_id: caller
      ? 'caller-call-id@example.invalid'
      : 'callee-call-id@example.invalid',
    local_tag: caller ? 'caller-local' : 'callee-local',
    remote_tag: caller ? 'caller-remote' : 'callee-remote',
    from_uri: caller
      ? 'sip:+8613800138000@example.invalid'
      : 'sip:service@example.invalid',
    to_uri: caller
      ? 'sip:service@example.invalid'
      : 'sip:agent-1001@example.invalid',
    local_contact_uri: caller
      ? 'sip:rustpbx-a@example.internal:5060'
      : 'sip:service@example.internal:5060',
    remote_uri: caller
      ? 'sip:+8613800138000@example.invalid'
      : 'sip:agent-1001@example.invalid',
    remote_contact_uri: caller
      ? 'sip:+8613800138000@198.51.100.10:5060'
      : 'sip:agent-1001@198.51.100.20:5060',
    route_set: ['sip:edge-a@example.internal:5061;transport=tls;lr'],
    local_cseq: caller ? 22 : 31,
    remote_cseq: caller ? 18 : 29,
    supports_100rel: true,
    media_reservation_id: caller ? 'reservation-caller' : 'reservation-callee',
    cdr_sequence: caller ? 12 : 13
  };
}

function record(
  leg: 'caller' | 'callee',
  overrides: Partial<DialogShadowRecord> = {}
): DialogShadowRecord {
  const value = payload(leg);
  const base = {
    schema_version: 2 as const,
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    dialog_id: value.dialog_id,
    call_id_hash: leg === 'caller' ? HASH_A : HASH_B,
    owner_node_id: 'rustpbx-a',
    owner_fault_domain: 'zone-a-rack-1',
    owner_epoch: 7,
    sequence: 4,
    state: 'confirmed' as const,
    local_tag: value.local_tag,
    remote_tag: value.remote_tag,
    route_set: ['sip:edge-a.internal:5061;transport=tls;lr'],
    local_cseq: value.local_cseq,
    remote_cseq: value.remote_cseq,
    branch_hash: HASH_C,
    final_response_hash: HASH_B,
    auth_context_ref: 'auth-context-a',
    logical_offer_hash: HASH_A,
    logical_answer_hash: HASH_B,
    media_reservation_id: value.media_reservation_id,
    provider_session_ref: value.call_session_ref,
    cdr_sequence: value.cdr_sequence,
    recorded_at: '2026-07-26T00:59:59.000Z',
    terminal: false,
    recovery_capsule: codec().seal(value, {
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      dialog_id: value.dialog_id,
      owner_epoch: 7,
      sequence: 4
    })
  };
  return { ...base, ...overrides } as DialogShadowRecord;
}

function preparedRecord(
  leg: 'caller' | 'callee',
  takeoverId = 'takeover-a'
): DialogShadowRecord {
  const value = payload(leg);
  return record(leg, {
    owner_node_id: 'rustpbx-b',
    owner_fault_domain: 'zone-b-rack-1',
    owner_epoch: 8,
    sequence: 1,
    recorded_at: '2026-07-26T01:00:00.500Z',
    takeover_id: takeoverId,
    recovery_capsule: codec().seal(value, {
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      dialog_id: value.dialog_id,
      owner_epoch: 8,
      sequence: 1
    })
  });
}

function claimInput(overrides: Record<string, unknown> = {}) {
  return {
    profile: 'VOICE-HA-T1' as const,
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    dialog_id: 'dialog-caller',
    caller: PEER,
    idempotency_key: 'takeover-request-a',
    reason: 'owner_heartbeat_expired',
    ...overrides
  };
}

test('complete confirmed T1 shadow pair receives higher epoch and one-time token', async () => {
  const { coordinator: service, store } = coordinator();

  const claimed = await service.claimByDialog(claimInput());

  assert.equal(claimed.status, 'claimed');
  assert.ok(claimed.status === 'claimed');
  assert.equal(claimed.owner_epoch, 8);
  assert.equal(claimed.takeover_token.length, 43);
  assert.equal(store.authority?.owner_epoch, 7, 'old owner stays active until consume');
  assert.equal(store.authority?.pending_owner_epoch, 8);
  assert.equal(
    store.authority?.pending_token_sha256,
    createHash('sha256').update(claimed.takeover_token).digest('hex')
  );

  const replay = await service.claimByDialog(claimInput());
  assert.deepEqual(replay, claimed);
});

test('terminating T1 shadow pair can only be taken over for finalization', async () => {
  const { coordinator: service, reader } = coordinator();
  reader.records = [
    record('caller', { state: 'terminating' }),
    record('callee', { state: 'terminating' })
  ];

  const claimed = await service.claimByDialog(claimInput());

  assert.equal(claimed.recovery_mode, 'finalize');
  assert.equal(claimed.shadow_records.every(
    (item) => item.state === 'terminating' && item.terminal === false
  ), true);
});

test('terminating takeover consumes only a durable terminating pair', async () => {
  const { coordinator: service, reader, store } = productionCoordinator();
  reader.records = [
    record('caller', { state: 'terminating' }),
    record('callee', { state: 'terminating' })
  ];
  const claimed = await service.claimByDialog(claimInput());
  assert.equal(claimed.recovery_mode, 'finalize');
  const prepared = [
    { ...preparedRecord('caller', claimed.takeover_id), state: 'terminating' as const },
    { ...preparedRecord('callee', claimed.takeover_id), state: 'terminating' as const }
  ] as [DialogShadowRecord, DialogShadowRecord];
  reader.records.push(...prepared);
  await service.observeCommittedPair(prepared);

  const active = await service.consume({
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    takeover_id: claimed.takeover_id,
    owner_node_id: 'rustpbx-b',
    owner_epoch: claimed.owner_epoch,
    takeover_token: claimed.takeover_token
  });

  assert.equal(active.status, 'active');
  assert.equal(store.authority?.owner_epoch, 8);
  assert.equal(store.authority?.terminal, false);
});

test('consuming the token activates new owner and fences stale mutation authority', async () => {
  const { coordinator: service, reader, store } = productionCoordinator();
  const claimed = await service.claimByDialog(claimInput());
  assert.ok(claimed.status === 'claimed');
  const prepared = [
    preparedRecord('caller', claimed.takeover_id),
    preparedRecord('callee', claimed.takeover_id)
  ] as [DialogShadowRecord, DialogShadowRecord];
  reader.records.push(...prepared);
  await service.observeCommittedPair(prepared);

  const active = await service.consume({
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    takeover_id: claimed.takeover_id,
    owner_node_id: 'rustpbx-b',
    owner_epoch: claimed.owner_epoch,
    takeover_token: claimed.takeover_token
  });

  assert.equal(active.status, 'active');
  assert.equal(active.owner_epoch, 8);
  assert.equal(
    store.authority?.shadow_pair_hash,
    dialogShadowPairHash([
      preparedRecord('caller'),
      preparedRecord('callee')
    ])
  );
  assert.equal(
    (await service.checkAuthority({
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      call_session_ref: 'call-session-a',
      owner_node_id: 'rustpbx-a',
      owner_epoch: 7
    })).status,
    'stale'
  );
  assert.equal(
    (await service.checkAuthority({
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      call_session_ref: 'call-session-a',
      owner_node_id: 'rustpbx-b',
      owner_epoch: 8
    })).status,
    'active'
  );
  assert.deepEqual(await service.consume({
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    takeover_id: claimed.takeover_id,
    owner_node_id: 'rustpbx-b',
    owner_epoch: claimed.owner_epoch,
    takeover_token: claimed.takeover_token
  }), active);
});

test('consume refuses to activate authority until the prepared pair is durable', async () => {
  const { coordinator: service, store } = productionCoordinator();
  const claimed = await service.claimByDialog(claimInput());
  assert.ok(claimed.status === 'claimed');

  await assert.rejects(
    service.consume({
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      call_session_ref: 'call-session-a',
      takeover_id: claimed.takeover_id,
      owner_node_id: 'rustpbx-b',
      owner_epoch: claimed.owner_epoch,
      takeover_token: claimed.takeover_token
    }),
    (error) => code(error) === 'dialog_owner_takeover_ineligible'
  );
  assert.equal(store.authority?.owner_node_id, 'rustpbx-a');
  assert.equal(store.authority?.owner_epoch, 7);
});

test('automatic takeover rejects incomplete, early, terminal, non-T1 and same-domain pairs', async () => {
  const cases = [
    {
      records: [record('caller')],
      input: claimInput(),
      expected: 'dialog_owner_absent'
    },
    {
      records: [
        record('caller', { state: 'early' }),
        record('callee')
      ],
      input: claimInput(),
      expected: 'dialog_owner_takeover_ineligible'
    },
    {
      records: [
        record('caller', { state: 'terminated', terminal: true }),
        record('callee')
      ],
      input: claimInput(),
      expected: 'dialog_owner_terminal'
    },
    {
      records: [record('caller'), record('callee')],
      input: claimInput({ profile: 'VOICE-ORDINARY' }),
      expected: 'dialog_owner_takeover_ineligible'
    },
    {
      records: [record('caller'), record('callee')],
      input: claimInput({
        caller: {
          spiffe_id:
            'spiffe://ivekit.internal/cells/cell-a/fault-domains/zone-a-rack-1/nodes/rustpbx-b',
          cell_id: 'cell-a',
          node_id: 'rustpbx-b',
          fault_domain: 'zone-a-rack-1'
        }
      }),
      expected: 'dialog_owner_takeover_ineligible'
    }
  ];
  for (const item of cases) {
    const { coordinator: service, reader } = coordinator();
    reader.records = item.records;
    await assert.rejects(
      service.claimByDialog(item.input as Parameters<typeof service.claimByDialog>[0]),
      (error) => code(error) === item.expected
    );
  }
});

test('takeover rejects incomplete capsule pairs and idempotency payload conflicts', async () => {
  const { coordinator: service, reader } = coordinator();
  const mismatched = record('callee', { provider_session_ref: 'call-session-b' });
  reader.records = [record('caller'), mismatched];
  await assert.rejects(
    service.claimByDialog(claimInput()),
    (error) => code(error) === 'dialog_owner_absent'
  );

  reader.records = [record('caller'), record('callee')];
  await service.claimByDialog(claimInput());
  await assert.rejects(
    service.claimByDialog(claimInput({
      caller: {
        spiffe_id:
          'spiffe://ivekit.internal/cells/cell-a/fault-domains/zone-c-rack-1/nodes/rustpbx-c',
        cell_id: 'cell-a',
        node_id: 'rustpbx-c',
        fault_domain: 'zone-c-rack-1'
      }
    })),
    (error) => code(error) === 'dialog_owner_takeover_idempotency_conflict'
  );
});

function code(error: unknown): string {
  return error instanceof DialogOwnerTakeoverError ? error.code : '';
}
