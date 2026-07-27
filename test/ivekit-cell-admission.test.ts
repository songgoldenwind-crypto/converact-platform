import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CellAdmissionController
} from '../src/agent-runtime/ivekit/placement/admission.js';

test('cell admission reserves all dimensions atomically and replays idempotently', () => {
  const controller = fixture();
  const first = controller.reserve({
    request_id: 'request-a',
    idempotency_key: 'idem-a',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: {
      'voice.weighted_calls': 1,
      'voice.recording_slots': 1
    }
  }, new Date('2026-07-16T08:00:00.000Z'));
  const replay = controller.reserve({
    request_id: 'request-retry',
    idempotency_key: 'idem-a',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: {
      'voice.weighted_calls': 1,
      'voice.recording_slots': 1
    }
  }, new Date('2026-07-16T08:00:01.000Z'));

  assert.equal(replay.reservation_id, first.reservation_id);
  assert.equal(replay.owner_epoch, first.owner_epoch);
  assert.equal(controller.snapshot().dimensions['voice.weighted_calls'].reserved, 1);
  assert.equal(controller.snapshot().dimensions['voice.recording_slots'].reserved, 1);

  assert.throws(() => controller.reserve({
    request_id: 'request-partition-conflict',
    idempotency_key: 'idem-a',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:different-call',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: {
      'voice.weighted_calls': 1,
      'voice.recording_slots': 1
    }
  }, new Date('2026-07-16T08:00:02.000Z')), (error: any) =>
    error?.code === 'idempotency_conflict'
  );

  assert.throws(() => controller.reserve({
    request_id: 'request-conflict',
    idempotency_key: 'idem-a',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 2 }
  }, new Date('2026-07-16T08:00:02.000Z')), (error: any) => error?.code === 'idempotency_conflict');
});

test('duplicate reservation IDs fail before capacity is charged again', () => {
  const controller = fixture(() => 'reservation-fixed');
  controller.reserve({
    request_id: 'request-a',
    idempotency_key: 'idem-a',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 }
  }, new Date('2026-07-16T08:00:00.000Z'));
  const before = controller.snapshot().dimensions;
  assert.throws(() => controller.reserve({
    request_id: 'request-b',
    idempotency_key: 'idem-b',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-b',
    interaction_id: 'call-b',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 }
  }, new Date('2026-07-16T08:00:01.000Z')), (error: any) =>
    error?.code === 'reservation_id_conflict'
  );
  assert.deepEqual(controller.snapshot().dimensions, before);
});

test('capacity failure does not leak a partial reservation', () => {
  const controller = fixture();
  controller.reserve({
    request_id: 'request-a',
    idempotency_key: 'idem-a',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: {
      'voice.weighted_calls': 1,
      'voice.recording_slots': 1
    }
  }, new Date('2026-07-16T08:00:00.000Z'));
  const before = controller.snapshot();

  assert.throws(() => controller.reserve({
    request_id: 'request-b',
    idempotency_key: 'idem-b',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-b',
    interaction_id: 'call-b',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: {
      'voice.weighted_calls': 1,
      'voice.recording_slots': 1
    }
  }, new Date('2026-07-16T08:00:01.000Z')), (error: any) =>
    error?.code === 'capacity_exhausted' &&
    error?.details?.limiting_dimensions?.includes('voice.recording_slots')
  );

  assert.deepEqual(controller.snapshot().dimensions, before.dimensions);
});

test('Cell admission assigns interactions only to nodes that advertise the requested capability', () => {
  const controller = new CellAdmissionController({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['sip_voice', 'livekit_av'],
    reservation_ttl_ms: 10_000,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'count', safe_capacity: 10, used: 0, reserved: 0
      }
    },
    nodes: [
      {
        node_id: 'livekit-a',
        endpoint: 'https://livekit-a.internal',
        state: 'accepting',
        profile_ids: ['cell-10k-v1'],
        interaction_kinds: ['livekit_av'],
        dimensions: {
          'voice.weighted_calls': {
            unit: 'count', safe_capacity: 10, used: 0, reserved: 0
          }
        }
      },
      {
        node_id: 'rustpbx-a',
        endpoint: 'https://rustpbx-a.internal',
        state: 'accepting',
        profile_ids: ['cell-10k-v1'],
        interaction_kinds: ['sip_voice'],
        dimensions: {
          'voice.weighted_calls': {
            unit: 'count', safe_capacity: 10, used: 5, reserved: 0
          }
        }
      }
    ],
    id_factory: () => 'reservation-capability'
  });

  const reservation = controller.reserve({
    request_id: 'request-capability',
    idempotency_key: 'idem-capability',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-capability',
    interaction_id: 'call-capability',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 }
  }, new Date('2026-07-16T08:00:00.000Z'));

  assert.equal(reservation.owner_node_id, 'rustpbx-a');
});

test('Cell admission excludes a failed owner when rebuilding an interaction', () => {
  const controller = new CellAdmissionController({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['livekit_av'],
    reservation_ttl_ms: 10_000,
    dimensions: {
      'video.participants': {
        unit: 'count', safe_capacity: 20, used: 0, reserved: 0
      }
    },
    nodes: [
      {
        node_id: 'livekit-a',
        endpoint: 'https://livekit-a.internal',
        state: 'accepting',
        profile_ids: ['cell-10k-v1'],
        interaction_kinds: ['livekit_av'],
        dimensions: {
          'video.participants': {
            unit: 'count', safe_capacity: 10, used: 0, reserved: 0
          }
        }
      },
      {
        node_id: 'livekit-b',
        endpoint: 'https://livekit-b.internal',
        state: 'accepting',
        profile_ids: ['cell-10k-v1'],
        interaction_kinds: ['livekit_av'],
        dimensions: {
          'video.participants': {
            unit: 'count', safe_capacity: 10, used: 0, reserved: 0
          }
        }
      }
    ],
    id_factory: () => 'reservation-rebuild'
  });

  const reservation = controller.reserve({
    request_id: 'request-rebuild',
    idempotency_key: 'idem-rebuild',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-rebuild',
    interaction_id: 'call-rebuild',
    interaction_kind: 'livekit_av',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'video.participants': 2 },
    excluded_owner_node_ids: ['livekit-a']
  }, new Date('2026-07-16T08:00:00.000Z'));

  assert.equal(reservation.owner_node_id, 'livekit-b');
  assert.throws(
    () => controller.reserve({
      request_id: 'request-rebuild-unavailable',
      idempotency_key: 'idem-rebuild-unavailable',
      tenant_id: 'tenant-a',
      routing_partition_id: 'tenant-a:call-rebuild-unavailable',
      interaction_id: 'call-rebuild-unavailable',
      interaction_kind: 'livekit_av',
      profile_id: 'cell-10k-v1',
      required_capacity: { 'video.participants': 2 },
      excluded_owner_node_ids: ['livekit-a', 'livekit-b']
    }, new Date('2026-07-16T08:00:01.000Z')),
    (error: any) => error?.code === 'owner_node_unavailable'
  );
});

test('activation, drain, close and TTL expiration preserve capacity accounting', () => {
  const controller = fixture();
  const reservation = controller.reserve({
    request_id: 'request-a',
    idempotency_key: 'idem-a',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 }
  }, new Date('2026-07-16T08:00:00.000Z'));

  controller.startDrain(new Date('2026-07-16T08:00:01.000Z'));
  assert.throws(() => controller.reserve({
    request_id: 'request-b',
    idempotency_key: 'idem-b',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-b',
    interaction_id: 'call-b',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 }
  }, new Date('2026-07-16T08:00:02.000Z')), (error: any) => error?.code === 'cell_draining');

  const active = controller.activate(reservation.reservation_id, new Date('2026-07-16T08:00:03.000Z'));
  assert.equal(active.state, 'active');
  assert.equal(controller.snapshot().dimensions['voice.weighted_calls'].used, 9);
  assert.equal(controller.snapshot().dimensions['voice.weighted_calls'].reserved, 0);

  controller.close(reservation.reservation_id, new Date('2026-07-16T08:00:04.000Z'));
  assert.equal(controller.snapshot().dimensions['voice.weighted_calls'].used, 8);

  const expiring = fixture();
  expiring.reserve({
    request_id: 'request-expire',
    idempotency_key: 'idem-expire',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-expire',
    interaction_id: 'call-expire',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 }
  }, new Date('2026-07-16T08:00:00.000Z'));
  assert.equal(expiring.expireReservations(new Date('2026-07-16T08:00:11.000Z')), 1);
  assert.equal(expiring.snapshot().dimensions['voice.weighted_calls'].reserved, 0);
});

test('Cell admission state transitions support controlled recovery but keep offline terminal', () => {
  const controller = fixture(undefined, {
    weighted_calls: 0,
    recording_slots: 0
  });
  const now = new Date('2026-07-16T08:00:00.000Z');

  controller.setState('degraded', now);
  assert.equal(controller.snapshot().state, 'degraded');

  controller.setState('draining', new Date(now.getTime() + 1_000));
  assert.equal(controller.snapshot().state, 'draining');
  assert.equal(
    controller.snapshot().drain_started_at,
    '2026-07-16T08:00:01.000Z'
  );

  controller.setState('accepting', new Date(now.getTime() + 2_000));
  assert.equal(controller.snapshot().state, 'accepting');
  assert.equal(controller.snapshot().drain_started_at, '');

  controller.setState('offline', new Date(now.getTime() + 3_000));
  assert.equal(controller.snapshot().state, 'offline');
  assert.throws(
    () => controller.setState('accepting', new Date(now.getTime() + 4_000)),
    (error: any) => error?.code === 'cell_offline'
  );
});

test('Cell admission refuses offline while reservations still own capacity', () => {
  const controller = fixture();
  controller.reserve({
    request_id: 'request-offline',
    idempotency_key: 'idem-offline',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-offline',
    interaction_id: 'call-offline',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 }
  }, new Date('2026-07-16T08:00:00.000Z'));
  assert.throws(
    () => controller.setState('offline', new Date('2026-07-16T08:00:01.000Z')),
    (error: any) => error?.code === 'cell_not_empty'
  );
});

test('Cell admission fails closed when an inbound SIP leg names a different owner node', () => {
  const controller = fixture();
  assert.throws(() => controller.reserve({
    request_id: 'request-inbound-owner',
    idempotency_key: 'idem-inbound-owner',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:inbound-owner',
    interaction_id: 'call-inbound-owner',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 },
    preferred_cell_id: 'cell-a',
    preferred_owner_node_id: 'rustpbx-other'
  }, new Date('2026-07-16T08:00:00.000Z')), (error: any) =>
    error?.code === 'owner_node_unavailable' &&
    error?.retryable === true
  );
});

test('Cell admission expires and evicts reservations through bounded deadline queues', () => {
  let id = 0;
  const controller = fixture(() => `reservation-deadline-${++id}`, {
    weighted_calls: 0,
    recording_slots: 0
  }, 1_000);
  const input = {
    request_id: 'request-deadline',
    idempotency_key: 'idem-deadline',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-deadline',
    interaction_id: 'call-deadline',
    interaction_kind: 'sip_voice' as const,
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 }
  };
  const first = controller.reserve(input, new Date('2026-07-16T08:00:00.000Z'));
  controller.close(first.reservation_id, new Date('2026-07-16T08:00:01.000Z'));

  const replay = controller.reserve({
    ...input,
    request_id: 'request-deadline-retry'
  }, new Date('2026-07-16T08:00:01.500Z'));
  assert.equal(replay.reservation_id, first.reservation_id);
  assert.equal(replay.state, 'closed');

  controller.expireReservations(new Date('2026-07-16T08:00:02.001Z'));
  assert.equal(controller.snapshot().reservations.length, 0);
  const reused = controller.reserve({
    ...input,
    request_id: 'request-deadline-reused'
  }, new Date('2026-07-16T08:00:02.002Z'));
  assert.notEqual(reused.reservation_id, first.reservation_id);
});

test('Cell admission deadline sweep leaves activated owners alive after reservation TTL', () => {
  const controller = fixture(undefined, {
    weighted_calls: 0,
    recording_slots: 0
  }, 1_000);
  const reservation = controller.reserve({
    request_id: 'request-active-deadline',
    idempotency_key: 'idem-active-deadline',
    tenant_id: 'tenant-a',
    routing_partition_id: 'tenant-a:call-active-deadline',
    interaction_id: 'call-active-deadline',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    required_capacity: { 'voice.weighted_calls': 1 }
  }, new Date('2026-07-16T08:00:00.000Z'));
  controller.activate(
    reservation.reservation_id,
    new Date('2026-07-16T08:00:01.000Z')
  );

  assert.equal(
    controller.expireReservations(new Date('2026-07-16T08:00:11.000Z')),
    0
  );
  assert.equal(controller.snapshot().reservations[0]?.state, 'active');
  assert.equal(controller.snapshot().dimensions['voice.weighted_calls'].used, 1);
});

test('Cell admission applies monotonic live capacity observations without changing safe limits', () => {
  const controller = fixture(undefined, {
    weighted_calls: 0,
    recording_slots: 0
  });
  controller.applyCapacityObservation({
    schema_version: '1.0.0',
    sequence: 1,
    observed_at: '2026-07-16T08:00:00.000Z',
    expires_at: '2026-07-16T08:00:05.000Z',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'count',
        safe_capacity: 10,
        used: 6
      },
      'voice.recording_slots': {
        unit: 'count',
        safe_capacity: 5,
        used: 2
      }
    },
    nodes: [{
      node_id: 'rustpbx-a',
      state: 'degraded',
      dimensions: {
        'voice.weighted_calls': {
          unit: 'count',
          safe_capacity: 10,
          used: 6
        },
        'voice.recording_slots': {
          unit: 'count',
          safe_capacity: 5,
          used: 2
        }
      }
    }]
  }, new Date('2026-07-16T08:00:01.000Z'));

  const snapshot = controller.snapshot();
  assert.equal(snapshot.capacity_sequence, 1);
  assert.equal(snapshot.capacity_expires_at, '2026-07-16T08:00:05.000Z');
  assert.equal(snapshot.dimensions['voice.weighted_calls'].safe_capacity, 10);
  assert.equal(snapshot.dimensions['voice.weighted_calls'].used, 6);
  assert.equal(snapshot.nodes[0]?.state, 'degraded');
  assert.throws(
    () => controller.applyCapacityObservation({
      schema_version: '1.0.0',
      sequence: 1,
      observed_at: '2026-07-16T08:00:01.000Z',
      expires_at: '2026-07-16T08:00:06.000Z',
      region_id: 'region-a',
      zone_id: 'zone-a',
      cell_id: 'cell-a',
      cell_lease_epoch: 3,
      dimensions: {
        'voice.weighted_calls': {
          unit: 'count',
          safe_capacity: 10,
          used: 1
        },
        'voice.recording_slots': {
          unit: 'count',
          safe_capacity: 5,
          used: 1
        }
      },
      nodes: []
    }, new Date('2026-07-16T08:00:02.000Z')),
    (error: any) => error?.code === 'capacity_sequence_stale'
  );
});

test('Cell admission keeps desired node state separate from transient heartbeat availability', () => {
  const controller = fixture(undefined, {
    weighted_calls: 0,
    recording_slots: 0
  });
  const firstTarget = controller.componentNodeTargets()[0]!;

  controller.markNodeUnavailable(
    'rustpbx-a',
    '2026-07-16T08:00:10.000Z',
    firstTarget.availability_generation
  );
  assert.equal(controller.snapshot().nodes[0]?.state, 'offline');
  assert.equal(
    controller.componentNodeTargets()[0]?.state,
    'accepting'
  );

  controller.applyCapacityObservation(
    capacityObservation(),
    new Date('2026-07-16T08:00:01.000Z')
  );
  assert.equal(controller.snapshot().nodes[0]?.state, 'offline');

  controller.restoreNodeAvailability(
    'rustpbx-a',
    firstTarget.availability_generation,
    firstTarget.desired_state_revision
  );
  assert.equal(controller.snapshot().nodes[0]?.state, 'offline');

  const recoveryTarget = controller.componentNodeTargets()[0]!;
  controller.restoreNodeAvailability(
    'rustpbx-a',
    recoveryTarget.availability_generation,
    recoveryTarget.desired_state_revision
  );
  assert.equal(controller.snapshot().nodes[0]?.state, 'accepting');
  assert.equal(controller.snapshot().nodes[0]?.recovery_safe_after, '');
});

test('Cell admission preserves the takeover fence while desired node state remains offline', () => {
  const controller = fixture(undefined, {
    weighted_calls: 0,
    recording_slots: 0
  });
  const target = controller.componentNodeTargets()[0]!;
  controller.markNodeUnavailable(
    'rustpbx-a',
    '2026-07-16T08:00:10.000Z',
    target.availability_generation
  );
  const staleRecoveryTarget = controller.componentNodeTargets()[0]!;
  const baseObservation = capacityObservation();
  const observation = {
    ...baseObservation,
    nodes: baseObservation.nodes.map((node) => ({
      ...node,
      state: 'offline' as const
    }))
  };
  controller.applyCapacityObservation(
    observation,
    new Date('2026-07-16T08:00:01.000Z')
  );

  const recoveryTarget = controller.componentNodeTargets()[0]!;
  assert.equal(
    recoveryTarget.availability_generation,
    staleRecoveryTarget.availability_generation
  );
  assert.notEqual(
    recoveryTarget.desired_state_revision,
    staleRecoveryTarget.desired_state_revision
  );
  controller.restoreNodeAvailability(
    'rustpbx-a',
    staleRecoveryTarget.availability_generation,
    staleRecoveryTarget.desired_state_revision
  );
  assert.equal(controller.snapshot().nodes[0]?.state, 'offline');
  controller.restoreNodeAvailability(
    'rustpbx-a',
    recoveryTarget.availability_generation,
    recoveryTarget.desired_state_revision
  );
  assert.equal(controller.snapshot().nodes[0]?.state, 'offline');
  assert.equal(
    controller.snapshot().nodes[0]?.recovery_safe_after,
    '2026-07-16T08:00:10.000Z'
  );
});

test('Cell admission desired-state changes cannot suppress an in-flight heartbeat failure', () => {
  const controller = fixture(undefined, {
    weighted_calls: 0,
    recording_slots: 0
  });
  const inFlightTarget = controller.componentNodeTargets()[0]!;
  const baseObservation = capacityObservation();
  controller.applyCapacityObservation({
    ...baseObservation,
    nodes: baseObservation.nodes.map((node) => ({
      ...node,
      state: 'degraded' as const
    }))
  }, new Date('2026-07-16T08:00:01.000Z'));

  const updatedTarget = controller.componentNodeTargets()[0]!;
  assert.equal(
    updatedTarget.availability_generation,
    inFlightTarget.availability_generation
  );
  assert.notEqual(
    updatedTarget.desired_state_revision,
    inFlightTarget.desired_state_revision
  );
  assert.equal(
    controller.markNodeUnavailable(
      'rustpbx-a',
      '2026-07-16T08:00:10.000Z',
      inFlightTarget.availability_generation
    ),
    true
  );
  assert.equal(controller.snapshot().nodes[0]?.state, 'offline');
});

test('Cell admission fails closed after live capacity expires', () => {
  const controller = fixture(undefined, {
    weighted_calls: 0,
    recording_slots: 0
  });
  controller.applyCapacityObservation(capacityObservation(), new Date(
    '2026-07-16T08:00:01.000Z'
  ));
  assert.throws(
    () => controller.reserve({
      request_id: 'request-stale-capacity',
      idempotency_key: 'idem-stale-capacity',
      tenant_id: 'tenant-a',
      routing_partition_id: 'tenant-a:stale-capacity',
      interaction_id: 'call-stale-capacity',
      interaction_kind: 'sip_voice',
      profile_id: 'cell-10k-v1',
      required_capacity: { 'voice.weighted_calls': 1 }
    }, new Date('2026-07-16T08:00:05.001Z')),
    (error: any) => error?.code === 'capacity_stale' && error?.retryable === true
  );
});

function fixture(
  idFactory?: () => string,
  initial: { weighted_calls: number; recording_slots: number } = {
    weighted_calls: 8,
    recording_slots: 4
  },
  terminalRetentionMs = 300_000
): CellAdmissionController {
  let id = 0;
  return new CellAdmissionController({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['sip_voice'],
    reservation_ttl_ms: 10_000,
    terminal_retention_ms: terminalRetentionMs,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'count', safe_capacity: 10, used: initial.weighted_calls, reserved: 0
      },
      'voice.recording_slots': {
        unit: 'count', safe_capacity: 5, used: initial.recording_slots, reserved: 0
      }
    },
    nodes: [{
      node_id: 'rustpbx-a',
      endpoint: 'https://rustpbx-a.internal',
      control_endpoint: 'https://rustpbx-control.internal',
      state: 'accepting',
      profile_ids: ['cell-10k-v1'],
      interaction_kinds: ['sip_voice'],
      dimensions: {
        'voice.weighted_calls': {
          unit: 'count', safe_capacity: 10, used: initial.weighted_calls, reserved: 0
        },
        'voice.recording_slots': {
          unit: 'count', safe_capacity: 5, used: initial.recording_slots, reserved: 0
        }
      }
    }],
    id_factory: idFactory || (() => `reservation-${++id}`)
  });
}

function capacityObservation() {
  return {
    schema_version: '1.0.0' as const,
    sequence: 1,
    observed_at: '2026-07-16T08:00:00.000Z',
    expires_at: '2026-07-16T08:00:05.000Z',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'count',
        safe_capacity: 10,
        used: 0
      },
      'voice.recording_slots': {
        unit: 'count',
        safe_capacity: 5,
        used: 0
      }
    },
    nodes: [{
      node_id: 'rustpbx-a',
      state: 'accepting' as const,
      dimensions: {
        'voice.weighted_calls': {
          unit: 'count',
          safe_capacity: 10,
          used: 0
        },
        'voice.recording_slots': {
          unit: 'count',
          safe_capacity: 5,
          used: 0
        }
      }
    }]
  };
}
