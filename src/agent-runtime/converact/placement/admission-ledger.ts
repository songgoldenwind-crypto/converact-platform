import { splitOwnerEpoch } from './owner-epoch.js';
import type {
  CellAdmissionReservationCheckpoint
} from './admission.js';
import {
  type PlacementPgQueryable,
  withPlacementPgTenant
} from './pg-queryable.js';
import type { InteractionKind, ReservationState } from './types.js';

const MAX_RECOVERY_ROWS = 250_000;

export interface CellAdmissionLeader {
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_instance_id: string;
  cell_lease_epoch: number;
}

export class PostgresCellAdmissionLedger {
  constructor(private readonly pg: PlacementPgQueryable) {}

  async load(input: {
    leader: CellAdmissionLeader;
    terminal_retention_ms: number;
    now: string;
    limit?: number;
  }): Promise<CellAdmissionReservationCheckpoint[]> {
    validateLeader(input.leader);
    validTimestamp(input.now);
    const retentionMs = boundedInteger(
      input.terminal_retention_ms,
      1_000,
      86_400_000,
      'terminal retention'
    );
    const limit = boundedInteger(
      input.limit ?? MAX_RECOVERY_ROWS,
      1,
      MAX_RECOVERY_ROWS,
      'recovery limit'
    );
    const result = await this.pg.query<Record<string, unknown>>(
      `SELECT *
       FROM opc_ivekit_cell_admission_recovery_rows(
         $1, $2, $3, $4, $5::bigint, $6::timestamptz, $7::bigint, $8::integer
       )`,
      [
        input.leader.region_id,
        input.leader.zone_id,
        input.leader.cell_id,
        input.leader.owner_instance_id,
        input.leader.cell_lease_epoch,
        input.now,
        retentionMs,
        limit
      ]
    );
    if (result.rows.length >= limit) {
      throw new CellAdmissionLedgerError('admission_recovery_limit_exceeded', 503);
    }
    return result.rows.map(decodeCheckpoint);
  }

  async persist(input: {
    checkpoint: CellAdmissionReservationCheckpoint;
    leader: CellAdmissionLeader;
    now: string;
  }): Promise<CellAdmissionReservationCheckpoint> {
    validateLeader(input.leader);
    validTimestamp(input.now);
    const checkpoint = validateCheckpoint(input.checkpoint);
    if (checkpoint.region_id !== input.leader.region_id ||
        checkpoint.zone_id !== input.leader.zone_id ||
        checkpoint.cell_id !== input.leader.cell_id) {
      throw new CellAdmissionLedgerError('admission_target_mismatch', 409);
    }
    const owner = splitOwnerEpoch(checkpoint.owner_epoch);
    if (owner.cell_lease_epoch > input.leader.cell_lease_epoch) {
      throw new CellAdmissionLedgerError('future_owner_epoch', 409);
    }
    return withPlacementPgTenant(
      this.pg,
      checkpoint.tenant_id,
      async (pg) => {
        const result = await pg.query<Record<string, unknown>>(
          `WITH active_lease AS (
         SELECT 1
         FROM ivekit_cell_leases
         WHERE region_id = $1 AND zone_id = $2 AND cell_id = $3
           AND owner_instance_id = $4
           AND lease_epoch = $5::bigint
           AND state = 'active'
           AND lease_expires_at > $6::timestamptz
       ),
       stored AS (
         INSERT INTO ivekit_cell_admission_reservations
           (region_id, zone_id, cell_id, reservation_id, tenant_id,
            routing_partition_id, interaction_id, interaction_kind, profile_id,
            owner_node_id, owner_epoch, cell_lease_epoch, endpoint,
            required_capacity, idempotency_key, payload_hash, state,
            expires_at, created_at, updated_at)
         SELECT
           $1, $2, $3, $7, $8, $9, $10, $11, $12, $13,
           $14::numeric, $15::bigint, $16, $17::jsonb, $18, $19, $20,
           $21::timestamptz, $22::timestamptz, $23::timestamptz
         FROM active_lease
         ON CONFLICT (region_id, zone_id, cell_id, reservation_id) DO UPDATE
         SET owner_epoch = EXCLUDED.owner_epoch,
             cell_lease_epoch = EXCLUDED.cell_lease_epoch,
             state = CASE
               WHEN ivekit_cell_admission_reservations.state = 'closed' THEN 'closed'
               WHEN EXCLUDED.state = 'closed' THEN 'closed'
               WHEN ivekit_cell_admission_reservations.state = 'expired' THEN 'expired'
               WHEN EXCLUDED.state = 'expired' THEN 'expired'
               WHEN ivekit_cell_admission_reservations.state = 'active' THEN 'active'
               ELSE EXCLUDED.state
             END,
             updated_at = GREATEST(
               ivekit_cell_admission_reservations.updated_at,
               EXCLUDED.updated_at
             )
         WHERE ivekit_cell_admission_reservations.tenant_id = EXCLUDED.tenant_id
           AND ivekit_cell_admission_reservations.interaction_id = EXCLUDED.interaction_id
           AND ivekit_cell_admission_reservations.interaction_kind = EXCLUDED.interaction_kind
           AND ivekit_cell_admission_reservations.owner_node_id = EXCLUDED.owner_node_id
           AND ivekit_cell_admission_reservations.idempotency_key = EXCLUDED.idempotency_key
           AND ivekit_cell_admission_reservations.payload_hash = EXCLUDED.payload_hash
           AND (
             (
               ivekit_cell_admission_reservations.owner_epoch = EXCLUDED.owner_epoch
               AND (
                 ivekit_cell_admission_reservations.state = EXCLUDED.state
                 OR EXCLUDED.cell_lease_epoch = $5::bigint
               )
             )
             OR (
               ivekit_cell_admission_reservations.state = 'active'
               AND EXCLUDED.state = 'active'
               AND ivekit_cell_admission_reservations.owner_epoch < EXCLUDED.owner_epoch
               AND EXCLUDED.cell_lease_epoch = $5::bigint
             )
             OR EXCLUDED.state = 'closed'
             OR (
               ivekit_cell_admission_reservations.state IN ('reserved', 'expired')
               AND EXCLUDED.state = 'expired'
             )
           )
         RETURNING *
       )
       SELECT reservation_id, state, region_id, zone_id, cell_id,
         owner_node_id, owner_epoch::text AS owner_epoch, endpoint,
         expires_at, required_capacity, tenant_id, routing_partition_id,
         interaction_id, interaction_kind, profile_id, idempotency_key,
         payload_hash, created_at, updated_at
       FROM stored`,
        [
          input.leader.region_id,
          input.leader.zone_id,
          input.leader.cell_id,
          input.leader.owner_instance_id,
          input.leader.cell_lease_epoch,
          input.now,
          checkpoint.reservation_id,
          checkpoint.tenant_id,
          checkpoint.routing_partition_id,
          checkpoint.interaction_id,
          checkpoint.interaction_kind,
          checkpoint.profile_id,
          checkpoint.owner_node_id,
          checkpoint.owner_epoch,
          owner.cell_lease_epoch,
          checkpoint.endpoint,
          JSON.stringify(checkpoint.required_capacity),
          checkpoint.idempotency_key,
          checkpoint.payload_hash,
          checkpoint.state,
          checkpoint.expires_at,
          checkpoint.created_at,
          checkpoint.updated_at
          ]
        );
        const row = result.rows[0];
        if (!row) {
          throw new CellAdmissionLedgerError('stale_cell_lease', 409, true);
        }
        return decodeCheckpoint(row);
      }
    );
  }

  async expireDue(input: {
    leader: CellAdmissionLeader;
    now: string;
  }): Promise<number> {
    validateLeader(input.leader);
    validTimestamp(input.now);
    const result = await this.pg.query<Record<string, unknown>>(
      `SELECT opc_ivekit_expire_cell_admission_reservations(
         $1, $2, $3, $4, $5::bigint, $6::timestamptz
       )::text AS expired_count`,
      [
        input.leader.region_id,
        input.leader.zone_id,
        input.leader.cell_id,
        input.leader.owner_instance_id,
        input.leader.cell_lease_epoch,
        input.now
      ]
    );
    return Number(result.rows[0]?.expired_count || 0);
  }
}

export class CellAdmissionLedgerError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false
  ) {
    super(code);
    this.name = 'CellAdmissionLedgerError';
  }
}

function decodeCheckpoint(
  row: Record<string, unknown>
): CellAdmissionReservationCheckpoint {
  const checkpoint: CellAdmissionReservationCheckpoint = {
    reservation_id: String(row.reservation_id),
    state: String(row.state) as ReservationState,
    region_id: String(row.region_id),
    zone_id: String(row.zone_id),
    cell_id: String(row.cell_id),
    owner_node_id: String(row.owner_node_id),
    owner_epoch: String(row.owner_epoch),
    endpoint: String(row.endpoint),
    expires_at: timestamp(row.expires_at),
    required_capacity: capacity(row.required_capacity),
    tenant_id: String(row.tenant_id),
    routing_partition_id: String(row.routing_partition_id),
    interaction_id: String(row.interaction_id),
    interaction_kind: String(row.interaction_kind) as InteractionKind,
    profile_id: String(row.profile_id),
    idempotency_key: String(row.idempotency_key),
    payload_hash: String(row.payload_hash),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
  return validateCheckpoint(checkpoint);
}

function validateCheckpoint(
  checkpoint: CellAdmissionReservationCheckpoint
): CellAdmissionReservationCheckpoint {
  for (const value of [
    checkpoint.reservation_id,
    checkpoint.region_id,
    checkpoint.zone_id,
    checkpoint.cell_id,
    checkpoint.owner_node_id,
    checkpoint.tenant_id,
    checkpoint.routing_partition_id,
    checkpoint.interaction_id,
    checkpoint.idempotency_key
  ]) safeId(value);
  if (!['reserved', 'active', 'expired', 'closed'].includes(checkpoint.state)) {
    throw new CellAdmissionLedgerError('invalid_admission_reservation_state', 500);
  }
  if (!['tinode_im', 'sip_voice', 'livekit_av', 'livekit_screen', 'rustdesk_remote']
    .includes(checkpoint.interaction_kind)) {
    throw new CellAdmissionLedgerError('invalid_admission_interaction_kind', 500);
  }
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(checkpoint.profile_id) ||
      !/^[a-f0-9]{64}$/.test(checkpoint.payload_hash) ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(checkpoint.owner_epoch)) {
    throw new CellAdmissionLedgerError('invalid_admission_reservation', 500);
  }
  checkedUrl(checkpoint.endpoint);
  validTimestamp(checkpoint.expires_at);
  validTimestamp(checkpoint.created_at);
  validTimestamp(checkpoint.updated_at);
  capacity(checkpoint.required_capacity);
  return structuredClone(checkpoint);
}

function validateLeader(leader: CellAdmissionLeader): void {
  validateCellIdentity(leader);
  safeId(leader.owner_instance_id);
  if (!Number.isInteger(leader.cell_lease_epoch) ||
      leader.cell_lease_epoch < 1 || leader.cell_lease_epoch > 0xffff_ffff) {
    throw new CellAdmissionLedgerError('invalid_cell_lease_epoch', 400);
  }
}

function validateCellIdentity(input: {
  region_id: string;
  zone_id: string;
  cell_id: string;
}): void {
  safeId(input.region_id);
  safeId(input.zone_id);
  safeId(input.cell_id);
}

function capacity(value: unknown): Record<string, number> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CellAdmissionLedgerError('invalid_admission_capacity', 500);
  }
  const result: Record<string, number> = {};
  for (const [name, amount] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_.]{2,127}$/.test(name) ||
        !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new CellAdmissionLedgerError('invalid_admission_capacity', 500);
    }
    result[name] = Number(amount);
  }
  if (Object.keys(result).length === 0) {
    throw new CellAdmissionLedgerError('invalid_admission_capacity', 500);
  }
  return result;
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new CellAdmissionLedgerError('invalid_admission_timestamp', 500);
  }
  return date.toISOString();
}

function validTimestamp(value: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new CellAdmissionLedgerError('invalid_admission_timestamp', 400);
  }
}

function safeId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/.test(String(value || ''))) {
    throw new CellAdmissionLedgerError('invalid_admission_identifier', 400);
  }
}

function checkedUrl(value: string): void {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CellAdmissionLedgerError('invalid_admission_endpoint', 500);
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CellAdmissionLedgerError(`invalid_${field.replaceAll(' ', '_')}`, 400);
  }
  return value;
}
