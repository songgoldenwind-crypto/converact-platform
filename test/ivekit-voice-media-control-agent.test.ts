import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MediaControlAgent,
  MediaControlError,
  type MediaControlAuthorizationFailure,
  type MediaControlAuthorityPort
} from '../src/agent-runtime/ivekit/media-control/agent.js';
import {
  InMemoryMediaTransport,
  type SimulatedFailure
} from '../src/agent-runtime/ivekit/media-control/simulator.js';
import type {
  MediaTransportPort
} from '../src/agent-runtime/ivekit/media-control/transport.js';
import {
  mediaControlPayloadHash,
  type MediaControlAction,
  type MediaControlCommand,
  type MediaControlReconcileInput
} from '../src/agent-runtime/ivekit/media-control/protocol.js';

const NOW = new Date('2026-07-25T00:00:00.000Z');
const OWNER_EPOCH = ((7n << 32n) | 11n).toString();

class FakeAuthority implements MediaControlAuthorityPort {
  available = true;
  ownerEpoch = OWNER_EPOCH;
  calls = 0;
  lastInput: {
    admission_reservation_id: string;
    call_id: string;
    owner_epoch: string;
    operation: 'open' | 'mutate' | 'close';
  } | undefined;

  async authorize(input: {
    admission_reservation_id: string;
    call_id: string;
    owner_epoch: string;
    operation: 'open' | 'mutate' | 'close';
  }) {
    this.calls += 1;
    this.lastInput = structuredClone(input);
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
  command_sequence: number,
  overrides: Partial<MediaControlCommand> = {}
): MediaControlCommand {
  const payload = overrides.payload ?? (action === 'offer'
    ? {
        offer_sdp: 'v=0\r\n',
        media_profile_id: 'g711-relay-v1'
      }
    : {});
  return {
    protocol_version: 'ivekit.media-control.v1',
    action,
    command_id: `cmd-${action}-${command_sequence}`,
    tenant_id: 'tenant-handle-1',
    call_id: 'call-1',
    leg_id: 'leg-1',
    cell_id: 'cell-1',
    owner_node_id: 'rustpbx-1',
    owner_epoch: OWNER_EPOCH,
    admission_reservation_id: 'reservation-1',
    media_reservation_id: 'reservation-1',
    command_sequence,
    idempotency_key: `idem-${action}-${command_sequence}`,
    expires_at: '2026-07-25T00:01:00.000Z',
    ...overrides,
    payload,
    payload_hash: overrides.payload_hash ?? mediaControlPayloadHash(payload)
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
  it('forwards the admission reservation identity to the media transport', async () => {
    const authority = new FakeAuthority();
    const delegate = new InMemoryMediaTransport();
    let observed: Record<string, unknown> | undefined;
    const transport: MediaTransportPort = {
      execute: (input) => {
        observed = structuredClone(input) as unknown as Record<string, unknown>;
        return delegate.execute(input);
      },
      queryCommand: (input) => delegate.queryCommand(input),
      querySession: (input) => delegate.querySession(input),
      scanOrphanCandidates: (input) => delegate.scanOrphanCandidates(input),
      releaseSession: (transportSessionId, reason) =>
        delegate.releaseSession(transportSessionId, reason)
    };
    const agent = new MediaControlAgent({
      authority,
      transport,
      max_reservations: 100,
      max_terminal_reservations: 100,
      max_commands_per_reservation: 8,
      terminal_retention_ms: 1_000
    });

    const prepared = await agent.execute(command('offer', 1), NOW);

    assert.equal(prepared.result_class, 'committed');
    assert.equal(observed?.admission_reservation_id, 'reservation-1');
  });

  it('prepares and commits a media session through the transport port', async () => {
    const { agent, transport } = fixture();

    const prepared = await agent.execute(command('offer', 1), NOW);
    const committed = await agent.execute(command('answer', 2), NOW);

    assert.equal(prepared.result_class, 'committed');
    assert.equal(prepared.session?.state, 'prepared');
    assert.match(prepared.session?.effective_sdp ?? '', /^v=0/);
    assert.equal(committed.result_class, 'committed');
    assert.equal(committed.session?.state, 'committed');
    assert.equal(transport.sideEffectCount('offer'), 1);
    assert.equal(transport.sideEffectCount('answer'), 1);
  });

  it('keeps the bounded media lease independent from the admission reservation TTL', async () => {
    const { agent, authority, transport } = fixture();
    const mediaLease = '2026-07-25T00:00:30.000Z';

    const prepared = await agent.execute(command('offer', 1, {
      expires_at: mediaLease
    }), NOW);

    assert.equal(prepared.result_class, 'committed');
    assert.equal(prepared.session?.expires_at, mediaLease);
    assert.equal(authority.calls, 1);
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('authorizes the admission reservation independently from the leg media session', async () => {
    const { agent, authority, transport } = fixture();

    const prepared = await agent.execute(command('offer', 1, {
      media_reservation_id: 'reservation-1/leg-1'
    }), NOW);

    assert.equal(prepared.result_class, 'committed');
    assert.deepEqual(authority.lastInput, {
      admission_reservation_id: 'reservation-1',
      call_id: 'call-1',
      owner_epoch: OWNER_EPOCH,
      operation: 'open'
    });
    assert.equal(prepared.session?.media_reservation_id, 'reservation-1/leg-1');
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('reports the normalized authority failure before rejecting media', async () => {
    const failures: MediaControlAuthorizationFailure[] = [];
    const transport = new InMemoryMediaTransport();
    const agent = new MediaControlAgent({
      authority: {
        async authorize() {
          throw Object.assign(new Error('reservation is not projected yet'), {
            code: 'component_reservation_not_found',
            status: 404,
            retryable: false
          });
        }
      },
      transport,
      authorization_failure_observer: (failure) => failures.push(failure)
    });

    const rejected = await agent.execute(command('offer', 1, {
      call_id: 'vcall-authority-failure',
      admission_reservation_id: 'reservation-authority-failure',
      media_reservation_id: 'reservation-authority-failure/leg-1'
    }), NOW);

    assert.equal(rejected.result_class, 'terminal_error');
    assert.equal(rejected.error_code, 'component_reservation_not_found');
    assert.deepEqual(failures, [{
      admission_reservation_id: 'reservation-authority-failure',
      call_id: 'vcall-authority-failure',
      owner_epoch: OWNER_EPOCH,
      operation: 'open',
      error_code: 'component_reservation_not_found',
      status: 404,
      retryable: false
    }]);
    assert.equal(transport.sideEffectCount(), 0);
  });

  it('rejects an excessively long media lease before a transport side effect', async () => {
    const { agent, transport } = fixture();

    const rejected = await agent.execute(command('offer', 1, {
      expires_at: '2026-07-25T00:05:00.000Z'
    }), NOW);

    assert.equal(rejected.result_class, 'terminal_error');
    assert.equal(rejected.error_code, 'media_control_lease_horizon_exceeded');
    assert.equal(transport.sideEffectCount(), 0);
  });

  it('rejects every stale owner epoch before a transport side effect', async () => {
    const { agent, transport } = fixture();
    const stale = ((6n << 32n) | 99n).toString();

    const rejected = await agent.execute(
      command('offer', 1, { owner_epoch: stale }),
      NOW
    );
    assert.equal(rejected.result_class, 'rejected_epoch');
    assert.equal(rejected.error_code, 'stale_owner_epoch');
    assert.equal(transport.sideEffectCount(), 0);
  });

  it('replays a command result without repeating its transport side effect', async () => {
    const { agent, authority, transport } = fixture();
    const input = command('offer', 1);

    const first = await agent.execute(input, NOW);
    const replay = await agent.execute(structuredClone(input), NOW);

    assert.equal(first.result_class, 'committed');
    assert.equal(replay.result_class, 'replayed');
    assert.deepEqual(replay.session, first.session);
    assert.equal(authority.calls, 1);
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('returns a recorded replay while the authority is unavailable', async () => {
    const { agent, authority, transport } = fixture();
    const input = command('offer', 1);
    const first = await agent.execute(input, NOW);
    authority.available = false;

    const replay = await agent.execute(structuredClone(input), NOW);

    assert.equal(first.result_class, 'committed');
    assert.equal(replay.result_class, 'replayed');
    assert.deepEqual(replay.session, first.session);
    assert.equal(authority.calls, 1);
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('deduplicates a new command ID by idempotency key', async () => {
    const { agent, transport } = fixture();
    const first = command('offer', 1);
    await agent.execute(first, NOW);

    const replay = await agent.execute(command('offer', 1, {
      command_id: 'retry-with-new-command-id'
    }), NOW);

    assert.equal(replay.result_class, 'replayed');
    assert.equal(replay.command_id, 'retry-with-new-command-id');
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('rejects idempotency-key reuse with different command facts', async () => {
    const { agent, transport } = fixture();
    await agent.execute(command('offer', 1), NOW);

    const rejected = await agent.execute(command('offer', 1, {
      command_id: 'conflicting-idempotency-command',
      payload: {
        offer_sdp: 'v=0\r\na=sendonly\r\n',
        media_profile_id: 'g711-relay-v1'
      }
    }), NOW);

    assert.equal(rejected.result_class, 'terminal_error');
    assert.equal(rejected.error_code, 'idempotency_key_conflict');
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('rejects command-id reuse with a different payload', async () => {
    const { agent, transport } = fixture();
    const first = command('offer', 1);
    await agent.execute(first, NOW);

    const rejected = await agent.execute(command('offer', 1, {
        command_id: first.command_id,
        payload: {
          offer_sdp: 'v=0\r\na=sendonly\r\n',
          media_profile_id: 'g711-relay-v1'
        }
      }), NOW);
    assert.equal(rejected.result_class, 'terminal_error');
    assert.equal(rejected.error_code, 'command_payload_conflict');
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('reconciles an after-apply timeout without repeating the side effect', async () => {
    const { agent, transport } = fixture({ failure: 'after_apply_timeout' });
    const input = command('offer', 1);

    const uncertain = await agent.execute(input, NOW);
    const reconciled = await agent.reconcile({
      protocol_version: 'ivekit.media-control.v1',
      action: 'reconcile',
      command: input
    }, NOW);

    assert.equal(uncertain.result_class, 'unknown');
    assert.equal(reconciled.result_class, 'committed');
    assert.equal(reconciled.session?.state, 'prepared');
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('safely replays a command that timed out before the transport observed it', async () => {
    const { agent, transport } = fixture({ failure: 'before_apply_timeout' });
    const input = command('offer', 1);

    const uncertain = await agent.execute(input, NOW);
    const reconciled = await agent.reconcile({
      protocol_version: 'ivekit.media-control.v1',
      action: 'reconcile',
      command: input
    }, NOW);

    assert.equal(uncertain.result_class, 'unknown');
    assert.equal(reconciled.result_class, 'committed');
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('keeps committed packet forwarding alive when the control plane is unavailable', async () => {
    const { agent, authority, transport } = fixture();
    await agent.execute(command('offer', 1), NOW);
    await agent.execute(command('answer', 2), NOW);
    authority.available = false;

    const forwarded = transport.forwardPackets('reservation-1', 500);

    assert.equal(forwarded, 500);
    assert.equal(transport.forwardedPackets('reservation-1'), 500);
  });

  it('requires unknown commands to reconcile before a later command_sequence', async () => {
    const { agent, transport } = fixture({ failure: 'before_apply_timeout' });

    assert.equal(
      (await agent.execute(command('offer', 1), NOW)).result_class,
      'unknown'
    );
    const rejected = await agent.execute(command('answer', 2), NOW);
    assert.equal(rejected.result_class, 'terminal_error');
    assert.equal(rejected.error_code, 'command_reconciliation_required');
    assert.equal(transport.sideEffectCount('answer'), 0);
  });

  it('does not consume command_sequence for a deterministic transport failure', async () => {
    const authority = new FakeAuthority();
    const delegate = new InMemoryMediaTransport();
    let attempts = 0;
    const transport: MediaTransportPort = {
      async execute(input) {
        attempts += 1;
        if (attempts === 1) {
          return {
            state: 'failed',
            command_id: input.command_id,
            error_code: 'transport_capacity_exhausted',
            retryable: true
          };
        }
        return delegate.execute(input);
      },
      queryCommand: (input) => delegate.queryCommand(input),
      querySession: (input) => delegate.querySession(input),
      scanOrphanCandidates: (input) =>
        delegate.scanOrphanCandidates(input),
      releaseSession: (id, reason) => delegate.releaseSession(id, reason)
    };
    const agent = new MediaControlAgent({ authority, transport });

    const failed = await agent.execute(command('offer', 1), NOW);
    const retry = await agent.execute(command('offer', 1, {
      command_id: 'cmd-offer-replacement',
      idempotency_key: 'idem-offer-replacement'
    }), NOW);

    assert.equal(failed.result_class, 'rejected_capacity');
    assert.equal(retry.result_class, 'committed', JSON.stringify(retry));
    assert.equal(retry.session?.last_sequence, 1);
  });

  it('releases command_sequence when an unknown command resolves failed', async () => {
    const authority = new FakeAuthority();
    const delegate = new InMemoryMediaTransport();
    let first = true;
    let unknownIssued = false;
    const transport: MediaTransportPort = {
      async execute(input) {
        if (first) {
          first = false;
          unknownIssued = true;
          return {
            state: 'unknown',
            command_id: input.command_id,
            error_code: 'transport_timeout',
            retryable: true
          };
        }
        return delegate.execute(input);
      },
      async queryCommand(input) {
        if (!unknownIssued) return { found: false };
        return {
          found: true,
          outcome: {
            state: 'failed',
            command_id: input.command_id,
            error_code: 'transport_capacity_exhausted',
            retryable: true
          }
        };
      },
      querySession: (input) => delegate.querySession(input),
      scanOrphanCandidates: (input) =>
        delegate.scanOrphanCandidates(input),
      releaseSession: (id, reason) => delegate.releaseSession(id, reason)
    };
    const agent = new MediaControlAgent({ authority, transport });
    const original = command('offer', 1);

    assert.equal(
      (await agent.execute(original, NOW)).result_class,
      'unknown'
    );
    const reconciled = await agent.reconcile({
      protocol_version: 'ivekit.media-control.v1',
      action: 'reconcile',
      command: original
    }, NOW);
    const replacement = await agent.execute(command('offer', 1, {
      command_id: 'cmd-offer-after-failed-reconcile',
      idempotency_key: 'idem-offer-after-failed-reconcile'
    }), NOW);

    assert.equal(reconciled.result_class, 'rejected_capacity');
    assert.equal(
      replacement.result_class,
      'committed',
      JSON.stringify(replacement)
    );
    assert.equal(replacement.session?.last_sequence, 1);
  });

  it('allows an authorized higher epoch takeover and fences the old owner', async () => {
    const { agent, authority, transport } = fixture();
    const original = command('offer', 1);
    await agent.execute(original, NOW);
    await agent.execute(command('answer', 2), NOW);

    const nextEpoch = ((8n << 32n) | 1n).toString();
    authority.ownerEpoch = nextEpoch;
    const takeover = await agent.execute(command('answer', 1, {
      owner_epoch: nextEpoch,
      owner_node_id: 'rustpbx-2',
      command_id: 'cmd-takeover-commit-1'
    }), NOW);

    assert.equal(takeover.result_class, 'committed');
    assert.equal(takeover.session?.owner_epoch, nextEpoch);
    const rejected = await agent.execute(original, NOW);
    assert.equal(rejected.result_class, 'rejected_epoch');
    assert.equal(rejected.error_code, 'stale_owner_epoch');
    assert.equal(transport.sideEffectCount('offer'), 1);
    assert.equal(transport.sideEffectCount('answer'), 2);
  });

  it('cancels prepared media and closes committed forwarding', async () => {
    const cancelled = fixture();
    await cancelled.agent.execute(command('offer', 1), NOW);
    const cancelResult = await cancelled.agent.execute(command('delete', 2), NOW);
    assert.equal(cancelResult.session?.state, 'closed');
    assert.equal(cancelled.transport.isForwarding('reservation-1'), false);

    const closed = fixture();
    await closed.agent.execute(command('offer', 1), NOW);
    await closed.agent.execute(command('answer', 2), NOW);
    assert.equal(closed.transport.forwardPackets('reservation-1', 10), 10);
    const closeResult = await closed.agent.execute(command('delete', 3), NOW);
    assert.equal(closeResult.session?.state, 'closed');
    assert.equal(closed.transport.forwardPackets('reservation-1', 10), 0);
  });

  it('expires prepared sessions but never expires committed media', async () => {
    const prepared = fixture();
    await prepared.agent.execute(command('offer', 1), NOW);
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
    await committed.agent.execute(command('offer', 1), NOW);
    await committed.agent.execute(command('answer', 2), NOW);
    assert.equal(
      await committed.agent.sweep(new Date('2026-07-25T00:01:01.000Z')),
      0
    );
    assert.equal(
      committed.agent.session('reservation-1')?.state,
      'committed'
    );
  });

  it('enforces reservation and command_sequence bounds', async () => {
    const { agent, transport } = fixture({ max_reservations: 1 });
    await agent.execute(command('offer', 1), NOW);

    const capacity = await agent.execute(command('offer', 1, {
        media_reservation_id: 'reservation-2',
        call_id: 'call-2',
        command_id: 'cmd-prepare-reservation-2'
      }), NOW);
    assert.equal(capacity.result_class, 'rejected_capacity');
    assert.equal(capacity.error_code, 'media_control_capacity_exhausted');
    const gap = await agent.execute(command('answer', 3), NOW);
    assert.equal(gap.result_class, 'terminal_error');
    assert.equal(gap.error_code, 'sequence_gap');
    assert.equal(transport.sideEffectCount('offer'), 1);
    assert.equal(transport.sideEffectCount('answer'), 0);
  });

  it('does not let transport recovery exceed the reservation bound', async () => {
    const authority = new FakeAuthority();
    const transport = new InMemoryMediaTransport();
    const first = new MediaControlAgent({ authority, transport });
    await first.execute(command('offer', 1), NOW);
    await first.execute(command('offer', 1, {
      media_reservation_id: 'reservation-2',
      call_id: 'call-2',
      command_id: 'reservation-2-prepare-1'
    }), NOW);

    const restarted = new MediaControlAgent({
      authority,
      transport,
      max_reservations: 1
    });
    await restarted.execute(command('offer', 2, {
      command_id: 'reservation-1-prepare-2'
    }), NOW);
    const rejected = await restarted.execute(command('offer', 2, {
        media_reservation_id: 'reservation-2',
        call_id: 'call-2',
        command_id: 'reservation-2-prepare-2'
      }), NOW);
    assert.equal(rejected.result_class, 'rejected_capacity');
    assert.equal(rejected.error_code, 'media_control_capacity_exhausted');
    assert.equal(restarted.activeReservationCount(), 1);
    assert.equal(restarted.reservationCount(), 1);
  });

  it('bounds simulator session and command journals', async () => {
    const authority = new FakeAuthority();
    const sessionBound = new InMemoryMediaTransport({
      max_sessions: 1,
      max_commands: 4
    });
    const sessionAgent = new MediaControlAgent({
      authority,
      transport: sessionBound,
      max_reservations: 2
    });
    await sessionAgent.execute(command('offer', 1), NOW);
    const sessionRejected = await sessionAgent.execute(command('offer', 1, {
      media_reservation_id: 'reservation-2',
      call_id: 'call-2',
      command_id: 'reservation-2-offer-1'
    }), NOW);
    assert.equal(sessionRejected.result_class, 'rejected_capacity');
    assert.equal(sessionRejected.error_code, 'transport_capacity_exhausted');
    assert.equal(sessionRejected.retryable, true);
    assert.equal(sessionBound.sessionCount(), 1);

    const commandBound = new InMemoryMediaTransport({
      max_sessions: 1,
      max_commands: 1
    });
    const commandAgent = new MediaControlAgent({
      authority,
      transport: commandBound
    });
    await commandAgent.execute(command('offer', 1), NOW);
    const commandRejected = await commandAgent.execute(
      command('answer', 2),
      NOW
    );
    assert.equal(commandRejected.result_class, 'rejected_capacity');
    assert.equal(
      commandRejected.error_code,
      'transport_command_capacity_exhausted'
    );
    assert.equal(commandRejected.retryable, true);
    assert.equal(commandBound.commandCount(), 1);
  });

  it('releases active capacity while bounding terminal replay records', async () => {
    const { agent } = fixture({
      max_reservations: 1,
      max_terminal_reservations: 1
    });
    await agent.execute(command('offer', 1), NOW);
    await agent.execute(command('delete', 2), NOW);

    assert.equal(agent.activeReservationCount(), 0);
    assert.equal(agent.terminalReservationCount(), 1);

    await agent.execute(command('offer', 1, {
      media_reservation_id: 'reservation-2',
      call_id: 'call-2',
      command_id: 'reservation-2-prepare'
    }), NOW);
    await agent.execute(command('delete', 2, {
      media_reservation_id: 'reservation-2',
      call_id: 'call-2',
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

    const rejected = await agent.execute(command('offer', 1, {
        expires_at: expiredLease
      }), NOW);
    assert.equal(rejected.result_class, 'terminal_error');
    assert.equal(rejected.error_code, 'media_control_lease_expired');
    assert.equal(transport.sideEffectCount(), 0);
  });

  it('serializes concurrent commands for the same reservation', async () => {
    const { agent, transport } = fixture();
    await agent.execute(command('offer', 1), NOW);

    const first = agent.execute(command('answer', 2, {
      command_id: 'commit-concurrent-a',
      idempotency_key: 'commit-concurrent-a'
    }), NOW);
    const second = agent.execute(command('answer', 2, {
      command_id: 'commit-concurrent-b',
      idempotency_key: 'commit-concurrent-b'
    }), NOW);
    const results = await Promise.allSettled([first, second]);

    assert.equal(
      results.some((result) =>
        result.status === 'fulfilled' &&
        result.value.result_class === 'terminal_error' &&
        result.value.error_code === 'stale_sequence'),
      true
    );
    assert.equal(transport.sideEffectCount('answer'), 1);
  });

  it('does not replay stale cleanup after authority takeover', async () => {
    const { agent, authority, transport } = fixture();
    await agent.execute(command('offer', 1), NOW);
    transport.failNext('before_apply_timeout');
    assert.equal(
      (await agent.execute(command('delete', 2), NOW)).result_class,
      'unknown'
    );
    authority.ownerEpoch = ((8n << 32n) | 1n).toString();

    await agent.sweep(new Date('2026-07-25T00:01:01.000Z'));

    assert.equal(transport.sideEffectCount('delete'), 0);
  });

  it('rebuilds active session state from the transport after agent restart', async () => {
    const authority = new FakeAuthority();
    const transport = new InMemoryMediaTransport();
    const first = new MediaControlAgent({ authority, transport });
    await first.execute(command('offer', 1), NOW);
    await first.execute(command('answer', 2), NOW);
    assert.equal(transport.forwardPackets('reservation-1', 10), 10);

    const restarted = new MediaControlAgent({ authority, transport });
    const closed = await restarted.execute(command('delete', 3), NOW);

    assert.equal(closed.result_class, 'committed');
    assert.equal(closed.session?.state, 'closed');
    assert.equal(transport.forwardPackets('reservation-1', 10), 0);
  });

  it('recovers an after-apply command when the agent restarts before journaling it', async () => {
    const authority = new FakeAuthority();
    const transport = new InMemoryMediaTransport();
    transport.failNext('after_apply_timeout');
    const first = new MediaControlAgent({ authority, transport });
    const input = command('offer', 1);
    assert.equal((await first.execute(input, NOW)).result_class, 'unknown');

    const restarted = new MediaControlAgent({ authority, transport });
    const recovered = await restarted.execute(input, NOW);

    assert.equal(recovered.result_class, 'replayed');
    assert.equal(recovered.session?.state, 'prepared');
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('reconciles an unknown command after the agent restarts', async () => {
    const authority = new FakeAuthority();
    const transport = new InMemoryMediaTransport();
    transport.failNext('after_apply_timeout');
    const first = new MediaControlAgent({ authority, transport });
    const input = command('offer', 1);
    assert.equal((await first.execute(input, NOW)).result_class, 'unknown');

    const restarted = new MediaControlAgent({ authority, transport });
    const reconciled = await restarted.reconcile({
      protocol_version: 'ivekit.media-control.v1',
      action: 'reconcile',
      command: input
    } as unknown as MediaControlReconcileInput, NOW);

    assert.equal(reconciled.result_class, 'replayed');
    assert.equal(reconciled.session?.state, 'prepared');
    assert.equal(transport.sideEffectCount('offer'), 1);
  });

  it('evicts finalized journal entries without blocking a long session', async () => {
    const { agent, transport } = fixture();
    for (let command_sequence = 1; command_sequence <= 12; command_sequence += 1) {
      await agent.execute(command('offer', command_sequence, {
        command_id: `long-call-prepare-${command_sequence}`
      }), NOW);
    }
    const committed = await agent.execute(command('answer', 13, {
      command_id: 'long-call-commit-13'
    }), NOW);

    assert.equal(committed.result_class, 'committed');
    assert.equal(transport.sideEffectCount('offer'), 1);
    assert.equal(transport.sideEffectCount('answer'), 1);
  });

  it('reschedules unknown reconciliation after a transport query failure', async () => {
    const { agent, transport } = fixture({ failure: 'before_apply_timeout' });
    await agent.execute(command('offer', 1), NOW);
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
    await agent.execute(command('offer', 1), NOW);
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
