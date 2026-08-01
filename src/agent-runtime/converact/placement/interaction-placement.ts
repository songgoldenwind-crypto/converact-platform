import { createHash, randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import { ConveractFabricTenantEventJournal } from '../tenant-event-store.js';
import { HttpCellAdmissionClient } from './admission-http.js';
import { splitOwnerEpoch } from './owner-epoch.js';
import {
  PlacementError,
  type AdmissionReservation,
  type CapacityRequirement,
  type CellReservationLifecyclePort,
  type InteractionKind,
  type PlacementDecision,
  type PlacementRequest
} from './types.js';

export type InteractionPlacementOwnerComponent =
  | 'rustpbx'
  | 'livekit'
  | 'tinode'
  | 'rustdesk';

export type InteractionPlacementState =
  | 'reserved'
  | 'active'
  | 'draining'
  | 'recovering'
  | 'closed'
  | 'expired';

export type InteractionPlacementDesiredState = 'reserved' | 'active' | 'closed';
export type InteractionPlacementSyncState =
  | 'succeeded'
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'failed';

export interface InteractionPlacementRecord {
  id: string;
  tenant_id: string;
  interaction_id: string;
  interaction_kind: InteractionKind;
  routing_partition_id: string;
  profile_id: string;
  owner_component: InteractionPlacementOwnerComponent;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  cell_lease_epoch: number;
  reservation_id: string;
  reservation_expires_at: string;
  admission_endpoint: string;
  provider_endpoint: string;
  snapshot_version: number;
  placement_generation: number;
  required_capacity: CapacityRequirement;
  placement_token_sha256: string;
  state: InteractionPlacementState;
  desired_state: InteractionPlacementDesiredState;
  sync_state: InteractionPlacementSyncState;
  lifecycle_reason: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  last_error_code: string;
  last_error_message: string;
  revision: number;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  closed_at: string | null;
}

export type InteractionPlacementHandoffState =
  | 'prepared'
  | 'source_close_pending'
  | 'completed'
  | 'failed';

export type InteractionPlacementHandoffSyncState =
  | 'waiting'
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'failed'
  | 'succeeded';

export interface InteractionPlacementHandoffRecord {
  id: string;
  tenant_id: string;
  interaction_id: string;
  interaction_kind: InteractionKind;
  placement_generation: number;
  from_region_id: string;
  from_zone_id: string;
  from_cell_id: string;
  from_owner_node_id: string;
  from_owner_epoch: string;
  from_reservation_id: string;
  from_admission_endpoint: string;
  from_provider_endpoint: string;
  from_required_capacity: CapacityRequirement;
  to_owner_node_id: string;
  to_owner_epoch: string;
  to_reservation_id: string;
  state: InteractionPlacementHandoffState;
  sync_state: InteractionPlacementHandoffSyncState;
  reason: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  last_error_code: string;
  last_error_message: string;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ReservedInteractionPlacement {
  request: PlacementRequest;
  owner_component: InteractionPlacementOwnerComponent;
  decision: PlacementDecision;
  record: InteractionPlacementRecord;
  signed_placement_token: string;
}

export interface InteractionPlacementEvent {
  tenant_id: string;
  type:
    | 'placement.reserved'
    | 'placement.activated'
    | 'placement.closed'
    | 'placement.recovered';
  data: Record<string, unknown>;
  idempotency_key: string;
}

export interface InteractionPlacementPlanner {
  place(request: PlacementRequest): Promise<PlacementDecision>;
  inspectOwner?(input: {
    profile_id: string;
    interaction_kind: InteractionKind;
    cell_id: string;
    owner_node_id: string;
    owner_epoch: string;
    cell_lease_epoch: number;
    reservation_id: string;
    admission_endpoint: string;
  }): Promise<{
    status: 'eligible' | 'recoverable' | 'unknown';
    reason: string;
  }>;
}

export interface InteractionPlacementRepository {
  insertReserved(input: InteractionPlacementRecord): Promise<InteractionPlacementRecord>;
  getPlacement(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
  }): Promise<InteractionPlacementRecord | null>;
  replaceReserved(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    expected_owner_epoch: string;
    expected_reservation_id: string;
    replacement: InteractionPlacementRecord;
    reason: string;
    max_attempts: number;
    now: Date;
  }): Promise<{
    record: InteractionPlacementRecord;
    handoff: InteractionPlacementHandoffRecord;
    replayed: boolean;
  }>;
  requestState(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    desired_state: 'active' | 'closed';
    reason: string;
    expected_reservation_id?: string;
    expected_owner_epoch?: string;
    now: Date;
  }): Promise<InteractionPlacementRecord>;
  claimOne(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
  }): Promise<InteractionPlacementRecord | null>;
  claimDue(input: {
    tenant_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
    limit: number;
  }): Promise<InteractionPlacementRecord[]>;
  claimHandoffOne(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
  }): Promise<InteractionPlacementHandoffRecord | null>;
  claimDueHandoffs(input: {
    tenant_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
    limit: number;
  }): Promise<InteractionPlacementHandoffRecord[]>;
  complete(input: {
    tenant_id: string;
    id: string;
    worker_id: string;
    revision: number;
    desired_state: 'active' | 'closed';
    now: Date;
  }): Promise<InteractionPlacementRecord>;
  release(input: {
    tenant_id: string;
    id: string;
    worker_id: string;
    revision: number;
    sync_state: 'retry_wait' | 'failed';
    next_attempt_at: Date | null;
    error_code: string;
    error_message: string;
    now: Date;
  }): Promise<InteractionPlacementRecord>;
  completeHandoff(input: {
    tenant_id: string;
    id: string;
    worker_id: string;
    revision: number;
    now: Date;
  }): Promise<InteractionPlacementHandoffRecord>;
  releaseHandoff(input: {
    tenant_id: string;
    id: string;
    worker_id: string;
    revision: number;
    sync_state: 'retry_wait' | 'failed';
    next_attempt_at: Date | null;
    error_code: string;
    error_message: string;
    now: Date;
  }): Promise<InteractionPlacementHandoffRecord>;
  listDueTenantIds(input: {
    now: Date;
    limit: number;
  }): Promise<string[]>;
}

type RepositoryFactory = (pg: PgQueryable) => InteractionPlacementRepository;
type LifecycleFactory = (admissionEndpoint: string) => CellReservationLifecyclePort;
type EventAppender = (
  pg: PgQueryable,
  event: InteractionPlacementEvent
) => Promise<void>;

export class InteractionPlacementCoordinator {
  readonly #planner: InteractionPlacementPlanner;
  readonly #rootPg: PgQueryable;
  readonly #repositoryFactory: RepositoryFactory;
  readonly #lifecycleFactory: LifecycleFactory;
  readonly #appendEvent: EventAppender;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;

  constructor(input: {
    planner: InteractionPlacementPlanner;
    root_pg: PgQueryable;
    repository_factory?: RepositoryFactory;
    lifecycle_factory?: LifecycleFactory;
    append_event?: EventAppender;
    now?: () => Date;
    id_factory?: () => string;
    lease_ms?: number;
    max_attempts?: number;
    admission_service_token?: string;
    admission_timeout_ms?: number;
  }) {
    this.#planner = input.planner;
    this.#rootPg = input.root_pg;
    this.#repositoryFactory = input.repository_factory ||
      ((pg) => new PostgresInteractionPlacementRepository(pg));
    const token = String(input.admission_service_token || '');
    this.#lifecycleFactory = input.lifecycle_factory || ((endpoint) =>
      new HttpCellAdmissionClient({
        endpoint,
        service_token: token,
        timeout_ms: input.admission_timeout_ms
      }));
    this.#appendEvent = input.append_event || ((pg, event) =>
      new ConveractFabricTenantEventJournal(pg).append({
        tenant_id: event.tenant_id,
        type: event.type,
        data: event.data,
        idempotency_key: event.idempotency_key
      }));
    this.#now = input.now || (() => new Date());
    this.#idFactory = input.id_factory || (() => `ipl_${randomUUID()}`);
    this.#leaseMs = boundedInteger(input.lease_ms ?? 15_000, 1_000, 300_000, 'placement lease');
    this.#maxAttempts = boundedInteger(input.max_attempts ?? 20, 1, 100, 'placement max attempts');
  }

  async reserve(
    input: PlacementRequest & { owner_component: InteractionPlacementOwnerComponent }
  ): Promise<ReservedInteractionPlacement> {
    const ownerComponent = checkedOwnerComponent(input.owner_component);
    const decision = await this.#planner.place(input);
    if (decision.interaction_id !== input.interaction_id ||
        decision.request_id !== input.request_id) {
      throw new PlacementError({ code: 'placement_response_mismatch', status: 502 });
    }
    const owner = splitOwnerEpoch(decision.owner_epoch);
    const now = validDate(this.#now());
    const record: InteractionPlacementRecord = {
      id: checkedIdentifier(this.#idFactory(), 'placement ID'),
      tenant_id: checkedIdentifier(input.tenant_id, 'tenant ID'),
      interaction_id: checkedIdentifier(input.interaction_id, 'interaction ID'),
      interaction_kind: input.interaction_kind,
      routing_partition_id: checkedIdentifier(
        input.routing_partition_id,
        'routing partition ID'
      ),
      profile_id: checkedProfile(input.profile_id),
      owner_component: ownerComponent,
      region_id: checkedIdentifier(decision.region_id, 'region ID'),
      zone_id: checkedIdentifier(decision.zone_id, 'zone ID'),
      cell_id: checkedIdentifier(decision.cell_id, 'Cell ID'),
      owner_node_id: checkedIdentifier(decision.owner_node_id, 'owner node ID'),
      owner_epoch: decision.owner_epoch,
      cell_lease_epoch: owner.cell_lease_epoch,
      reservation_id: checkedIdentifier(decision.reservation_id, 'reservation ID'),
      reservation_expires_at: validFutureTimestamp(
        decision.reservation_expires_at,
        now,
        'reservation expiry'
      ),
      admission_endpoint: checkedHttpEndpoint(decision.admission_endpoint),
      provider_endpoint: checkedProviderEndpoint(decision.endpoint),
      snapshot_version: positiveSafeInteger(decision.snapshot_version, 'snapshot version'),
      placement_generation: 1,
      required_capacity: checkedCapacity(input.required_capacity),
      placement_token_sha256: createHash('sha256')
        .update(decision.signed_placement_token)
        .digest('hex'),
      state: 'reserved',
      desired_state: 'reserved',
      sync_state: 'succeeded',
      lifecycle_reason: 'placement_reserved',
      attempt_count: 0,
      max_attempts: this.#maxAttempts,
      next_attempt_at: null,
      lease_until: null,
      worker_id: '',
      last_error_code: '',
      last_error_message: '',
      revision: 1,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      activated_at: null,
      closed_at: null
    };
    return {
      request: { ...input },
      owner_component: ownerComponent,
      decision,
      record,
      signed_placement_token: decision.signed_placement_token
    };
  }

  async persistReserved(
    pg: PgQueryable,
    reserved: ReservedInteractionPlacement
  ): Promise<InteractionPlacementRecord> {
    const stored = await this.#repositoryFactory(pg).insertReserved(reserved.record);
    await this.#appendEvent(pg, placementEvent('placement.reserved', stored));
    return stored;
  }

  getPlacement(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      interaction_kind: InteractionKind;
      interaction_id: string;
    }
  ): Promise<InteractionPlacementRecord | null> {
    return this.#repositoryFactory(pg).getPlacement(input);
  }

  async inspectOwner(
    record: InteractionPlacementRecord
  ): Promise<{
    status: 'eligible' | 'recoverable' | 'unknown';
    reason: string;
  }> {
    if (!this.#planner.inspectOwner) {
      return { status: 'unknown', reason: 'owner_inspection_unavailable' };
    }
    return this.#planner.inspectOwner({
      profile_id: record.profile_id,
      interaction_kind: record.interaction_kind,
      cell_id: record.cell_id,
      owner_node_id: record.owner_node_id,
      owner_epoch: record.owner_epoch,
      cell_lease_epoch: record.cell_lease_epoch,
      reservation_id: record.reservation_id,
      admission_endpoint: record.admission_endpoint
    });
  }

  async persistReplacement(
    pg: PgQueryable,
    input: {
      reserved: ReservedInteractionPlacement;
      expected_owner_epoch: string;
      expected_reservation_id: string;
      reason: string;
    }
  ): Promise<{
    record: InteractionPlacementRecord;
    handoff: InteractionPlacementHandoffRecord;
    replayed: boolean;
  }> {
    const result = await this.#repositoryFactory(pg).replaceReserved({
      tenant_id: input.reserved.record.tenant_id,
      interaction_kind: input.reserved.record.interaction_kind,
      interaction_id: input.reserved.record.interaction_id,
      expected_owner_epoch: input.expected_owner_epoch,
      expected_reservation_id: input.expected_reservation_id,
      replacement: input.reserved.record,
      reason: checkedReason(input.reason),
      max_attempts: this.#maxAttempts,
      now: validDate(this.#now())
    });
    if (!result.replayed) {
      await this.#appendEvent(
        pg,
        placementEvent('placement.reserved', result.record)
      );
    }
    return result;
  }

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
  ): Promise<InteractionPlacementRecord> {
    return this.#repositoryFactory(pg).requestState({
      ...input,
      reason: checkedReason(input.reason),
      now: validDate(this.#now())
    });
  }

  async releaseUncommitted(
    reserved: ReservedInteractionPlacement
  ): Promise<void> {
    const response = await this.#lifecycleFactory(
      reserved.record.admission_endpoint
    ).close(reserved.record.reservation_id);
    validateLifecycleResponse(reserved.record, response, 'closed');
  }

  async reconcileOne(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    worker_id: string;
  }): Promise<InteractionPlacementReconcileResult> {
    const now = validDate(this.#now());
    const repository = this.#repositoryFactory(this.#rootPg);
    const claimed = await repository.claimOne({
      ...input,
      worker_id: checkedIdentifier(input.worker_id, 'placement worker ID'),
      now,
      lease_ms: this.#leaseMs
    });
    if (!claimed) return { outcome: 'idle', record: null };
    return this.#reconcileClaim(repository, claimed, now);
  }

  async reconcileDue(input: {
    worker_id: string;
    tenant_limit: number;
    batch_size: number;
  }): Promise<{
    tenants: number;
    claimed: number;
    succeeded: number;
    retry_wait: number;
    failed: number;
  }> {
    const now = validDate(this.#now());
    const repository = this.#repositoryFactory(this.#rootPg);
    const tenantIds = await repository.listDueTenantIds({
      now,
      limit: boundedInteger(input.tenant_limit, 1, 1_000, 'placement tenant limit')
    });
    const summary = {
      tenants: tenantIds.length,
      claimed: 0,
      succeeded: 0,
      retry_wait: 0,
      failed: 0
    };
    for (const tenantId of tenantIds) {
      const claimed = await repository.claimDue({
        tenant_id: tenantId,
        worker_id: checkedIdentifier(input.worker_id, 'placement worker ID'),
        now,
        lease_ms: this.#leaseMs,
        limit: boundedInteger(input.batch_size, 1, 100, 'placement batch size')
      });
      summary.claimed += claimed.length;
      for (const record of claimed) {
        const result = await this.#reconcileClaim(repository, record, now);
        if (result.outcome !== 'idle') summary[result.outcome] += 1;
      }
      const handoffs = await repository.claimDueHandoffs({
        tenant_id: tenantId,
        worker_id: checkedIdentifier(input.worker_id, 'placement worker ID'),
        now,
        lease_ms: this.#leaseMs,
        limit: boundedInteger(input.batch_size, 1, 100, 'placement batch size')
      });
      summary.claimed += handoffs.length;
      for (const handoff of handoffs) {
        const result = await this.#reconcileHandoffClaim(
          repository,
          handoff,
          now
        );
        summary[result] += 1;
      }
    }
    return summary;
  }

  async reconcileHandoffOne(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    worker_id: string;
  }): Promise<'idle' | 'succeeded' | 'retry_wait' | 'failed'> {
    const now = validDate(this.#now());
    const repository = this.#repositoryFactory(this.#rootPg);
    const claimed = await repository.claimHandoffOne({
      ...input,
      worker_id: checkedIdentifier(input.worker_id, 'placement worker ID'),
      now,
      lease_ms: this.#leaseMs
    });
    if (!claimed) return 'idle';
    return this.#reconcileHandoffClaim(repository, claimed, now);
  }

  async #reconcileClaim(
    repository: InteractionPlacementRepository,
    claimed: InteractionPlacementRecord,
    now: Date
  ): Promise<InteractionPlacementReconcileResult> {
    const desired = claimed.desired_state;
    if (desired !== 'active' && desired !== 'closed') {
      throw new Error('claimed interaction placement has no lifecycle action');
    }
    try {
      const client = this.#lifecycleFactory(claimed.admission_endpoint);
      const response = desired === 'active'
        ? await client.activate(claimed.reservation_id)
        : await client.close(claimed.reservation_id);
      validateLifecycleResponse(claimed, response, desired);
      const completed = await withPgTenant(this.#rootPg, claimed.tenant_id, async (pg) => {
        const transactionalRepository = this.#repositoryFactory(pg);
        const record = await transactionalRepository.complete({
          tenant_id: claimed.tenant_id,
          id: claimed.id,
          worker_id: claimed.worker_id,
          revision: claimed.revision,
          desired_state: desired,
          now
        });
        await this.#appendEvent(
          pg,
          placementEvent(
            desired === 'active' ? 'placement.activated' : 'placement.closed',
            record
          )
        );
        return record;
      });
      return { outcome: 'succeeded', record: completed };
    } catch (error) {
      const projected = lifecycleError(error);
      const retryable = projected.retryable &&
        claimed.attempt_count < claimed.max_attempts;
      const nextAttempt = retryable
        ? new Date(now.getTime() + retryDelayMs(claimed.attempt_count))
        : null;
      const released = await repository.release({
        tenant_id: claimed.tenant_id,
        id: claimed.id,
        worker_id: claimed.worker_id,
        revision: claimed.revision,
        sync_state: retryable ? 'retry_wait' : 'failed',
        next_attempt_at: nextAttempt,
        error_code: projected.code,
        error_message: projected.message,
        now
      });
      return {
        outcome: retryable ? 'retry_wait' : 'failed',
        record: released
      };
    }
  }

  async #reconcileHandoffClaim(
    repository: InteractionPlacementRepository,
    claimed: InteractionPlacementHandoffRecord,
    now: Date
  ): Promise<'succeeded' | 'retry_wait' | 'failed'> {
    try {
      const response = await this.#lifecycleFactory(
        claimed.from_admission_endpoint
      ).close(claimed.from_reservation_id);
      validateHandoffCloseResponse(claimed, response);
      const completed = await withPgTenant(
        this.#rootPg,
        claimed.tenant_id,
        async (pg) => {
          const record = await this.#repositoryFactory(pg).completeHandoff({
            tenant_id: claimed.tenant_id,
            id: claimed.id,
            worker_id: claimed.worker_id,
            revision: claimed.revision,
            now
          });
          await this.#appendEvent(pg, placementRecoveryEvent(record));
          return record;
        }
      );
      void completed;
      return 'succeeded';
    } catch (error) {
      const projected = lifecycleError(error);
      const retryable = projected.retryable &&
        claimed.attempt_count < claimed.max_attempts;
      const nextAttempt = retryable
        ? new Date(now.getTime() + retryDelayMs(claimed.attempt_count))
        : null;
      await repository.releaseHandoff({
        tenant_id: claimed.tenant_id,
        id: claimed.id,
        worker_id: claimed.worker_id,
        revision: claimed.revision,
        sync_state: retryable ? 'retry_wait' : 'failed',
        next_attempt_at: nextAttempt,
        error_code: projected.code,
        error_message: projected.message,
        now
      });
      return retryable ? 'retry_wait' : 'failed';
    }
  }
}

export interface InteractionPlacementReconcileResult {
  outcome: 'idle' | 'succeeded' | 'retry_wait' | 'failed';
  record: InteractionPlacementRecord | null;
}

export class PostgresInteractionPlacementRepository
implements InteractionPlacementRepository {
  constructor(private readonly pg: PgQueryable) {}

  insertReserved(input: InteractionPlacementRecord): Promise<InteractionPlacementRecord> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `INSERT INTO ivekit_interaction_placements
          (id, tenant_id, interaction_id, interaction_kind, routing_partition_id,
           profile_id, owner_component, region_id, zone_id, cell_id, owner_node_id,
           owner_epoch, cell_lease_epoch, reservation_id, reservation_expires_at,
           admission_endpoint, provider_endpoint, snapshot_version,
           placement_generation, required_capacity, placement_token_sha256,
           state, desired_state, sync_state, lifecycle_reason,
           attempt_count, max_attempts, next_attempt_at, lease_until, worker_id,
           last_error_code, last_error_message, revision, created_at, updated_at,
           activated_at, closed_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric,
           $13, $14, $15::timestamptz, $16, $17, $18, $19, $20::jsonb,
           $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
           $33, $34, $35, $36, $37)
         ON CONFLICT (tenant_id, interaction_kind, interaction_id) DO NOTHING
         RETURNING *`,
        recordParams(input)
      );
      if (result.rows[0]) return decodeRecord(result.rows[0]);
      const replay = await pg.query(
        `SELECT * FROM ivekit_interaction_placements
         WHERE tenant_id = $1 AND interaction_kind = $2 AND interaction_id = $3`,
        [input.tenant_id, input.interaction_kind, input.interaction_id]
      );
      const existing = replay.rows[0] ? decodeRecord(replay.rows[0]) : null;
      if (!existing || existing.placement_token_sha256 !== input.placement_token_sha256 ||
          existing.owner_epoch !== input.owner_epoch) {
        throw new PlacementError({ code: 'placement_idempotency_conflict', status: 409 });
      }
      return existing;
    });
  }

  getPlacement(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
  }): Promise<InteractionPlacementRecord | null> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT * FROM ivekit_interaction_placements
         WHERE tenant_id = $1 AND interaction_kind = $2 AND interaction_id = $3`,
        [input.tenant_id, input.interaction_kind, input.interaction_id]
      );
      return result.rows[0] ? decodeRecord(result.rows[0]) : null;
    });
  }

  replaceReserved(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    expected_owner_epoch: string;
    expected_reservation_id: string;
    replacement: InteractionPlacementRecord;
    reason: string;
    max_attempts: number;
    now: Date;
  }): Promise<{
    record: InteractionPlacementRecord;
    handoff: InteractionPlacementHandoffRecord;
    replayed: boolean;
  }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const currentResult = await pg.query(
        `SELECT * FROM ivekit_interaction_placements
         WHERE tenant_id = $1 AND interaction_kind = $2 AND interaction_id = $3
         FOR UPDATE`,
        [input.tenant_id, input.interaction_kind, input.interaction_id]
      );
      const current = currentResult.rows[0]
        ? decodeRecord(currentResult.rows[0])
        : null;
      if (!current) {
        throw new PlacementError({
          code: 'placement_owner_missing',
          status: 503,
          retryable: true
        });
      }
      if (current.owner_epoch === input.replacement.owner_epoch &&
          current.reservation_id === input.replacement.reservation_id) {
        const replayResult = await pg.query(
          `SELECT * FROM ivekit_interaction_placement_handoffs
           WHERE tenant_id = $1 AND interaction_kind = $2
             AND interaction_id = $3 AND to_reservation_id = $4`,
          [
            input.tenant_id,
            input.interaction_kind,
            input.interaction_id,
            input.replacement.reservation_id
          ]
        );
        if (!replayResult.rows[0]) {
          throw new PlacementError({
            code: 'placement_recovery_replay_missing',
            status: 409
          });
        }
        return {
          record: current,
          handoff: decodeHandoff(replayResult.rows[0]),
          replayed: true
        };
      }
      assertReplacementIdentity(current, input.replacement);
      if (current.owner_epoch !== input.expected_owner_epoch ||
          current.reservation_id !== input.expected_reservation_id) {
        throw new PlacementError({
          code: 'stale_placement_recovery',
          status: 409,
          retryable: true
        });
      }
      if (current.state !== 'active' ||
          current.desired_state !== 'active' ||
          current.sync_state !== 'succeeded') {
        throw new PlacementError({
          code: 'placement_owner_not_active',
          status: 503,
          retryable: true
        });
      }
      const generation = current.placement_generation + 1;
      const handoff: InteractionPlacementHandoffRecord = {
        id: input.replacement.id,
        tenant_id: current.tenant_id,
        interaction_id: current.interaction_id,
        interaction_kind: current.interaction_kind,
        placement_generation: generation,
        from_region_id: current.region_id,
        from_zone_id: current.zone_id,
        from_cell_id: current.cell_id,
        from_owner_node_id: current.owner_node_id,
        from_owner_epoch: current.owner_epoch,
        from_reservation_id: current.reservation_id,
        from_admission_endpoint: current.admission_endpoint,
        from_provider_endpoint: current.provider_endpoint,
        from_required_capacity: current.required_capacity,
        to_owner_node_id: input.replacement.owner_node_id,
        to_owner_epoch: input.replacement.owner_epoch,
        to_reservation_id: input.replacement.reservation_id,
        state: 'prepared',
        sync_state: 'waiting',
        reason: input.reason,
        attempt_count: 0,
        max_attempts: input.max_attempts,
        next_attempt_at: null,
        lease_until: null,
        worker_id: '',
        last_error_code: '',
        last_error_message: '',
        revision: 1,
        created_at: input.now.toISOString(),
        updated_at: input.now.toISOString(),
        completed_at: null
      };
      const inserted = await pg.query(
        `INSERT INTO ivekit_interaction_placement_handoffs
          (id, tenant_id, interaction_id, interaction_kind,
           placement_generation, from_region_id, from_zone_id, from_cell_id,
           from_owner_node_id, from_owner_epoch, from_reservation_id,
           from_admission_endpoint, from_provider_endpoint,
           from_required_capacity, to_owner_node_id, to_owner_epoch,
           to_reservation_id, state, sync_state, reason, attempt_count,
           max_attempts, next_attempt_at, lease_until, worker_id,
           last_error_code, last_error_message, revision, created_at,
           updated_at, completed_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11,
           $12, $13, $14::jsonb, $15, $16::numeric, $17, $18, $19,
           $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
         RETURNING *`,
        handoffParams(handoff)
      );
      const replacement = {
        ...input.replacement,
        id: current.id,
        placement_generation: generation,
        state: 'reserved' as const,
        desired_state: 'active' as const,
        sync_state: 'pending' as const,
        lifecycle_reason: input.reason,
        attempt_count: 0,
        max_attempts: current.max_attempts,
        next_attempt_at: input.now.toISOString(),
        lease_until: null,
        worker_id: '',
        last_error_code: '',
        last_error_message: '',
        revision: current.revision + 1,
        created_at: current.created_at,
        updated_at: input.now.toISOString(),
        activated_at: current.activated_at,
        closed_at: null
      };
      const updated = await pg.query(
        `UPDATE ivekit_interaction_placements
         SET routing_partition_id = $4, profile_id = $5,
             owner_component = $6, region_id = $7, zone_id = $8,
             cell_id = $9, owner_node_id = $10, owner_epoch = $11::numeric,
             cell_lease_epoch = $12, reservation_id = $13,
             reservation_expires_at = $14::timestamptz,
             admission_endpoint = $15, provider_endpoint = $16,
             snapshot_version = $17, placement_generation = $18,
             required_capacity = $19::jsonb, placement_token_sha256 = $20,
             state = 'reserved', desired_state = 'active',
             sync_state = 'pending', lifecycle_reason = $21,
             attempt_count = 0, next_attempt_at = $22::timestamptz,
             lease_until = NULL, worker_id = '', last_error_code = '',
             last_error_message = '', revision = revision + 1,
             updated_at = $22::timestamptz, closed_at = NULL
         WHERE tenant_id = $1 AND interaction_kind = $2 AND interaction_id = $3
         RETURNING *`,
        [
          input.tenant_id,
          input.interaction_kind,
          input.interaction_id,
          replacement.routing_partition_id,
          replacement.profile_id,
          replacement.owner_component,
          replacement.region_id,
          replacement.zone_id,
          replacement.cell_id,
          replacement.owner_node_id,
          replacement.owner_epoch,
          replacement.cell_lease_epoch,
          replacement.reservation_id,
          replacement.reservation_expires_at,
          replacement.admission_endpoint,
          replacement.provider_endpoint,
          replacement.snapshot_version,
          replacement.placement_generation,
          JSON.stringify(replacement.required_capacity),
          replacement.placement_token_sha256,
          replacement.lifecycle_reason,
          replacement.updated_at
        ]
      );
      return {
        record: decodeRecord(updated.rows[0]),
        handoff: decodeHandoff(inserted.rows[0]),
        replayed: false
      };
    });
  }

  requestState(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    desired_state: 'active' | 'closed';
    reason: string;
    expected_reservation_id?: string;
    expected_owner_epoch?: string;
    now: Date;
  }): Promise<InteractionPlacementRecord> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `UPDATE ivekit_interaction_placements
         SET desired_state = $4, sync_state = CASE
               WHEN state = $4 THEN 'succeeded' ELSE 'pending'
             END,
             lifecycle_reason = $5, attempt_count = CASE
               WHEN desired_state = $4 THEN attempt_count ELSE 0
             END,
             next_attempt_at = CASE WHEN state = $4 THEN NULL ELSE $6::timestamptz END,
             lease_until = NULL, worker_id = '', last_error_code = '',
             last_error_message = '', revision = revision + 1,
             updated_at = $6::timestamptz
         WHERE tenant_id = $1 AND interaction_kind = $2 AND interaction_id = $3
           AND state NOT IN ('closed', 'expired')
           AND NOT (desired_state = 'closed' AND $4 = 'active')
           AND ($7::text IS NULL OR reservation_id = $7)
           AND ($8::numeric IS NULL OR owner_epoch = $8::numeric)
         RETURNING *`,
        [
          input.tenant_id,
          input.interaction_kind,
          input.interaction_id,
          input.desired_state,
          input.reason,
          input.now.toISOString(),
          input.expected_reservation_id || null,
          input.expected_owner_epoch || null
        ]
      );
      if (result.rows[0]) return decodeRecord(result.rows[0]);
      const replay = await pg.query(
        `SELECT * FROM ivekit_interaction_placements
         WHERE tenant_id = $1 AND interaction_kind = $2 AND interaction_id = $3`,
        [input.tenant_id, input.interaction_kind, input.interaction_id]
      );
      const current = replay.rows[0] ? decodeRecord(replay.rows[0]) : null;
      if (current && current.desired_state === input.desired_state &&
          (!input.expected_reservation_id || current.reservation_id === input.expected_reservation_id) &&
          (!input.expected_owner_epoch || current.owner_epoch === input.expected_owner_epoch)) {
        return current;
      }
      throw new PlacementError({ code: 'placement_state_conflict', status: 409 });
    });
  }

  claimOne(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
  }): Promise<InteractionPlacementRecord | null> {
    return this.#claim({
      tenant_id: input.tenant_id,
      interaction_kind: input.interaction_kind,
      interaction_id: input.interaction_id,
      worker_id: input.worker_id,
      now: input.now,
      lease_ms: input.lease_ms,
      limit: 1
    }).then((rows) => rows[0] || null);
  }

  claimDue(input: {
    tenant_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
    limit: number;
  }): Promise<InteractionPlacementRecord[]> {
    return this.#claim({
      ...input,
      interaction_kind: '',
      interaction_id: ''
    });
  }

  claimHandoffOne(input: {
    tenant_id: string;
    interaction_kind: InteractionKind;
    interaction_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
  }): Promise<InteractionPlacementHandoffRecord | null> {
    return this.#claimHandoffs({
      ...input,
      limit: 1
    }).then((rows) => rows[0] || null);
  }

  claimDueHandoffs(input: {
    tenant_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
    limit: number;
  }): Promise<InteractionPlacementHandoffRecord[]> {
    return this.#claimHandoffs({
      ...input,
      interaction_kind: '',
      interaction_id: ''
    });
  }

  complete(input: {
    tenant_id: string;
    id: string;
    worker_id: string;
    revision: number;
    desired_state: 'active' | 'closed';
    now: Date;
  }): Promise<InteractionPlacementRecord> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `UPDATE ivekit_interaction_placements
         SET state = $5, sync_state = 'succeeded', worker_id = '',
             lease_until = NULL, next_attempt_at = NULL, last_error_code = '',
             last_error_message = '', revision = revision + 1,
             activated_at = CASE WHEN $5 = 'active'
               THEN COALESCE(activated_at, $6::timestamptz) ELSE activated_at END,
             closed_at = CASE WHEN $5 = 'closed'
               THEN COALESCE(closed_at, $6::timestamptz) ELSE closed_at END,
             updated_at = $6::timestamptz
         WHERE tenant_id = $1 AND id = $2 AND worker_id = $3
           AND revision = $4 AND desired_state = $5 AND sync_state = 'processing'
         RETURNING *`,
        [
          input.tenant_id,
          input.id,
          input.worker_id,
          input.revision,
          input.desired_state,
          input.now.toISOString()
        ]
      );
      if (!result.rows[0]) {
        throw new PlacementError({ code: 'stale_placement_lease', status: 409 });
      }
      const record = decodeRecord(result.rows[0]);
      await pg.query(
        `UPDATE ivekit_interaction_placement_handoffs
         SET state = 'source_close_pending', sync_state = 'pending',
             next_attempt_at = $4::timestamptz, lease_until = NULL,
             worker_id = '', last_error_code = '', last_error_message = '',
             revision = revision + 1, updated_at = $4::timestamptz
         WHERE tenant_id = $1 AND interaction_kind = $2
           AND interaction_id = $3 AND to_reservation_id = $5
           AND state = 'prepared' AND sync_state = 'waiting'`,
        [
          input.tenant_id,
          record.interaction_kind,
          record.interaction_id,
          input.now.toISOString(),
          record.reservation_id
        ]
      );
      return record;
    });
  }

  release(input: {
    tenant_id: string;
    id: string;
    worker_id: string;
    revision: number;
    sync_state: 'retry_wait' | 'failed';
    next_attempt_at: Date | null;
    error_code: string;
    error_message: string;
    now: Date;
  }): Promise<InteractionPlacementRecord> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `UPDATE ivekit_interaction_placements
         SET sync_state = $5, next_attempt_at = $6, worker_id = '',
             lease_until = NULL, last_error_code = $7, last_error_message = $8,
             revision = revision + 1, updated_at = $9::timestamptz
         WHERE tenant_id = $1 AND id = $2 AND worker_id = $3
           AND revision = $4 AND sync_state = 'processing'
         RETURNING *`,
        [
          input.tenant_id,
          input.id,
          input.worker_id,
          input.revision,
          input.sync_state,
          input.next_attempt_at?.toISOString() || null,
          input.error_code,
          input.error_message,
          input.now.toISOString()
        ]
      );
      if (!result.rows[0]) {
        throw new PlacementError({ code: 'stale_placement_lease', status: 409 });
      }
      return decodeRecord(result.rows[0]);
    });
  }

  completeHandoff(input: {
    tenant_id: string;
    id: string;
    worker_id: string;
    revision: number;
    now: Date;
  }): Promise<InteractionPlacementHandoffRecord> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `UPDATE ivekit_interaction_placement_handoffs
         SET state = 'completed', sync_state = 'succeeded',
             next_attempt_at = NULL, lease_until = NULL, worker_id = '',
             last_error_code = '', last_error_message = '',
             revision = revision + 1, updated_at = $5::timestamptz,
             completed_at = COALESCE(completed_at, $5::timestamptz)
         WHERE tenant_id = $1 AND id = $2 AND worker_id = $3
           AND revision = $4 AND state = 'source_close_pending'
           AND sync_state = 'processing'
         RETURNING *`,
        [
          input.tenant_id,
          input.id,
          input.worker_id,
          input.revision,
          input.now.toISOString()
        ]
      );
      if (!result.rows[0]) {
        throw new PlacementError({
          code: 'stale_placement_handoff_lease',
          status: 409
        });
      }
      return decodeHandoff(result.rows[0]);
    });
  }

  releaseHandoff(input: {
    tenant_id: string;
    id: string;
    worker_id: string;
    revision: number;
    sync_state: 'retry_wait' | 'failed';
    next_attempt_at: Date | null;
    error_code: string;
    error_message: string;
    now: Date;
  }): Promise<InteractionPlacementHandoffRecord> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const terminal = input.sync_state === 'failed';
      const result = await pg.query(
        `UPDATE ivekit_interaction_placement_handoffs
         SET state = CASE WHEN $5 = 'failed' THEN 'failed'
               ELSE 'source_close_pending' END,
             sync_state = $5, next_attempt_at = $6, worker_id = '',
             lease_until = NULL, last_error_code = $7,
             last_error_message = $8, revision = revision + 1,
             updated_at = $9::timestamptz
         WHERE tenant_id = $1 AND id = $2 AND worker_id = $3
           AND revision = $4 AND state = 'source_close_pending'
           AND sync_state = 'processing'
         RETURNING *`,
        [
          input.tenant_id,
          input.id,
          input.worker_id,
          input.revision,
          input.sync_state,
          input.next_attempt_at?.toISOString() || null,
          input.error_code,
          input.error_message,
          input.now.toISOString()
        ]
      );
      void terminal;
      if (!result.rows[0]) {
        throw new PlacementError({
          code: 'stale_placement_handoff_lease',
          status: 409
        });
      }
      return decodeHandoff(result.rows[0]);
    });
  }

  async listDueTenantIds(input: {
    now: Date;
    limit: number;
  }): Promise<string[]> {
    const result = await this.pg.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM opc_ivekit_placement_tenant_ids($1, $2)',
      [input.now.toISOString(), input.limit]
    );
    return result.rows.map((row) => String(row.tenant_id));
  }

  async #claim(input: {
    tenant_id: string;
    interaction_kind: InteractionKind | '';
    interaction_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
    limit: number;
  }): Promise<InteractionPlacementRecord[]> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const leaseUntil = new Date(input.now.getTime() + input.lease_ms);
      const result = await pg.query(
        `SELECT * FROM opc_ivekit_claim_interaction_placements(
           $1, $2, $3, $4, $5, $6, $7
         )`,
        [
          input.tenant_id,
          input.interaction_kind,
          input.interaction_id,
          input.worker_id,
          input.now.toISOString(),
          leaseUntil.toISOString(),
          input.limit
        ]
      );
      return result.rows.map(decodeRecord);
    });
  }

  async #claimHandoffs(input: {
    tenant_id: string;
    interaction_kind: InteractionKind | '';
    interaction_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
    limit: number;
  }): Promise<InteractionPlacementHandoffRecord[]> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const leaseUntil = new Date(input.now.getTime() + input.lease_ms);
      const result = await pg.query(
        `WITH candidate AS (
           SELECT handoff.id
           FROM ivekit_interaction_placement_handoffs handoff
           WHERE handoff.tenant_id = $1
             AND ($2 = '' OR handoff.interaction_kind = $2)
             AND ($3 = '' OR handoff.interaction_id = $3)
             AND handoff.state = 'source_close_pending'
             AND (
               handoff.sync_state = 'pending'
               OR (
                 handoff.sync_state = 'retry_wait'
                 AND (
                   handoff.next_attempt_at IS NULL
                   OR handoff.next_attempt_at <= $5::timestamptz
                 )
               )
               OR (
                 handoff.sync_state = 'processing'
                 AND handoff.lease_until <= $5::timestamptz
               )
             )
             AND handoff.attempt_count < handoff.max_attempts
           ORDER BY COALESCE(handoff.next_attempt_at, handoff.updated_at),
             handoff.id
           FOR UPDATE SKIP LOCKED
           LIMIT $7
         )
         UPDATE ivekit_interaction_placement_handoffs handoff
         SET sync_state = 'processing', worker_id = $4,
             lease_until = $6::timestamptz,
             attempt_count = handoff.attempt_count + 1,
             revision = handoff.revision + 1,
             updated_at = $5::timestamptz
         FROM candidate
         WHERE handoff.tenant_id = $1 AND handoff.id = candidate.id
         RETURNING handoff.*`,
        [
          input.tenant_id,
          input.interaction_kind,
          input.interaction_id,
          input.worker_id,
          input.now.toISOString(),
          leaseUntil.toISOString(),
          input.limit
        ]
      );
      return result.rows.map(decodeHandoff);
    });
  }
}

function recordParams(record: InteractionPlacementRecord): unknown[] {
  return [
    record.id,
    record.tenant_id,
    record.interaction_id,
    record.interaction_kind,
    record.routing_partition_id,
    record.profile_id,
    record.owner_component,
    record.region_id,
    record.zone_id,
    record.cell_id,
    record.owner_node_id,
    record.owner_epoch,
    record.cell_lease_epoch,
    record.reservation_id,
    record.reservation_expires_at,
    record.admission_endpoint,
    record.provider_endpoint,
    record.snapshot_version,
    record.placement_generation,
    JSON.stringify(record.required_capacity),
    record.placement_token_sha256,
    record.state,
    record.desired_state,
    record.sync_state,
    record.lifecycle_reason,
    record.attempt_count,
    record.max_attempts,
    record.next_attempt_at,
    record.lease_until,
    record.worker_id,
    record.last_error_code,
    record.last_error_message,
    record.revision,
    record.created_at,
    record.updated_at,
    record.activated_at,
    record.closed_at
  ];
}

function decodeRecord(row: Record<string, unknown>): InteractionPlacementRecord {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    interaction_id: String(row.interaction_id),
    interaction_kind: row.interaction_kind as InteractionKind,
    routing_partition_id: String(row.routing_partition_id),
    profile_id: String(row.profile_id),
    owner_component: row.owner_component as InteractionPlacementOwnerComponent,
    region_id: String(row.region_id),
    zone_id: String(row.zone_id),
    cell_id: String(row.cell_id),
    owner_node_id: String(row.owner_node_id),
    owner_epoch: String(row.owner_epoch),
    cell_lease_epoch: Number(row.cell_lease_epoch),
    reservation_id: String(row.reservation_id),
    reservation_expires_at: timestamp(row.reservation_expires_at),
    admission_endpoint: String(row.admission_endpoint),
    provider_endpoint: String(row.provider_endpoint),
    snapshot_version: Number(row.snapshot_version),
    placement_generation: Number(row.placement_generation || 1),
    required_capacity: jsonRecord(row.required_capacity),
    placement_token_sha256: String(row.placement_token_sha256),
    state: row.state as InteractionPlacementState,
    desired_state: row.desired_state as InteractionPlacementDesiredState,
    sync_state: row.sync_state as InteractionPlacementSyncState,
    lifecycle_reason: String(row.lifecycle_reason),
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: nullableTimestamp(row.next_attempt_at),
    lease_until: nullableTimestamp(row.lease_until),
    worker_id: String(row.worker_id || ''),
    last_error_code: String(row.last_error_code || ''),
    last_error_message: String(row.last_error_message || ''),
    revision: Number(row.revision),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
    activated_at: nullableTimestamp(row.activated_at),
    closed_at: nullableTimestamp(row.closed_at)
  };
}

function handoffParams(record: InteractionPlacementHandoffRecord): unknown[] {
  return [
    record.id,
    record.tenant_id,
    record.interaction_id,
    record.interaction_kind,
    record.placement_generation,
    record.from_region_id,
    record.from_zone_id,
    record.from_cell_id,
    record.from_owner_node_id,
    record.from_owner_epoch,
    record.from_reservation_id,
    record.from_admission_endpoint,
    record.from_provider_endpoint,
    JSON.stringify(record.from_required_capacity),
    record.to_owner_node_id,
    record.to_owner_epoch,
    record.to_reservation_id,
    record.state,
    record.sync_state,
    record.reason,
    record.attempt_count,
    record.max_attempts,
    record.next_attempt_at,
    record.lease_until,
    record.worker_id,
    record.last_error_code,
    record.last_error_message,
    record.revision,
    record.created_at,
    record.updated_at,
    record.completed_at
  ];
}

function decodeHandoff(
  row: Record<string, unknown>
): InteractionPlacementHandoffRecord {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    interaction_id: String(row.interaction_id),
    interaction_kind: row.interaction_kind as InteractionKind,
    placement_generation: Number(row.placement_generation),
    from_region_id: String(row.from_region_id),
    from_zone_id: String(row.from_zone_id),
    from_cell_id: String(row.from_cell_id),
    from_owner_node_id: String(row.from_owner_node_id),
    from_owner_epoch: String(row.from_owner_epoch),
    from_reservation_id: String(row.from_reservation_id),
    from_admission_endpoint: String(row.from_admission_endpoint),
    from_provider_endpoint: String(row.from_provider_endpoint),
    from_required_capacity: jsonRecord(row.from_required_capacity),
    to_owner_node_id: String(row.to_owner_node_id),
    to_owner_epoch: String(row.to_owner_epoch),
    to_reservation_id: String(row.to_reservation_id),
    state: row.state as InteractionPlacementHandoffState,
    sync_state: row.sync_state as InteractionPlacementHandoffSyncState,
    reason: String(row.reason || ''),
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: nullableTimestamp(row.next_attempt_at),
    lease_until: nullableTimestamp(row.lease_until),
    worker_id: String(row.worker_id || ''),
    last_error_code: String(row.last_error_code || ''),
    last_error_message: String(row.last_error_message || ''),
    revision: Number(row.revision),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
    completed_at: nullableTimestamp(row.completed_at)
  };
}

function assertReplacementIdentity(
  current: InteractionPlacementRecord,
  replacement: InteractionPlacementRecord
): void {
  if (replacement.tenant_id !== current.tenant_id ||
      replacement.interaction_id !== current.interaction_id ||
      replacement.interaction_kind !== current.interaction_kind ||
      replacement.owner_component !== current.owner_component ||
      replacement.profile_id !== current.profile_id ||
      replacement.owner_epoch === current.owner_epoch ||
      replacement.reservation_id === current.reservation_id) {
    throw new PlacementError({
      code: 'placement_recovery_identity_mismatch',
      status: 409
    });
  }
}

function placementEvent(
  type: InteractionPlacementEvent['type'],
  record: InteractionPlacementRecord
): InteractionPlacementEvent {
  return {
    tenant_id: record.tenant_id,
    type,
    idempotency_key: `${type}:${record.interaction_kind}:${record.interaction_id}:${record.owner_epoch}`,
    data: {
      interaction_id: record.interaction_id,
      interaction_kind: record.interaction_kind,
      call_id: record.interaction_kind === 'livekit_av' ||
        record.interaction_kind === 'livekit_screen'
        ? record.interaction_id
        : undefined,
      routing_partition_id: record.routing_partition_id,
      profile_id: record.profile_id,
      owner_component: record.owner_component,
      region_id: record.region_id,
      zone_id: record.zone_id,
      cell_id: record.cell_id,
      owner_node_id: record.owner_node_id,
      owner_epoch: record.owner_epoch,
      cell_lease_epoch: record.cell_lease_epoch,
      reservation_id: record.reservation_id,
      snapshot_version: record.snapshot_version,
      placement_generation: record.placement_generation,
      state: record.state,
      reason: record.lifecycle_reason,
      occurred_at: record.updated_at
    }
  };
}

function placementRecoveryEvent(
  handoff: InteractionPlacementHandoffRecord
): InteractionPlacementEvent {
  return {
    tenant_id: handoff.tenant_id,
    type: 'placement.recovered',
    idempotency_key: [
      'placement.recovered',
      handoff.interaction_kind,
      handoff.interaction_id,
      handoff.to_owner_epoch
    ].join(':'),
    data: {
      interaction_id: handoff.interaction_id,
      interaction_kind: handoff.interaction_kind,
      call_id: handoff.interaction_kind === 'livekit_av' ||
        handoff.interaction_kind === 'livekit_screen'
        ? handoff.interaction_id
        : undefined,
      placement_generation: handoff.placement_generation,
      from_region_id: handoff.from_region_id,
      from_zone_id: handoff.from_zone_id,
      from_cell_id: handoff.from_cell_id,
      from_owner_node_id: handoff.from_owner_node_id,
      from_owner_epoch: handoff.from_owner_epoch,
      from_reservation_id: handoff.from_reservation_id,
      to_owner_node_id: handoff.to_owner_node_id,
      to_owner_epoch: handoff.to_owner_epoch,
      to_reservation_id: handoff.to_reservation_id,
      reason: handoff.reason,
      occurred_at: handoff.updated_at
    }
  };
}

function validateLifecycleResponse(
  record: InteractionPlacementRecord,
  response: AdmissionReservation,
  expectedState: 'active' | 'closed'
): void {
  if (response.state !== expectedState ||
      response.reservation_id !== record.reservation_id ||
      response.region_id !== record.region_id ||
      response.zone_id !== record.zone_id ||
      response.cell_id !== record.cell_id ||
      response.owner_node_id !== record.owner_node_id ||
      response.owner_epoch !== record.owner_epoch ||
      response.endpoint !== record.provider_endpoint ||
      !equalCapacity(response.required_capacity, record.required_capacity)) {
    throw new PlacementError({
      code: 'admission_lifecycle_response_mismatch',
      status: 502
    });
  }
}

function validateHandoffCloseResponse(
  handoff: InteractionPlacementHandoffRecord,
  response: AdmissionReservation
): void {
  if (response.state !== 'closed' ||
      response.reservation_id !== handoff.from_reservation_id ||
      response.region_id !== handoff.from_region_id ||
      response.zone_id !== handoff.from_zone_id ||
      response.cell_id !== handoff.from_cell_id ||
      response.owner_node_id !== handoff.from_owner_node_id ||
      response.owner_epoch !== handoff.from_owner_epoch ||
      response.endpoint !== handoff.from_provider_endpoint ||
      !equalCapacity(
        response.required_capacity,
        handoff.from_required_capacity
      )) {
    throw new PlacementError({
      code: 'admission_handoff_response_mismatch',
      status: 502
    });
  }
}

function equalCapacity(
  left: CapacityRequirement,
  right: CapacityRequirement
): boolean {
  return JSON.stringify(Object.entries(left).sort()) ===
    JSON.stringify(Object.entries(right).sort());
}

function lifecycleError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof PlacementError) {
    return {
      code: error.code,
      message: error.message.slice(0, 500),
      retryable: error.retryable
    };
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: /^[a-z][a-z0-9_]{1,127}$/.test(String(candidate?.code || ''))
      ? String(candidate.code)
      : 'placement_lifecycle_failed',
    message: String(candidate?.message || error || '').slice(0, 500),
    retryable: false
  };
}

function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 250 * 2 ** Math.max(0, Math.min(10, attempt - 1)));
}

function checkedOwnerComponent(
  value: InteractionPlacementOwnerComponent
): InteractionPlacementOwnerComponent {
  if (!['rustpbx', 'livekit', 'tinode', 'rustdesk'].includes(value)) {
    throw new Error('invalid placement owner component');
  }
  return value;
}

function checkedIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(String(value || ''))) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function checkedProfile(value: string): string {
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(value)) {
    throw new Error('invalid placement profile');
  }
  return value;
}

function checkedCapacity(value: CapacityRequirement): CapacityRequirement {
  const entries = Object.entries(value || {});
  if (entries.length === 0 || entries.some(([key, amount]) =>
    !/^[a-z][a-z0-9_.]{2,127}$/.test(key) ||
    !Number.isFinite(amount) || amount <= 0
  )) {
    throw new Error('invalid placement capacity requirement');
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function checkedHttpEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid placement endpoint');
  }
  return url.toString().replace(/\/$/, '');
}

function checkedProviderEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
      url.username || url.password || url.hash) {
    throw new Error('invalid placement provider endpoint');
  }
  return url.toString().replace(/\/$/, '');
}

function checkedReason(value: string): string {
  const reason = String(value || '').trim();
  if (!reason || reason.length > 255 || /[\0\r\n]/.test(reason)) {
    throw new Error('invalid placement lifecycle reason');
  }
  return reason;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${field}`);
  return value;
}

function validFutureTimestamp(value: string, now: Date, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= now.getTime()) {
    throw new Error(`invalid ${field}`);
  }
  return new Date(parsed).toISOString();
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid placement time');
  }
  return value;
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function jsonRecord(value: unknown): CapacityRequirement {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, amount]) => [
        key,
        Number(amount)
      ])
    );
  }
  try {
    return jsonRecord(JSON.parse(String(value || '{}')));
  } catch {
    return {};
  }
}

function timestamp(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value == null || value === '' ? null : timestamp(value);
}
