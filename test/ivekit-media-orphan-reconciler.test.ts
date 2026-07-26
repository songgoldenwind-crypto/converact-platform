import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MediaControlAgent,
  type MediaControlAuthorityPort,
  type MediaControlOrphanProbe
} from '../src/agent-runtime/ivekit/media-control/agent.js';
import {
  mediaControlPayloadHash,
  type MediaControlAction,
  type MediaControlCommand
} from '../src/agent-runtime/ivekit/media-control/protocol.js';
import {
  InMemoryMediaTransport
} from '../src/agent-runtime/ivekit/media-control/simulator.js';
import type {
  MediaTransportCommand,
  MediaTransportOrphanCandidate,
  MediaTransportOutcome,
  MediaTransportPort
} from '../src/agent-runtime/ivekit/media-control/transport.js';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const EXPIRED = new Date('2026-07-26T00:01:01.000Z');
const OWNER_EPOCH = ((9n << 32n) | 7n).toString();

class AllowAuthority implements MediaControlAuthorityPort {
  async authorize() {
    return {
      owner_epoch: OWNER_EPOCH,
      reservation_expires_at: '2026-07-26T00:01:00.000Z',
      node_lease_expires_at: '2026-07-26T00:00:30.000Z'
    };
  }
}

class ControlledOrphanProbe implements MediaControlOrphanProbe {
  ownerExists = true;
  sessionExists = true;
  available = true;
  calls = 0;

  async inspect() {
    this.calls += 1;
    if (!this.available) throw new Error('authority unavailable');
    return {
      owner_exists: this.ownerExists,
      session_exists: this.sessionExists
    };
  }
}

class RestoredOrphanTransport implements MediaTransportPort {
  released = 0;
  readonly candidate: MediaTransportOrphanCandidate = {
    tenant_id: 'tenant-handle-1',
    call_id: 'call-restored',
    leg_id: 'callee',
    cell_id: 'cell-1',
    owner_node_id: 'rustpbx-1',
    owner_epoch: OWNER_EPOCH,
    media_reservation_id: 'reservation-restored',
    transport_session_id: 'transport-restored',
    expires_at: '2026-07-26T00:01:00.000Z',
    state: 'committed'
  };

  async execute(command: MediaTransportCommand): Promise<MediaTransportOutcome> {
    return {
      state: 'failed',
      command_id: command.command_id,
      error_code: 'not_supported',
      retryable: false
    };
  }

  async queryCommand() {
    return { found: false as const };
  }

  async querySession() {
    return undefined;
  }

  async scanOrphanCandidates() {
    return {
      items: [structuredClone(this.candidate)],
      next_cursor: ''
    };
  }

  async releaseSession(): Promise<void> {
    this.released += 1;
  }
}

function command(
  action: MediaControlAction,
  sequence: number,
  reservation = 'reservation-1'
): MediaControlCommand {
  const payload = action === 'offer'
    ? {
        from_tag: `from-${reservation}`,
        media_profile_id: 'g711-relay-v1',
        offer_sdp: 'v=0\r\n'
      }
    : {
        answer_sdp: 'v=0\r\n',
        from_tag: `from-${reservation}`,
        to_tag: `to-${reservation}`
      };
  return {
    protocol_version: 'ivekit.media-control.v1',
    action,
    command_id: `cmd-${reservation}-${action}-${sequence}`,
    tenant_id: 'tenant-handle-1',
    call_id: `call-${reservation}`,
    leg_id: 'callee',
    cell_id: 'cell-1',
    owner_node_id: 'rustpbx-1',
    owner_epoch: OWNER_EPOCH,
    media_reservation_id: reservation,
    command_sequence: sequence,
    idempotency_key: `idem-${reservation}-${action}-${sequence}`,
    expires_at: '2026-07-26T00:01:00.000Z',
    payload,
    payload_hash: mediaControlPayloadHash(payload)
  };
}

async function fixture(reservations = ['reservation-1']) {
  const transport = new InMemoryMediaTransport({ now: () => EXPIRED });
  const probe = new ControlledOrphanProbe();
  const agent = new MediaControlAgent({
    authority: new AllowAuthority(),
    transport,
    orphan_probe: probe,
    orphan_batch_size: 16
  });
  for (const reservation of reservations) {
    await agent.execute(command('offer', 1, reservation), NOW);
    await agent.execute(command('answer', 2, reservation), NOW);
  }
  return { agent, probe, transport };
}

describe('media-control orphan reconciliation', () => {
  it('requires lease expiry plus missing owner and session before release', async () => {
    const { agent, probe, transport } = await fixture();

    assert.deepEqual(await agent.sweepOrphans(EXPIRED), {
      inspected: 1,
      released: 0,
      deferred: 1
    });
    assert.equal(transport.isForwarding('reservation-1'), true);

    probe.ownerExists = false;
    assert.equal((await agent.sweepOrphans(EXPIRED)).released, 0);
    assert.equal(transport.isForwarding('reservation-1'), true);

    probe.sessionExists = false;
    assert.deepEqual(await agent.sweepOrphans(EXPIRED), {
      inspected: 1,
      released: 1,
      deferred: 0
    });
    assert.equal(transport.isForwarding('reservation-1'), false);
    assert.equal(
      (await transport.querySession({
        media_reservation_id: 'reservation-1',
        call_id: 'call-reservation-1'
      }))?.state,
      'closed'
    );
  });

  it('fails closed and retries when authority evidence is unavailable', async () => {
    const { agent, probe, transport } = await fixture();
    probe.available = false;

    assert.deepEqual(await agent.sweepOrphans(EXPIRED), {
      inspected: 1,
      released: 0,
      deferred: 1
    });
    assert.equal(transport.isForwarding('reservation-1'), true);

    probe.available = true;
    probe.ownerExists = false;
    probe.sessionExists = false;
    assert.equal((await agent.sweepOrphans(EXPIRED)).released, 1);
  });

  it('bounds each scan and advances fairly across active reservations', async () => {
    const { agent, probe, transport } = await fixture([
      'reservation-1',
      'reservation-2',
      'reservation-3'
    ]);
    probe.ownerExists = false;
    probe.sessionExists = false;

    assert.equal((await agent.sweepOrphans(EXPIRED, 1)).inspected, 1);
    assert.equal((await agent.sweepOrphans(EXPIRED, 1)).inspected, 1);
    assert.equal((await agent.sweepOrphans(EXPIRED, 1)).inspected, 1);
    assert.equal(transport.isForwarding('reservation-1'), false);
    assert.equal(transport.isForwarding('reservation-2'), false);
    assert.equal(transport.isForwarding('reservation-3'), false);
  });

  it('recovers orphan candidates after the agent process loses memory', async () => {
    const transport = new RestoredOrphanTransport();
    const probe = new ControlledOrphanProbe();
    probe.ownerExists = false;
    probe.sessionExists = false;
    const agent = new MediaControlAgent({
      authority: new AllowAuthority(),
      transport,
      orphan_probe: probe,
      orphan_batch_size: 16
    });

    assert.equal(agent.reservationCount(), 0);
    assert.deepEqual(await agent.sweepOrphans(EXPIRED), {
      inspected: 1,
      released: 1,
      deferred: 0
    });
    assert.equal(transport.released, 1);
  });

  it('fails closed when a transport returns an invalid lease timestamp', async () => {
    const transport = new RestoredOrphanTransport();
    transport.candidate.expires_at = 'invalid-timestamp';
    const probe = new ControlledOrphanProbe();
    probe.ownerExists = false;
    probe.sessionExists = false;
    const agent = new MediaControlAgent({
      authority: new AllowAuthority(),
      transport,
      orphan_probe: probe,
      orphan_batch_size: 16
    });

    assert.deepEqual(await agent.sweepOrphans(EXPIRED), {
      inspected: 1,
      released: 0,
      deferred: 1
    });
    assert.equal(probe.calls, 0);
    assert.equal(transport.released, 0);
  });
});
