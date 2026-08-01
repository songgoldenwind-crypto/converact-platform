import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import {
  DialogOwnerTakeoverError,
  type DialogOwnerAuthorityRecord,
  type DialogNodeLeaseRecord,
  type DialogPeerIdentity,
  type DialogOwnerTakeoverClaimWrite,
  type DialogOwnerTakeoverConsumeWrite,
  type DialogOwnerTakeoverStore
} from '../dialog-owner-takeover.js';
import {
  assertDialogShadowPair,
  dialogShadowPairHash,
  type DialogShadowRecord
} from '../dialog-shadow.js';
import {
  type DialogTerminalShadowRepairClaim,
  type DialogTerminalShadowRepairStore
} from '../dialog-terminal-shadow-repair.js';

interface TakeoverReplayRow {
  id: string;
  owner_epoch: number;
  expires_at: string;
  request_hash: string;
  token_key_id: string;
  prepared_pair_hash: string | null;
  state: 'prepared' | 'shadow_prepared' | 'consumed' | 'expired';
}

export class PostgresDialogOwnerTakeoverStore
implements DialogOwnerTakeoverStore, DialogTerminalShadowRepairStore {
  constructor(private readonly pg: PgQueryable) {}

  claim(input: DialogOwnerTakeoverClaimWrite): Promise<{
    authority: DialogOwnerAuthorityRecord;
    takeover_id: string;
    owner_epoch: number;
    token_expires_at: string;
    token_key_id: string;
    state: 'prepared' | 'shadow_prepared' | 'consumed';
    replayed: boolean;
  }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      await pg.query(
        `/* converact-dialog-owner-takeover:seed */
         INSERT INTO ivekit_voice_dialog_ownership
          (tenant_id, cell_id, call_session_ref, profile,
           owner_node_id, owner_fault_domain, owner_epoch,
           owner_epoch_high_watermark, shadow_pair_hash, terminal,
           revision, created_at, updated_at)
         VALUES
          ($1, $2, $3, 'VOICE-HA-T1', $4, $5, $6, $6, $7, FALSE, 1,
           $8::timestamptz, $8::timestamptz)
         ON CONFLICT (tenant_id, cell_id, call_session_ref) DO NOTHING`,
        [
          input.tenant_id,
          input.cell_id,
          input.call_session_ref,
          input.previous_owner_node_id,
          input.previous_owner_fault_domain,
          input.expected_owner_epoch,
          input.shadow_pair_hash,
          input.claimed_at.toISOString()
        ]
      );
      let authority = await this.#lockAuthority(
        pg,
        input.tenant_id,
        input.cell_id,
        input.call_session_ref
      );
      await this.#assertCandidateLease(pg, input);
      const replay = await this.#findReplay(pg, input);
      if (replay) {
        if (replay.request_hash !== input.request_hash) {
          throw new DialogOwnerTakeoverError(
            'dialog_owner_takeover_idempotency_conflict',
            409
          );
        }
        if (replay.state === 'expired') {
          throw new DialogOwnerTakeoverError(
            'dialog_owner_takeover_token_expired',
            409
          );
        }
        assertReplayAuthority(authority, replay);
        return {
          authority,
          takeover_id: replay.id,
          owner_epoch: replay.owner_epoch,
          token_expires_at: replay.expires_at,
          token_key_id: replay.token_key_id,
          state: replay.state,
          replayed: true
        };
      }

      if (authority.pending_takeover_id &&
          authority.pending_expires_at &&
          Date.parse(authority.pending_expires_at) <= input.claimed_at.getTime()) {
        authority = await this.#expirePending(pg, authority, input.claimed_at);
      }
      if (authority.terminal) {
        throw new DialogOwnerTakeoverError(
          'dialog_owner_takeover_ineligible',
          409
        );
      }
      if (authority.pending_takeover_id) {
        throw new DialogOwnerTakeoverError(
          'dialog_owner_takeover_in_progress',
          409
        );
      }
      if (authority.owner_node_id !== input.previous_owner_node_id ||
          authority.owner_fault_domain !== input.previous_owner_fault_domain ||
          authority.owner_epoch !== input.expected_owner_epoch) {
        throw new DialogOwnerTakeoverError(
          'dialog_owner_takeover_stale_owner',
          409
        );
      }
      await this.#assertPreviousOwnerOffline(pg, input);
      const ownerEpoch = Math.max(
        authority.owner_epoch_high_watermark,
        input.expected_owner_epoch
      ) + 1;
      if (ownerEpoch > 0xffff_ffff) {
        throw new DialogOwnerTakeoverError(
          'dialog_owner_takeover_epoch_exhausted',
          503
        );
      }

      const inserted = await pg.query(
        `/* converact-dialog-owner-takeover:insert-attempt */
         INSERT INTO ivekit_voice_dialog_takeovers
          (id, tenant_id, cell_id, call_session_ref, idempotency_key,
           request_hash, previous_owner_node_id, previous_owner_fault_domain,
           previous_owner_epoch, owner_node_id, owner_fault_domain, owner_epoch,
           shadow_pair_hash, token_key_id, token_sha256, reason, state, claimed_at,
           expires_at, consumed_at, updated_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, 'prepared', $17::timestamptz, $18::timestamptz,
           NULL, $17::timestamptz)
         RETURNING id, owner_epoch, expires_at, request_hash, token_key_id,
           prepared_pair_hash, state`,
        [
          input.takeover_id,
          input.tenant_id,
          input.cell_id,
          input.call_session_ref,
          input.idempotency_key,
          input.request_hash,
          input.previous_owner_node_id,
          input.previous_owner_fault_domain,
          input.expected_owner_epoch,
          input.owner_node_id,
          input.owner_fault_domain,
          ownerEpoch,
          input.shadow_pair_hash,
          input.token_key_id,
          input.token_sha256,
          input.reason,
          input.claimed_at.toISOString(),
          input.token_expires_at
        ]
      );
      if (!inserted.rows[0]) unavailable();
      const attempt = decodeReplay(inserted.rows[0]);
      if (attempt.id !== input.takeover_id ||
          attempt.owner_epoch !== ownerEpoch ||
          attempt.request_hash !== input.request_hash ||
          attempt.state !== 'prepared') {
        unavailable();
      }

      const updated = await pg.query(
        `/* converact-dialog-owner-takeover:publish-pending */
         UPDATE ivekit_voice_dialog_ownership
         SET owner_epoch_high_watermark = $4,
             shadow_pair_hash = $5,
             pending_takeover_id = $6,
             pending_owner_node_id = $7,
             pending_owner_fault_domain = $8,
             pending_owner_epoch = $4,
             pending_token_sha256 = $9,
             pending_expires_at = $10::timestamptz,
             revision = revision + 1,
             updated_at = $11::timestamptz
         WHERE tenant_id = $1
           AND cell_id = $2
           AND call_session_ref = $3
           AND owner_node_id = $12
           AND owner_epoch = $13
           AND pending_takeover_id IS NULL
           AND terminal = FALSE
         RETURNING ${AUTHORITY_COLUMNS}`,
        [
          input.tenant_id,
          input.cell_id,
          input.call_session_ref,
          ownerEpoch,
          input.shadow_pair_hash,
          input.takeover_id,
          input.owner_node_id,
          input.owner_fault_domain,
          input.token_sha256,
          input.token_expires_at,
          input.claimed_at.toISOString(),
          input.previous_owner_node_id,
          input.expected_owner_epoch
        ]
      );
      if (!updated.rows[0]) unavailable();
      authority = decodeAuthority(updated.rows[0]);
      assertPendingAuthority(authority, input, ownerEpoch);
      return {
        authority,
        takeover_id: attempt.id,
        owner_epoch: ownerEpoch,
        token_expires_at: attempt.expires_at,
        token_key_id: attempt.token_key_id,
        state: 'prepared',
        replayed: false
      };
    });
  }

  consume(
    input: DialogOwnerTakeoverConsumeWrite
  ): Promise<DialogOwnerAuthorityRecord> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const authority = await this.#lockAuthority(
        pg,
        input.tenant_id,
        input.cell_id,
        input.call_session_ref
      );
      const replay = await this.#findAttemptById(pg, input);
      if (replay?.state === 'consumed' &&
          replay.owner_epoch === input.owner_epoch &&
          replay.prepared_pair_hash === input.prepared_pair_hash &&
          authority.owner_node_id === input.owner_node_id &&
          authority.owner_epoch === input.owner_epoch &&
          authority.pending_takeover_id === null) {
        return authority;
      }
      if (authority.terminal ||
          authority.pending_takeover_id !== input.takeover_id ||
          authority.pending_owner_node_id !== input.owner_node_id ||
          authority.pending_owner_epoch !== input.owner_epoch ||
          authority.pending_token_sha256 !== input.token_sha256 ||
          !authority.pending_expires_at ||
          !replay ||
          !['prepared', 'shadow_prepared'].includes(replay.state) ||
          (replay.state === 'prepared' &&
            Date.parse(authority.pending_expires_at) <= input.consumed_at.getTime())) {
        throw new DialogOwnerTakeoverError(
          'dialog_owner_takeover_token_invalid',
          409
        );
      }
      const consumed = await pg.query(
        `/* converact-dialog-owner-takeover:consume-attempt */
         UPDATE ivekit_voice_dialog_takeovers
         SET state = 'consumed',
             prepared_pair_hash = $8,
             consumed_at = $9::timestamptz,
             updated_at = $9::timestamptz
         WHERE id = $1
           AND tenant_id = $2
           AND cell_id = $3
           AND call_session_ref = $4
           AND owner_node_id = $5
           AND owner_epoch = $6
           AND token_sha256 = $7
           AND state = 'shadow_prepared'
           AND prepared_pair_hash = $8
         RETURNING id, owner_epoch, expires_at, request_hash, token_key_id,
           prepared_pair_hash, state`,
        [
          input.takeover_id,
          input.tenant_id,
          input.cell_id,
          input.call_session_ref,
          input.owner_node_id,
          input.owner_epoch,
          input.token_sha256,
          input.prepared_pair_hash,
          input.consumed_at.toISOString()
        ]
      );
      if (!consumed.rows[0] ||
          decodeReplay(consumed.rows[0]).state !== 'consumed') {
        throw new DialogOwnerTakeoverError(
          'dialog_owner_takeover_token_invalid',
          409
        );
      }

      const activated = await pg.query(
        `/* converact-dialog-owner-takeover:activate-owner */
         UPDATE ivekit_voice_dialog_ownership
         SET owner_node_id = pending_owner_node_id,
             owner_fault_domain = pending_owner_fault_domain,
             owner_epoch = pending_owner_epoch,
             shadow_pair_hash = $7,
             pending_takeover_id = NULL,
             pending_owner_node_id = NULL,
             pending_owner_fault_domain = NULL,
             pending_owner_epoch = NULL,
             pending_token_sha256 = NULL,
             pending_expires_at = NULL,
             revision = revision + 1,
             updated_at = $8::timestamptz
         WHERE tenant_id = $1
           AND cell_id = $2
           AND call_session_ref = $3
           AND pending_takeover_id = $4
           AND pending_owner_node_id = $5
           AND pending_owner_epoch = $6
           AND terminal = FALSE
         RETURNING ${AUTHORITY_COLUMNS}`,
        [
          input.tenant_id,
          input.cell_id,
          input.call_session_ref,
          input.takeover_id,
          input.owner_node_id,
          input.owner_epoch,
          input.prepared_pair_hash,
          input.consumed_at.toISOString()
        ]
      );
      if (!activated.rows[0]) unavailable();
      const result = decodeAuthority(activated.rows[0]);
      if (result.owner_node_id !== input.owner_node_id ||
          result.owner_epoch !== input.owner_epoch ||
          result.pending_takeover_id !== null) {
        unavailable();
      }
      return result;
    });
  }

  async heartbeatNode(input: {
    identity: DialogPeerIdentity;
    heartbeat_at: Date;
    lease_ttl_ms: number;
  }): Promise<DialogNodeLeaseRecord> {
    const expiresAt = new Date(
      input.heartbeat_at.getTime() + input.lease_ttl_ms
    ).toISOString();
    const result = await this.pg.query(
      `/* converact-dialog-owner-takeover:heartbeat-node */
       INSERT INTO ivekit_voice_dialog_node_leases
        (cell_id, node_id, fault_domain, spiffe_id, heartbeat_at,
         lease_expires_at, revision)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 1)
       ON CONFLICT (cell_id, node_id) DO UPDATE
       SET fault_domain = EXCLUDED.fault_domain,
           spiffe_id = EXCLUDED.spiffe_id,
           heartbeat_at = EXCLUDED.heartbeat_at,
           lease_expires_at = EXCLUDED.lease_expires_at,
           revision = ivekit_voice_dialog_node_leases.revision + 1
       WHERE ivekit_voice_dialog_node_leases.spiffe_id = EXCLUDED.spiffe_id
       RETURNING cell_id, node_id, fault_domain, spiffe_id, heartbeat_at,
         lease_expires_at, revision`,
      [
        input.identity.cell_id,
        input.identity.node_id,
        input.identity.fault_domain,
        input.identity.spiffe_id,
        input.heartbeat_at.toISOString(),
        expiresAt
      ]
    );
    if (!result.rows[0]) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_node_identity_conflict',
        409
      );
    }
    return decodeNodeLease(result.rows[0]);
  }

  async assertNodeLease(input: {
    identity: DialogPeerIdentity;
    observed_at: Date;
  }): Promise<DialogNodeLeaseRecord> {
    const result = await this.pg.query(
      `/* converact-dialog-owner-takeover:assert-node-lease */
       SELECT cell_id, node_id, fault_domain, spiffe_id, heartbeat_at,
         lease_expires_at, revision
       FROM ivekit_voice_dialog_node_leases
       WHERE cell_id = $1
         AND node_id = $2
         AND fault_domain = $3
         AND spiffe_id = $4
         AND lease_expires_at > $5::timestamptz`,
      [
        input.identity.cell_id,
        input.identity.node_id,
        input.identity.fault_domain,
        input.identity.spiffe_id,
        input.observed_at.toISOString()
      ]
    );
    if (!result.rows[0]) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_node_lease_inactive',
        503
      );
    }
    return decodeNodeLease(result.rows[0]);
  }

  observeCommittedPair(input: {
    records: readonly [DialogShadowRecord, DialogShadowRecord];
    pair_hash: string;
    observed_at: Date;
  }): Promise<DialogOwnerAuthorityRecord> {
    const first = input.records[0];
    const callSessionRef = first.provider_session_ref;
    if (!callSessionRef) unavailable();
    return withPgTenant(this.pg, first.tenant_id, async (pg) => {
      await pg.query(
        `/* converact-dialog-owner-takeover:observe-seed */
         INSERT INTO ivekit_voice_dialog_ownership
          (tenant_id, cell_id, call_session_ref, profile,
           owner_node_id, owner_fault_domain, owner_epoch,
           owner_epoch_high_watermark, shadow_pair_hash, terminal,
           revision, created_at, updated_at)
         VALUES
          ($1, $2, $3, 'VOICE-HA-T1', $4, $5, $6, $6, $7, $8, 1,
           $9::timestamptz, $9::timestamptz)
         ON CONFLICT (tenant_id, cell_id, call_session_ref) DO NOTHING`,
        [
          first.tenant_id,
          first.cell_id,
          callSessionRef,
          first.owner_node_id,
          first.owner_fault_domain,
          first.owner_epoch,
          input.pair_hash,
          first.terminal,
          input.observed_at.toISOString()
        ]
      );
      const authority = await this.#lockAuthority(
        pg,
        first.tenant_id,
        first.cell_id,
        callSessionRef
      );
      if (authority.terminal && !first.terminal) {
        throw new DialogOwnerTakeoverError('dialog_owner_terminal', 410);
      }
      const pendingMatch = first.takeover_id !== null &&
        authority.pending_takeover_id === first.takeover_id &&
        authority.pending_owner_node_id === first.owner_node_id &&
        authority.pending_owner_fault_domain === first.owner_fault_domain &&
        authority.pending_owner_epoch === first.owner_epoch;
      if (pendingMatch) {
        const prepared = await pg.query(
          `/* converact-dialog-owner-takeover:observe-prepared-pair */
           UPDATE ivekit_voice_dialog_takeovers
           SET state = 'shadow_prepared',
               prepared_pair_hash = $5,
               updated_at = $6::timestamptz
           WHERE id = $1
             AND tenant_id = $2
             AND cell_id = $3
             AND call_session_ref = $4
             AND state IN ('prepared', 'shadow_prepared')
             AND (prepared_pair_hash IS NULL OR prepared_pair_hash = $5)
           RETURNING id`,
          [
            first.takeover_id,
            first.tenant_id,
            first.cell_id,
            callSessionRef,
            input.pair_hash,
            input.observed_at.toISOString()
          ]
        );
        if (!prepared.rows[0]) unavailable();
        return authority;
      }
      if (authority.pending_takeover_id !== null ||
          authority.owner_node_id !== first.owner_node_id ||
          authority.owner_fault_domain !== first.owner_fault_domain ||
          authority.owner_epoch !== first.owner_epoch) {
        throw new DialogOwnerTakeoverError(
          'dialog_owner_takeover_stale_owner',
          409
        );
      }
      const updated = await pg.query(
        `/* converact-dialog-owner-takeover:observe-active-pair */
         UPDATE ivekit_voice_dialog_ownership
         SET shadow_pair_hash = $4,
             terminal = $5,
             terminal_shadow_pending = CASE
               WHEN $5 = TRUE THEN FALSE ELSE terminal_shadow_pending END,
             revision = revision + 1,
             updated_at = $6::timestamptz
         WHERE tenant_id = $1
           AND cell_id = $2
           AND call_session_ref = $3
           AND owner_node_id = $7
           AND owner_epoch = $8
           AND pending_takeover_id IS NULL
           AND (terminal = FALSE OR $5 = TRUE)
         RETURNING ${AUTHORITY_COLUMNS}`,
        [
          first.tenant_id,
          first.cell_id,
          callSessionRef,
          input.pair_hash,
          first.terminal,
          input.observed_at.toISOString(),
          first.owner_node_id,
          first.owner_epoch
        ]
      );
      if (!updated.rows[0]) unavailable();
      return decodeAuthority(updated.rows[0]);
    });
  }

  async pendingTenantIds(input: {
    cell_id: string;
    limit: number;
  }): Promise<string[]> {
    const cellId = identifier(input.cell_id);
    const limit = integer(input.limit, 1, 256);
    const result = await this.pg.query(
      `/* converact-dialog-terminal-repair:pending-tenants */
       SELECT tenant_id
       FROM opc_ivekit_terminal_shadow_repair_tenant_ids($1, $2)`,
      [cellId, limit]
    );
    return result.rows.map((row) => identifier(row.tenant_id));
  }

  async heartbeatTerminalShadowRepairWorker(input: {
    identity: DialogPeerIdentity;
    heartbeat_at: Date;
    lease_ttl_ms: number;
  }): Promise<void> {
    const identity = {
      spiffe_id: spiffeId(input.identity.spiffe_id),
      cell_id: identifier(input.identity.cell_id),
      node_id: identifier(input.identity.node_id),
      fault_domain: identifier(input.identity.fault_domain)
    };
    const heartbeatAt = timestamp(input.heartbeat_at);
    const leaseTtlMs = integer(input.lease_ttl_ms, 500, 60_000);
    const expiresAt = new Date(
      Date.parse(heartbeatAt) + leaseTtlMs
    ).toISOString();
    const result = await this.pg.query(
      `/* converact-dialog-terminal-repair:heartbeat-worker */
       INSERT INTO ivekit_voice_terminal_repair_worker_leases
        (cell_id, worker_id, fault_domain, spiffe_id, heartbeat_at,
         lease_expires_at, revision)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 1)
       ON CONFLICT (cell_id, worker_id) DO UPDATE
       SET fault_domain = EXCLUDED.fault_domain,
           spiffe_id = EXCLUDED.spiffe_id,
           heartbeat_at = EXCLUDED.heartbeat_at,
           lease_expires_at = EXCLUDED.lease_expires_at,
           revision =
             ivekit_voice_terminal_repair_worker_leases.revision + 1
       WHERE ivekit_voice_terminal_repair_worker_leases.spiffe_id =
             EXCLUDED.spiffe_id
       RETURNING worker_id`,
      [
        identity.cell_id,
        identity.node_id,
        identity.fault_domain,
        identity.spiffe_id,
        heartbeatAt,
        expiresAt
      ]
    );
    if (!result.rows[0]) {
      throw new DialogOwnerTakeoverError(
        'dialog_terminal_shadow_repair_identity_conflict',
        409
      );
    }
  }

  claimTerminalShadowRepair(input: {
    repair_id: string;
    tenant_id: string;
    identity: DialogPeerIdentity;
    claimed_at: Date;
    lease_ttl_ms: number;
  }): Promise<DialogTerminalShadowRepairClaim | null> {
    const repairId = identifier(input.repair_id);
    const tenantId = identifier(input.tenant_id);
    const identity = {
      spiffe_id: spiffeId(input.identity.spiffe_id),
      cell_id: identifier(input.identity.cell_id),
      node_id: identifier(input.identity.node_id),
      fault_domain: identifier(input.identity.fault_domain)
    };
    const claimedAt = timestamp(input.claimed_at);
    const leaseTtlMs = integer(input.lease_ttl_ms, 500, 60_000);
    const expiresAt = new Date(
      Date.parse(claimedAt) + leaseTtlMs
    ).toISOString();
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const lease = await pg.query(
        `/* converact-dialog-terminal-repair:assert-worker-lease */
         SELECT worker_id
         FROM ivekit_voice_terminal_repair_worker_leases
         WHERE cell_id = $1
           AND worker_id = $2
           AND fault_domain = $3
           AND spiffe_id = $4
           AND lease_expires_at > $5::timestamptz
         FOR UPDATE`,
        [
          identity.cell_id,
          identity.node_id,
          identity.fault_domain,
          identity.spiffe_id,
          claimedAt
        ]
      );
      if (!lease.rows[0]) {
        throw new DialogOwnerTakeoverError(
          'dialog_terminal_shadow_repair_candidate_inactive',
          503
        );
      }
      const authorityResult = await pg.query(
        `/* converact-dialog-terminal-repair:lock-authority */
         SELECT ${AUTHORITY_COLUMNS_OWNERSHIP}
         FROM ivekit_voice_dialog_ownership ownership
         JOIN ivekit_voice_cdr_receipts receipt
           ON receipt.tenant_id = ownership.tenant_id
          AND receipt.receipt_id = ownership.terminal_cdr_receipt_id
          AND receipt.call_id = ownership.terminal_cdr_call_id
          AND receipt.acknowledged_sequence = ownership.terminal_cdr_sequence
          AND receipt.acknowledged_payload_hash =
            ownership.terminal_cdr_payload_hash
          AND receipt.region_id = ownership.terminal_cdr_region_id
          AND receipt.durability_contract_id =
            ownership.terminal_cdr_durability_contract_id
          AND receipt.cell_id = ownership.cell_id
          AND receipt.owner_node_id = ownership.owner_node_id
          AND receipt.owner_epoch = ownership.owner_epoch
          AND receipt.availability_profile = ownership.profile
         JOIN ivekit_voice_cdr_calls cdr_call
           ON cdr_call.tenant_id = receipt.tenant_id
          AND cdr_call.call_id = receipt.call_id
          AND cdr_call.provider_call_id = ownership.call_session_ref
          AND cdr_call.receipt_id = receipt.receipt_id
          AND cdr_call.state = 'committed'
         WHERE ownership.tenant_id = $1
           AND ownership.cell_id = $2
           AND ownership.terminal = TRUE
           AND ownership.terminal_shadow_pending = TRUE
           AND ownership.terminal_cdr_sequence IS NOT NULL
           AND ownership.terminal_cdr_payload_hash IS NOT NULL
           AND ownership.terminal_cdr_call_id IS NOT NULL
           AND ownership.terminal_cdr_receipt_id IS NOT NULL
           AND ownership.terminal_cdr_region_id IS NOT NULL
           AND ownership.terminal_cdr_durability_contract_id IS NOT NULL
           AND ownership.pending_takeover_id IS NULL
         ORDER BY ownership.updated_at, ownership.call_session_ref
         LIMIT 1
         FOR UPDATE OF ownership SKIP LOCKED`,
        [tenantId, identity.cell_id]
      );
      if (!authorityResult.rows[0]) return null;
      const authority = decodeAuthority(authorityResult.rows[0]);
      const existingResult = await pg.query(
        `/* converact-dialog-terminal-repair:find-claim */
         SELECT id, tenant_id, cell_id, call_session_ref,
           source_owner_node_id, source_owner_fault_domain,
           source_owner_epoch, source_pair_hash,
           repair_owner_node_id, repair_owner_fault_domain,
           repair_owner_epoch, terminal_cdr_sequence,
           terminal_cdr_payload_hash, terminal_cdr_call_id,
           terminal_cdr_receipt_id, terminal_cdr_region_id,
           terminal_cdr_durability_contract_id, claimed_at, expires_at
         FROM ivekit_voice_dialog_terminal_repairs
         WHERE tenant_id = $1
           AND cell_id = $2
           AND call_session_ref = $3
           AND state = 'claimed'
         ORDER BY repair_owner_epoch DESC
         LIMIT 1
         FOR UPDATE`,
        [tenantId, identity.cell_id, authority.call_session_ref]
      );
      if (existingResult.rows[0]) {
        const existing = decodeTerminalRepair(existingResult.rows[0]);
        if (!matchesTerminalCdrAuthority(existing, authority)) unavailable();
        const sameOwner = existing.repair_owner_node_id === identity.node_id &&
          existing.repair_owner_fault_domain === identity.fault_domain;
        if (!sameOwner) {
          if (Date.parse(existing.expires_at) > Date.parse(claimedAt)) {
            return null;
          }
          await pg.query(
            `/* converact-dialog-terminal-repair:expire-foreign-claim */
             UPDATE ivekit_voice_dialog_terminal_repairs
             SET state = 'expired',
                 updated_at = $5::timestamptz
             WHERE id = $1
               AND tenant_id = $2
               AND cell_id = $3
               AND call_session_ref = $4
               AND state = 'claimed'
               AND expires_at <= $5::timestamptz`,
            [
              existing.repair_id,
              tenantId,
              identity.cell_id,
              authority.call_session_ref,
              claimedAt
            ]
          );
          return null;
        }
        if (Date.parse(existing.expires_at) <= Date.parse(claimedAt)) {
          const renewed = await pg.query(
            `/* converact-dialog-terminal-repair:renew-local-claim */
             UPDATE ivekit_voice_dialog_terminal_repairs
             SET expires_at = $5::timestamptz,
                 updated_at = $6::timestamptz
             WHERE id = $1
               AND tenant_id = $2
               AND cell_id = $3
               AND call_session_ref = $4
               AND state = 'claimed'
             RETURNING id, tenant_id, cell_id, call_session_ref,
               source_owner_node_id, source_owner_fault_domain,
               source_owner_epoch, source_pair_hash,
               repair_owner_node_id, repair_owner_fault_domain,
               repair_owner_epoch, terminal_cdr_sequence,
               terminal_cdr_payload_hash, terminal_cdr_call_id,
               terminal_cdr_receipt_id, terminal_cdr_region_id,
               terminal_cdr_durability_contract_id, claimed_at, expires_at`,
            [
              existing.repair_id,
              tenantId,
              identity.cell_id,
              authority.call_session_ref,
              expiresAt,
              claimedAt
            ]
          );
          if (!renewed.rows[0]) unavailable();
          return decodeTerminalRepair(renewed.rows[0]);
        }
        return existing;
      }
      const ownerEpoch = authority.owner_epoch_high_watermark + 1;
      if (ownerEpoch > 0xffff_ffff ||
          authority.terminal_cdr_sequence === null ||
          authority.terminal_cdr_payload_hash === null ||
          authority.terminal_cdr_call_id === null ||
          authority.terminal_cdr_receipt_id === null ||
          authority.terminal_cdr_region_id === null ||
          authority.terminal_cdr_durability_contract_id === null) {
        unavailable();
      }
      const reserved = await pg.query(
        `/* converact-dialog-terminal-repair:reserve-epoch */
         UPDATE ivekit_voice_dialog_ownership
         SET owner_epoch_high_watermark = $4,
             revision = revision + 1,
             updated_at = $5::timestamptz
         WHERE tenant_id = $1
           AND cell_id = $2
           AND call_session_ref = $3
           AND owner_epoch_high_watermark < $4
           AND terminal = TRUE
           AND terminal_shadow_pending = TRUE
           AND terminal_cdr_sequence = $6
           AND terminal_cdr_payload_hash = $7
           AND terminal_cdr_call_id = $8
           AND terminal_cdr_receipt_id = $9
           AND terminal_cdr_region_id = $10
           AND terminal_cdr_durability_contract_id = $11
           AND pending_takeover_id IS NULL
         RETURNING ${AUTHORITY_COLUMNS}`,
        [
          tenantId,
          identity.cell_id,
          authority.call_session_ref,
          ownerEpoch,
          claimedAt,
          authority.terminal_cdr_sequence,
          authority.terminal_cdr_payload_hash,
          authority.terminal_cdr_call_id,
          authority.terminal_cdr_receipt_id,
          authority.terminal_cdr_region_id,
          authority.terminal_cdr_durability_contract_id
        ]
      );
      if (!reserved.rows[0]) unavailable();
      const inserted = await pg.query(
        `/* converact-dialog-terminal-repair:insert-claim */
         INSERT INTO ivekit_voice_dialog_terminal_repairs
          (id, tenant_id, cell_id, call_session_ref,
           source_owner_node_id, source_owner_fault_domain,
           source_owner_epoch, source_pair_hash,
           repair_owner_node_id, repair_owner_fault_domain,
           repair_owner_epoch, terminal_cdr_sequence,
           terminal_cdr_payload_hash, terminal_cdr_call_id,
           terminal_cdr_receipt_id, terminal_cdr_region_id,
           terminal_cdr_durability_contract_id, state, claimed_at, expires_at,
           completed_at, terminal_pair_hash, updated_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, 'claimed', $18::timestamptz,
           $19::timestamptz, NULL, NULL, $18::timestamptz)
         RETURNING id, tenant_id, cell_id, call_session_ref,
           source_owner_node_id, source_owner_fault_domain,
           source_owner_epoch, source_pair_hash,
           repair_owner_node_id, repair_owner_fault_domain,
           repair_owner_epoch, terminal_cdr_sequence,
           terminal_cdr_payload_hash, terminal_cdr_call_id,
           terminal_cdr_receipt_id, terminal_cdr_region_id,
           terminal_cdr_durability_contract_id, claimed_at, expires_at`,
        [
          repairId,
          tenantId,
          identity.cell_id,
          authority.call_session_ref,
          authority.owner_node_id,
          authority.owner_fault_domain,
          authority.owner_epoch,
          authority.shadow_pair_hash,
          identity.node_id,
          identity.fault_domain,
          ownerEpoch,
          authority.terminal_cdr_sequence,
          authority.terminal_cdr_payload_hash,
          authority.terminal_cdr_call_id,
          authority.terminal_cdr_receipt_id,
          authority.terminal_cdr_region_id,
          authority.terminal_cdr_durability_contract_id,
          claimedAt,
          expiresAt
        ]
      );
      if (!inserted.rows[0]) unavailable();
      return decodeTerminalRepair(inserted.rows[0]);
    });
  }

  completeTerminalShadowRepair(input: {
    claim: DialogTerminalShadowRepairClaim;
    records: readonly [DialogShadowRecord, DialogShadowRecord];
    pair_hash: string;
    completed_at: Date;
  }): Promise<DialogOwnerAuthorityRecord> {
    const claim = decodeTerminalRepair(repairRow(input.claim));
    const records = assertDialogShadowPair(input.records);
    const pairHash = hash(input.pair_hash);
    const completedAt = timestamp(input.completed_at);
    if (dialogShadowPairHash(records) !== pairHash ||
        records.some((record) =>
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
          record.terminal_cdr_payload_hash !==
            claim.terminal_cdr_payload_hash
        )) {
      throw new DialogOwnerTakeoverError(
        'dialog_terminal_shadow_repair_binding_mismatch',
        409
      );
    }
    return withPgTenant(this.pg, claim.tenant_id, async (pg) => {
      const result = await pg.query(
        `/* converact-dialog-terminal-repair:complete */
         WITH bound_receipt AS (
           SELECT receipt.receipt_id
           FROM ivekit_voice_cdr_receipts receipt
           JOIN ivekit_voice_cdr_calls cdr_call
             ON cdr_call.tenant_id = receipt.tenant_id
            AND cdr_call.call_id = receipt.call_id
            AND cdr_call.provider_call_id = $4
            AND cdr_call.receipt_id = receipt.receipt_id
            AND cdr_call.state = 'committed'
           WHERE receipt.tenant_id = $2
             AND receipt.receipt_id = $16
             AND receipt.call_id = $17
             AND receipt.acknowledged_sequence = $10
             AND receipt.acknowledged_payload_hash = $13
             AND receipt.region_id = $18
             AND receipt.durability_contract_id = $19
             AND receipt.cell_id = $3
             AND receipt.owner_node_id = $5
             AND receipt.owner_epoch = $6
             AND receipt.availability_profile = 'VOICE-HA-T1'
         ),
         completed_repair AS (
           UPDATE ivekit_voice_dialog_terminal_repairs
           SET state = 'committed',
               completed_at = $12::timestamptz,
               terminal_pair_hash = $11,
               updated_at = $12::timestamptz
           WHERE id = $1
             AND tenant_id = $2
             AND cell_id = $3
             AND call_session_ref = $4
             AND source_owner_node_id = $5
             AND source_owner_fault_domain = $15
             AND source_owner_epoch = $6
             AND source_pair_hash = $7
             AND repair_owner_node_id = $8
             AND repair_owner_epoch = $9
             AND terminal_cdr_sequence = $10
             AND terminal_cdr_payload_hash = $13
             AND terminal_cdr_call_id = $17
             AND terminal_cdr_receipt_id = $16
             AND terminal_cdr_region_id = $18
             AND terminal_cdr_durability_contract_id = $19
             AND state = 'claimed'
             AND EXISTS (SELECT 1 FROM bound_receipt)
           RETURNING id
         ),
         completed_authority AS (
           UPDATE ivekit_voice_dialog_ownership
           SET owner_node_id = $8,
               owner_fault_domain = $14,
               owner_epoch = $9,
               shadow_pair_hash = $11,
               terminal_shadow_pending = FALSE,
               revision = revision + 1,
               updated_at = $12::timestamptz
           WHERE tenant_id = $2
             AND cell_id = $3
             AND call_session_ref = $4
             AND owner_node_id = $5
             AND owner_fault_domain = $15
             AND owner_epoch = $6
             AND owner_epoch_high_watermark >= $9
             AND shadow_pair_hash = $7
             AND terminal = TRUE
             AND terminal_shadow_pending = TRUE
             AND terminal_cdr_sequence = $10
             AND terminal_cdr_payload_hash = $13
             AND terminal_cdr_call_id = $17
             AND terminal_cdr_receipt_id = $16
             AND terminal_cdr_region_id = $18
             AND terminal_cdr_durability_contract_id = $19
             AND pending_takeover_id IS NULL
             AND EXISTS (SELECT 1 FROM completed_repair)
           RETURNING ${AUTHORITY_COLUMNS}
         )
         SELECT * FROM completed_authority`,
        [
          claim.repair_id,
          claim.tenant_id,
          claim.cell_id,
          claim.call_session_ref,
          claim.source_owner_node_id,
          claim.source_owner_epoch,
          claim.source_pair_hash,
          claim.repair_owner_node_id,
          claim.repair_owner_epoch,
          claim.terminal_cdr_sequence,
          pairHash,
          completedAt,
          claim.terminal_cdr_payload_hash,
          claim.repair_owner_fault_domain,
          claim.source_owner_fault_domain,
          claim.terminal_cdr_receipt_id,
          claim.terminal_cdr_call_id,
          claim.terminal_cdr_region_id,
          claim.terminal_cdr_durability_contract_id
        ]
      );
      if (!result.rows[0]) unavailable();
      const authority = decodeAuthority(result.rows[0]);
      if (!authority.terminal ||
          authority.terminal_shadow_pending ||
          authority.owner_node_id !== claim.repair_owner_node_id ||
          authority.owner_epoch !== claim.repair_owner_epoch ||
          authority.shadow_pair_hash !== pairHash) {
        unavailable();
      }
      return authority;
    });
  }

  getAuthority(input: {
    tenant_id: string;
    cell_id: string;
    call_session_ref: string;
  }): Promise<DialogOwnerAuthorityRecord | null> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `/* converact-dialog-owner-takeover:get */
         SELECT ${AUTHORITY_COLUMNS}
         FROM ivekit_voice_dialog_ownership
         WHERE tenant_id = $1
           AND cell_id = $2
           AND call_session_ref = $3`,
        [input.tenant_id, input.cell_id, input.call_session_ref]
      );
      return result.rows[0] ? decodeAuthority(result.rows[0]) : null;
    });
  }

  async #assertCandidateLease(
    pg: PgQueryable,
    input: DialogOwnerTakeoverClaimWrite
  ): Promise<void> {
    const result = await pg.query(
      `/* converact-dialog-owner-takeover:assert-candidate-lease */
       SELECT node_id
       FROM ivekit_voice_dialog_node_leases
       WHERE cell_id = $1
         AND node_id = $2
         AND fault_domain = $3
         AND spiffe_id = $4
         AND lease_expires_at > $5::timestamptz
       FOR UPDATE`,
      [
        input.cell_id,
        input.owner_node_id,
        input.owner_fault_domain,
        input.owner_spiffe_id,
        input.claimed_at.toISOString()
      ]
    );
    if (!result.rows[0]) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_takeover_candidate_inactive',
        503
      );
    }
  }

  async #assertPreviousOwnerOffline(
    pg: PgQueryable,
    input: DialogOwnerTakeoverClaimWrite
  ): Promise<void> {
    const result = await pg.query(
      `/* converact-dialog-owner-takeover:assert-previous-offline */
       SELECT node_id, fault_domain, lease_expires_at
       FROM ivekit_voice_dialog_node_leases
       WHERE cell_id = $1
         AND node_id = $2
       FOR UPDATE`,
      [input.cell_id, input.previous_owner_node_id]
    );
    const lease = result.rows[0] as Record<string, unknown> | undefined;
    if (!lease ||
        identifier(lease.node_id) !== input.previous_owner_node_id ||
        identifier(lease.fault_domain) !== input.previous_owner_fault_domain ||
        Date.parse(timestamp(lease.lease_expires_at)) > input.claimed_at.getTime()) {
      throw new DialogOwnerTakeoverError(
        'dialog_owner_takeover_previous_owner_active',
        409
      );
    }
  }

  async #lockAuthority(
    pg: PgQueryable,
    tenantId: string,
    cellId: string,
    callSessionRef: string
  ): Promise<DialogOwnerAuthorityRecord> {
    const result = await pg.query(
      `/* converact-dialog-owner-takeover:lock */
       SELECT ${AUTHORITY_COLUMNS}
       FROM ivekit_voice_dialog_ownership
       WHERE tenant_id = $1
         AND cell_id = $2
         AND call_session_ref = $3
       FOR UPDATE`,
      [tenantId, cellId, callSessionRef]
    );
    if (!result.rows[0]) unavailable();
    return decodeAuthority(result.rows[0]);
  }

  async #findReplay(
    pg: PgQueryable,
    input: DialogOwnerTakeoverClaimWrite
  ): Promise<TakeoverReplayRow | null> {
    const result = await pg.query(
      `/* converact-dialog-owner-takeover:replay */
       SELECT id, owner_epoch, expires_at, request_hash, token_key_id,
         prepared_pair_hash, state
       FROM ivekit_voice_dialog_takeovers
       WHERE tenant_id = $1
         AND cell_id = $2
         AND call_session_ref = $3
         AND idempotency_key = $4`,
      [
        input.tenant_id,
        input.cell_id,
        input.call_session_ref,
        input.idempotency_key
      ]
    );
    return result.rows[0] ? decodeReplay(result.rows[0]) : null;
  }

  async #findAttemptById(
    pg: PgQueryable,
    input: DialogOwnerTakeoverConsumeWrite
  ): Promise<TakeoverReplayRow | null> {
    const result = await pg.query(
      `/* converact-dialog-owner-takeover:attempt-by-id */
       SELECT id, owner_epoch, expires_at, request_hash, token_key_id,
         prepared_pair_hash, state
       FROM ivekit_voice_dialog_takeovers
       WHERE id = $1
         AND tenant_id = $2
         AND cell_id = $3
         AND call_session_ref = $4
         AND owner_node_id = $5
         AND token_sha256 = $6`,
      [
        input.takeover_id,
        input.tenant_id,
        input.cell_id,
        input.call_session_ref,
        input.owner_node_id,
        input.token_sha256
      ]
    );
    return result.rows[0] ? decodeReplay(result.rows[0]) : null;
  }

  async #expirePending(
    pg: PgQueryable,
    authority: DialogOwnerAuthorityRecord,
    now: Date
  ): Promise<DialogOwnerAuthorityRecord> {
    const expired = await pg.query(
      `/* converact-dialog-owner-takeover:expire-attempt */
       UPDATE ivekit_voice_dialog_takeovers
       SET state = 'expired',
           updated_at = $5::timestamptz
       WHERE id = $1
         AND tenant_id = $2
         AND cell_id = $3
         AND call_session_ref = $4
         AND state = 'prepared'
         AND expires_at <= $5::timestamptz
       RETURNING id`,
      [
        authority.pending_takeover_id,
        authority.tenant_id,
        authority.cell_id,
        authority.call_session_ref,
        now.toISOString()
      ]
    );
    if (!expired.rows[0]) return authority;
    const cleared = await pg.query(
      `/* converact-dialog-owner-takeover:clear-expired */
       UPDATE ivekit_voice_dialog_ownership
       SET pending_takeover_id = NULL,
           pending_owner_node_id = NULL,
           pending_owner_fault_domain = NULL,
           pending_owner_epoch = NULL,
           pending_token_sha256 = NULL,
           pending_expires_at = NULL,
           revision = revision + 1,
           updated_at = $5::timestamptz
       WHERE tenant_id = $1
         AND cell_id = $2
         AND call_session_ref = $3
         AND pending_takeover_id = $4
         AND pending_expires_at <= $5::timestamptz
       RETURNING ${AUTHORITY_COLUMNS}`,
      [
        authority.tenant_id,
        authority.cell_id,
        authority.call_session_ref,
        authority.pending_takeover_id,
        now.toISOString()
      ]
    );
    if (!cleared.rows[0]) unavailable();
    return decodeAuthority(cleared.rows[0]);
  }
}

const AUTHORITY_COLUMN_NAMES = [
  'tenant_id',
  'cell_id',
  'call_session_ref',
  'profile',
  'owner_node_id',
  'owner_fault_domain',
  'owner_epoch',
  'owner_epoch_high_watermark',
  'shadow_pair_hash',
  'terminal',
  'terminal_shadow_pending',
  'terminal_cdr_sequence',
  'terminal_cdr_payload_hash',
  'terminal_cdr_call_id',
  'terminal_cdr_receipt_id',
  'terminal_cdr_region_id',
  'terminal_cdr_durability_contract_id',
  'pending_takeover_id',
  'pending_owner_node_id',
  'pending_owner_fault_domain',
  'pending_owner_epoch',
  'pending_token_sha256',
  'pending_expires_at',
  'revision'
] as const;
const AUTHORITY_COLUMNS = AUTHORITY_COLUMN_NAMES.join(', ');
const AUTHORITY_COLUMNS_OWNERSHIP = AUTHORITY_COLUMN_NAMES
  .map((column) => `ownership.${column} AS ${column}`)
  .join(', ');

function decodeAuthority(row: Record<string, unknown>): DialogOwnerAuthorityRecord {
  const result: DialogOwnerAuthorityRecord = {
    tenant_id: identifier(row.tenant_id),
    cell_id: identifier(row.cell_id),
    call_session_ref: identifier(row.call_session_ref),
    profile: profile(row.profile),
    owner_node_id: identifier(row.owner_node_id),
    owner_fault_domain: identifier(row.owner_fault_domain),
    owner_epoch: integer(row.owner_epoch, 1, 0xffff_ffff),
    owner_epoch_high_watermark: integer(
      row.owner_epoch_high_watermark,
      1,
      0xffff_ffff
    ),
    shadow_pair_hash: hash(row.shadow_pair_hash),
    terminal: boolean(row.terminal),
    terminal_shadow_pending: boolean(row.terminal_shadow_pending),
    terminal_cdr_sequence: nullableSafeInteger(row.terminal_cdr_sequence),
    terminal_cdr_payload_hash: nullableHash(row.terminal_cdr_payload_hash),
    terminal_cdr_call_id: nullableIdentifier(row.terminal_cdr_call_id),
    terminal_cdr_receipt_id: nullableIdentifier(row.terminal_cdr_receipt_id),
    terminal_cdr_region_id: nullableIdentifier(row.terminal_cdr_region_id),
    terminal_cdr_durability_contract_id: nullableIdentifier(
      row.terminal_cdr_durability_contract_id
    ),
    pending_takeover_id: nullableIdentifier(row.pending_takeover_id),
    pending_owner_node_id: nullableIdentifier(row.pending_owner_node_id),
    pending_owner_fault_domain: nullableIdentifier(row.pending_owner_fault_domain),
    pending_owner_epoch: nullableInteger(row.pending_owner_epoch),
    pending_token_sha256: nullableHash(row.pending_token_sha256),
    pending_expires_at: nullableTimestamp(row.pending_expires_at),
    revision: integer(row.revision, 1, Number.MAX_SAFE_INTEGER)
  };
  const pending = [
    result.pending_takeover_id,
    result.pending_owner_node_id,
    result.pending_owner_fault_domain,
    result.pending_owner_epoch,
    result.pending_token_sha256,
    result.pending_expires_at
  ];
  const terminalCdrAuthority = [
    result.terminal_cdr_sequence,
    result.terminal_cdr_payload_hash,
    result.terminal_cdr_call_id,
    result.terminal_cdr_receipt_id,
    result.terminal_cdr_region_id,
    result.terminal_cdr_durability_contract_id
  ];
  if (result.owner_epoch_high_watermark < result.owner_epoch ||
      (terminalCdrAuthority.every((value) => value === null)
        ? false
        : terminalCdrAuthority.some((value) => value === null)) ||
      (result.terminal_shadow_pending &&
        (!result.terminal || result.terminal_cdr_sequence === null)) ||
      (pending.every((value) => value === null)
        ? false
        : pending.some((value) => value === null)) ||
      (result.pending_owner_epoch !== null &&
        (result.pending_owner_epoch <= result.owner_epoch ||
         result.pending_owner_epoch > result.owner_epoch_high_watermark))) {
    unavailable();
  }
  return result;
}

function decodeTerminalRepair(
  row: Record<string, unknown>
): DialogTerminalShadowRepairClaim {
  const result: DialogTerminalShadowRepairClaim = {
    repair_id: identifier(row.id),
    tenant_id: identifier(row.tenant_id),
    cell_id: identifier(row.cell_id),
    call_session_ref: identifier(row.call_session_ref),
    source_owner_node_id: identifier(row.source_owner_node_id),
    source_owner_fault_domain: identifier(row.source_owner_fault_domain),
    source_owner_epoch: integer(row.source_owner_epoch, 1, 0xffff_fffe),
    source_pair_hash: hash(row.source_pair_hash),
    repair_owner_node_id: identifier(row.repair_owner_node_id),
    repair_owner_fault_domain: identifier(row.repair_owner_fault_domain),
    repair_owner_epoch: integer(row.repair_owner_epoch, 2, 0xffff_ffff),
    terminal_cdr_sequence: integer(
      row.terminal_cdr_sequence,
      1,
      Number.MAX_SAFE_INTEGER
    ),
    terminal_cdr_payload_hash: hash(row.terminal_cdr_payload_hash),
    terminal_cdr_call_id: identifier(row.terminal_cdr_call_id),
    terminal_cdr_receipt_id: identifier(row.terminal_cdr_receipt_id),
    terminal_cdr_region_id: identifier(row.terminal_cdr_region_id),
    terminal_cdr_durability_contract_id: identifier(
      row.terminal_cdr_durability_contract_id
    ),
    claimed_at: timestamp(row.claimed_at),
    expires_at: timestamp(row.expires_at)
  };
  if (result.repair_owner_epoch <= result.source_owner_epoch ||
      Date.parse(result.expires_at) <= Date.parse(result.claimed_at)) {
    unavailable();
  }
  return result;
}

function repairRow(
  claim: DialogTerminalShadowRepairClaim
): Record<string, unknown> {
  return {
    id: claim.repair_id,
    tenant_id: claim.tenant_id,
    cell_id: claim.cell_id,
    call_session_ref: claim.call_session_ref,
    source_owner_node_id: claim.source_owner_node_id,
    source_owner_fault_domain: claim.source_owner_fault_domain,
    source_owner_epoch: claim.source_owner_epoch,
    source_pair_hash: claim.source_pair_hash,
    repair_owner_node_id: claim.repair_owner_node_id,
    repair_owner_fault_domain: claim.repair_owner_fault_domain,
    repair_owner_epoch: claim.repair_owner_epoch,
    terminal_cdr_sequence: claim.terminal_cdr_sequence,
    terminal_cdr_payload_hash: claim.terminal_cdr_payload_hash,
    terminal_cdr_call_id: claim.terminal_cdr_call_id,
    terminal_cdr_receipt_id: claim.terminal_cdr_receipt_id,
    terminal_cdr_region_id: claim.terminal_cdr_region_id,
    terminal_cdr_durability_contract_id:
      claim.terminal_cdr_durability_contract_id,
    claimed_at: claim.claimed_at,
    expires_at: claim.expires_at
  };
}

function matchesTerminalCdrAuthority(
  claim: DialogTerminalShadowRepairClaim,
  authority: DialogOwnerAuthorityRecord
): boolean {
  return claim.terminal_cdr_sequence === authority.terminal_cdr_sequence &&
    claim.terminal_cdr_payload_hash === authority.terminal_cdr_payload_hash &&
    claim.terminal_cdr_call_id === authority.terminal_cdr_call_id &&
    claim.terminal_cdr_receipt_id === authority.terminal_cdr_receipt_id &&
    claim.terminal_cdr_region_id === authority.terminal_cdr_region_id &&
    claim.terminal_cdr_durability_contract_id ===
      authority.terminal_cdr_durability_contract_id;
}

function decodeReplay(row: Record<string, unknown>): TakeoverReplayRow {
  const state = String(row.state || '');
  if (state !== 'prepared' && state !== 'shadow_prepared' &&
      state !== 'consumed' && state !== 'expired') {
    unavailable();
  }
  return {
    id: identifier(row.id),
    owner_epoch: integer(row.owner_epoch, 2, 0xffff_ffff),
    expires_at: timestamp(row.expires_at),
    request_hash: hash(row.request_hash),
    token_key_id: identifier(row.token_key_id),
    prepared_pair_hash: nullableHash(row.prepared_pair_hash),
    state
  };
}

function assertReplayAuthority(
  authority: DialogOwnerAuthorityRecord,
  replay: TakeoverReplayRow
): void {
  const pendingMatch = (
    replay.state === 'prepared' || replay.state === 'shadow_prepared'
  ) &&
    authority.pending_takeover_id === replay.id &&
    authority.pending_owner_epoch === replay.owner_epoch;
  const activeMatch = replay.state === 'consumed' &&
    authority.owner_epoch === replay.owner_epoch;
  if (!pendingMatch && !activeMatch) unavailable();
}

function decodeNodeLease(row: Record<string, unknown>): DialogNodeLeaseRecord {
  const result = {
    cell_id: identifier(row.cell_id),
    node_id: identifier(row.node_id),
    fault_domain: identifier(row.fault_domain),
    spiffe_id: spiffeId(row.spiffe_id),
    heartbeat_at: timestamp(row.heartbeat_at),
    lease_expires_at: timestamp(row.lease_expires_at),
    revision: integer(row.revision, 1, Number.MAX_SAFE_INTEGER)
  };
  if (Date.parse(result.lease_expires_at) <= Date.parse(result.heartbeat_at)) {
    unavailable();
  }
  return result;
}

function assertPendingAuthority(
  authority: DialogOwnerAuthorityRecord,
  input: DialogOwnerTakeoverClaimWrite,
  ownerEpoch: number
): void {
  if (authority.owner_node_id !== input.previous_owner_node_id ||
      authority.owner_epoch !== input.expected_owner_epoch ||
      authority.owner_epoch_high_watermark !== ownerEpoch ||
      authority.pending_takeover_id !== input.takeover_id ||
      authority.pending_owner_node_id !== input.owner_node_id ||
      authority.pending_owner_fault_domain !== input.owner_fault_domain ||
      authority.pending_owner_epoch !== ownerEpoch ||
      authority.pending_token_sha256 !== input.token_sha256 ||
      authority.pending_expires_at !== input.token_expires_at) {
    unavailable();
  }
}

function identifier(value: unknown): string {
  const result = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) unavailable();
  return result;
}

function spiffeId(value: unknown): string {
  const result = String(value || '');
  let uri: URL;
  try {
    uri = new URL(result);
  } catch {
    unavailable();
  }
  if (uri!.protocol !== 'spiffe:' || uri!.username || uri!.password ||
      uri!.search || uri!.hash || uri!.toString() !== result) {
    unavailable();
  }
  return result;
}

function profile(value: unknown): 'VOICE-HA-T1' {
  if (value !== 'VOICE-HA-T1') unavailable();
  return value;
}

function hash(value: unknown): string {
  const result = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(result)) unavailable();
  return result;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    unavailable();
  }
  return result;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') unavailable();
  return value;
}

function nullableIdentifier(value: unknown): string | null {
  return value === null || value === undefined ? null : identifier(value);
}

function nullableHash(value: unknown): string | null {
  return value === null || value === undefined ? null : hash(value);
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : integer(value, 2, 0xffff_ffff);
}

function nullableSafeInteger(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : integer(value, 1, Number.MAX_SAFE_INTEGER);
}

function timestamp(value: unknown): string {
  const result = value instanceof Date ? value.toISOString() : String(value || '');
  if (!Number.isFinite(Date.parse(result)) ||
      new Date(result).toISOString() !== result) {
    unavailable();
  }
  return result;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp(value);
}

function unavailable(): never {
  throw new DialogOwnerTakeoverError(
    'dialog_owner_takeover_store_unavailable',
    503
  );
}
