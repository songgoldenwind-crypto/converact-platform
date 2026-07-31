import assert from 'node:assert/strict';
import test from 'node:test';

import { routeIveKitMediaApi } from '../src/agent-runtime/converact/media-http.js';
import {
  MediaCallService,
  type MediaCallPlacementPort
} from '../src/agent-runtime/livekit/media-call-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';

test('media call create activates its durable reservation in the post-commit path', async () => {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = 'placement-create-secret-at-least-32-bytes';
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const calls: string[] = [];
  const placement = placementFixture(calls);

  try {
    const response = await routeIveKitMediaApi(
      db,
      'POST',
      '/api/ivekit/media/calls',
      new URL('http://localhost/api/ivekit/media/calls'),
      {
        media: 'video',
        participant_identities: ['guest-a'],
        business_ref: { type: 'service_order', id: 'order-placement-create' }
      },
      '',
      {
        authorization: `Bearer ${signAccessToken({
          sub: 'host-a',
          tid: 'tenant-placement-create',
          role: 'operator'
        })}`,
        'idempotency-key': 'placement-create'
      },
      { pg, placement }
    ) as {
      data: { call: { id: string } };
      afterCommit: () => Promise<unknown>;
    };

    assert.deepEqual(calls.slice(0, 3), [
      `reserve:${response.data.call.id}`,
      `persist:${response.data.call.id}`,
      `state:active:${response.data.call.id}`
    ]);
    await response.afterCommit();
    assert.equal(calls.at(-1), `reconcile:${response.data.call.id}`);
  } finally {
    db.close();
    if (previousSecret === undefined) delete process.env.CONVERACT_JWT_SECRET;
    else process.env.CONVERACT_JWT_SECRET = previousSecret;
  }
});

test('call-bound join resolves the active Cell owner and returns its LiveKit URL', async () => {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = 'placement-join-secret-at-least-32-bytes';
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const service = new MediaCallService(new MediaCallStore(pg));
  const tenantId = 'tenant-placement-join';
  const created = await service.createCall({
    tenant_id: tenantId,
    initiated_by: 'host-a',
    media: 'video',
    participant_identities: ['guest-a'],
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order-placement-join',
      metadata: {}
    }
  });
  await service.transition({
    tenant_id: tenantId,
    call_id: created.call.id,
    action: 'ring',
    actor_identity: 'host-a',
    idempotency_key: 'placement-join-ring'
  });
  await service.transition({
    tenant_id: tenantId,
    call_id: created.call.id,
    action: 'accept',
    actor_identity: 'guest-a',
    idempotency_key: 'placement-join-accept'
  });
  const resolved: string[] = [];
  const placement: MediaCallPlacementPort = {
    async reserve() {
      throw new Error('not used');
    },
    async persistReserved() {},
    async releaseUncommitted() {},
    async requestState() {},
    async reconcileOne() {
      return { outcome: 'succeeded' };
    },
    async resolveOwner(_pg, input) {
      resolved.push(`${input.tenant_id}:${input.interaction_id}`);
      return {
        interaction_id: input.interaction_id,
        reservation_id: 'reservation-livekit-cell-a',
        region_id: 'region-a',
        zone_id: 'zone-a',
        cell_id: 'cell-a',
        owner_node_id: 'livekit-a',
        owner_epoch: '12884901889',
        profile_id: 'cell-10k-v1',
        snapshot_version: 9,
        livekit_url: 'wss://livekit-cell-a.example.com'
      };
    }
  };

  try {
    const response = await routeIveKitMediaApi(
      db,
      'POST',
      `/api/ivekit/media/calls/${created.call.id}/join`,
      new URL(`http://localhost/api/ivekit/media/calls/${created.call.id}/join`),
      { identity: 'host-a' },
      '',
      {
        authorization: `Bearer ${signAccessToken({
          sub: 'host-a',
          tid: tenantId,
          role: 'operator'
        })}`
      },
      { pg, placement }
    ) as {
      status: number;
      data: {
        token: {
          livekit_url: string;
          placement: {
            interaction_id: string;
            reservation_id: string;
            cell_id: string;
            owner_epoch: string;
          };
        };
      };
    };

    assert.equal(response.status, 201);
    assert.deepEqual(resolved, [`${tenantId}:${created.call.id}`]);
    assert.equal(response.data.token.livekit_url, 'wss://livekit-cell-a.example.com');
    assert.deepEqual(response.data.token.placement, {
      interaction_id: created.call.id,
      reservation_id: 'reservation-livekit-cell-a',
      region_id: 'region-a',
      zone_id: 'zone-a',
      cell_id: 'cell-a',
      owner_node_id: 'livekit-a',
      owner_epoch: '12884901889',
      profile_id: 'cell-10k-v1',
      snapshot_version: 9,
      livekit_url: 'wss://livekit-cell-a.example.com'
    });
  } finally {
    db.close();
    if (previousSecret === undefined) delete process.env.CONVERACT_JWT_SECRET;
    else process.env.CONVERACT_JWT_SECRET = previousSecret;
  }
});

test('terminal call rejoin conditionally recovers from its previous placement identity', async () => {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = 'placement-recovery-secret-at-least-32-bytes';
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const service = new MediaCallService(new MediaCallStore(pg));
  const tenantId = 'tenant-placement-recovery';
  const created = await service.createCall({
    tenant_id: tenantId,
    initiated_by: 'host-a',
    media: 'video',
    participant_identities: ['guest-a'],
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'order-placement-recovery',
      metadata: {}
    }
  });
  await service.transition({
    tenant_id: tenantId,
    call_id: created.call.id,
    action: 'ring',
    actor_identity: 'host-a',
    idempotency_key: 'placement-recovery-ring'
  });
  await service.transition({
    tenant_id: tenantId,
    call_id: created.call.id,
    action: 'accept',
    actor_identity: 'guest-a',
    idempotency_key: 'placement-recovery-accept'
  });
  const recovered: unknown[] = [];
  const placement: MediaCallPlacementPort = {
    async reserve() {
      throw new Error('not used');
    },
    async persistReserved() {},
    async releaseUncommitted() {},
    async requestState() {},
    async reconcileOne() {
      return { outcome: 'succeeded' };
    },
    async resolveOwner() {
      throw new Error('normal owner resolution must not be used');
    },
    async recoverOwner(_pg, input) {
      recovered.push(input);
      return {
        interaction_id: input.interaction_id,
        reservation_id: 'reservation-livekit-cell-b',
        region_id: 'region-a',
        zone_id: 'zone-b',
        cell_id: 'cell-b',
        owner_node_id: 'livekit-b',
        owner_epoch: '12884901890',
        profile_id: 'cell-10k-v1',
        snapshot_version: 10,
        placement_generation: 2,
        livekit_url: 'wss://livekit-cell-b.example.com'
      };
    }
  };

  try {
    const response = await routeIveKitMediaApi(
      db,
      'POST',
      `/api/ivekit/media/calls/${created.call.id}/join`,
      new URL(`http://localhost/api/ivekit/media/calls/${created.call.id}/join`),
      {
        identity: 'host-a',
        recovery: {
          previous_owner_epoch: '12884901889',
          previous_reservation_id: 'reservation-livekit-cell-a'
        }
      },
      '',
      {
        authorization: `Bearer ${signAccessToken({
          sub: 'host-a',
          tid: tenantId,
          role: 'operator'
        })}`
      },
      {
        pg,
        placement,
        placementWorkerId: 'media-recovery-worker'
      }
    ) as {
      data: {
        token: {
          placement: {
            owner_node_id: string;
            owner_epoch: string;
            placement_generation: number;
          };
        };
      };
    };

    assert.deepEqual(recovered, [{
      tenant_id: tenantId,
      interaction_id: created.call.id,
      expected_owner_epoch: '12884901889',
      expected_reservation_id: 'reservation-livekit-cell-a',
      worker_id: 'media-recovery-worker'
    }]);
    assert.deepEqual(response.data.token.placement, {
      interaction_id: created.call.id,
      reservation_id: 'reservation-livekit-cell-b',
      region_id: 'region-a',
      zone_id: 'zone-b',
      cell_id: 'cell-b',
      owner_node_id: 'livekit-b',
      owner_epoch: '12884901890',
      profile_id: 'cell-10k-v1',
      snapshot_version: 10,
      placement_generation: 2,
      livekit_url: 'wss://livekit-cell-b.example.com'
    });
  } finally {
    db.close();
    if (previousSecret === undefined) delete process.env.CONVERACT_JWT_SECRET;
    else process.env.CONVERACT_JWT_SECRET = previousSecret;
  }
});

function placementFixture(calls: string[]): MediaCallPlacementPort {
  return {
    async reserve(input) {
      calls.push(`reserve:${input.interaction_id}`);
      return {
        interaction_id: input.interaction_id,
        value: { interaction_id: input.interaction_id }
      };
    },
    async persistReserved(_pg, reservation) {
      calls.push(`persist:${reservation.interaction_id}`);
    },
    async releaseUncommitted() {},
    async requestState(_pg, input) {
      calls.push(`state:${input.desired_state}:${input.interaction_id}`);
    },
    async reconcileOne(input) {
      calls.push(`reconcile:${input.interaction_id}`);
      return { outcome: 'succeeded' };
    },
    async resolveOwner() {
      throw new Error('not used');
    }
  };
}
