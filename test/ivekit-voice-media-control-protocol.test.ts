import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  checkedMediaControlCommand,
  checkedMediaControlReconcileInput,
  mediaControlCommandHash,
  type MediaControlCommand
} from '../src/agent-runtime/ivekit/media-control/protocol.js';

const schema = JSON.parse(
  readFileSync(
    'docs/capacity/schemas/voice-media-control-v1.schema.json',
    'utf8'
  )
) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value: string) => !Number.isNaN(Date.parse(value))
});
const validate = ajv.compile(schema);

const prepare: MediaControlCommand = {
  protocol_version: 'ivekit.media-control.v1',
  action: 'prepare',
  command_id: 'command-1',
  reservation_id: 'reservation-1',
  interaction_id: 'call-1',
  owner_epoch: ((1n << 32n) | 1n).toString(),
  sequence: 1,
  lease_expires_at: '2026-07-25T00:01:00.000Z',
  payload: {
    offer_sdp: 'v=0\r\n',
    media_profile_id: 'g711-relay-v1'
  }
};

describe('iveKit media control protocol v1', () => {
  it('validates command, reconciliation, and response documents', () => {
    const documents = [
      prepare,
      {
        protocol_version: 'ivekit.media-control.v1',
        action: 'commit',
        command_id: 'command-2',
        reservation_id: 'reservation-1',
        interaction_id: 'call-1',
        owner_epoch: prepare.owner_epoch,
        sequence: 2,
        lease_expires_at: prepare.lease_expires_at,
        payload: {}
      },
      {
        protocol_version: 'ivekit.media-control.v1',
        action: 'reconcile',
        command_id: 'command-1',
        reservation_id: 'reservation-1',
        interaction_id: 'call-1',
        owner_epoch: prepare.owner_epoch
      },
      {
        protocol_version: 'ivekit.media-control.v1',
        state: 'unknown',
        command_id: 'command-1',
        error_code: 'transport_timeout',
        retryable: true
      }
    ];

    for (const document of documents) {
      assert.equal(
        validate(document),
        true,
        ajv.errorsText(validate.errors)
      );
    }
  });

  it('rejects unversioned, malformed, oversized, and extended commands', () => {
    const invalid = [
      { ...prepare, protocol_version: 'v2' },
      { ...prepare, owner_epoch: '-1' },
      { ...prepare, command_id: 42 },
      { ...prepare, owner_epoch: 42 },
      { ...prepare, sequence: 0 },
      { ...prepare, lease_expires_at: 'tomorrow' },
      { ...prepare, lease_expires_at: '2026-07-25T00:01:00Z' },
      { ...prepare, extra: true },
      {
        ...prepare,
        payload: {
          offer_sdp: 'x'.repeat(16_385),
          media_profile_id: 'g711-relay-v1'
        }
      }
    ];

    for (const document of invalid) {
      assert.equal(validate(document), false);
    }
  });

  it('canonicalizes payload key order before hashing', () => {
    const reversed: MediaControlCommand = {
      ...prepare,
      payload: {
        media_profile_id: 'g711-relay-v1',
        offer_sdp: 'v=0\r\n'
      }
    };

    assert.equal(
      mediaControlCommandHash(prepare),
      mediaControlCommandHash(reversed)
    );
  });

  it('runtime validation enforces the same protocol and bounds', () => {
    assert.deepEqual(checkedMediaControlCommand(prepare), prepare);
    assert.throws(
      () => checkedMediaControlCommand({ ...prepare, sequence: 0 }),
      /media_control_sequence_invalid/
    );
    assert.throws(
      () => checkedMediaControlCommand({
        ...prepare,
        unexpected: true
      } as MediaControlCommand),
      /media_control_command_invalid/
    );
    assert.throws(
      () => checkedMediaControlCommand({
        ...prepare,
        payload: {
          offer_sdp: 'v=0\r\n',
          media_profile_id: 'g711-relay-v1',
          invalid: Number.NaN
        }
      }),
      /media_control_payload_invalid/
    );
    assert.throws(
      () => checkedMediaControlCommand({
        ...prepare,
        command_id: 42
      } as unknown as MediaControlCommand),
      /media_control_command_id_invalid/
    );
    assert.deepEqual(
      checkedMediaControlReconcileInput({
        protocol_version: 'ivekit.media-control.v1',
        action: 'reconcile',
        command_id: prepare.command_id,
        reservation_id: prepare.reservation_id,
        interaction_id: prepare.interaction_id,
        owner_epoch: prepare.owner_epoch
      }),
      {
        protocol_version: 'ivekit.media-control.v1',
        action: 'reconcile',
        command_id: prepare.command_id,
        reservation_id: prepare.reservation_id,
        interaction_id: prepare.interaction_id,
        owner_epoch: prepare.owner_epoch
      }
    );
  });
});
