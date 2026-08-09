import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import type { QueryResult, QueryResultRow } from 'pg';
import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import {
  SIP_EFFECT_SCHEMA_HASH,
  SIP_EFFECT_SCHEMA_ID,
  SIP_EFFECT_SCHEMA_VERSION,
  SIP_EFFECT_SCHEMA_V1_VERSION,
  SipEffectError,
  assertSameProtocolEffectIdentity,
  canonicalSipEffectHash,
  cloneProtocolEffect,
  isSupportedSipEffectSchema,
  protocolEffectIdentityHash,
  uint64Decimal,
  validateAtomicBoundaryMetadata,
  validateEffectRepairClaim,
  validateEffectRepairCompactRequest,
  validateEffectRepairReleaseRequest,
  validateEffectRetentionRequest,
  validateProtocolEffectIdentity,
  type AtomicBoundaryMetadata,
  type EffectRepairBatch,
  type EffectRepairClaim,
  type EffectRepairCompactRequest,
  type EffectRepairReleaseRequest,
  type EffectRetentionRequest,
  type EffectTransition,
  type ProtocolEffectIdentity,
  type ProtocolEffectRecord,
  type ProtocolEffectState,
  type ProtocolEffectStore,
  type SipEffectMetricBook,
  type StoreFailureCode
} from './effect-oracle.js';
import {
  validateBackendRuntimeIdentity
} from './capabilities.js';
import {
  bindSipRoute,
  sipRouteBindingSha256,
  sipWireAttemptFactsSha256,
  sipWireFreezeSha256,
  validateBoundSipWireAttemptFacts
} from './route-binding.js';
import type {
  BackendRuntimeIdentity,
  BoundSipRouteBinding,
  BoundSipWireAttemptFacts
} from './types.js';
import {
  snapshotClosedArray,
  snapshotClosedBytes,
  snapshotClosedRecord,
  snapshotClosedShape,
} from './closed-schema.js';

type EffectRow = Record<string, unknown>;

export interface PostgresEffectStoreOptions {
  writer_identity?: string;
  max_in_flight?: number;
  max_queue_depth?: number;
  pool_wait_timeout_ms?: number;
  metrics?: SipEffectMetricBook;
}

export interface PostgresStoreFailureEvidence {
  failure_code: StoreFailureCode;
  retry_after_facts: Readonly<{
    pool_wait_ms: number;
    queue_depth: number;
    retry_attempt: number;
  }> | null;
}

const STORE_FAILURE_EVIDENCE =
  new WeakMap<SipEffectError, PostgresStoreFailureEvidence>();

export function readPostgresStoreFailureEvidence(
  error: unknown
): PostgresStoreFailureEvidence | null {
  return error instanceof SipEffectError
    ? STORE_FAILURE_EVIDENCE.get(error) ?? null
    : null;
}

const EFFECT_COLUMNS = effectColumns('');
const EFFECT_COLUMNS_QUALIFIED = effectColumns('effect.');
const REPAIR_BATCH_CEILING = 100;
const REPAIR_ATTEMPT_CEILING = 8;
const MAX_IN_FLIGHT_CEILING = 256;
const MAX_QUEUE_DEPTH = 1_024;
const MAX_POOL_WAIT_MS = 250;
const MAX_REPAIR_DELAY_MS = 86_400_000;
const DEFAULT_WRITER_IDENTITY = 'unified-rustpbx.sip-foundation';
const EFFECT_EXECUTOR_ROLE = 'opc_sip_effect_executor';
const EFFECT_ROW_KEYS = [
  'protocol_effect_id',
  'tenant_id',
  'protocol_session_id',
  'protocol_session_generation',
  'decision_id',
  'idempotency_key',
  'request_hash',
  'command_id',
  'adapter_identity',
  'adapter_identity_hash',
  'wire_bytes_hash',
  'wire_length_bytes',
  'canonical_wire_bytes',
  'route_binding',
  'route_binding_hash',
  'wire_attempt_facts',
  'wire_attempt_facts_hash',
  'wire_freeze_sha256',
  'effect_identity_hash',
  'owner_epoch',
  'command_sequence',
  'schema_id',
  'schema_version',
  'schema_hash',
  'writer_identity',
  'state',
  'revision',
  'unknown_count',
  'last_receipt_id',
  'last_receipt_hash',
  'last_receipt_repair_delay_ms',
  'failure_code',
  'repair_due_at',
  'repair_owner_id',
  'repair_owner_epoch',
  'repair_epoch_high_watermark',
  'repair_claim_token',
  'repair_claim_revision',
  'repair_lease_until',
  'repair_attempts',
  'repair_exhausted_at',
  'repair_exhaustion_receipt_hash',
  'operator_attention_required',
  'repair_compacted_at',
  'retention_reference_count',
  'rollback_reference_count',
  'audit_until',
  'payload_retained',
  'terminal_tombstone_id',
  'terminal_tombstone_hash',
  'terminal_at',
  'prepared_at',
  'updated_at'
] as const;
const RECEIPT_REPLAY_ROW_KEYS = [
  'protocol_effect_id',
  'effect_identity_hash',
  'receipt_hash',
  'level',
  'schema_id',
  'schema_version',
  'schema_hash',
  'writer_identity'
] as const;

export class PostgresEffectStore implements ProtocolEffectStore {
  readonly #writerIdentity: string;
  readonly #admission: StoreAdmissionGate;

  constructor(
    private readonly pg: PgQueryable,
    options: PostgresEffectStoreOptions = {}
  ) {
    const checkedOptions = checkedStoreOptions(options);
    this.#writerIdentity = checkedIdentifier(
      checkedOptions.writer_identity ?? DEFAULT_WRITER_IDENTITY,
      'writer_identity'
    );
    this.#admission = new StoreAdmissionGate({
      max_in_flight: checkedBoundedInteger(
        checkedOptions.max_in_flight ?? MAX_IN_FLIGHT_CEILING,
        1,
        MAX_IN_FLIGHT_CEILING,
        'max_in_flight'
      ),
      max_queue_depth: checkedBoundedInteger(
        checkedOptions.max_queue_depth ?? MAX_QUEUE_DEPTH,
        1,
        MAX_QUEUE_DEPTH,
        'max_queue_depth'
      ),
      wait_timeout_ms: checkedBoundedInteger(
        checkedOptions.pool_wait_timeout_ms ?? MAX_POOL_WAIT_MS,
        1,
        MAX_POOL_WAIT_MS,
        'pool_wait_timeout_ms'
      ),
      metrics: checkedOptions.metrics
    });
  }

  prepare(effect: ProtocolEffectRecord): Promise<{
    effect: ProtocolEffectRecord;
    replayed: boolean;
  }> {
    const checkedEffect = validatePreparedRecord(effect);
    return this.#tenant(checkedEffect.tenant_id, async (pg) => {
      const inserted = await pg.query<EffectRow>(
        `/* converact-sip-effect-oracle:prepare-insert */
         INSERT INTO ivekit_sip_protocol_effects
          (protocol_effect_id, tenant_id, protocol_session_id,
           protocol_session_generation, decision_id, idempotency_key,
           request_hash, command_id, adapter_identity, adapter_identity_hash,
           wire_bytes_hash, wire_length_bytes, canonical_wire_bytes,
           route_binding, route_binding_hash, wire_attempt_facts,
           wire_attempt_facts_hash, wire_freeze_sha256, effect_identity_hash,
           owner_epoch, command_sequence,
           schema_id, schema_version, schema_hash, writer_identity,
           state, revision, unknown_count, last_receipt_id, last_receipt_hash,
           last_receipt_repair_delay_ms, failure_code, repair_due_at,
           repair_owner_id, repair_owner_epoch, repair_epoch_high_watermark,
           repair_claim_token,
           repair_claim_revision, repair_lease_until, repair_attempts,
           repair_exhausted_at, repair_exhaustion_receipt_hash,
           operator_attention_required, repair_compacted_at,
           retention_reference_count, rollback_reference_count,
           audit_until, payload_retained, terminal_tombstone_id,
           terminal_tombstone_hash, terminal_at, prepared_at, updated_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
           $13, $14::jsonb, $15, $16::jsonb, $17, $18, $19, $20::numeric,
           $21::numeric, $22, $23, $24, $25, 'prepared', 1, 0, NULL, NULL,
           NULL, '', NULL, NULL, NULL, 0, NULL, NULL, NULL, 0, NULL, NULL,
           FALSE, NULL, 0, 0, $26::timestamptz, TRUE, NULL, NULL, NULL,
           $27::timestamptz, $27::timestamptz)
         ON CONFLICT DO NOTHING
         RETURNING ${EFFECT_COLUMNS}`,
        [
          checkedEffect.protocol_effect_id,
          checkedEffect.tenant_id,
          checkedEffect.protocol_session_id,
          checkedEffect.protocol_session_generation,
          checkedEffect.decision_id,
          checkedEffect.idempotency_key,
          checkedEffect.request_hash,
          checkedEffect.command_id,
          JSON.stringify(checkedEffect.adapter_identity),
          checkedEffect.adapter_identity_hash,
          checkedEffect.wire_bytes_hash,
          checkedEffect.wire_length_bytes,
          checkedEffect.canonical_wire_bytes,
          JSON.stringify(checkedEffect.route_binding),
          checkedEffect.route_binding_hash,
          JSON.stringify(checkedEffect.wire_attempt_facts),
          checkedEffect.wire_attempt_facts_hash,
          checkedEffect.wire_freeze_sha256,
          protocolEffectIdentityHash(checkedEffect),
          checkedEffect.owner_epoch,
          checkedEffect.command_sequence,
          SIP_EFFECT_SCHEMA_ID,
          SIP_EFFECT_SCHEMA_VERSION,
          SIP_EFFECT_SCHEMA_HASH,
          this.#writerIdentity,
          checkedEffect.audit_until,
          checkedEffect.prepared_at
        ]
      );
      const insertedRows = queryRows(inserted, 1, 'invalid_prepare_insert_rows');
      if (insertedRows[0]) {
        return {
          effect: decodeEffect(insertedRows[0], this.#writerIdentity),
          replayed: false
        };
      }

      const conflicts = await pg.query<EffectRow>(
        `/* converact-sip-effect-oracle:prepare-conflict-read */
         SELECT ${EFFECT_COLUMNS}
         FROM ivekit_sip_protocol_effects
         WHERE tenant_id = $1
           AND (protocol_effect_id = $2 OR idempotency_key = $3)
         ORDER BY (protocol_effect_id = $2) DESC
         FOR UPDATE`,
        [
          checkedEffect.tenant_id,
          checkedEffect.protocol_effect_id,
          checkedEffect.idempotency_key
        ]
      );
      const conflictRows = queryRows(
        conflicts,
        2,
        'invalid_prepare_conflict_rows'
      );
      if (conflictRows.length !== 1) idempotencyConflict();
      const existing = decodeEffect(conflictRows[0]!, this.#writerIdentity);
      if (!samePreparedEffect(existing, checkedEffect)) idempotencyConflict();
      return { effect: existing, replayed: true };
    });
  }

  transition(input: EffectTransition): Promise<ProtocolEffectRecord> {
    const checked = validateTransition(input);
    return this.#tenant(checked.identity.tenant_id, async (pg) => {
      const currentResult = await pg.query<EffectRow>(
        `/* converact-sip-effect-oracle:transition-lock */
         SELECT ${EFFECT_COLUMNS}
         FROM ivekit_sip_protocol_effects
         WHERE tenant_id = $1 AND protocol_effect_id = $2
         FOR UPDATE`,
        [checked.identity.tenant_id, checked.identity.protocol_effect_id]
      );
      const currentRows = queryRows(
        currentResult,
        1,
        'invalid_transition_lock_rows'
      );
      if (!currentRows[0]) notFound();
      const current = decodeEffect(currentRows[0], this.#writerIdentity);
      assertSameProtocolEffectIdentity(current, checked.identity);

      const replay = await pg.query<EffectRow>(
         `/* converact-sip-effect-oracle:receipt-replay */
         SELECT protocol_effect_id, effect_identity_hash, receipt_hash, level,
           schema_id, schema_version, schema_hash, writer_identity
         FROM ivekit_sip_effect_receipts
         WHERE tenant_id = $1 AND receipt_id = $2`,
        [checked.identity.tenant_id, checked.receipt_id]
      );
      const replayRows = queryRows(replay, 1, 'invalid_receipt_replay_rows');
      if (replayRows[0]) {
        const row = snapshotSchemaRecord(
          replayRows[0],
          RECEIPT_REPLAY_ROW_KEYS,
          'invalid_receipt_row'
        );
        assertReplaySchema(row, this.#writerIdentity, current);
        if (row.protocol_effect_id !== checked.identity.protocol_effect_id ||
            row.effect_identity_hash !==
              protocolEffectIdentityHash(checked.identity) ||
            row.receipt_hash !== checked.receipt_hash ||
            row.level !== checked.level) {
          receiptConflict();
        }
        return current;
      }

      if (current.terminal_tombstone) {
        throw new SipEffectError({ code: 'sip_effect_terminal', status: 409 });
      }
      if (!checked.allowed_from.includes(current.state)) transitionConflict();
      if ((current.state === 'unknown') !== (checked.repair_fence !== null)) {
        fenceLost();
      }
      if (current.state === 'unknown') {
        assertLiveRepairFence(current, checked);
      }
      const terminal =
        checked.level === 'transport_completed' ||
        checked.level === 'protocol_observed' ||
        checked.level === 'failed';
      if (terminal !== checked.terminal) transitionConflict();

      const insertedReceipt = await pg.query<EffectRow>(
        `/* converact-sip-effect-oracle:receipt-insert */
         INSERT INTO ivekit_sip_effect_receipts
          (receipt_id, tenant_id, protocol_effect_id, decision_id,
           idempotency_key, request_hash, command_id, wire_bytes_hash,
           effect_identity_hash, owner_epoch, command_sequence, receipt_hash,
           level, from_state,
           failure_code, repair_delay_ms, observed_at, schema_id,
           schema_version, schema_hash, writer_identity)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric,
           $12, $13, $14, $15, $16, statement_timestamp(), $17, $18, $19, $20)
         ON CONFLICT (tenant_id, receipt_id) DO NOTHING
         RETURNING receipt_id`,
        [
          checked.receipt_id,
          checked.identity.tenant_id,
          checked.identity.protocol_effect_id,
          checked.identity.decision_id,
          checked.identity.idempotency_key,
          checked.identity.request_hash,
          checked.identity.command_id,
          checked.identity.wire_bytes_hash,
          protocolEffectIdentityHash(checked.identity),
          checked.identity.owner_epoch,
          checked.identity.command_sequence,
          checked.receipt_hash,
          checked.level,
          current.state,
          checked.failure_code,
          checked.repair_delay_ms,
          current.schema_id,
          current.schema_version,
          current.schema_hash,
          this.#writerIdentity
        ]
      );
      const insertedReceiptRows = queryRows(
        insertedReceipt,
        1,
        'invalid_receipt_insert_rows'
      );
      if (!insertedReceiptRows[0]) {
        const conflictingReceipt = await pg.query<EffectRow>(
          `/* converact-sip-effect-oracle:receipt-conflict-read */
           SELECT protocol_effect_id, receipt_hash, level,
             effect_identity_hash,
             schema_id, schema_version, schema_hash, writer_identity
           FROM ivekit_sip_effect_receipts
           WHERE tenant_id = $1 AND receipt_id = $2`,
          [checked.identity.tenant_id, checked.receipt_id]
        );
        const conflictingRows = queryRows(
          conflictingReceipt,
          1,
          'invalid_receipt_conflict_rows'
        );
        const row = conflictingRows[0]
          ? snapshotSchemaRecord(
              conflictingRows[0],
              RECEIPT_REPLAY_ROW_KEYS,
              'invalid_receipt_row'
            )
          : undefined;
        if (row) assertReplaySchema(row, this.#writerIdentity, current);
        if (!row ||
            row.protocol_effect_id !==
              checked.identity.protocol_effect_id ||
            row.effect_identity_hash !==
              protocolEffectIdentityHash(checked.identity) ||
            row.receipt_hash !== checked.receipt_hash ||
            row.level !== checked.level) {
          receiptConflict();
        }
        return current;
      }
      const fence = checked.repair_fence;
      const updated = await pg.query<EffectRow>(
        `/* converact-sip-effect-oracle:transition-update */
         UPDATE ivekit_sip_protocol_effects AS effect
         SET state = $10,
             revision = revision + 1,
             unknown_count = unknown_count +
               CASE WHEN $10 = 'unknown' THEN 1 ELSE 0 END,
             last_receipt_id = $11,
             last_receipt_hash = $12,
             last_receipt_repair_delay_ms = $14::integer,
             failure_code = $13,
             repair_due_at = CASE
               WHEN $10 = 'unknown' THEN statement_timestamp() +
                 ($14::integer * INTERVAL '1 millisecond')
               ELSE repair_due_at
             END,
             repair_owner_id = CASE WHEN $15 THEN NULL ELSE repair_owner_id END,
             repair_owner_epoch = CASE WHEN $15 THEN NULL ELSE repair_owner_epoch END,
             repair_claim_token = CASE WHEN $15 THEN NULL ELSE repair_claim_token END,
             repair_claim_revision = CASE WHEN $15 THEN NULL ELSE repair_claim_revision END,
             repair_lease_until = CASE WHEN $15 THEN NULL ELSE repair_lease_until END,
             terminal_tombstone_id = CASE WHEN $16 THEN $11 ELSE NULL END,
             terminal_tombstone_hash = CASE WHEN $16 THEN $12 ELSE NULL END,
             terminal_at = CASE WHEN $16 THEN statement_timestamp() ELSE NULL END,
             updated_at = statement_timestamp()
         WHERE tenant_id = $1
           AND protocol_effect_id = $2
           AND decision_id = $3
           AND idempotency_key = $4
           AND request_hash = $5
           AND command_id = $6
           AND wire_bytes_hash = $7
           AND owner_epoch = $8::numeric
           AND command_sequence = $9::numeric
           AND effect_identity_hash = $23
           AND revision = $17::numeric
           AND state = ANY($18::text[])
           AND (
             $15 = FALSE OR (
               repair_owner_id = $19
               AND repair_owner_epoch = $20::numeric
               AND repair_claim_token = $21
               AND repair_claim_revision = $22::numeric
               AND revision = $22::numeric
               AND repair_lease_until > statement_timestamp()
             )
           )
         RETURNING ${EFFECT_COLUMNS_QUALIFIED}`,
        [
          checked.identity.tenant_id,
          checked.identity.protocol_effect_id,
          checked.identity.decision_id,
          checked.identity.idempotency_key,
          checked.identity.request_hash,
          checked.identity.command_id,
          checked.identity.wire_bytes_hash,
          checked.identity.owner_epoch,
          checked.identity.command_sequence,
          checked.level,
          checked.receipt_id,
          checked.receipt_hash,
          checked.failure_code,
          checked.repair_delay_ms,
          fence !== null,
          terminal,
          current.revision,
          [...checked.allowed_from],
          fence?.repair_owner_id ?? '',
          fence?.repair_owner_epoch ?? '1',
          fence?.repair_claim_token ?? '',
          fence?.repair_claim_revision ?? '1',
          protocolEffectIdentityHash(checked.identity)
        ]
      );
      const updatedRows = queryRows(
        updated,
        1,
        'invalid_transition_update_rows'
      );
      if (!updatedRows[0]) fenceLost();
      return decodeEffect(updatedRows[0], this.#writerIdentity);
    });
  }

  query(identity: ProtocolEffectIdentity): Promise<ProtocolEffectRecord | null> {
    const checked = validateProtocolEffectIdentity(identity);
    return this.#tenant(checked.tenant_id, async (pg) => {
      const result = await pg.query<EffectRow>(
        `/* converact-sip-effect-oracle:query */
         SELECT ${EFFECT_COLUMNS}
         FROM ivekit_sip_protocol_effects
         WHERE tenant_id = $1 AND protocol_effect_id = $2`,
        [checked.tenant_id, checked.protocol_effect_id]
      );
      const rows = queryRows(result, 1, 'invalid_query_rows');
      if (!rows[0]) return null;
      const effect = decodeEffect(rows[0], this.#writerIdentity);
      assertSameProtocolEffectIdentity(effect, checked);
      return effect;
    });
  }

  claimUnknownForRepair(input: EffectRepairClaim): Promise<EffectRepairBatch> {
    const checked = validateEffectRepairClaim(input);
    return this.#tenant(checked.tenant_id, async (pg) => {
      const dueResult = await pg.query<EffectRow>(
        `/* converact-sip-effect-oracle:claim-repair */
         SELECT ${EFFECT_COLUMNS}
         FROM ivekit_sip_protocol_effects
         WHERE tenant_id = $1
           AND state = 'unknown'
           AND operator_attention_required = FALSE
           AND repair_due_at <= statement_timestamp()
           AND (
             repair_lease_until IS NULL OR
             repair_lease_until <= statement_timestamp()
           )
           AND repair_epoch_high_watermark < $2::numeric
           AND (
             repair_attempts < 8 OR
             repair_attempts = 8
           )
         ORDER BY repair_due_at, protocol_effect_id
         FOR UPDATE SKIP LOCKED
         LIMIT $3`,
        [
          checked.tenant_id,
          checked.repair_owner_epoch,
          checked.limit
        ]
      );
      const dueRows = queryRows(
        dueResult,
        checked.limit,
        'invalid_repair_claim_rows'
      );
      const claimable: ProtocolEffectRecord[] = [];
      const exhausted: ProtocolEffectRecord[] = [];
      for (let index = 0; index < dueRows.length; index += 1) {
        const effect = decodeEffect(dueRows[index]!, this.#writerIdentity);
        if (effect.repair_attempts < REPAIR_ATTEMPT_CEILING) {
          claimable.push(effect);
        } else {
          exhausted.push(effect);
        }
      }

      const claimedRows = claimable.length
        ? await updateClaimedRepairs(pg, checked, claimable)
        : [];
      const exhaustedCount = exhausted.length
        ? await updateExhaustedRepairs(pg, checked, exhausted)
        : 0;
      if (claimedRows.length !== claimable.length ||
          exhaustedCount !== exhausted.length) {
        fenceLost();
      }
      const effects: ProtocolEffectRecord[] = [];
      for (let index = 0; index < claimedRows.length; index += 1) {
        effects.push(decodeEffect(claimedRows[index]!, this.#writerIdentity));
      }
      return {
        effects,
        exhausted_count: exhaustedCount
      };
    });
  }

  releaseRepairClaim(input: EffectRepairReleaseRequest): Promise<void> {
    const checked = validateEffectRepairReleaseRequest(input);
    return this.#tenant(checked.identity.tenant_id, async (pg) => {
      const result = await pg.query(
        `/* converact-sip-effect-oracle:release-repair */
         UPDATE ivekit_sip_protocol_effects
         SET repair_owner_id = NULL,
             repair_owner_epoch = NULL,
             repair_claim_token = NULL,
             repair_claim_revision = NULL,
             repair_lease_until = NULL,
             repair_due_at = statement_timestamp() +
               ($15::double precision * INTERVAL '1 millisecond'),
             revision = revision + 1,
             updated_at = statement_timestamp()
         WHERE tenant_id = $1
           AND protocol_effect_id = $2
           AND decision_id = $3
           AND idempotency_key = $4
           AND request_hash = $5
           AND command_id = $6
           AND wire_bytes_hash = $7
           AND owner_epoch = $8::numeric
           AND command_sequence = $9::numeric
           AND effect_identity_hash = $10
           AND repair_owner_id = $11
           AND repair_owner_epoch = $12::numeric
           AND repair_claim_token = $13
           AND repair_claim_revision = $14::numeric
           AND revision = $14::numeric
           AND repair_lease_until > statement_timestamp()
           AND state = 'unknown'
         RETURNING protocol_effect_id`,
        [
          checked.identity.tenant_id,
          checked.identity.protocol_effect_id,
          checked.identity.decision_id,
          checked.identity.idempotency_key,
          checked.identity.request_hash,
          checked.identity.command_id,
          checked.identity.wire_bytes_hash,
          checked.identity.owner_epoch,
          checked.identity.command_sequence,
          protocolEffectIdentityHash(checked.identity),
          checked.fence.repair_owner_id,
          checked.fence.repair_owner_epoch,
          checked.fence.repair_claim_token,
          checked.fence.repair_claim_revision,
          checked.next_repair_at.getTime() - checked.released_at.getTime()
        ]
      );
      if (queryRows(result, 1, 'invalid_repair_release_rows').length !== 1) {
        fenceLost();
      }
    });
  }

  compactExhaustedRepairs(input: EffectRepairCompactRequest): Promise<number> {
    const checked = validateEffectRepairCompactRequest(input);
    return this.#tenant(checked.tenant_id, async (pg) => {
      const result = await pg.query<EffectRow>(
        `/* converact-sip-effect-oracle:compact-exhausted */
         WITH eligible AS (
           SELECT tenant_id, protocol_effect_id
           FROM ivekit_sip_protocol_effects
           WHERE tenant_id = $1
             AND operator_attention_required = TRUE
             AND repair_exhausted_at <= $2::timestamptz
             AND repair_compacted_at IS NULL
           ORDER BY repair_exhausted_at, protocol_effect_id
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE ivekit_sip_protocol_effects AS effect
         SET repair_owner_id = NULL,
             repair_owner_epoch = NULL,
             repair_claim_token = NULL,
             repair_claim_revision = NULL,
             repair_lease_until = NULL,
             repair_due_at = NULL,
             repair_compacted_at = $2::timestamptz,
             revision = revision + 1,
             updated_at = $2::timestamptz
         FROM eligible
         WHERE effect.tenant_id = eligible.tenant_id
           AND effect.protocol_effect_id = eligible.protocol_effect_id
         RETURNING effect.protocol_effect_id`,
        [checked.tenant_id, checked.cutoff.toISOString(), checked.limit]
      );
      return queryRows(
        result,
        checked.limit,
        'invalid_repair_compaction_rows'
      ).length;
    });
  }

  pruneTerminalPayloads(input: EffectRetentionRequest): Promise<number> {
    const checked = validateEffectRetentionRequest(input);
    return this.#tenant(checked.tenant_id, async (pg) => {
      const result = await pg.query<EffectRow>(
        `/* converact-sip-effect-oracle:prune-terminal */
         WITH eligible AS (
           SELECT tenant_id, protocol_effect_id
           FROM ivekit_sip_protocol_effects
           WHERE tenant_id = $1
             AND terminal_at IS NOT NULL
             AND payload_retained = TRUE
             AND retention_reference_count = 0
             AND rollback_reference_count = 0
             AND audit_until <= $2::timestamptz
           ORDER BY audit_until, protocol_effect_id
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE ivekit_sip_protocol_effects AS effect
         SET canonical_wire_bytes = decode('', 'hex'),
             payload_retained = FALSE,
             revision = revision + 1,
             updated_at = $2::timestamptz
         FROM eligible
         WHERE effect.tenant_id = eligible.tenant_id
           AND effect.protocol_effect_id = eligible.protocol_effect_id
         RETURNING effect.protocol_effect_id`,
        [checked.tenant_id, checked.cutoff.toISOString(), checked.limit]
      );
      return queryRows(
        result,
        checked.limit,
        'invalid_retention_rows'
      ).length;
    });
  }

  async runAtomicBoundary(
    metadataInput: AtomicBoundaryMetadata
  ): Promise<never> {
    validateAtomicBoundaryMetadata(metadataInput);
    schemaIncompatible('atomic_domain_writes_not_wired_not_production');
  }

  async #tenant<T>(
    tenantId: string,
    operation: (pg: PgQueryable) => Promise<T>
  ): Promise<T> {
    if (!hasDataMethod(this.pg, 'connect') ||
        hasDataMethod(this.pg, 'release')) {
      schemaIncompatible('effect_store_requires_owned_pool_transaction');
    }
    const admission = await this.#admission.acquire();
    try {
      const boundedPool = new PoolAcquisitionDeadline(
        this.pg as ConnectableEffectPool,
        admission
      );
      return await withPgTenant(boundedPool, tenantId, async (pg) => {
        await pg.query(`SET LOCAL statement_timeout = '250ms'`);
        await pg.query(`SET LOCAL lock_timeout = '250ms'`);
        await pg.query(
          'SET LOCAL search_path = pg_catalog, public, pg_temp'
        );
        await pg.query(`SET LOCAL ROLE ${EFFECT_EXECUTOR_ROLE}`);
        await pg.query(
          `SELECT set_config(
             'app.sip_effect_writer_identity',
             $1,
             TRUE
           )`,
          [this.#writerIdentity]
        );
        await pg.query(
          `SELECT ivekit_assert_sip_effect_writer($1, $2, $3, $4)`,
          [
            this.#writerIdentity,
            SIP_EFFECT_SCHEMA_ID,
            SIP_EFFECT_SCHEMA_VERSION,
            SIP_EFFECT_SCHEMA_HASH
          ]
        );
        return operation(pg);
      });
    } catch (error) {
      if (error instanceof SipEffectError) throw error;
      throw mapPostgresError(error);
    } finally {
      admission.release();
    }
  }
}

async function updateClaimedRepairs(
  pg: PgQueryable,
  input: EffectRepairClaim,
  effects: ProtocolEffectRecord[]
): Promise<EffectRow[]> {
  const values: string[] = [];
  const params: unknown[] = [];
  for (const [index, effect] of effects.entries()) {
    const offset = index * 4;
    values.push(
      `($${offset + 1}, $${offset + 2}::numeric, $${offset + 3}, ` +
      `$${offset + 4}::numeric)`
    );
    params.push(
      effect.protocol_effect_id,
      effect.revision,
      `${input.claim_token_prefix}:${effect.protocol_effect_id}:` +
        `${input.repair_owner_epoch}:${nextU64(effect.revision)}`,
      input.repair_owner_epoch
    );
  }
  const base = params.length;
  params.push(
    input.tenant_id,
    input.repair_owner_id,
    input.lease_until.getTime() - input.claimed_at.getTime()
  );
  const result = await pg.query<EffectRow>(
    `/* converact-sip-effect-oracle:claim-repair-update */
     UPDATE ivekit_sip_protocol_effects AS effect
     SET repair_owner_id = $${base + 2},
         repair_owner_epoch = candidate.owner_epoch,
         repair_epoch_high_watermark = candidate.owner_epoch,
         repair_claim_token = candidate.claim_token,
         repair_lease_until = statement_timestamp() +
           ($${base + 3}::double precision * INTERVAL '1 millisecond'),
         repair_attempts = repair_attempts + 1,
         revision = revision + 1,
         repair_claim_revision = revision + 1,
         updated_at = statement_timestamp()
     FROM (VALUES ${values.join(', ')})
       AS candidate(protocol_effect_id, expected_revision, claim_token, owner_epoch)
     WHERE effect.tenant_id = $${base + 1}
       AND effect.protocol_effect_id = candidate.protocol_effect_id
       AND effect.revision = candidate.expected_revision
       AND effect.state = 'unknown'
       AND effect.operator_attention_required = FALSE
       AND effect.repair_attempts < 8
       AND effect.repair_epoch_high_watermark < candidate.owner_epoch
       AND (
         effect.repair_lease_until IS NULL OR
         effect.repair_lease_until <= statement_timestamp()
       )
     RETURNING ${EFFECT_COLUMNS_QUALIFIED}`,
    params
  );
  return [...queryRows(
    result,
    effects.length,
    'invalid_claim_update_rows'
  )];
}

async function updateExhaustedRepairs(
  pg: PgQueryable,
  input: EffectRepairClaim,
  effects: ProtocolEffectRecord[]
): Promise<number> {
  const values: string[] = [];
  const params: unknown[] = [];
  for (const [index, effect] of effects.entries()) {
    const offset = index * 3;
    values.push(
      `($${offset + 1}, $${offset + 2}::numeric, $${offset + 3})`
    );
    params.push(
      effect.protocol_effect_id,
      effect.revision,
      canonicalSipEffectHash({
        tenant_id: effect.tenant_id,
        protocol_effect_id: effect.protocol_effect_id,
        repair_attempts: effect.repair_attempts,
        repair_epoch_high_watermark: input.repair_owner_epoch
      })
    );
  }
  const base = params.length;
  params.push(
    input.tenant_id,
    input.repair_owner_epoch
  );
  const result = await pg.query<EffectRow>(
    `/* converact-sip-effect-oracle:exhaust-repair-update */
     UPDATE ivekit_sip_protocol_effects AS effect
     SET repair_owner_id = NULL,
         repair_owner_epoch = NULL,
         repair_epoch_high_watermark = $${base + 2}::numeric,
         repair_claim_token = NULL,
         repair_claim_revision = NULL,
         repair_lease_until = NULL,
         repair_due_at = NULL,
         repair_exhausted_at = statement_timestamp(),
         repair_exhaustion_receipt_hash = candidate.exhaustion_hash,
         operator_attention_required = TRUE,
         revision = revision + 1,
         updated_at = statement_timestamp()
     FROM (VALUES ${values.join(', ')})
       AS candidate(protocol_effect_id, expected_revision, exhaustion_hash)
     WHERE effect.tenant_id = $${base + 1}
       AND effect.protocol_effect_id = candidate.protocol_effect_id
       AND effect.revision = candidate.expected_revision
       AND effect.state = 'unknown'
       AND effect.operator_attention_required = FALSE
       AND effect.repair_attempts = 8
       AND effect.repair_epoch_high_watermark < $${base + 2}::numeric
     RETURNING effect.protocol_effect_id`,
    params
  );
  return queryRows(
    result,
    effects.length,
    'invalid_exhaust_update_rows'
  ).length;
}

function validatePreparedRecord(
  input: ProtocolEffectRecord
): ProtocolEffectRecord {
  const effect = cloneProtocolEffect(input);
  const identity = validateProtocolEffectIdentity({
    tenant_id: effect.tenant_id,
    protocol_effect_id: effect.protocol_effect_id,
    protocol_session_id: effect.protocol_session_id,
    protocol_session_generation: effect.protocol_session_generation,
    decision_id: effect.decision_id,
    idempotency_key: effect.idempotency_key,
    request_hash: effect.request_hash,
    command_id: effect.command_id,
    adapter_identity_hash: effect.adapter_identity_hash,
    wire_bytes_hash: effect.wire_bytes_hash,
    wire_length_bytes: effect.wire_length_bytes,
    route_binding_hash: effect.route_binding_hash,
    wire_attempt_facts_hash: effect.wire_attempt_facts_hash,
    wire_freeze_sha256: effect.wire_freeze_sha256,
    owner_epoch: effect.owner_epoch,
    command_sequence: effect.command_sequence
  });
  assertSameProtocolEffectIdentity(effect, identity);
  if (effect.schema_id !== SIP_EFFECT_SCHEMA_ID ||
      effect.schema_version !== SIP_EFFECT_SCHEMA_VERSION ||
      effect.schema_hash !== SIP_EFFECT_SCHEMA_HASH ||
      effect.state !== 'prepared' ||
      effect.revision !== '1' ||
      effect.canonical_wire_bytes.byteLength < 1 ||
      effect.canonical_wire_bytes.byteLength > 65_535 ||
      effect.canonical_wire_bytes.byteLength !== effect.wire_length_bytes ||
      createHash('sha256')
        .update(effect.canonical_wire_bytes)
        .digest('hex') !== effect.wire_bytes_hash) {
    throw new SipEffectError({
      code: 'sip_effect_validation_failed',
      status: 422,
      details: { field: 'effect' }
    });
  }
  return effect;
}

function validateTransition(input: EffectTransition): EffectTransition {
  const record = snapshotInputRecord(
    input,
    [
      'identity',
      'receipt_id',
      'receipt_hash',
      'level',
      'allowed_from',
      'observed_at',
      'failure_code',
      'repair_delay_ms',
      'terminal',
      'repair_fence'
    ],
    'transition'
  );
  const identity = validateProtocolEffectIdentity(
    record.identity as ProtocolEffectIdentity
  );
  const allowedFromInput = snapshotClosedArray(
    record.allowed_from,
    EFFECT_STATES.size,
    () => validationError('transition.allowed_from')
  );
  if (!EFFECT_RECEIPT_LEVELS.has(record.level as EffectTransition['level']) ||
      allowedFromInput.length < 1 ||
      typeof record.terminal !== 'boolean') {
    validation('transition');
  }
  const allowedFrom: ProtocolEffectState[] = [];
  for (let index = 0; index < allowedFromInput.length; index += 1) {
    const state = allowedFromInput[index];
    if (!EFFECT_STATES.has(state as ProtocolEffectState)) {
      validation('transition.allowed_from');
    }
    allowedFrom.push(state as ProtocolEffectState);
  }
  const observedAt = inputTimestamp(record.observed_at, 'observed_at');
  const repairDelayMs = record.repair_delay_ms === null
    ? null
    : checkedBoundedInteger(
        record.repair_delay_ms,
        0,
        MAX_REPAIR_DELAY_MS,
        'repair_delay_ms'
      );
  const fence = record.repair_fence === null
    ? null
    : validateRepairFenceLocally(
        record.repair_fence as NonNullable<EffectTransition['repair_fence']>
      );
  const receiptId = checkedIdentifier(record.receipt_id, 'receipt_id');
  const receiptHash = checkedInputHash(record.receipt_hash, 'receipt_hash');
  const level = record.level as EffectTransition['level'];
  const failureCode = checkedFailureCode(record.failure_code);
  assertClosedTransitionPolicy({
    level,
    allowed_from: allowedFrom,
    failure_code: failureCode,
    repair_delay_ms: repairDelayMs,
    terminal: record.terminal,
    repair_fence: fence
  });
  if (receiptHash !== canonicalSipEffectHash({
    identity,
    receipt_id: receiptId,
    level,
    failure_code: failureCode,
    repair_delay_ms: repairDelayMs
  })) {
    validation('transition.receipt_hash');
  }
  return {
    identity,
    receipt_id: receiptId,
    receipt_hash: receiptHash,
    level,
    allowed_from: allowedFrom,
    observed_at: observedAt,
    failure_code: failureCode,
    repair_delay_ms: repairDelayMs,
    terminal: record.terminal,
    repair_fence: fence
  };
}

function assertClosedTransitionPolicy(
  input: Pick<
    EffectTransition,
    | 'level'
    | 'allowed_from'
    | 'failure_code'
    | 'repair_delay_ms'
    | 'terminal'
    | 'repair_fence'
  >
): void {
  const repaired = input.repair_fence !== null;
  let expectedFrom: readonly ProtocolEffectState[];
  switch (input.level) {
    case 'durable_decision':
      expectedFrom = ['prepared'];
      break;
    case 'send_attempted':
      expectedFrom = ['durable_decision'];
      break;
    case 'transport_accepted':
      expectedFrom = ['send_attempted'];
      break;
    case 'transport_completed':
      expectedFrom = ['transport_accepted'];
      break;
    case 'protocol_observed':
      expectedFrom = repaired
        ? ['unknown']
        : ['send_attempted', 'transport_accepted'];
      break;
    case 'failed':
      expectedFrom = repaired
        ? ['unknown']
        : ['prepared', 'durable_decision', 'send_attempted', 'transport_accepted'];
      break;
    case 'unknown':
      expectedFrom = repaired
        ? ['unknown']
        : ['send_attempted', 'transport_accepted'];
      break;
  }
  if (!sameStateSet(input.allowed_from, expectedFrom) ||
      input.terminal !==
        (input.level === 'transport_completed' ||
         input.level === 'protocol_observed' ||
         input.level === 'failed') ||
      (input.level === 'failed'
        ? input.failure_code.length === 0
        : input.failure_code.length !== 0) ||
      (input.level === 'unknown'
        ? input.repair_delay_ms === null
        : input.repair_delay_ms !== null) ||
      (repaired &&
       input.level !== 'unknown' &&
       input.level !== 'protocol_observed' &&
       input.level !== 'failed')) {
    validation('transition.policy');
  }
}

function sameStateSet(
  actual: readonly ProtocolEffectState[],
  expected: readonly ProtocolEffectState[]
): boolean {
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    let matches = 0;
    for (let candidate = 0; candidate < expected.length; candidate += 1) {
      if (actual[index] === expected[candidate]) matches += 1;
    }
    if (matches !== 1) return false;
  }
  return true;
}

function validateRepairFenceLocally(
  value: EffectTransition['repair_fence'] & {}
): NonNullable<EffectTransition['repair_fence']> {
  const record = snapshotInputRecord(
    value,
    [
      'repair_owner_id',
      'repair_owner_epoch',
      'repair_claim_token',
      'repair_claim_revision'
    ],
    'repair_fence'
  );
  return {
    repair_owner_id: checkedIdentifier(
      record.repair_owner_id,
      'repair_owner_id'
    ),
    repair_owner_epoch: uint64Decimal(
      record.repair_owner_epoch,
      'repair_owner_epoch',
      true
    ),
    repair_claim_token: checkedAsciiToken(
      record.repair_claim_token,
      'repair_claim_token',
      512
    ),
    repair_claim_revision: uint64Decimal(
      record.repair_claim_revision,
      'repair_claim_revision',
      true
    )
  };
}

function assertLiveRepairFence(
  current: ProtocolEffectRecord,
  input: EffectTransition
): void {
  const fence = input.repair_fence;
  if (!fence ||
      current.repair_owner_id !== fence.repair_owner_id ||
      current.repair_owner_epoch !== fence.repair_owner_epoch ||
      current.repair_claim_token !== fence.repair_claim_token ||
      current.repair_claim_revision !== fence.repair_claim_revision ||
      current.revision !== fence.repair_claim_revision) {
    fenceLost();
  }
}

function decodeEffect(
  input: unknown,
  expectedWriterIdentity: string
): ProtocolEffectRecord {
  const row = snapshotSchemaRecord(
    input,
    EFFECT_ROW_KEYS,
    'invalid_effect_row'
  );
  if (typeof row.state !== 'string') {
    schemaIncompatible('invalid_effect_state');
  }
  const state = row.state as ProtocolEffectState;
  if (!EFFECT_STATES.has(state)) schemaIncompatible('invalid_effect_state');
  const schemaVersion = integer(row.schema_version);
  const schemaHash = row.schema_hash;
  if (!isSupportedSipEffectSchema({
        schema_id: row.schema_id,
        schema_version: schemaVersion,
        schema_hash: schemaHash
      }) ||
      (schemaVersion === SIP_EFFECT_SCHEMA_V1_VERSION &&
       state === 'transport_completed') ||
      row.writer_identity !== expectedWriterIdentity) {
    schemaIncompatible('invalid_schema_identity');
  }
  const terminalId = nullableText(row.terminal_tombstone_id);
  const terminalHash = nullableText(row.terminal_tombstone_hash);
  const terminalAt = nullableTimestamp(row.terminal_at);
  if ((terminalId === null) !== (terminalHash === null) ||
      (terminalId === null) !== (terminalAt === null) ||
      (terminalId !== null &&
       state !== 'transport_completed' &&
       state !== 'protocol_observed' && state !== 'failed')) {
    schemaIncompatible('invalid_terminal_tombstone');
  }
  const effectId = text(row.protocol_effect_id);
  const adapter = adapterIdentity(row.adapter_identity);
  const adapterHash = databaseHash(
    row.adapter_identity_hash,
    'adapter_identity_hash'
  );
  if (canonicalSipEffectHash(adapter) !== adapterHash) {
    schemaIncompatible('invalid_adapter_identity_hash');
  }
  const route = routeBinding(row.route_binding);
  const routeHash = databaseHash(row.route_binding_hash, 'route_binding_hash');
  const attemptFacts = wireAttemptFacts(row.wire_attempt_facts, effectId);
  const attemptFactsHash = databaseHash(
    row.wire_attempt_facts_hash,
    'wire_attempt_facts_hash'
  );
  const wireFreezeHash = databaseHash(
    row.wire_freeze_sha256,
    'wire_freeze_sha256'
  );
  if (sipRouteBindingSha256(route) !== routeHash ||
      sipWireAttemptFactsSha256(attemptFacts) !== attemptFactsHash) {
    schemaIncompatible('invalid_route_binding_hash');
  }
  const exhaustedAt = nullableTimestamp(row.repair_exhausted_at);
  const exhaustionHash = nullableText(row.repair_exhaustion_receipt_hash);
  const operatorAttention = boolean(row.operator_attention_required);
  if ((exhaustedAt === null) !== (exhaustionHash === null) ||
      operatorAttention !== (exhaustedAt !== null)) {
    schemaIncompatible('invalid_repair_exhaustion');
  }
  const wireHash = databaseHash(row.wire_bytes_hash, 'wire_bytes_hash');
  const wireLength = integer(row.wire_length_bytes);
  const wireBytes = bytes(row.canonical_wire_bytes);
  const payloadRetained = boolean(row.payload_retained);
  if (sipWireFreezeSha256({
    route_binding_sha256: routeHash,
    wire_attempt_facts_sha256: attemptFactsHash,
    wire_sha256: wireHash,
    wire_length_bytes: wireLength
  }) !== wireFreezeHash) {
    schemaIncompatible('invalid_wire_freeze_hash');
  }
  if ((payloadRetained &&
       (wireBytes.byteLength < 1 ||
        wireBytes.byteLength > 65_535 ||
        wireBytes.byteLength !== wireLength ||
        createHash('sha256').update(wireBytes).digest('hex') !== wireHash)) ||
      (!payloadRetained && (wireBytes.byteLength !== 0 || terminalAt === null))) {
    schemaIncompatible('invalid_canonical_wire_bytes');
  }
  const repairOwnerId = nullableText(row.repair_owner_id);
  const repairOwnerEpoch = nullableDatabaseU64(
    row.repair_owner_epoch,
    'repair_owner_epoch',
    true
  );
  const repairHighWatermark = databaseU64(
    row.repair_epoch_high_watermark,
    'repair_epoch_high_watermark',
    false
  );
  const repairClaimToken = nullableText(row.repair_claim_token);
  const repairClaimRevision = nullableDatabaseU64(
    row.repair_claim_revision,
    'repair_claim_revision',
    true
  );
  const repairLeaseUntil = nullableTimestamp(row.repair_lease_until);
  const repairGroup = [
    repairOwnerId,
    repairOwnerEpoch,
    repairClaimToken,
    repairClaimRevision,
    repairLeaseUntil
  ];
  if (!repairGroup.every((value) => value === null) &&
      !repairGroup.every((value) => value !== null)) {
    schemaIncompatible('invalid_repair_claim');
  }
  if (repairOwnerEpoch !== null &&
      BigInt(repairOwnerEpoch) !== BigInt(repairHighWatermark)) {
    schemaIncompatible('invalid_repair_epoch');
  }
  const repairAttempts = integer(row.repair_attempts);
  if (repairAttempts > REPAIR_ATTEMPT_CEILING ||
      (state === 'unknown' &&
       nullableTimestamp(row.repair_due_at) === null &&
       !operatorAttention)) {
    schemaIncompatible('invalid_repair_state');
  }
  const revision = databaseU64(row.revision, 'revision', true);
  if (repairClaimRevision !== null && repairClaimRevision !== revision) {
    schemaIncompatible('invalid_repair_revision');
  }
  const lastReceiptRepairDelayMs =
    row.last_receipt_repair_delay_ms === null
      ? null
      : integer(row.last_receipt_repair_delay_ms);
  if (lastReceiptRepairDelayMs !== null &&
      lastReceiptRepairDelayMs > MAX_REPAIR_DELAY_MS) {
    schemaIncompatible('invalid_last_receipt_repair_delay');
  }
  const decoded: ProtocolEffectRecord = {
    tenant_id: text(row.tenant_id),
    protocol_effect_id: effectId,
    protocol_session_id: text(row.protocol_session_id),
    protocol_session_generation: text(row.protocol_session_generation),
    decision_id: text(row.decision_id),
    idempotency_key: text(row.idempotency_key),
    request_hash: databaseHash(row.request_hash, 'request_hash'),
    command_id: text(row.command_id),
    adapter_identity_hash: adapterHash,
    wire_bytes_hash: wireHash,
    wire_length_bytes: wireLength,
    route_binding_hash: routeHash,
    wire_attempt_facts_hash: attemptFactsHash,
    wire_freeze_sha256: wireFreezeHash,
    owner_epoch: databaseU64(row.owner_epoch, 'owner_epoch', true),
    command_sequence: databaseU64(
      row.command_sequence,
      'command_sequence',
      true
    ),
    schema_id: SIP_EFFECT_SCHEMA_ID,
    schema_version: schemaVersion as ProtocolEffectRecord['schema_version'],
    schema_hash: schemaHash as string,
    adapter_identity: adapter,
    canonical_wire_bytes: wireBytes,
    route_binding: route,
    wire_attempt_facts: attemptFacts,
    state,
    revision,
    unknown_count: integer(row.unknown_count),
    last_receipt_id: nullableText(row.last_receipt_id),
    last_receipt_hash: nullableDatabaseHash(
      row.last_receipt_hash,
      'last_receipt_hash'
    ),
    last_receipt_repair_delay_ms: lastReceiptRepairDelayMs,
    failure_code: typeof row.failure_code === 'string'
      ? row.failure_code
      : schemaIncompatible('invalid_failure_code'),
    repair_due_at: nullableTimestamp(row.repair_due_at),
    repair_owner_id: repairOwnerId,
    repair_owner_epoch: repairOwnerEpoch,
    repair_epoch_high_watermark: repairHighWatermark,
    repair_claim_token: repairClaimToken,
    repair_claim_revision: repairClaimRevision,
    repair_lease_until: repairLeaseUntil,
    repair_attempts: repairAttempts,
    repair_exhausted_at: exhaustedAt,
    repair_exhaustion_receipt_hash: exhaustionHash === null
      ? null
      : databaseHash(exhaustionHash, 'repair_exhaustion_receipt_hash'),
    operator_attention_required: operatorAttention,
    repair_compacted_at: nullableTimestamp(row.repair_compacted_at),
    retention_reference_count: integer(row.retention_reference_count),
    rollback_reference_count: integer(row.rollback_reference_count),
    audit_until: timestamp(row.audit_until),
    payload_retained: payloadRetained,
    terminal_tombstone: terminalId && terminalHash && terminalAt
      ? {
          receipt_id: terminalId,
          receipt_hash: databaseHash(terminalHash, 'terminal_tombstone_hash'),
          state: state as 'transport_completed' | 'protocol_observed' | 'failed',
          terminal_at: terminalAt
        }
      : null,
    prepared_at: timestamp(row.prepared_at),
    updated_at: timestamp(row.updated_at)
  };
  try {
    if (databaseHash(
      row.effect_identity_hash,
      'effect_identity_hash'
    ) !== protocolEffectIdentityHash(decoded)) {
      schemaIncompatible('invalid_effect_identity_hash');
    }
    return cloneProtocolEffect(decoded);
  } catch (error) {
    if (error instanceof SipEffectError &&
        error.code === 'sip_effect_validation_failed') {
      schemaIncompatible('invalid_effect_contract');
    }
    throw error;
  }
}

function samePreparedEffect(
  left: ProtocolEffectRecord,
  right: ProtocolEffectRecord
): boolean {
  try {
    assertSameProtocolEffectIdentity(left, right);
  } catch {
    return false;
  }
  return left.schema_id === right.schema_id &&
    left.schema_version === right.schema_version &&
    left.schema_hash === right.schema_hash &&
    left.route_binding_hash === right.route_binding_hash &&
    (!left.payload_retained ||
      Buffer.from(left.canonical_wire_bytes)
        .equals(Buffer.from(right.canonical_wire_bytes)));
}

function assertReplaySchema(
  row: Readonly<Record<string, unknown>>,
  expectedWriterIdentity: string,
  effect: Pick<ProtocolEffectRecord, 'schema_id' | 'schema_version' | 'schema_hash'>
): void {
  const schemaVersion = integer(row.schema_version);
  if (!isSupportedSipEffectSchema({
        schema_id: row.schema_id,
        schema_version: schemaVersion,
        schema_hash: row.schema_hash
      }) ||
      row.schema_id !== effect.schema_id ||
      schemaVersion !== effect.schema_version ||
      row.schema_hash !== effect.schema_hash ||
      row.writer_identity !== expectedWriterIdentity) {
    schemaIncompatible('invalid_schema_identity');
  }
}

function parsedFoundationJson(value: unknown, field: string): unknown {
  let parsed = value;
  if (typeof value === 'string') {
    if (value.length > 131_072) {
      schemaIncompatible(`invalid_${field}_json`);
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      schemaIncompatible(`invalid_${field}_json`);
    }
  }
  return parsed;
}

function adapterIdentity(value: unknown): BackendRuntimeIdentity {
  try {
    return validateBackendRuntimeIdentity(
      parsedFoundationJson(value, 'adapter_identity')
    );
  } catch {
    return schemaIncompatible('invalid_adapter_identity');
  }
}

function routeBinding(value: unknown): BoundSipRouteBinding {
  try {
    return bindSipRoute(
      parsedFoundationJson(value, 'route_binding') as BoundSipRouteBinding
    );
  } catch {
    return schemaIncompatible('invalid_route_binding');
  }
}

function wireAttemptFacts(
  value: unknown,
  effectId: string
): BoundSipWireAttemptFacts {
  try {
    return validateBoundSipWireAttemptFacts(
      parsedFoundationJson(
        value,
        'wire_attempt_facts'
      ) as BoundSipWireAttemptFacts,
      effectId
    );
  } catch {
    return schemaIncompatible('invalid_wire_attempt_facts');
  }
}

function effectColumns(prefix: string): string {
  return `
    ${prefix}protocol_effect_id, ${prefix}tenant_id,
    ${prefix}protocol_session_id, ${prefix}protocol_session_generation,
    ${prefix}decision_id, ${prefix}idempotency_key, ${prefix}request_hash,
    ${prefix}command_id, ${prefix}adapter_identity,
    ${prefix}adapter_identity_hash, ${prefix}wire_bytes_hash,
    ${prefix}wire_length_bytes, ${prefix}canonical_wire_bytes,
    ${prefix}route_binding, ${prefix}route_binding_hash,
    ${prefix}wire_attempt_facts, ${prefix}wire_attempt_facts_hash,
    ${prefix}wire_freeze_sha256, ${prefix}effect_identity_hash,
    ${prefix}owner_epoch::text AS owner_epoch,
    ${prefix}command_sequence::text AS command_sequence,
    ${prefix}schema_id, ${prefix}schema_version, ${prefix}schema_hash,
    ${prefix}writer_identity, ${prefix}state,
    ${prefix}revision::text AS revision, ${prefix}unknown_count,
    ${prefix}last_receipt_id, ${prefix}last_receipt_hash,
    ${prefix}last_receipt_repair_delay_ms, ${prefix}failure_code,
    ${prefix}repair_due_at, ${prefix}repair_owner_id,
    ${prefix}repair_owner_epoch::text AS repair_owner_epoch,
    ${prefix}repair_epoch_high_watermark::text AS repair_epoch_high_watermark,
    ${prefix}repair_claim_token,
    ${prefix}repair_claim_revision::text AS repair_claim_revision,
    ${prefix}repair_lease_until, ${prefix}repair_attempts,
    ${prefix}repair_exhausted_at, ${prefix}repair_exhaustion_receipt_hash,
    ${prefix}operator_attention_required, ${prefix}repair_compacted_at,
    ${prefix}retention_reference_count, ${prefix}rollback_reference_count,
    ${prefix}audit_until, ${prefix}payload_retained,
    ${prefix}terminal_tombstone_id, ${prefix}terminal_tombstone_hash,
    ${prefix}terminal_at, ${prefix}prepared_at, ${prefix}updated_at`;
}

class StoreAdmissionGate {
  readonly #maxInFlight: number;
  readonly #maxQueueDepth: number;
  readonly #waitTimeoutMs: number;
  readonly #metrics?: SipEffectMetricBook;
  #inFlight = 0;
  #head: AdmissionWaiter | null = null;
  #tail: AdmissionWaiter | null = null;
  #queueDepth = 0;

  constructor(input: {
    max_in_flight: number;
    max_queue_depth: number;
    wait_timeout_ms: number;
    metrics?: SipEffectMetricBook;
  }) {
    this.#maxInFlight = input.max_in_flight;
    this.#maxQueueDepth = input.max_queue_depth;
    this.#waitTimeoutMs = input.wait_timeout_ms;
    this.#metrics = input.metrics;
  }

  acquire(): Promise<StoreAdmissionLease> {
    const deadlineMs = performance.now() + this.#waitTimeoutMs;
    if (this.#inFlight < this.#maxInFlight) {
      this.#inFlight += 1;
      return Promise.resolve(new StoreAdmissionLease(
        this.#release,
        this.#waitTimeoutMs,
        0,
        deadlineMs
      ));
    }
    if (this.#queueDepth >= this.#maxQueueDepth) {
      return Promise.reject(poolExhausted(0, this.#queueDepth));
    }
    return new Promise<StoreAdmissionLease>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        previous: this.#tail,
        next: null,
        resolve,
        reject,
        timer: undefined,
        active: true,
        queue_depth: 0,
        deadline_ms: deadlineMs
      };
      if (this.#tail) this.#tail.next = waiter;
      else this.#head = waiter;
      this.#tail = waiter;
      this.#queueDepth += 1;
      waiter.queue_depth = this.#queueDepth;
      this.#metrics?.setQueueDepth(this.#queueDepth);
      waiter.timer = setTimeout(() => {
        if (!waiter.active) return;
        this.#unlink(waiter);
        reject(poolExhausted(this.#waitTimeoutMs, waiter.queue_depth));
      }, this.#waitTimeoutMs);
    });
  }

  readonly #release = (): void => {
    const waiter = this.#head;
    if (!waiter) {
      this.#inFlight -= 1;
      return;
    }
    this.#unlink(waiter);
    waiter.resolve(new StoreAdmissionLease(
      this.#release,
      this.#waitTimeoutMs,
      waiter.queue_depth,
      waiter.deadline_ms
    ));
  };

  #unlink(waiter: AdmissionWaiter): void {
    if (!waiter.active) return;
    waiter.active = false;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.previous) waiter.previous.next = waiter.next;
    else this.#head = waiter.next;
    if (waiter.next) waiter.next.previous = waiter.previous;
    else this.#tail = waiter.previous;
    this.#queueDepth -= 1;
    this.#metrics?.setQueueDepth(this.#queueDepth);
  }
}

interface AdmissionWaiter {
  previous: AdmissionWaiter | null;
  next: AdmissionWaiter | null;
  resolve: (lease: StoreAdmissionLease) => void;
  reject: (error: SipEffectError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  active: boolean;
  queue_depth: number;
  deadline_ms: number;
}

class StoreAdmissionLease {
  #references = 1;

  constructor(
    private readonly releasePermit: () => void,
    readonly pool_wait_ms: number,
    readonly queue_depth: number,
    private readonly deadlineMs: number
  ) {}

  retain(): void {
    this.#references += 1;
  }

  remainingPoolWaitMs(): number {
    return Math.max(0, this.deadlineMs - performance.now());
  }

  release(): void {
    if (this.#references === 0) return;
    this.#references -= 1;
    if (this.#references === 0) this.releasePermit();
  }
}

interface ReleasableEffectClient extends PgQueryable {
  release(): void;
}

interface ConnectableEffectPool extends PgQueryable {
  connect(): Promise<ReleasableEffectClient>;
}

type CapturedDataMethod = (...args: unknown[]) => unknown;

class PoolAcquisitionDeadline implements PgQueryable {
  constructor(
    private readonly pool: ConnectableEffectPool,
    private readonly admission: StoreAdmissionLease
  ) {}

  query<R extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ) {
    return this.pool.query<R>(text, params);
  }

  connect(): Promise<ReleasableEffectClient> {
    return acquireEffectPoolClient(this.pool, this.admission);
  }
}

function acquireEffectPoolClient(
  pool: ConnectableEffectPool,
  admission: StoreAdmissionLease
): Promise<ReleasableEffectClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const remainingWaitMs = admission.remainingPoolWaitMs();
    if (remainingWaitMs <= 0) {
      reject(poolExhausted(
        admission.pool_wait_ms,
        admission.queue_depth
      ));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      admission.retain();
      settled = true;
      reject(poolExhausted(
        admission.pool_wait_ms,
        admission.queue_depth
      ));
    }, remainingWaitMs);

    let connection: Promise<ReleasableEffectClient>;
    try {
      connection = Promise.resolve(pool.connect());
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
      return;
    }
    connection.then(
      (client) => {
        if (settled) {
          releaseEffectPoolClient(client, admission);
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          resolve(ownedEffectPoolClient(client, admission));
        } catch (error) {
          reject(error);
        }
      },
      (error: unknown) => {
        if (settled) {
          admission.release();
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function ownedEffectPoolClient(
  client: unknown,
  admission: StoreAdmissionLease
): ReleasableEffectClient {
  admission.retain();
  const query = dataMethod(client, 'query');
  const release = dataMethod(client, 'release');
  if (!query || !release) {
    if (release) releaseEffectPoolClient(client, admission, release);
    schemaIncompatible('invalid_effect_pool_client');
  }
  return new OwnedEffectPoolClient(
    client,
    query,
    release,
    admission
  );
}

class OwnedEffectPoolClient implements ReleasableEffectClient {
  #releaseAttempted = false;

  constructor(
    private readonly client: unknown,
    private readonly queryMethod: CapturedDataMethod,
    private readonly releaseMethod: CapturedDataMethod,
    private readonly admission: StoreAdmissionLease
  ) {}

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<QueryResult<R>> {
    try {
      return Promise.resolve(Reflect.apply(
        this.queryMethod,
        this.client,
        [text, params]
      )) as Promise<QueryResult<R>>;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  release(): void {
    if (this.#releaseAttempted) return;
    this.#releaseAttempted = true;
    releaseEffectPoolClient(
      this.client,
      this.admission,
      this.releaseMethod
    );
  }
}

function releaseEffectPoolClient(
  client: unknown,
  admission: StoreAdmissionLease,
  capturedRelease = dataMethod(client, 'release')
): void {
  if (!capturedRelease) return;
  try {
    Promise.resolve(Reflect.apply(capturedRelease, client, [])).then(
      () => admission.release(),
      () => {}
    );
  } catch {
    // Keep the admission reference when physical ownership is uncertain.
  }
}

function poolExhausted(
  poolWaitMs: number,
  queueDepth: number
): SipEffectError {
  return evidenceStoreFailure(new SipEffectError({
    code: 'store_pool_exhausted',
    status: 503,
    retryable: true,
    details: {
      pool_wait_ms: poolWaitMs,
      queue_depth: queueDepth,
      retry_attempt: 0
    }
  }), {
    pool_wait_ms: poolWaitMs,
    queue_depth: queueDepth,
    retry_attempt: 0
  });
}

function checkedStoreOptions(
  options: PostgresEffectStoreOptions
): PostgresEffectStoreOptions {
  return snapshotOptionalInputRecord(
    options,
    [],
    [
      'writer_identity',
      'max_in_flight',
      'max_queue_depth',
      'pool_wait_timeout_ms',
      'metrics'
    ],
    'store_options'
  ) as PostgresEffectStoreOptions;
}

function snapshotInputRecord(
  value: unknown,
  keys: readonly string[],
  field: string
): Readonly<Record<string, unknown>> {
  return snapshotClosedRecord(value, keys, () => validationError(field));
}

function snapshotOptionalInputRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  field: string
): Readonly<Record<string, unknown>> {
  return snapshotClosedShape(
    value,
    required,
    optional,
    () => validationError(field)
  );
}

function snapshotSchemaRecord(
  value: unknown,
  keys: readonly string[],
  reason: string
): Readonly<Record<string, unknown>> {
  return snapshotClosedRecord(value, keys, () => schemaError(reason));
}

function queryRows(
  result: unknown,
  maximum: number,
  reason: string
): readonly EffectRow[] {
  const source = snapshotClosedArray(
    snapshotPgResultRows(result, reason),
    maximum,
    () => schemaError(reason)
  );
  const rows: EffectRow[] = [];
  for (let index = 0; index < source.length; index += 1) {
    rows.push(source[index] as EffectRow);
  }
  return rows;
}

function snapshotPgResultRows(result: unknown, reason: string): unknown {
  if (!result || typeof result !== 'object' || utilTypes.isProxy(result) ||
      Array.isArray(result)) {
    schemaIncompatible(reason);
  }
  try {
    const keys = Reflect.ownKeys(result);
    if (keys.length > 16 ||
        keys.some((key) => typeof key !== 'string')) {
      schemaIncompatible(reason);
    }
    let rows: unknown;
    let rowsPresent = false;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(result, key);
      if (!descriptor || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')) {
        schemaIncompatible(reason);
      }
      if (key === 'rows') {
        rows = descriptor.value;
        rowsPresent = true;
      }
    }
    if (!rowsPresent) schemaIncompatible(reason);
    return rows;
  } catch (error) {
    if (error instanceof SipEffectError) throw error;
    schemaIncompatible(reason);
  }
}

function bytes(value: unknown): Uint8Array {
  if (utilTypes.isUint8Array(value)) {
    return snapshotClosedBytes(
      value,
      0,
      65_535,
      () => schemaError('invalid_canonical_wire_bytes')
    );
  }
  if (typeof value === 'string' &&
      value.length <= 131_072 &&
      /^\\x(?:[a-fA-F0-9]{2})*$/.test(value)) {
    return Buffer.from(value.slice(2), 'hex');
  }
  schemaIncompatible('invalid_canonical_wire_bytes');
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) schemaIncompatible('invalid_text');
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : text(value);
}

function databaseHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    schemaIncompatible(`invalid_${field}`);
  }
  return value;
}

function nullableDatabaseHash(value: unknown, field: string): string | null {
  return value === null || value === undefined || value === ''
    ? null
    : databaseHash(value, field);
}

function databaseU64(
  value: unknown,
  field: string,
  positive: boolean
): string {
  if (typeof value !== 'string') schemaIncompatible(`invalid_${field}`);
  try {
    return uint64Decimal(value, field, positive);
  } catch {
    schemaIncompatible(`invalid_${field}`);
  }
}

function nullableDatabaseU64(
  value: unknown,
  field: string,
  positive: boolean
): string | null {
  return value === null || value === undefined
    ? null
    : databaseU64(value, field, positive);
}

function integer(value: unknown): number {
  const output = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(output) || output < 0) {
    schemaIncompatible('invalid_integer');
  }
  return output;
}

function boolean(value: unknown): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  schemaIncompatible('invalid_boolean');
}

function timestamp(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length > 64) schemaIncompatible('invalid_timestamp');
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      schemaIncompatible('invalid_timestamp');
    }
    return date.toISOString();
  }
  if (utilTypes.isProxy(value) || !(value instanceof Date)) {
    schemaIncompatible('invalid_timestamp');
  }
  try {
    if (Object.getPrototypeOf(value) !== Date.prototype ||
        Reflect.ownKeys(value).length !== 0) {
      schemaIncompatible('invalid_timestamp');
    }
    const time = Date.prototype.getTime.call(value);
    if (!Number.isFinite(time)) schemaIncompatible('invalid_timestamp');
    return new Date(time).toISOString();
  } catch (error) {
    if (error instanceof SipEffectError) throw error;
    schemaIncompatible('invalid_timestamp');
  }
}

function inputTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 64) validation(field);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    validation(field);
  }
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined || value === ''
    ? null
    : timestamp(value);
}

function checkedIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(value)) {
    validation(field);
  }
  return value;
}

function checkedAsciiToken(
  value: unknown,
  field: string,
  maximum: number
): string {
  if (typeof value !== 'string' ||
      value.length < 1 ||
      value.length > maximum ||
      !/^[\x21-\x7e]+$/.test(value)) {
    validation(field);
  }
  return value;
}

function nextU64(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > 18_446_744_073_709_551_615n) {
    unavailable('revision_exhausted');
  }
  return next.toString();
}

function checkedHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    schemaIncompatible(`invalid_${field}`);
  }
  return value;
}

function checkedInputHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    validation(field);
  }
  return value;
}

function checkedFailureCode(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 ||
      /[\u0000\r\n]/.test(value)) {
    validation('failure_code');
  }
  return value;
}

function checkedBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) ||
      (value as number) < minimum ||
      (value as number) > maximum) {
    validation(field);
  }
  return value as number;
}

function validation(field: string): never {
  throw validationError(field);
}

function validationError(field: string): SipEffectError {
  return new SipEffectError({
    code: 'sip_effect_validation_failed',
    status: 422,
    details: { field }
  });
}

function idempotencyConflict(): never {
  throw new SipEffectError({
    code: 'sip_effect_idempotency_conflict',
    status: 409
  });
}

function receiptConflict(): never {
  throw new SipEffectError({
    code: 'sip_effect_receipt_conflict',
    status: 409
  });
}

function transitionConflict(): never {
  throw new SipEffectError({
    code: 'sip_effect_transition_conflict',
    status: 409
  });
}

function fenceLost(): never {
  throw new SipEffectError({
    code: 'sip_effect_fence_lost',
    status: 409
  });
}

function notFound(): never {
  throw new SipEffectError({ code: 'sip_effect_not_found', status: 404 });
}

function unavailable(reason: string): never {
  throw evidenceStoreFailure(new SipEffectError({
    code: 'store_unavailable',
    status: 503,
    retryable: true,
    details: { reason }
  }));
}

function schemaIncompatible(reason: string): never {
  throw schemaError(reason);
}

function schemaError(reason: string): SipEffectError {
  return evidenceStoreFailure(new SipEffectError({
    code: 'store_schema_incompatible',
    status: 503,
    retryable: true,
    details: { reason }
  }));
}

function mapPostgresError(error: unknown): SipEffectError {
  const code = ownStringData(error, 'code', 32);
  const message = ownStringData(error, 'message', 1_024);
  let failureCode: StoreFailureCode;
  if (code === '57014' || code === '55P03') {
    failureCode = 'store_timeout';
  } else if (code === '53300' || code === '53400' ||
             /pool|connection queue/i.test(message)) {
    failureCode = 'store_pool_exhausted';
  } else if (['42P01', '42703', '42883', '3F000', '55000'].includes(code) ||
             /schema|incompatible SIP effect writer|relation .* does not exist|column .* does not exist/i.test(message)) {
    failureCode = 'store_schema_incompatible';
  } else {
    failureCode = 'store_unavailable';
  }
  return evidenceStoreFailure(new SipEffectError({
    code: failureCode,
    status: 503,
    retryable: true,
    cause: error
  }));
}

function evidenceStoreFailure(
  error: SipEffectError,
  retryAfterFacts: PostgresStoreFailureEvidence['retry_after_facts'] = null
): SipEffectError {
  STORE_FAILURE_EVIDENCE.set(error, Object.freeze({
    failure_code: error.code as StoreFailureCode,
    retry_after_facts: retryAfterFacts === null
      ? null
      : Object.freeze({ ...retryAfterFacts })
  }));
  return error;
}

function ownStringData(
  value: unknown,
  key: string,
  maximum: number
): string {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) {
    return '';
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string' &&
      descriptor.value.length <= maximum
      ? descriptor.value
      : '';
  } catch {
    return '';
  }
}

function hasDataMethod(value: unknown, key: string): boolean {
  return dataMethod(value, key) !== null;
}

function dataMethod(
  value: unknown,
  key: string
): CapturedDataMethod | null {
  if ((!value || (typeof value !== 'object' && typeof value !== 'function')) ||
      utilTypes.isProxy(value)) {
    return null;
  }
  let current: object | null = value;
  const visited = new Set<object>();
  for (let depth = 0; current && depth < 16; depth += 1) {
    if (utilTypes.isProxy(current) || visited.has(current)) return null;
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return !descriptor.get && !descriptor.set &&
        typeof descriptor.value === 'function'
        ? descriptor.value as CapturedDataMethod
        : null;
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

const EFFECT_STATES = new Set<ProtocolEffectState>([
  'prepared',
  'durable_decision',
  'send_attempted',
  'transport_accepted',
  'transport_completed',
  'protocol_observed',
  'failed',
  'unknown'
]);
const EFFECT_RECEIPT_LEVELS = new Set([
  'durable_decision',
  'send_attempted',
  'transport_accepted',
  'transport_completed',
  'protocol_observed',
  'failed',
  'unknown'
]);
