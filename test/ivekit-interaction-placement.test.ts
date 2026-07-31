import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  InteractionPlacementCoordinator,
  type InteractionPlacementEvent,
  type InteractionPlacementHandoffRecord,
  type InteractionPlacementRecord,
  type InteractionPlacementRepository
} from '../src/agent-runtime/ivekit/placement/interaction-placement.js';
import {
  PlacementError,
  type AdmissionReservation,
  type PlacementDecision,
  type PlacementRequest
} from '../src/agent-runtime/ivekit/placement/types.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';

test('interaction placement persists reservation and reconciles active then closed lifecycle', async () => {
  const repository = new MemoryPlacementRepository();
  const events: InteractionPlacementEvent[] = [];
  const lifecycleCalls: string[] = [];
  const coordinator = fixture({
    repository,
    events,
    lifecycle: {
      async activate(reservationId) {
        lifecycleCalls.push(`activate:${reservationId}`);
        return admission('active');
      },
      async close(reservationId) {
        lifecycleCalls.push(`close:${reservationId}`);
        return admission('closed');
      }
    }
  });
  const pg = new MemoryPg();
  const reserved = await coordinator.reserve(request());

  const stored = await coordinator.persistReserved(pg, reserved);
  assert.equal(stored.state, 'reserved');
  assert.equal(stored.desired_state, 'reserved');
  assert.equal(stored.owner_epoch, '12884901889');
  assert.equal(stored.cell_lease_epoch, 3);
  assert.equal(events[0]?.type, 'placement.reserved');

  await coordinator.requestState(pg, {
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    desired_state: 'active',
    reason: 'media_call_activated'
  });
  assert.equal(
    (await coordinator.reconcileOne({
      tenant_id: 'tenant-a',
      interaction_kind: 'livekit_av',
      interaction_id: 'call-a',
      worker_id: 'placement-worker-a'
    })).outcome,
    'succeeded'
  );
  assert.equal(repository.record?.state, 'active');
  assert.equal(events.at(-1)?.type, 'placement.activated');

  await coordinator.requestState(pg, {
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    desired_state: 'closed',
    reason: 'media_call_ended'
  });
  assert.equal(
    (await coordinator.reconcileOne({
      tenant_id: 'tenant-a',
      interaction_kind: 'livekit_av',
      interaction_id: 'call-a',
      worker_id: 'placement-worker-a'
    })).outcome,
    'succeeded'
  );
  assert.equal(repository.record?.state, 'closed');
  assert.deepEqual(lifecycleCalls, [
    'activate:reservation-a',
    'close:reservation-a'
  ]);
  assert.equal(events.at(-1)?.type, 'placement.closed');
});

test('interaction placement keeps retryable admission failures durable', async () => {
  const repository = new MemoryPlacementRepository();
  let attempts = 0;
  const coordinator = fixture({
    repository,
    lifecycle: {
      async activate() {
        attempts += 1;
        if (attempts === 1) {
          throw new PlacementError({
            code: 'admission_unavailable',
            status: 503,
            retryable: true
          });
        }
        return admission('active');
      },
      async close() {
        return admission('closed');
      }
    }
  });
  const pg = new MemoryPg();
  await coordinator.persistReserved(pg, await coordinator.reserve(request()));
  await coordinator.requestState(pg, {
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    desired_state: 'active',
    reason: 'media_call_activated'
  });

  const first = await coordinator.reconcileOne({
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    worker_id: 'placement-worker-a'
  });
  assert.equal(first.outcome, 'retry_wait');
  assert.equal(repository.record?.sync_state, 'retry_wait');
  assert.equal(repository.record?.last_error_code, 'admission_unavailable');

  repository.makeDue();
  const second = await coordinator.reconcileOne({
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    worker_id: 'placement-worker-b'
  });
  assert.equal(second.outcome, 'succeeded');
  assert.equal(repository.record?.state, 'active');
  assert.equal(attempts, 2);
});

test('interaction placement atomically rebuilds an owner and durably closes the source', async () => {
  const repository = new MemoryPlacementRepository();
  const events: InteractionPlacementEvent[] = [];
  const lifecycleCalls: string[] = [];
  const decisions = [decision(), replacementDecision()];
  const coordinator = fixture({
    repository,
    events,
    decisions,
    lifecycle: {
      async activate(reservationId) {
        lifecycleCalls.push(`activate:${reservationId}`);
        return reservationId === 'reservation-b'
          ? replacementAdmission('active')
          : admission('active');
      },
      async close(reservationId) {
        lifecycleCalls.push(`close:${reservationId}`);
        return reservationId === 'reservation-b'
          ? replacementAdmission('closed')
          : admission('closed');
      }
    }
  });
  const pg = new MemoryPg();
  await coordinator.persistReserved(pg, await coordinator.reserve(request()));
  await coordinator.requestState(pg, {
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    desired_state: 'active',
    reason: 'media_call_activated'
  });
  await coordinator.reconcileOne({
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    worker_id: 'placement-worker-a'
  });

  const replacement = await coordinator.reserve({
    ...request(),
    request_id: 'request-recovery-a',
    idempotency_key: 'placement-recovery-a',
    excluded_owner_node_ids: ['livekit-a']
  });
  const replaced = await coordinator.persistReplacement(pg, {
    reserved: replacement,
    expected_owner_epoch: '12884901889',
    expected_reservation_id: 'reservation-a',
    reason: 'livekit_owner_recovery'
  });
  assert.equal(replaced.replayed, false);
  assert.equal(replaced.record.placement_generation, 2);
  assert.equal(replaced.record.owner_node_id, 'livekit-b');
  assert.equal(replaced.handoff.state, 'prepared');

  assert.equal((await coordinator.reconcileOne({
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    worker_id: 'placement-worker-b'
  })).outcome, 'succeeded');
  assert.equal(repository.record?.state, 'active');
  assert.equal(repository.handoff?.state, 'source_close_pending');

  assert.equal(await coordinator.reconcileHandoffOne({
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    worker_id: 'placement-worker-b'
  }), 'succeeded');
  assert.equal(repository.handoff?.state, 'completed');
  assert.deepEqual(lifecycleCalls, [
    'activate:reservation-a',
    'activate:reservation-b',
    'close:reservation-a'
  ]);
  assert.equal(events.filter((event) => event.type === 'placement.recovered').length, 1);
});

test('interaction placement close supersedes an unprocessed activation', async () => {
  const repository = new MemoryPlacementRepository();
  const lifecycleCalls: string[] = [];
  const coordinator = fixture({
    repository,
    lifecycle: {
      async activate() {
        lifecycleCalls.push('activate');
        return admission('active');
      },
      async close() {
        lifecycleCalls.push('close');
        return admission('closed');
      }
    }
  });
  const pg = new MemoryPg();
  await coordinator.persistReserved(pg, await coordinator.reserve(request()));
  await coordinator.requestState(pg, {
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    desired_state: 'active',
    reason: 'accepted'
  });
  await coordinator.requestState(pg, {
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    desired_state: 'closed',
    reason: 'cancelled_before_join'
  });

  await coordinator.reconcileOne({
    tenant_id: 'tenant-a',
    interaction_kind: 'livekit_av',
    interaction_id: 'call-a',
    worker_id: 'placement-worker-a'
  });

  assert.deepEqual(lifecycleCalls, ['close']);
  assert.equal(repository.record?.state, 'closed');
});

test('interaction placement migration defines fenced durable lifecycle and worker discovery', () => {
  const sql = readFileSync(
    'src/migrations/080_ivekit_interaction_placements.sql',
    'utf8'
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_interaction_placements/);
  assert.match(sql, /owner_epoch NUMERIC\(20,0\)/);
  assert.match(sql, /cell_lease_epoch BIGINT/);
  assert.match(sql, /desired_state TEXT NOT NULL/);
  assert.match(sql, /sync_state TEXT NOT NULL/);
  assert.match(sql, /revision BIGINT NOT NULL/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /opc_ivekit_placement_tenant_ids/);
  assert.match(sql, /ALTER TABLE ivekit_interaction_placements FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /UNIQUE \(tenant_id, interaction_kind, interaction_id\)/);
  const handoffSql = readFileSync(
    'src/migrations/085_ivekit_interaction_placement_handoffs.sql',
    'utf8'
  );
  assert.match(handoffSql, /placement_generation BIGINT NOT NULL DEFAULT 1/);
  assert.match(handoffSql, /CREATE TABLE IF NOT EXISTS ivekit_interaction_placement_handoffs/);
  assert.match(handoffSql, /FORCE ROW LEVEL SECURITY/);
  assert.match(handoffSql, /source_close_pending/);
  assert.match(handoffSql, /opc_ivekit_placement_tenant_ids/);
});

function fixture(input: {
  repository: MemoryPlacementRepository;
  lifecycle: {
    activate(reservationId: string): Promise<AdmissionReservation>;
    close(reservationId: string): Promise<AdmissionReservation>;
  };
  events?: InteractionPlacementEvent[];
  decisions?: PlacementDecision[];
}) {
  return new InteractionPlacementCoordinator({
    planner: {
      async place(): Promise<PlacementDecision> {
        return input.decisions?.shift() || decision();
      }
    },
    root_pg: new MemoryPg(),
    repository_factory: () => input.repository,
    lifecycle_factory: () => input.lifecycle,
    append_event: async (_pg, event) => {
      input.events?.push(event);
    },
    now: () => new Date('2026-07-16T08:00:00.000Z'),
    id_factory: () => 'iplacement-a'
  });
}

function request(): PlacementRequest & { owner_component: 'livekit' } {
  return {
    request_id: 'request-a',
    idempotency_key: 'placement-idem-a',
    tenant_id: 'tenant-a',
    routing_partition_id: 'service-order-a',
    interaction_id: 'call-a',
    interaction_kind: 'livekit_av',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'video.participants': 2 },
    owner_component: 'livekit'
  };
}

function decision(): PlacementDecision {
  return {
    request_id: 'request-a',
    interaction_id: 'call-a',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'livekit-a',
    owner_epoch: '12884901889',
    reservation_id: 'reservation-a',
    reservation_expires_at: '2026-07-16T08:00:10.000Z',
    snapshot_version: 7,
    admission_endpoint: 'https://admission.cell-a.internal',
    endpoint: 'https://livekit-a.internal',
    signed_placement_token: 'placement-token-a'
  };
}

function replacementDecision(): PlacementDecision {
  return {
    request_id: 'request-recovery-a',
    interaction_id: 'call-a',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'livekit-b',
    owner_epoch: '12884901890',
    reservation_id: 'reservation-b',
    reservation_expires_at: '2026-07-16T08:00:10.000Z',
    snapshot_version: 8,
    admission_endpoint: 'https://admission.cell-a.internal',
    endpoint: 'https://livekit-b.internal',
    signed_placement_token: 'placement-token-b'
  };
}

function admission(state: 'active' | 'closed'): AdmissionReservation {
  return {
    reservation_id: 'reservation-a',
    state,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'livekit-a',
    owner_epoch: '12884901889',
    endpoint: 'https://livekit-a.internal',
    expires_at: '2026-07-16T08:00:10.000Z',
    required_capacity: { 'video.participants': 2 }
  };
}

function replacementAdmission(state: 'active' | 'closed'): AdmissionReservation {
  return {
    reservation_id: 'reservation-b',
    state,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'livekit-b',
    owner_epoch: '12884901890',
    endpoint: 'https://livekit-b.internal',
    expires_at: '2026-07-16T08:00:10.000Z',
    required_capacity: { 'video.participants': 2 }
  };
}

class MemoryPlacementRepository implements InteractionPlacementRepository {
  record: InteractionPlacementRecord | null = null;
  handoff: InteractionPlacementHandoffRecord | null = null;

  async insertReserved(input: InteractionPlacementRecord): Promise<InteractionPlacementRecord> {
    this.record = structuredClone(input);
    return structuredClone(this.record);
  }

  async getPlacement(): Promise<InteractionPlacementRecord | null> {
    return this.record ? structuredClone(this.record) : null;
  }

  async replaceReserved(input: {
    expected_owner_epoch: string;
    expected_reservation_id: string;
    replacement: InteractionPlacementRecord;
    reason: string;
    max_attempts: number;
    now: Date;
  }) {
    assert.ok(this.record);
    assert.equal(this.record.owner_epoch, input.expected_owner_epoch);
    assert.equal(this.record.reservation_id, input.expected_reservation_id);
    const previous = structuredClone(this.record);
    const generation = previous.placement_generation + 1;
    this.handoff = {
      id: input.replacement.id,
      tenant_id: previous.tenant_id,
      interaction_id: previous.interaction_id,
      interaction_kind: previous.interaction_kind,
      placement_generation: generation,
      from_region_id: previous.region_id,
      from_zone_id: previous.zone_id,
      from_cell_id: previous.cell_id,
      from_owner_node_id: previous.owner_node_id,
      from_owner_epoch: previous.owner_epoch,
      from_reservation_id: previous.reservation_id,
      from_admission_endpoint: previous.admission_endpoint,
      from_provider_endpoint: previous.provider_endpoint,
      from_required_capacity: previous.required_capacity,
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
    this.record = {
      ...structuredClone(input.replacement),
      id: previous.id,
      placement_generation: generation,
      state: 'reserved',
      desired_state: 'active',
      sync_state: 'pending',
      lifecycle_reason: input.reason,
      next_attempt_at: input.now.toISOString(),
      revision: previous.revision + 1,
      created_at: previous.created_at,
      updated_at: input.now.toISOString(),
      activated_at: previous.activated_at
    };
    return {
      record: structuredClone(this.record),
      handoff: structuredClone(this.handoff),
      replayed: false
    };
  }

  async requestState(input: {
    tenant_id: string;
    interaction_kind: InteractionPlacementRecord['interaction_kind'];
    interaction_id: string;
    desired_state: 'active' | 'closed';
    reason: string;
    now: Date;
  }): Promise<InteractionPlacementRecord> {
    assert.ok(this.record);
    this.record.desired_state = input.desired_state;
    this.record.sync_state = 'pending';
    this.record.attempt_count = 0;
    this.record.next_attempt_at = input.now.toISOString();
    this.record.last_error_code = '';
    this.record.last_error_message = '';
    this.record.lifecycle_reason = input.reason;
    this.record.revision += 1;
    return structuredClone(this.record);
  }

  async claimOne(input: {
    tenant_id: string;
    interaction_kind: InteractionPlacementRecord['interaction_kind'];
    interaction_id: string;
    worker_id: string;
    now: Date;
    lease_ms: number;
  }): Promise<InteractionPlacementRecord | null> {
    if (!this.record ||
        this.record.tenant_id !== input.tenant_id ||
        this.record.interaction_kind !== input.interaction_kind ||
        this.record.interaction_id !== input.interaction_id ||
        !['pending', 'retry_wait', 'processing'].includes(this.record.sync_state) ||
        (this.record.next_attempt_at &&
          Date.parse(this.record.next_attempt_at) > input.now.getTime())) {
      return null;
    }
    this.record.sync_state = 'processing';
    this.record.worker_id = input.worker_id;
    this.record.lease_until = new Date(
      input.now.getTime() + input.lease_ms
    ).toISOString();
    this.record.attempt_count += 1;
    this.record.revision += 1;
    return structuredClone(this.record);
  }

  async complete(input: {
    tenant_id: string;
    id: string;
    worker_id: string;
    revision: number;
    desired_state: 'active' | 'closed';
    now: Date;
  }): Promise<InteractionPlacementRecord> {
    assert.ok(this.record);
    assert.equal(this.record.id, input.id);
    assert.equal(this.record.worker_id, input.worker_id);
    assert.equal(this.record.revision, input.revision);
    assert.equal(this.record.desired_state, input.desired_state);
    this.record.state = input.desired_state;
    this.record.sync_state = 'succeeded';
    this.record.worker_id = '';
    this.record.lease_until = null;
    this.record.next_attempt_at = null;
    this.record.last_error_code = '';
    this.record.last_error_message = '';
    this.record.revision += 1;
    if (this.handoff?.state === 'prepared' &&
        this.handoff.to_reservation_id === this.record.reservation_id) {
      this.handoff.state = 'source_close_pending';
      this.handoff.sync_state = 'pending';
      this.handoff.next_attempt_at = input.now.toISOString();
      this.handoff.revision += 1;
    }
    return structuredClone(this.record);
  }

  async release(input: {
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
    assert.ok(this.record);
    assert.equal(this.record.id, input.id);
    assert.equal(this.record.worker_id, input.worker_id);
    assert.equal(this.record.revision, input.revision);
    this.record.sync_state = input.sync_state;
    this.record.worker_id = '';
    this.record.lease_until = null;
    this.record.next_attempt_at = input.next_attempt_at?.toISOString() || null;
    this.record.last_error_code = input.error_code;
    this.record.last_error_message = input.error_message;
    this.record.revision += 1;
    return structuredClone(this.record);
  }

  async listDueTenantIds(): Promise<string[]> {
    return this.record || this.handoff
      ? [this.record?.tenant_id || this.handoff!.tenant_id]
      : [];
  }

  async claimDue(): Promise<InteractionPlacementRecord[]> {
    return [];
  }

  async claimHandoffOne(input: {
    worker_id: string;
    now: Date;
    lease_ms: number;
  }): Promise<InteractionPlacementHandoffRecord | null> {
    if (!this.handoff ||
        this.handoff.state !== 'source_close_pending' ||
        !['pending', 'retry_wait', 'processing'].includes(this.handoff.sync_state)) {
      return null;
    }
    this.handoff.sync_state = 'processing';
    this.handoff.worker_id = input.worker_id;
    this.handoff.lease_until = new Date(
      input.now.getTime() + input.lease_ms
    ).toISOString();
    this.handoff.attempt_count += 1;
    this.handoff.revision += 1;
    return structuredClone(this.handoff);
  }

  async claimDueHandoffs(input: {
    worker_id: string;
    now: Date;
    lease_ms: number;
  }): Promise<InteractionPlacementHandoffRecord[]> {
    const claimed = await this.claimHandoffOne(input);
    return claimed ? [claimed] : [];
  }

  async completeHandoff(input: {
    worker_id: string;
    revision: number;
    now: Date;
  }): Promise<InteractionPlacementHandoffRecord> {
    assert.ok(this.handoff);
    assert.equal(this.handoff.worker_id, input.worker_id);
    assert.equal(this.handoff.revision, input.revision);
    this.handoff.state = 'completed';
    this.handoff.sync_state = 'succeeded';
    this.handoff.worker_id = '';
    this.handoff.lease_until = null;
    this.handoff.next_attempt_at = null;
    this.handoff.completed_at = input.now.toISOString();
    this.handoff.updated_at = input.now.toISOString();
    this.handoff.revision += 1;
    return structuredClone(this.handoff);
  }

  async releaseHandoff(input: {
    worker_id: string;
    revision: number;
    sync_state: 'retry_wait' | 'failed';
    next_attempt_at: Date | null;
    error_code: string;
    error_message: string;
    now: Date;
  }): Promise<InteractionPlacementHandoffRecord> {
    assert.ok(this.handoff);
    assert.equal(this.handoff.worker_id, input.worker_id);
    assert.equal(this.handoff.revision, input.revision);
    this.handoff.state = input.sync_state === 'failed'
      ? 'failed'
      : 'source_close_pending';
    this.handoff.sync_state = input.sync_state;
    this.handoff.worker_id = '';
    this.handoff.lease_until = null;
    this.handoff.next_attempt_at = input.next_attempt_at?.toISOString() || null;
    this.handoff.last_error_code = input.error_code;
    this.handoff.last_error_message = input.error_message;
    this.handoff.updated_at = input.now.toISOString();
    this.handoff.revision += 1;
    return structuredClone(this.handoff);
  }

  makeDue(): void {
    if (this.record) this.record.next_attempt_at = '2026-07-16T07:59:59.000Z';
  }
}
