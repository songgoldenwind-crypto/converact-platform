import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MediaControlAgent,
  MediaControlError,
  type MediaControlAuthorityPort
} from '../src/agent-runtime/ivekit/media-control/agent.js';
import {
  InMemoryMediaTransport,
  type SimulatedFailure
} from '../src/agent-runtime/ivekit/media-control/simulator.js';
import type {
  MediaControlAction,
  MediaControlCommand
} from '../src/agent-runtime/ivekit/media-control/protocol.js';

const NOW = new Date('2026-07-25T00:00:00.000Z');
const OWNER_EPOCH = ((7n << 32n) | 11n).toString();

class FakeAuthority implements MediaControlAuthorityPort {
  available = true;
  ownerEpoch = OWNER_EPOCH;
  calls = 0;

  async authorize(input: {
    reservation_id: string;
    interaction_id: string;
    owner_epoch: string;
    operation: 'open' | 'mutate' | 'close';
  }) {
    this.calls += 1;
    if (!this.available) throw new Error('control plane unavailable');
    if (input.owner_epoch !== this.ownerEpoch) {
      throw new MediaControlError('stale_owner_epoch', 409, false);
    }
    return {
      owner_epoch: this.ownerEpoch,
      reservation_expires_at: '2026-07-25T00:01:00.000Z',
      node_lease_expires_at: '2026-07-25T00:00:30.000Z'
    };
  }
}

function command(
  action: MediaControlAction,
  sequence: number,
  overrides: Partial<MediaControlCommand> = {}
): MediaControlCommand {
  return {
    protocol_version: 'ivekit.media-control.v1',
    action,
    command_id: `cmd-${action}-${sequence}`,
    reservation_id: 'reservation-1',
    interaction_id: 'call-1',
    owner_epoch: OWNER_EPOCH,
    sequence,
    lease_expires_at: '2026-07-25T00:01:00.000Z',
    payload: action === 'prepare'
      ? {
          offer_sdp: 'v=0\r\n',
          media_profile_id: 'g711-relay-v1'
        }
      : {},
    ...overrides
  };
}

function fixture(input: {
  failure?: SimulatedFailure;
  max_reservations?: number;
  max_terminal_reservations?: number;
} = {}) {
  const authority = new FakeAuthority();
  const transport = new InMemoryMediaTransport();
  if (input.failure) transport.failNext(input.failure);
  const agent = new MediaControlAgent({
    authority,
    transport,
    max_reservations: input.max_reservations ?? 100,
    max_terminal_reservations: input.max_terminal_reservations ?? 100,
    max_commands_per_reservation: 8,
    terminal_retention_ms: 1_000
  });
  return { agent, authority, transport };
}

describe('iveKit media control agent', () => {
  it('prepares and commits a media session through the transport port', async () => {
    const { agent, transport } = fixture();

    const prepared = await agent.execute(command('prepare', 1), NOW);
    const committed = await agent.execute(command('commit', 2), NOW);

    assert.equal(prepared.state, 'succeeded');
    assert.equal(prepared.session?.state, 'prepared');
    assert.match(prepared.session?.effective_sdp ?? '', /^v=0/);
    assert.equal(committed.state, 'succeeded');
    assert.equal(committed.session?.state, 'committed');
    assert.equal(transport.sideEffectCount('prepare'), 1);
    assert.equal(transport.sideEffectCount('commit'), 1);
  });

  it('rejects every stale owner epoch before a transport side effect', async () => {
    const { agent, transport } = fixture();
    const stale = ((6n << 32n) | 99n).toString();

    await assert.rejects(
      agent.execute(command('prepare', 1, { owner_epoch: stale }), NOW),
      (error: unknown) =>
        error instanceof MediaControlError && error.code === 'stale_owner_epoch'
    );
    assert.equal(transport.sideEffectCount(), 0);
  });

  it('replays a command result without repeating its transport side effect', async () => {
    const { agent, authority, transport } = fixture();
    const input = command('prepare', 1);

    const first = await agent.execute(input, NOW);
    const replay = await agent.execute(structuredClone(input), NOW);

    assert.deepEqual(replay, first);
    assert.equal(authority.calls, 2);
    assert.equal(transport.sideEffectCount('prepare'), 1);
  });

  it('rejects command-id reuse with a different payload', async () => {
    const { agent, transport } = fixture();
    const first = command('prepare', 1);
    await agent.execute(first, NOW);

    await assert.rejects(
      agent.execute(command('prepare', 1, {
        command_id: first.command_id,
        payload: {
          offer_sdp: 'v=0\r\na=sendonly\r\n',
          media_profile_id: 'g711-relay-v1'
        }
      }), NOW),
      (error: unknown) =>
        error instanceof MediaControlError &&
        error.code === 'command_payload_conflict'
    );
    assert.equal(transport.sideEffectCount('prepare'), 1);
  });

  it('reconciles an after-apply timeout without repeating the side effect', async () => {
    const { agent, transport } = fixture({ failure: 'after_apply_timeout' });
    const input = command('prepare', 1);

    const uncertain = await agent.execute(input, NOW);
    const reconciled = await agent.reconcile({
      protocol_version: 'ivekit.media-control.v1',
      action: 'reconcile',
      reservation_id: input.reservation_id,
      interaction_id: input.interaction_id,
      owner_epoch: input.owner_epoch,
      command_id: input.command_id
    }, NOW);

    assert.equal(uncertain.state, 'unknown');
    assert.equal(reconciled.state, 'succeeded');
    assert.equal(reconciled.session?.state, 'prepared');
    assert.equal(transport.sideEffectCount('prepare'), 1);
  });

  it('safely replays a command that timed out before the transport observed it', async () => {
    const { agent, transport } = fixture({ failure: 'before_apply_timeout' });
    const input = command('prepare', 1);

    const uncertain = await agent.execute(input, NOW);
    const reconciled = await agent.reconcile({
      protocol_version: 'ivekit.media-control.v1',
      action: 'reconcile',
      reservation_id: input.reservation_id,
      interaction_id: input.interaction_id,
      owner_epoch: input.owner_epoch,
      command_id: input.command_id
    }, NOW);

    assert.equal(uncertain.state, 'unknown');
    assert.equal(reconciled.state, 'succeeded');
    assert.equal(transport.sideEffectCount('prepare'), 1);
  });

  it('keeps committed packet forwarding alive when the control plane is unavailable', async () => {
    const { agent, authority, transport } = fixture();
    await agent.execute(command('prepare', 1), NOW);
    await agent.execute(command('commit', 2), NOW);
    authority.available = false;

    const forwarded = transport.forwardPackets('reservation-1', 500);

    assert.equal(forwarded, 500);
    assert.equal(transport.forwardedPackets('reservation-1'), 500);
  });

  it('requires unknown commands to reconcile before a later sequence', async () => {
    const { agent, transport } = fixture({ failure: 'before_apply_timeout' });

    assert.equal(
      (await agent.execute(command('prepare', 1), NOW)).state,
      'unknown'
    );
    await assert.rejects(
      agent.execute(command('commit', 2), NOW),
      (error: unknown) =>
        error instanceof MediaControlError &&
        error.code === 'command_reconciliation_required'
    );
    assert.equal(transport.sideEffectCount('commit'), 0);
  });

  it('allows an authorized higher epoch takeover and fences the old owner', async () => {
    const { agent, authority, transport } = fixture();
    const original = command('prepare', 1);
    await agent.execute(original, NOW);
    await agent.execute(command('commit', 2), NOW);

    const nextEpoch = ((8n << 32n) | 1n).toString();
    authority.ownerEpoch = nextEpoch;
    const takeover = await agent.execute(command('commit', 1, {
      owner_epoch: nextEpoch,
      command_id: 'cmd-takeover-commit-1'
    }), NOW);

    assert.equal(takeover.state, 'succeeded');
    assert.equal(takeover.session?.owner_epoch, nextEpoch);
    await assert.rejects(
      agent.execute(original, NOW),
      (error: unknown) =>
        error instanceof MediaControlError && error.code === 'stale_owner_epoch'
    );
    assert.equal(transport.sideEffectCount('prepare'), 1);
    assert.equal(transport.sideEffectCount('commit'), 2);
  });

  it('cancels prepared media and closes committed forwarding', async () => {
    const cancelled = fixture();
    await cancelled.agent.execute(command('prepare', 1), NOW);
    const cancelResult = await cancelled.agent.execute(command('cancel', 2), NOW);
    assert.equal(cancelResult.session?.state, 'cancelled');
    assert.equal(cancelled.transport.isForwarding('reservation-1'), false);

    const closed = fixture();
    await closed.agent.execute(command('prepare', 1), NOW);
    await closed.agent.execute(command('commit', 2), NOW);
    assert.equal(closed.transport.forwardPackets('reservation-1', 10), 10);
    const closeResult = await closed.agent.execute(command('close', 3), NOW);
    assert.equal(closeResult.session?.state, 'closed');
    assert.equal(closed.transport.forwardPackets('reservation-1', 10), 0);
  });

  it('expires prepared sessions but never expires committed media', async () => {
    const prepared = fixture();
    await prepared.agent.execute(command('prepare', 1), NOW);
    assert.equal(
      await prepared.agent.sweep(new Date('2026-07-25T00:01:01.000Z')),
      1
    );
    assert.equal(prepared.transport.isForwarding('reservation-1'), false);
    assert.equal(
      prepared.agent.session('reservation-1')?.state,
      'expired'
    );
    assert.equal(
      await prepared.agent.sweep(new Date('2026-07-25T00:01:02.001Z')),
      0
    );
    assert.equal(prepared.agent.session('reservation-1'), undefined);

    const committed = fixture();
    await committed.agent.execute(command('prepare', 1), NOW);
    await committed.agent.execute(command('commit', 2), NOW);
    assert.equal(
      await committed.agent.sweep(new Date('2026-07-25T00:01:01.000Z')),
      0
    );
    assert.equal(
      committed.agent.session('reservation-1')?.state,
      'committed'
    );
  });

  it('enforces reservation and sequence bounds', async () => {
    const { agent, transport } = fixture({ max_reservations: 1 });
    await agent.execute(command('prepare', 1), NOW);

    await assert.rejects(
      agent.execute(command('prepare', 1, {
        reservation_id: 'reservation-2',
        interaction_id: 'call-2',
        command_id: 'cmd-prepare-reservation-2'
      }), NOW),
      (error: unknown) =>
        error instanceof MediaControlError &&
        error.code === 'media_control_capacity_exhausted'
    );
    await assert.rejects(
      agent.execute(command('commit', 3), NOW),
      (error: unknown) =>
        error instanceof MediaControlError && error.code === 'sequence_gap'
    );
    assert.equal(transport.sideEffectCount('prepare'), 1);
    assert.equal(transport.sideEffectCount('commit'), 0);
  });

  it('releases active capacity while bounding terminal replay records', async () => {
    const { agent } = fixture({
      max_reservations: 1,
      max_terminal_reservations: 1
    });
    await agent.execute(command('prepare', 1), NOW);
    await agent.execute(command('close', 2), NOW);

    assert.equal(agent.activeReservationCount(), 0);
    assert.equal(agent.terminalReservationCount(), 1);

    await agent.execute(command('prepare', 1, {
      reservation_id: 'reservation-2',
      interaction_id: 'call-2',
      command_id: 'reservation-2-prepare'
    }), NOW);
    await agent.execute(command('close', 2, {
      reservation_id: 'reservation-2',
      interaction_id: 'call-2',
      command_id: 'reservation-2-close'
    }), NOW);

    assert.equal(agent.activeReservationCount(), 0);
    assert.equal(agent.terminalReservationCount(), 1);
    assert.equal(agent.reservationCount(), 1);
    assert.equal(agent.session('reservation-1'), undefined);
    assert.equal(agent.session('reservation-2')?.state, 'closed');
  });

  it('rejects expired open and mutate leases before transport execution', async () => {
    const { agent, transport } = fixture();
    const expiredLease = '2026-07-24T23:59:59.000Z';

    await assert.rejects(
      agent.execute(command('prepare', 1, {
        lease_expires_at: expiredLease
      }), NOW),
      (error: unknown) =>
        error instanceof MediaControlError &&
        error.code === 'media_control_lease_expired'
    );
    assert.equal(transport.sideEffectCount(), 0);
  });

  it('serializes concurrent commands for the same reservation', async () => {
    const { agent, transport } = fixture();
    await agent.execute(command('prepare', 1), NOW);

    const first = agent.execute(command('commit', 2, {
      command_id: 'commit-concurrent-a'
    }), NOW);
    const second = agent.execute(command('commit', 2, {
      command_id: 'commit-concurrent-b'
    }), NOW);
    const results = await Promise.allSettled([first, second]);

    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1
    );
    assert.equal(
      results.some((result) =>
        result.status === 'rejected' &&
        result.reason instanceof MediaControlError &&
        result.reason.code === 'stale_sequence'),
      true
    );
    assert.equal(transport.sideEffectCount('commit'), 1);
  });

  it('does not replay stale cleanup after authority takeover', async () => {
    const { agent, authority, transport } = fixture();
    await agent.execute(command('prepare', 1), NOW);
    transport.failNext('before_apply_timeout');
    assert.equal(
      (await agent.execute(command('cancel', 2), NOW)).state,
      'unknown'
    );
    authority.ownerEpoch = ((8n << 32n) | 1n).toString();

    await agent.sweep(new Date('2026-07-25T00:01:01.000Z'));

    assert.equal(transport.sideEffectCount('cancel'), 0);
  });

  it('rebuilds active session state from the transport after agent restart', async () => {
    const authority = new FakeAuthority();
    const transport = new InMemoryMediaTransport();
    const first = new MediaControlAgent({ authority, transport });
    await first.execute(command('prepare', 1), NOW);
    await first.execute(command('commit', 2), NOW);
    assert.equal(transport.forwardPackets('reservation-1', 10), 10);

    const restarted = new MediaControlAgent({ authority, transport });
    const closed = await restarted.execute(command('close', 3), NOW);

    assert.equal(closed.state, 'succeeded');
    assert.equal(closed.session?.state, 'closed');
    assert.equal(transport.forwardPackets('reservation-1', 10), 0);
  });

  it('recovers an after-apply command when the agent restarts before journaling it', async () => {
    const authority = new FakeAuthority();
    const transport = new InMemoryMediaTransport();
    transport.failNext('after_apply_timeout');
    const first = new MediaControlAgent({ authority, transport });
    const input = command('prepare', 1);
    assert.equal((await first.execute(input, NOW)).state, 'unknown');

    const restarted = new MediaControlAgent({ authority, transport });
    const recovered = await restarted.execute(input, NOW);

    assert.equal(recovered.state, 'succeeded');
    assert.equal(recovered.session?.state, 'prepared');
    assert.equal(transport.sideEffectCount('prepare'), 1);
  });

  it('evicts finalized journal entries without blocking a long session', async () => {
    const { agent, transport } = fixture();
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      await agent.execute(command('prepare', sequence, {
        command_id: `long-call-prepare-${sequence}`
      }), NOW);
    }
    const committed = await agent.execute(command('commit', 13, {
      command_id: 'long-call-commit-13'
    }), NOW);

    assert.equal(committed.state, 'succeeded');
    assert.equal(transport.sideEffectCount('prepare'), 1);
    assert.equal(transport.sideEffectCount('commit'), 1);
  });

  it('reschedules unknown reconciliation after a transport query failure', async () => {
    const { agent, transport } = fixture({ failure: 'before_apply_timeout' });
    await agent.execute(command('prepare', 1), NOW);
    transport.failNextQuery();

    assert.equal(
      await agent.sweep(new Date('2026-07-25T00:01:01.000Z')),
      0
    );
    assert.equal(agent.scheduledDeadlineCount(), 1);
    assert.equal(
      await agent.sweep(new Date('2026-07-25T00:01:02.001Z')),
      1
    );
    assert.equal(agent.session('reservation-1')?.state, undefined);
  });

  it('reschedules prepared-session expiry after release failure', async () => {
    const { agent, transport } = fixture();
    await agent.execute(command('prepare', 1), NOW);
    transport.failNextRelease();

    assert.equal(
      await agent.sweep(new Date('2026-07-25T00:01:01.000Z')),
      0
    );
    assert.equal(agent.session('reservation-1')?.state, 'prepared');
    assert.equal(agent.scheduledDeadlineCount(), 1);
    assert.equal(
      await agent.sweep(new Date('2026-07-25T00:01:02.001Z')),
      1
    );
    assert.equal(agent.session('reservation-1')?.state, 'expired');
  });
});
