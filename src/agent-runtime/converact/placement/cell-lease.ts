import type { PlacementPgQueryable } from './pg-queryable.js';

export interface CellLease {
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_instance_id: string;
  lease_epoch: number;
  topology_sha256: string;
  lease_expires_at: string;
}

export interface CellLeaseClaimInput {
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_instance_id: string;
  topology_sha256: string;
  lease_ttl_ms: number;
  now: string;
}

export interface CellLeaseRenewInput extends CellLeaseClaimInput {
  lease_epoch: number;
}

export interface CellLeaseRepository {
  claim(input: CellLeaseClaimInput): Promise<CellLease>;
  renew(input: CellLeaseRenewInput): Promise<CellLease>;
  release(input: {
    region_id: string;
    zone_id: string;
    cell_id: string;
    owner_instance_id: string;
    lease_epoch: number;
    topology_sha256: string;
    now: string;
  }): Promise<void>;
}

export class PostgresCellLeaseRepository implements CellLeaseRepository {
  readonly #pg: PlacementPgQueryable;

  constructor(pg: PlacementPgQueryable) {
    this.#pg = pg;
  }

  async claim(input: CellLeaseClaimInput): Promise<CellLease> {
    validateClaim(input);
    const result = await this.#pg.query<Record<string, unknown>>(
      `INSERT INTO ivekit_cell_leases
         (region_id, zone_id, cell_id, owner_instance_id, lease_epoch,
          topology_sha256, state,
          lease_expires_at, heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, 'active', $6::timestamptz,
         $7::timestamptz, $7::timestamptz, $7::timestamptz)
       ON CONFLICT (region_id, zone_id, cell_id) DO UPDATE
       SET owner_instance_id = EXCLUDED.owner_instance_id,
           lease_epoch = CASE
             WHEN ivekit_cell_leases.owner_instance_id = EXCLUDED.owner_instance_id
               AND ivekit_cell_leases.state = 'active'
               AND ivekit_cell_leases.lease_expires_at > $7::timestamptz
               AND ivekit_cell_leases.topology_sha256 =
                 EXCLUDED.topology_sha256
             THEN ivekit_cell_leases.lease_epoch
             ELSE ivekit_cell_leases.lease_epoch + 1
           END,
           topology_sha256 = EXCLUDED.topology_sha256,
           state = 'active',
           lease_expires_at = EXCLUDED.lease_expires_at,
           heartbeat_at = EXCLUDED.heartbeat_at,
           updated_at = EXCLUDED.updated_at
       WHERE (
              ivekit_cell_leases.owner_instance_id =
                EXCLUDED.owner_instance_id
              AND ivekit_cell_leases.state = 'active'
              AND ivekit_cell_leases.lease_expires_at > $7::timestamptz
              AND ivekit_cell_leases.topology_sha256 =
                EXCLUDED.topology_sha256
             )
          OR ivekit_cell_leases.state = 'released'
          OR ivekit_cell_leases.lease_expires_at <= $7::timestamptz
       RETURNING region_id, zone_id, cell_id, owner_instance_id,
         lease_epoch::text AS lease_epoch, topology_sha256,
         lease_expires_at`,
      [
        input.region_id,
        input.zone_id,
        input.cell_id,
        input.owner_instance_id,
        input.topology_sha256,
        expiresAt(input.now, input.lease_ttl_ms),
        input.now
      ]
    );
    if (!result.rows[0]) {
      throw new CellLeaseError('cell_lease_unavailable', 409, true);
    }
    return decodeLease(result.rows[0]);
  }

  async renew(input: CellLeaseRenewInput): Promise<CellLease> {
    validateClaim(input);
    validEpoch(input.lease_epoch);
    const result = await this.#pg.query<Record<string, unknown>>(
      `UPDATE ivekit_cell_leases
       SET lease_expires_at = $7::timestamptz,
           heartbeat_at = $8::timestamptz,
           updated_at = $8::timestamptz
       WHERE region_id = $1 AND zone_id = $2 AND cell_id = $3
         AND owner_instance_id = $4 AND lease_epoch = $5::bigint
         AND topology_sha256 = $6
         AND state = 'active' AND lease_expires_at > $8::timestamptz
       RETURNING region_id, zone_id, cell_id, owner_instance_id,
         lease_epoch::text AS lease_epoch, topology_sha256,
         lease_expires_at`,
      [
        input.region_id,
        input.zone_id,
        input.cell_id,
        input.owner_instance_id,
        input.lease_epoch,
        input.topology_sha256,
        expiresAt(input.now, input.lease_ttl_ms),
        input.now
      ]
    );
    if (!result.rows[0]) throw new CellLeaseError('stale_cell_lease', 409);
    return decodeLease(result.rows[0]);
  }

  async release(input: {
    region_id: string;
    zone_id: string;
    cell_id: string;
    owner_instance_id: string;
    lease_epoch: number;
    topology_sha256: string;
    now: string;
  }): Promise<void> {
    for (const value of [
      input.region_id,
      input.zone_id,
      input.cell_id,
      input.owner_instance_id
    ]) safeId(value);
    validEpoch(input.lease_epoch);
    validTopologySha256(input.topology_sha256);
    validTimestamp(input.now);
    const result = await this.#pg.query(
      `UPDATE ivekit_cell_leases
       SET state = 'released', lease_expires_at = $7::timestamptz,
           heartbeat_at = $7::timestamptz, updated_at = $7::timestamptz
       WHERE region_id = $1 AND zone_id = $2 AND cell_id = $3
         AND owner_instance_id = $4 AND lease_epoch = $5::bigint
         AND topology_sha256 = $6
         AND state = 'active'
       RETURNING cell_id`,
      [
        input.region_id,
        input.zone_id,
        input.cell_id,
        input.owner_instance_id,
        input.lease_epoch,
        input.topology_sha256,
        input.now
      ]
    );
    if (!result.rows[0]) throw new CellLeaseError('stale_cell_lease', 409);
  }
}

export async function startCellLeaseMaintainer(input: {
  repository: CellLeaseRepository;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_instance_id: string;
  topology_sha256: string;
  lease_ttl_ms: number;
  renewal_interval_ms?: number;
  claim_retry_interval_ms?: number;
  signal?: AbortSignal;
  now?: () => string;
  on_waiting?: (error: unknown) => void | Promise<void>;
  on_lost: (error: unknown) => void | Promise<void>;
}): Promise<{
  lease: CellLease;
  stop(): Promise<void>;
}> {
  const now = input.now || (() => new Date().toISOString());
  const renewalIntervalMs = input.renewal_interval_ms ??
    Math.max(100, Math.floor(input.lease_ttl_ms / 3));
  if (!Number.isInteger(renewalIntervalMs) ||
      renewalIntervalMs < 100 || renewalIntervalMs > input.lease_ttl_ms / 2) {
    throw new CellLeaseError('cell_lease_renewal_interval_invalid', 400);
  }
  const claimRetryIntervalMs = input.claim_retry_interval_ms;
  if (claimRetryIntervalMs !== undefined &&
      (!Number.isInteger(claimRetryIntervalMs) ||
       claimRetryIntervalMs < 10 || claimRetryIntervalMs > 60_000)) {
    throw new CellLeaseError('cell_lease_claim_retry_interval_invalid', 400);
  }
  const identity = {
    region_id: input.region_id,
    zone_id: input.zone_id,
    cell_id: input.cell_id,
    owner_instance_id: input.owner_instance_id
  };
  const lease = await claimCellLease({
    ...input,
    ...identity,
    now,
    claim_retry_interval_ms: claimRetryIntervalMs
  });
  let stopped = false;
  let lost = false;
  let active: Promise<void> | null = null;
  const renew = () => {
    if (stopped || lost || active) return;
    active = input.repository.renew({
      ...identity,
      lease_epoch: lease.lease_epoch,
      topology_sha256: input.topology_sha256,
      lease_ttl_ms: input.lease_ttl_ms,
      now: now()
    }).then((renewed) => {
      lease.lease_expires_at = renewed.lease_expires_at;
    }).catch(async (error) => {
      lost = true;
      clearInterval(timer);
      await input.on_lost(error);
    }).finally(() => {
      active = null;
    });
  };
  const timer = setInterval(renew, renewalIntervalMs);
  timer.unref?.();
  return {
    lease,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await active;
      if (lost) return;
      await input.repository.release({
        ...identity,
        lease_epoch: lease.lease_epoch,
        topology_sha256: input.topology_sha256,
        now: now()
      });
    }
  };
}

async function claimCellLease(input: {
  repository: CellLeaseRepository;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_instance_id: string;
  topology_sha256: string;
  lease_ttl_ms: number;
  claim_retry_interval_ms?: number;
  signal?: AbortSignal;
  now: () => string;
  on_waiting?: (error: unknown) => void | Promise<void>;
}): Promise<CellLease> {
  while (true) {
    if (input.signal?.aborted) {
      throw new CellLeaseError('cell_lease_acquire_aborted', 409);
    }
    try {
      return await input.repository.claim({
        region_id: input.region_id,
        zone_id: input.zone_id,
        cell_id: input.cell_id,
        owner_instance_id: input.owner_instance_id,
        topology_sha256: input.topology_sha256,
        lease_ttl_ms: input.lease_ttl_ms,
        now: input.now()
      });
    } catch (error) {
      if (input.claim_retry_interval_ms === undefined ||
          !(error instanceof CellLeaseError) || !error.retryable) {
        throw error;
      }
      await input.on_waiting?.(error);
      await abortableDelay(input.claim_retry_interval_ms, input.signal);
    }
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new CellLeaseError('cell_lease_acquire_aborted', 409)
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new CellLeaseError('cell_lease_acquire_aborted', 409));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class CellLeaseError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, status: number, retryable = false) {
    super(code);
    this.name = 'CellLeaseError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function validateClaim(input: CellLeaseClaimInput): void {
  for (const value of [
    input.region_id,
    input.zone_id,
    input.cell_id,
    input.owner_instance_id
  ]) safeId(value);
  if (!Number.isInteger(input.lease_ttl_ms) ||
      input.lease_ttl_ms < 3_000 || input.lease_ttl_ms > 300_000) {
    throw new CellLeaseError('cell_lease_ttl_invalid', 400);
  }
  validTopologySha256(input.topology_sha256);
  validTimestamp(input.now);
}

function safeId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/.test(value)) {
    throw new CellLeaseError('cell_lease_identifier_invalid', 400);
  }
}

function validEpoch(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new CellLeaseError('cell_lease_epoch_invalid', 400);
  }
}

function validTimestamp(value: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new CellLeaseError('cell_lease_timestamp_invalid', 400);
  }
}

function validTopologySha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new CellLeaseError('cell_lease_topology_sha256_invalid', 400);
  }
}

function expiresAt(now: string, ttlMs: number): string {
  return new Date(Date.parse(now) + ttlMs).toISOString();
}

function decodeLease(row: Record<string, unknown>): CellLease {
  const epoch = Number(row.lease_epoch);
  validEpoch(epoch);
  const expires = new Date(String(row.lease_expires_at));
  if (!Number.isFinite(expires.getTime())) {
    throw new CellLeaseError('cell_lease_timestamp_invalid', 500);
  }
  return {
    region_id: String(row.region_id),
    zone_id: String(row.zone_id),
    cell_id: String(row.cell_id),
    owner_instance_id: String(row.owner_instance_id),
    lease_epoch: epoch,
    topology_sha256: topologySha256(row.topology_sha256),
    lease_expires_at: expires.toISOString()
  };
}

function topologySha256(value: unknown): string {
  const result = String(value || '');
  validTopologySha256(result);
  return result;
}
