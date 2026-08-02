import { resolveConveractEnv } from '../../../config/converact-env.js';
import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import {
  type InteractionPlacementCoordinator,
  type InteractionPlacementOwnerComponent,
  type InteractionPlacementRecord,
  type InteractionPlacementReconcileResult,
  type ReservedInteractionPlacement
} from './interaction-placement.js';
import {
  PlacementError,
  type CapacityRequirement,
  type InteractionKind,
  type PlacementRequest
} from './types.js';

export interface ComponentPlacementPolicy {
  profile_id: string;
  fixed_capacity: CapacityRequirement;
}

export interface ComponentPlacementReservation {
  interaction_id: string;
  value: ReservedInteractionPlacement;
}

export interface ComponentPlacementOwner {
  interaction_kind: InteractionKind;
  owner_component: InteractionPlacementOwnerComponent;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  reservation_id: string;
  profile_id: string;
  snapshot_version: number;
  placement_generation: number;
  provider_endpoint: string;
}

export interface ComponentPlacementCoordinatorPort {
  reserve(
    input: PlacementRequest & {
      owner_component: InteractionPlacementOwnerComponent;
    }
  ): Promise<ReservedInteractionPlacement>;
  persistReserved(
    pg: PgQueryable,
    reserved: ReservedInteractionPlacement
  ): Promise<InteractionPlacementRecord | void>;
  releaseUncommitted(reserved: ReservedInteractionPlacement): Promise<void>;
  requestState(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_kind: InteractionKind;
      interaction_id: string;
      desired_state: 'active' | 'closed';
      reason: string;
      expected_reservation_id?: string;
      expected_owner_epoch?: string;
    }
  ): Promise<InteractionPlacementRecord | void>;
  reconcileOne(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    worker_id: string;
  }): Promise<InteractionPlacementReconcileResult>;
  getPlacement(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_kind: InteractionKind;
      interaction_id: string;
    }
  ): Promise<InteractionPlacementRecord | null>;
}

export class ComponentPlacementAdapter {
  readonly #coordinator: ComponentPlacementCoordinatorPort;
  readonly #interactionKind: InteractionKind;
  readonly #ownerComponent: InteractionPlacementOwnerComponent;
  readonly #policy: ComponentPlacementPolicy;

  constructor(input: {
    coordinator: ComponentPlacementCoordinatorPort | InteractionPlacementCoordinator;
    interaction_kind: InteractionKind;
    owner_component: InteractionPlacementOwnerComponent;
    policy: ComponentPlacementPolicy;
  }) {
    this.#coordinator = input.coordinator;
    this.#interactionKind = input.interaction_kind;
    this.#ownerComponent = input.owner_component;
    this.#policy = checkedPolicy(input.policy);
    assertComponentPair(this.#interactionKind, this.#ownerComponent);
  }

  async reserve(input: {
    tenant_id: string;
    interaction_id: string;
    routing_partition_key: string;
    idempotency_key: string;
    preferred_cell_id?: string;
    preferred_owner_node_id?: string;
  }): Promise<ComponentPlacementReservation> {
    const reserved = await this.#coordinator.reserve({
      request_id: `${this.#interactionKind}:${digest([
        input.tenant_id,
        input.interaction_id,
        'request'
      ])}`,
      idempotency_key: `${this.#interactionKind}:${digest([
        input.tenant_id,
        input.idempotency_key,
        'idempotency'
      ])}`,
      tenant_id: checkedIdentifier(input.tenant_id, 'tenant ID'),
      routing_partition_id: `${this.#interactionKind}:${digest([
        input.tenant_id,
        checkedRoutingKey(input.routing_partition_key)
      ])}`,
      interaction_id: checkedIdentifier(input.interaction_id, 'interaction ID'),
      interaction_kind: this.#interactionKind,
      profile_id: this.#policy.profile_id,
      required_capacity: { ...this.#policy.fixed_capacity },
      owner_component: this.#ownerComponent,
      ...(input.preferred_cell_id
        ? { preferred_cell_id: input.preferred_cell_id }
        : {}),
      ...(input.preferred_owner_node_id
        ? { preferred_owner_node_id: input.preferred_owner_node_id }
        : {})
    });
    return {
      interaction_id: input.interaction_id,
      value: reserved
    };
  }

  async persistReserved(
    pg: PgQueryable,
    reservation: ComponentPlacementReservation
  ): Promise<void> {
    await this.#coordinator.persistReserved(pg, reservationValue(reservation));
  }

  async hasPlacement(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
    }
  ): Promise<boolean> {
    const record = await this.#coordinator.getPlacement(pg, {
      tenant_id: input.tenant_id,
      interaction_kind: this.#interactionKind,
      interaction_id: input.interaction_id
    });
    return record?.owner_component === this.#ownerComponent;
  }

  releaseUncommitted(
    reservation: ComponentPlacementReservation
  ): Promise<void> {
    return this.#coordinator.releaseUncommitted(reservationValue(reservation));
  }

  async requestState(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
      desired_state: 'active' | 'closed';
      reason: string;
      expected_reservation_id?: string;
      expected_owner_epoch?: string;
    }
  ): Promise<void> {
    await this.#coordinator.requestState(pg, {
      ...input,
      interaction_kind: this.#interactionKind
    });
  }

  async reconcileOne(input: {
    tenant_id: string;
    interaction_id: string;
    worker_id: string;
  }): Promise<InteractionPlacementReconcileResult['outcome']> {
    const result = await this.#coordinator.reconcileOne({
      ...input,
      interaction_kind: this.#interactionKind
    });
    return result.outcome;
  }

  async resolveOwner(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
      require_active?: boolean;
    }
  ): Promise<ComponentPlacementOwner> {
    const record = await this.#coordinator.getPlacement(pg, {
      tenant_id: input.tenant_id,
      interaction_kind: this.#interactionKind,
      interaction_id: input.interaction_id
    });
    if (!record) {
      throw new PlacementError({
        code: 'placement_owner_missing',
        status: 503,
        retryable: true
      });
    }
    const requireActive = input.require_active !== false;
    if (record.owner_component !== this.#ownerComponent ||
        (requireActive && (
          record.state !== 'active' ||
          record.desired_state !== 'active' ||
          record.sync_state !== 'succeeded'
        ))) {
      throw new PlacementError({
        code: 'placement_owner_not_active',
        status: 503,
        retryable: true
      });
    }
    return {
      interaction_kind: record.interaction_kind,
      owner_component: record.owner_component,
      region_id: record.region_id,
      zone_id: record.zone_id,
      cell_id: record.cell_id,
      owner_node_id: record.owner_node_id,
      owner_epoch: record.owner_epoch,
      reservation_id: record.reservation_id,
      profile_id: record.profile_id,
      snapshot_version: record.snapshot_version,
      placement_generation: record.placement_generation,
      provider_endpoint: record.provider_endpoint
    };
  }
}

export function componentPlacementPolicyConfig(
  env: NodeJS.ProcessEnv,
  envName: string
): ComponentPlacementPolicy {
  const raw = String(resolveConveractEnv(env, envName) || '').trim();
  if (!raw) throw new Error(`${envName} is required`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${envName} is invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${envName} must be an object`);
  }
  const value = parsed as Record<string, unknown>;
  return checkedPolicy({
    profile_id: String(value.profile_id || ''),
    fixed_capacity: capacityObject(value.fixed_capacity)
  });
}

function checkedPolicy(policy: ComponentPlacementPolicy): ComponentPlacementPolicy {
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(policy.profile_id)) {
    throw new Error('invalid component placement profile');
  }
  const fixedCapacity = checkedCapacity(policy.fixed_capacity);
  if (Object.keys(fixedCapacity).length === 0) {
    throw new Error('component placement capacity policy is empty');
  }
  return {
    profile_id: policy.profile_id,
    fixed_capacity: fixedCapacity
  };
}

function assertComponentPair(
  interactionKind: InteractionKind,
  ownerComponent: InteractionPlacementOwnerComponent
): void {
  const expected: Record<InteractionKind, InteractionPlacementOwnerComponent> = {
    tinode_im: 'tinode',
    sip_voice: 'rustpbx',
    livekit_av: 'livekit',
    livekit_screen: 'livekit',
    rustdesk_remote: 'rustdesk'
  };
  if (expected[interactionKind] !== ownerComponent) {
    throw new Error('placement interaction kind and owner component mismatch');
  }
}

function reservationValue(
  reservation: ComponentPlacementReservation
): ReservedInteractionPlacement {
  if (reservation.value.record.interaction_id !== reservation.interaction_id) {
    throw new Error('component placement reservation mismatch');
  }
  return reservation.value;
}

function checkedCapacity(value: CapacityRequirement): CapacityRequirement {
  const entries = Object.entries(value || {});
  if (entries.some(([name, amount]) =>
    !/^[a-z][a-z0-9_.]{2,127}$/.test(name) ||
    !Number.isFinite(amount) || amount <= 0
  )) {
    throw new Error('invalid component placement capacity');
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function capacityObject(value: unknown): CapacityRequirement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, amount]) => [
      key,
      Number(amount)
    ])
  );
}

function checkedIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(String(value || ''))) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function checkedRoutingKey(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 2_048 || /[\0\r\n]/.test(normalized)) {
    throw new Error('invalid placement routing partition key');
  }
  return normalized;
}

function digest(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}
