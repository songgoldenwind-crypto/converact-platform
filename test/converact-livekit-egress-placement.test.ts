import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LiveKitEgressPlacementAdapter,
  liveKitEgressPlacementPolicies
} from '../src/agent-runtime/converact/placement/livekit-egress-placement.js';
import type { ComponentPlacementCoordinatorPort } from '../src/agent-runtime/converact/placement/component-placement.js';
import type {
  InteractionPlacementOwnerComponent,
  InteractionPlacementRecord,
  ReservedInteractionPlacement
} from '../src/agent-runtime/converact/placement/interaction-placement.js';
import type { PlacementRequest } from '../src/agent-runtime/converact/placement/types.js';
import { MemoryPg } from '../src/db-pg.js';

test('Egress placement uses disjoint Track and Composite capacity dimensions', async () => {
  const requests: Array<PlacementRequest & { owner_component: InteractionPlacementOwnerComponent }> = [];
  const states: string[] = [];
  const stateIdentities: Array<{ reservation_id?: string; owner_epoch?: string }> = [];
  const adapter = new LiveKitEgressPlacementAdapter({
    coordinator: coordinator(requests, states, stateIdentities),
    policies: {
      track: { profile_id: 'cell-10k-v1', fixed_capacity: { 'workers.track_egress_slots': 1 } },
      composite: { profile_id: 'cell-10k-v1', fixed_capacity: { 'workers.composite_egress_slots': 1 } }
    }
  });
  const pg = new MemoryPg();

  const track = await adapter.reserveJob(pg, placementInput('job-track', 'track'));
  const composite = await adapter.reserveJob(pg, placementInput('job-composite', 'room_composite'));
  await adapter.activateJob(pg, track);
  await adapter.closeJob(pg, composite, 'provider_completed');

  assert.deepEqual(requests.map((request) => request.required_capacity), [
    { 'workers.track_egress_slots': 1 },
    { 'workers.composite_egress_slots': 1 }
  ]);
  assert.deepEqual(requests.map((request) => request.interaction_kind), ['livekit_av', 'livekit_av']);
  assert.deepEqual(requests.map((request) => request.owner_component), ['livekit', 'livekit']);
  assert.equal(track.reservation_id, 'reservation-job-track');
  assert.equal(track.owner_epoch, '12884901889');
  assert.deepEqual(states, ['job-track:active:egress_provider_started', 'job-composite:closed:provider_completed']);
  assert.deepEqual(stateIdentities, [
    { reservation_id: 'reservation-job-track', owner_epoch: '12884901889' },
    { reservation_id: 'reservation-job-composite', owner_epoch: '12884901889' }
  ]);
});

test('Egress placement policy configuration is explicit and rejects shared dimensions', () => {
  const policies = liveKitEgressPlacementPolicies({
    CONVERACT_FABRIC_PLACEMENT_EGRESS_TRACK_POLICY_JSON: JSON.stringify({
      profile_id: 'cell-10k-v1', fixed_capacity: { 'workers.track_egress_slots': 1 }
    }),
    CONVERACT_FABRIC_PLACEMENT_EGRESS_COMPOSITE_POLICY_JSON: JSON.stringify({
      profile_id: 'cell-10k-v1', fixed_capacity: { 'workers.composite_egress_slots': 1 }
    })
  });
  assert.equal(policies.track.profile_id, 'cell-10k-v1');
  assert.throws(() => liveKitEgressPlacementPolicies({
    CONVERACT_FABRIC_PLACEMENT_EGRESS_TRACK_POLICY_JSON: JSON.stringify({
      profile_id: 'cell-10k-v1', fixed_capacity: { 'workers.egress_slots': 1 }
    }),
    CONVERACT_FABRIC_PLACEMENT_EGRESS_COMPOSITE_POLICY_JSON: JSON.stringify({
      profile_id: 'cell-10k-v1', fixed_capacity: { 'workers.egress_slots': 1 }
    })
  }), /must use disjoint capacity dimensions/);
});

function placementInput(jobId: string, recordingMode: 'track' | 'room_composite') {
  return {
    tenant_id: 'tenant-a',
    recording_id: 'recording-a',
    job_id: jobId,
    room_name: 'room-a',
    recording_mode: recordingMode,
    business_ref: { tenant_id: 'tenant-a', type: 'order', id: 'order-a' }
  };
}

function coordinator(
  requests: Array<PlacementRequest & { owner_component: InteractionPlacementOwnerComponent }>,
  states: string[],
  stateIdentities: Array<{ reservation_id?: string; owner_epoch?: string }>
): ComponentPlacementCoordinatorPort {
  return {
    async reserve(request) {
      requests.push(request);
      return reserved(request);
    },
    async persistReserved() {},
    async releaseUncommitted() {},
    async requestState(_pg, input) {
      states.push(`${input.interaction_id}:${input.desired_state}:${input.reason}`);
      stateIdentities.push({
        reservation_id: input.expected_reservation_id,
        owner_epoch: input.expected_owner_epoch
      });
    },
    async reconcileOne() { return { outcome: 'succeeded', record: null }; },
    async getPlacement() { return null; }
  };
}

function reserved(
  request: PlacementRequest & { owner_component: InteractionPlacementOwnerComponent }
): ReservedInteractionPlacement {
  const record = placementRecord(request);
  return {
    request,
    owner_component: request.owner_component,
    decision: {
      request_id: request.request_id,
      interaction_id: request.interaction_id,
      region_id: record.region_id,
      zone_id: record.zone_id,
      cell_id: record.cell_id,
      owner_node_id: record.owner_node_id,
      owner_epoch: record.owner_epoch,
      reservation_id: record.reservation_id,
      reservation_expires_at: record.reservation_expires_at,
      snapshot_version: record.snapshot_version,
      admission_endpoint: record.admission_endpoint,
      endpoint: record.provider_endpoint,
      signed_placement_token: 'placement-token'
    },
    record,
    signed_placement_token: 'placement-token'
  };
}

function placementRecord(
  request: PlacementRequest & { owner_component: InteractionPlacementOwnerComponent }
): InteractionPlacementRecord {
  return {
    id: `placement-${request.interaction_id}`,
    tenant_id: request.tenant_id,
    interaction_id: request.interaction_id,
    interaction_kind: request.interaction_kind,
    routing_partition_id: request.routing_partition_id,
    profile_id: request.profile_id,
    owner_component: request.owner_component,
    region_id: 'region-a', zone_id: 'zone-a', cell_id: 'cell-a', owner_node_id: 'egress-track-0',
    owner_epoch: '12884901889', cell_lease_epoch: 3,
    reservation_id: `reservation-${request.interaction_id}`,
    reservation_expires_at: '2026-07-17T03:00:30.000Z',
    admission_endpoint: 'http://admission-a.internal', provider_endpoint: 'http://egress.internal',
    snapshot_version: 7, placement_generation: 1,
    required_capacity: request.required_capacity, placement_token_sha256: 'a'.repeat(64),
    state: 'reserved', desired_state: 'reserved', sync_state: 'succeeded', lifecycle_reason: 'reserved',
    attempt_count: 0, max_attempts: 20, next_attempt_at: null, lease_until: null, worker_id: '',
    last_error_code: '', last_error_message: '', revision: 1,
    created_at: '2026-07-17T03:00:00.000Z', updated_at: '2026-07-17T03:00:00.000Z',
    activated_at: null, closed_at: null
  };
}
