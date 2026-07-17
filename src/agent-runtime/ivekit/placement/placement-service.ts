import { createHash } from 'node:crypto';

import { PlacementSnapshotSigner, PlacementTokenSigner } from './snapshot.js';
import { splitOwnerEpoch } from './owner-epoch.js';
import {
  PlacementError,
  type CellAdmissionPort,
  type PlacementDecision,
  type PlacementRequest,
  type PlacementSnapshotCell,
  type SignedPlacementSnapshot,
  type TenantRegionDirectory
} from './types.js';

interface Candidate {
  region_id: string;
  zone_id: string;
  cell: PlacementSnapshotCell;
  request_utilization: number;
}

export class PlacementService {
  readonly #snapshotSigner: PlacementSnapshotSigner;
  readonly #tokenSigner: PlacementTokenSigner;
  readonly #tokenKeyId: string;
  readonly #admissions: Map<string, CellAdmissionPort>;
  readonly #tenantRegions: TenantRegionDirectory;
  readonly #now: () => Date;
  readonly #staleGraceMs: number;

  constructor(input: {
    snapshot_signer: PlacementSnapshotSigner;
    token_signer: PlacementTokenSigner;
    token_key_id: string;
    admissions: Map<string, CellAdmissionPort>;
    tenant_regions: TenantRegionDirectory;
    now?: () => Date;
    stale_grace_ms?: number;
  }) {
    this.#snapshotSigner = input.snapshot_signer;
    this.#tokenSigner = input.token_signer;
    this.#tokenKeyId = input.token_key_id;
    this.#admissions = input.admissions;
    this.#tenantRegions = input.tenant_regions;
    this.#now = input.now || (() => new Date());
    this.#staleGraceMs = input.stale_grace_ms ?? 30_000;
  }

  async place(input: {
    snapshot: SignedPlacementSnapshot;
    last_accepted_snapshot_version: number;
    request: PlacementRequest;
  }): Promise<PlacementDecision> {
    validatePlacementRequest(input.request);
    const now = this.#now();
    const verified = this.#snapshotSigner.verify(input.snapshot, {
      now,
      last_accepted_version: input.last_accepted_snapshot_version,
      stale_grace_ms: this.#staleGraceMs
    });
    if (verified.body.profile_id !== input.request.profile_id) {
      throw new PlacementError({ code: 'snapshot_profile_mismatch', status: 409 });
    }
    const directory = await this.#tenantRegions.resolve(input.request.tenant_id);
    const regionOrder = [
      directory.home_region_id,
      ...directory.failover_region_ids
    ].filter((value, index, values) => values.indexOf(value) === index);
    if (input.request.preferred_region_id &&
        regionOrder.includes(input.request.preferred_region_id)) {
      regionOrder.splice(regionOrder.indexOf(input.request.preferred_region_id), 1);
      regionOrder.unshift(input.request.preferred_region_id);
    }
    let candidates: Candidate[] = [];
    for (const regionId of regionOrder) {
      candidates = collectCandidates(verified.body, input.request, [regionId], now);
      if (candidates.length > 0) break;
    }
    if (input.request.preferred_zone_id) {
      const preferred = candidates.filter((candidate) =>
        candidate.zone_id === input.request.preferred_zone_id
      );
      if (preferred.length > 0) candidates = preferred;
    }
    if (input.request.preferred_cell_id) {
      candidates = candidates.filter((candidate) =>
        candidate.cell.cell_id === input.request.preferred_cell_id
      );
    }
    if (candidates.length === 0) {
      throw new PlacementError({
        code: 'placement_unavailable',
        status: 503,
        retryable: true
      });
    }
    const partitionKey = [
      input.request.tenant_id,
      input.request.routing_partition_id,
      input.request.profile_id
    ].join(':');
    const selected = candidates
      .map((candidate) => ({
        candidate,
        rendezvous: rendezvousScore(partitionKey, candidate.cell)
      }))
      .sort((left, right) => left.rendezvous - right.rendezvous ||
        left.candidate.cell.cell_id.localeCompare(right.candidate.cell.cell_id))
      .slice(0, 2)
      .map((item) => item.candidate)
      .sort((left, right) =>
        left.request_utilization - right.request_utilization ||
        left.cell.cell_id.localeCompare(right.cell.cell_id)
      );
    const attempted: string[] = [];
    let lastError: PlacementError | null = null;
    for (const candidate of selected) {
      const admission = this.#admissions.get(candidate.cell.cell_id);
      if (!admission) continue;
      attempted.push(candidate.cell.cell_id);
      try {
        const reservation = await admission.reserve({
          ...input.request,
          region_id: candidate.region_id,
          zone_id: candidate.zone_id,
          cell_id: candidate.cell.cell_id,
          snapshot_version: verified.body.snapshot_version,
          cell_lease_epoch: candidate.cell.cell_lease_epoch
        });
        validateAdmissionResponse(reservation, candidate, input.request, now);
        const issuedAt = now.toISOString();
        const signedToken = this.#tokenSigner.issue({
          key_id: this.#tokenKeyId,
          tenant_id: input.request.tenant_id,
          interaction_id: input.request.interaction_id,
          interaction_kind: input.request.interaction_kind,
          profile_id: input.request.profile_id,
          region_id: reservation.region_id,
          zone_id: reservation.zone_id,
          cell_id: reservation.cell_id,
          owner_node_id: reservation.owner_node_id,
          owner_epoch: reservation.owner_epoch,
          reservation_id: reservation.reservation_id,
          issued_at: issuedAt,
          expires_at: reservation.expires_at
        });
        return {
          request_id: input.request.request_id,
          interaction_id: input.request.interaction_id,
          region_id: reservation.region_id,
          zone_id: reservation.zone_id,
          cell_id: reservation.cell_id,
          owner_node_id: reservation.owner_node_id,
          owner_epoch: reservation.owner_epoch,
          reservation_id: reservation.reservation_id,
          reservation_expires_at: reservation.expires_at,
          snapshot_version: verified.body.snapshot_version,
          admission_endpoint: candidate.cell.admission_endpoint,
          endpoint: reservation.endpoint,
          signed_placement_token: signedToken
        };
      } catch (error) {
        if (!(error instanceof PlacementError) || !error.retryable) throw error;
        lastError = error;
      }
    }
    throw new PlacementError({
      code: 'placement_capacity_exhausted',
      status: 503,
      retryable: true,
      details: {
        attempted_cells: attempted,
        last_error_code: lastError?.code || 'admission_unavailable'
      }
    });
  }
}

function collectCandidates(
  snapshot: Readonly<{
    profile_id: string;
    regions: ReadonlyArray<{
      region_id: string;
      zones: ReadonlyArray<{
        zone_id: string;
        state: string;
        cells: ReadonlyArray<PlacementSnapshotCell>;
      }>;
    }>;
  }>,
  request: PlacementRequest,
  allowedRegions: string[],
  now: Date
): Candidate[] {
  const allowed = new Set(allowedRegions);
  const result: Candidate[] = [];
  for (const region of snapshot.regions) {
    if (!allowed.has(region.region_id)) continue;
    for (const zone of region.zones) {
      if (!['accepting', 'degraded'].includes(zone.state)) continue;
      for (const cell of zone.cells) {
        const requestUtilization = requestDominantUtilization(
          cell.capacity_dimensions,
          request.required_capacity
        );
        if (!['accepting', 'degraded'].includes(cell.state) ||
            !cell.supported_interaction_kinds.includes(request.interaction_kind) ||
            !cell.supported_profile_ids.includes(request.profile_id) ||
            Date.parse(cell.capacity_expires_at) < now.getTime() ||
            requestUtilization === null) {
          continue;
        }
        result.push({
          region_id: region.region_id,
          zone_id: zone.zone_id,
          cell,
          request_utilization: requestUtilization
        });
      }
    }
  }
  return result;
}

function rendezvousScore(key: string, cell: PlacementSnapshotCell): number {
  const digest = createHash('sha256').update(`${key}:${cell.cell_id}`).digest();
  const value = digest.readBigUInt64BE(0);
  const uniform = (Number(value >> 11n) + 1) / (2 ** 53 + 1);
  return -Math.log(uniform) / cell.routing_weight;
}

function validatePlacementRequest(request: PlacementRequest): void {
  for (const value of [
    request.request_id,
    request.idempotency_key,
    request.tenant_id,
    request.routing_partition_id,
    request.interaction_id
  ]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(String(value || ''))) {
      throw new Error('invalid placement request identifier');
    }
  }
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(request.profile_id)) {
    throw new Error('invalid placement request profile');
  }
  for (const preferred of [request.preferred_region_id, request.preferred_zone_id]) {
    if (preferred && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(preferred)) {
      throw new Error('invalid placement preferred location');
    }
  }
  for (const preferred of [
    request.preferred_cell_id,
    request.preferred_owner_node_id
  ]) {
    if (preferred && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(preferred)) {
      throw new Error('invalid placement preferred owner');
    }
  }
  if (request.excluded_owner_node_ids !== undefined) {
    if (!Array.isArray(request.excluded_owner_node_ids) ||
        request.excluded_owner_node_ids.length > 64 ||
        new Set(request.excluded_owner_node_ids).size !==
          request.excluded_owner_node_ids.length ||
        request.excluded_owner_node_ids.some((owner) =>
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(owner))) {
      throw new Error('invalid placement excluded owners');
    }
    if (request.preferred_owner_node_id &&
        request.excluded_owner_node_ids.includes(request.preferred_owner_node_id)) {
      throw new Error('placement preferred owner is excluded');
    }
  }
  const dimensions = Object.entries(request.required_capacity);
  if (dimensions.length === 0 ||
      dimensions.some(([key, value]) =>
        !/^[a-z][a-z0-9_.]{2,127}$/.test(key) ||
        !Number.isFinite(value) || value <= 0
      )) {
    throw new Error('invalid placement required capacity');
  }
}

function requestDominantUtilization(
  dimensions: PlacementSnapshotCell['capacity_dimensions'],
  required: PlacementRequest['required_capacity']
): number | null {
  let dominant = 0;
  for (const [name, amount] of Object.entries(required)) {
    const dimension = dimensions[name];
    if (!dimension) return null;
    const projected = dimension.used + dimension.reserved + amount;
    if (projected > dimension.safe_capacity) return null;
    dominant = Math.max(dominant, projected / dimension.safe_capacity);
  }
  return dominant;
}

function validateAdmissionResponse(
  reservation: import('./types.js').AdmissionReservation,
  candidate: Candidate,
  request: PlacementRequest,
  now: Date
): void {
  let owner: ReturnType<typeof splitOwnerEpoch>;
  try {
    owner = splitOwnerEpoch(reservation.owner_epoch);
  } catch {
    throw new PlacementError({ code: 'admission_response_mismatch', status: 502 });
  }
  const capacityMatches = JSON.stringify(
    Object.entries(reservation.required_capacity).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  ) === JSON.stringify(
    Object.entries(request.required_capacity).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
  if (reservation.state !== 'reserved' ||
      reservation.region_id !== candidate.region_id ||
      reservation.zone_id !== candidate.zone_id ||
      reservation.cell_id !== candidate.cell.cell_id ||
      owner.cell_lease_epoch !== candidate.cell.cell_lease_epoch ||
      owner.cell_local_sequence < 1 ||
      (request.preferred_owner_node_id &&
        reservation.owner_node_id !== request.preferred_owner_node_id) ||
      !capacityMatches ||
      Date.parse(reservation.expires_at) <= now.getTime() ||
      !validHttpEndpoint(reservation.endpoint)) {
    throw new PlacementError({ code: 'admission_response_mismatch', status: 502 });
  }
}

function validHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
