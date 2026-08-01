import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SystemPlatformClock,
  createPlatformDeadline,
  platformDeadlineState,
  type PlatformClock
} from '../src/agent-runtime/converact/platform-foundation/clock.js';
import {
  ComponentNodeSynchronizer,
  type ComponentNodeAdmissionClientPort
} from '../src/agent-runtime/converact/placement/index.js';

class MutableClock implements PlatformClock {
  constructor(
    public wall: Date,
    public monotonic: number
  ) {}

  wallNow(): Date {
    return new Date(this.wall);
  }

  monotonicNowMs(): number {
    return this.monotonic;
  }
}

test('wall clock jumps do not change a monotonic deadline', () => {
  const clock = new MutableClock(new Date('2026-08-01T00:00:00.000Z'), 1_000);
  const deadline = createPlatformDeadline(clock, 5_000, 60_000);

  clock.wall = new Date('2036-08-01T00:00:00.000Z');
  clock.monotonic = 5_999;
  assert.equal(platformDeadlineState(clock, deadline), 'active');

  clock.wall = new Date('2016-08-01T00:00:00.000Z');
  clock.monotonic = 6_000;
  assert.equal(platformDeadlineState(clock, deadline), 'expired');
});

test('monotonic reversal requires reauthorization instead of extending a lease', () => {
  const clock = new MutableClock(new Date('2026-08-01T00:00:00.000Z'), 2_000);
  const deadline = createPlatformDeadline(clock, 5_000, 60_000);

  clock.monotonic = 1_999;
  assert.equal(platformDeadlineState(clock, deadline), 'restart_reauthorization_required');
});

test('invalid clocks and durations fail closed', () => {
  const clock = new MutableClock(new Date('invalid'), 1_000);
  assert.throws(() => createPlatformDeadline(clock, 5_000, 60_000), /platform_clock_invalid/);

  clock.wall = new Date('2026-08-01T00:00:00.000Z');
  for (const duration of [0, -1, 1.5, 60_001, Number.NaN]) {
    assert.throws(
      () => createPlatformDeadline(clock, duration, 60_000),
      /platform_deadline_duration_invalid/
    );
  }

  const deadline = createPlatformDeadline(clock, 5_000, 60_000);
  clock.monotonic = Number.NaN;
  assert.equal(platformDeadlineState(clock, deadline), 'clock_invalid');
});

test('system platform clock returns valid wall and monotonic domains', () => {
  const clock = new SystemPlatformClock();
  assert.equal(Number.isFinite(clock.wallNow().getTime()), true);
  assert.equal(Number.isFinite(clock.monotonicNowMs()), true);
  assert.equal(clock.monotonicNowMs() >= 0, true);
});

test('component node elapsed time does not depend on the wall clock', async () => {
  const originalDateNow = Date.now;
  Date.now = () => {
    throw new Error('wall clock must not be used for elapsed time');
  };
  try {
    const synchronizer = new ComponentNodeSynchronizer({
      region_id: 'region-a',
      zone_id: 'zone-a',
      cell_id: 'cell-a',
      cell_lease_epoch: 1,
      service_token: 'service-token-not-used-by-test',
      lease_ttl_ms: 10_000,
      targets: [{
        component: 'livekit',
        node_id: 'livekit-a',
        control_endpoint: 'https://livekit-a.internal',
        state: 'accepting'
      }],
      client_factory(): ComponentNodeAdmissionClientPort {
        return {
          async applyLease(heartbeat) {
            return {
              component: heartbeat.component,
              region_id: heartbeat.region_id,
              zone_id: heartbeat.zone_id,
              cell_id: heartbeat.cell_id,
              node_id: heartbeat.node_id,
              state: heartbeat.state,
              state_sequence: 1,
              drain_started_at: '',
              cell_lease_epoch: heartbeat.cell_lease_epoch,
              lease_observed_at: heartbeat.observed_at,
              lease_expires_at: heartbeat.expires_at,
              lease_fresh: true,
              recovery_pending: false,
              dimensions: {},
              reservations: { reserved: 0, active: 0, expired: 0, closed: 0 }
            };
          },
          async applyReservation(checkpoint) {
            return checkpoint;
          },
          async applyRecoveryReservation(checkpoint) {
            return checkpoint;
          }
        };
      }
    });

    const result = await synchronizer.syncLeases({
      targets: [{
        component: 'livekit',
        node_id: 'livekit-a',
        control_endpoint: 'https://livekit-a.internal',
        state: 'accepting'
      }],
      cell_state: 'accepting',
      now: new Date('2026-08-01T00:00:00.000Z')
    });
    assert.deepEqual(result.failed, []);
  } finally {
    Date.now = originalDateNow;
  }
});
