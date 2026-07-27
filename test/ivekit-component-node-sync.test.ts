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

  assert.deepEqual([...events].sort(), [
    'livekit-a:lease:draining:3',
    'livekit-a:lease:accepting:3',
    'livekit-a:reservation:reservation-a:active',
    'tinode-a:lease:degraded:3',
    'tinode-a:lease:draining:3'
  ].sort());
  assert.ok(
    events.indexOf('livekit-a:lease:draining:3') <
      events.indexOf('livekit-a:reservation:reservation-a:active')
  );
  assert.ok(
    events.indexOf('livekit-a:reservation:reservation-a:active') <
      events.indexOf('livekit-a:lease:accepting:3')
  );
  assert.ok(
    events.indexOf('tinode-a:lease:draining:3') <
      events.indexOf('tinode-a:lease:degraded:3')
  );
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

test('component node heartbeat rejects a successful response that did not apply desired state', async () => {
  const events: string[] = [];
  const target = targets()[0]!;
  const synchronizer = new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    targets: [target],
    client_factory(): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          return leaseAcknowledgement(heartbeat, {
            state: 'draining'
          });
        },
        async applyRecoveryReservation(value) {
          return value;
        },
        async applyReservation(value) {
          return value;
        }
      };
    }
  });

  const result = await synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:00.000Z')
  });

  assert.deepEqual(result.succeeded, []);
  assert.equal(result.failed[0]?.error_code, 'component_node_state_mismatch');
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
          return leaseAcknowledgement(heartbeat);
        },
        async applyRecoveryReservation(value) {
          events.push(`reservation:${value.reservation_id}:${value.state}`);
          return value;
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

test('component node recovery freezes its checkpoint set before awaiting the recovery lease', async () => {
  const events: string[] = [];
  let recoveryRequired = false;
  let lateCheckpoint: Promise<unknown> = Promise.resolve();
  let synchronizer!: ComponentNodeSynchronizer;
  const target = targets()[0]!;
  synchronizer = new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    targets: [target],
    client_factory(): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          if (recoveryRequired && heartbeat.recovery_complete) {
            recoveryRequired = false;
            throw Object.assign(new Error('recovery required'), {
              code: 'component_node_recovery_required'
            });
          }
          if (!heartbeat.recovery_complete) {
            lateCheckpoint = synchronizer.applyCheckpoint(
              checkpoint({
                reservation_id: 'reservation-late',
                interaction_id: 'room-late',
                idempotency_key: 'idem-late',
                owner_epoch: '12884901890'
              }),
              new Date('2026-07-16T08:00:01.000Z')
            ).catch(() => undefined);
          }
          events.push(`lease:${heartbeat.state}:${heartbeat.recovery_complete}`);
          return leaseAcknowledgement(heartbeat);
        },
        async applyRecoveryReservation(value) {
          events.push(`recovery:${value.reservation_id}`);
          return value;
        },
        async applyReservation(value) {
          events.push(`ordinary:${value.reservation_id}`);
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

  await synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:01.000Z')
  });
  await lateCheckpoint;

  assert.deepEqual(events, [
    'lease:draining:false',
    'recovery:reservation-a',
    'lease:accepting:true',
    'ordinary:reservation-late'
  ]);
});

test('component node heartbeat reconciles a failed checkpoint before restoring success', async () => {
  const events: string[] = [];
  let rejectClose = true;
  const target = targets()[0]!;
  const synchronizer = new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    targets: [target],
    client_factory(): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          events.push(`lease:${heartbeat.state}:${heartbeat.recovery_complete}`);
          return leaseAcknowledgement(heartbeat);
        },
        async applyRecoveryReservation(value) {
          events.push(`recovery:${value.reservation_id}:${value.state}`);
          return value;
        },
        async applyReservation(value) {
          if (value.state === 'closed' && rejectClose) {
            rejectClose = false;
            throw new Error('controlled close failure');
          }
          return value;
        }
      };
    }
  });
  await synchronizer.applyCheckpoint(
    checkpoint(),
    new Date('2026-07-16T08:00:00.000Z')
  );
  await assert.rejects(
    () => synchronizer.applyCheckpoint(
      checkpoint({
        state: 'closed',
        updated_at: '2026-07-16T08:00:02.000Z'
      }),
      new Date('2026-07-16T08:00:02.000Z')
    ),
    (error: any) => error?.code === 'component_node_checkpoint_failed'
  );

  const result = await synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:03.000Z')
  });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.succeeded, [target.node_id]);
  assert.deepEqual(events, [
    'lease:draining:false',
    'recovery:reservation-a:closed',
    'lease:accepting:true'
  ]);
});

test('component node recovery preserves backpressure arriving after its frozen snapshot', async () => {
  const events: string[] = [];
  let rejectClose = true;
  let injectLateCheckpoint = true;
  let lateCheckpoint: Promise<unknown> = Promise.resolve();
  let synchronizer!: ComponentNodeSynchronizer;
  const target = targets()[0]!;
  synchronizer = new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    max_queued_checkpoint_syncs: 0,
    targets: [target],
    client_factory(): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          events.push(`lease:${heartbeat.recovery_complete}`);
          return leaseAcknowledgement(heartbeat);
        },
        async applyRecoveryReservation(value) {
          events.push(`recovery:${value.reservation_id}:${value.state}`);
          if (injectLateCheckpoint) {
            injectLateCheckpoint = false;
            lateCheckpoint = synchronizer.applyCheckpoint(
              checkpoint({
                reservation_id: 'reservation-late',
                interaction_id: 'room-late',
                idempotency_key: 'idem-late',
                owner_epoch: '12884901890'
              }),
              new Date('2026-07-16T08:00:03.000Z')
            ).catch(() => undefined);
          }
          return value;
        },
        async applyReservation(value) {
          if (value.state === 'closed' && rejectClose) {
            rejectClose = false;
            throw new Error('controlled close failure');
          }
          return value;
        }
      };
    }
  });
  await synchronizer.applyCheckpoint(
    checkpoint(),
    new Date('2026-07-16T08:00:00.000Z')
  );
  await assert.rejects(() => synchronizer.applyCheckpoint(
    checkpoint({
      state: 'closed',
      updated_at: '2026-07-16T08:00:02.000Z'
    }),
    new Date('2026-07-16T08:00:02.000Z')
  ));

  const firstRecovery = await synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:03.000Z')
  });
  await lateCheckpoint;
  assert.equal(
    firstRecovery.failed[0]?.error_code,
    'component_node_reconciliation_pending'
  );
  events.length = 0;
  const secondRecovery = await synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:04.000Z')
  });

  assert.deepEqual(secondRecovery.failed, []);
  assert.deepEqual(events, [
    'lease:false',
    'recovery:reservation-late:active',
    'lease:true'
  ]);
});

test('component node recovery re-drains when backpressure arrives during final lease', async () => {
  const events: string[] = [];
  let rejectClose = true;
  let injectOnFinalLease = false;
  let finalRaceInjected = false;
  let synchronizer!: ComponentNodeSynchronizer;
  const target = targets()[0]!;
  synchronizer = new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    max_queued_checkpoint_syncs: 0,
    targets: [target],
    client_factory(): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          events.push(`lease:${heartbeat.recovery_complete}`);
          if (heartbeat.recovery_complete && injectOnFinalLease) {
            injectOnFinalLease = false;
            finalRaceInjected = true;
            await synchronizer.applyCheckpoint(
              checkpoint({
                reservation_id: 'reservation-final-race',
                interaction_id: 'room-final-race',
                idempotency_key: 'idem-final-race',
                owner_epoch: '12884901890'
              }),
              new Date('2026-07-16T08:00:03.000Z')
            ).catch(() => undefined);
          }
          return leaseAcknowledgement(heartbeat);
        },
        async applyRecoveryReservation(value) {
          events.push(`recovery:${value.reservation_id}:${value.state}`);
          if (!finalRaceInjected) injectOnFinalLease = true;
          return value;
        },
        async applyReservation(value) {
          if (value.state === 'closed' && rejectClose) {
            rejectClose = false;
            throw new Error('controlled close failure');
          }
          return value;
        }
      };
    }
  });
  await synchronizer.applyCheckpoint(
    checkpoint(),
    new Date('2026-07-16T08:00:00.000Z')
  );
  await assert.rejects(() => synchronizer.applyCheckpoint(
    checkpoint({
      state: 'closed',
      updated_at: '2026-07-16T08:00:02.000Z'
    }),
    new Date('2026-07-16T08:00:02.000Z')
  ));

  const firstRecovery = await synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:03.000Z')
  });

  assert.equal(
    firstRecovery.failed[0]?.error_code,
    'component_node_reconciliation_pending'
  );
  assert.deepEqual(events.slice(-2), ['lease:true', 'lease:false']);
  events.length = 0;
  const secondRecovery = await synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:04.000Z')
  });

  assert.deepEqual(secondRecovery.failed, []);
  assert.deepEqual(events, [
    'lease:false',
    'recovery:reservation-final-race:active',
    'lease:true'
  ]);
});

test('component node recovery renews a long replay and creates a fresh final lease', async () => {
  const events: string[] = [];
  let monotonicNow = 100;
  let requireRecovery = false;
  const target = targets()[0]!;
  const synchronizer = new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    monotonic_clock_ms: () => monotonicNow,
    targets: [target],
    client_factory(): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          if (requireRecovery && heartbeat.recovery_complete) {
            requireRecovery = false;
            throw Object.assign(new Error('recovery required'), {
              code: 'component_node_recovery_required'
            });
          }
          events.push(
            `lease:${heartbeat.recovery_complete}:${heartbeat.observed_at}`
          );
          return leaseAcknowledgement(heartbeat);
        },
        async applyRecoveryReservation(value) {
          events.push(`recovery:${value.reservation_id}`);
          if (value.reservation_id === 'reservation-a') {
            monotonicNow += 6_000;
          }
          return value;
        },
        async applyReservation(value) {
          return value;
        }
      };
    }
  });
  await synchronizer.applyCheckpoint(
    checkpoint(),
    new Date('2026-07-16T08:00:00.000Z')
  );
  await synchronizer.applyCheckpoint(
    checkpoint({
      reservation_id: 'reservation-second',
      interaction_id: 'room-second',
      idempotency_key: 'idem-second',
      owner_epoch: '12884901890'
    }),
    new Date('2026-07-16T08:00:00.000Z')
  );
  requireRecovery = true;

  await synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:01.000Z')
  });

  assert.deepEqual(events, [
    'lease:false:2026-07-16T08:00:01.000Z',
    'recovery:reservation-a',
    'lease:false:2026-07-16T08:00:07.000Z',
    'recovery:reservation-second',
    'lease:true:2026-07-16T08:00:07.000Z'
  ]);
});

test('component node sync runs checkpoints concurrently but gives heartbeat writer priority', async () => {
  const events: string[] = [];
  const checkpointReleases: Array<() => void> = [];
  let activeCheckpoints = 0;
  let maximumActiveCheckpoints = 0;
  const target = targets()[0]!;
  const synchronizer = new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    max_concurrent_checkpoint_syncs: 2,
    max_queued_checkpoint_syncs: 4,
    targets: [target],
    client_factory(): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          events.push('lease');
          return leaseAcknowledgement(heartbeat);
        },
        async applyRecoveryReservation(value) {
          return value;
        },
        async applyReservation(value) {
          events.push(`checkpoint:start:${value.reservation_id}`);
          activeCheckpoints += 1;
          maximumActiveCheckpoints = Math.max(
            maximumActiveCheckpoints,
            activeCheckpoints
          );
          if (value.reservation_id !== 'reservation-third') {
            await new Promise<void>((resolve) => {
              checkpointReleases.push(resolve);
            });
          }
          activeCheckpoints -= 1;
          events.push(`checkpoint:end:${value.reservation_id}`);
          return value;
        }
      };
    }
  });

  const first = synchronizer.applyCheckpoint(
    checkpoint(),
    new Date('2026-07-16T08:00:00.000Z')
  );
  const second = synchronizer.applyCheckpoint(
    checkpoint({
      reservation_id: 'reservation-second',
      interaction_id: 'room-second',
      idempotency_key: 'idem-second',
      owner_epoch: '12884901890'
    }),
    new Date('2026-07-16T08:00:00.000Z')
  );
  await waitUntil(() => checkpointReleases.length === 2);
  const heartbeat = synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:01.000Z')
  });
  const third = synchronizer.applyCheckpoint(
    checkpoint({
      reservation_id: 'reservation-third',
      interaction_id: 'room-third',
      idempotency_key: 'idem-third',
      owner_epoch: '12884901891'
    }),
    new Date('2026-07-16T08:00:01.000Z')
  );
  for (const release of checkpointReleases) release();
  await Promise.all([first, second, heartbeat, third]);

  assert.equal(maximumActiveCheckpoints, 2);
  assert.ok(
    events.indexOf('lease') <
      events.indexOf('checkpoint:start:reservation-third')
  );
});

test('component node heartbeat starts its lease after waiting for the writer permit', async () => {
  let monotonicNow = 100;
  let releaseCheckpoint!: () => void;
  let checkpointStarted = false;
  let observedHeartbeat:
    | Parameters<ComponentNodeAdmissionClientPort['applyLease']>[0]
    | undefined;
  const target = targets()[0]!;
  const synchronizer = new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    monotonic_clock_ms: () => monotonicNow,
    targets: [target],
    client_factory(): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          observedHeartbeat = heartbeat;
          return leaseAcknowledgement(heartbeat);
        },
        async applyRecoveryReservation(value) {
          return value;
        },
        async applyReservation(value) {
          checkpointStarted = true;
          await new Promise<void>((resolve) => {
            releaseCheckpoint = resolve;
          });
          return value;
        }
      };
    }
  });
  const pendingCheckpoint = synchronizer.applyCheckpoint(
    checkpoint(),
    new Date('2026-07-16T08:00:00.000Z')
  );
  await waitUntil(() => checkpointStarted);
  const pendingHeartbeat = synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:01.000Z')
  });
  monotonicNow = 350;
  releaseCheckpoint();
  await Promise.all([pendingCheckpoint, pendingHeartbeat]);

  assert.equal(
    observedHeartbeat?.observed_at,
    '2026-07-16T08:00:01.250Z'
  );
  assert.equal(
    observedHeartbeat?.expires_at,
    '2026-07-16T08:00:11.250Z'
  );
});

test('component node sync bounds queued checkpoints instead of growing without limit', async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  let firstStarted = false;
  const target = targets()[0]!;
  const synchronizer = new ComponentNodeSynchronizer({
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 3,
    service_token: 'component-node-service-token-1234567890',
    lease_ttl_ms: 10_000,
    max_concurrent_checkpoint_syncs: 1,
    max_queued_checkpoint_syncs: 1,
    targets: [target],
    client_factory(): ComponentNodeAdmissionClientPort {
      return {
        async applyLease(heartbeat) {
          events.push(`lease:${heartbeat.recovery_complete}`);
          return leaseAcknowledgement(heartbeat);
        },
        async applyRecoveryReservation(value) {
          events.push(`recovery:${value.reservation_id}:${value.state}`);
          return value;
        },
        async applyReservation(value) {
          if (!firstStarted) {
            firstStarted = true;
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return value;
        }
      };
    }
  });
  const first = synchronizer.applyCheckpoint(
    checkpoint(),
    new Date('2026-07-16T08:00:00.000Z')
  );
  await waitUntil(() => firstStarted);
  const queued = synchronizer.applyCheckpoint(
    checkpoint({
      reservation_id: 'reservation-queued',
      interaction_id: 'room-queued',
      idempotency_key: 'idem-queued',
      owner_epoch: '12884901890'
    }),
    new Date('2026-07-16T08:00:00.000Z')
  );
  await assert.rejects(
    () => synchronizer.applyCheckpoint(
      checkpoint({
        reservation_id: 'reservation-rejected',
        interaction_id: 'room-rejected',
        idempotency_key: 'idem-rejected',
        owner_epoch: '12884901891'
      }),
      new Date('2026-07-16T08:00:00.000Z')
    ),
    (error: any) => error?.code === 'component_node_sync_backpressure'
  );
  releaseFirst();
  await Promise.all([first, queued]);
  const result = await synchronizer.syncLeases({
    targets: [target],
    cell_state: 'accepting',
    now: new Date('2026-07-16T08:00:01.000Z')
  });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(events, [
    'lease:false',
    'recovery:reservation-a:active',
    'recovery:reservation-queued:active',
    'recovery:reservation-rejected:active',
    'lease:true'
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
    monotonic_clock_ms: () => 0,
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
          return leaseAcknowledgement(heartbeat);
        },
        async applyRecoveryReservation(value) {
          if (target.node_id === failingNode) {
            throw new Error('controlled node failure');
          }
          events.push(
            `${target.node_id}:reservation:${value.reservation_id}:${value.state}`
          );
          return value;
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
      state: 'accepting' as const,
      availability_generation: 0
    },
    {
      component: 'tinode' as const,
      node_id: 'tinode-a',
      control_endpoint: 'http://tinode-a:3210',
      state: 'degraded' as const,
      availability_generation: 0
    }
  ];
}

function leaseAcknowledgement(
  heartbeat: {
    component: 'rustpbx' | 'livekit' | 'tinode' | 'rustdesk';
    region_id: string;
    zone_id: string;
    cell_id: string;
    node_id: string;
    cell_lease_epoch: number;
    state: 'accepting' | 'degraded' | 'draining';
    recovery_complete: boolean;
    observed_at: string;
    expires_at: string;
  },
  overrides: Record<string, unknown> = {}
) {
  return {
    component: heartbeat.component,
    region_id: heartbeat.region_id,
    zone_id: heartbeat.zone_id,
    cell_id: heartbeat.cell_id,
    node_id: heartbeat.node_id,
    state: heartbeat.state,
    state_sequence: 1,
    drain_started_at: heartbeat.state === 'draining'
      ? heartbeat.observed_at
      : '',
    cell_lease_epoch: heartbeat.cell_lease_epoch,
    lease_observed_at: heartbeat.observed_at,
    lease_expires_at: heartbeat.expires_at,
    lease_fresh: true,
    recovery_pending: !heartbeat.recovery_complete,
    dimensions: {
      'video.participants': {
        unit: 'participants',
        safe_capacity: 10,
        used: 0,
        reserved: 0
      }
    },
    reservations: {
      reserved: 0,
      active: 0,
      expired: 0,
      closed: 0
    },
    ...overrides
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timed out waiting for component node sync test condition');
}

function checkpoint(overrides: Record<string, unknown> = {}) {
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
    updated_at: '2026-07-16T08:00:01.000Z',
    ...overrides
  };
}
