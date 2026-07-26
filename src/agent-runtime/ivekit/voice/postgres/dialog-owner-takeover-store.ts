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
import type { DialogShadowRecord } from '../dialog-shadow.js';

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
implements DialogOwnerTakeoverStore {
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
        `/* ivekit-dialog-owner-takeover:seed */
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
        `/* ivekit-dialog-owner-takeover:insert-attempt */
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
        `/* ivekit-dialog-owner-takeover:publish-pending */
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
        `/* ivekit-dialog-owner-takeover:consume-attempt */
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
        `/* ivekit-dialog-owner-takeover:activate-owner */
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
      `/* ivekit-dialog-owner-takeover:heartbeat-node */
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
      `/* ivekit-dialog-owner-takeover:assert-node-lease */
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
        `/* ivekit-dialog-owner-takeover:observe-seed */
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
          `/* ivekit-dialog-owner-takeover:observe-prepared-pair */
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
        `/* ivekit-dialog-owner-takeover:observe-active-pair */
         UPDATE ivekit_voice_dialog_ownership
         SET shadow_pair_hash = $4,
             terminal = $5,
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

  getAuthority(input: {
    tenant_id: string;
    cell_id: string;
    call_session_ref: string;
  }): Promise<DialogOwnerAuthorityRecord | null> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `/* ivekit-dialog-owner-takeover:get */
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
      `/* ivekit-dialog-owner-takeover:assert-candidate-lease */
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
      `/* ivekit-dialog-owner-takeover:assert-previous-offline */
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
      `/* ivekit-dialog-owner-takeover:lock */
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
      `/* ivekit-dialog-owner-takeover:replay */
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
      `/* ivekit-dialog-owner-takeover:attempt-by-id */
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
      `/* ivekit-dialog-owner-takeover:expire-attempt */
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
      `/* ivekit-dialog-owner-takeover:clear-expired */
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

const AUTHORITY_COLUMNS = [
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
  'pending_takeover_id',
  'pending_owner_node_id',
  'pending_owner_fault_domain',
  'pending_owner_epoch',
  'pending_token_sha256',
  'pending_expires_at',
  'revision'
].join(', ');

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
  if (result.owner_epoch_high_watermark < result.owner_epoch ||
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
