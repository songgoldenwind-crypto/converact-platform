import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MediaControlAgent,
  MediaControlError,
  type MediaControlAuthorityPort
} from '../src/agent-runtime/ivekit/media-control/agent.js';
import type {
  MediaControlCommand
} from '../src/agent-runtime/ivekit/media-control/protocol.js';
import type {
  MediaTransportCommand,
  MediaTransportOutcome,
  MediaTransportPort,
  MediaTransportQuery
} from '../src/agent-runtime/ivekit/media-control/transport.js';

const NOW = new Date('2026-07-25T00:00:00.000Z');
const OWNER_EPOCH = ((1n << 32n) | 1n).toString();

class AllowAllAuthority implements MediaControlAuthorityPort {
  async authorize() {
    return {
      owner_epoch: OWNER_EPOCH,
      reservation_expires_at: '2026-07-25T00:01:00.000Z',
      node_lease_expires_at: '2026-07-25T00:00:30.000Z'
    };
  }
}

class StatelessCapacityTransport implements MediaTransportPort {
  async execute(command: MediaTransportCommand): Promise<MediaTransportOutcome> {
    return {
      state: 'succeeded',
      command_id: command.command_id,
      transport_session_id: `t-${command.reservation_id}`,
      effective_sdp: '',
      session_state: 'prepared',
      applied_at: NOW.toISOString()
    };
  }

  async queryCommand(): Promise<MediaTransportQuery> {
    return { found: false };
  }

  async querySession() {
    return undefined;
  }

  async releaseSession(): Promise<void> {}
}

function prepare(index: number): MediaControlCommand {
  return {
    protocol_version: 'ivekit.media-control.v1',
    action: 'prepare',
    command_id: `c-${index}`,
    reservation_id: `r-${index}`,
    interaction_id: `i-${index}`,
    owner_epoch: OWNER_EPOCH,
    sequence: 1,
    lease_expires_at: '2026-07-25T00:01:00.000Z',
    payload: {
      offer_sdp: '',
      media_profile_id: 'g711-relay-v1'
    }
  };
}

describe('iveKit media control 100K reservation model', () => {
  it('holds exactly 100,000 records and rejects record 100,001 without growth', async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    const agent = new MediaControlAgent({
      authority: new AllowAllAuthority(),
      transport: new StatelessCapacityTransport(),
      max_reservations: 100_000,
      max_commands_per_reservation: 4
    });

    for (let index = 1; index <= 100_000; index += 1) {
      const result = await agent.execute(prepare(index), NOW);
      assert.equal(result.state, 'succeeded');
    }
    const heapGrowth = Math.max(
      0,
      process.memoryUsage().heapUsed - heapBefore
    );
    assert.equal(agent.reservationCount(), 100_000);
    assert.equal(agent.activeReservationCount(), 100_000);
    assert.equal(agent.scheduledDeadlineCount(), 100_000);
    assert.ok(
      heapGrowth < 512 * 1024 * 1024,
      `100K reservation heap growth ${heapGrowth} exceeded 512 MiB`
    );
    assert.equal(
      await agent.sweep(new Date('2026-07-25T00:00:30.000Z')),
      0
    );
    assert.equal(agent.scheduledDeadlineCount(), 100_000);

    await assert.rejects(
      agent.execute(prepare(100_001), NOW),
      (error: unknown) =>
        error instanceof MediaControlError &&
        error.code === 'media_control_capacity_exhausted'
    );
    assert.equal(agent.reservationCount(), 100_000);
  });

  it('renders only fixed low-cardinality metric labels', async () => {
    const agent = new MediaControlAgent({
      authority: new AllowAllAuthority(),
      transport: new StatelessCapacityTransport(),
      max_reservations: 10
    });
    const input = prepare(7);

    await agent.execute(input, NOW);
    await agent.execute(structuredClone(input), NOW);
    const metrics = agent.renderMetrics();

    assert.match(
      metrics,
      /ivekit_media_control_commands_total\{action="prepare",result="succeeded"\} 1/
    );
    assert.match(
      metrics,
      /ivekit_media_control_commands_total\{action="prepare",result="replayed"\} 1/
    );
    assert.match(
      metrics,
      /ivekit_media_control_sessions\{state="prepared"\} 1/
    );
    assert.match(metrics, /ivekit_media_control_reservations 1/);
    for (const forbidden of [
      input.command_id,
      input.reservation_id,
      input.interaction_id,
      input.owner_epoch,
      'tenant_id',
      'call_id',
      'reservation_id',
      'command_id'
    ]) {
      assert.equal(metrics.includes(forbidden), false, forbidden);
    }
  });
});
