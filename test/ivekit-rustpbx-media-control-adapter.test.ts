import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaControlError } from '../src/agent-runtime/ivekit/media-control/agent.js';
import { mediaControlCommandHash } from '../src/agent-runtime/ivekit/media-control/protocol.js';
import type {
  MediaControlCommand,
  MediaControlReconcileInput,
  MediaControlResult,
  MediaSessionSnapshot
} from '../src/agent-runtime/ivekit/media-control/protocol.js';
import { rtpengineRequest } from '../src/agent-runtime/ivekit/media-control/rtpengine.js';
import {
  RustPbxMediaControlAdapter,
  rustPbxMediaCommandId,
  type RustPbxMediaControlClientPort
} from '../src/agent-runtime/ivekit/voice/adapters/media-control.js';

const OWNER_EPOCH = ((1n << 32n) | 1n).toString();

class FakeClient implements RustPbxMediaControlClientPort {
  readonly commands: MediaControlCommand[] = [];
  readonly reconciliations: MediaControlReconcileInput[] = [];
  next: MediaControlResult | undefined;
  reconcileResult: MediaControlResult | undefined;

  async execute(command: MediaControlCommand): Promise<MediaControlResult> {
    this.commands.push(structuredClone(command));
    return this.next ?? success(command);
  }

  async reconcile(
    input: MediaControlReconcileInput
  ): Promise<MediaControlResult> {
    this.reconciliations.push(structuredClone(input));
    return this.reconcileResult ?? {
      protocol_version: 'ivekit.media-control.v1',
      result_class: 'unknown',
      command_id: input.command.command_id,
      error_code: 'transport_timeout',
      retryable: true
    };
  }

  async session(reservationId: string): Promise<MediaSessionSnapshot> {
    return {
      media_reservation_id: reservationId,
      call_id: 'call-1',
      owner_epoch: OWNER_EPOCH,
      last_sequence: 2,
      state: 'committed',
      transport_session_id: 'transport-1',
      effective_sdp: 'v=0\r\na=ivekit-media-node:node-1\r\n',
      expires_at: '2026-07-25T00:01:00.000Z',
      updated_at: '2026-07-25T00:00:00.000Z'
    };
  }
}

class BlockingClient extends FakeClient {
  readonly started: Promise<void>;
  #markStarted!: () => void;
  #release!: () => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  override async execute(
    command: MediaControlCommand
  ): Promise<MediaControlResult> {
    this.commands.push(structuredClone(command));
    this.#markStarted();
    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    return success(command);
  }
}

function identity(command_sequence: number, commandId: string) {
  return {
    command_id: commandId,
    tenant_id: 'tenant-handle-1',
    call_id: 'call-1',
    leg_id: 'leg-1',
    cell_id: 'cell-1',
    owner_node_id: 'rustpbx-1',
    owner_epoch: OWNER_EPOCH,
    admission_reservation_id: 'reservation-1',
    media_reservation_id: 'reservation-1',
    command_sequence,
    idempotency_key: `idem-${commandId}`,
    expires_at: '2026-07-25T00:01:00.000Z'
  };
}

function success(command: MediaControlCommand): MediaControlResult {
  return {
    protocol_version: 'ivekit.media-control.v1',
    result_class: 'committed',
    command_id: command.command_id,
    session: {
      media_reservation_id: command.media_reservation_id,
      call_id: command.call_id,
      owner_epoch: command.owner_epoch,
      last_sequence: command.command_sequence,
      state: command.action === 'offer' ? 'prepared' : 'committed',
      transport_session_id: 'transport-1',
      effective_sdp: 'v=0\r\na=ivekit-media-node:node-1\r\n',
      expires_at: command.expires_at,
      updated_at: '2026-07-25T00:00:00.000Z'
    }
  };
}

function transportRequest(command: MediaControlCommand) {
  return rtpengineRequest({
    action: command.action,
    command_id: command.command_id,
    tenant_id: command.tenant_id,
    call_id: command.call_id,
    leg_id: command.leg_id,
    cell_id: command.cell_id,
    owner_node_id: command.owner_node_id,
    owner_epoch: command.owner_epoch,
    admission_reservation_id: command.admission_reservation_id,
    media_reservation_id: command.media_reservation_id,
    expires_at: command.expires_at,
    command_sequence: command.command_sequence,
    idempotency_key: command.idempotency_key,
    payload_hash: command.payload_hash,
    command_hash: mediaControlCommandHash(command),
    payload: structuredClone(command.payload)
  });
}

describe('RustPBX media-control adapter', () => {
  it('keeps logical and effective SDP separate while preserving command identity', async () => {
    const client = new FakeClient();
    const adapter = new RustPbxMediaControlAdapter(client);

    const result = await adapter.prepare({
      ...identity(1, 'prepare-1'),
      logical_offer_sdp: 'v=0\r\na=sendrecv\r\n',
      media_profile_id: 'g711-relay-v1',
      from_tag: 'sip-from-tag-1',
      transport_hints: { address_family: 'ipv4' }
    });

    assert.equal(client.commands.length, 1);
    assert.equal(client.commands[0].command_id, 'prepare-1');
    assert.equal(client.commands[0].command_sequence, 1);
    assert.equal(
      client.commands[0].payload.offer_sdp,
      'v=0\r\na=sendrecv\r\n'
    );
    assert.equal(client.commands[0].payload.from_tag, 'sip-from-tag-1');
    assert.equal(result.logical_offer_sdp, 'v=0\r\na=sendrecv\r\n');
    assert.equal(
      result.effective_sdp,
      'v=0\r\na=ivekit-media-node:node-1\r\n'
    );
  });

  it('blocks later commands until an unknown command is reconciled', async () => {
    const client = new FakeClient();
    client.next = {
      protocol_version: 'ivekit.media-control.v1',
      result_class: 'unknown',
      command_id: 'prepare-1',
      error_code: 'media_control_timeout',
      retryable: true
    };
    const adapter = new RustPbxMediaControlAdapter(client);
    await adapter.prepare({
      ...identity(1, 'prepare-1'),
      logical_offer_sdp: 'v=0\r\n',
      media_profile_id: 'g711-relay-v1',
      from_tag: 'sip-from-tag-1'
    });

    await assert.rejects(
      adapter.commit({
        ...identity(2, 'commit-2'),
        answer_sdp: 'v=0\r\na=recvonly\r\n',
        from_tag: 'sip-from-tag-1',
        to_tag: 'sip-to-tag-1'
      }),
      (error: unknown) =>
        error instanceof MediaControlError &&
        error.code === 'command_reconciliation_required'
    );
    assert.equal(client.commands.length, 1);
    await assert.rejects(
      adapter.prepare({
        ...identity(1, 'prepare-1'),
        logical_offer_sdp: 'v=0\r\n',
        media_profile_id: 'g711-relay-v1',
        from_tag: 'sip-from-tag-1'
      }),
      (error: unknown) =>
        error instanceof MediaControlError &&
        error.code === 'command_reconciliation_required'
    );
    assert.equal(client.commands.length, 1);
  });

  it('reconciles the exact command and then permits the next command_sequence', async () => {
    const client = new FakeClient();
    client.next = {
      protocol_version: 'ivekit.media-control.v1',
      result_class: 'unknown',
      command_id: 'prepare-1',
      error_code: 'media_control_timeout',
      retryable: true
    };
    const adapter = new RustPbxMediaControlAdapter(client);
    await adapter.prepare({
      ...identity(1, 'prepare-1'),
      logical_offer_sdp: 'v=0\r\n',
      media_profile_id: 'g711-relay-v1',
      from_tag: 'sip-from-tag-1'
    });
    client.reconcileResult = success(client.commands[0]);

    const reconciled = await adapter.reconcile({
      media_reservation_id: 'reservation-1',
      call_id: 'call-1',
      owner_epoch: OWNER_EPOCH
    });
    client.next = undefined;
    const committed = await adapter.commit({
      ...identity(2, 'commit-2'),
      answer_sdp: 'v=0\r\na=recvonly\r\n',
      from_tag: 'sip-from-tag-1',
      to_tag: 'sip-to-tag-1'
    });

    assert.equal(reconciled.result.result_class, 'committed');
    assert.equal(client.reconciliations[0].command.command_id, 'prepare-1');
    assert.equal(committed.result.result_class, 'committed');
    assert.equal(client.commands[1].command_sequence, 2);
    assert.deepEqual(client.commands[1].payload, {
      answer_sdp: 'v=0\r\na=recvonly\r\n',
      from_tag: 'sip-from-tag-1',
      to_tag: 'sip-to-tag-1'
    });
  });

  it('maps early media, re-INVITE and hold updates without changing reservation', async () => {
    const client = new FakeClient();
    const adapter = new RustPbxMediaControlAdapter(client);

    await adapter.update({
      ...identity(2, 'early-2'),
      reason: 'early_media',
      answer_sdp: 'v=0\r\na=sendonly\r\n',
      from_tag: 'sip-from-tag-1',
      to_tag: 'sip-to-tag-early'
    });
    await adapter.update({
      ...identity(3, 'hold-3'),
      reason: 'hold',
      offer_sdp: 'v=0\r\na=inactive\r\n',
      from_tag: 'sip-from-tag-1',
      to_tag: 'sip-to-tag-1'
    });

    assert.deepEqual(client.commands.map((command) => command.action), [
      'update',
      'update'
    ]);
    assert.deepEqual(client.commands[0].payload, {
      from_tag: 'sip-from-tag-1',
      negotiation_role: 'answer',
      reason: 'early_media',
      sdp: 'v=0\r\na=sendonly\r\n',
      to_tag: 'sip-to-tag-early'
    });
    assert.equal(client.commands[1].payload.reason, 'hold');
    assert.equal(client.commands[1].media_reservation_id, 'reservation-1');
    assert.equal(transportRequest(client.commands[0]).command, 'answer');
    assert.equal(
      transportRequest(client.commands[0]).sdp,
      'v=0\r\na=sendonly\r\n'
    );
    assert.equal(transportRequest(client.commands[1]).command, 'offer');
  });

  it('allows read-only query while a mutation awaits reconciliation', async () => {
    const client = new FakeClient();
    client.next = {
      protocol_version: 'ivekit.media-control.v1',
      result_class: 'unknown',
      command_id: 'prepare-1',
      error_code: 'media_control_timeout',
      retryable: true
    };
    const adapter = new RustPbxMediaControlAdapter(client);
    await adapter.prepare({
      ...identity(1, 'prepare-1'),
      logical_offer_sdp: 'v=0\r\n',
      media_profile_id: 'g711-relay-v1',
      from_tag: 'sip-from-tag-1'
    });

    const queried = await adapter.query('reservation-1');

    assert.equal(queried.state, 'committed');
    assert.equal(client.commands.length, 1);
  });

  it('validates and maps DTMF, timeout delete and owner takeover', async () => {
    const client = new FakeClient();
    const adapter = new RustPbxMediaControlAdapter(client);

    await adapter.injectDtmf({
      ...identity(3, 'dtmf-3'),
      digit: 'A',
      duration_ms: 120,
      gap_ms: 100,
      volume: 10,
      from_tag: 'sip-from-tag-1',
      to_tag: 'sip-to-tag-1'
    });
    await adapter.expire({
      ...identity(4, 'expire-4'),
      from_tag: 'sip-from-tag-1',
      to_tag: 'sip-to-tag-1'
    });
    await adapter.takeover({
      ...identity(1, 'takeover-1'),
      owner_epoch: ((BigInt(OWNER_EPOCH) + 1n)).toString(),
      previous_owner_epoch: OWNER_EPOCH,
      negotiation_role: 'offer',
      sdp: 'v=0\r\na=sendrecv\r\n',
      from_tag: 'sip-from-tag-1',
      to_tag: 'sip-to-tag-1'
    });

    assert.deepEqual(client.commands[0].payload, {
      digit: 'A',
      duration: 120,
      from_tag: 'sip-from-tag-1',
      pause: 100,
      to_tag: 'sip-to-tag-1',
      volume: 10
    });
    assert.equal(client.commands[0].action, 'inject_dtmf');
    assert.equal(client.commands[1].action, 'delete');
    assert.equal(client.commands[1].payload.reason, 'media_timeout');
    assert.equal(client.commands[2].action, 'update');
    assert.equal(client.commands[2].payload.owner_takeover, true);
    assert.equal(client.commands[2].payload.previous_owner_epoch, OWNER_EPOCH);
    assert.equal(transportRequest(client.commands[0]).command, 'play DTMF');
    assert.equal(transportRequest(client.commands[0]).digit, 'A');
    assert.equal(transportRequest(client.commands[1]).command, 'delete');
    assert.equal(transportRequest(client.commands[2]).command, 'offer');

    await assert.rejects(
      adapter.injectDtmf({
        ...identity(5, 'dtmf-invalid'),
        digit: 'E',
        duration_ms: 120,
        gap_ms: 100,
        volume: 10,
        from_tag: 'sip-from-tag-1'
      }),
      /media_control_dtmf_invalid/
    );
  });

  it('serializes pending reconciliation for process restart recovery', async () => {
    const client = new FakeClient();
    client.next = {
      protocol_version: 'ivekit.media-control.v1',
      result_class: 'unknown',
      command_id: 'prepare-1',
      error_code: 'media_control_timeout',
      retryable: true
    };
    const adapter = new RustPbxMediaControlAdapter(client);
    await adapter.prepare({
      ...identity(1, 'prepare-1'),
      logical_offer_sdp: 'v=0\r\n',
      media_profile_id: 'g711-relay-v1',
      from_tag: 'sip-from-tag-1'
    });
    const pending = adapter.exportPendingReconciliations();
    const recoveredClient = new FakeClient();
    recoveredClient.reconcileResult = success(client.commands[0]);
    const recovered = new RustPbxMediaControlAdapter(recoveredClient, {
      pending_reconciliations: pending
    });

    const result = await recovered.reconcile({
      media_reservation_id: 'reservation-1',
      call_id: 'call-1',
      owner_epoch: OWNER_EPOCH
    });

    assert.equal(result.result.result_class, 'committed');
    assert.equal(
      recoveredClient.reconciliations[0].command.command_id,
      'prepare-1'
    );
    assert.deepEqual(recovered.exportPendingReconciliations(), []);
  });

  it('reserves bounded reconciliation capacity before transport execution', async () => {
    const client = new BlockingClient();
    const adapter = new RustPbxMediaControlAdapter(client, {
      max_pending_reconciliations: 1
    });
    const first = adapter.prepare({
      ...identity(1, 'prepare-1'),
      logical_offer_sdp: 'v=0\r\n',
      media_profile_id: 'g711-relay-v1',
      from_tag: 'sip-from-tag-1'
    });
    await client.started;

    await assert.rejects(
      adapter.prepare({
        ...identity(1, 'prepare-2'),
        call_id: 'call-2',
        leg_id: 'leg-2',
        media_reservation_id: 'reservation-2',
        logical_offer_sdp: 'v=0\r\n',
        media_profile_id: 'g711-relay-v1',
        from_tag: 'sip-from-tag-2'
      }),
      (error: unknown) =>
        error instanceof MediaControlError &&
        error.code === 'media_reconciliation_capacity_exhausted'
    );
    await assert.rejects(
      adapter.commit({
        ...identity(2, 'commit-2'),
        answer_sdp: 'v=0\r\na=sendrecv\r\n',
        from_tag: 'sip-from-tag-1',
        to_tag: 'sip-to-tag-1'
      }),
      (error: unknown) =>
        error instanceof MediaControlError &&
        error.code === 'media_command_in_flight'
    );
    assert.equal(client.commands.length, 1);
    client.release();
    assert.equal((await first).result.result_class, 'committed');
  });

  it('publishes a stable cross-language command identity vector', () => {
    assert.equal(
      rustPbxMediaCommandId({
        tenant_id: 'tenant-handle-1',
        call_id: 'call-1',
        leg_id: 'leg-1',
        owner_epoch: OWNER_EPOCH,
        command_sequence: 2,
        action: 'update',
        payload_hash:
          '387e38ec4b2ea79ba900c5bf52db3b0bc575aa25cfa8d0455175cc7b4a1b9cef'
      }),
      'cmd-cb8ce0ead2c63309ad7884c1e64dc9c33d886e5147ac247463a779d2fbe5b611'
    );
    assert.throws(
      () => rustPbxMediaCommandId({
        tenant_id: 'tenant-handle-1',
        call_id: 'call-1',
        leg_id: 'leg-1',
        owner_epoch: OWNER_EPOCH,
        command_sequence: 0,
        action: 'update',
        payload_hash: '0'.repeat(64)
      }),
      /media_control_command_identity_invalid/
    );
  });
});
