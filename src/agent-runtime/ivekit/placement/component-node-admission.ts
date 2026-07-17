import {
  compareOwnerEpoch,
  splitOwnerEpoch
} from './owner-epoch.js';
import type {
  CellAdmissionReservationCheckpoint
} from './admission.js';
import type {
  AdmissionState,
  CapacityRequirement,
  FlatCapacityState,
  InteractionKind,
  ReservationState
} from './types.js';

export type ComponentNodeComponent =
  | 'rustpbx'
  | 'livekit'
  | 'tinode'
  | 'rustdesk';

export interface ComponentNodeLeaseHeartbeat {
  component: ComponentNodeComponent;
  region_id: string;
  zone_id: string;
  cell_id: string;
  node_id: string;
  cell_lease_epoch: number;
  state: Exclude<AdmissionState, 'offline'>;
  recovery_complete: boolean;
  observed_at: string;
  expires_at: string;
}

export interface ComponentNodeAuthorizationInput {
  reservation_id: string;
  interaction_id: string;
  owner_epoch: string;
  operation: 'open' | 'mutate' | 'close';
}

export interface ComponentNodeAuthorization {
  allowed: true;
  component: ComponentNodeComponent;
  node_id: string;
  cell_lease_epoch: number;
  owner_epoch: string;
  state_sequence: number;
  lease_expires_at: string;
}

export interface ComponentNodeBatchAuthorizationResult {
  request: ComponentNodeAuthorizationInput;
  authorization?: ComponentNodeAuthorization;
  error?: {
    code: string;
    status: number;
    retryable: boolean;
  };
}

interface ReservationDeadline {
  at: number;
  reservation_id: string;
  kind: 'expire' | 'evict';
}

export class ComponentNodeAdmissionController {
  readonly #identity: {
    component: ComponentNodeComponent;
    region_id: string;
    zone_id: string;
    cell_id: string;
    node_id: string;
    profile_ids: Set<string>;
    interaction_kinds: Set<InteractionKind>;
    terminal_retention_ms: number;
  };
  readonly #dimensions: FlatCapacityState;
  readonly #reservations = new Map<string, CellAdmissionReservationCheckpoint>();
  readonly #deadlines: ReservationDeadline[] = [];
  #state: Exclude<AdmissionState, 'offline'> = 'draining';
  #recoveryPending = true;
  #stickyDrain = false;
  #drainStartedAt = '';
  #cellLeaseEpoch = 0;
  #leaseObservedAt = '';
  #leaseExpiresAt = '';
  #stateSequence = 0;

  constructor(input: {
    component: ComponentNodeComponent;
    region_id: string;
    zone_id: string;
    cell_id: string;
    node_id: string;
    profile_ids: string[];
    interaction_kinds: InteractionKind[];
    terminal_retention_ms?: number;
    dimensions: FlatCapacityState;
  }) {
    for (const value of [
      input.region_id,
      input.zone_id,
      input.cell_id,
      input.node_id
    ]) safeId(value);
    if (!['rustpbx', 'livekit', 'tinode', 'rustdesk'].includes(input.component)) {
      throw new Error('invalid component node component');
    }
    const profiles = checkedProfiles(input.profile_ids);
    const kinds = checkedInteractionKinds(input.interaction_kinds);
    for (const kind of kinds) assertComponentKind(input.component, kind);
    this.#identity = {
      component: input.component,
      region_id: input.region_id,
      zone_id: input.zone_id,
      cell_id: input.cell_id,
      node_id: input.node_id,
      profile_ids: new Set(profiles),
      interaction_kinds: new Set(kinds),
      terminal_retention_ms: boundedInteger(
        input.terminal_retention_ms ?? 300_000,
        1_000,
        86_400_000,
        'component node terminal retention'
      )
    };
    this.#dimensions = cloneDimensions(input.dimensions);
  }

  applyLease(
    heartbeat: ComponentNodeLeaseHeartbeat,
    now: Date
  ): ReturnType<ComponentNodeAdmissionController['snapshot']> {
    const timestamp = validNow(now);
    validateLease(heartbeat, this.#identity, timestamp);
    if (this.#cellLeaseEpoch === 0 && heartbeat.recovery_complete) {
      throw new ComponentNodeAdmissionError(
        'component_node_recovery_required',
        409,
        true
      );
    }
    if (heartbeat.cell_lease_epoch < this.#cellLeaseEpoch) {
      throw new ComponentNodeAdmissionError('stale_cell_lease_epoch', 409, true);
    }
    const observedAt = Date.parse(heartbeat.observed_at);
    if (heartbeat.cell_lease_epoch === this.#cellLeaseEpoch) {
      const currentObservedAt = Date.parse(this.#leaseObservedAt || '1970-01-01T00:00:00.000Z');
      if (observedAt < currentObservedAt) {
        throw new ComponentNodeAdmissionError('stale_component_node_lease', 409, true);
      }
      if (observedAt === currentObservedAt &&
          heartbeat.expires_at === this.#leaseExpiresAt &&
          heartbeat.state === this.#state &&
          heartbeat.recovery_complete === !this.#recoveryPending) {
        return this.snapshot(now);
      }
    }
    this.#cellLeaseEpoch = heartbeat.cell_lease_epoch;
    this.#leaseObservedAt = new Date(observedAt).toISOString();
    this.#leaseExpiresAt = new Date(Date.parse(heartbeat.expires_at)).toISOString();
    this.#recoveryPending = !heartbeat.recovery_complete;
    if (this.#recoveryPending) {
      this.#state = 'draining';
      this.#drainStartedAt ||= now.toISOString();
    } else if (!this.#stickyDrain) {
      this.#state = heartbeat.state;
      this.#drainStartedAt = heartbeat.state === 'draining'
        ? this.#drainStartedAt || now.toISOString()
        : '';
    }
    this.#stateSequence += 1;
    return this.snapshot(now);
  }

  startDrain(now: Date): ReturnType<ComponentNodeAdmissionController['snapshot']> {
    validNow(now);
    this.#stickyDrain = true;
    if (this.#state !== 'draining') {
      this.#state = 'draining';
      this.#drainStartedAt = now.toISOString();
      this.#stateSequence += 1;
    } else {
      this.#drainStartedAt ||= now.toISOString();
    }
    return this.snapshot(now);
  }

  hasReservation(reservationId: string): boolean {
    return this.#reservations.has(reservationId);
  }

  applyReservation(
    value: CellAdmissionReservationCheckpoint,
    now: Date
  ): CellAdmissionReservationCheckpoint {
    const timestamp = validNow(now);
    const checkpoint = checkedCheckpoint(value, this.#identity);
    const owner = splitOwnerEpoch(checkpoint.owner_epoch);
    if (this.#cellLeaseEpoch === 0) {
      throw new ComponentNodeAdmissionError('component_node_lease_missing', 503, true);
    }
    const existing = this.#reservations.get(checkpoint.reservation_id);
    if (!existing && this.#state === 'draining' &&
        (checkpoint.state === 'reserved' || checkpoint.state === 'active')) {
      throw new ComponentNodeAdmissionError('component_node_draining', 503, true);
    }
    if ((checkpoint.state === 'reserved' || checkpoint.state === 'active') &&
        owner.cell_lease_epoch !== this.#cellLeaseEpoch) {
      throw new ComponentNodeAdmissionError(
        owner.cell_lease_epoch < this.#cellLeaseEpoch
          ? 'stale_owner_epoch'
          : 'owner_epoch_ahead',
        409,
        owner.cell_lease_epoch > this.#cellLeaseEpoch
      );
    }
    if (existing) {
      assertSameReservation(existing, checkpoint);
      const transition = stateTransition(existing.state, checkpoint.state);
      if (transition === 'same') return structuredClone(existing);
      if (Date.parse(checkpoint.updated_at) < Date.parse(existing.updated_at)) {
        throw new ComponentNodeAdmissionError(
          'component_reservation_state_regression',
          409
        );
      }
      this.#applyCapacityTransition(existing, checkpoint.state);
      existing.state = checkpoint.state;
      existing.updated_at = checkpoint.updated_at;
      this.#schedule(existing, timestamp);
      this.#stateSequence += 1;
      return structuredClone(existing);
    }
    ensureCapacity(this.#dimensions, checkpoint.required_capacity);
    const stored = structuredClone(checkpoint);
    this.#reservations.set(stored.reservation_id, stored);
    this.#chargeNew(stored);
    this.#schedule(stored, timestamp);
    this.#stateSequence += 1;
    return structuredClone(stored);
  }

  authorize(
    input: ComponentNodeAuthorizationInput,
    now: Date
  ): ComponentNodeAuthorization {
    const timestamp = validNow(now);
    safeId(input.reservation_id);
    safeId(input.interaction_id);
    if (!['open', 'mutate', 'close'].includes(input.operation)) {
      throw new ComponentNodeAdmissionError('component_operation_invalid', 400);
    }
    const reservation = this.#reservations.get(input.reservation_id);
    if (!reservation || reservation.interaction_id !== input.interaction_id) {
      throw new ComponentNodeAdmissionError('component_reservation_not_found', 404);
    }
    const comparison = compareOwnerEpoch(input.owner_epoch, reservation.owner_epoch);
    if (comparison !== 0) {
      throw new ComponentNodeAdmissionError(
        comparison < 0 ? 'stale_owner_epoch' : 'owner_epoch_ahead',
        409,
        comparison > 0
      );
    }
    if (input.operation !== 'close') {
      this.#requireFreshLease(timestamp);
      const owner = splitOwnerEpoch(input.owner_epoch);
      if (owner.cell_lease_epoch !== this.#cellLeaseEpoch) {
        throw new ComponentNodeAdmissionError(
          owner.cell_lease_epoch < this.#cellLeaseEpoch
            ? 'stale_owner_epoch'
            : 'owner_epoch_ahead',
          409,
          owner.cell_lease_epoch > this.#cellLeaseEpoch
        );
      }
    }
    if (input.operation === 'open' &&
        reservation.state !== 'reserved' && reservation.state !== 'active') {
      throw new ComponentNodeAdmissionError('component_reservation_not_openable', 409);
    }
    if (input.operation === 'mutate' && reservation.state !== 'active') {
      throw new ComponentNodeAdmissionError('component_reservation_not_active', 409);
    }
    return {
      allowed: true,
      component: this.#identity.component,
      node_id: this.#identity.node_id,
      cell_lease_epoch: this.#cellLeaseEpoch,
      owner_epoch: reservation.owner_epoch,
      state_sequence: this.#stateSequence,
      lease_expires_at: this.#leaseExpiresAt
    };
  }

  authorizeBatch(
    inputs: ComponentNodeAuthorizationInput[],
    now: Date
  ): ComponentNodeBatchAuthorizationResult[] {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 64) {
      throw new ComponentNodeAdmissionError(
        'component_authorization_batch_invalid',
        400
      );
    }
    return inputs.map((input) => {
      try {
        return {
          request: structuredClone(input),
          authorization: this.authorize(input, now)
        };
      } catch (error) {
        if (!(error instanceof ComponentNodeAdmissionError)) throw error;
        return {
          request: structuredClone(input),
          error: {
            code: error.code,
            status: error.status,
            retryable: error.retryable
          }
        };
      }
    });
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
        this.#applyCapacityTransition(reservation, 'expired');
        reservation.state = 'expired';
        reservation.updated_at = now.toISOString();
        this.#schedule(reservation, timestamp);
        this.#stateSequence += 1;
        expired += 1;
      } else if (deadline.kind === 'evict' &&
          (reservation.state === 'closed' || reservation.state === 'expired') &&
          Date.parse(reservation.updated_at) +
            this.#identity.terminal_retention_ms <= timestamp) {
        this.#reservations.delete(reservation.reservation_id);
        this.#stateSequence += 1;
      }
    }
    return expired;
  }

  snapshot(now: Date): {
    component: ComponentNodeComponent;
    region_id: string;
    zone_id: string;
    cell_id: string;
    node_id: string;
    state: Exclude<AdmissionState, 'offline'>;
    state_sequence: number;
    drain_started_at: string;
    cell_lease_epoch: number;
    lease_observed_at: string;
    lease_expires_at: string;
    lease_fresh: boolean;
    recovery_pending: boolean;
    dimensions: FlatCapacityState;
    reservations: Record<ReservationState, number>;
  } {
    const timestamp = validNow(now);
    const counts: Record<ReservationState, number> = {
      reserved: 0,
      active: 0,
      expired: 0,
      closed: 0
    };
    for (const reservation of this.#reservations.values()) {
      counts[reservation.state] += 1;
    }
    return structuredClone({
      component: this.#identity.component,
      region_id: this.#identity.region_id,
      zone_id: this.#identity.zone_id,
      cell_id: this.#identity.cell_id,
      node_id: this.#identity.node_id,
      state: this.#state,
      state_sequence: this.#stateSequence,
      drain_started_at: this.#drainStartedAt,
      cell_lease_epoch: this.#cellLeaseEpoch,
      lease_observed_at: this.#leaseObservedAt,
      lease_expires_at: this.#leaseExpiresAt,
      lease_fresh: Boolean(this.#leaseExpiresAt) &&
        timestamp < Date.parse(this.#leaseExpiresAt),
      recovery_pending: this.#recoveryPending,
      dimensions: this.#dimensions,
      reservations: counts
    });
  }

  #requireFreshLease(timestamp: number): void {
    if (!this.#leaseExpiresAt) {
      throw new ComponentNodeAdmissionError('component_node_lease_missing', 503, true);
    }
    if (timestamp >= Date.parse(this.#leaseExpiresAt)) {
      throw new ComponentNodeAdmissionError('component_node_lease_expired', 503, true);
    }
  }

  #chargeNew(reservation: CellAdmissionReservationCheckpoint): void {
    if (reservation.state === 'reserved') {
      addCapacity(this.#dimensions, reservation.required_capacity, 'reserved', 1);
    } else if (reservation.state === 'active') {
      addCapacity(this.#dimensions, reservation.required_capacity, 'used', 1);
    }
  }

  #applyCapacityTransition(
    reservation: CellAdmissionReservationCheckpoint,
    next: ReservationState
  ): void {
    if (reservation.state === 'reserved' && next === 'active') {
      addCapacity(this.#dimensions, reservation.required_capacity, 'reserved', -1);
      addCapacity(this.#dimensions, reservation.required_capacity, 'used', 1);
    } else if (reservation.state === 'reserved' &&
        (next === 'closed' || next === 'expired')) {
      addCapacity(this.#dimensions, reservation.required_capacity, 'reserved', -1);
    } else if (reservation.state === 'active' && next === 'closed') {
      addCapacity(this.#dimensions, reservation.required_capacity, 'used', -1);
    }
  }

  #schedule(
    reservation: CellAdmissionReservationCheckpoint,
    now: number
  ): void {
    if (reservation.state === 'reserved') {
      pushDeadline(this.#deadlines, {
        at: Date.parse(reservation.expires_at),
        reservation_id: reservation.reservation_id,
        kind: 'expire'
      });
    } else if (reservation.state === 'closed' || reservation.state === 'expired') {
      pushDeadline(this.#deadlines, {
        at: Math.max(now, Date.parse(reservation.updated_at)) +
          this.#identity.terminal_retention_ms,
        reservation_id: reservation.reservation_id,
        kind: 'evict'
      });
    }
  }
}

export class ComponentNodeAdmissionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false
  ) {
    super(code);
    this.name = 'ComponentNodeAdmissionError';
  }
}

function validateLease(
  heartbeat: ComponentNodeLeaseHeartbeat,
  identity: {
    component: ComponentNodeComponent;
    region_id: string;
    zone_id: string;
    cell_id: string;
    node_id: string;
  },
  now: number
): void {
  if (heartbeat.component !== identity.component ||
      heartbeat.region_id !== identity.region_id ||
      heartbeat.zone_id !== identity.zone_id ||
      heartbeat.cell_id !== identity.cell_id ||
      heartbeat.node_id !== identity.node_id) {
    throw new ComponentNodeAdmissionError('component_node_identity_mismatch', 409);
  }
  if (!Number.isInteger(heartbeat.cell_lease_epoch) ||
      heartbeat.cell_lease_epoch < 1 || heartbeat.cell_lease_epoch > 0xffff_ffff) {
    throw new ComponentNodeAdmissionError('invalid_cell_lease_epoch', 400);
  }
  if (!['accepting', 'degraded', 'draining'].includes(heartbeat.state)) {
    throw new ComponentNodeAdmissionError('component_node_state_invalid', 400);
  }
  if (typeof heartbeat.recovery_complete !== 'boolean' ||
      (!heartbeat.recovery_complete && heartbeat.state !== 'draining')) {
    throw new ComponentNodeAdmissionError('component_node_recovery_state_invalid', 400);
  }
  const observedAt = Date.parse(heartbeat.observed_at);
  const expiresAt = Date.parse(heartbeat.expires_at);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) ||
      observedAt > now + 5_000 || expiresAt <= now ||
      expiresAt <= observedAt || expiresAt - observedAt > 300_000) {
    throw new ComponentNodeAdmissionError('component_node_lease_timestamp_invalid', 400);
  }
}

function checkedCheckpoint(
  value: CellAdmissionReservationCheckpoint,
  identity: {
    component: ComponentNodeComponent;
    region_id: string;
    zone_id: string;
    cell_id: string;
    node_id: string;
    profile_ids: Set<string>;
    interaction_kinds: Set<InteractionKind>;
  }
): CellAdmissionReservationCheckpoint {
  if (!value || typeof value !== 'object') {
    throw new ComponentNodeAdmissionError('component_reservation_invalid', 400);
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
  ]) safeId(id);
  if (value.region_id !== identity.region_id ||
      value.zone_id !== identity.zone_id ||
      value.cell_id !== identity.cell_id ||
      value.owner_node_id !== identity.node_id) {
    throw new ComponentNodeAdmissionError('component_reservation_target_mismatch', 409);
  }
  if (!identity.profile_ids.has(value.profile_id) ||
      !identity.interaction_kinds.has(value.interaction_kind)) {
    throw new ComponentNodeAdmissionError('component_reservation_capability_mismatch', 409);
  }
  assertComponentKind(identity.component, value.interaction_kind);
  if (!['reserved', 'active', 'expired', 'closed'].includes(value.state) ||
      !/^[a-f0-9]{64}$/.test(value.payload_hash) ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(value.owner_epoch)) {
    throw new ComponentNodeAdmissionError('component_reservation_invalid', 400);
  }
  checkedUrl(value.endpoint);
  const createdAt = Date.parse(value.created_at);
  const updatedAt = Date.parse(value.updated_at);
  const expiresAt = Date.parse(value.expires_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) ||
      !Number.isFinite(expiresAt) || updatedAt < createdAt) {
    throw new ComponentNodeAdmissionError('component_reservation_timestamp_invalid', 400);
  }
  validateCapacity(value.required_capacity);
  return structuredClone(value);
}

function assertSameReservation(
  existing: CellAdmissionReservationCheckpoint,
  incoming: CellAdmissionReservationCheckpoint
): void {
  const fields = [
    'region_id',
    'zone_id',
    'cell_id',
    'owner_node_id',
    'owner_epoch',
    'endpoint',
    'tenant_id',
    'routing_partition_id',
    'interaction_id',
    'interaction_kind',
    'profile_id',
    'idempotency_key',
    'payload_hash',
    'created_at',
    'expires_at'
  ] as const;
  if (fields.some((field) => existing[field] !== incoming[field]) ||
      capacityFingerprint(existing.required_capacity) !==
        capacityFingerprint(incoming.required_capacity)) {
    throw new ComponentNodeAdmissionError('component_reservation_conflict', 409);
  }
}

function stateTransition(
  current: ReservationState,
  next: ReservationState
): 'same' | 'advance' {
  if (current === next) return 'same';
  const allowed =
    (current === 'reserved' && ['active', 'closed', 'expired'].includes(next)) ||
    (current === 'active' && next === 'closed') ||
    (current === 'expired' && next === 'closed');
  if (!allowed) {
    throw new ComponentNodeAdmissionError(
      'component_reservation_state_regression',
      409
    );
  }
  return 'advance';
}

function assertComponentKind(
  component: ComponentNodeComponent,
  kind: InteractionKind
): void {
  const expected: Record<InteractionKind, ComponentNodeComponent> = {
    tinode_im: 'tinode',
    sip_voice: 'rustpbx',
    livekit_av: 'livekit',
    livekit_screen: 'livekit',
    rustdesk_remote: 'rustdesk'
  };
  if (expected[kind] !== component) {
    throw new ComponentNodeAdmissionError('component_interaction_kind_mismatch', 409);
  }
}

function ensureCapacity(
  dimensions: FlatCapacityState,
  required: CapacityRequirement
): void {
  for (const [name, amount] of Object.entries(required)) {
    const dimension = dimensions[name];
    if (!dimension ||
        dimension.used + dimension.reserved + amount > dimension.safe_capacity) {
      throw new ComponentNodeAdmissionError('component_node_capacity_exhausted', 503, true);
    }
  }
}

function addCapacity(
  dimensions: FlatCapacityState,
  required: CapacityRequirement,
  field: 'used' | 'reserved',
  direction: 1 | -1
): void {
  for (const [name, amount] of Object.entries(required)) {
    const next = dimensions[name][field] + amount * direction;
    if (next < 0) throw new Error(`component node capacity underflow for ${name}`);
    dimensions[name][field] = next;
  }
}

function validateCapacity(value: CapacityRequirement): void {
  const entries = Object.entries(value || {});
  if (entries.length === 0 || entries.some(([name, amount]) =>
    !/^[a-z][a-z0-9_.]{2,127}$/.test(name) ||
    !Number.isFinite(amount) || amount <= 0
  )) {
    throw new ComponentNodeAdmissionError('component_reservation_capacity_invalid', 400);
  }
}

function cloneDimensions(input: FlatCapacityState): FlatCapacityState {
  const result: FlatCapacityState = {};
  for (const [name, dimension] of Object.entries(input || {})) {
    if (!/^[a-z][a-z0-9_.]{2,127}$/.test(name) ||
        !dimension.unit || dimension.unit.length > 64 ||
        !Number.isFinite(dimension.safe_capacity) || dimension.safe_capacity <= 0 ||
        !Number.isFinite(dimension.used) || dimension.used < 0 ||
        !Number.isFinite(dimension.reserved) || dimension.reserved < 0 ||
        dimension.used + dimension.reserved > dimension.safe_capacity) {
      throw new Error('invalid component node capacity dimension');
    }
    result[name] = { ...dimension };
  }
  if (Object.keys(result).length === 0) {
    throw new Error('component node capacity dimensions are required');
  }
  return result;
}

function checkedProfiles(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0 ||
      new Set(values).size !== values.length ||
      values.some((value) => !/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(value))) {
    throw new Error('invalid component node profiles');
  }
  return [...values].sort();
}

function checkedInteractionKinds(values: InteractionKind[]): InteractionKind[] {
  const allowed = new Set<InteractionKind>([
    'tinode_im',
    'sip_voice',
    'livekit_av',
    'livekit_screen',
    'rustdesk_remote'
  ]);
  if (!Array.isArray(values) || values.length === 0 ||
      new Set(values).size !== values.length ||
      values.some((value) => !allowed.has(value))) {
    throw new Error('invalid component node interaction kinds');
  }
  return [...values].sort();
}

function capacityFingerprint(value: CapacityRequirement): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort()));
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

function compareDeadline(left: ReservationDeadline, right: ReservationDeadline): number {
  return left.at - right.at ||
    left.reservation_id.localeCompare(right.reservation_id) ||
    left.kind.localeCompare(right.kind);
}

function checkedUrl(value: string): void {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ComponentNodeAdmissionError('component_reservation_endpoint_invalid', 400);
  }
}

function safeId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/.test(String(value || ''))) {
    throw new ComponentNodeAdmissionError('component_node_identifier_invalid', 400);
  }
}

function validNow(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid component node time');
  }
  return value.getTime();
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}
