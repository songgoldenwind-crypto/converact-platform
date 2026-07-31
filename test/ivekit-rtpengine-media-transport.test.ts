import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtemp,
  realpath,
  rm
} from 'node:fs/promises';
import net, { type AddressInfo, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  decodeBencodePrefix,
  encodeBencode,
  type BencodeDictionary
} from '../src/agent-runtime/ivekit/media-control/bencode.js';
import {
  MediaCommandJournal
} from '../src/agent-runtime/ivekit/media-control/journal.js';
import {
  RtpengineMediaTransport,
  rtpengineRequest
} from '../src/agent-runtime/ivekit/media-control/rtpengine.js';
import {
  RtpengineNgClient,
  rtpengineNgCookie
} from '../src/agent-runtime/ivekit/media-control/rtpengine-ng.js';
import type {
  MediaTransportCommand
} from '../src/agent-runtime/ivekit/media-control/transport.js';

const FENCE_KEYS = [
  'ivekit-owner-epoch',
  'ivekit-command-id',
  'ivekit-command-hash',
  'ivekit-command-sequence',
  'ivekit-reservation-id'
] as const;

describe('RTPengine MediaTransportPort', () => {
  it('preserves bounded RFC 3261 SIP tags without weakening internal identifiers', () => {
    const validTag = "Az09-.!%*_+`'~";
    const request = rtpengineRequest(command({
      action: 'answer',
      payload: {
        answer_sdp: logicalSdp('answer'),
        from_tag: validTag,
        to_tag: validTag
      }
    }));

    assert.equal(text(request['from-tag']), validTag);
    assert.equal(text(request['to-tag']), validTag);

    for (const invalidTag of [
      'tag with space',
      'tag:with-colon',
      'tag/with-slash',
      'tag\r\nwith-control',
      'x'.repeat(257)
    ]) {
      assert.throws(
        () => rtpengineRequest(command({
          action: 'answer',
          payload: {
            answer_sdp: logicalSdp('answer'),
            from_tag: invalidTag,
            to_tag: 'callee-tag'
          }
        })),
        /rtpengine_payload_invalid/
      );
    }
  });

  it('maps every media action to a real TCP NG request with exact fencing', async () => {
    await withFixture(async ({ fixture, transport }) => {
      const actions: Array<{
        action: MediaTransportCommand['action'];
        payload: Record<string, unknown>;
      }> = [
        {
          action: 'offer',
          payload: {
            offer_sdp: logicalSdp('offer'),
            from_tag: 'from-a',
            media_profile_id: 'profile-g711',
            direction: ['private', 'public']
          }
        },
        {
          action: 'answer',
          payload: {
            answer_sdp: logicalSdp('answer'),
            from_tag: 'from-a',
            to_tag: 'to-b',
            media_profile_id: 'profile-g711'
          }
        },
        {
          action: 'update',
          payload: {
            negotiation_role: 'offer',
            sdp: logicalSdp('update-offer'),
            from_tag: 'from-a',
            to_tag: 'to-b'
          }
        },
        {
          action: 'update',
          payload: {
            negotiation_role: 'answer',
            sdp: logicalSdp('update-answer'),
            from_tag: 'from-a',
            to_tag: 'to-b'
          }
        },
        { action: 'block_media', payload: { from_tag: 'from-a' } },
        { action: 'unblock_media', payload: { from_tag: 'from-a' } },
        { action: 'start_forward', payload: { from_tag: 'from-a' } },
        { action: 'stop_forward', payload: { from_tag: 'from-a' } },
        { action: 'start_recording_fork', payload: {} },
        { action: 'stop_recording_fork', payload: {} },
        {
          action: 'play_media',
          payload: {
            from_tag: 'from-a',
            file: '/prompts/notice.wav',
            repeat_times: 2,
            start_pos: 10
          }
        },
        { action: 'stop_media', payload: { from_tag: 'from-a' } },
        {
          action: 'inject_dtmf',
          payload: {
            from_tag: 'from-a',
            digit: '#',
            duration: 180,
            volume: 8,
            pause: 120
          }
        },
        { action: 'subscribe_quality', payload: {} },
        { action: 'query', payload: { from_tag: 'from-a', to_tag: 'to-b' } },
        { action: 'delete', payload: { from_tag: 'from-a', to_tag: 'to-b' } },
        { action: 'drain_node', payload: {} }
      ];

      const outcomes = [];
      for (const [index, item] of actions.entries()) {
        outcomes.push(await transport.execute(command({
          action: item.action,
          command_sequence: index + 1,
          command_id: `command-${index + 1}`,
          payload: item.payload,
          ...(index === 0 ? {} : { transport_session_id: 'call-a' })
        })));
      }

      assert.deepEqual(
        fixture.requests.map((request) => text(request.command)),
        [
          'offer',
          'ivekit replay ack',
          'answer',
          'ivekit replay ack',
          'offer',
          'ivekit replay ack',
          'answer',
          'ivekit replay ack',
          'block media',
          'unblock media',
          'start forwarding',
          'stop forwarding',
          'start recording',
          'stop recording',
          'play media',
          'stop media',
          'play DTMF',
          'query',
          'query',
          'delete',
          'ivekit drain'
        ]
      );
      assert.equal(
        text(fixture.requests[0]!['sdp']),
        logicalSdp('offer')
      );
      assert.equal(text(fixture.requests[0]!['from-tag']), 'from-a');
      assert.equal(text(fixture.requests[0]!['template']), 'profile-g711');
      assert.deepEqual(
        stringList(fixture.requests[0]!['direction']),
        ['private', 'public']
      );
      const commands = fixture.requests.filter(
        (request) => text(request.command) !== 'ivekit replay ack'
      );
      assert.equal(text(commands[1]!['to-tag']), 'to-b');
      assert.equal(text(commands[10]!['file']), '/prompts/notice.wav');
      assert.equal(commands[10]!['repeat-times'], 2);
      assert.equal(text(commands[12]!['digit']), '#');
      assert.equal(commands[12]!['duration'], 180);

      for (const [index, request] of commands.entries()) {
        assert.equal(text(request['ivekit-owner-epoch']), '1');
        assert.equal(
          text(request['ivekit-command-id']),
          `command-${index + 1}`
        );
        assert.equal(
          text(request['ivekit-reservation-id']),
          'reservation-a'
        );
      }
      const acknowledgements = fixture.requests.filter(
        (request) => text(request.command) === 'ivekit replay ack'
      );
      assert.deepEqual(
        acknowledgements.map(
          (request) => text(request['ivekit-ack-command-id'])
        ),
        ['command-1', 'command-2', 'command-3', 'command-4']
      );

      assert.equal(outcomes[0]!.state, 'succeeded');
      if (outcomes[0]!.state !== 'succeeded') assert.fail();
      assert.equal(outcomes[0]!.effective_sdp, effectiveSdp('offer'));
      assert.equal(
        actions[0]!.payload.offer_sdp,
        logicalSdp('offer')
      );
    });
  });

  it('rejects invalid SIP dialog payloads before writing to RTPengine', async () => {
    await withFixture(async ({ fixture, transport }) => {
      const invalid = [
        command({
          command_id: 'invalid-offer',
          command_hash: hash('command:invalid-offer'),
          action: 'offer',
          payload: {
            offer_sdp: logicalSdp('offer'),
            media_profile_id: 'profile-g711'
          }
        }),
        command({
          command_id: 'invalid-answer',
          command_hash: hash('command:invalid-answer'),
          command_sequence: 2,
          action: 'answer',
          payload: {
            answer_sdp: logicalSdp('answer'),
            from_tag: 'from-a'
          }
        }),
        command({
          command_id: 'invalid-update',
          command_hash: hash('command:invalid-update'),
          command_sequence: 3,
          action: 'update',
          payload: {
            negotiation_role: 'answer',
            sdp: logicalSdp('answer'),
            from_tag: 'from-a'
          }
        }),
        command({
          command_id: 'oversized-offer',
          command_hash: hash('command:oversized-offer'),
          command_sequence: 4,
          action: 'offer',
          payload: {
            offer_sdp: `${logicalSdp('oversized')}${'x'.repeat(16 * 1024)}`,
            from_tag: 'from-a',
            media_profile_id: 'profile-g711'
          }
        })
      ];

      for (const candidate of invalid) {
        const outcome = await transport.execute(candidate);
        assert.equal(outcome.state, 'failed');
        if (outcome.state !== 'failed') assert.fail();
        assert.equal(outcome.error_code, 'rtpengine_payload_invalid');
      }
      assert.equal(fixture.requests.length, 0);
    });
  });

  it('classifies a pre-write NG connection outage as retryable', async () => {
    const unavailable = net.createServer();
    unavailable.listen(0, '127.0.0.1');
    await once(unavailable, 'listening');
    const port = (unavailable.address() as AddressInfo).port;
    unavailable.close();
    await once(unavailable, 'close');
    const directory = await secureTemporaryDirectory();
    const journal = await MediaCommandJournal.open({
      path: path.join(directory, 'media-command.wal')
    });
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port,
      maxConnections: 1,
      maxInFlight: 4,
      requestTimeoutMs: 100,
      reconnectMinDelayMs: 1_000,
      reconnectMaxDelayMs: 1_000
    });
    const transport = await RtpengineMediaTransport.open({
      client,
      journal
    });
    try {
      const outcome = await transport.execute(command({
        command_id: 'connect-outage-offer',
        command_hash: hash('command:connect-outage-offer'),
        payload: {
          offer_sdp: logicalSdp('connect-outage'),
          from_tag: 'from-connect-outage',
          media_profile_id: 'profile-g711'
        }
      }));

      assert.equal(outcome.state, 'failed');
      if (outcome.state !== 'failed') assert.fail();
      assert.equal(outcome.error_code, 'rtpengine_ng_connect_failed');
      assert.equal(outcome.retryable, true);
    } finally {
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves the exact failed outcome across WAL restart', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    const invalid = command({
      command_id: 'persisted-invalid-offer',
      command_hash: hash('command:persisted-invalid-offer'),
      payload: {
        offer_sdp: logicalSdp('persisted-invalid'),
        media_profile_id: 'profile-g711'
      }
    });
    try {
      const first = await openTransport(fixture, journalPath);
      const rejected = await first.execute(invalid);
      assert.deepEqual(rejected, {
        state: 'failed',
        command_id: invalid.command_id,
        error_code: 'rtpengine_payload_invalid',
        retryable: false
      });
      await first.close();

      const recovered = await openTransport(fixture, journalPath);
      assert.deepEqual(await recovered.execute(invalid), rejected);
      assert.equal(fixture.requests.length, 0);
      await recovered.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts the exact SDP boundary and compensates unsafe applied responses', async () => {
    const exact = `v=0\r\n${'a'.repeat(256 * 1024 - 5)}`;
    await withFixture(async ({ fixture, transport }) => {
      const offered = command({
        command_id: 'exact-sdp-boundary',
        command_hash: hash('command:exact-sdp-boundary'),
        payload: {
          offer_sdp: logicalSdp('exact-boundary'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.respondWithSdp(offered.command_id, exact);
      const outcome = await transport.execute(offered);
      assert.equal(outcome.state, 'succeeded');
      if (outcome.state !== 'succeeded') assert.fail();
      assert.equal(Buffer.byteLength(outcome.effective_sdp), 256 * 1024);
    });

    for (const [commandId, unsafe] of [
      ['oversized-effective-sdp', `${exact}x`],
      ['nul-effective-sdp', 'v=0\r\n\0a=unsafe\r\n'],
      ['invalid-utf8-effective-sdp', Buffer.from([0x76, 0x3d, 0x30, 0xff])]
    ] as const) {
      const fixture = await NgFixture.start();
      const directory = await secureTemporaryDirectory();
      const journalPath = path.join(directory, 'media-command.wal');
      try {
        const transport = await openTransport(fixture, journalPath);
        const offered = command({
          command_id: commandId,
          command_hash: hash(`command:${commandId}`),
          payload: {
            offer_sdp: logicalSdp(commandId),
            from_tag: 'from-a',
            media_profile_id: 'profile-g711'
          }
        });
        fixture.respondWithSdp(offered.command_id, unsafe);
        const outcome = await transport.execute(offered);
        assert.deepEqual(outcome, {
          state: 'failed',
          command_id: offered.command_id,
          error_code: 'rtpengine_effective_sdp_invalid',
          retryable: false
        });
        assert.deepEqual(
          fixture.requests.map((request) => text(request.command)),
          ['offer', 'delete']
        );
        assert.equal(fixture.sideEffectCount(offered.command_id), 1);
        await transport.close();

        const recovered = await openTransport(fixture, journalPath);
        assert.deepEqual(await recovered.execute(offered), outcome);
        assert.deepEqual(
          fixture.requests.map((request) => text(request.command)),
          ['offer', 'delete']
        );
        await recovered.close();
      } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('recovers an applied invalid-SDP cleanup after its response is lost', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    try {
      const firstTransport = await openTransport(fixture, journalPath);
      const offered = command({
        command_id: 'invalid-sdp-cleanup-lost',
        command_hash: hash('command:invalid-sdp-cleanup-lost'),
        payload: {
          offer_sdp: logicalSdp('invalid-sdp-cleanup-lost'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.respondWithSdp(offered.command_id, 'v=0\r\n\0a=unsafe\r\n');
      const cleanupId = invalidSdpCleanupId(offered);
      fixture.dropResponseOnce(cleanupId);

      const first = await firstTransport.execute(offered);
      assert.equal(first.state, 'unknown');
      if (first.state !== 'unknown') assert.fail();
      assert.equal(
        first.error_code,
        'rtpengine_invalid_sdp_cleanup_unconfirmed'
      );
      assert.equal(fixture.sideEffectCount(cleanupId), 1);
      await firstTransport.close();

      const requestsBeforeRecovery = fixture.requests.length;
      const recoveredTransport = await openTransport(fixture, journalPath);
      const recovered = await recoveredTransport.queryCommand({
        command_id: offered.command_id,
        media_reservation_id: offered.media_reservation_id,
        owner_epoch: offered.owner_epoch,
        command_hash: offered.command_hash
      });
      assert.equal(recovered.found, true);
      if (!recovered.found) assert.fail();
      assert.deepEqual(recovered.outcome, {
        state: 'failed',
        command_id: offered.command_id,
        error_code: 'rtpengine_effective_sdp_invalid',
        retryable: false
      });
      assert.deepEqual(
        fixture.requests.slice(requestsBeforeRecovery).map(
          (request) => text(request.command)
        ),
        ['ivekit command status']
      );
      assert.equal(
        text(fixture.requests.at(-1)?.['ivekit-status-command-id']),
        cleanupId
      );
      assert.equal(fixture.sideEffectCount(cleanupId), 1);
      assert.equal((await recoveredTransport.querySession({
        media_reservation_id: offered.media_reservation_id,
        call_id: offered.call_id
      }))?.state, 'closed');
      await recoveredTransport.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists unknown outcomes and resolves them with the same stable cookie', async () => {
    await withFixture(async ({ fixture, transport }) => {
      const offered = command({
        action: 'offer',
        payload: {
          offer_sdp: logicalSdp('unknown'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.dropResponseOnce(offered.command_id);

      const first = await transport.execute(offered);
      assert.equal(first.state, 'unknown');
      const unresolved = await transport.queryCommand({
        command_id: offered.command_id,
        media_reservation_id: offered.media_reservation_id,
        owner_epoch: offered.owner_epoch,
        command_hash: offered.command_hash
      });
      assert.deepEqual(unresolved, { found: false });

      fixture.expireCookiesFor(offered.command_id);
      const requestsBeforeReplay = fixture.requests.length;
      const replay = await transport.execute(offered);
      assert.equal(replay.state, 'succeeded');
      if (replay.state !== 'succeeded') assert.fail();
      assert.equal(replay.effective_sdp, effectiveSdp('offer'));
      assert.equal(fixture.sideEffectCount(offered.command_id), 1);
      assert.deepEqual(
        fixture.requests.slice(requestsBeforeReplay).map(
          (request) => text(request.command)
        ),
        ['ivekit command status', 'ivekit replay ack']
      );
      assert.equal(
        fixture.cookiesFor(offered.command_id)[0],
        rtpengineNgCookie({
          command_id: offered.command_id,
          command_hash: offered.command_hash
        })
      );
      assert.equal(new Set(fixture.cookiesFor(offered.command_id)).size, 1);

      const resolved = await transport.queryCommand({
        command_id: offered.command_id,
        media_reservation_id: offered.media_reservation_id,
        owner_epoch: offered.owner_epoch,
        command_hash: offered.command_hash
      });
      assert.equal(resolved.found, true);
      if (!resolved.found) assert.fail();
      assert.equal(resolved.outcome.state, 'succeeded');
    });
  });

  it('never replays an uncertain non-idempotent command without guard proof', async () => {
    await withFixture(async ({ fixture, transport }) => {
      const offered = command({
        command_id: 'non-idempotent-offer',
        command_hash: hash('command:non-idempotent-offer'),
        payload: {
          offer_sdp: logicalSdp('non-idempotent'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      assert.equal((await transport.execute(offered)).state, 'succeeded');

      const dtmf = command({
        action: 'inject_dtmf',
        command_id: 'uncertain-dtmf',
        command_hash: hash('command:uncertain-dtmf'),
        command_sequence: 2,
        transport_session_id: offered.call_id,
        payload: {
          from_tag: 'from-a',
          digit: '5',
          duration: 180
        }
      });
      fixture.dropResponseOnce(dtmf.command_id);
      assert.equal((await transport.execute(dtmf)).state, 'unknown');

      fixture.expireCookiesFor(dtmf.command_id);
      fixture.expireFence(dtmf.call_id);
      const requestsBeforeRecovery = fixture.requests.length;
      const recovered = await transport.execute(dtmf);

      assert.equal(recovered.state, 'unknown');
      if (recovered.state !== 'unknown') assert.fail();
      assert.equal(recovered.error_code, 'rtpengine_command_status_unproven');
      assert.equal(fixture.sideEffectCount(dtmf.command_id), 1);
      assert.deepEqual(
        fixture.requests.slice(requestsBeforeRecovery).map(
          (request) => text(request.command)
        ),
        ['ivekit command status', 'query']
      );
    });
  });

  it('converges an unknown delete after its RTPengine tombstone expires', async () => {
    await withFixture(async ({ fixture, transport }) => {
      const offered = command({
        command_id: 'delete-offer',
        command_hash: hash('command:delete-offer'),
        payload: {
          offer_sdp: logicalSdp('delete'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      assert.equal((await transport.execute(offered)).state, 'succeeded');

      const deleted = command({
        action: 'delete',
        command_id: 'delete-after-offer',
        command_hash: hash('command:delete-after-offer'),
        command_sequence: 2,
        transport_session_id: offered.call_id,
        payload: { from_tag: 'from-a' }
      });
      fixture.dropResponseOnce(deleted.command_id);
      assert.equal((await transport.execute(deleted)).state, 'unknown');

      fixture.expireCookiesFor(deleted.command_id);
      fixture.expireFence(deleted.call_id);
      const replay = await transport.execute(deleted);
      assert.equal(replay.state, 'succeeded');
      if (replay.state !== 'succeeded') assert.fail();
      assert.equal(replay.session_state, 'closed');
      assert.equal(fixture.sideEffectCount(deleted.command_id), 1);
      assert.equal(
        text(fixture.requests.at(-1)?.command),
        'query'
      );
    });
  });

  it('recovers WAL sessions against RTPengine and closes missing calls', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    try {
      const first = await openTransport(fixture, journalPath);
      const offered = command({
        action: 'offer',
        payload: {
          offer_sdp: logicalSdp('restart'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      const outcome = await first.execute(offered);
      assert.equal(outcome.state, 'succeeded');
      await first.close();

      const recovered = await openTransport(fixture, journalPath);
      const active = await recovered.querySession({
        media_reservation_id: offered.media_reservation_id,
        call_id: offered.call_id
      });
      assert.equal(active?.state, 'prepared');
      assert.equal(active?.effective_sdp, effectiveSdp('offer'));
      await recovered.close();

      fixture.removeCall(offered.call_id);
      const missing = await openTransport(fixture, journalPath);
      const closed = await missing.querySession({
        media_reservation_id: offered.media_reservation_id,
        call_id: offered.call_id
      });
      assert.equal(closed?.state, 'closed');
      await missing.close();

      const journal = await MediaCommandJournal.open({ path: journalPath });
      const records = await journal.replay();
      assert.equal(records.at(-1)?.session_state, 'closed');
      assert.ok(records.at(-1)?.terminal_at);
      await journal.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('restores complete orphan candidates from the WAL after restart', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    try {
      const first = await openTransport(fixture, journalPath);
      const offered = command({
        action: 'offer',
        expires_at: '2026-07-26T08:05:00.000Z',
        payload: {
          offer_sdp: logicalSdp('orphan-restart'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      assert.equal((await first.execute(offered)).state, 'succeeded');
      await first.close();

      const recovered = await openTransport(fixture, journalPath);
      assert.deepEqual(await recovered.scanOrphanCandidates({
        after: '',
        limit: 1
      }), {
        items: [{
          tenant_id: offered.tenant_id,
          call_id: offered.call_id,
          leg_id: offered.leg_id,
          cell_id: offered.cell_id,
          owner_node_id: offered.owner_node_id,
          owner_epoch: offered.owner_epoch,
          media_reservation_id: offered.media_reservation_id,
          transport_session_id: offered.call_id,
          expires_at: offered.expires_at,
          state: 'prepared'
        }],
        next_cursor: offered.media_reservation_id
      });
      await recovered.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers an applied unknown initial offer after restart', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    try {
      const first = await openTransport(fixture, journalPath);
      const offered = command({
        action: 'offer',
        payload: {
          offer_sdp: logicalSdp('unknown-restart'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.dropResponseOnce(offered.command_id);
      assert.equal((await first.execute(offered)).state, 'unknown');
      await first.close();

      const requestsBeforeRestart = fixture.requests.length;
      const recovered = await openTransport(fixture, journalPath);
      const session = await recovered.querySession({
        media_reservation_id: offered.media_reservation_id,
        call_id: offered.call_id
      });
      assert.equal(session?.state, 'prepared');
      assert.equal(session?.effective_sdp, effectiveSdp('offer'));
      assert.deepEqual(
        fixture.requests.slice(requestsBeforeRestart).map(
          (request) => text(request.command)
        ),
        ['ivekit command status', 'ivekit replay ack']
      );

      fixture.expireCookiesFor(offered.command_id);
      const replay = await recovered.execute(offered);
      assert.equal(replay.state, 'succeeded');
      if (replay.state !== 'succeeded') assert.fail();
      assert.equal(replay.effective_sdp, effectiveSdp('offer'));
      assert.equal(fixture.sideEffectCount(offered.command_id), 1);
      await recovered.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retries rejected replay acknowledgements with bounded telemetry', async () => {
    await withFixture(async ({ fixture, transport }) => {
      const offered = command({
        command_id: 'ack-retry-offer',
        command_hash: hash('command:ack-retry-offer'),
        payload: {
          offer_sdp: logicalSdp('ack-retry'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.dropAckResponseOnce(offered.command_id);

      assert.equal((await transport.execute(offered)).state, 'succeeded');
      assert.equal(transport.replayAckMetrics().failed_total, 1);
      await waitFor(() => fixture.ackCount(offered.command_id) >= 2);

      assert.deepEqual(transport.replayAckMetrics(), {
        pending: 0,
        failed_total: 1,
        succeeded_total: 1,
        escalated_total: 0,
        abandoned_total: 0
      });
      assert.equal(fixture.sideEffectCount(offered.command_id), 1);
    });
  });

  it('recovers pending replay acknowledgement from the WAL after restart', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    const ackOptions = {
      replayAckRetryBaseMs: 10_000,
      replayAckRetryMaxMs: 10_000
    };
    try {
      const first = await openTransport(fixture, journalPath, ackOptions);
      const offered = command({
        command_id: 'ack-restart-offer',
        command_hash: hash('command:ack-restart-offer'),
        payload: {
          offer_sdp: logicalSdp('ack-restart'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.dropAckResponseOnce(offered.command_id);
      assert.equal((await first.execute(offered)).state, 'succeeded');
      assert.equal(first.replayAckMetrics().pending, 1);
      await first.close();

      const recovered = await openTransport(fixture, journalPath, ackOptions);
      assert.equal(fixture.ackCount(offered.command_id), 2);
      assert.equal(recovered.replayAckMetrics().pending, 0);
      assert.equal(recovered.replayAckMetrics().succeeded_total, 1);
      assert.equal(recovered.replayAckMetrics().escalated_total, 0);
      await recovered.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers the latest applied negotiation ACK when a later command failed', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    const ackOptions = {
      replayAckRetryBaseMs: 10_000,
      replayAckRetryMaxMs: 10_000
    };
    try {
      const first = await openTransport(fixture, journalPath, ackOptions);
      const offered = command({
        command_id: 'ack-before-failure-offer',
        command_hash: hash('command:ack-before-failure-offer'),
        payload: {
          offer_sdp: logicalSdp('ack-before-failure'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.dropAckResponseOnce(offered.command_id);
      assert.equal((await first.execute(offered)).state, 'succeeded');
      assert.equal(first.replayAckMetrics().pending, 1);

      const invalidAnswer = command({
        action: 'answer',
        command_id: 'failed-after-ack-offer',
        command_hash: hash('command:failed-after-ack-offer'),
        command_sequence: 2,
        transport_session_id: offered.call_id,
        payload: {
          answer_sdp: logicalSdp('invalid-answer'),
          from_tag: 'from-a'
        }
      });
      assert.equal((await first.execute(invalidAnswer)).state, 'failed');
      await first.close();

      const recovered = await openTransport(fixture, journalPath, ackOptions);
      assert.equal(fixture.ackCount(offered.command_id), 2);
      assert.equal(recovered.replayAckMetrics().pending, 0);
      await recovered.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers a newer unknown negotiation before acknowledging replay state', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    try {
      const first = await openTransport(fixture, journalPath);
      const offered = command({
        command_id: 'unknown-answer-offer',
        command_hash: hash('command:unknown-answer-offer'),
        payload: {
          offer_sdp: logicalSdp('unknown-answer-offer'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      assert.equal((await first.execute(offered)).state, 'succeeded');

      const answered = command({
        action: 'answer',
        command_id: 'unknown-answer',
        command_hash: hash('command:unknown-answer'),
        command_sequence: 2,
        transport_session_id: offered.call_id,
        payload: {
          answer_sdp: logicalSdp('unknown-answer'),
          from_tag: 'from-a',
          to_tag: 'to-b'
        }
      });
      fixture.dropResponseOnce(answered.command_id);
      assert.equal((await first.execute(answered)).state, 'unknown');
      await first.close();

      const requestsBeforeRestart = fixture.requests.length;
      const recovered = await openTransport(fixture, journalPath);
      const restartRequests = fixture.requests.slice(requestsBeforeRestart);
      assert.equal(
        text(restartRequests[0]?.command),
        'ivekit command status'
      );
      assert.equal(
        text(restartRequests[0]?.['ivekit-status-command-id']),
        answered.command_id
      );
      assert.ok(
        restartRequests.some(
          (request) =>
            text(request.command) === 'ivekit replay ack' &&
            text(request['ivekit-ack-command-id']) === answered.command_id
        )
      );
      assert.equal(fixture.ackCount(answered.command_id), 1);
      assert.equal((await recovered.querySession({
        media_reservation_id: answered.media_reservation_id,
        call_id: answered.call_id
      }))?.state, 'committed');
      await recovered.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers the higher owner epoch before an older high sequence', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    try {
      const first = await openTransport(fixture, journalPath);
      const oldOwner = command({
        command_id: 'old-owner-unknown',
        command_hash: hash('command:old-owner-unknown'),
        owner_epoch: '1',
        command_sequence: 20,
        payload: {
          offer_sdp: logicalSdp('old-owner-unknown'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.dropResponseOnce(oldOwner.command_id);
      assert.equal((await first.execute(oldOwner)).state, 'unknown');

      const newOwner = command({
        command_id: 'new-owner-unknown',
        command_hash: hash('command:new-owner-unknown'),
        owner_epoch: '2',
        command_sequence: 1,
        payload: {
          offer_sdp: logicalSdp('new-owner-unknown'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.dropResponseOnce(newOwner.command_id);
      assert.equal((await first.execute(newOwner)).state, 'unknown');
      await first.close();

      const requestsBeforeRestart = fixture.requests.length;
      const recovered = await openTransport(fixture, journalPath);
      const firstRestartRequest = fixture.requests[requestsBeforeRestart];
      assert.equal(
        text(firstRestartRequest?.command),
        'ivekit command status'
      );
      assert.equal(
        text(firstRestartRequest?.['ivekit-status-command-id']),
        newOwner.command_id
      );
      assert.equal((await recovered.querySession({
        media_reservation_id: newOwner.media_reservation_id,
        call_id: newOwner.call_id
      }))?.owner_epoch, '2');
      assert.equal(fixture.ackCount(newOwner.command_id), 1);
      await recovered.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('acknowledges the higher owner epoch before an older high sequence', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    const ackOptions = {
      replayAckRetryBaseMs: 10_000,
      replayAckRetryMaxMs: 10_000
    };
    try {
      const first = await openTransport(fixture, journalPath, ackOptions);
      const oldOwner = command({
        command_id: 'old-owner-applied',
        command_hash: hash('command:old-owner-applied'),
        owner_epoch: '1',
        command_sequence: 20,
        payload: {
          offer_sdp: logicalSdp('old-owner-applied'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.dropAckResponseOnce(oldOwner.command_id);
      assert.equal((await first.execute(oldOwner)).state, 'succeeded');

      const newOwner = command({
        command_id: 'new-owner-applied',
        command_hash: hash('command:new-owner-applied'),
        owner_epoch: '2',
        command_sequence: 1,
        payload: {
          offer_sdp: logicalSdp('new-owner-applied'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.dropAckResponseOnce(newOwner.command_id);
      assert.equal((await first.execute(newOwner)).state, 'succeeded');
      await first.close();

      const requestsBeforeRestart = fixture.requests.length;
      const recovered = await openTransport(
        fixture,
        journalPath,
        ackOptions
      );
      const firstRestartRequest = fixture.requests[requestsBeforeRestart];
      assert.equal(
        text(firstRestartRequest?.command),
        'ivekit command status'
      );
      assert.equal(
        text(firstRestartRequest?.['ivekit-status-command-id']),
        newOwner.command_id
      );
      assert.equal(fixture.ackCount(oldOwner.command_id), 1);
      assert.equal(fixture.ackCount(newOwner.command_id), 2);
      assert.equal(recovered.replayAckMetrics().pending, 0);
      await recovered.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a bounded low-frequency ACK retry after the fast retry budget', async () => {
    await withFixture(async ({ fixture, transport }) => {
      const offered = command({
        command_id: 'ack-escalated-offer',
        command_hash: hash('command:ack-escalated-offer'),
        payload: {
          offer_sdp: logicalSdp('ack-escalated'),
          from_tag: 'from-a',
          media_profile_id: 'profile-g711'
        }
      });
      fixture.rejectAckFor(offered.command_id);

      assert.equal((await transport.execute(offered)).state, 'succeeded');
      await waitFor(() => {
        const metrics = transport.replayAckMetrics();
        return metrics.escalated_total === 1 &&
          metrics.failed_total >= 3 &&
          metrics.failed_total === fixture.ackCount(offered.command_id);
      });
      const metrics = transport.replayAckMetrics();
      assert.equal(metrics.pending, 1);
      assert.ok(metrics.failed_total >= 3);
      assert.equal(
        metrics.failed_total,
        fixture.ackCount(offered.command_id)
      );
      assert.equal(metrics.succeeded_total, 0);
      assert.equal(metrics.escalated_total, 1);
      assert.equal(metrics.abandoned_total, 0);
    }, {
      replayAckRetryBaseMs: 1,
      replayAckRetryMaxMs: 10,
      replayAckMaxAttempts: 2
    });
  });

  it('filters expired terminal WAL sessions before rebuilding bounded indexes', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    let now = Date.parse('2026-07-26T08:00:00.000Z');
    try {
      const first = await openTransport(fixture, journalPath, {
        now: () => new Date(now),
        maxSessions: 2,
        maxCommands: 8,
        terminalRetentionMs: 1_000
      });
      for (let index = 1; index <= 2; index += 1) {
        const offered = command({
          command_id: `restart-terminal-offer-${index}`,
          command_hash: hash(`command:restart-terminal-offer-${index}`),
          call_id: `restart-terminal-call-${index}`,
          media_reservation_id: `restart-terminal-reservation-${index}`,
          payload: {
            offer_sdp: logicalSdp(`restart-terminal-${index}`),
            from_tag: `from-${index}`,
            media_profile_id: 'profile-g711'
          }
        });
        assert.equal((await first.execute(offered)).state, 'succeeded');
        assert.equal((await first.execute(command({
          action: 'delete',
          command_id: `restart-terminal-delete-${index}`,
          command_hash: hash(`command:restart-terminal-delete-${index}`),
          call_id: offered.call_id,
          media_reservation_id: offered.media_reservation_id,
          command_sequence: 2,
          transport_session_id: offered.call_id,
          payload: { from_tag: `from-${index}` }
        }))).state, 'succeeded');
      }
      await first.close();

      now += 2_000;
      const recovered = await openTransport(fixture, journalPath, {
        now: () => new Date(now),
        maxSessions: 1,
        maxCommands: 2,
        terminalRetentionMs: 1_000
      });
      assert.deepEqual(recovered.runtimeMetrics(), {
        commands: 0,
        sessions: 0,
        transport_session_index: 0,
        quality_snapshots: 0,
        journal_compaction_failures_total: 0,
        command_limit: 2,
        session_limit: 1
      });
      await recovered.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds runtime maps and releases sessions by the persisted dialog tag', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    let now = Date.parse('2026-07-26T08:00:00.000Z');
    try {
      const transport = await openTransport(fixture, journalPath, {
        now: () => new Date(now),
        maxSessions: 2,
        maxCommands: 4,
        terminalRetentionMs: 1_000
      });
      for (let index = 1; index <= 2; index += 1) {
        const offered = command({
          command_id: `bounded-offer-${index}`,
          command_hash: hash(`command:bounded-offer-${index}`),
          call_id: `bounded-call-${index}`,
          media_reservation_id: `bounded-reservation-${index}`,
          payload: {
            offer_sdp: logicalSdp(`bounded-${index}`),
            from_tag: `from-${index}`,
            media_profile_id: 'profile-g711'
          }
        });
        assert.equal((await transport.execute(offered)).state, 'succeeded');
        assert.equal((await transport.execute(command({
          action: 'delete',
          command_id: `bounded-delete-${index}`,
          command_hash: hash(`command:bounded-delete-${index}`),
          call_id: offered.call_id,
          media_reservation_id: offered.media_reservation_id,
          command_sequence: 2,
          transport_session_id: offered.call_id,
          payload: { from_tag: `from-${index}` }
        }))).state, 'succeeded');
      }
      assert.deepEqual(transport.runtimeMetrics(), {
        commands: 4,
        sessions: 2,
        transport_session_index: 2,
        quality_snapshots: 0,
        journal_compaction_failures_total: 0,
        command_limit: 4,
        session_limit: 2
      });

      now += 2_000;
      const third = command({
        command_id: 'bounded-offer-3',
        command_hash: hash('command:bounded-offer-3'),
        call_id: 'bounded-call-3',
        media_reservation_id: 'bounded-reservation-3',
        payload: {
          offer_sdp: logicalSdp('bounded-3'),
          from_tag: 'from-3',
          media_profile_id: 'profile-g711'
        }
      });
      assert.equal((await transport.execute(third)).state, 'succeeded');
      assert.equal(transport.runtimeMetrics().commands, 1);
      assert.equal(transport.runtimeMetrics().sessions, 1);

      const requestsBeforeRelease = fixture.requests.length;
      await transport.releaseSession(third.call_id, 'bounded_release');
      assert.deepEqual(
        fixture.requests.slice(requestsBeforeRelease).map(
          (request) => text(request.command)
        ),
        ['delete']
      );
      assert.equal(
        text(fixture.requests.at(-1)?.['from-tag']),
        'from-3'
      );
      assert.equal((await transport.querySession({
        media_reservation_id: third.media_reservation_id,
        call_id: third.call_id
      }))?.state, 'closed');
      await transport.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retries a failed runtime compaction before the next WAL append', async () => {
    const fixture = await NgFixture.start();
    const directory = await secureTemporaryDirectory();
    const journalPath = path.join(directory, 'media-command.wal');
    let now = Date.parse('2026-07-26T08:00:00.000Z');
    const journal = await MediaCommandJournal.open({
      path: journalPath,
      maxRecords: 2,
      terminalRetentionMs: 1_000
    });
    const compact = journal.compact.bind(journal);
    let compactCalls = 0;
    journal.compact = async (at) => {
      compactCalls += 1;
      if (compactCalls === 2) {
        throw new Error('controlled runtime compaction failure');
      }
      return compact(at);
    };
    try {
      const transport = await openTransport(fixture, journalPath, {
        journal,
        now: () => new Date(now),
        maxSessions: 1,
        maxCommands: 2,
        terminalRetentionMs: 1_000,
        journalCompactionRetryBaseMs: 10_000,
        journalCompactionRetryMaxMs: 10_000
      });
      const first = command({
        command_id: 'compact-retry-offer-1',
        command_hash: hash('command:compact-retry-offer-1'),
        call_id: 'compact-retry-call-1',
        media_reservation_id: 'compact-retry-reservation-1',
        payload: {
          offer_sdp: logicalSdp('compact-retry-1'),
          from_tag: 'from-1',
          media_profile_id: 'profile-g711'
        }
      });
      assert.equal((await transport.execute(first)).state, 'succeeded');
      assert.equal((await transport.execute(command({
        action: 'delete',
        command_id: 'compact-retry-delete-1',
        command_hash: hash('command:compact-retry-delete-1'),
        call_id: first.call_id,
        media_reservation_id: first.media_reservation_id,
        command_sequence: 2,
        transport_session_id: first.call_id,
        payload: { from_tag: 'from-1' }
      }))).state, 'succeeded');

      now += 2_000;
      const second = command({
        command_id: 'compact-retry-offer-2',
        command_hash: hash('command:compact-retry-offer-2'),
        call_id: 'compact-retry-call-2',
        media_reservation_id: 'compact-retry-reservation-2',
        payload: {
          offer_sdp: logicalSdp('compact-retry-2'),
          from_tag: 'from-2',
          media_profile_id: 'profile-g711'
        }
      });
      assert.equal((await transport.execute(second)).state, 'succeeded');
      assert.equal(compactCalls, 3);
      assert.equal(
        transport.runtimeMetrics().journal_compaction_failures_total,
        1
      );
      await transport.close();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function withFixture(
  run: (input: {
    fixture: NgFixture;
    transport: RtpengineMediaTransport;
  }) => Promise<void>,
  options: Parameters<typeof openTransport>[2] = {}
): Promise<void> {
  const fixture = await NgFixture.start();
  const directory = await secureTemporaryDirectory();
  try {
    const transport = await openTransport(
      fixture,
      path.join(directory, 'media-command.wal'),
      options
    );
    try {
      await run({ fixture, transport });
    } finally {
      await transport.close();
    }
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function openTransport(
  fixture: NgFixture,
  journalPath: string,
  options: {
    journal?: MediaCommandJournal;
    now?: () => Date;
    replayAckRetryBaseMs?: number;
    replayAckRetryMaxMs?: number;
    replayAckMaxAttempts?: number;
    journalCompactionRetryBaseMs?: number;
    journalCompactionRetryMaxMs?: number;
    maxSessions?: number;
    maxCommands?: number;
    terminalRetentionMs?: number;
  } = {}
): Promise<RtpengineMediaTransport> {
  const journal = options.journal ?? await MediaCommandJournal.open({
    path: journalPath,
    ...(options.terminalRetentionMs !== undefined
      ? { terminalRetentionMs: options.terminalRetentionMs }
      : {})
  });
  const {
    journal: _journal,
    ...transportOptions
  } = options;
  const client = new RtpengineNgClient({
    host: '127.0.0.1',
    port: fixture.port,
    maxConnections: 2,
    maxInFlight: 64,
    requestTimeoutMs: 100,
    reconnectMinDelayMs: 0,
    reconnectMaxDelayMs: 0,
    random: () => 0
  });
  try {
    return await RtpengineMediaTransport.open({
      client,
      journal,
      now: () => new Date('2026-07-26T08:00:00.000Z'),
      recoveryConcurrency: 4,
      replayAckRetryBaseMs: 10,
      replayAckRetryMaxMs: 100,
      ...transportOptions
    });
  } catch (error) {
    await client.close();
    await journal.close();
    throw error;
  }
}

function command(
  overrides: Partial<MediaTransportCommand> = {}
): MediaTransportCommand {
  const commandId = overrides.command_id ?? 'command-1';
  return {
    action: 'offer',
    command_id: commandId,
    tenant_id: 'tenant-a',
    call_id: 'call-a',
    leg_id: 'leg-a',
    cell_id: 'cell-a',
    owner_node_id: 'node-a',
    owner_epoch: '1',
    media_reservation_id: 'reservation-a',
    expires_at: '2026-07-26T08:05:00.000Z',
    command_sequence: 1,
    idempotency_key: `idempotency-${commandId}`,
    payload_hash: hash(`payload:${commandId}`),
    command_hash: hash(`command:${commandId}`),
    payload: {},
    ...overrides
  };
}

function logicalSdp(marker: string): string {
  return [
    'v=0',
    `o=- 1 1 IN IP4 192.0.2.${marker.length + 10}`,
    's=-',
    'c=IN IP4 192.0.2.10',
    't=0 0',
    'm=audio 4000 RTP/AVP 0',
    `a=x-logical:${marker}`,
    ''
  ].join('\r\n');
}

function effectiveSdp(commandName: string): string {
  return [
    'v=0',
    'o=- 2 2 IN IP4 198.51.100.20',
    's=-',
    'c=IN IP4 198.51.100.20',
    't=0 0',
    'm=audio 30000 RTP/AVP 0',
    `a=x-effective:${commandName}`,
    ''
  ].join('\r\n');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidSdpCleanupId(command: MediaTransportCommand): string {
  return `invalid-sdp-${hash([
    command.media_reservation_id,
    command.owner_epoch,
    command.command_id,
    command.command_hash
  ].join('\0')).slice(0, 48)}`;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }
  return '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text) : [];
}

async function secureTemporaryDirectory(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), 'ivekit-rtpe-port-'));
  return realpath(created);
}

class NgFixture {
  readonly requests: BencodeDictionary[] = [];
  readonly #server: net.Server;
  readonly #sockets = new Set<Socket>();
  readonly #responses = new Map<string, BencodeDictionary>();
  readonly #dropOnce = new Set<string>();
  readonly #dropped = new Set<string>();
  readonly #dropAckOnce = new Set<string>();
  readonly #droppedAck = new Set<string>();
  readonly #rejectedAcks = new Set<string>();
  readonly #ackCounts = new Map<string, number>();
  readonly #sideEffects = new Map<string, number>();
  readonly #cookies = new Map<string, string[]>();
  readonly #calls = new Set<string>();
  readonly #fences = new Map<string, FenceState>();
  readonly #effectiveSdpByCommand = new Map<string, string | Buffer>();
  readonly port: number;

  private constructor(server: net.Server, port: number) {
    this.#server = server;
    this.port = port;
  }

  static async start(): Promise<NgFixture> {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const fixture = new NgFixture(
      server,
      (server.address() as AddressInfo).port
    );
    server.on('connection', (socket) => fixture.#accept(socket));
    return fixture;
  }

  dropResponseOnce(commandId: string): void {
    this.#dropOnce.add(commandId);
  }

  dropAckResponseOnce(commandId: string): void {
    this.#dropAckOnce.add(commandId);
  }

  rejectAckFor(commandId: string): void {
    this.#rejectedAcks.add(commandId);
  }

  ackCount(commandId: string): number {
    return this.#ackCounts.get(commandId) ?? 0;
  }

  respondWithSdp(commandId: string, value: string | Buffer): void {
    this.#effectiveSdpByCommand.set(commandId, value);
  }

  sideEffectCount(commandId: string): number {
    return this.#sideEffects.get(commandId) ?? 0;
  }

  cookiesFor(commandId: string): string[] {
    return [...(this.#cookies.get(commandId) ?? [])];
  }

  expireCookiesFor(commandId: string): void {
    for (const cookie of this.#cookies.get(commandId) ?? []) {
      this.#responses.delete(cookie);
    }
  }

  expireFence(callId: string): void {
    this.#fences.delete(callId);
  }

  removeCall(callId: string): void {
    this.#calls.delete(callId);
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#server.close();
    await once(this.#server, 'close');
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    collectFrames(socket, (cookie, request) => {
      void this.#respond(socket, cookie, request);
    });
  }

  async #respond(
    socket: Socket,
    cookie: string,
    request: BencodeDictionary
  ): Promise<void> {
    this.requests.push(request);
    const ackCommandId = text(request['ivekit-ack-command-id']);
    if (text(request.command) === 'ivekit replay ack' && ackCommandId) {
      this.#ackCounts.set(
        ackCommandId,
        (this.#ackCounts.get(ackCommandId) ?? 0) + 1
      );
      if (this.#dropAckOnce.has(ackCommandId) &&
          !this.#droppedAck.has(ackCommandId)) {
        this.#droppedAck.add(ackCommandId);
        socket.destroy();
        return;
      }
      if (this.#rejectedAcks.has(ackCommandId)) {
        socket.write(frame(cookie, {
          result: 'error',
          'error-reason': 'controlled replay ACK rejection'
        }));
        return;
      }
    }
    const commandId = text(request['ivekit-command-id']);
    if (commandId) {
      const cookies = this.#cookies.get(commandId) ?? [];
      cookies.push(cookie);
      this.#cookies.set(commandId, cookies);
    }
    const cached = this.#responses.get(cookie);
    if (cached) {
      socket.write(frame(cookie, cached));
      return;
    }

    const replay = this.#fencedReplay(request);
    if (replay) {
      this.#responses.set(cookie, replay);
      socket.write(frame(cookie, replay));
      return;
    }
    const response = this.#apply(request);
    this.#captureFence(request, response);
    this.#responses.set(cookie, response);
    if (commandId) {
      this.#sideEffects.set(
        commandId,
        (this.#sideEffects.get(commandId) ?? 0) + 1
      );
    }
    if (commandId &&
        this.#dropOnce.has(commandId) &&
        !this.#dropped.has(commandId)) {
      this.#dropped.add(commandId);
      socket.destroy();
      return;
    }
    socket.write(frame(cookie, response));
  }

  #fencedReplay(
    request: BencodeDictionary
  ): BencodeDictionary | undefined {
    const callId = text(request['call-id']);
    const current = this.#fences.get(callId);
    if (!current ||
        current.command_id !== text(request['ivekit-command-id']) ||
        current.command_hash !== text(request['ivekit-command-hash']) ||
        current.command_sequence !==
          Number(text(request['ivekit-command-sequence']))) {
      return undefined;
    }
    const response: BencodeDictionary = {
      result: 'error',
      'error-reason': 'ivekit command already applied',
      'ivekit-command-replayed': 1
    };
    for (const key of FENCE_KEYS) response[key] = request[key]!;
    if (current.invalid_effective_sdp) {
      response['ivekit-command-result'] = 'invalid_effective_sdp';
    }
    if (current.effective_sdp) response.sdp = current.effective_sdp;
    return response;
  }

  #captureFence(
    request: BencodeDictionary,
    response: BencodeDictionary
  ): void {
    const commandId = text(request['ivekit-command-id']);
    if (!commandId || text(response.result) !== 'ok') return;
    const responseSdp = response.sdp;
    const invalidEffectiveSdp =
      (text(request.command) === 'offer' ||
        text(request.command) === 'answer') &&
      !validFixtureSdp(responseSdp);
    if (invalidEffectiveSdp) {
      response['ivekit-command-result'] = 'invalid_effective_sdp';
    }
    this.#fences.set(text(request['call-id']), {
      owner_epoch: text(request['ivekit-owner-epoch']),
      reservation_id: text(request['ivekit-reservation-id']),
      command_id: commandId,
      command_hash: text(request['ivekit-command-hash']),
      command_sequence: Number(text(request['ivekit-command-sequence'])),
      effective_sdp: invalidEffectiveSdp ? '' : text(responseSdp),
      invalid_effective_sdp: invalidEffectiveSdp
    });
  }

  #apply(request: BencodeDictionary): BencodeDictionary {
    const commandName = text(request.command);
    const callId = text(request['call-id']);
    if (commandName === 'ivekit command status') {
      const current = this.#fences.get(callId);
      const ownerEpoch = text(request['ivekit-status-owner-epoch']);
      const commandId = text(request['ivekit-status-command-id']);
      const commandHash = text(request['ivekit-status-command-hash']);
      const commandSequence = Number(
        text(request['ivekit-status-command-sequence'])
      );
      const reservationId = text(request['ivekit-status-reservation-id']);
      if (!current) {
        return {
          result: 'ok',
          'ivekit-command-status': 'unseen',
          'ivekit-guard-entry-found': 0
        };
      }
      if (current.owner_epoch === ownerEpoch &&
          current.reservation_id === reservationId &&
          current.command_id === commandId &&
          current.command_hash === commandHash &&
          current.command_sequence === commandSequence) {
        return {
          result: 'ok',
          'ivekit-command-status': 'applied',
          'ivekit-guard-entry-found': 1,
          'ivekit-owner-epoch': current.owner_epoch,
          'ivekit-command-id': current.command_id,
          'ivekit-command-hash': current.command_hash,
          'ivekit-command-sequence': current.command_sequence,
          'ivekit-reservation-id': current.reservation_id,
          'ivekit-command-replayed': 1,
          ...(current.invalid_effective_sdp
            ? { 'ivekit-command-result': 'invalid_effective_sdp' }
            : {}),
          ...(current.effective_sdp
            ? { sdp: current.effective_sdp }
            : {})
        };
      }
      const exactNext = current.owner_epoch === ownerEpoch &&
        current.reservation_id === reservationId &&
        commandSequence === current.command_sequence + 1 &&
        current.command_id !== commandId;
      const newOwner = BigInt(ownerEpoch) > BigInt(current.owner_epoch) &&
        commandSequence === 1;
      return {
        result: 'ok',
        'ivekit-command-status': exactNext || newOwner
          ? 'unseen'
          : 'conflict',
        'ivekit-guard-entry-found': 1
      };
    }
    if (commandName === 'ivekit replay ack') {
      const current = this.#fences.get(callId);
      let acknowledged = 0;
      if (current &&
          current.command_id === text(request['ivekit-ack-command-id']) &&
          current.command_hash === text(request['ivekit-ack-command-hash'])) {
        current.effective_sdp = '';
        acknowledged = 1;
      }
      return {
        result: 'ok',
        'ivekit-replay-acknowledged': acknowledged
      };
    }
    if (commandName === 'query' && !this.#calls.has(callId)) {
      return {
        result: 'error',
        'error-reason': 'Unknown call-id'
      };
    }
    if (commandName === 'offer') this.#calls.add(callId);
    if (commandName === 'delete') this.#calls.delete(callId);

    const response: BencodeDictionary = { result: 'ok' };
    if (commandName === 'offer' || commandName === 'answer') {
      response.sdp = this.#effectiveSdpByCommand.get(
        text(request['ivekit-command-id'])
      ) ?? effectiveSdp(commandName);
    }
    if (commandName === 'query') {
      response.tags = {
        'from-a': {
          tag: 'from-a',
          'in dialogue with': 'to-b',
          medias: []
        },
        'to-b': {
          tag: 'to-b',
          'in dialogue with': 'from-a',
          medias: []
        }
      };
    }
    for (const key of FENCE_KEYS) {
      if (request[key] !== undefined) response[key] = request[key]!;
    }
    if (request['ivekit-command-id'] !== undefined) {
      response['ivekit-command-replayed'] = 0;
    }
    return response;
  }
}

interface FenceState {
  owner_epoch: string;
  reservation_id: string;
  command_id: string;
  command_hash: string;
  command_sequence: number;
  effective_sdp: string;
  invalid_effective_sdp: boolean;
}

function collectFrames(
  socket: Socket,
  onFrame: (cookie: string, payload: BencodeDictionary) => void
): void {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      const separator = buffer.indexOf(0x20);
      if (separator < 1) return;
      const cookie = buffer.subarray(0, separator).toString('ascii');
      let decoded;
      try {
        decoded = decodeBencodePrefix(buffer.subarray(separator + 1));
      } catch (error) {
        const incomplete = Boolean(
          error &&
          typeof error === 'object' &&
          'incomplete' in error &&
          error.incomplete
        );
        if (incomplete) return;
        socket.destroy(error as Error);
        return;
      }
      buffer = buffer.subarray(separator + 1 + decoded.bytesRead);
      onFrame(cookie, decoded.value as BencodeDictionary);
    }
  });
}

function frame(cookie: string, payload: BencodeDictionary): Buffer {
  return Buffer.concat([
    Buffer.from(`${cookie} `, 'ascii'),
    encodeBencode(payload)
  ]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('condition was not met before timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function validFixtureSdp(value: unknown): boolean {
  if (typeof value === 'string') {
    return !value.includes('\0') &&
      Buffer.byteLength(value, 'utf8') <= 256 * 1024;
  }
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return false;
  const bytes = Buffer.from(value);
  if (bytes.length > 256 * 1024 || bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
