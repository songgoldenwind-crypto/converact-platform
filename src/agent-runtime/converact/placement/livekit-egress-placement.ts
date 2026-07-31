import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import type {
  LiveKitEgressPlacementInput,
  LiveKitEgressPlacementReservation
} from '../../livekit/types.js';
import {
  ComponentPlacementAdapter,
  componentPlacementPolicyConfig,
  type ComponentPlacementCoordinatorPort,
  type ComponentPlacementPolicy,
  type ComponentPlacementReservation
} from './component-placement.js';
import type { InteractionPlacementCoordinator } from './interaction-placement.js';

export interface LiveKitEgressPlacementPolicies {
  track: ComponentPlacementPolicy;
  composite: ComponentPlacementPolicy;
}

export interface LiveKitEgressPlacementPort {
  reserveJob(
    pg: PgQueryable,
    input: LiveKitEgressPlacementInput
  ): Promise<LiveKitEgressPlacementReservation>;
  activateJob(pg: PgQueryable, value: LiveKitEgressPlacementReservation): Promise<void>;
  closeJob(
    pg: PgQueryable,
    value: LiveKitEgressPlacementReservation,
    reason: string
  ): Promise<void>;
  closeJobById(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      job_id: string;
      reservation_id: string;
      owner_epoch: string;
      reason: string;
    }
  ): Promise<void>;
}

interface EgressReservationValue {
  tenant_id: string;
  reservation: ComponentPlacementReservation;
  pool: 'track' | 'composite';
}

export class LiveKitEgressPlacementAdapter {
  readonly #track: ComponentPlacementAdapter;
  readonly #composite: ComponentPlacementAdapter;

  constructor(input: {
    coordinator: ComponentPlacementCoordinatorPort | InteractionPlacementCoordinator;
    policies: LiveKitEgressPlacementPolicies;
  }) {
    const policies = checkedPolicies(input.policies);
    this.#track = new ComponentPlacementAdapter({
      coordinator: input.coordinator,
      interaction_kind: 'livekit_av',
      owner_component: 'livekit',
      policy: policies.track
    });
    this.#composite = new ComponentPlacementAdapter({
      coordinator: input.coordinator,
      interaction_kind: 'livekit_av',
      owner_component: 'livekit',
      policy: policies.composite
    });
  }

  async reserveJob(
    pg: PgQueryable,
    input: LiveKitEgressPlacementInput
  ): Promise<LiveKitEgressPlacementReservation> {
    const pool = input.recording_mode === 'track' ? 'track' : 'composite';
    const adapter = pool === 'track' ? this.#track : this.#composite;
    const reservation = await adapter.reserve({
      tenant_id: input.tenant_id,
      interaction_id: input.job_id,
      routing_partition_key: [
        input.room_name,
        input.business_ref?.type || '',
        input.business_ref?.id || ''
      ].join(':'),
      idempotency_key: `livekit-egress:${input.recording_id}:${input.job_id}`
    });
    try {
      await withPgTenant(pg, input.tenant_id, (tenantPg) =>
        adapter.persistReserved(tenantPg, reservation)
      );
    } catch (cause) {
      await adapter.releaseUncommitted(reservation).catch(() => undefined);
      throw cause;
    }
    return {
      job_id: input.job_id,
      reservation_id: reservation.value.record.reservation_id,
      owner_epoch: reservation.value.record.owner_epoch,
      value: { tenant_id: input.tenant_id, reservation, pool } satisfies EgressReservationValue
    };
  }

  activateJob(
    pg: PgQueryable,
    value: LiveKitEgressPlacementReservation
  ): Promise<void> {
    const reservation = reservationValue(value);
    return withPgTenant(pg, reservation.tenant_id, (tenantPg) =>
      this.#adapter(reservation.pool).requestState(tenantPg, {
        tenant_id: reservation.tenant_id,
        interaction_id: value.job_id,
        desired_state: 'active',
        reason: 'egress_provider_started',
        expected_reservation_id: value.reservation_id,
        expected_owner_epoch: value.owner_epoch
      })
    );
  }

  closeJob(
    pg: PgQueryable,
    value: LiveKitEgressPlacementReservation,
    reason: string
  ): Promise<void> {
    const reservation = reservationValue(value);
    return this.closeJobById(pg, {
      tenant_id: reservation.tenant_id,
      job_id: value.job_id,
      reservation_id: value.reservation_id,
      owner_epoch: value.owner_epoch,
      reason
    });
  }

  closeJobById(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      job_id: string;
      reservation_id: string;
      owner_epoch: string;
      reason: string;
    }
  ): Promise<void> {
    return withPgTenant(pg, input.tenant_id, (tenantPg) =>
      this.#track.requestState(tenantPg, {
        tenant_id: input.tenant_id,
        interaction_id: input.job_id,
        desired_state: 'closed',
        reason: checkedReason(input.reason),
        expected_reservation_id: checkedIdentifier(input.reservation_id, 'reservation ID'),
        expected_owner_epoch: checkedOwnerEpoch(input.owner_epoch)
      })
    );
  }

  #adapter(pool: EgressReservationValue['pool']): ComponentPlacementAdapter {
    return pool === 'track' ? this.#track : this.#composite;
  }
}

export function liveKitEgressPlacementPolicies(
  env: NodeJS.ProcessEnv
): LiveKitEgressPlacementPolicies {
  return checkedPolicies({
    track: componentPlacementPolicyConfig(
      env,
      'CONVERACT_FABRIC_PLACEMENT_EGRESS_TRACK_POLICY_JSON'
    ),
    composite: componentPlacementPolicyConfig(
      env,
      'CONVERACT_FABRIC_PLACEMENT_EGRESS_COMPOSITE_POLICY_JSON'
    )
  });
}

function checkedPolicies(policies: LiveKitEgressPlacementPolicies): LiveKitEgressPlacementPolicies {
  if (policies.track.profile_id !== policies.composite.profile_id) {
    throw new Error('LiveKit Egress placement policies must use one profile');
  }
  const trackDimensions = new Set(Object.keys(policies.track.fixed_capacity));
  const overlap = Object.keys(policies.composite.fixed_capacity).filter((key) => trackDimensions.has(key));
  if (overlap.length > 0) {
    throw new Error('LiveKit Egress Track and Composite must use disjoint capacity dimensions');
  }
  return policies;
}

function reservationValue(value: LiveKitEgressPlacementReservation): EgressReservationValue {
  const candidate = value.value as Partial<EgressReservationValue> | undefined;
  if (!candidate || !candidate.tenant_id || !candidate.reservation ||
      (candidate.pool !== 'track' && candidate.pool !== 'composite') ||
      candidate.reservation.interaction_id !== value.job_id ||
      candidate.reservation.value.record.reservation_id !== value.reservation_id ||
      candidate.reservation.value.record.owner_epoch !== value.owner_epoch) {
    throw new Error('invalid LiveKit Egress placement reservation');
  }
  return candidate as EgressReservationValue;
}

function checkedReason(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 200 || /[\0\r\n]/.test(normalized)) {
    throw new Error('invalid LiveKit Egress placement close reason');
  }
  return normalized;
}

function checkedIdentifier(value: string, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 255 || /[\0\r\n]/.test(normalized)) {
    throw new Error(`invalid LiveKit Egress ${field}`);
  }
  return normalized;
}

function checkedOwnerEpoch(value: string): string {
  const normalized = String(value || '').trim();
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(normalized) ||
      BigInt(normalized) > 18_446_744_073_709_551_615n) {
    throw new Error('invalid LiveKit Egress owner epoch');
  }
  return normalized;
}
