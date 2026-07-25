import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaControlError } from '../src/agent-runtime/ivekit/media-control/agent.js';
import type {
  MediaControlCommand,
  MediaControlReconcileInput,
  MediaControlResult,
  MediaSessionSnapshot
} from '../src/agent-runtime/ivekit/media-control/protocol.js';
import {
  RustPbxMediaControlAdapter,
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

  async session(): Promise<MediaSessionSnapshot> {
    throw new Error('not used');
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

describe('RustPBX media-control adapter', () => {
  it('keeps logical and effective SDP separate while preserving command identity', async () => {
    const client = new FakeClient();
    const adapter = new RustPbxMediaControlAdapter(client);

    const result = await adapter.prepare({
      ...identity(1, 'prepare-1'),
      logical_offer_sdp: 'v=0\r\na=sendrecv\r\n',
      media_profile_id: 'g711-relay-v1',
      transport_hints: { address_family: 'ipv4' }
    });

    assert.equal(client.commands.length, 1);
    assert.equal(client.commands[0].command_id, 'prepare-1');
    assert.equal(client.commands[0].command_sequence, 1);
    assert.equal(
      client.commands[0].payload.offer_sdp,
      'v=0\r\na=sendrecv\r\n'
    );
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
      media_profile_id: 'g711-relay-v1'
    });

    await assert.rejects(
      adapter.commit(identity(2, 'commit-2')),
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
      media_profile_id: 'g711-relay-v1'
    });
    client.reconcileResult = success(client.commands[0]);

    const reconciled = await adapter.reconcile({
      media_reservation_id: 'reservation-1',
      call_id: 'call-1',
      owner_epoch: OWNER_EPOCH
    });
    client.next = undefined;
    const committed = await adapter.commit(identity(2, 'commit-2'));

    assert.equal(reconciled.result.result_class, 'committed');
    assert.equal(client.reconciliations[0].command.command_id, 'prepare-1');
    assert.equal(committed.result.result_class, 'committed');
    assert.equal(client.commands[1].command_sequence, 2);
  });
});
