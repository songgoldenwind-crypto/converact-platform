import { resolveFabricEnv } from '../../../config/converact-env.js';
import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import type {
  MediaCallPlacementPort,
  MediaCallPlacementReservation
} from '../../livekit/media-call-service.js';
import type { MediaBusinessRef } from '../../livekit/types.js';
import {
  type InteractionPlacementCoordinator,
  type InteractionPlacementRecord,
  type InteractionPlacementReconcileResult,
  type ReservedInteractionPlacement
} from './interaction-placement.js';
import type {
  CapacityRequirement,
  PlacementRequest
} from './types.js';
import { PlacementError } from './types.js';

export interface MediaCallPlacementPolicy {
  profile_id: string;
  fixed_capacity: CapacityRequirement;
  per_participant_capacity: CapacityRequirement;
}

export interface InteractionPlacementCoordinatorPort {
  reserve(
    input: PlacementRequest & { owner_component: 'livekit' }
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
      interaction_kind: 'livekit_av';
      interaction_id: string;
      desired_state: 'active' | 'closed';
      reason: string;
    }
  ): Promise<InteractionPlacementRecord | void>;
  reconcileOne(input: {
    tenant_id: string;
    interaction_kind: 'livekit_av';
    interaction_id: string;
    worker_id: string;
  }): Promise<InteractionPlacementReconcileResult>;
  getPlacement(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_kind: 'livekit_av';
      interaction_id: string;
    }
  ): Promise<InteractionPlacementRecord | null>;
  inspectOwner?(
    record: InteractionPlacementRecord
  ): Promise<{
    status: 'eligible' | 'recoverable' | 'unknown';
    reason: string;
  }>;
  persistReplacement?(
    pg: PgQueryable,
    input: {
      reserved: ReservedInteractionPlacement;
      expected_owner_epoch: string;
      expected_reservation_id: string;
      reason: string;
    }
  ): Promise<{
    record: InteractionPlacementRecord;
    replayed: boolean;
  }>;
  reconcileHandoffOne?(input: {
    tenant_id: string;
    interaction_kind: 'livekit_av';
    interaction_id: string;
    worker_id: string;
  }): Promise<'idle' | 'succeeded' | 'retry_wait' | 'failed'>;
}

export class MediaCallPlacementAdapter implements MediaCallPlacementPort {
  readonly coordinator: InteractionPlacementCoordinatorPort;
  readonly #policy: MediaCallPlacementPolicy;

  constructor(input: {
    coordinator: InteractionPlacementCoordinatorPort | InteractionPlacementCoordinator;
    policy: MediaCallPlacementPolicy;
  }) {
    this.coordinator = input.coordinator;
    this.#policy = checkedPolicy(input.policy);
  }

  async reserve(input: {
    tenant_id: string;
    interaction_id: string;
    media: 'voice' | 'video';
    participant_count: number;
    business_ref: MediaBusinessRef;
    idempotency_key: string;
  }): Promise<MediaCallPlacementReservation> {
    const participantCount = boundedInteger(
      input.participant_count,
      1,
      10_000,
      'media placement participant count'
    );
    const reserved = await this.coordinator.reserve({
      request_id: `media:${digest([
        input.tenant_id,
        input.interaction_id,
        'request'
      ])}`,
      idempotency_key: `media:${digest([
        input.tenant_id,
        input.idempotency_key,
        'idempotency'
      ])}`,
      tenant_id: input.tenant_id,
      routing_partition_id: `media:${digest([
        input.tenant_id,
        input.business_ref.type,
        input.business_ref.id
      ])}`,
      interaction_id: input.interaction_id,
      interaction_kind: 'livekit_av',
      profile_id: this.#policy.profile_id,
      required_capacity: compileCapacity(this.#policy, participantCount),
      owner_component: 'livekit'
    });
    return {
      interaction_id: input.interaction_id,
      value: reserved
    };
  }

  async persistReserved(
    pg: PgQueryable,
    reservation: MediaCallPlacementReservation
  ): Promise<void> {
    await this.coordinator.persistReserved(pg, reservedValue(reservation));
  }

  releaseUncommitted(
    reservation: MediaCallPlacementReservation
  ): Promise<void> {
    return this.coordinator.releaseUncommitted(reservedValue(reservation));
  }

  async requestState(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
      desired_state: 'active' | 'closed';
      reason: string;
    }
  ): Promise<void> {
    await this.coordinator.requestState(pg, {
      ...input,
      interaction_kind: 'livekit_av'
    });
  }

  async reconcileOne(input: {
    tenant_id: string;
    interaction_id: string;
    worker_id: string;
  }): Promise<{ outcome: 'idle' | 'succeeded' | 'retry_wait' | 'failed' }> {
    const result = await this.coordinator.reconcileOne({
      ...input,
      interaction_kind: 'livekit_av'
    });
    return { outcome: result.outcome };
  }

  async resolveOwner(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
    }
  ) {
    const record = await this.coordinator.getPlacement(pg, {
      ...input,
      interaction_kind: 'livekit_av'
    });
    if (!record) {
      throw new PlacementError({
        code: 'placement_owner_missing',
        status: 503,
        retryable: true
      });
    }
    if (record.owner_component !== 'livekit' ||
        record.state !== 'active' ||
        record.desired_state !== 'active' ||
        record.sync_state !== 'succeeded') {
      throw new PlacementError({
        code: 'placement_owner_not_active',
        status: 503,
        retryable: true
      });
    }
    return liveKitOwner(record);
  }

  async recoverOwner(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_id: string;
      expected_owner_epoch: string;
      expected_reservation_id: string;
      worker_id: string;
    }
  ) {
    let current = await this.coordinator.getPlacement(pg, {
      tenant_id: input.tenant_id,
      interaction_kind: 'livekit_av',
      interaction_id: input.interaction_id
    });
    if (!current) {
      throw new PlacementError({
        code: 'placement_owner_missing',
        status: 503,
        retryable: true
      });
    }
    if (current.owner_epoch !== input.expected_owner_epoch ||
        current.reservation_id !== input.expected_reservation_id) {
      current = await this.#ensureCurrentOwner(pg, current, input.worker_id);
      return liveKitOwner(current);
    }
    if (!isActiveOwner(current)) {
      current = await this.#ensureCurrentOwner(pg, current, input.worker_id);
      return liveKitOwner(current);
    }
    const inspection = await this.coordinator.inspectOwner?.(current);
    if (!inspection || inspection.status !== 'recoverable' ||
        !this.coordinator.persistReplacement) {
      return liveKitOwner(current);
    }
    const reserved = await this.coordinator.reserve({
      request_id: `media-recovery:${digest([
        input.tenant_id,
        input.interaction_id,
        input.expected_owner_epoch,
        'request'
      ])}`,
      idempotency_key: `media-recovery:${digest([
        input.tenant_id,
        input.interaction_id,
        input.expected_owner_epoch,
        'idempotency'
      ])}`,
      tenant_id: current.tenant_id,
      routing_partition_id: current.routing_partition_id,
      interaction_id: current.interaction_id,
      interaction_kind: 'livekit_av',
      profile_id: current.profile_id,
      required_capacity: current.required_capacity,
      owner_component: 'livekit',
      excluded_owner_node_ids: [current.owner_node_id]
    });
    let adopted = false;
    try {
      await this.coordinator.persistReplacement(pg, {
        reserved,
        expected_owner_epoch: current.owner_epoch,
        expected_reservation_id: current.reservation_id,
        reason: `livekit_owner_recovery:${inspection.reason}`
      });
      adopted = true;
    } catch (error) {
      const latest = await this.coordinator.getPlacement(pg, {
        tenant_id: input.tenant_id,
        interaction_kind: 'livekit_av',
        interaction_id: input.interaction_id
      });
      adopted = latest?.reservation_id === reserved.record.reservation_id &&
        latest.owner_epoch === reserved.record.owner_epoch;
      if (!adopted) {
        await this.coordinator.releaseUncommitted(reserved).catch(() => undefined);
      }
      if (!adopted && (!latest ||
          (error as { code?: unknown })?.code !== 'stale_placement_recovery')) {
        throw error;
      }
    }
    current = await this.#ensureCurrentOwner(pg, reserved.record, input.worker_id);
    if (adopted) {
      await this.coordinator.reconcileHandoffOne?.({
        tenant_id: input.tenant_id,
        interaction_kind: 'livekit_av',
        interaction_id: input.interaction_id,
        worker_id: input.worker_id
      });
    }
    return liveKitOwner(current);
  }

  async #ensureCurrentOwner(
    pg: PgQueryable,
    record: InteractionPlacementRecord,
    workerId: string
  ): Promise<InteractionPlacementRecord> {
    if (!isActiveOwner(record)) {
      await this.coordinator.reconcileOne({
        tenant_id: record.tenant_id,
        interaction_kind: 'livekit_av',
        interaction_id: record.interaction_id,
        worker_id: workerId
      });
    }
    const current = await this.coordinator.getPlacement(pg, {
      tenant_id: record.tenant_id,
      interaction_kind: 'livekit_av',
      interaction_id: record.interaction_id
    });
    if (!current || !isActiveOwner(current)) {
      throw new PlacementError({
        code: 'placement_owner_not_active',
        status: 503,
        retryable: true
      });
    }
    return current;
  }
}

export function mediaCallPlacementPolicyConfig(
  env: NodeJS.ProcessEnv = process.env
): MediaCallPlacementPolicy {
  const raw = String(resolveFabricEnv(env, 'PLACEMENT_MEDIA_POLICY_JSON') || '').trim();
  if (!raw) {
    throw new Error('CONVERACT_FABRIC_PLACEMENT_MEDIA_POLICY_JSON is required');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CONVERACT_FABRIC_PLACEMENT_MEDIA_POLICY_JSON is invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CONVERACT_FABRIC_PLACEMENT_MEDIA_POLICY_JSON must be an object');
  }
  const value = parsed as Record<string, unknown>;
  return checkedPolicy({
    profile_id: String(value.profile_id || ''),
    fixed_capacity: capacityObject(value.fixed_capacity),
    per_participant_capacity: capacityObject(value.per_participant_capacity)
  });
}

function checkedPolicy(policy: MediaCallPlacementPolicy): MediaCallPlacementPolicy {
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(policy.profile_id)) {
    throw new Error('invalid media placement profile');
  }
  const fixed = checkedCapacity(policy.fixed_capacity);
  const perParticipant = checkedCapacity(policy.per_participant_capacity);
  if (Object.keys(fixed).length + Object.keys(perParticipant).length === 0) {
    throw new Error('media placement capacity policy is empty');
  }
  return {
    profile_id: policy.profile_id,
    fixed_capacity: fixed,
    per_participant_capacity: perParticipant
  };
}

function compileCapacity(
  policy: MediaCallPlacementPolicy,
  participantCount: number
): CapacityRequirement {
  const result: CapacityRequirement = { ...policy.fixed_capacity };
  for (const [name, amount] of Object.entries(policy.per_participant_capacity)) {
    result[name] = (result[name] || 0) + amount * participantCount;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right))
  );
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

function checkedCapacity(value: CapacityRequirement): CapacityRequirement {
  const entries = Object.entries(value || {});
  if (entries.some(([name, amount]) =>
    !/^[a-z][a-z0-9_.]{2,127}$/.test(name) ||
    !Number.isFinite(amount) || amount <= 0
  )) {
    throw new Error('invalid media placement capacity');
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function liveKitClientUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol) ||
      url.username || url.password || url.hash) {
    throw new PlacementError({
      code: 'placement_provider_endpoint_invalid',
      status: 503
    });
  }
  return url.toString().replace(/\/$/, '');
}

function liveKitOwner(record: InteractionPlacementRecord) {
  if (record.owner_component !== 'livekit' || !isActiveOwner(record)) {
    throw new PlacementError({
      code: 'placement_owner_not_active',
      status: 503,
      retryable: true
    });
  }
  return {
    interaction_id: record.interaction_id,
    reservation_id: record.reservation_id,
    region_id: record.region_id,
    zone_id: record.zone_id,
    cell_id: record.cell_id,
    owner_node_id: record.owner_node_id,
    owner_epoch: record.owner_epoch,
    profile_id: record.profile_id,
    snapshot_version: record.snapshot_version,
    placement_generation: record.placement_generation,
    livekit_url: liveKitClientUrl(record.provider_endpoint)
  };
}

function isActiveOwner(record: InteractionPlacementRecord): boolean {
  return record.owner_component === 'livekit' &&
    record.state === 'active' &&
    record.desired_state === 'active' &&
    record.sync_state === 'succeeded';
}

function reservedValue(
  reservation: MediaCallPlacementReservation
): ReservedInteractionPlacement {
  const value = reservation.value as ReservedInteractionPlacement | null;
  if (!value || value.record?.interaction_id !== reservation.interaction_id) {
    throw new Error('invalid media placement reservation');
  }
  return value;
}

function digest(parts: string[]): string {
  return createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}
