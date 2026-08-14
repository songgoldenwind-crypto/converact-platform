import { createHash, createHmac, randomUUID } from 'node:crypto';

import {
  DialogRecoveryCapsuleCodec,
  nativeCallRecoveryBindingSha256,
  type DialogRecoveryCapsulePayload
} from './dialog-recovery-capsule.js';
import {
  assertDialogShadowRecord,
  dialogShadowPairHash,
  type DialogShadowProfile,
  type DialogShadowRecord
} from './dialog-shadow.js';

export interface DialogOwnerAuthorityRecord {
  tenant_id: string;
  cell_id: string;
  call_session_ref: string;
  profile: 'VOICE-HA-T1';
  owner_node_id: string;
  owner_fault_domain: string;
  owner_epoch: number;
  owner_epoch_high_watermark: number;
  shadow_pair_hash: string;
  terminal: boolean;
  terminal_shadow_pending: boolean;
  terminal_cdr_sequence: number | null;
  terminal_cdr_payload_hash: string | null;
  terminal_cdr_call_id: string | null;
  terminal_cdr_receipt_id: string | null;
  terminal_cdr_region_id: string | null;
  terminal_cdr_durability_contract_id: string | null;
  pending_takeover_id: string | null;
  pending_owner_node_id: string | null;
  pending_owner_fault_domain: string | null;
  pending_owner_epoch: number | null;
  pending_token_sha256: string | null;
  pending_expires_at: string | null;
  revision: number;
}

export interface DialogPeerIdentity {
  spiffe_id: string;
  cell_id: string;
  node_id: string;
  fault_domain: string;
}

export interface DialogNodeLeaseRecord extends DialogPeerIdentity {
  heartbeat_at: string;
  lease_expires_at: string;
  revision: number;
}

export interface DialogOwnerTakeoverClaimWrite {
  takeover_id: string;
  tenant_id: string;
  cell_id: string;
  call_session_ref: string;
  previous_owner_node_id: string;
  previous_owner_fault_domain: string;
  expected_owner_epoch: number;
  owner_node_id: string;
  owner_fault_domain: string;
  owner_spiffe_id: string;
  shadow_pair_hash: string;
  token_key_id: string;
  token_sha256: string;
  token_expires_at: string;
  idempotency_key: string;
  request_hash: string;
  reason: string;
  claimed_at: Date;
}

export interface DialogOwnerTakeoverConsumeWrite {
  tenant_id: string;
  cell_id: string;
  call_session_ref: string;
  takeover_id: string;
  owner_node_id: string;
  owner_epoch: number;
  token_sha256: string;
  prepared_pair_hash: string;
  consumed_at: Date;
}

export interface DialogOwnerTakeoverStore {
  claim(input: DialogOwnerTakeoverClaimWrite): Promise<{
    authority: DialogOwnerAuthorityRecord;
    takeover_id: string;
    owner_epoch: number;
    token_expires_at: string;
    token_key_id: string;
    state: 'prepared' | 'shadow_prepared' | 'consumed';
    replayed: boolean;
  }>;
  consume(input: DialogOwnerTakeoverConsumeWrite): Promise<DialogOwnerAuthorityRecord>;
  heartbeatNode(input: {
    identity: DialogPeerIdentity;
    heartbeat_at: Date;
    lease_ttl_ms: number;
  }): Promise<DialogNodeLeaseRecord>;
  assertNodeLease(input: {
    identity: DialogPeerIdentity;
    observed_at: Date;
  }): Promise<DialogNodeLeaseRecord>;
  observeCommittedPair(input: {
    records: readonly [DialogShadowRecord, DialogShadowRecord];
    pair_hash: string;
    observed_at: Date;
  }): Promise<DialogOwnerAuthorityRecord>;
  getAuthority(input: {
    tenant_id: string;
    cell_id: string;
    call_session_ref: string;
  }): Promise<DialogOwnerAuthorityRecord | null>;
}

export interface DialogOwnerShadowReader {
  latestRecoveryPair(input: {
    tenant_id: string;
    cell_id: string;
    call_session_ref: string;
    owner_node_id?: string;
    owner_epoch?: number;
    takeover_id?: string;
  }): Promise<DialogShadowRecord[]>;
  resolveRecoveryPair(input: {
    tenant_id: string;
    cell_id: string;
    dialog_id: string;
  }): Promise<{
    call_session_ref: string;
    records: DialogShadowRecord[];
  } | null>;
}

export interface DialogOwnerTakeoverDiscoveryInput {
  profile: DialogShadowProfile;
  tenant_id: string;
  cell_id: string;
  dialog_id: string;
  caller: DialogPeerIdentity;
  idempotency_key: string;
  reason: string;
}

export interface DialogOwnerTakeoverClaimResponse {
  status: 'claimed';
  recovery_mode: 'resume' | 'finalize';
  takeover_id: string;
  owner_node_id: string;
  owner_epoch: number;
  takeover_token: string;
  token_expires_at: string;
  shadow_records: DialogShadowRecord[];
}

export interface DialogOwnerTakeoverClaimInput {
  profile: DialogShadowProfile;
  tenant_id: string;
  cell_id: string;
  call_session_ref: string;
  previous_owner_node_id: string;
  expected_owner_epoch: number;
  owner_node_id: string;
  owner_fault_domain: string;
  owner_spiffe_id: string;
  idempotency_key: string;
  reason: string;
  shadow_records?: DialogShadowRecord[];
}

type EligibleTakeoverPair = Omit<
  DialogOwnerTakeoverClaimWrite,
  | 'takeover_id'
  | 'token_sha256'
  | 'token_key_id'
  | 'token_expires_at'
  | 'request_hash'
  | 'claimed_at'
>;

export class DialogOwnerTakeoverCoordinator {
  readonly #store: DialogOwnerTakeoverStore;
  readonly #recoveryCodec: DialogRecoveryCapsuleCodec;
  readonly #shadowReader: DialogOwnerShadowReader | null;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #tokenKeys: ReadonlyMap<string, Buffer>;
  readonly #currentTokenKeyId: string;
  readonly #tokenTtlMs: number;
  readonly #nodeLeaseTtlMs: number;

  constructor(input: {
    store: DialogOwnerTakeoverStore;
    recovery_codec: DialogRecoveryCapsuleCodec;
    shadow_reader?: DialogOwnerShadowReader;
    now?: () => Date;
    id_factory?: () => string;
    token_hmac_keys: {
      current: { key_id: string; key: Buffer };
      previous?: { key_id: string; key: Buffer };
    };
    token_ttl_ms?: number;
    node_lease_ttl_ms?: number;
  }) {
    this.#store = input.store;
    this.#recoveryCodec = input.recovery_codec;
    this.#shadowReader = input.shadow_reader ?? null;
    this.#now = input.now ?? (() => new Date());
    this.#idFactory = input.id_factory ?? (() => `dto_${randomUUID()}`);
    const currentKey = takeoverHmacKey(input.token_hmac_keys.current);
    const previousKey = input.token_hmac_keys.previous
      ? takeoverHmacKey(input.token_hmac_keys.previous)
      : null;
    if (previousKey?.key_id === currentKey.key_id) {
      throw new Error('takeover HMAC key ids must be distinct');
    }
    this.#currentTokenKeyId = currentKey.key_id;
    this.#tokenKeys = new Map([
      [currentKey.key_id, currentKey.key],
      ...(previousKey ? [[previousKey.key_id, previousKey.key] as const] : [])
    ]);
    this.#tokenTtlMs = integer(
      input.token_ttl_ms ?? 5_000,
      500,
      30_000,
      'token TTL'
    );
    this.#nodeLeaseTtlMs = integer(
      input.node_lease_ttl_ms ?? 3_000,
      1_000,
      30_000,
      'node lease TTL'
    );
  }

  heartbeatNode(identity: DialogPeerIdentity): Promise<DialogNodeLeaseRecord> {
    return this.#store.heartbeatNode({
      identity: checkedIdentity(identity),
      heartbeat_at: validDate(this.#now()),
      lease_ttl_ms: this.#nodeLeaseTtlMs
    });
  }

  assertNodeLease(identity: DialogPeerIdentity): Promise<DialogNodeLeaseRecord> {
    return this.#store.assertNodeLease({
      identity: checkedIdentity(identity),
      observed_at: validDate(this.#now())
    });
  }

  observeCommittedPair(
    records: readonly [DialogShadowRecord, DialogShadowRecord]
  ): Promise<DialogOwnerAuthorityRecord> {
    const checked = records
      .map(assertDialogShadowRecord)
      .sort((left, right) => left.dialog_id.localeCompare(right.dialog_id)) as
      [DialogShadowRecord, DialogShadowRecord];
    if (checked[0].dialog_id === checked[1].dialog_id ||
        checked[0].tenant_id !== checked[1].tenant_id ||
        checked[0].cell_id !== checked[1].cell_id ||
        checked[0].provider_session_ref === null ||
        checked[0].provider_session_ref !== checked[1].provider_session_ref ||
        checked[0].owner_node_id !== checked[1].owner_node_id ||
        checked[0].owner_fault_domain !== checked[1].owner_fault_domain ||
        checked[0].owner_epoch !== checked[1].owner_epoch ||
        checked[0].sequence !== checked[1].sequence ||
        checked[0].terminal !== checked[1].terminal ||
        checked[0].takeover_id !== checked[1].takeover_id) {
      ineligible();
    }
    return this.#store.observeCommittedPair({
      records: checked,
      pair_hash: dialogShadowPairHash(checked),
      observed_at: validDate(this.#now())
    });
  }

  async claimByDialog(
    input: DialogOwnerTakeoverDiscoveryInput
  ): Promise<DialogOwnerTakeoverClaimResponse> {
    if (!this.#shadowReader) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_takeover_unavailable',
        503
      );
    }
    const resolved = await this.#shadowReader.resolveRecoveryPair({
      tenant_id: input.tenant_id,
      cell_id: input.cell_id,
      dialog_id: identifier(input.dialog_id, 'dialog ID')
    });
    if (!resolved || resolved.records.length !== 2) {
      throw new DialogOwnerTakeoverError('dialog_owner_absent', 404);
    }
    const authority = await this.#store.getAuthority({
      tenant_id: input.tenant_id,
      cell_id: input.cell_id,
      call_session_ref: resolved.call_session_ref
    });
    if (authority?.terminal ||
        resolved.records.some((record) => record.terminal)) {
      throw new DialogOwnerTakeoverError('dialog_owner_terminal', 410);
    }
    const caller = checkedIdentity(input.caller);
    if (caller.cell_id !== input.cell_id) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_takeover_identity_mismatch',
        403
      );
    }
    const first = authority
      ? {
          owner_node_id: authority.owner_node_id,
          owner_epoch: authority.owner_epoch
        }
      : assertDialogShadowRecord(resolved.records[0]!);
    return this.#claim({
      profile: input.profile,
      tenant_id: input.tenant_id,
      cell_id: input.cell_id,
      call_session_ref: resolved.call_session_ref,
      previous_owner_node_id: first.owner_node_id,
      expected_owner_epoch: first.owner_epoch,
      owner_node_id: caller.node_id,
      owner_fault_domain: caller.fault_domain,
      owner_spiffe_id: caller.spiffe_id,
      idempotency_key: input.idempotency_key,
      reason: input.reason
    });
  }

  async #claim(
    input: DialogOwnerTakeoverClaimInput
  ): Promise<DialogOwnerTakeoverClaimResponse> {
    const sourceRecords = this.#shadowReader
      ? await this.#shadowReader.latestRecoveryPair({
          tenant_id: input.tenant_id,
          cell_id: input.cell_id,
          call_session_ref: input.call_session_ref,
          owner_node_id: input.previous_owner_node_id,
          owner_epoch: input.expected_owner_epoch
        })
      : input.shadow_records;
    const shadowRecords = Array.isArray(sourceRecords)
      ? sourceRecords.map(assertDialogShadowRecord)
        .sort((left, right) => left.dialog_id.localeCompare(right.dialog_id))
      : [];
    const checked = this.#eligiblePair({
      ...input,
      shadow_records: shadowRecords
    });
    const recoveryMode = recoveryModeForPair(shadowRecords);
    const now = validDate(this.#now());
    const takeoverId = identifier(this.#idFactory(), 'takeover ID');
    const tokenExpiresAt = new Date(now.getTime() + this.#tokenTtlMs).toISOString();
    const token = this.#token({
      key_id: this.#currentTokenKeyId,
      takeover_id: takeoverId,
      token_expires_at: tokenExpiresAt,
      takeover: checked
    });
    const requestHash = sha256(canonicalJson({
      tenant_id: checked.tenant_id,
      cell_id: checked.cell_id,
      call_session_ref: checked.call_session_ref,
      previous_owner_node_id: checked.previous_owner_node_id,
      previous_owner_fault_domain: checked.previous_owner_fault_domain,
      expected_owner_epoch: checked.expected_owner_epoch,
      owner_node_id: checked.owner_node_id,
      owner_fault_domain: checked.owner_fault_domain,
      owner_spiffe_id: checked.owner_spiffe_id,
      shadow_pair_hash: checked.shadow_pair_hash,
      idempotency_key: checked.idempotency_key,
      reason: checked.reason
    }));
    const result = await this.#store.claim({
      takeover_id: takeoverId,
      ...checked,
      token_key_id: this.#currentTokenKeyId,
      token_sha256: sha256(token),
      token_expires_at: tokenExpiresAt,
      request_hash: requestHash,
      claimed_at: now
    });
    this.#assertClaimResult(result, checked);
    const resumedToken = this.#token({
      key_id: result.token_key_id,
      takeover_id: result.takeover_id,
      token_expires_at: result.token_expires_at,
      takeover: checked
    });
    return {
      status: 'claimed',
      recovery_mode: recoveryMode,
      takeover_id: result.takeover_id,
      owner_node_id: checked.owner_node_id,
      owner_epoch: result.owner_epoch,
      takeover_token: resumedToken,
      token_expires_at: result.token_expires_at,
      shadow_records: structuredClone(shadowRecords)
    };
  }

  async consume(input: {
    tenant_id: string;
    cell_id: string;
    call_session_ref: string;
    takeover_id: string;
    owner_node_id: string;
    owner_epoch: number;
    takeover_token: string;
  }): Promise<{
    status: 'active';
    owner_node_id: string;
    owner_epoch: number;
    revision: number;
  }> {
    const checked = {
      tenant_id: identifier(input.tenant_id, 'tenant ID'),
      cell_id: identifier(input.cell_id, 'Cell ID'),
      call_session_ref: identifier(input.call_session_ref, 'call session ref'),
      takeover_id: identifier(input.takeover_id, 'takeover ID'),
      owner_node_id: identifier(input.owner_node_id, 'owner node ID'),
      owner_epoch: integer(input.owner_epoch, 2, 0xffff_ffff, 'owner epoch'),
      takeover_token: takeoverToken(input.takeover_token)
    };
    const preparedPairHash = await this.#preparedPairHash(checked);
    const authority = await this.#store.consume({
      tenant_id: checked.tenant_id,
      cell_id: checked.cell_id,
      call_session_ref: checked.call_session_ref,
      takeover_id: checked.takeover_id,
      owner_node_id: checked.owner_node_id,
      owner_epoch: checked.owner_epoch,
      token_sha256: sha256(checked.takeover_token),
      prepared_pair_hash: preparedPairHash,
      consumed_at: validDate(this.#now())
    });
    if (authority.terminal ||
        authority.owner_node_id !== checked.owner_node_id ||
        authority.owner_epoch !== checked.owner_epoch ||
        authority.pending_takeover_id !== null) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_takeover_activation_mismatch',
        503
      );
    }
    return {
      status: 'active',
      owner_node_id: authority.owner_node_id,
      owner_epoch: authority.owner_epoch,
      revision: authority.revision
    };
  }

  async #preparedPairHash(input: {
    tenant_id: string;
    cell_id: string;
    call_session_ref: string;
    takeover_id: string;
    owner_node_id: string;
    owner_epoch: number;
  }): Promise<string> {
    if (!this.#shadowReader) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_takeover_prepared_pair_unavailable',
        503
      );
    }
    const authority = await this.#store.getAuthority({
      tenant_id: input.tenant_id,
      cell_id: input.cell_id,
      call_session_ref: input.call_session_ref
    });
    const pendingOwner = authority &&
      authority.pending_takeover_id === input.takeover_id &&
      authority.pending_owner_node_id === input.owner_node_id &&
      authority.pending_owner_epoch === input.owner_epoch &&
      authority.pending_owner_fault_domain !== null;
    const activeOwner = authority &&
      authority.pending_takeover_id === null &&
      authority.owner_node_id === input.owner_node_id &&
      authority.owner_epoch === input.owner_epoch;
    if (!authority || authority.terminal || (!pendingOwner && !activeOwner)) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_takeover_token_invalid',
        409
      );
    }
    const ownerFaultDomain = activeOwner
      ? authority.owner_fault_domain
      : authority.pending_owner_fault_domain!;
    const records = (await this.#shadowReader.latestRecoveryPair({
      tenant_id: input.tenant_id,
      cell_id: input.cell_id,
      call_session_ref: input.call_session_ref,
      owner_node_id: input.owner_node_id,
      owner_epoch: input.owner_epoch,
      takeover_id: input.takeover_id
    })).map(assertDialogShadowRecord)
      .sort((left, right) => left.dialog_id.localeCompare(right.dialog_id));
    if (records.length !== 2 ||
        records.some((record) =>
          record.schema_version !== 2 ||
          record.takeover_id !== input.takeover_id ||
          record.owner_node_id !== input.owner_node_id ||
          record.owner_fault_domain !== ownerFaultDomain ||
          record.owner_epoch !== input.owner_epoch ||
          record.sequence !== 1 ||
          record.provider_session_ref !== input.call_session_ref ||
          record.terminal ||
          (record.state !== 'confirmed' &&
            record.state !== 'updating' &&
            record.state !== 'terminating') ||
          !record.recovery_capsule
        )) {
      ineligible();
    }
    recoveryModeForPair(records);
    const payloads = records.map((record) =>
      this.#recoveryCodec.open(record.recovery_capsule!, {
        tenant_id: record.tenant_id,
        cell_id: record.cell_id,
        dialog_id: record.dialog_id,
        owner_epoch: record.owner_epoch,
        sequence: record.sequence
      })
    );
    assertRecoveryPair(records, payloads, input.call_session_ref);
    return dialogShadowPairHash(
      records as [DialogShadowRecord, DialogShadowRecord]
    );
  }

  async checkAuthority(input: {
    tenant_id: string;
    cell_id: string;
    call_session_ref: string;
    owner_node_id: string;
    owner_epoch: number;
  }): Promise<{
    status: 'active' | 'pending' | 'stale' | 'terminal' | 'absent';
    active_owner_node_id: string | null;
    active_owner_epoch: number | null;
  }> {
    const authority = await this.#store.getAuthority({
      tenant_id: identifier(input.tenant_id, 'tenant ID'),
      cell_id: identifier(input.cell_id, 'Cell ID'),
      call_session_ref: identifier(input.call_session_ref, 'call session ref')
    });
    if (!authority) {
      return {
        status: 'absent',
        active_owner_node_id: null,
        active_owner_epoch: null
      };
    }
    const ownerNodeId = identifier(input.owner_node_id, 'owner node ID');
    const ownerEpoch = integer(input.owner_epoch, 1, 0xffff_ffff, 'owner epoch');
    const status = authority.terminal
      ? 'terminal'
      : authority.owner_node_id === ownerNodeId &&
          authority.owner_epoch === ownerEpoch
        ? 'active'
        : authority.pending_owner_node_id === ownerNodeId &&
            authority.pending_owner_epoch === ownerEpoch
          ? 'pending'
          : 'stale';
    return {
      status,
      active_owner_node_id: authority.owner_node_id,
      active_owner_epoch: authority.owner_epoch
    };
  }

  #eligiblePair(
    input: DialogOwnerTakeoverClaimInput & {
      shadow_records: DialogShadowRecord[];
    }
  ): EligibleTakeoverPair {
    try {
      if (input.profile !== 'VOICE-HA-T1' ||
          !Array.isArray(input.shadow_records) ||
          input.shadow_records.length !== 2) {
        ineligible();
      }
      const tenantId = identifier(input.tenant_id, 'tenant ID');
      const cellId = identifier(input.cell_id, 'Cell ID');
      const callSessionRef = identifier(
        input.call_session_ref,
        'call session ref'
      );
      const previousOwnerNodeId = identifier(
        input.previous_owner_node_id,
        'previous owner node ID'
      );
      const expectedOwnerEpoch = integer(
        input.expected_owner_epoch,
        1,
        0xffff_fffe,
        'expected owner epoch'
      );
      const ownerNodeId = identifier(input.owner_node_id, 'owner node ID');
      const ownerFaultDomain = identifier(
        input.owner_fault_domain,
        'owner fault domain'
      );
      const ownerSpiffeId = checkedIdentity({
        spiffe_id: input.owner_spiffe_id,
        cell_id: cellId,
        node_id: ownerNodeId,
        fault_domain: ownerFaultDomain
      }).spiffe_id;
      const idempotencyKey = identifier(
        input.idempotency_key,
        'idempotency key'
      );
      const reason = boundedReason(input.reason);
      const records = input.shadow_records
        .map(assertDialogShadowRecord)
        .sort((left, right) => left.dialog_id.localeCompare(right.dialog_id));
      const first = records[0]!;
      const second = records[1]!;
      recoveryModeForPair(records);
      if (records.some((record) =>
        record.schema_version !== 2 ||
        !record.recovery_capsule ||
        record.terminal ||
        (record.state !== 'confirmed' &&
          record.state !== 'updating' &&
          record.state !== 'terminating') ||
        record.tenant_id !== tenantId ||
        record.cell_id !== cellId ||
        record.owner_node_id !== previousOwnerNodeId ||
        record.owner_epoch !== expectedOwnerEpoch ||
        record.provider_session_ref !== callSessionRef ||
        !record.remote_tag ||
        !record.media_reservation_id
      )) {
        ineligible();
      }
      if (first.dialog_id === second.dialog_id ||
          first.owner_fault_domain !== second.owner_fault_domain ||
          ownerNodeId === previousOwnerNodeId ||
          ownerFaultDomain === first.owner_fault_domain) {
        ineligible();
      }
      const payloads = records.map((record) =>
        this.#recoveryCodec.open(record.recovery_capsule!, {
          tenant_id: record.tenant_id,
          cell_id: record.cell_id,
          dialog_id: record.dialog_id,
          owner_epoch: record.owner_epoch,
          sequence: record.sequence
        })
      );
      assertRecoveryPair(records, payloads, callSessionRef);
      return {
        tenant_id: tenantId,
        cell_id: cellId,
        call_session_ref: callSessionRef,
        previous_owner_node_id: previousOwnerNodeId,
        previous_owner_fault_domain: first.owner_fault_domain,
        expected_owner_epoch: expectedOwnerEpoch,
        owner_node_id: ownerNodeId,
        owner_fault_domain: ownerFaultDomain,
        owner_spiffe_id: ownerSpiffeId,
        shadow_pair_hash: dialogShadowPairHash(
          records as [DialogShadowRecord, DialogShadowRecord]
        ),
        idempotency_key: idempotencyKey,
        reason
      };
    } catch (error) {
      if (error instanceof DialogOwnerTakeoverError) throw error;
      throw new DialogOwnerTakeoverError(
        'dialog_owner_takeover_ineligible',
        409,
        error
      );
    }
  }

  #assertClaimResult(
    result: Awaited<ReturnType<DialogOwnerTakeoverStore['claim']>>,
    input: EligibleTakeoverPair
  ): void {
    const pending = result.state === 'prepared' ||
      result.state === 'shadow_prepared';
    const ownerMatches = pending
      ? result.authority.pending_takeover_id === result.takeover_id &&
        result.authority.pending_owner_node_id === input.owner_node_id &&
        result.authority.pending_owner_epoch === result.owner_epoch
      : result.state === 'consumed' &&
        result.authority.pending_takeover_id === null &&
        result.authority.owner_node_id === input.owner_node_id &&
        result.authority.owner_epoch === result.owner_epoch;
    if (result.authority.terminal ||
        !ownerMatches ||
        result.owner_epoch <= input.expected_owner_epoch ||
        result.owner_epoch > 0xffff_ffff ||
        !this.#tokenKeys.has(result.token_key_id) ||
        !Number.isFinite(Date.parse(result.token_expires_at))) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_takeover_store_mismatch',
        503
      );
    }
  }

  #token(input: {
    key_id: string;
    takeover_id: string;
    token_expires_at: string;
    takeover: EligibleTakeoverPair;
  }): string {
    const key = this.#tokenKeys.get(input.key_id);
    if (!key) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_takeover_token_key_unavailable',
        503
      );
    }
    return createHmac('sha256', key)
      .update(canonicalJson({
        schema_version: 1,
        key_id: input.key_id,
        takeover_id: input.takeover_id,
        token_expires_at: input.token_expires_at,
        tenant_id: input.takeover.tenant_id,
        cell_id: input.takeover.cell_id,
        call_session_ref: input.takeover.call_session_ref,
        owner_node_id: input.takeover.owner_node_id,
        owner_fault_domain: input.takeover.owner_fault_domain,
        owner_spiffe_id: input.takeover.owner_spiffe_id,
        idempotency_key: input.takeover.idempotency_key
      }))
      .digest('base64url');
  }
}

function recoveryModeForPair(
  records: readonly DialogShadowRecord[]
): 'resume' | 'finalize' {
  if (records.length !== 2) ineligible();
  if (records.every((record) => record.state === 'terminating')) {
    return 'finalize';
  }
  if (records.every((record) =>
    record.state === 'confirmed' || record.state === 'updating'
  )) {
    return 'resume';
  }
  ineligible();
}

export class DialogOwnerTakeoverError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    cause?: unknown
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'DialogOwnerTakeoverError';
  }
}

function assertRecoveryPair(
  records: DialogShadowRecord[],
  payloads: DialogRecoveryCapsulePayload[],
  callSessionRef: string
): void {
  const byDialog = new Map(payloads.map((payload) => [payload.dialog_id, payload]));
  const predecessor = payloads[0]?.native_call_binding;
  if (byDialog.size !== 2 ||
      new Set(payloads.map((payload) => payload.leg)).size !== 2 ||
      !predecessor ||
      payloads.some((payload) =>
        payload.schema_version !== 2 ||
        !payload.native_call_binding ||
        nativeCallRecoveryBindingSha256(payload.native_call_binding) !==
          nativeCallRecoveryBindingSha256(predecessor)
      )) {
    ineligible();
  }
  for (const [index, record] of records.entries()) {
    const payload = payloads[index]!;
    const peer = byDialog.get(payload.peer_dialog_id);
    if (!peer ||
        peer.peer_dialog_id !== payload.dialog_id ||
        payload.call_session_ref !== callSessionRef ||
        payload.interaction_id !== payloads[0]!.interaction_id ||
        payload.dialog_id !== record.dialog_id ||
        payload.local_tag !== record.local_tag ||
        payload.remote_tag !== record.remote_tag ||
        payload.local_cseq !== record.local_cseq ||
        payload.remote_cseq !== record.remote_cseq ||
        payload.media_reservation_id !== record.media_reservation_id ||
        payload.cdr_sequence !== record.cdr_sequence ||
        (payload.leg === 'caller' && payload.dialog_role !== 'uas') ||
        (payload.leg === 'callee' && payload.dialog_role !== 'uac')) {
      ineligible();
    }
  }
}

function checkedIdentity(value: DialogPeerIdentity): DialogPeerIdentity {
  const identity = {
    spiffe_id: String(value?.spiffe_id || ''),
    cell_id: identifier(value?.cell_id, 'peer Cell ID'),
    node_id: identifier(value?.node_id, 'peer node ID'),
    fault_domain: identifier(value?.fault_domain, 'peer fault domain')
  };
  let uri: URL;
  try {
    uri = new URL(identity.spiffe_id);
  } catch {
    throw new Error('peer SPIFFE ID is invalid');
  }
  if (uri.protocol !== 'spiffe:' || uri.username || uri.password ||
      uri.search || uri.hash || identity.spiffe_id !== uri.toString()) {
    throw new Error('peer SPIFFE ID is invalid');
  }
  return identity;
}

function takeoverHmacKey(value: {
  key_id: string;
  key: Buffer;
}): { key_id: string; key: Buffer } {
  const keyId = identifier(value?.key_id, 'takeover HMAC key ID');
  if (!Buffer.isBuffer(value?.key) || value.key.byteLength !== 32) {
    throw new Error('takeover HMAC key is invalid');
  }
  return { key_id: keyId, key: Buffer.from(value.key) };
}

function identifier(value: unknown, field: string): string {
  const result = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}

function boundedReason(value: unknown): string {
  const result = String(value || '');
  if (!/^[a-z][a-z0-9._:-]{2,127}$/.test(result)) {
    throw new Error('takeover reason is invalid');
  }
  return result;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum) {
    throw new Error(`${field} is invalid`);
  }
  return Number(value);
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('takeover clock returned an invalid date');
  }
  return value;
}

function takeoverToken(value: unknown): string {
  const result = String(value || '');
  const decoded = Buffer.from(result, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== result) {
    throw new DialogOwnerTakeoverError(
      'dialog_owner_takeover_token_invalid',
      409
    );
  }
  return result;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ineligible(): never {
  throw new DialogOwnerTakeoverError(
    'dialog_owner_takeover_ineligible',
    409
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}
