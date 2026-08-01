import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MediaCallService,
  type MediaCallPlacementPort,
  type MediaCallPlacementReservation
} from '../src/agent-runtime/livekit/media-call-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import { MemoryPg } from '../src/db-pg.js';

test('media call lifecycle reserves, persists and stages Cell placement transitions', async () => {
  const pg = new MemoryPg();
  const calls: string[] = [];
  const placement = fixturePlacement(calls);
  const service = new MediaCallService(new MediaCallStore(pg), { placement });
  const created = await service.createCall({
    tenant_id: 'tenant-a',
    initiated_by: 'host-a',
    media: 'video',
    participant_identities: ['guest-a'],
    business_ref: {
      tenant_id: 'tenant-a',
      type: 'service_order',
      id: 'order-a',
      metadata: {}
    },
    idempotency_key: 'create-call-a'
  });

  assert.deepEqual(calls.slice(0, 3), [
    `reserve:${created.call.id}:2:create-call-a`,
    `persist:${created.call.id}`,
    `request:active:${created.call.id}:media_call_durable`
  ]);
  await service.transition({
    tenant_id: 'tenant-a',
    call_id: created.call.id,
    action: 'ring',
    actor_identity: 'host-a',
    idempotency_key: 'ring-a'
  });
  await service.transition({
    tenant_id: 'tenant-a',
    call_id: created.call.id,
    action: 'accept',
    actor_identity: 'guest-a',
    idempotency_key: 'accept-a'
  });
  const activated = await service.transition({
    tenant_id: 'tenant-a',
    call_id: created.call.id,
    action: 'activate',
    actor_identity: 'host-a',
    idempotency_key: 'activate-a'
  });
  assert.equal(activated.placement_reconcile?.desired_state, 'active');
  assert.equal(calls.at(-1), `request:active:${created.call.id}:media_call_activated`);

  const ended = await service.transition({
    tenant_id: 'tenant-a',
    call_id: created.call.id,
    action: 'end',
    actor_identity: 'host-a',
    idempotency_key: 'end-a'
  });
  assert.equal(ended.placement_reconcile?.desired_state, 'closed');
  assert.equal(calls.at(-1), `request:closed:${created.call.id}:media_call_ended`);
});

test('media call releases an uncommitted placement when durable creation fails', async () => {
  const pg = new MemoryPg();
  const calls: string[] = [];
  const placement = fixturePlacement(calls, { failPersist: true });
  const service = new MediaCallService(new MediaCallStore(pg), { placement });

  await assert.rejects(
    () => service.createCall({
      tenant_id: 'tenant-a',
      initiated_by: 'host-a',
      media: 'video',
      participant_identities: ['guest-a'],
      business_ref: {
        tenant_id: 'tenant-a',
        type: 'service_order',
        id: 'order-a',
        metadata: {}
      }
    }),
    /controlled placement persist failure/
  );
  assert.match(calls.at(-1) || '', /^release:mcall_/);
});

function fixturePlacement(
  calls: string[],
  options: { failPersist?: boolean } = {}
): MediaCallPlacementPort {
  return {
    async reserve(input): Promise<MediaCallPlacementReservation> {
      calls.push(
        `reserve:${input.interaction_id}:${input.participant_count}:${input.idempotency_key}`
      );
      return {
        interaction_id: input.interaction_id,
        value: { interaction_id: input.interaction_id }
      };
    },
    async persistReserved(_pg, reservation) {
      calls.push(`persist:${reservation.interaction_id}`);
      if (options.failPersist) throw new Error('controlled placement persist failure');
    },
    async releaseUncommitted(reservation) {
      calls.push(`release:${reservation.interaction_id}`);
    },
    async requestState(_pg, input) {
      calls.push(
        `request:${input.desired_state}:${input.interaction_id}:${input.reason}`
      );
    },
    async reconcileOne() {
      return { outcome: 'succeeded' as const };
    },
    async resolveOwner(_pg, input) {
      return {
        interaction_id: input.interaction_id,
        reservation_id: 'reservation-livekit-a',
        region_id: 'region-a',
        zone_id: 'zone-a',
        cell_id: 'cell-a',
        owner_node_id: 'livekit-a',
        owner_epoch: '12884901889',
        profile_id: 'cell-10k-v1',
        snapshot_version: 1,
        livekit_url: 'wss://livekit-a.example.com'
      };
    }
  };
}
