import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MediaCallPlacementAdapter,
  mediaCallPlacementPolicyConfig
} from '../src/agent-runtime/converact/placement/media-call-placement.js';
import type {
  InteractionPlacementRecord,
  ReservedInteractionPlacement
} from '../src/agent-runtime/converact/placement/interaction-placement.js';
import type {
  PlacementDecision,
  PlacementRequest
} from '../src/agent-runtime/converact/placement/types.js';
import { MemoryPg } from '../src/db-pg.js';

test('media placement adapter compiles trusted participant capacity and hashed partition', async () => {
  const requests: Array<PlacementRequest & { owner_component: 'livekit' }> = [];
  const states: string[] = [];
  let owner: InteractionPlacementRecord = {
    ...reserved({
      request_id: 'request-owner',
      idempotency_key: 'idempotency-owner',
      tenant_id: 'tenant-a',
      routing_partition_id: 'media:owner',
      interaction_id: 'call-a',
      interaction_kind: 'livekit_av' as const,
      profile_id: 'cell-10k-v1',
      required_capacity: { 'video.rooms': 1 },
      owner_component: 'livekit' as const
    }).record,
    state: 'active' as const,
    desired_state: 'active' as const,
    sync_state: 'succeeded' as const
  };
  const adapter = new MediaCallPlacementAdapter({
    coordinator: {
      async reserve(input) {
        requests.push(input);
        return reserved(input);
      },
      async persistReserved() {},
      async releaseUncommitted() {},
      async requestState(_pg, input) {
        states.push(`${input.desired_state}:${input.interaction_kind}`);
        return {} as never;
      },
      async reconcileOne() {
        return { outcome: 'succeeded' as const, record: null };
      },
      async getPlacement() {
        return owner;
      }
    },
    policy: {
      profile_id: 'cell-10k-v1',
      fixed_capacity: { 'video.rooms': 1 },
      per_participant_capacity: { 'video.participants': 1 }
    }
  });

  const placement = await adapter.reserve({
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    media: 'video',
    participant_count: 3,
    business_ref: {
      tenant_id: 'tenant-a',
      type: 'service_order',
      id: 'order / with unsafe routing characters',
      metadata: {}
    },
    idempotency_key: 'client request key'
  });
  assert.equal(placement.interaction_id, 'call-a');
  assert.deepEqual(requests[0]?.required_capacity, {
    'video.participants': 3,
    'video.rooms': 1
  });
  assert.match(requests[0]?.routing_partition_id || '', /^media:[a-f0-9]{32}$/);
  assert.match(requests[0]?.idempotency_key || '', /^media:[a-f0-9]{32}$/);
  assert.equal(requests[0]?.owner_component, 'livekit');

  await adapter.requestState(new MemoryPg(), {
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    desired_state: 'active',
    reason: 'media_call_activated'
  });
  assert.deepEqual(states, ['active:livekit_av']);

  const resolved = await adapter.resolveOwner(new MemoryPg(), {
    tenant_id: 'tenant-a',
    interaction_id: 'call-a'
  });
  assert.deepEqual(resolved, {
    interaction_id: 'call-a',
    reservation_id: 'reservation-a',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'livekit-a',
    owner_epoch: '12884901889',
    profile_id: 'cell-10k-v1',
    snapshot_version: 1,
    placement_generation: 1,
    livekit_url: 'wss://livekit-a.internal'
  });

  owner = { ...owner, state: 'reserved', desired_state: 'reserved' };
  await assert.rejects(
    () => adapter.resolveOwner(new MemoryPg(), {
      tenant_id: 'tenant-a',
      interaction_id: 'call-a'
    }),
    (error: any) => error?.code === 'placement_owner_not_active' &&
      error?.status === 503 &&
      error?.retryable === true
  );
});

test('media placement recovery excludes the failed owner and converges on one generation', async () => {
  const requests: Array<PlacementRequest & { owner_component: 'livekit' }> = [];
  const handoffs: string[] = [];
  let owner = activeRecord(reserved({
    request_id: 'request-owner',
    idempotency_key: 'idempotency-owner',
    tenant_id: 'tenant-a',
    routing_partition_id: 'media:owner',
    interaction_id: 'call-a',
    interaction_kind: 'livekit_av',
    profile_id: 'cell-10k-v1',
    required_capacity: {
      'video.participants': 2,
      'video.rooms': 1
    },
    owner_component: 'livekit'
  }).record);
  const adapter = new MediaCallPlacementAdapter({
    coordinator: {
      async reserve(input) {
        requests.push(input);
        const next = reserved(input);
        next.record = {
          ...next.record,
          id: 'ipl-b',
          owner_node_id: 'livekit-b',
          owner_epoch: '12884901890',
          reservation_id: 'reservation-b',
          provider_endpoint: 'https://livekit-b.internal',
          placement_token_sha256: 'b'.repeat(64)
        };
        return next;
      },
      async persistReserved() {},
      async releaseUncommitted() {},
      async requestState() {},
      async reconcileOne() {
        owner = activeRecord(owner);
        return { outcome: 'succeeded' as const, record: owner };
      },
      async getPlacement() {
        return owner;
      },
      async inspectOwner() {
        return { status: 'recoverable', reason: 'owner_node_offline' };
      },
      async persistReplacement(_pg, input) {
        owner = {
          ...input.reserved.record,
          id: owner.id,
          placement_generation: owner.placement_generation + 1,
          state: 'reserved',
          desired_state: 'active',
          sync_state: 'pending'
        };
        return {
          record: owner,
          replayed: false
        };
      },
      async reconcileHandoffOne() {
        handoffs.push('closed-source');
        return 'succeeded' as const;
      }
    },
    policy: {
      profile_id: 'cell-10k-v1',
      fixed_capacity: { 'video.rooms': 1 },
      per_participant_capacity: { 'video.participants': 1 }
    }
  });

  const recovered = await adapter.recoverOwner(new MemoryPg(), {
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    expected_owner_epoch: '12884901889',
    expected_reservation_id: 'reservation-a',
    worker_id: 'media-recovery-worker'
  });

  assert.deepEqual(requests[0]?.excluded_owner_node_ids, ['livekit-a']);
  assert.equal(recovered.owner_node_id, 'livekit-b');
  assert.equal(recovered.owner_epoch, '12884901890');
  assert.equal(recovered.placement_generation, 2);
  assert.deepEqual(handoffs, ['closed-source']);
});

test('media placement policy requires explicit non-empty trusted capacity', () => {
  const policy = mediaCallPlacementPolicyConfig({
    OPC_IVEKIT_PLACEMENT_MEDIA_POLICY_JSON: JSON.stringify({
      profile_id: 'cell-10k-v1',
      fixed_capacity: {},
      per_participant_capacity: { 'video.participants': 1 }
    })
  });
  assert.equal(policy.profile_id, 'cell-10k-v1');
  assert.throws(
    () => mediaCallPlacementPolicyConfig({
      OPC_IVEKIT_PLACEMENT_MEDIA_POLICY_JSON: JSON.stringify({
        profile_id: 'cell-10k-v1',
        fixed_capacity: {},
        per_participant_capacity: {}
      })
    }),
    /capacity/
  );
});

function reserved(
  request: PlacementRequest & { owner_component: 'livekit' }
): ReservedInteractionPlacement {
  const decision: PlacementDecision = {
    request_id: request.request_id,
    interaction_id: request.interaction_id,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'livekit-a',
    owner_epoch: '12884901889',
    reservation_id: 'reservation-a',
    reservation_expires_at: '2026-07-16T08:00:10.000Z',
    snapshot_version: 1,
    admission_endpoint: 'https://admission-a.internal',
    endpoint: 'https://livekit-a.internal',
    signed_placement_token: 'token-a'
  };
  return {
    request,
    owner_component: 'livekit',
    decision,
    signed_placement_token: 'token-a',
    record: {
      id: 'ipl-a',
      tenant_id: request.tenant_id,
      interaction_id: request.interaction_id,
      interaction_kind: 'livekit_av',
      routing_partition_id: request.routing_partition_id,
      profile_id: request.profile_id,
      owner_component: 'livekit',
      region_id: 'region-a',
      zone_id: 'zone-a',
      cell_id: 'cell-a',
      owner_node_id: 'livekit-a',
      owner_epoch: '12884901889',
      cell_lease_epoch: 3,
      reservation_id: 'reservation-a',
      reservation_expires_at: '2026-07-16T08:00:10.000Z',
      admission_endpoint: 'https://admission-a.internal',
      provider_endpoint: 'https://livekit-a.internal',
      snapshot_version: 1,
      placement_generation: 1,
      required_capacity: request.required_capacity,
      placement_token_sha256: 'a'.repeat(64),
      state: 'reserved',
      desired_state: 'reserved',
      sync_state: 'succeeded',
      lifecycle_reason: 'placement_reserved',
      attempt_count: 0,
      max_attempts: 20,
      next_attempt_at: null,
      lease_until: null,
      worker_id: '',
      last_error_code: '',
      last_error_message: '',
      revision: 1,
      created_at: '2026-07-16T08:00:00.000Z',
      updated_at: '2026-07-16T08:00:00.000Z',
      activated_at: null,
      closed_at: null
    }
  };
}

function activeRecord(
  record: InteractionPlacementRecord
): InteractionPlacementRecord {
  return {
    ...record,
    state: 'active',
    desired_state: 'active',
    sync_state: 'succeeded'
  };
}
