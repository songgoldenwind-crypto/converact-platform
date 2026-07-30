import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComponentNodeAdmissionController
} from '../src/agent-runtime/ivekit/placement/index.js';

test('component node admission starts draining and requires a fresh Cell lease', () => {
  const controller = fixture();

  assert.equal(controller.snapshot(new Date('2026-07-16T08:00:00.000Z')).state, 'draining');
  assert.throws(
    () => controller.applyReservation(
      reservation(),
      new Date('2026-07-16T08:00:00.000Z')
    ),
    (error: any) => error?.code === 'component_node_lease_missing'
  );

  assert.throws(
    () => controller.applyLease(
      lease(),
      new Date('2026-07-16T08:00:00.000Z')
    ),
    (error: any) => error?.code === 'component_node_recovery_required'
  );
  controller.applyLease(
    lease({ state: 'draining', recovery_complete: false }),
    new Date('2026-07-16T08:00:00.000Z')
  );
  controller.applyLease(lease(), new Date('2026-07-16T08:00:00.000Z'));
  assert.equal(controller.snapshot(new Date('2026-07-16T08:00:01.000Z')).state, 'accepting');
});

test('component node recovery accepts authoritative reservation replay before admissions reopen', () => {
  const controller = fixture();
  controller.applyLease(
    lease({ state: 'draining', recovery_complete: false }),
    new Date('2026-07-16T08:00:00.000Z')
  );

  assert.throws(
    () => controller.applyReservation(
      reservation(),
      new Date('2026-07-16T08:00:00.500Z')
    ),
    (error: any) => error?.code === 'component_node_draining'
  );
  assert.equal(
    controller.applyRecoveryReservation(
      reservation(),
      new Date('2026-07-16T08:00:00.500Z'),
      3
    ).reservation_id,
    'reservation-a'
  );
  assert.equal(
    controller.snapshot(new Date('2026-07-16T08:00:00.500Z')).recovery_pending,
    true
  );
  controller.applyLease(
    lease({
      observed_at: '2026-07-16T08:00:01.000Z',
      expires_at: '2026-07-16T08:00:11.000Z'
    }),
    new Date('2026-07-16T08:00:01.000Z')
  );
  assert.equal(
    controller.snapshot(new Date('2026-07-16T08:00:01.000Z')).state,
    'accepting'
  );
});

test('component node recovery replaces stale reservations before authoritative replay', () => {
  const controller = readyFixture();
  controller.applyReservation(
    reservation(),
    new Date('2026-07-16T08:00:00.500Z')
  );
  controller.applyLease(
    lease({
      state: 'draining',
      recovery_complete: false,
      observed_at: '2026-07-16T08:00:01.000Z',
      expires_at: '2026-07-16T08:00:11.000Z'
    }),
    new Date('2026-07-16T08:00:01.000Z')
  );

  const reset = controller.snapshot(new Date('2026-07-16T08:00:01.000Z'));
  assert.equal(reset.reservations.reserved, 0);
  assert.equal(reset.dimensions['video.participants'].reserved, 0);
  assert.throws(
    () => controller.authorize({
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '12884901889',
      operation: 'open'
    }, new Date('2026-07-16T08:00:01.000Z')),
    (error: any) => error?.code === 'component_reservation_not_found'
  );

  controller.applyRecoveryReservation(
    reservation(),
    new Date('2026-07-16T08:00:01.500Z'),
    3
  );
  controller.applyLease(
    lease({
      observed_at: '2026-07-16T08:00:02.000Z',
      expires_at: '2026-07-16T08:00:12.000Z'
    }),
    new Date('2026-07-16T08:00:02.000Z')
  );
  const recovered = controller.snapshot(new Date('2026-07-16T08:00:02.000Z'));
  assert.equal(recovered.reservations.reserved, 1);
  assert.equal(recovered.dimensions['video.participants'].reserved, 1);
});

test('component node recovery fences the request lease while preserving an older active owner', () => {
  const controller = fixture();
  controller.applyLease(
    lease({ state: 'draining', recovery_complete: false }),
    new Date('2026-07-16T08:00:00.000Z')
  );
  const recovered = reservation({
    state: 'active',
    owner_epoch: '8589934593'
  });

  assert.throws(
    () => controller.applyRecoveryReservation(
      recovered,
      new Date('2026-07-16T08:00:00.500Z'),
      2
    ),
    (error: any) => error?.code === 'component_node_recovery_epoch_mismatch'
  );
  controller.applyRecoveryReservation(
    recovered,
    new Date('2026-07-16T08:00:00.500Z'),
    3
  );
  controller.applyLease(
    lease({
      observed_at: '2026-07-16T08:00:01.000Z',
      expires_at: '2026-07-16T08:00:11.000Z'
    }),
    new Date('2026-07-16T08:00:01.000Z')
  );

  assert.equal(
    controller.authorize({
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '8589934593',
      operation: 'mutate'
    }, new Date('2026-07-16T08:00:02.000Z')).allowed,
    true
  );
  assert.equal(
    controller.applyReservation(
      recovered,
      new Date('2026-07-16T08:00:02.000Z')
    ).state,
    'active'
  );
  assert.equal(
    controller.authorize({
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '8589934593',
      operation: 'mutate'
    }, new Date('2026-07-16T08:00:02.500Z')).allowed,
    true
  );
  assert.equal(
    controller.applyReservation(
      {
        ...recovered,
        state: 'closed',
        updated_at: '2026-07-16T08:00:03.000Z'
      },
      new Date('2026-07-16T08:00:03.000Z')
    ).state,
    'closed'
  );
  assert.throws(
    () => controller.authorize({
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '8589934593',
      operation: 'mutate'
    }, new Date('2026-07-16T08:00:03.500Z')),
    (error: any) => [
      'component_reservation_not_active',
      'stale_owner_epoch'
    ].includes(error?.code)
  );
  assert.throws(
    () => controller.applyReservation(
      reservation({
        reservation_id: 'reservation-stale',
        interaction_id: 'room-stale',
        idempotency_key: 'idem-stale',
        owner_epoch: '8589934594'
      }),
      new Date('2026-07-16T08:00:02.000Z')
    ),
    (error: any) => error?.code === 'stale_owner_epoch'
  );
});

test('component node recovery renewal preserves reservations already replayed', () => {
  const controller = fixture();
  controller.applyLease(
    lease({
      state: 'draining',
      recovery_complete: false,
      recovery_reset: true
    }),
    new Date('2026-07-16T08:00:00.000Z')
  );
  controller.applyRecoveryReservation(
    reservation(),
    new Date('2026-07-16T08:00:00.500Z'),
    3
  );
  controller.applyLease(
    lease({
      state: 'draining',
      recovery_complete: false,
      recovery_reset: false,
      observed_at: '2026-07-16T08:00:01.000Z',
      expires_at: '2026-07-16T08:00:11.000Z'
    }),
    new Date('2026-07-16T08:00:01.000Z')
  );

  const renewed = controller.snapshot(new Date('2026-07-16T08:00:01.000Z'));
  assert.equal(renewed.recovery_pending, true);
  assert.equal(renewed.reservations.reserved, 1);
  assert.equal(renewed.dimensions['video.participants'].reserved, 1);
});

test('component node recovery keeps nonterminal old-owner advances fenced', () => {
  const controller = fixture();
  controller.applyLease(
    lease({ state: 'draining', recovery_complete: false }),
    new Date('2026-07-16T08:00:00.000Z')
  );
  const recovered = reservation({ owner_epoch: '8589934593' });
  controller.applyRecoveryReservation(
    recovered,
    new Date('2026-07-16T08:00:00.500Z'),
    3
  );
  controller.applyLease(
    lease({
      observed_at: '2026-07-16T08:00:01.000Z',
      expires_at: '2026-07-16T08:00:11.000Z'
    }),
    new Date('2026-07-16T08:00:01.000Z')
  );

  assert.throws(
    () => controller.applyReservation(
      {
        ...recovered,
        state: 'active',
        updated_at: '2026-07-16T08:00:02.000Z'
      },
      new Date('2026-07-16T08:00:02.000Z')
    ),
    (error: any) => error?.code === 'stale_owner_epoch'
  );
});

test('component node repeated recovery reset clears partial replay at the same lease timestamp', () => {
  const controller = fixture();
  const resetLease = lease({
    state: 'draining',
    recovery_complete: false,
    recovery_reset: true
  });
  controller.applyLease(
    resetLease,
    new Date('2026-07-16T08:00:00.000Z')
  );
  controller.applyRecoveryReservation(
    reservation(),
    new Date('2026-07-16T08:00:00.500Z'),
    3
  );
  controller.applyLease(
    resetLease,
    new Date('2026-07-16T08:00:00.500Z')
  );

  const reset = controller.snapshot(new Date('2026-07-16T08:00:00.500Z'));
  assert.equal(reset.recovery_pending, true);
  assert.equal(reset.reservations.reserved, 0);
  assert.equal(reset.dimensions['video.participants'].reserved, 0);
});

test('component node admission applies reservation transitions idempotently', () => {
  const controller = readyFixture();
  const reserved = controller.applyReservation(
    reservation(),
    new Date('2026-07-16T08:00:01.000Z')
  );
  const replay = controller.applyReservation(
    reservation(),
    new Date('2026-07-16T08:00:02.000Z')
  );
  assert.deepEqual(replay, reserved);
  assert.equal(controller.snapshot(new Date('2026-07-16T08:00:02.000Z'))
    .dimensions['video.participants'].reserved, 1);

  const active = controller.applyReservation(
    reservation({
      state: 'active',
      updated_at: '2026-07-16T08:00:03.000Z'
    }),
    new Date('2026-07-16T08:00:03.000Z')
  );
  assert.equal(active.state, 'active');
  assert.equal(controller.snapshot(new Date('2026-07-16T08:00:03.000Z'))
    .dimensions['video.participants'].used, 1);
  assert.equal(controller.snapshot(new Date('2026-07-16T08:00:03.000Z'))
    .dimensions['video.participants'].reserved, 0);

  const closed = controller.applyReservation(
    reservation({
      state: 'closed',
      updated_at: '2026-07-16T08:00:04.000Z'
    }),
    new Date('2026-07-16T08:00:04.000Z')
  );
  assert.equal(closed.state, 'closed');
  assert.equal(controller.snapshot(new Date('2026-07-16T08:00:04.000Z'))
    .dimensions['video.participants'].used, 0);
});

test('component node admission rejects conflicting replay and state regression', () => {
  const controller = readyFixture();
  controller.applyReservation(
    reservation(),
    new Date('2026-07-16T08:00:01.000Z')
  );
  assert.throws(
    () => controller.applyReservation(
      reservation({ interaction_id: 'room-other' }),
      new Date('2026-07-16T08:00:02.000Z')
    ),
    (error: any) => error?.code === 'component_reservation_conflict'
  );
  controller.applyReservation(
    reservation({
      state: 'active',
      updated_at: '2026-07-16T08:00:03.000Z'
    }),
    new Date('2026-07-16T08:00:03.000Z')
  );
  assert.throws(
    () => controller.applyReservation(
      reservation({
        state: 'reserved',
        updated_at: '2026-07-16T08:00:04.000Z'
      }),
      new Date('2026-07-16T08:00:04.000Z')
    ),
    (error: any) => error?.code === 'component_reservation_state_regression'
  );
});

test('component node authorization fences identity, state and owner epoch', () => {
  const controller = readyFixture();
  controller.applyReservation(
    reservation(),
    new Date('2026-07-16T08:00:01.000Z')
  );

  assert.equal(controller.authorize({
    reservation_id: 'reservation-a',
    interaction_id: 'room-a',
    owner_epoch: '12884901889',
    operation: 'open'
  }, new Date('2026-07-16T08:00:02.000Z')).allowed, true);
  assert.throws(
    () => controller.authorize({
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '12884901888',
      operation: 'open'
    }, new Date('2026-07-16T08:00:02.000Z')),
    (error: any) => error?.code === 'stale_owner_epoch'
  );
  assert.throws(
    () => controller.authorize({
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '12884901889',
      operation: 'mutate'
    }, new Date('2026-07-16T08:00:02.000Z')),
    (error: any) => error?.code === 'component_reservation_not_active'
  );

  controller.applyReservation(
    reservation({
      state: 'active',
      updated_at: '2026-07-16T08:00:03.000Z'
    }),
    new Date('2026-07-16T08:00:03.000Z')
  );
  assert.equal(controller.authorize({
    reservation_id: 'reservation-a',
    interaction_id: 'room-a',
    owner_epoch: '12884901889',
    operation: 'mutate'
  }, new Date('2026-07-16T08:00:04.000Z')).allowed, true);
});

test('component node applies a monotonic owner takeover for the same reservation', () => {
  const controller = readyFixture();
  controller.applyReservation(
    reservation(),
    new Date('2026-07-16T08:00:01.000Z')
  );
  const takeover = controller.applyReservation(
    reservation({
      owner_epoch: '12884901890',
      updated_at: '2026-07-16T08:00:02.000Z'
    }),
    new Date('2026-07-16T08:00:02.000Z')
  );

  assert.equal(takeover.owner_epoch, '12884901890');
  assert.equal(controller.authorize({
    reservation_id: 'reservation-a',
    interaction_id: 'room-a',
    owner_epoch: '12884901890',
    operation: 'open'
  }, new Date('2026-07-16T08:00:03.000Z')).allowed, true);
  assert.throws(
    () => controller.authorize({
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '12884901889',
      operation: 'open'
    }, new Date('2026-07-16T08:00:03.000Z')),
    (error: any) => error?.code === 'stale_owner_epoch'
  );
});

test('component node batch authorization isolates stale owners inside one bounded refresh', () => {
  const controller = readyFixture();
  controller.applyReservation(
    reservation({
      state: 'active',
      updated_at: '2026-07-16T08:00:01.000Z'
    }),
    new Date('2026-07-16T08:00:01.000Z')
  );
  const results = controller.authorizeBatch([
    {
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '12884901889',
      operation: 'mutate'
    },
    {
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '12884901888',
      operation: 'mutate'
    }
  ], new Date('2026-07-16T08:00:02.000Z'));

  assert.equal(results[0]?.authorization?.allowed, true);
  assert.equal(results[0]?.error, undefined);
  assert.deepEqual(results[1]?.error, {
    code: 'stale_owner_epoch',
    status: 409,
    retryable: false
  });
  assert.throws(
    () => controller.authorizeBatch(
      Array.from({ length: 65 }, () => ({
        reservation_id: 'reservation-a',
        interaction_id: 'room-a',
        owner_epoch: '12884901889',
        operation: 'mutate' as const
      })),
      new Date('2026-07-16T08:00:02.000Z')
    ),
    (error: any) => error?.code === 'component_authorization_batch_invalid'
  );
});

test('component node drain rejects new reservations but permits existing open and close', () => {
  const controller = readyFixture();
  controller.applyReservation(
    reservation(),
    new Date('2026-07-16T08:00:01.000Z')
  );
  controller.startDrain(new Date('2026-07-16T08:00:02.000Z'));

  assert.equal(controller.authorize({
    reservation_id: 'reservation-a',
    interaction_id: 'room-a',
    owner_epoch: '12884901889',
    operation: 'open'
  }, new Date('2026-07-16T08:00:03.000Z')).allowed, true);
  assert.throws(
    () => controller.applyReservation(
      reservation({
        reservation_id: 'reservation-b',
        interaction_id: 'room-b',
        owner_epoch: '12884901890',
        created_at: '2026-07-16T08:00:03.000Z',
        updated_at: '2026-07-16T08:00:03.000Z'
      }),
      new Date('2026-07-16T08:00:03.000Z')
    ),
    (error: any) => error?.code === 'component_node_draining'
  );
  assert.equal(controller.authorize({
    reservation_id: 'reservation-a',
    interaction_id: 'room-a',
    owner_epoch: '12884901889',
    operation: 'close'
  }, new Date('2026-07-16T08:00:03.000Z')).allowed, true);
});

test('component node route drain publishes draining before blocking new admission', () => {
  const controller = readyFixture();
  controller.startRouteDrain(new Date('2026-07-16T08:00:01.000Z'));

  assert.equal(
    controller.snapshot(new Date('2026-07-16T08:00:01.000Z')).state,
    'draining'
  );
  assert.equal(
    controller.applyReservation(
      reservation(),
      new Date('2026-07-16T08:00:01.000Z')
    ).state,
    'reserved'
  );

  controller.stopNewAdmissions();
  assert.throws(
    () => controller.applyReservation(
      reservation({
        reservation_id: 'reservation-b',
        interaction_id: 'room-b',
        owner_epoch: '12884901890',
        created_at: '2026-07-16T08:00:02.000Z',
        updated_at: '2026-07-16T08:00:02.000Z'
      }),
      new Date('2026-07-16T08:00:02.000Z')
    ),
    (error: any) => error?.code === 'component_node_draining'
  );
});

test('higher Cell lease epoch immediately fences stale owners', () => {
  const controller = readyFixture();
  controller.applyReservation(
    reservation({
      state: 'active',
      updated_at: '2026-07-16T08:00:01.000Z'
    }),
    new Date('2026-07-16T08:00:01.000Z')
  );
  controller.applyLease(lease({
    cell_lease_epoch: 4,
    observed_at: '2026-07-16T08:00:02.000Z',
    expires_at: '2026-07-16T08:00:12.000Z'
  }), new Date('2026-07-16T08:00:02.000Z'));

  assert.throws(
    () => controller.authorize({
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '12884901889',
      operation: 'mutate'
    }, new Date('2026-07-16T08:00:03.000Z')),
    (error: any) => error?.code === 'stale_owner_epoch'
  );
  assert.equal(controller.authorize({
    reservation_id: 'reservation-a',
    interaction_id: 'room-a',
    owner_epoch: '12884901889',
    operation: 'close'
  }, new Date('2026-07-16T08:00:03.000Z')).allowed, true);
});

test('component node lease expiry and reservation expiry fail closed', () => {
  const controller = readyFixture();
  controller.applyReservation(
    reservation(),
    new Date('2026-07-16T08:00:01.000Z')
  );
  assert.throws(
    () => controller.authorize({
      reservation_id: 'reservation-a',
      interaction_id: 'room-a',
      owner_epoch: '12884901889',
      operation: 'open'
    }, new Date('2026-07-16T08:00:11.000Z')),
    (error: any) => error?.code === 'component_node_lease_expired'
  );

  const expiring = readyFixture();
  expiring.applyReservation(
    reservation({ expires_at: '2026-07-16T08:00:02.000Z' }),
    new Date('2026-07-16T08:00:01.000Z')
  );
  assert.equal(
    expiring.expireReservations(new Date('2026-07-16T08:00:03.000Z')),
    1
  );
  assert.equal(expiring.snapshot(new Date('2026-07-16T08:00:03.000Z'))
    .reservations.expired, 1);
});

function readyFixture(): ComponentNodeAdmissionController {
  const controller = fixture();
  controller.applyLease(
    lease({ state: 'draining', recovery_complete: false }),
    new Date('2026-07-16T08:00:00.000Z')
  );
  controller.applyLease(lease(), new Date('2026-07-16T08:00:00.000Z'));
  return controller;
}

function fixture(): ComponentNodeAdmissionController {
  return new ComponentNodeAdmissionController({
    component: 'livekit',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'livekit-a',
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['livekit_av', 'livekit_screen'],
    terminal_retention_ms: 60_000,
    dimensions: {
      'video.participants': {
        unit: 'participants',
        safe_capacity: 10,
        used: 0,
        reserved: 0
      }
    }
  });
}

function lease(overrides: Record<string, unknown> = {}) {
  const heartbeat = {
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: 'livekit-a',
    component: 'livekit' as const,
    cell_lease_epoch: 3,
    state: 'accepting' as const,
    recovery_complete: true,
    recovery_reset: false,
    observed_at: '2026-07-16T08:00:00.000Z',
    expires_at: '2026-07-16T08:00:10.000Z',
    ...overrides
  };
  if (overrides.recovery_reset === undefined &&
      heartbeat.recovery_complete === false) {
    heartbeat.recovery_reset = true;
  }
  return heartbeat;
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    reservation_id: 'reservation-a',
    state: 'reserved' as const,
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
    updated_at: '2026-07-16T08:00:00.000Z',
    ...overrides
  };
}
