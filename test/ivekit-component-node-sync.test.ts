import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComponentNodeSynchronizer,
  type ComponentNodeAdmissionClientPort
} from '../src/agent-runtime/ivekit/placement/index.js';

test('component node recovery pushes draining lease, checkpoints, then desired lease', async () => {
  const events: string[] = [];
  const synchronizer = fixture(events);

  await synchronizer.recover({
    checkpoints: [checkpoint()],
    targets: targets(),
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:00.000Z')
  });

  assert.deepEqual(events, [
    'livekit-a:lease:draining:3',
    'tinode-a:lease:draining:3',
    'livekit-a:reservation:reservation-a:active',
    'livekit-a:lease:accepting:3',
    'tinode-a:lease:degraded:3'
  ]);
});

test('component node synchronizer sends a checkpoint only to its exact owner node', async () => {
  const events: string[] = [];
  const synchronizer = fixture(events);
  await synchronizer.applyCheckpoint(
    checkpoint(),
    new Date('2026-07-16T08:00:01.000Z')
  );

  assert.deepEqual(events, [
    'livekit-a:reservation:reservation-a:active'
  ]);
});

test('component node heartbeat reports per-node failures without hiding healthy nodes', async () => {
  const events: string[] = [];
  const synchronizer = fixture(events, 'tinode-a');
  const result = await synchronizer.syncLeases({
    targets: targets(),
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:00.000Z')
  });

  assert.deepEqual(result.succeeded, ['livekit-a']);
  assert.deepEqual(result.failed.map((item) => item.node_id), ['tinode-a']);
  assert.match(result.failed[0]?.error || '', /controlled node failure/);
  assert.equal(
    result.failed[0]?.recovery_safe_after,
    '2026-07-16T08:00:10.000Z'
  );
});

test('component node heartbeat maps Cell or node drain to a draining lease', async () => {
  const events: string[] = [];
  const synchronizer = fixture(events);
  await synchronizer.syncLeases({
    targets: targets().map((target) => (
      target.node_id === 'livekit-a'
        ? { ...target, state: 'offline' as const }
        : target
    )),
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:00.000Z')
  });
  await synchronizer.syncLeases({
    targets: targets(),
    cell_state: 'draining',
    now: new Date('2026-07-16T08:00:01.000Z')
  });

  assert.equal(events[0], 'livekit-a:lease:draining:3');
  assert.ok(events.slice(2).every((event) => event.includes(':lease:draining:')));
});

test('component node heartbeat automatically replays cached owners after agent restart', async () => {
  const events: string[] = [];
  let recoveryRequired = false;
  const synchronizer = new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    targets: [targets()[0]],
    client_factory(): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          if (recoveryRequired && heartbeat.recovery_complete) {
            recoveryRequired = false;
            throw Object.assign(new Error('recovery required'), {
              code: 'component_node_recovery_required'
            });
          }
          events.push(`lease:${heartbeat.state}:${heartbeat.recovery_complete}`);
          return {};
        },
        async applyReservation(value) {
          events.push(`reservation:${value.reservation_id}:${value.state}`);
          return value;
        }
      };
    }
  });
  await synchronizer.applyCheckpoint(
    checkpoint(),
    new Date('2026-07-16T08:00:00.000Z')
  );
  events.length = 0;
  recoveryRequired = true;

  const result = await synchronizer.syncLeases({
    targets: [targets()[0]],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:01.000Z')
  });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(events, [
    'lease:draining:false',
    'reservation:reservation-a:active',
    'lease:accepting:true'
  ]);
});

function fixture(
  events: string[],
  failingNode = ''
): ComponentNodeSynchronizer {
  return new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    timeout_ms: 1_000,
    targets: targets(),
    client_factory(target): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          if (target.node_id === failingNode) {
            throw new Error('controlled node failure');
          }
          events.push(
            `${target.node_id}:lease:${heartbeat.state}:${heartbeat.cell_lease_epoch}`
          );
          return {};
        },
        async applyReservation(value) {
          if (target.node_id === failingNode) {
            throw new Error('controlled node failure');
          }
          events.push(
            `${target.node_id}:reservation:${value.reservation_id}:${value.state}`
          );
          return value;
        }
      };
    }
  });
}

function targets() {
  return [
    {
      component: 'livekit' as const,
      node_id: 'livekit-a',
      control_endpoint: 'http://livekit-a:3210',
      state: 'accepting' as const
    },
    {
      component: 'tinode' as const,
      node_id: 'tinode-a',
      control_endpoint: 'http://tinode-a:3210',
      state: 'degraded' as const
    }
  ];
}

function checkpoint() {
  return {
    reservation_id: 'reservation-a',
    state: 'active' as const,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'livekit-a',
    owner_epoch: '12884901889',
    endpoint: 'https://livekit-a.internal',
    expires_at: '2026-07-16T08:00:10.000Z',
    required_capacity: { 'video.participants': 1 },
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:room-a',
    interaction_id: 'room-a',
    interaction_kind: 'livekit_av' as const,
    profile_id: 'cell-10k-v1',
    idempotency_key: 'idem-a',
    payload_hash: 'a'.repeat(64),
    created_at: '2026-07-16T08:00:00.000Z',
    updated_at: '2026-07-16T08:00:01.000Z'
  };
}
