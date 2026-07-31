import { randomUUID } from 'node:crypto';

import {
  DialogRecoveryCapsuleCodec,
  type DialogRecoveryCapsulePayload
} from './dialog-recovery-capsule.js';
import type {
  DialogOwnerShadowReader,
  DialogPeerIdentity
} from './dialog-owner-takeover.js';
import {
  assertDialogShadowPair,
  dialogShadowPairHash,
  type DialogShadowProfile,
  type DialogShadowRecord
} from './dialog-shadow.js';

export interface DialogTerminalShadowRepairClaim {
  repair_id: string;
  tenant_id: string;
  cell_id: string;
  call_session_ref: string;
  source_owner_node_id: string;
  source_owner_fault_domain: string;
  source_owner_epoch: number;
  source_pair_hash: string;
  repair_owner_node_id: string;
  repair_owner_fault_domain: string;
  repair_owner_epoch: number;
  terminal_cdr_sequence: number;
  terminal_cdr_payload_hash: string;
  terminal_cdr_call_id: string;
  terminal_cdr_receipt_id: string;
  terminal_cdr_region_id: string;
  terminal_cdr_durability_contract_id: string;
  claimed_at: string;
  expires_at: string;
}

export interface DialogTerminalShadowRepairStore {
  heartbeatTerminalShadowRepairWorker(input: {
    identity: DialogPeerIdentity;
    heartbeat_at: Date;
    lease_ttl_ms: number;
  }): Promise<unknown>;
  pendingTenantIds(input: {
    cell_id: string;
    limit: number;
  }): Promise<string[]>;
  claimTerminalShadowRepair(input: {
    repair_id: string;
    tenant_id: string;
    identity: DialogPeerIdentity;
    claimed_at: Date;
    lease_ttl_ms: number;
  }): Promise<DialogTerminalShadowRepairClaim | null>;
  completeTerminalShadowRepair(input: {
    claim: DialogTerminalShadowRepairClaim;
    records: readonly [DialogShadowRecord, DialogShadowRecord];
    pair_hash: string;
    completed_at: Date;
  }): Promise<unknown>;
}

export interface DialogTerminalShadowCommitter {
  commitPair(
    profile: DialogShadowProfile,
    records: readonly [DialogShadowRecord, DialogShadowRecord]
  ): Promise<unknown>;
}

export class DialogTerminalShadowRepairWorker {
  readonly #identity: DialogPeerIdentity;
  readonly #store: DialogTerminalShadowRepairStore;
  readonly #reader: DialogOwnerShadowReader;
  readonly #codec: DialogRecoveryCapsuleCodec;
  readonly #committer: DialogTerminalShadowCommitter;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #leaseTtlMs: number;
  readonly #tenantBatchSize: number;

  constructor(input: {
    identity: DialogPeerIdentity;
    store: DialogTerminalShadowRepairStore;
    shadow_reader: DialogOwnerShadowReader;
    recovery_codec: DialogRecoveryCapsuleCodec;
    shadow_committer: DialogTerminalShadowCommitter;
    now?: () => Date;
    id_factory?: () => string;
    lease_ttl_ms?: number;
    tenant_batch_size?: number;
  }) {
    this.#identity = checkedIdentity(input.identity);
    this.#store = input.store;
    this.#reader = input.shadow_reader;
    this.#codec = input.recovery_codec;
    this.#committer = input.shadow_committer;
    this.#now = input.now ?? (() => new Date());
    this.#idFactory = input.id_factory ?? (() => `dtr_${randomUUID()}`);
    this.#leaseTtlMs = integer(input.lease_ttl_ms ?? 5_000, 500, 60_000);
    this.#tenantBatchSize = integer(input.tenant_batch_size ?? 32, 1, 256);
  }

  async runOnce(): Promise<{
    status: 'idle' | 'repaired';
    repair_id?: string;
  }> {
    await this.#store.heartbeatTerminalShadowRepairWorker({
      identity: this.#identity,
      heartbeat_at: validDate(this.#now()),
      lease_ttl_ms: this.#leaseTtlMs
    });
    const tenants = await this.#store.pendingTenantIds({
      cell_id: this.#identity.cell_id,
      limit: this.#tenantBatchSize
    });
    for (const tenantId of tenants) {
      const now = validDate(this.#now());
      const claim = await this.#store.claimTerminalShadowRepair({
        repair_id: identifier(this.#idFactory()),
        tenant_id: identifier(tenantId),
        identity: this.#identity,
        claimed_at: now,
        lease_ttl_ms: this.#leaseTtlMs
      });
      if (!claim) continue;
      const checkedClaim = checkedRepairClaim(claim, this.#identity);
      const records = await this.#repairPair(checkedClaim, now);
      await this.#committer.commitPair('VOICE-HA-T1', records);
      const pairHash = dialogShadowPairHash(records);
      await this.#store.completeTerminalShadowRepair({
        claim: checkedClaim,
        records,
        pair_hash: pairHash,
        completed_at: now
      });
      return {
        status: 'repaired',
        repair_id: checkedClaim.repair_id
      };
    }
    return { status: 'idle' };
  }

  async #repairPair(
    claim: DialogTerminalShadowRepairClaim,
    now: Date
  ): Promise<[DialogShadowRecord, DialogShadowRecord]> {
    const replay = await this.#reader.latestRecoveryPair({
      tenant_id: claim.tenant_id,
      cell_id: claim.cell_id,
      call_session_ref: claim.call_session_ref,
      owner_node_id: claim.repair_owner_node_id,
      owner_epoch: claim.repair_owner_epoch,
      takeover_id: claim.repair_id
    });
    if (replay.length > 0) {
      return checkedTerminalPair(replay, claim);
    }
    const source = await this.#reader.latestRecoveryPair({
      tenant_id: claim.tenant_id,
      cell_id: claim.cell_id,
      call_session_ref: claim.call_session_ref,
      owner_node_id: claim.source_owner_node_id,
      owner_epoch: claim.source_owner_epoch
    });
    const sourcePair = checkedSourcePair(source, claim, this.#codec);
    return assertDialogShadowPair(sourcePair.map((record) => {
      const payload = openPayload(this.#codec, record);
      const terminalPayload: DialogRecoveryCapsulePayload = {
        ...payload,
        cdr_sequence: claim.terminal_cdr_sequence
      };
      return {
        ...record,
        owner_node_id: claim.repair_owner_node_id,
        owner_fault_domain: claim.repair_owner_fault_domain,
        owner_epoch: claim.repair_owner_epoch,
        sequence: 1,
        state: 'terminated' as const,
        cdr_sequence: claim.terminal_cdr_sequence,
        recorded_at: now.toISOString(),
        terminal: true,
        takeover_id: claim.repair_id,
        terminal_cdr_payload_hash: claim.terminal_cdr_payload_hash,
        recovery_capsule: this.#codec.seal(terminalPayload, {
          tenant_id: claim.tenant_id,
          cell_id: claim.cell_id,
          dialog_id: record.dialog_id,
          owner_epoch: claim.repair_owner_epoch,
          sequence: 1
        })
      };
    }) as [DialogShadowRecord, DialogShadowRecord]);
  }
}

function checkedSourcePair(
  records: DialogShadowRecord[],
  claim: DialogTerminalShadowRepairClaim,
  codec: DialogRecoveryCapsuleCodec
): [DialogShadowRecord, DialogShadowRecord] {
  const pair = assertDialogShadowPair(
    records as [DialogShadowRecord, DialogShadowRecord]
  );
  if (dialogShadowPairHash(pair) !== claim.source_pair_hash ||
      pair.some((record) =>
        record.tenant_id !== claim.tenant_id ||
        record.cell_id !== claim.cell_id ||
        record.provider_session_ref !== claim.call_session_ref ||
        record.owner_node_id !== claim.source_owner_node_id ||
        record.owner_fault_domain !== claim.source_owner_fault_domain ||
        record.owner_epoch !== claim.source_owner_epoch ||
        record.state !== 'terminating' ||
        record.terminal ||
        !record.recovery_capsule
      )) {
    invalid();
  }
  const payloads = pair.map((record) => openPayload(codec, record));
  if (new Set(payloads.map((payload) => payload.leg)).size !== 2 ||
      payloads.some((payload, index) =>
        payload.call_session_ref !== claim.call_session_ref ||
        payload.dialog_id !== pair[index]!.dialog_id ||
        payload.peer_dialog_id === payload.dialog_id
      ) ||
      payloads[0]!.peer_dialog_id !== payloads[1]!.dialog_id ||
      payloads[1]!.peer_dialog_id !== payloads[0]!.dialog_id) {
    invalid();
  }
  return pair;
}

function checkedTerminalPair(
  records: DialogShadowRecord[],
  claim: DialogTerminalShadowRepairClaim
): [DialogShadowRecord, DialogShadowRecord] {
  const pair = assertDialogShadowPair(
    records as [DialogShadowRecord, DialogShadowRecord]
  );
  if (pair.some((record) =>
    record.tenant_id !== claim.tenant_id ||
    record.cell_id !== claim.cell_id ||
    record.provider_session_ref !== claim.call_session_ref ||
    record.owner_node_id !== claim.repair_owner_node_id ||
    record.owner_fault_domain !== claim.repair_owner_fault_domain ||
    record.owner_epoch !== claim.repair_owner_epoch ||
    record.sequence !== 1 ||
    record.state !== 'terminated' ||
    !record.terminal ||
    record.takeover_id !== claim.repair_id ||
    record.cdr_sequence !== claim.terminal_cdr_sequence ||
    record.terminal_cdr_payload_hash !== claim.terminal_cdr_payload_hash
  )) {
    invalid();
  }
  return pair;
}

function openPayload(
  codec: DialogRecoveryCapsuleCodec,
  record: DialogShadowRecord
): DialogRecoveryCapsulePayload {
  if (!record.recovery_capsule) invalid();
  return codec.open(record.recovery_capsule, {
    tenant_id: record.tenant_id,
    cell_id: record.cell_id,
    dialog_id: record.dialog_id,
    owner_epoch: record.owner_epoch,
    sequence: record.sequence
  });
}

function checkedRepairClaim(
  value: DialogTerminalShadowRepairClaim,
  identity: DialogPeerIdentity
): DialogTerminalShadowRepairClaim {
  const result = {
    repair_id: identifier(value.repair_id),
    tenant_id: identifier(value.tenant_id),
    cell_id: identifier(value.cell_id),
    call_session_ref: identifier(value.call_session_ref),
    source_owner_node_id: identifier(value.source_owner_node_id),
    source_owner_fault_domain: identifier(value.source_owner_fault_domain),
    source_owner_epoch: integer(value.source_owner_epoch, 1, 0xffff_fffe),
    source_pair_hash: hash(value.source_pair_hash),
    repair_owner_node_id: identifier(value.repair_owner_node_id),
    repair_owner_fault_domain: identifier(value.repair_owner_fault_domain),
    repair_owner_epoch: integer(value.repair_owner_epoch, 2, 0xffff_ffff),
    terminal_cdr_sequence: integer(
      value.terminal_cdr_sequence,
      1,
      Number.MAX_SAFE_INTEGER
    ),
    terminal_cdr_payload_hash: hash(value.terminal_cdr_payload_hash),
    terminal_cdr_call_id: identifier(value.terminal_cdr_call_id),
    terminal_cdr_receipt_id: identifier(value.terminal_cdr_receipt_id),
    terminal_cdr_region_id: identifier(value.terminal_cdr_region_id),
    terminal_cdr_durability_contract_id: identifier(
      value.terminal_cdr_durability_contract_id
    ),
    claimed_at: timestamp(value.claimed_at),
    expires_at: timestamp(value.expires_at)
  };
  if (result.cell_id !== identity.cell_id ||
      result.repair_owner_node_id !== identity.node_id ||
      result.repair_owner_fault_domain !== identity.fault_domain ||
      result.repair_owner_epoch <= result.source_owner_epoch ||
      Date.parse(result.expires_at) <= Date.parse(result.claimed_at)) {
    invalid();
  }
  return result;
}

function checkedIdentity(value: DialogPeerIdentity): DialogPeerIdentity {
  return {
    spiffe_id: String(value.spiffe_id || ''),
    cell_id: identifier(value.cell_id),
    node_id: identifier(value.node_id),
    fault_domain: identifier(value.fault_domain)
  };
}

function identifier(value: unknown): string {
  const result = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) invalid();
  return result;
}

function hash(value: unknown): string {
  const result = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(result)) invalid();
  return result;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    invalid();
  }
  return result;
}

function timestamp(value: unknown): string {
  const result = String(value || '');
  if (!Number.isFinite(Date.parse(result)) ||
      new Date(result).toISOString() !== result) {
    invalid();
  }
  return result;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return value;
}

function invalid(): never {
  throw new Error('dialog_terminal_shadow_repair_invalid');
}
