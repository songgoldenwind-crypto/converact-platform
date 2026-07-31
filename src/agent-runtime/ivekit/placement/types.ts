export type InteractionKind =
  | 'tinode_im'
  | 'sip_voice'
  | 'livekit_av'
  | 'livekit_screen'
  | 'rustdesk_remote';

export type PlacementState = 'accepting' | 'degraded' | 'draining' | 'offline';
export type AdmissionState = 'accepting' | 'degraded' | 'draining' | 'offline';
export type ReservationState = 'reserved' | 'active' | 'expired' | 'closed';

export interface CapacityDimensionState {
  unit: string;
  safe_capacity: number;
  used: number;
  reserved: number;
}

export type FlatCapacityState = Record<string, CapacityDimensionState>;
export type CapacityRequirement = Record<string, number>;

export interface CellCapacityObservationDimension {
  unit: string;
  safe_capacity: number;
  used: number;
}

export interface CellCapacityObservation {
  schema_version: '1.0.0';
  sequence: number;
  observed_at: string;
  expires_at: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  cell_lease_epoch: number;
  dimensions: Record<string, CellCapacityObservationDimension>;
  nodes: Array<{
    node_id: string;
    state: AdmissionState;
    dimensions: Record<string, CellCapacityObservationDimension>;
  }>;
}

export interface PlacementSnapshotCell {
  cell_id: string;
  state: PlacementState;
  routing_weight: number;
  supported_interaction_kinds: InteractionKind[];
  supported_profile_ids: string[];
  capacity_vector_sequence: number;
  capacity_expires_at: string;
  dominant_utilization_ratio: number;
  capacity_dimensions: FlatCapacityState;
  cell_lease_epoch: number;
  admission_endpoint: string;
}

export interface PlacementSnapshotBody {
  schema_version: '1.0.0';
  snapshot_version: number;
  generated_at: string;
  expires_at: string;
  profile_id: string;
  regions: Array<{
    region_id: string;
    zones: Array<{
      zone_id: string;
      state: PlacementState;
      cells: PlacementSnapshotCell[];
    }>;
  }>;
}

export interface SignedPlacementSnapshot {
  key_id: string;
  body: PlacementSnapshotBody;
  signature: string;
}

export interface VerifiedPlacementSnapshot {
  body: Readonly<PlacementSnapshotBody>;
  freshness: 'fresh' | 'grace';
}

export interface PlacementTokenClaims {
  key_id: string;
  tenant_id: string;
  interaction_id: string;
  interaction_kind: InteractionKind;
  profile_id: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  reservation_id: string;
  issued_at: string;
  expires_at: string;
}

export interface PlacementRequest {
  request_id: string;
  idempotency_key: string;
  tenant_id: string;
  routing_partition_id: string;
  interaction_id: string;
  interaction_kind: InteractionKind;
  profile_id: string;
  required_capacity: CapacityRequirement;
  preferred_region_id?: string;
  preferred_zone_id?: string;
  preferred_cell_id?: string;
  preferred_owner_node_id?: string;
  excluded_owner_node_ids?: string[];
}

export interface CellAdmissionRequest extends PlacementRequest {
  region_id: string;
  zone_id: string;
  cell_id: string;
  snapshot_version: number;
  cell_lease_epoch: number;
}

export interface AdmissionReservation {
  reservation_id: string;
  state: ReservationState;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  endpoint: string;
  expires_at: string;
  required_capacity: CapacityRequirement;
}

export interface CellAdmissionTakeoverRequest {
  expected_owner_epoch: string;
  owner_epoch: string;
  owner_node_id: string;
}

export interface CellAdmissionPort {
  reserve(input: CellAdmissionRequest): Promise<AdmissionReservation>;
}

export interface CellReservationLifecyclePort {
  activate(reservationId: string): Promise<AdmissionReservation>;
  close(reservationId: string): Promise<AdmissionReservation>;
}

export interface CellReservationTakeoverPort {
  takeover(
    reservationId: string,
    input: CellAdmissionTakeoverRequest
  ): Promise<AdmissionReservation>;
}

export interface TenantRegionDirectory {
  resolve(tenantId: string): Promise<{
    home_region_id: string;
    failover_region_ids: string[];
  }>;
}

export interface PlacementDecision {
  request_id: string;
  interaction_id: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  reservation_id: string;
  reservation_expires_at: string;
  snapshot_version: number;
  admission_endpoint: string;
  endpoint: string;
  signed_placement_token: string;
}

export class PlacementError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(input: {
    code: string;
    status: number;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(input.code);
    this.name = 'PlacementError';
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    this.details = input.details || {};
  }
}
