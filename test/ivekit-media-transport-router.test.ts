import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MediaTransportRouter
} from '../src/agent-runtime/converact/media-control/router.js';
import type {
  MediaTransportCommand,
  MediaTransportCommandIdentity,
  MediaTransportOrphanCandidate,
  MediaTransportOutcome,
  MediaTransportPort,
  MediaTransportQuery,
  MediaTransportSessionSnapshot
} from '../src/agent-runtime/converact/media-control/transport.js';

describe('media transport router', () => {
  it('routes only frozen ordinary and processing profiles', async () => {
    const fastPath = new ProbeTransport('fast');
    const processing = new ProbeTransport('processing');
    const router = new MediaTransportRouter({ fast_path: fastPath, processing });

    await router.execute(command('ordinary', 'g711-relay-v1'));
    await router.execute(command('ivr', 'VOICE-IVR-G711-OPUS-V1'));

    assert.deepEqual(fastPath.commandReservations(), ['ordinary']);
    assert.deepEqual(processing.commandReservations(), ['ivr']);
  });

  it('fails closed for an unknown profile without touching either transport', async () => {
    const fastPath = new ProbeTransport('fast');
    const processing = new ProbeTransport('processing');
    const router = new MediaTransportRouter({ fast_path: fastPath, processing });

    const outcome = await router.execute(command('unknown', 'profile-guessed'));

    assert.deepEqual(outcome, {
      state: 'failed',
      command_id: 'command-unknown-offer',
      error_code: 'media_profile_unsupported',
      retryable: false
    });
    assert.equal(fastPath.commands.length, 0);
    assert.equal(processing.commands.length, 0);
  });

  it('keeps an unknown offer bound to its original transport', async () => {
    const fastPath = new ProbeTransport('fast');
    const processing = new ProbeTransport('processing');
    processing.nextOutcome = {
      state: 'unknown',
      command_id: 'command-call-a-offer',
      error_code: 'processing_transport_timeout',
      retryable: true
    };
    const router = new MediaTransportRouter({ fast_path: fastPath, processing });

    const offered = await router.execute(
      command('call-a', 'VOICE-IVR-G711-OPUS-V1')
    );
    const answered = await router.execute(command(
      'call-a',
      'VOICE-ORDINARY',
      'answer',
      2
    ));

    assert.equal(offered.state, 'unknown');
    assert.equal(answered.state, 'succeeded');
    assert.equal(fastPath.commands.length, 0);
    assert.deepEqual(
      processing.commands.map((entry) => entry.action),
      ['offer', 'answer']
    );
  });

  it('recovers a lost binding by querying both transports exactly once', async () => {
    const fastPath = new ProbeTransport('fast');
    const processing = new ProbeTransport('processing');
    processing.sessions.set('restored', session('restored', 'processing'));
    const router = new MediaTransportRouter({ fast_path: fastPath, processing });

    const restored = await router.querySession({
      media_reservation_id: 'restored',
      call_id: 'call-restored'
    });
    const updated = await router.execute(command(
      'restored',
      'VOICE-ORDINARY',
      'update',
      3,
      {
        call_id: 'call-restored',
        transport_session_id: 'processing:restored'
      }
    ));

    assert.equal(restored?.transport_session_id, 'processing:restored');
    assert.equal(updated.state, 'succeeded');
    assert.equal(fastPath.sessionQueries, 1);
    assert.equal(processing.sessionQueries, 1);
    assert.equal(fastPath.commands.length, 0);
    assert.equal(processing.commands.length, 1);
  });

  it('rejects ambiguous restart recovery instead of choosing a transport', async () => {
    const fastPath = new ProbeTransport('fast');
    const processing = new ProbeTransport('processing');
    fastPath.commandQuery = {
      found: true,
      outcome: success('command-conflict', 'fast:conflict')
    };
    processing.commandQuery = {
      found: true,
      outcome: success('command-conflict', 'processing:conflict')
    };
    const router = new MediaTransportRouter({ fast_path: fastPath, processing });

    await assert.rejects(
      router.queryCommand({
        command_id: 'command-conflict',
        media_reservation_id: 'conflict',
        owner_epoch: '1',
        command_hash: HASH
      }),
      /media_transport_binding_conflict/
    );
  });

  it('releases processing-prefixed sessions only through the processing pool', async () => {
    const fastPath = new ProbeTransport('fast');
    const processing = new ProbeTransport('processing');
    const router = new MediaTransportRouter({ fast_path: fastPath, processing });

    await router.releaseSession('processing:session-a', 'lease_expired');
    await router.releaseSession('call-b', 'lease_expired');

    assert.deepEqual(processing.releases, ['processing:session-a']);
    assert.deepEqual(fastPath.releases, ['call-b']);
  });

  it('isolates an established processing failure from unrelated fast-path reservations', async () => {
    const fastPath = new ProbeTransport('fast');
    const processing = new ProbeTransport('processing');
    const router = new MediaTransportRouter({ fast_path: fastPath, processing });

    await router.execute(command('ordinary-a', 'g711-relay-v1'));
    await router.execute(command('ivr-a', 'VOICE-IVR-G711-OPUS-V1'));
    processing.nextOutcome = {
      state: 'failed',
      command_id: 'command-ivr-a-inject_dtmf',
      error_code: 'processing_worker_unavailable',
      retryable: true
    };

    const failed = await router.execute(command(
      'ivr-a',
      'VOICE-IVR-G711-OPUS-V1',
      'inject_dtmf',
      2,
      {
        transport_session_id: 'processing:ivr-a',
        payload: {
          source: 'sip_info',
          event_id: 'sip-info-caller-42',
          digit: '5'
        }
      }
    ));
    const ordinaryUpdate = await router.execute(command(
      'ordinary-a',
      'g711-relay-v1',
      'update',
      2,
      {
        transport_session_id: 'fast:ordinary-a',
        payload: { sdp_role: 'offer', sdp: 'v=0\r\n' }
      }
    ));

    assert.equal(failed.state, 'failed');
    assert.equal(ordinaryUpdate.state, 'succeeded');
    assert.deepEqual(
      fastPath.commands.map((entry) => [
        entry.media_reservation_id,
        entry.action
      ]),
      [
        ['ordinary-a', 'offer'],
        ['ordinary-a', 'update']
      ]
    );
    assert.deepEqual(
      processing.commands.map((entry) => [
        entry.media_reservation_id,
        entry.action
      ]),
      [
        ['ivr-a', 'offer'],
        ['ivr-a', 'inject_dtmf']
      ]
    );
    assert.deepEqual(fastPath.releases, []);
  });

  it('alternates one-item orphan pages without advancing an unreturned transport', async () => {
    const fastPath = new ProbeTransport('fast');
    const processing = new ProbeTransport('processing');
    fastPath.orphans = [candidate('fast-a', 'fast')];
    processing.orphans = [candidate('processing-a', 'processing')];
    const router = new MediaTransportRouter({ fast_path: fastPath, processing });

    const first = await router.scanOrphanCandidates({ after: '', limit: 1 });
    const second = await router.scanOrphanCandidates({
      after: first.next_cursor,
      limit: 1
    });

    assert.deepEqual(
      [first.items[0]?.media_reservation_id,
        second.items[0]?.media_reservation_id],
      ['fast-a', 'processing-a']
    );
    assert.deepEqual(fastPath.scanLimits, [1]);
    assert.deepEqual(processing.scanLimits, [1]);
  });
});

class ProbeTransport implements MediaTransportPort {
  readonly commands: MediaTransportCommand[] = [];
  readonly releases: string[] = [];
  readonly sessions = new Map<string, MediaTransportSessionSnapshot>();
  orphans: MediaTransportOrphanCandidate[] = [];
  readonly scanLimits: number[] = [];
  nextOutcome: MediaTransportOutcome | undefined;
  commandQuery: MediaTransportQuery = { found: false };
  sessionQueries = 0;

  constructor(readonly name: 'fast' | 'processing') {}

  async execute(command: MediaTransportCommand): Promise<MediaTransportOutcome> {
    this.commands.push(structuredClone(command));
    const outcome = this.nextOutcome;
    this.nextOutcome = undefined;
    return outcome ?? success(
      command.command_id,
      this.name === 'processing'
        ? `processing:${command.media_reservation_id}`
        : `fast:${command.media_reservation_id}`
    );
  }

  async queryCommand(
    _identity: MediaTransportCommandIdentity
  ): Promise<MediaTransportQuery> {
    return structuredClone(this.commandQuery);
  }

  async querySession(input: {
    media_reservation_id: string;
    call_id: string;
  }): Promise<MediaTransportSessionSnapshot | undefined> {
    this.sessionQueries += 1;
    const value = this.sessions.get(input.media_reservation_id);
    return value?.call_id === input.call_id ? structuredClone(value) : undefined;
  }

  async scanOrphanCandidates(input: {
    after: string;
    limit: number;
  }): Promise<{
    items: MediaTransportOrphanCandidate[];
    next_cursor: string;
  }> {
    this.scanLimits.push(input.limit);
    const previous = input.after
      ? this.orphans.findIndex(
          (entry) => entry.media_reservation_id === input.after
        )
      : -1;
    const items = this.orphans
      .slice(previous + 1, previous + 1 + input.limit)
      .map((entry) => structuredClone(entry));
    return {
      items,
      next_cursor: items.at(-1)?.media_reservation_id ?? input.after
    };
  }

  async releaseSession(transportSessionId: string): Promise<void> {
    this.releases.push(transportSessionId);
  }

  commandReservations(): string[] {
    return this.commands.map((entry) => entry.media_reservation_id);
  }
}

function command(
  reservation: string,
  profile: string,
  action: MediaTransportCommand['action'] = 'offer',
  sequence = 1,
  overrides: Partial<MediaTransportCommand> = {}
): MediaTransportCommand {
  return {
    action,
    command_id: `command-${reservation}-${action}`,
    tenant_id: 'tenant-a',
    call_id: `call-${reservation}`,
    leg_id: 'leg-a',
    cell_id: 'cell-a',
    owner_node_id: 'node-a',
    owner_epoch: '1',
    admission_reservation_id: `admission-${reservation}`,
    media_reservation_id: reservation,
    expires_at: '2026-07-28T00:05:00.000Z',
    command_sequence: sequence,
    idempotency_key: `idempotency-${reservation}-${action}`,
    payload_hash: HASH,
    command_hash: HASH,
    payload: { media_profile_id: profile },
    ...overrides
  };
}

function success(
  commandId: string,
  transportSessionId: string
): Exclude<MediaTransportOutcome, { state: 'unknown' | 'failed' }> {
  return {
    state: 'succeeded',
    command_id: commandId,
    transport_session_id: transportSessionId,
    effective_sdp: 'v=0\r\n',
    session_state: 'prepared',
    applied_at: '2026-07-28T00:00:00.000Z'
  };
}

function session(
  reservation: string,
  transport: 'fast' | 'processing'
): MediaTransportSessionSnapshot {
  return {
    media_reservation_id: reservation,
    call_id: `call-${reservation}`,
    owner_epoch: '1',
    last_sequence: 2,
    state: 'committed',
    transport_session_id: transport === 'processing'
      ? `processing:${reservation}`
      : `fast:${reservation}`,
    effective_sdp: 'v=0\r\n',
    from_tag: null,
    to_tag: null,
    updated_at: '2026-07-28T00:00:00.000Z'
  };
}

function candidate(
  reservation: string,
  transport: 'fast' | 'processing'
): MediaTransportOrphanCandidate {
  return {
    tenant_id: 'tenant-a',
    call_id: `call-${reservation}`,
    leg_id: 'leg-a',
    cell_id: 'cell-a',
    owner_node_id: 'node-a',
    owner_epoch: '1',
    media_reservation_id: reservation,
    transport_session_id: transport === 'processing'
      ? `processing:${reservation}`
      : `fast:${reservation}`,
    expires_at: '2026-07-28T00:05:00.000Z',
    state: 'committed'
  };
}

const HASH = '51'.repeat(32);
