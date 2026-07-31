import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComponentPlacementAdapter,
  componentPlacementPolicyConfig,
  type ComponentPlacementCoordinatorPort
} from '../src/agent-runtime/converact/placement/component-placement.js';
import type {
  InteractionPlacementOwnerComponent,
  InteractionPlacementRecord,
  ReservedInteractionPlacement
} from '../src/agent-runtime/converact/placement/interaction-placement.js';
import type {
  InteractionKind,
  PlacementRequest
} from '../src/agent-runtime/converact/placement/types.js';
import { MemoryPg } from '../src/db-pg.js';

test('component placement adapters compile trusted capacity for SIP Tinode and RustDesk', async () => {
  const requests: Array<PlacementRequest & {
    owner_component: InteractionPlacementOwnerComponent;
  }> = [];
  const coordinator = fixtureCoordinator(requests);
  const cases = [
    {
      kind: 'sip_voice' as const,
      owner: 'rustpbx' as const,
      capacity: { 'voice.weighted_calls': 1 }
    },
    {
      kind: 'tinode_im' as const,
      owner: 'tinode' as const,
      capacity: { 'im.sessions': 1 }
    },
    {
      kind: 'rustdesk_remote' as const,
      owner: 'rustdesk' as const,
      capacity: { 'remote.sessions': 1 }
    }
  ];

  for (const item of cases) {
    const adapter = new ComponentPlacementAdapter({
      coordinator,
      interaction_kind: item.kind,
      owner_component: item.owner,
      policy: {
        profile_id: 'cell-10k-v1',
        fixed_capacity: item.capacity
      }
    });
    const reservation = await adapter.reserve({
      tenant_id: 'tenant-a',
      interaction_id: `${item.kind}-a`,
      routing_partition_key: 'service-order-a',
      idempotency_key: `${item.kind}-idempotency`
    });
    assert.equal(reservation.interaction_id, `${item.kind}-a`);
    const request = requests.at(-1)!;
    assert.equal(request.interaction_kind, item.kind);
    assert.equal(request.owner_component, item.owner);
    assert.deepEqual(request.required_capacity, item.capacity);
    assert.match(request.routing_partition_id, new RegExp(`^${item.kind}:[a-f0-9]{32}$`));
  }
});

test('component placement owner lookup requires an active fenced owner', async () => {
  const requests: Array<PlacementRequest & {
    owner_component: InteractionPlacementOwnerComponent;
  }> = [];
  let record = placementRecord('sip_voice', 'rustpbx', 'active');
  const coordinator = fixtureCoordinator(requests, () => record);
  const adapter = new ComponentPlacementAdapter({
    coordinator,
    interaction_kind: 'sip_voice',
    owner_component: 'rustpbx',
    policy: {
      profile_id: 'cell-10k-v1',
      fixed_capacity: { 'voice.weighted_calls': 1 }
    }
  });

  const owner = await adapter.resolveOwner(new MemoryPg(), {
    tenant_id: 'tenant-a',
    interaction_id: 'sip_voice-a'
  });
  assert.deepEqual(owner, {
    interaction_kind: 'sip_voice',
    owner_component: 'rustpbx',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'rustpbx-a',
    owner_epoch: '12884901889',
    reservation_id: 'reservation-sip_voice',
    profile_id: 'cell-10k-v1',
    snapshot_version: 7,
    provider_endpoint: 'http://rustpbx-a.internal'
  });

  record = placementRecord('sip_voice', 'rustpbx', 'reserved');
  await assert.rejects(
    () => adapter.resolveOwner(new MemoryPg(), {
      tenant_id: 'tenant-a',
      interaction_id: 'sip_voice-a'
    }),
    (error: any) => error?.code === 'placement_owner_not_active' &&
      error?.retryable === true
  );
});

test('component placement forwards trusted Cell and node affinity for accepted interactions', async () => {
  const requests: Array<PlacementRequest & {
    owner_component: InteractionPlacementOwnerComponent;
  }> = [];
  const adapter = new ComponentPlacementAdapter({
    coordinator: fixtureCoordinator(requests),
    interaction_kind: 'sip_voice',
    owner_component: 'rustpbx',
    policy: {
      profile_id: 'cell-10k-v1',
      fixed_capacity: { 'voice.weighted_calls': 1 }
    }
  });

  await adapter.reserve({
    tenant_id: 'tenant-a',
    interaction_id: 'sip-inbound-a',
    routing_partition_key: 'inbound-sip-a',
    idempotency_key: 'inbound-idempotency-a',
    preferred_cell_id: 'cell-a',
    preferred_owner_node_id: 'rustpbx-a'
  });

  assert.equal(requests[0]?.preferred_cell_id, 'cell-a');
  assert.equal(requests[0]?.preferred_owner_node_id, 'rustpbx-a');
});

test('component placement policies are explicit and reject empty capacity', () => {
  const policy = componentPlacementPolicyConfig({
    OPC_IVEKIT_PLACEMENT_VOICE_POLICY_JSON: JSON.stringify({
      profile_id: 'cell-10k-v1',
      fixed_capacity: { 'voice.weighted_calls': 1 }
    })
  }, 'OPC_IVEKIT_PLACEMENT_VOICE_POLICY_JSON');
  assert.deepEqual(policy.fixed_capacity, { 'voice.weighted_calls': 1 });
  assert.throws(
    () => componentPlacementPolicyConfig(
      { OPC_IVEKIT_PLACEMENT_VOICE_POLICY_JSON: '{"profile_id":"cell-10k-v1","fixed_capacity":{}}' },
      'OPC_IVEKIT_PLACEMENT_VOICE_POLICY_JSON'
    ),
    /capacity/
  );
});

function fixtureCoordinator(
  requests: Array<PlacementRequest & {
    owner_component: InteractionPlacementOwnerComponent;
  }>,
  current: () => InteractionPlacementRecord | null = () => null
): ComponentPlacementCoordinatorPort {
  return {
    async reserve(input) {
      requests.push(input);
      return reserved(input);
    },
    async persistReserved() {},
    async releaseUncommitted() {},
    async requestState() {},
    async reconcileOne() {
      return { outcome: 'succeeded', record: current() };
    },
    async getPlacement() {
      return current();
    }
  };
}

function reserved(
  request: PlacementRequest & {
    owner_component: InteractionPlacementOwnerComponent;
  }
): ReservedInteractionPlacement {
  const record = placementRecord(
    request.interaction_kind,
    request.owner_component,
    'reserved',
    request.interaction_id
  );
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
      signed_placement_token: 'placement-token-a'
    },
    record,
    signed_placement_token: 'placement-token-a'
  };
}

function placementRecord(
  kind: InteractionKind,
  owner: InteractionPlacementOwnerComponent,
  state: 'reserved' | 'active',
  interactionId = `${kind}-a`
): InteractionPlacementRecord {
  return {
    id: `placement-${kind}`,
    tenant_id: 'tenant-a',
    interaction_id: interactionId,
    interaction_kind: kind,
    routing_partition_id: `${kind}:partition`,
    profile_id: 'cell-10k-v1',
    owner_component: owner,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: `${owner}-a`,
    owner_epoch: '12884901889',
    cell_lease_epoch: 3,
    reservation_id: `reservation-${kind}`,
    reservation_expires_at: '2026-07-16T12:00:10.000Z',
    admission_endpoint: 'http://admission-a.internal',
    provider_endpoint: `http://${owner}-a.internal`,
    snapshot_version: 7,
    placement_generation: 1,
    required_capacity: { [`${kind}.sessions`]: 1 },
    placement_token_sha256: 'a'.repeat(64),
    state,
    desired_state: state,
    sync_state: 'succeeded',
    lifecycle_reason: state === 'active' ? 'activated' : 'reserved',
    attempt_count: 0,
    max_attempts: 20,
    next_attempt_at: null,
    lease_until: null,
    worker_id: '',
    last_error_code: '',
    last_error_message: '',
    revision: 1,
    created_at: '2026-07-16T12:00:00.000Z',
    updated_at: '2026-07-16T12:00:00.000Z',
    activated_at: state === 'active' ? '2026-07-16T12:00:01.000Z' : null,
    closed_at: null
  };
}
