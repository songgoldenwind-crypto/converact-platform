import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import {
  mergeVoiceCdrProjection,
  parseVoiceDualLegCdr,
  type VoiceCdrCallSummary,
  type VoiceCdrDurabilityContract,
  type VoiceCdrDurableReceipt,
  type VoiceCdrLeg,
  type VoiceCdrProjection,
  type VoiceDualLegCdr,
  type VoiceAvailabilityProfile
} from '../cdr-convergence.js';
import { VoiceError } from '../errors.js';

const MAX_SAFE_DECIMAL = 9_007_199_254_740_991n;

interface VoiceCdrConvergenceStoreOptions {
  now?: () => Date;
  id?: () => string;
  event_retention_ms?: number;
  region_id?: string;
}

interface VoiceCdrRow extends Record<string, unknown> {
  tenant_id: unknown;
  call_id: unknown;
  provider_profile_id: unknown;
  provider_call_id: unknown;
  cell_id: unknown;
  owner_node_id: unknown;
  availability_profile: unknown;
  owner_epoch: unknown;
  highest_sequence: unknown;
  latest_payload_hash: unknown;
  state: unknown;
  call_summary: unknown;
  durability_contract_id: unknown;
  durability_region_id: unknown;
  receipt_id: unknown;
  billing_event_id: unknown;
  committed_at: unknown;
}

interface StoredVoiceCdrReceipt {
  receipt_id: string;
  committed_sequence: string;
  acknowledged_payload_hash: string;
  durability_contract_id: string;
  region_id: string;
  committed_at: string;
}

interface StoredVoiceCdrAcknowledgement {
  submission_payload_hash: string;
  receipt: StoredVoiceCdrReceipt | null;
}

export class PostgresVoiceCdrConvergenceStore {
  readonly #pg: PgQueryable;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #eventRetentionMs: number;
  readonly #regionId: string | null;

  constructor(pg: PgQueryable, options: VoiceCdrConvergenceStoreOptions = {}) {
    this.#pg = pg;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#eventRetentionMs = boundedRetention(options.event_retention_ms);
    this.#regionId = options.region_id?.trim()
      ? identifier(options.region_id.trim())
      : null;
  }

  async converge(input: {
    tenant_id: string;
    profile_id: string;
    authoritative_availability_profile: VoiceAvailabilityProfile;
    envelope: VoiceDualLegCdr;
  }): Promise<VoiceCdrDurableReceipt> {
    const tenantId = identifier(input.tenant_id);
    const profileId = identifier(input.profile_id);
    const envelope = parseVoiceDualLegCdr(stripPayloadHash(input.envelope));
    if (input.authoritative_availability_profile !== envelope.availability_profile) {
      throw sequenceConflict();
    }
    if ((this.#regionId && envelope.expected_region_id !== this.#regionId) ||
        (!this.#regionId && envelope.availability_profile === 'VOICE-HA-T1')) {
      throw sequenceConflict();
    }
    return withPgTenant(this.#pg, tenantId, async (pg) => {
      await pg.query(
        `/* ivekit-voice-cdr:lock-key */
         SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`${tenantId}:${envelope.interaction_id}`]
      );
      await this.#assertCallIdentity(pg, tenantId, profileId, envelope);
      const existingResult = await pg.query<VoiceCdrRow>(
        `/* ivekit-voice-cdr:lock-cdr */
         SELECT *
         FROM ivekit_voice_cdr_calls
         WHERE tenant_id = $1 AND call_id = $2
         FOR UPDATE`,
        [tenantId, envelope.interaction_id]
      );
      const legResult = await pg.query<Record<string, unknown>>(
        `/* ivekit-voice-cdr:load-legs */
         SELECT *
         FROM ivekit_voice_cdr_legs
         WHERE tenant_id = $1 AND call_id = $2
         ORDER BY role`,
        [tenantId, envelope.interaction_id]
      );
      const previous = existingResult.rows[0]
        ? decodeProjection(
          existingResult.rows[0],
          legResult.rows,
          envelope.expected_region_id
        )
        : null;
      const acknowledgement = await this.#loadAcknowledgement(
        pg,
        tenantId,
        envelope.interaction_id,
        envelope.sequence
      );
      if (acknowledgement &&
          acknowledgement.submission_payload_hash !== envelope.payload_hash) {
        throw sequenceConflict();
      }
      if (!acknowledgement) {
        await this.#assertCurrentDialogOwner(pg, tenantId, envelope);
      }
      if (acknowledgement?.receipt) {
        return storedReceiptFor(envelope, acknowledgement.receipt);
      }
      const existingContractId = previous?.durability_contract_id &&
        BigInt(envelope.sequence) <= BigInt(previous.highest_sequence)
        ? previous.durability_contract_id
        : null;
      const durability = await this.#loadDurability(
        pg,
        existingContractId
      );
      const merged = mergeVoiceCdrProjection(previous, envelope, durability, {
        journaled_replay: acknowledgement != null
      });

      if (merged.outcome === 'replayed' || merged.outcome === 'stale') {
        if (!acknowledgement) throw sequenceConflict();
        if (merged.projection.state === 'committed') {
          const now = checkedDate(this.#now());
          const receiptId = identifier(this.#id());
          const committedAt = now.toISOString();
          const billingEventId = merged.projection.billing_event_id;
          if (!durability || !billingEventId) {
            throw new Error('committed CDR receipt metadata is incomplete');
          }
          await this.#insertReceipt(
            pg,
            tenantId,
            envelope,
            merged.projection,
            receiptId,
            durability,
            billingEventId,
            committedAt
          );
          return receiptFor({
            projection: merged.projection,
            envelope,
            durability,
            receipt_id: receiptId,
            committed_at: committedAt,
            replayed: true
          });
        }
        return receiptFor({
          projection: merged.projection,
          envelope,
          durability,
          receipt_id: null,
          committed_at: null,
          replayed: true
        });
      }

      const now = checkedDate(this.#now());
      let billingEventId = merged.projection.billing_event_id;
      if (merged.emit_billing_event) {
        billingEventId = await this.#insertBillingEvent(
          pg,
          tenantId,
          merged.projection,
          now
        );
      }
      const needsReceipt = merged.projection.state === 'committed' &&
        (previous?.state !== 'committed' ||
          previous.highest_sequence !== merged.projection.highest_sequence);
      const receiptId = merged.projection.state === 'committed'
        ? needsReceipt ? identifier(this.#id()) : previous?.durability_contract_id
          ? existingString(existingResult.rows[0]?.receipt_id)
          : identifier(this.#id())
        : null;
      const committedAt = merged.projection.state === 'committed'
        ? needsReceipt ? now.toISOString() : existingTimestamp(existingResult.rows[0]?.committed_at)
        : null;
      const persisted: VoiceCdrProjection = {
        ...merged.projection,
        billing_event_id: billingEventId
      };
      await this.#upsertProjection(
        pg,
        tenantId,
        profileId,
        persisted,
        receiptId,
        committedAt,
        now
      );
      for (const leg of envelope.legs) {
        await this.#upsertLeg(pg, tenantId, envelope.interaction_id, envelope.sequence, leg);
      }
      await this.#insertSubmission(pg, tenantId, envelope);
      if (needsReceipt) {
        if (!receiptId || !committedAt || !durability || !billingEventId) {
          throw new Error('committed CDR receipt metadata is incomplete');
        }
        await this.#insertReceipt(
          pg,
          tenantId,
          envelope,
          persisted,
          receiptId,
          durability,
          billingEventId,
          committedAt
        );
        if (envelope.availability_profile === 'VOICE-HA-T1') {
          await this.#markDialogTerminalPendingShadow(
            pg,
            tenantId,
            envelope,
            receiptId,
            durability
          );
        }
      }
      return receiptFor({
        projection: persisted,
        envelope,
        durability,
        receipt_id: receiptId,
        committed_at: committedAt,
        replayed: false
      });
    });
  }

  async #assertCallIdentity(
    pg: PgQueryable,
    tenantId: string,
    profileId: string,
    envelope: VoiceDualLegCdr
  ): Promise<void> {
    const result = await pg.query<Record<string, unknown>>(
      `/* ivekit-voice-cdr:lock-authoritative-call */
       SELECT id, provider_profile_id, provider_call_id
       FROM ivekit_voice_calls
       WHERE tenant_id = $1 AND id = $2
       FOR SHARE`,
      [tenantId, envelope.interaction_id]
    );
    const row = result.rows[0];
    if (!row) throw new VoiceError({ code: 'not_found', status: 404 });
    if (String(row.provider_profile_id) !== profileId ||
        String(row.provider_call_id) !== envelope.provider_call_id) {
      throw new VoiceError({
        code: 'event_sequence_conflict',
        status: 409,
        retryable: false
      });
    }
  }

  async #assertCurrentDialogOwner(
    pg: PgQueryable,
    tenantId: string,
    envelope: VoiceDualLegCdr
  ): Promise<void> {
    if (envelope.availability_profile !== 'VOICE-HA-T1') return;
    const authority = await pg.query<Record<string, unknown>>(
      `/* ivekit-voice-cdr:lock-dialog-authority */
       SELECT owner_node_id, owner_epoch, pending_takeover_id, terminal
       FROM ivekit_voice_dialog_ownership
       WHERE tenant_id = $1
         AND cell_id = $2
         AND call_session_ref = $3
       FOR SHARE`,
      [tenantId, envelope.cell_id, envelope.provider_call_id]
    );
    const owner = authority.rows[0];
    if (!owner ||
        String(owner.owner_node_id) !== envelope.owner_node_id ||
        String(owner.owner_epoch) !== envelope.owner_epoch ||
        owner.pending_takeover_id != null ||
        owner.terminal === true) {
      throw sequenceConflict();
    }
  }

  async #loadDurability(
    pg: PgQueryable,
    committedContractId: string | null
  ): Promise<VoiceCdrDurabilityContract | null> {
    if (!committedContractId && !this.#regionId) return null;
    const result = committedContractId
      ? await pg.query<Record<string, unknown>>(
        `/* ivekit-voice-cdr:load-durability */
         SELECT id, region_id, fault_domains, quorum_size, status
         FROM ivekit_voice_cdr_durability_contracts
         WHERE id = $1
         LIMIT 1
         FOR SHARE`,
        [committedContractId]
      )
      : await pg.query<Record<string, unknown>>(
        `/* ivekit-voice-cdr:load-durability */
         SELECT id, region_id, fault_domains, quorum_size, status
         FROM ivekit_voice_cdr_durability_contracts
         WHERE status = 'active'
           AND region_id = $1
         ORDER BY verified_at DESC, id
         LIMIT 1
         FOR SHARE`,
        [this.#regionId]
      );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      region_id: String(row.region_id),
      fault_domains: Array.isArray(row.fault_domains)
        ? row.fault_domains.map(String)
        : [],
      quorum_size: Number(row.quorum_size),
      status: row.status === 'active' ? 'active' : 'unavailable'
    };
  }

  async #loadAcknowledgement(
    pg: PgQueryable,
    tenantId: string,
    callId: string,
    sequence: string
  ): Promise<StoredVoiceCdrAcknowledgement | null> {
    const result = await pg.query<Record<string, unknown>>(
      `/* ivekit-voice-cdr:load-acknowledgement */
       SELECT s.payload_hash AS submission_payload_hash,
              r.receipt_id,
              r.committed_sequence,
              r.acknowledged_payload_hash,
              r.durability_contract_id,
              r.region_id,
              r.committed_at
       FROM ivekit_voice_cdr_submissions s
       LEFT JOIN ivekit_voice_cdr_receipts r
         ON r.tenant_id = s.tenant_id
        AND r.call_id = s.call_id
        AND r.acknowledged_sequence = s.sequence
       WHERE s.tenant_id = $1
         AND s.call_id = $2
         AND s.sequence = $3::bigint
       LIMIT 1`,
      [tenantId, callId, sequence]
    );
    const row = result.rows[0];
    if (!row) return null;
    const submissionPayloadHash = hash(row.submission_payload_hash);
    if (row.receipt_id == null) {
      return {
        submission_payload_hash: submissionPayloadHash,
        receipt: null
      };
    }
    return {
      submission_payload_hash: submissionPayloadHash,
      receipt: {
        receipt_id: existingString(row.receipt_id),
        committed_sequence: positiveDecimal(row.committed_sequence),
        acknowledged_payload_hash: hash(row.acknowledged_payload_hash),
        durability_contract_id: existingString(row.durability_contract_id),
        region_id: identifier(row.region_id),
        committed_at: existingTimestamp(row.committed_at)
      }
    };
  }

  async #insertBillingEvent(
    pg: PgQueryable,
    tenantId: string,
    projection: VoiceCdrProjection,
    now: Date
  ): Promise<string> {
    const expiresAt = new Date(now.getTime() + this.#eventRetentionMs);
    const result = await pg.query<{ id: unknown }>(
      `/* ivekit-voice-cdr:insert-billing-event */
       INSERT INTO ivekit_tenant_events
         (tenant_id, event_type, visibility_scope, visibility_ref_id,
          audience_user_ids, payload, occurred_at, expires_at)
       VALUES ($1, 'ivekit.voice.cdr.committed', 'tenant', '',
               ARRAY[]::TEXT[], $2::jsonb, $3, $4)
       RETURNING id`,
      [
        tenantId,
        JSON.stringify({
          schema_version: '1.0.0',
          call_id: projection.interaction_id,
          provider_call_id: projection.provider_call_id,
          cdr_sequence: projection.highest_sequence,
          billing_key: billingKey(projection.interaction_id)
        }),
        now.toISOString(),
        expiresAt.toISOString()
      ]
    );
    const id = result.rows[0]?.id;
    if (id == null || !/^[1-9][0-9]*$/.test(String(id))) {
      throw new Error('CDR billing event was not persisted');
    }
    return String(id);
  }

  async #upsertProjection(
    pg: PgQueryable,
    tenantId: string,
    profileId: string,
    projection: VoiceCdrProjection,
    receiptId: string | null,
    committedAt: string | null,
    now: Date
  ): Promise<void> {
    await pg.query(
      `/* ivekit-voice-cdr:upsert-cdr */
       INSERT INTO ivekit_voice_cdr_calls
         (tenant_id, call_id, provider_profile_id, provider_call_id, cell_id,
          owner_node_id, availability_profile, owner_epoch, highest_sequence,
          latest_payload_hash, state, call_summary, durability_contract_id,
          durability_region_id, receipt_id, billing_key, billing_event_id,
          committed_at, revision, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::bigint, $10,
               $11, $12::jsonb, $13, $14, $15, $16, $17::bigint, $18,
               1, $19, $19)
       ON CONFLICT (tenant_id, call_id) DO UPDATE
       SET provider_profile_id = EXCLUDED.provider_profile_id,
           provider_call_id = EXCLUDED.provider_call_id,
           cell_id = EXCLUDED.cell_id,
           owner_node_id = EXCLUDED.owner_node_id,
           availability_profile = EXCLUDED.availability_profile,
           owner_epoch = EXCLUDED.owner_epoch,
           highest_sequence = EXCLUDED.highest_sequence,
           latest_payload_hash = EXCLUDED.latest_payload_hash,
           state = EXCLUDED.state,
           call_summary = EXCLUDED.call_summary,
           durability_contract_id = EXCLUDED.durability_contract_id,
           durability_region_id = EXCLUDED.durability_region_id,
           receipt_id = EXCLUDED.receipt_id,
           billing_event_id = COALESCE(
             ivekit_voice_cdr_calls.billing_event_id,
             EXCLUDED.billing_event_id
           ),
           committed_at = EXCLUDED.committed_at,
           revision = ivekit_voice_cdr_calls.revision + 1,
           updated_at = EXCLUDED.updated_at`,
      [
        tenantId,
        projection.interaction_id,
        profileId,
        projection.provider_call_id,
        projection.cell_id,
        projection.owner_node_id,
        projection.availability_profile,
        projection.owner_epoch,
        projection.highest_sequence,
        projection.latest_payload_hash,
        projection.state,
        JSON.stringify(projection.call),
        projection.durability_contract_id,
        projection.durability_region_id,
        receiptId,
        billingKey(projection.interaction_id),
        projection.billing_event_id,
        committedAt,
        now.toISOString()
      ]
    );
  }

  async #upsertLeg(
    pg: PgQueryable,
    tenantId: string,
    callId: string,
    sequence: string,
    leg: VoiceCdrLeg
  ): Promise<void> {
    await pg.query(
      `/* ivekit-voice-cdr:upsert-leg */
       INSERT INTO ivekit_voice_cdr_legs
         (tenant_id, call_id, role, sequence, dialog_id_hash, direction,
          sip_final_code, hangup_cause, answered_at, ended_at, media_result,
          reservation_ref, owner_epoch, route_snapshot_revision)
       VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9, $10, $11,
               $12, $13::bigint, $14::bigint)
       ON CONFLICT (tenant_id, call_id, role) DO UPDATE
       SET sequence = EXCLUDED.sequence,
           dialog_id_hash = EXCLUDED.dialog_id_hash,
           direction = EXCLUDED.direction,
           sip_final_code = EXCLUDED.sip_final_code,
           hangup_cause = EXCLUDED.hangup_cause,
           answered_at = EXCLUDED.answered_at,
           ended_at = EXCLUDED.ended_at,
           media_result = EXCLUDED.media_result,
           reservation_ref = EXCLUDED.reservation_ref,
           owner_epoch = EXCLUDED.owner_epoch,
           route_snapshot_revision = EXCLUDED.route_snapshot_revision,
           updated_at = CURRENT_TIMESTAMP
       WHERE EXCLUDED.sequence > ivekit_voice_cdr_legs.sequence`,
      [
        tenantId,
        callId,
        leg.role,
        sequence,
        leg.dialog_id_hash,
        leg.direction,
        leg.sip_final_code,
        leg.hangup_cause,
        leg.answered_at,
        leg.ended_at,
        leg.media_result,
        leg.reservation_ref,
        leg.owner_epoch,
        leg.route_snapshot_revision
      ]
    );
  }

  async #insertReceipt(
    pg: PgQueryable,
    tenantId: string,
    envelope: VoiceDualLegCdr,
    projection: VoiceCdrProjection,
    receiptId: string,
    durability: VoiceCdrDurabilityContract,
    billingEventId: string,
    committedAt: string
  ): Promise<void> {
    await pg.query(
      `/* ivekit-voice-cdr:insert-receipt */
       INSERT INTO ivekit_voice_cdr_receipts
         (tenant_id, call_id, acknowledged_sequence, committed_sequence,
          acknowledged_payload_hash, receipt_id, durability_contract_id,
          region_id, billing_event_id, cell_id, owner_node_id,
          availability_profile, owner_epoch, committed_at)
       VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7, $8,
               $9::bigint, $10, $11, $12, $13::bigint, $14)`,
      [
        tenantId,
        projection.interaction_id,
        envelope.sequence,
        projection.highest_sequence,
        envelope.payload_hash,
        receiptId,
        durability.id,
        durability.region_id,
        billingEventId,
        envelope.cell_id,
        envelope.owner_node_id,
        envelope.availability_profile,
        envelope.owner_epoch,
        committedAt
      ]
    );
  }

  async #insertSubmission(
    pg: PgQueryable,
    tenantId: string,
    envelope: VoiceDualLegCdr
  ): Promise<void> {
    await pg.query(
      `/* ivekit-voice-cdr:insert-submission */
       INSERT INTO ivekit_voice_cdr_submissions
         (tenant_id, call_id, sequence, payload_hash, cell_id, owner_node_id,
          availability_profile, owner_epoch)
       VALUES ($1, $2, $3::bigint, $4, $5, $6, $7, $8::bigint)
       ON CONFLICT (tenant_id, call_id, sequence) DO NOTHING`,
      [
        tenantId,
        envelope.interaction_id,
        envelope.sequence,
        envelope.payload_hash,
        envelope.cell_id,
        envelope.owner_node_id,
        envelope.availability_profile,
        envelope.owner_epoch
      ]
    );
  }

  async #markDialogTerminalPendingShadow(
    pg: PgQueryable,
    tenantId: string,
    envelope: VoiceDualLegCdr,
    receiptId: string,
    durability: VoiceCdrDurabilityContract
  ): Promise<void> {
    const result = await pg.query(
      `/* ivekit-voice-cdr:mark-dialog-terminal-pending-shadow */
       UPDATE ivekit_voice_dialog_ownership
       SET terminal = TRUE,
           terminal_shadow_pending = TRUE,
           terminal_cdr_sequence = $6,
           terminal_cdr_payload_hash = $7,
           terminal_cdr_call_id = $8,
           terminal_cdr_receipt_id = $9,
           terminal_cdr_region_id = $10,
           terminal_cdr_durability_contract_id = $11,
           revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1
         AND cell_id = $2
         AND call_session_ref = $3
         AND owner_node_id = $4
         AND owner_epoch = $5
         AND pending_takeover_id IS NULL
         AND terminal = FALSE
       RETURNING call_session_ref`,
      [
        tenantId,
        envelope.cell_id,
        envelope.provider_call_id,
        envelope.owner_node_id,
        envelope.owner_epoch,
        envelope.sequence,
        envelope.payload_hash,
        envelope.interaction_id,
        receiptId,
        durability.region_id,
        durability.id
      ]
    );
    if (!result.rows[0]) throw sequenceConflict();
  }
}

function decodeProjection(
  row: VoiceCdrRow,
  legRows: Record<string, unknown>[],
  expectedRegionId: string
): VoiceCdrProjection {
  const call = record(row.call_summary) as unknown as VoiceCdrCallSummary;
  const state = row.state;
  if (state !== 'pending_unacknowledged' && state !== 'committed') {
    throw new Error('stored CDR state is invalid');
  }
  const interactionId = identifier(row.call_id);
  const providerCallId = storedProviderCallId(row.provider_call_id);
  const cellId = identifier(row.cell_id);
  const ownerNodeId = identifier(row.owner_node_id);
  const availabilityProfile = storedAvailabilityProfile(row.availability_profile);
  const ownerEpoch = positiveDecimal(row.owner_epoch);
  const legs: VoiceCdrProjection['legs'] = {};
  for (const legRow of legRows) {
    const sequence = positiveDecimal(legRow.sequence);
    const legOwnerEpoch = positiveDecimal(legRow.owner_epoch);
    const envelope = parseVoiceDualLegCdr({
      schema_version: '1.0.0',
      state: 'pending_unacknowledged',
      interaction_id: interactionId,
      provider_call_id: providerCallId,
      cell_id: cellId,
      owner_node_id: ownerNodeId,
      expected_region_id: expectedRegionId,
      availability_profile: availabilityProfile,
      owner_epoch: legOwnerEpoch,
      sequence,
      call,
      legs: [{
        role: legRow.role,
        dialog_id_hash: legRow.dialog_id_hash,
        direction: legRow.direction,
        sip_final_code: Number(legRow.sip_final_code),
        hangup_cause: legRow.hangup_cause,
        answered_at: nullableIso(legRow.answered_at),
        ended_at: iso(legRow.ended_at),
        media_result: legRow.media_result,
        reservation_ref: legRow.reservation_ref,
        owner_epoch: legOwnerEpoch,
        route_snapshot_revision: String(legRow.route_snapshot_revision)
      }]
    });
    const leg = envelope.legs[0];
    if (leg) legs[leg.role] = { ...leg, sequence };
  }
  return {
    interaction_id: interactionId,
    provider_call_id: providerCallId,
    cell_id: cellId,
    owner_node_id: ownerNodeId,
    availability_profile: availabilityProfile,
    owner_epoch: ownerEpoch,
    highest_sequence: positiveDecimal(row.highest_sequence),
    latest_payload_hash: hash(row.latest_payload_hash),
    state,
    call: structuredClone(call),
    legs,
    durability_contract_id: nullableString(row.durability_contract_id),
    durability_region_id: nullableString(row.durability_region_id),
    billing_event_id: nullableString(row.billing_event_id)
  };
}

function receiptFor(input: {
  projection: VoiceCdrProjection;
  envelope: VoiceDualLegCdr;
  durability: VoiceCdrDurabilityContract | null;
  receipt_id?: string | null;
  committed_at?: string | null;
  replayed: boolean;
}): VoiceCdrDurableReceipt {
  const committed = input.projection.state === 'committed';
  return {
    schema_version: '1.0.0',
    state: input.projection.state,
    receipt_id: committed
      ? input.receipt_id ?? null
      : null,
    interaction_id: input.envelope.interaction_id,
    provider_call_id: input.envelope.provider_call_id,
    acknowledged_sequence: input.envelope.sequence,
    committed_sequence: committed ? input.projection.highest_sequence : null,
    acknowledged_payload_hash: input.envelope.payload_hash,
    region_id: committed ? input.durability?.region_id ?? null : null,
    durability_contract_id: committed
      ? input.projection.durability_contract_id
      : null,
    committed_at: committed ? input.committed_at ?? null : null,
    replayed: input.replayed
  };
}

function storedReceiptFor(
  envelope: VoiceDualLegCdr,
  receipt: StoredVoiceCdrReceipt
): VoiceCdrDurableReceipt {
  if (receipt.acknowledged_payload_hash !== envelope.payload_hash) {
    throw sequenceConflict();
  }
  return {
    schema_version: '1.0.0',
    state: 'committed',
    receipt_id: receipt.receipt_id,
    interaction_id: envelope.interaction_id,
    provider_call_id: envelope.provider_call_id,
    acknowledged_sequence: envelope.sequence,
    committed_sequence: receipt.committed_sequence,
    acknowledged_payload_hash: receipt.acknowledged_payload_hash,
    region_id: receipt.region_id,
    durability_contract_id: receipt.durability_contract_id,
    committed_at: receipt.committed_at,
    replayed: true
  };
}

function stripPayloadHash(envelope: VoiceDualLegCdr): Omit<VoiceDualLegCdr, 'payload_hash'> {
  const { payload_hash: _payloadHash, ...payload } = envelope;
  return payload;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stored CDR JSON is invalid');
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(text)) {
    throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
  }
  return text;
}

function storedProviderCallId(value: unknown): string {
  const text = String(value ?? '');
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength < 1 || byteLength > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error('stored CDR provider Call-ID is invalid');
  }
  return text;
}

function positiveDecimal(value: unknown): string {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]{0,19}$/.test(text) ||
      BigInt(text) > MAX_SAFE_DECIMAL) {
    throw new Error('stored CDR sequence is invalid');
  }
  return text;
}

function storedAvailabilityProfile(value: unknown): VoiceAvailabilityProfile {
  if (value !== 'VOICE-ORDINARY' && value !== 'VOICE-HA-T1') {
    throw new Error('stored CDR availability profile is invalid');
  }
  return value;
}

function hash(value: unknown): string {
  const text = String(value ?? '');
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('stored CDR hash is invalid');
  return text;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function existingString(value: unknown): string {
  const result = nullableString(value);
  if (!result) throw new Error('committed CDR receipt is missing');
  return result;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('stored CDR timestamp is invalid');
  return date.toISOString();
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function existingTimestamp(value: unknown): string {
  if (value == null) throw new Error('committed CDR timestamp is missing');
  return iso(value);
}

function checkedDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('CDR clock returned an invalid date');
  }
  return value;
}

function boundedRetention(value: number | undefined): number {
  const candidate = value ?? 30 * 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(candidate) ||
      candidate < 60_000 ||
      candidate > 3650 * 24 * 60 * 60 * 1_000) {
    throw new Error('CDR event retention is invalid');
  }
  return candidate;
}

function billingKey(callId: string): string {
  return `voice-cdr:${callId}`;
}

function sequenceConflict(): VoiceError {
  return new VoiceError({
    code: 'event_sequence_conflict',
    status: 409,
    retryable: false
  });
}
