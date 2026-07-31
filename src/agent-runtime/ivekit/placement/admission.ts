import { createHash, randomUUID } from 'node:crypto';

import {
  compareOwnerEpoch,
  composeOwnerEpoch,
  splitOwnerEpoch
} from './owner-epoch.js';
import {
  PlacementError,
  type AdmissionReservation,
  type AdmissionState,
  type CellAdmissionTakeoverRequest,
  type CellCapacityObservation,
  type CellCapacityObservationDimension,
  type CapacityDimensionState,
  type CapacityRequirement,
  type CellAdmissionRequest,
  type FlatCapacityState,
  type InteractionKind,
  type ReservationState
} from './types.js';

interface AdmissionNode {
  node_id: string;
  endpoint: string;
  control_endpoint?: string;
  component?: 'rustpbx' | 'livekit' | 'tinode' | 'rustdesk' | '';
  state: AdmissionState;
  profile_ids: string[];
  interaction_kinds: InteractionKind[];
  dimensions: FlatCapacityState;
  recovery_safe_after?: string;
}

interface InternalReservation extends AdmissionReservation {
  idempotency_key: string;
  payload_hash: string;
  tenant_id: string;
  routing_partition_id: string;
  interaction_id: string;
  interaction_kind: InteractionKind;
  profile_id: string;
  owner_node_id: string;
  created_at: string;
  updated_at: string;
}

export interface CellAdmissionReservationCheckpoint extends AdmissionReservation {
  tenant_id: string;
  routing_partition_id: string;
  interaction_id: string;
  interaction_kind: InteractionKind;
  profile_id: string;
  idempotency_key: string;
  payload_hash: string;
  created_at: string;
  updated_at: string;
}

interface ReservationDeadline {
  at: number;
  reservation_id: string;
  kind: 'expire' | 'evict';
}

export class CellAdmissionController {
  readonly #config: {
    region_id: string;
    zone_id: string;
    cell_id: string;
    cell_lease_epoch: number;
    profile_ids: Set<string>;
    interaction_kinds: Set<InteractionKind>;
    reservation_ttl_ms: number;
    terminal_retention_ms: number;
  };
  readonly #dimensions: FlatCapacityState;
  readonly #nodes: AdmissionNode[];
  readonly #nodesById: Map<string, AdmissionNode>;
  readonly #desiredNodeStates = new Map<string, AdmissionState>();
  readonly #nodeAvailability = new Map<string, {
    generation: number;
    unavailable: boolean;
    desired_state_revision: number;
  }>();
  readonly #reservations = new Map<string, InternalReservation>();
  readonly #idempotency = new Map<string, string>();
  readonly #deadlines: ReservationDeadline[] = [];
  readonly #idFactory: () => string;
  #state: AdmissionState;
  #drainStartedAt = '';
  #localSequence = 0;
  #capacitySequence = 0;
  #capacityObservedAt = '';
  #capacityExpiresAt = '';

  constructor(input: {
    region_id: string;
    zone_id: string;
    cell_id: string;
    cell_lease_epoch: number;
    profile_ids: string[];
    interaction_kinds: InteractionKind[];
    reservation_ttl_ms: number;
    terminal_retention_ms?: number;
    dimensions: FlatCapacityState;
    nodes: AdmissionNode[];
    state?: AdmissionState;
    recovered_reservations?: CellAdmissionReservationCheckpoint[];
    id_factory?: () => string;
  }) {
    safeId(input.region_id);
    safeId(input.zone_id);
    safeId(input.cell_id);
    if (!Number.isInteger(input.cell_lease_epoch) || input.cell_lease_epoch < 1 ||
        input.cell_lease_epoch > 0xffff_ffff) {
      throw new Error('invalid Cell lease epoch');
    }
    if (!Number.isInteger(input.reservation_ttl_ms) ||
        input.reservation_ttl_ms < 1_000 || input.reservation_ttl_ms > 300_000) {
      throw new Error('invalid reservation TTL');
    }
    const terminalRetentionMs = input.terminal_retention_ms ?? 300_000;
    if (!Number.isInteger(terminalRetentionMs) ||
        terminalRetentionMs < 1_000 || terminalRetentionMs > 86_400_000) {
      throw new Error('invalid reservation terminal retention');
    }
    if (input.profile_ids.length === 0 ||
        input.profile_ids.some((profile) => !/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(profile)) ||
        new Set(input.profile_ids).size !== input.profile_ids.length) {
      throw new Error('invalid admission profiles');
    }
    if (input.interaction_kinds.length === 0 ||
        new Set(input.interaction_kinds).size !== input.interaction_kinds.length ||
        input.interaction_kinds.some((kind) =>
          !['tinode_im', 'sip_voice', 'livekit_av', 'livekit_screen', 'rustdesk_remote']
            .includes(kind))) {
      throw new Error('invalid admission interaction kinds');
    }
    this.#config = {
      region_id: input.region_id,
      zone_id: input.zone_id,
      cell_id: input.cell_id,
      cell_lease_epoch: input.cell_lease_epoch,
      profile_ids: new Set(input.profile_ids),
      interaction_kinds: new Set(input.interaction_kinds),
      reservation_ttl_ms: input.reservation_ttl_ms,
      terminal_retention_ms: terminalRetentionMs
    };
    this.#dimensions = cloneDimensions(input.dimensions);
    this.#nodes = input.nodes.map((node) => ({
      node_id: checkedId(node.node_id),
      endpoint: checkedUrl(node.endpoint),
      control_endpoint: node.control_endpoint
        ? checkedUrl(node.control_endpoint)
        : '',
      component: node.control_endpoint
        ? componentForKinds(node.interaction_kinds)
        : '',
      state: validAdmissionState(node.state),
      profile_ids: checkedNodeProfiles(node.profile_ids, this.#config.profile_ids),
      interaction_kinds: checkedNodeInteractionKinds(
        node.interaction_kinds,
        this.#config.interaction_kinds
      ),
      dimensions: cloneDimensions(node.dimensions),
      recovery_safe_after: ''
    }));
    if (this.#nodes.length === 0) throw new Error('Cell admission requires at least one node');
    if (new Set(this.#nodes.map((node) => node.node_id)).size !== this.#nodes.length) {
      throw new Error('duplicate admission node ID');
    }
    this.#nodesById = new Map(this.#nodes.map((node) => [node.node_id, node]));
    for (const node of this.#nodes) {
      this.#desiredNodeStates.set(node.node_id, node.state);
      this.#nodeAvailability.set(node.node_id, {
        generation: 0,
        unavailable: false,
        desired_state_revision: 0
      });
    }
    this.#state = validAdmissionState(input.state || 'accepting');
    this.#idFactory = input.id_factory || randomUUID;
    this.#restore(input.recovered_reservations || []);
  }

  reserve(
    request: Omit<CellAdmissionRequest,
      'region_id' | 'zone_id' | 'cell_id' | 'snapshot_version' | 'cell_lease_epoch'>,
    now: Date
  ): AdmissionReservation {
    const timestamp = validNow(now);
    validateRequest(request);
    this.expireReservations(now);
    const payloadHash = requestHash(request);
    const replayId = this.#idempotency.get(request.idempotency_key);
    if (replayId) {
      const replay = this.#reservations.get(replayId)!;
      if (replay.payload_hash !== payloadHash) {
        throw new PlacementError({ code: 'idempotency_conflict', status: 409 });
      }
      return publicReservation(replay);
    }
    if (!this.isCapacityFresh(now)) {
      throw new PlacementError({
        code: 'capacity_stale',
        status: 503,
        retryable: true
      });
    }
    if (this.#state === 'draining') {
      throw new PlacementError({
        code: 'cell_draining',
        status: 503,
        retryable: true,
        details: { drain_started_at: this.#drainStartedAt }
      });
    }
    if (this.#state === 'offline') {
      throw new PlacementError({ code: 'cell_offline', status: 503, retryable: true });
    }
    if (!this.#config.profile_ids.has(request.profile_id)) {
      throw new PlacementError({ code: 'profile_not_supported', status: 409 });
    }
    if (!this.#config.interaction_kinds.has(request.interaction_kind)) {
      throw new PlacementError({ code: 'interaction_kind_not_supported', status: 409 });
    }
    if (request.preferred_cell_id &&
        request.preferred_cell_id !== this.#config.cell_id) {
      throw new PlacementError({
        code: 'admission_target_mismatch',
        status: 409,
        retryable: true
      });
    }
    const cellLimits = limitingDimensions(this.#dimensions, request.required_capacity);
    if (cellLimits.length > 0) {
      throw new PlacementError({
        code: 'capacity_exhausted',
        status: 503,
        retryable: true,
        details: { limiting_dimensions: cellLimits }
      });
    }
    const excludedOwners = new Set(request.excluded_owner_node_ids || []);
    const candidateNodes = (request.preferred_owner_node_id
      ? this.#nodes.filter((node) =>
          node.node_id === request.preferred_owner_node_id
        )
      : this.#nodes).filter((node) => !excludedOwners.has(node.node_id));
    const node = selectNode(
      candidateNodes,
      request.profile_id,
      request.interaction_kind,
      request.required_capacity
    );
    if (!node) {
      if (request.preferred_owner_node_id ||
          excludedOwners.size > 0) {
        throw new PlacementError({
          code: 'owner_node_unavailable',
          status: 503,
          retryable: true
        });
      }
      throw new PlacementError({
        code: 'capacity_exhausted',
        status: 503,
        retryable: true,
        details: { limiting_dimensions: ['owner_node'] }
      });
    }

    if (this.#localSequence >= 0xffff_ffff) {
      throw new PlacementError({ code: 'owner_epoch_exhausted', status: 503 });
    }
    this.#localSequence += 1;
    const reservationId = checkedId(this.#idFactory());
    if (this.#reservations.has(reservationId)) {
      throw new PlacementError({ code: 'reservation_id_conflict', status: 500 });
    }
    const expiresAt = new Date(timestamp + this.#config.reservation_ttl_ms).toISOString();
    const reservation: InternalReservation = {
      reservation_id: reservationId,
      state: 'reserved',
      region_id: this.#config.region_id,
      zone_id: this.#config.zone_id,
      cell_id: this.#config.cell_id,
      owner_node_id: node.node_id,
      owner_epoch: composeOwnerEpoch(this.#config.cell_lease_epoch, this.#localSequence),
      endpoint: node.endpoint,
      expires_at: expiresAt,
      required_capacity: { ...request.required_capacity },
      idempotency_key: request.idempotency_key,
      payload_hash: payloadHash,
      tenant_id: request.tenant_id,
      routing_partition_id: request.routing_partition_id,
      interaction_id: request.interaction_id,
      interaction_kind: request.interaction_kind,
      profile_id: request.profile_id,
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    };
    addCapacity(this.#dimensions, request.required_capacity, 'reserved', 1);
    addCapacity(node.dimensions, request.required_capacity, 'reserved', 1);
    this.#reservations.set(reservationId, reservation);
    this.#idempotency.set(request.idempotency_key, reservationId);
    pushDeadline(this.#deadlines, {
      at: Date.parse(expiresAt),
      reservation_id: reservationId,
      kind: 'expire'
    });
    return publicReservation(reservation);
  }

  activate(reservationId: string, now: Date): AdmissionReservation {
    const reservation = this.#requiredReservation(reservationId);
    if (reservation.state === 'active') return publicReservation(reservation);
    if (reservation.state !== 'reserved') {
      throw new PlacementError({ code: 'invalid_reservation_state', status: 409 });
    }
    if (validNow(now) >= Date.parse(reservation.expires_at)) {
      this.#expire(reservation, now);
      throw new PlacementError({ code: 'reservation_expired', status: 409 });
    }
    const node = this.#requiredNode(reservation.owner_node_id);
    addCapacity(this.#dimensions, reservation.required_capacity, 'reserved', -1);
    addCapacity(node.dimensions, reservation.required_capacity, 'reserved', -1);
    addCapacity(this.#dimensions, reservation.required_capacity, 'used', 1);
    addCapacity(node.dimensions, reservation.required_capacity, 'used', 1);
    reservation.state = 'active';
    reservation.updated_at = now.toISOString();
    return publicReservation(reservation);
  }

  takeover(
    reservationId: string,
    request: CellAdmissionTakeoverRequest,
    now: Date
  ): AdmissionReservation {
    const timestamp = validNow(now);
    const reservation = this.#requiredReservation(reservationId);
    safeId(request.owner_node_id);
    let nextOwner: ReturnType<typeof splitOwnerEpoch>;
    try {
      splitOwnerEpoch(request.expected_owner_epoch);
      nextOwner = splitOwnerEpoch(request.owner_epoch);
    } catch {
      throw new PlacementError({
        code: 'owner_epoch_invalid',
        status: 400
      });
    }
    if (reservation.owner_epoch === request.owner_epoch &&
        reservation.owner_node_id === request.owner_node_id) {
      return publicReservation(reservation);
    }
    const expectedComparison = compareOwnerEpoch(
      request.expected_owner_epoch,
      reservation.owner_epoch
    );
    if (expectedComparison !== 0) {
      throw new PlacementError({
        code: expectedComparison < 0
          ? 'stale_owner_epoch'
          : 'owner_epoch_ahead',
        status: 409,
        retryable: expectedComparison > 0
      });
    }
    if (reservation.state !== 'active') {
      throw new PlacementError({
        code: 'reservation_takeover_invalid_state',
        status: 409
      });
    }
    if (compareOwnerEpoch(request.owner_epoch, reservation.owner_epoch) <= 0 ||
        nextOwner.cell_lease_epoch !== this.#config.cell_lease_epoch) {
      throw new PlacementError({
        code: 'reservation_takeover_epoch_invalid',
        status: 409
      });
    }
    if (request.owner_node_id !== reservation.owner_node_id) {
      throw new PlacementError({
        code: 'cross_node_takeover_transfer_fence_required',
        status: 409
      });
    }
    const nextNode = this.#requiredNode(request.owner_node_id);
    if ((nextNode.state !== 'accepting' && nextNode.state !== 'degraded') ||
        !nextNode.profile_ids.includes(reservation.profile_id) ||
        !nextNode.interaction_kinds.includes(reservation.interaction_kind)) {
      throw new PlacementError({
        code: 'owner_node_unavailable',
        status: 503,
        retryable: true
      });
    }
    reservation.owner_node_id = nextNode.node_id;
    reservation.owner_epoch = request.owner_epoch;
    reservation.endpoint = nextNode.endpoint;
    reservation.updated_at = new Date(timestamp).toISOString();
    this.#localSequence = Math.max(
      this.#localSequence,
      nextOwner.cell_local_sequence
    );
    return publicReservation(reservation);
  }

  close(reservationId: string, now: Date): AdmissionReservation {
    const reservation = this.#requiredReservation(reservationId);
    if (reservation.state === 'closed') return publicReservation(reservation);
    validNow(now);
    const node = this.#requiredNode(reservation.owner_node_id);
    if (reservation.state === 'reserved') {
      addCapacity(this.#dimensions, reservation.required_capacity, 'reserved', -1);
      addCapacity(node.dimensions, reservation.required_capacity, 'reserved', -1);
    } else if (reservation.state === 'active') {
      addCapacity(this.#dimensions, reservation.required_capacity, 'used', -1);
      addCapacity(node.dimensions, reservation.required_capacity, 'used', -1);
    }
    reservation.state = 'closed';
    reservation.updated_at = now.toISOString();
    this.#scheduleTerminalEviction(reservation, now.getTime());
    return publicReservation(reservation);
  }

  expireReservations(now: Date): number {
    const timestamp = validNow(now);
    let expired = 0;
    while (this.#deadlines[0] && this.#deadlines[0].at <= timestamp) {
      const deadline = popDeadline(this.#deadlines)!;
      const reservation = this.#reservations.get(deadline.reservation_id);
      if (!reservation) continue;
      if (deadline.kind === 'expire' &&
          reservation.state === 'reserved' &&
          Date.parse(reservation.expires_at) <= timestamp) {
        this.#expire(reservation, now);
        expired += 1;
        continue;
      }
      if (deadline.kind === 'evict' &&
          (reservation.state === 'closed' || reservation.state === 'expired') &&
          Date.parse(reservation.updated_at) + this.#config.terminal_retention_ms <= timestamp) {
        this.#reservations.delete(reservation.reservation_id);
        if (this.#idempotency.get(reservation.idempotency_key) === reservation.reservation_id) {
          this.#idempotency.delete(reservation.idempotency_key);
        }
      }
    }
    return expired;
  }

  startDrain(now: Date): void {
    validNow(now);
    if (this.#state === 'offline') {
      throw new PlacementError({ code: 'cell_offline', status: 409 });
    }
    this.#state = 'draining';
    this.#drainStartedAt ||= now.toISOString();
  }

  setState(state: AdmissionState, now: Date): void {
    validNow(now);
    validAdmissionState(state);
    if (state === this.#state) return;
    if (this.#state === 'offline') {
      throw new PlacementError({ code: 'cell_offline', status: 409 });
    }
    if (state === 'draining') {
      this.startDrain(now);
      return;
    }
    if (state === 'offline') {
      const ownsCapacity = Object.values(this.#dimensions).some(
        (dimension) => dimension.used > 0 || dimension.reserved > 0
      );
      if (ownsCapacity || [...this.#reservations.values()].some(
        (reservation) => reservation.state === 'reserved' || reservation.state === 'active'
      )) {
        throw new PlacementError({ code: 'cell_not_empty', status: 409 });
      }
      this.#state = 'offline';
      this.#drainStartedAt ||= now.toISOString();
      return;
    }
    this.#state = state;
    this.#drainStartedAt = '';
  }

  applyCapacityObservation(
    observation: CellCapacityObservation,
    now: Date
  ): void {
    const timestamp = validNow(now);
    if (observation.schema_version !== '1.0.0') {
      throw new PlacementError({ code: 'capacity_schema_unsupported', status: 400 });
    }
    if (!Number.isSafeInteger(observation.sequence) || observation.sequence < 1) {
      throw new PlacementError({ code: 'capacity_sequence_invalid', status: 400 });
    }
    if (observation.sequence <= this.#capacitySequence) {
      throw new PlacementError({ code: 'capacity_sequence_stale', status: 409 });
    }
    if (observation.region_id !== this.#config.region_id ||
        observation.zone_id !== this.#config.zone_id ||
        observation.cell_id !== this.#config.cell_id) {
      throw new PlacementError({
        code: 'admission_target_mismatch',
        status: 409,
        retryable: true
      });
    }
    if (observation.cell_lease_epoch !== this.#config.cell_lease_epoch) {
      throw new PlacementError({
        code: 'stale_cell_lease_epoch',
        status: 409,
        retryable: true
      });
    }
    const observedAt = Date.parse(observation.observed_at);
    const expiresAt = Date.parse(observation.expires_at);
    if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) ||
        observedAt > timestamp + 5_000 || expiresAt <= timestamp ||
        expiresAt <= observedAt || expiresAt - observedAt > 300_000) {
      throw new PlacementError({ code: 'capacity_timestamp_invalid', status: 400 });
    }
    validateObservedDimensions(observation.dimensions, this.#dimensions);
    if (!Array.isArray(observation.nodes) ||
        observation.nodes.length !== this.#nodes.length) {
      throw new PlacementError({ code: 'capacity_nodes_mismatch', status: 409 });
    }
    const observedNodes = new Map<string, CellCapacityObservation['nodes'][number]>();
    for (const node of observation.nodes) {
      if (observedNodes.has(node.node_id)) {
        throw new PlacementError({ code: 'capacity_nodes_mismatch', status: 409 });
      }
      const configured = this.#nodesById.get(node.node_id);
      if (!configured) {
        throw new PlacementError({ code: 'capacity_nodes_mismatch', status: 409 });
      }
      validAdmissionState(node.state);
      validateObservedDimensions(node.dimensions, configured.dimensions);
      observedNodes.set(node.node_id, node);
    }

    const activeCell = activeOwnedCapacity(this.#reservations.values());
    applyObservedUsage(this.#dimensions, observation.dimensions, activeCell);
    for (const configured of this.#nodes) {
      const observed = observedNodes.get(configured.node_id)!;
      const activeNode = activeOwnedCapacity(
        [...this.#reservations.values()].filter(
          (reservation) => reservation.owner_node_id === configured.node_id
        )
      );
      applyObservedUsage(configured.dimensions, observed.dimensions, activeNode);
      const previousState = configured.state;
      const previousDesiredState = this.#desiredNodeStates.get(configured.node_id);
      const availability = this.#requiredNodeAvailability(configured.node_id);
      if (previousDesiredState !== observed.state) {
        availability.desired_state_revision += 1;
      }
      this.#desiredNodeStates.set(configured.node_id, observed.state);
      if (!availability.unavailable) {
        configured.state = observed.state;
      }
      if (!availability.unavailable &&
          (observed.state !== 'offline' || previousState !== 'offline')) {
        configured.recovery_safe_after = '';
      }
    }
    this.#capacitySequence = observation.sequence;
    this.#capacityObservedAt = new Date(observedAt).toISOString();
    this.#capacityExpiresAt = new Date(expiresAt).toISOString();
  }

  isCapacityFresh(now: Date): boolean {
    const timestamp = validNow(now);
    return !this.#capacityExpiresAt ||
      timestamp < Date.parse(this.#capacityExpiresAt);
  }

  snapshot(): {
    state: AdmissionState;
    drain_started_at: string;
    cell_lease_epoch: number;
    capacity_sequence: number;
    capacity_observed_at: string;
    capacity_expires_at: string;
    dimensions: FlatCapacityState;
    nodes: AdmissionNode[];
    reservations: AdmissionReservation[];
  } {
    return structuredClone({
      state: this.#state,
      drain_started_at: this.#drainStartedAt,
      cell_lease_epoch: this.#config.cell_lease_epoch,
      capacity_sequence: this.#capacitySequence,
      capacity_observed_at: this.#capacityObservedAt,
      capacity_expires_at: this.#capacityExpiresAt,
      dimensions: this.#dimensions,
      nodes: this.#nodes,
      reservations: [...this.#reservations.values()].map(publicReservation)
    });
  }

  checkpoint(reservationId: string): CellAdmissionReservationCheckpoint {
    const reservation = this.#requiredReservation(reservationId);
    return structuredClone({
      reservation_id: reservation.reservation_id,
      state: reservation.state,
      region_id: reservation.region_id,
      zone_id: reservation.zone_id,
      cell_id: reservation.cell_id,
      owner_node_id: reservation.owner_node_id,
      owner_epoch: reservation.owner_epoch,
      endpoint: reservation.endpoint,
      expires_at: reservation.expires_at,
      required_capacity: reservation.required_capacity,
      tenant_id: reservation.tenant_id,
      routing_partition_id: reservation.routing_partition_id,
      interaction_id: reservation.interaction_id,
      interaction_kind: reservation.interaction_kind,
      profile_id: reservation.profile_id,
      idempotency_key: reservation.idempotency_key,
      payload_hash: reservation.payload_hash,
      created_at: reservation.created_at,
      updated_at: reservation.updated_at
    });
  }

  componentNodeTargets(): Array<{
    component: 'rustpbx' | 'livekit' | 'tinode' | 'rustdesk';
    node_id: string;
    control_endpoint: string;
    state: AdmissionState;
    availability_generation: number;
    desired_state_revision: number;
  }> {
    return this.#nodes
      .filter((node) => Boolean(node.control_endpoint && node.component))
      .map((node) => ({
        component: node.component as 'rustpbx' | 'livekit' | 'tinode' | 'rustdesk',
        node_id: node.node_id,
        control_endpoint: node.control_endpoint || '',
        state: this.#desiredNodeStates.get(node.node_id) || node.state,
        availability_generation: this.#requiredNodeAvailability(node.node_id)
          .generation,
        desired_state_revision: this.#requiredNodeAvailability(node.node_id)
          .desired_state_revision
      }));
  }

  setNodeState(
    nodeId: string,
    state: AdmissionState,
    recoverySafeAfter?: string
  ): void {
    const node = this.#requiredNode(checkedId(nodeId));
    const desiredState = validAdmissionState(state);
    const availability = this.#requiredNodeAvailability(node.node_id);
    if (this.#desiredNodeStates.get(node.node_id) !== desiredState) {
      availability.desired_state_revision += 1;
    }
    this.#desiredNodeStates.set(node.node_id, desiredState);
    node.state = availability.unavailable ? 'offline' : desiredState;
    if (state !== 'offline' && !availability.unavailable) {
      node.recovery_safe_after = '';
      return;
    }
    if (recoverySafeAfter !== undefined) {
      const timestamp = Date.parse(recoverySafeAfter);
      if (!Number.isFinite(timestamp)) {
        throw new Error('invalid component node recovery fence');
      }
      node.recovery_safe_after = new Date(timestamp).toISOString();
    }
  }

  markNodeUnavailable(
    nodeId: string,
    recoverySafeAfter?: string,
    expectedGeneration?: number
  ): boolean {
    const node = this.#requiredNode(checkedId(nodeId));
    const availability = this.#requiredNodeAvailability(node.node_id);
    if (expectedGeneration !== undefined &&
        checkedAvailabilityGeneration(expectedGeneration) !==
          availability.generation) {
      return false;
    }
    availability.generation += 1;
    availability.unavailable = true;
    node.state = 'offline';
    if (recoverySafeAfter === undefined) return true;
    const timestamp = Date.parse(recoverySafeAfter);
    if (!Number.isFinite(timestamp)) {
      throw new Error('invalid component node recovery fence');
    }
    node.recovery_safe_after = new Date(timestamp).toISOString();
    return true;
  }

  restoreNodeAvailability(
    nodeId: string,
    expectedGeneration: number,
    expectedDesiredStateRevision: number
  ): boolean {
    const node = this.#requiredNode(checkedId(nodeId));
    const availability = this.#requiredNodeAvailability(node.node_id);
    if (checkedAvailabilityGeneration(expectedGeneration) !==
        availability.generation ||
        checkedAvailabilityGeneration(expectedDesiredStateRevision) !==
          availability.desired_state_revision ||
        !availability.unavailable) {
      return false;
    }
    availability.generation += 1;
    availability.unavailable = false;
    const desiredState = this.#desiredNodeStates.get(node.node_id) || node.state;
    node.state = desiredState;
    if (desiredState !== 'offline') {
      node.recovery_safe_after = '';
    }
    return true;
  }

  #restore(checkpoints: CellAdmissionReservationCheckpoint[]): void {
    if (!Array.isArray(checkpoints) || checkpoints.length > 250_000) {
      throw new Error('invalid recovered admission reservations');
    }
    const activeCell: CapacityRequirement = {};
    const activeNodes = new Map<string, CapacityRequirement>();
    for (const value of checkpoints) {
      const checkpoint = checkedRecoveredReservation(value);
      if (checkpoint.region_id !== this.#config.region_id ||
          checkpoint.zone_id !== this.#config.zone_id ||
          checkpoint.cell_id !== this.#config.cell_id) {
        throw new Error('recovered admission target mismatch');
      }
      if (this.#reservations.has(checkpoint.reservation_id)) {
        throw new Error('duplicate recovered admission reservation');
      }
      if (this.#idempotency.has(checkpoint.idempotency_key)) {
        throw new Error('duplicate recovered admission idempotency');
      }
      const node = this.#requiredNode(checkpoint.owner_node_id);
      if (node.endpoint !== checkedUrl(checkpoint.endpoint)) {
        throw new Error('recovered admission endpoint mismatch');
      }
      validateRecoveredCapacity(checkpoint.required_capacity, this.#dimensions, node.dimensions);
      const epoch = splitOwnerEpoch(checkpoint.owner_epoch);
      if (epoch.cell_lease_epoch > this.#config.cell_lease_epoch) {
        throw new Error('recovered admission has a future Cell lease epoch');
      }
      if (epoch.cell_lease_epoch === this.#config.cell_lease_epoch) {
        this.#localSequence = Math.max(this.#localSequence, epoch.cell_local_sequence);
      }
      const restored: InternalReservation = structuredClone(checkpoint);
      this.#reservations.set(restored.reservation_id, restored);
      this.#idempotency.set(restored.idempotency_key, restored.reservation_id);
      if (restored.state === 'reserved') {
        addCapacity(this.#dimensions, restored.required_capacity, 'reserved', 1);
        addCapacity(node.dimensions, restored.required_capacity, 'reserved', 1);
        pushDeadline(this.#deadlines, {
          at: Date.parse(restored.expires_at),
          reservation_id: restored.reservation_id,
          kind: 'expire'
        });
      } else if (restored.state === 'active') {
        mergeCapacity(activeCell, restored.required_capacity);
        const activeNode = activeNodes.get(restored.owner_node_id) || {};
        mergeCapacity(activeNode, restored.required_capacity);
        activeNodes.set(restored.owner_node_id, activeNode);
      } else {
        this.#scheduleTerminalEviction(restored, Date.parse(restored.updated_at));
      }
    }
    applyRecoveredActiveUsage(this.#dimensions, activeCell);
    for (const node of this.#nodes) {
      applyRecoveredActiveUsage(
        node.dimensions,
        activeNodes.get(node.node_id) || {}
      );
    }
  }

  #expire(reservation: InternalReservation, now: Date): void {
    const node = this.#requiredNode(reservation.owner_node_id);
    addCapacity(this.#dimensions, reservation.required_capacity, 'reserved', -1);
    addCapacity(node.dimensions, reservation.required_capacity, 'reserved', -1);
    reservation.state = 'expired';
    reservation.updated_at = now.toISOString();
    this.#idempotency.delete(reservation.idempotency_key);
    this.#scheduleTerminalEviction(reservation, now.getTime());
  }

  #scheduleTerminalEviction(
    reservation: InternalReservation,
    timestamp: number
  ): void {
    pushDeadline(this.#deadlines, {
      at: timestamp + this.#config.terminal_retention_ms,
      reservation_id: reservation.reservation_id,
      kind: 'evict'
    });
  }

  #requiredReservation(id: string): InternalReservation {
    const reservation = this.#reservations.get(id);
    if (!reservation) throw new PlacementError({ code: 'reservation_not_found', status: 404 });
    return reservation;
  }

  #requiredNode(id: string): AdmissionNode {
    const node = this.#nodesById.get(id);
    if (!node) throw new Error('reservation owner node is missing');
    return node;
  }

  #requiredNodeAvailability(id: string): {
    generation: number;
    unavailable: boolean;
    desired_state_revision: number;
  } {
    const availability = this.#nodeAvailability.get(id);
    if (!availability) throw new Error('admission node availability missing');
    return availability;
  }
}

function selectNode(
  nodes: AdmissionNode[],
  profileId: string,
  interactionKind: InteractionKind,
  required: CapacityRequirement
): AdmissionNode | null {
  let selected: AdmissionNode | null = null;
  let selectedUtilization = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.state !== 'accepting' && node.state !== 'degraded') continue;
    if (!node.profile_ids.includes(profileId) ||
        !node.interaction_kinds.includes(interactionKind)) {
      continue;
    }
    const utilization = admissibleDominantUtilization(node.dimensions, required);
    if (utilization === null) continue;
    if (utilization < selectedUtilization ||
        (utilization === selectedUtilization &&
          (!selected || node.node_id.localeCompare(selected.node_id) < 0))) {
      selected = node;
      selectedUtilization = utilization;
    }
  }
  return selected;
}

function admissibleDominantUtilization(
  dimensions: FlatCapacityState,
  required: CapacityRequirement
): number | null {
  let dominant = 0;
  for (const [key, amount] of Object.entries(required)) {
    const dimension = dimensions[key];
    if (!dimension) return null;
    const projected = dimension.used + dimension.reserved + amount;
    if (projected > dimension.safe_capacity) return null;
    dominant = Math.max(dominant, projected / dimension.safe_capacity);
  }
  return dominant;
}

function limitingDimensions(dimensions: FlatCapacityState, required: CapacityRequirement): string[] {
  const limiting: string[] = [];
  for (const [key, amount] of Object.entries(required)) {
    const dimension = dimensions[key];
    if (!dimension || dimension.used + dimension.reserved + amount > dimension.safe_capacity) {
      limiting.push(key);
    }
  }
  return limiting.sort();
}

function addCapacity(
  dimensions: FlatCapacityState,
  required: CapacityRequirement,
  field: 'used' | 'reserved',
  direction: 1 | -1
): void {
  for (const [key, amount] of Object.entries(required)) {
    const next = dimensions[key][field] + amount * direction;
    if (next < 0) throw new Error(`capacity accounting underflow for ${key}`);
    dimensions[key][field] = next;
  }
}

function validateObservedDimensions(
  observed: Record<string, CellCapacityObservationDimension>,
  configured: FlatCapacityState
): void {
  const observedKeys = Object.keys(observed).sort();
  const configuredKeys = Object.keys(configured).sort();
  if (observedKeys.length !== configuredKeys.length ||
      observedKeys.some((key, index) => key !== configuredKeys[index])) {
    throw new PlacementError({ code: 'capacity_dimensions_mismatch', status: 409 });
  }
  for (const key of configuredKeys) {
    const sample = observed[key];
    const expected = configured[key];
    if (!sample || sample.unit !== expected.unit ||
        sample.safe_capacity !== expected.safe_capacity ||
        !Number.isFinite(sample.used) || sample.used < 0) {
      throw new PlacementError({ code: 'capacity_dimensions_mismatch', status: 409 });
    }
  }
}

function applyObservedUsage(
  target: FlatCapacityState,
  observed: Record<string, CellCapacityObservationDimension>,
  activeOwned: CapacityRequirement
): void {
  for (const [key, sample] of Object.entries(observed)) {
    target[key].used = Math.max(sample.used, activeOwned[key] || 0);
  }
}

function activeOwnedCapacity(
  reservations: Iterable<InternalReservation>
): CapacityRequirement {
  const result: CapacityRequirement = {};
  for (const reservation of reservations) {
    if (reservation.state !== 'active') continue;
    for (const [key, amount] of Object.entries(reservation.required_capacity)) {
      result[key] = (result[key] || 0) + amount;
    }
  }
  return result;
}

function mergeCapacity(
  target: CapacityRequirement,
  source: CapacityRequirement
): void {
  for (const [key, amount] of Object.entries(source)) {
    target[key] = (target[key] || 0) + amount;
  }
}

function applyRecoveredActiveUsage(
  dimensions: FlatCapacityState,
  active: CapacityRequirement
): void {
  for (const [key, amount] of Object.entries(active)) {
    dimensions[key].used = Math.max(dimensions[key].used, amount);
  }
}

function pushDeadline(
  heap: ReservationDeadline[],
  deadline: ReservationDeadline
): void {
  heap.push(deadline);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareDeadline(heap[parent], deadline) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = deadline;
}

function popDeadline(heap: ReservationDeadline[]): ReservationDeadline | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length &&
      compareDeadline(heap[right], heap[left]) < 0 ? right : left;
    if (compareDeadline(last, heap[child]) <= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}

function compareDeadline(
  left: ReservationDeadline,
  right: ReservationDeadline
): number {
  return left.at - right.at ||
    left.reservation_id.localeCompare(right.reservation_id) ||
    left.kind.localeCompare(right.kind);
}

function cloneDimensions(input: FlatCapacityState): FlatCapacityState {
  const result: FlatCapacityState = {};
  for (const [key, dimension] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_.]{2,127}$/.test(key)) throw new Error(`invalid capacity dimension ${key}`);
    validateDimension(dimension);
    result[key] = { ...dimension };
  }
  if (Object.keys(result).length === 0) throw new Error('capacity dimensions are required');
  return result;
}

function validateDimension(dimension: CapacityDimensionState): void {
  if (!dimension.unit || !Number.isFinite(dimension.safe_capacity) ||
      dimension.safe_capacity <= 0 || !Number.isFinite(dimension.used) ||
      dimension.used < 0 || !Number.isFinite(dimension.reserved) ||
      dimension.reserved < 0 ||
      dimension.used + dimension.reserved > dimension.safe_capacity) {
    throw new Error('invalid capacity dimension');
  }
}

function validateRequest(request: {
  request_id: string;
  idempotency_key: string;
  tenant_id: string;
  routing_partition_id: string;
  interaction_id: string;
  interaction_kind: InteractionKind;
  profile_id: string;
  required_capacity: CapacityRequirement;
  preferred_cell_id?: string;
  preferred_owner_node_id?: string;
  excluded_owner_node_ids?: string[];
}): void {
  for (const value of [
    request.request_id, request.idempotency_key, request.tenant_id,
    request.routing_partition_id, request.interaction_id
  ]) safeId(value);
  for (const value of [
    request.preferred_cell_id,
    request.preferred_owner_node_id
  ]) {
    if (value !== undefined) safeId(value);
  }
  if (request.excluded_owner_node_ids !== undefined) {
    if (!Array.isArray(request.excluded_owner_node_ids) ||
        request.excluded_owner_node_ids.length > 64 ||
        new Set(request.excluded_owner_node_ids).size !==
          request.excluded_owner_node_ids.length) {
      throw new Error('invalid excluded owner nodes');
    }
    for (const value of request.excluded_owner_node_ids) safeId(value);
    if (request.preferred_owner_node_id &&
        request.excluded_owner_node_ids.includes(request.preferred_owner_node_id)) {
      throw new Error('preferred owner node is excluded');
    }
  }
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(request.profile_id)) {
    throw new Error('invalid admission profile');
  }
  const entries = Object.entries(request.required_capacity);
  if (entries.length === 0) throw new Error('required capacity is empty');
  for (const [key, amount] of entries) {
    if (!/^[a-z][a-z0-9_.]{2,127}$/.test(key) ||
        !Number.isFinite(amount) || amount <= 0) {
      throw new Error('invalid required capacity');
    }
  }
}

function requestHash(request: {
  idempotency_key: string;
  tenant_id: string;
  routing_partition_id: string;
  interaction_id: string;
  interaction_kind: InteractionKind;
  profile_id: string;
  required_capacity: CapacityRequirement;
  preferred_cell_id?: string;
  preferred_owner_node_id?: string;
  excluded_owner_node_ids?: string[];
}): string {
  return createHash('sha256').update(JSON.stringify({
    tenant_id: request.tenant_id,
    routing_partition_id: request.routing_partition_id,
    interaction_id: request.interaction_id,
    interaction_kind: request.interaction_kind,
    profile_id: request.profile_id,
    preferred_cell_id: request.preferred_cell_id || '',
    preferred_owner_node_id: request.preferred_owner_node_id || '',
    excluded_owner_node_ids: [...(request.excluded_owner_node_ids || [])].sort(),
    required_capacity: Object.fromEntries(Object.entries(request.required_capacity).sort())
  })).digest('hex');
}

function checkedRecoveredReservation(
  value: CellAdmissionReservationCheckpoint
): CellAdmissionReservationCheckpoint {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid recovered admission reservation');
  }
  for (const id of [
    value.reservation_id,
    value.region_id,
    value.zone_id,
    value.cell_id,
    value.owner_node_id,
    value.tenant_id,
    value.routing_partition_id,
    value.interaction_id,
    value.idempotency_key
  ]) checkedId(id);
  if (!['reserved', 'active', 'expired', 'closed'].includes(value.state)) {
    throw new Error('invalid recovered admission state');
  }
  if (!['tinode_im', 'sip_voice', 'livekit_av', 'livekit_screen', 'rustdesk_remote']
    .includes(value.interaction_kind)) {
    throw new Error('invalid recovered admission interaction kind');
  }
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(value.profile_id) ||
      !/^[a-f0-9]{64}$/.test(value.payload_hash) ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(value.owner_epoch)) {
    throw new Error('invalid recovered admission identity');
  }
  const createdAt = Date.parse(value.created_at);
  const updatedAt = Date.parse(value.updated_at);
  const expiresAt = Date.parse(value.expires_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) ||
      !Number.isFinite(expiresAt) || updatedAt < createdAt) {
    throw new Error('invalid recovered admission timestamps');
  }
  return structuredClone(value);
}

function validateRecoveredCapacity(
  required: CapacityRequirement,
  cell: FlatCapacityState,
  node: FlatCapacityState
): void {
  const entries = Object.entries(required || {});
  if (entries.length === 0 || entries.some(([key, amount]) =>
    !cell[key] || !node[key] || !Number.isFinite(amount) || amount <= 0
  )) {
    throw new Error('invalid recovered admission capacity');
  }
}

function publicReservation(value: InternalReservation): AdmissionReservation {
  return structuredClone({
    reservation_id: value.reservation_id,
    state: value.state,
    region_id: value.region_id,
    zone_id: value.zone_id,
    cell_id: value.cell_id,
    owner_node_id: value.owner_node_id,
    owner_epoch: value.owner_epoch,
    endpoint: value.endpoint,
    expires_at: value.expires_at,
    required_capacity: value.required_capacity
  });
}

function validAdmissionState(value: AdmissionState): AdmissionState {
  if (!['accepting', 'degraded', 'draining', 'offline'].includes(value)) {
    throw new Error('invalid admission state');
  }
  return value;
}

function checkedAvailabilityGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid node availability generation');
  }
  return value;
}

function validNow(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('invalid admission time');
  return value.getTime();
}

function safeId(value: string): void {
  checkedId(value);
}

function checkedId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(String(value || ''))) {
    throw new Error('invalid admission identifier');
  }
  return value;
}

function checkedUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username || url.password) {
    throw new Error('invalid admission endpoint');
  }
  return url.toString().replace(/\/$/, '');
}

function checkedNodeProfiles(
  values: string[],
  cellProfiles: ReadonlySet<string>
): string[] {
  if (!Array.isArray(values) || values.length === 0 ||
      new Set(values).size !== values.length ||
      values.some((profile) =>
        !/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(profile) ||
        !cellProfiles.has(profile)
      )) {
    throw new Error('invalid admission node profiles');
  }
  return [...values].sort();
}

function checkedNodeInteractionKinds(
  values: InteractionKind[],
  cellKinds: ReadonlySet<InteractionKind>
): InteractionKind[] {
  if (!Array.isArray(values) || values.length === 0 ||
      new Set(values).size !== values.length ||
      values.some((kind) => !cellKinds.has(kind))) {
    throw new Error('invalid admission node interaction kinds');
  }
  return [...values].sort();
}

function componentForKinds(
  values: InteractionKind[]
): 'rustpbx' | 'livekit' | 'tinode' | 'rustdesk' {
  const byKind: Record<
    InteractionKind,
    'rustpbx' | 'livekit' | 'tinode' | 'rustdesk'
  > = {
    tinode_im: 'tinode',
    sip_voice: 'rustpbx',
    livekit_av: 'livekit',
    livekit_screen: 'livekit',
    rustdesk_remote: 'rustdesk'
  };
  const components = new Set(values.map((kind) => byKind[kind]));
  if (components.size !== 1) {
    throw new Error('component admission node control endpoint requires one component');
  }
  return [...components][0];
}
