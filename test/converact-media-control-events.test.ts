import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { BencodeDictionary } from '../src/agent-runtime/converact/media-control/bencode.js';
import {
  MediaControlAgent
} from '../src/agent-runtime/converact/media-control/agent.js';
import {
  createMediaControlHttpServer
} from '../src/agent-runtime/converact/media-control/http.js';
import {
  mediaControlPayloadHash,
  type MediaControlCommand
} from '../src/agent-runtime/converact/media-control/protocol.js';
import type { RtpengineNgDtmfEvent } from '../src/agent-runtime/converact/media-control/rtpengine-ng.js';
import {
  InMemoryMediaTransport
} from '../src/agent-runtime/converact/media-control/simulator.js';
import type {
  ProcessingTerminalEvent
} from '../src/agent-runtime/converact/media-control/processing.js';

const TOKEN = 'media-event-test-token-0123456789';

const command = (
  callId: string,
  ownerNodeId: string,
  ownerEpoch = '4294967297'
): MediaControlCommand => {
  const payload = {
    offer_sdp: 'v=0\r\n',
    media_profile_id: 'g711-relay-v1'
  };
  return {
    protocol_version: 'ivekit.media-control.v1',
    action: 'offer',
    command_id: `command-${callId}-${ownerEpoch}`,
    tenant_id: 'tenant-events',
    call_id: callId,
    leg_id: 'callee',
    cell_id: 'cell-events',
    owner_node_id: ownerNodeId,
    owner_epoch: ownerEpoch,
    admission_reservation_id: `reservation-${callId}`,
    media_reservation_id: `reservation-${callId}`,
    command_sequence: 1,
    idempotency_key: `idem-${callId}-${ownerEpoch}`,
    expires_at: '2026-07-26T17:00:30.000Z',
    payload,
    payload_hash: mediaControlPayloadHash(payload)
  };
};

const dtmf = (
  callId: string,
  event: number,
  timestamp: number
): RtpengineNgDtmfEvent => ({
  cookie: `notify-${callId}-${timestamp}`,
  payload: {
    notify: 'onDTMF',
    data: {
      type: 'DTMF',
      callid: callId,
      source_tag: 'caller-tag',
      event,
      duration: 160,
      volume: 10,
      timestamp
    } satisfies BencodeDictionary
  }
});

describe('media-control event broker', () => {
  it('routes RTPengine DTMF only to the current RustPBX owner', async () => {
    const {
      MediaControlEventBroker
    } = await import('../src/agent-runtime/converact/media-control/events.js');
    const broker = new MediaControlEventBroker({
      maxBindings: 8,
      maxRetainedEventsPerOwner: 8
    });
    broker.bind(command('call-1', 'rustpbx-a'));
    const ownerA = broker.subscribe({
      owner_node_id: 'rustpbx-a',
      after_sequence: 0
    });

    assert.equal(broker.publishRtpengineDtmf(dtmf('call-1', 5, 100)), true);
    const first = await ownerA.next();
    assert.equal(first.done, false);
    assert.deepEqual(first.value, {
      protocol_version: 'ivekit.media-event.v1',
      event_sequence: 1,
      event_type: 'dtmf',
      tenant_id: 'tenant-events',
      call_id: 'call-1',
      cell_id: 'cell-events',
      owner_node_id: 'rustpbx-a',
      owner_epoch: '4294967297',
      source_tag: 'caller-tag',
      digit: '5',
      duration: 160,
      volume: 10,
      rtp_timestamp: 100
    });

    broker.bind(command('call-1', 'rustpbx-b', '4294967298'));
    const ownerB = broker.subscribe({
      owner_node_id: 'rustpbx-b',
      after_sequence: 0
    });
    assert.equal(broker.publishRtpengineDtmf(dtmf('call-1', 11, 101)), true);
    const moved = await ownerB.next();
    assert.equal(moved.done, false);
    assert.equal(moved.value?.digit, '#');
    assert.equal(moved.value?.owner_epoch, '4294967298');

    const oldOwnerResult = await Promise.race([
      ownerA.next().then(() => 'unexpected'),
      new Promise<string>((resolve) => setTimeout(() => resolve('idle'), 20))
    ]);
    assert.equal(oldOwnerResult, 'idle');
    ownerA.close();
    ownerB.close();
  });

  it('replays a bounded owner stream and rejects an unrecoverable gap', async () => {
    const {
      MediaControlEventBroker,
      MediaControlEventGapError
    } = await import('../src/agent-runtime/converact/media-control/events.js');
    const broker = new MediaControlEventBroker({
      maxBindings: 2,
      maxRetainedEventsPerOwner: 2
    });
    broker.bind(command('call-2', 'rustpbx-a'));
    broker.publishRtpengineDtmf(dtmf('call-2', 1, 201));
    broker.publishRtpengineDtmf(dtmf('call-2', 2, 202));
    broker.publishRtpengineDtmf(dtmf('call-2', 3, 203));

    assert.throws(
      () => broker.subscribe({
        owner_node_id: 'rustpbx-a',
        after_sequence: 0
      }),
      MediaControlEventGapError
    );
    const replay = broker.subscribe({
      owner_node_id: 'rustpbx-a',
      after_sequence: 1
    });
    assert.equal((await replay.next()).value?.digit, '2');
    assert.equal((await replay.next()).value?.digit, '3');
    replay.close();
  });

  it('bounds call ownership and ignores malformed or unbound notifications', async () => {
    const {
      MediaControlEventBroker
    } = await import('../src/agent-runtime/converact/media-control/events.js');
    const broker = new MediaControlEventBroker({
      maxBindings: 1,
      maxRetainedEventsPerOwner: 2
    });
    broker.bind(command('call-3', 'rustpbx-a'));
    assert.throws(
      () => broker.bind(command('call-4', 'rustpbx-a')),
      /media_control_event_binding_capacity/
    );
    assert.equal(broker.publishRtpengineDtmf(dtmf('missing', 1, 301)), false);
    assert.equal(broker.publishRtpengineDtmf({
      cookie: 'malformed',
      payload: {
        notify: 'onDTMF',
        data: { type: 'DTMF', callid: 'call-3', event: 99 }
      }
    }), false);
  });

  it('durably publishes and deduplicates processing terminal events', async () => {
    const {
      MediaControlEventBroker
    } = await import('../src/agent-runtime/converact/media-control/events.js');
    const appended: unknown[] = [];
    const broker = new MediaControlEventBroker({
      maxBindings: 8,
      maxRetainedEventsPerOwner: 8,
      terminalJournal: {
        async append(event) {
          appended.push(structuredClone(event));
          return { replayed: false };
        }
      }
    });
    broker.bind(command('call-terminal', 'rustpbx-terminal'));
    const subscription = broker.subscribeTerminal({
      owner_node_id: 'rustpbx-terminal',
      after_sequence: 0
    });

    const first = await broker.publishProcessingTerminal(
      processingTerminal('call-terminal', 'rustpbx-terminal')
    );
    assert.equal(first.replayed, false);
    assert.equal(first.event.event_sequence, 1);
    assert.equal((await subscription.next()).value?.event_type, 'gather_completed');

    const replay = await broker.publishProcessingTerminal(
      processingTerminal('call-terminal', 'rustpbx-terminal')
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.event, first.event);
    assert.equal(appended.length, 1);
    subscription.close();
  });

  it('serializes concurrent terminal publications and restores owner sequence', async () => {
    const {
      MediaControlEventBroker,
      MEDIA_CONTROL_EVENT_PROTOCOL_VERSION
    } = await import('../src/agent-runtime/converact/media-control/events.js');
    const restored = {
      protocol_version: MEDIA_CONTROL_EVENT_PROTOCOL_VERSION,
      event_sequence: 5,
      event_type: 'gather_completed' as const,
      event_id: 'processing-event-restored',
      source: 'processing' as const,
      source_event_sequence: '5',
      tenant_id: 'tenant-events',
      call_id: 'call-terminal',
      cell_id: 'cell-events',
      owner_node_id: 'rustpbx-terminal',
      owner_epoch: '4294967297',
      media_reservation_id: 'reservation-call-terminal',
      command_id: 'gather-restored',
      occurred_at_ms: 1_785_200_000_100,
      digits: '5',
      reason: 'maximum_digits' as const,
      minimum_satisfied: true
    };
    const appended: Array<{ event_sequence: number }> = [];
    const broker = new MediaControlEventBroker({
      maxBindings: 8,
      maxRetainedEventsPerOwner: 8,
      terminalEvents: [restored],
      terminalJournal: {
        async append(event) {
          appended.push(structuredClone(event));
          return { replayed: false };
        }
      }
    });
    broker.bind(command('call-terminal', 'rustpbx-terminal'));
    const replay = broker.subscribeTerminal({
      owner_node_id: 'rustpbx-terminal',
      after_sequence: 4
    });
    assert.deepEqual((await replay.next()).value, restored);
    replay.close();

    const [sixth, seventh] = await Promise.all([
      broker.publishProcessingTerminal(processingTerminal(
        'call-terminal',
        'rustpbx-terminal',
        {
          event_id: 'processing-event-six',
          event_sequence: '6',
          command_id: 'gather-six'
        }
      )),
      broker.publishProcessingTerminal(processingTerminal(
        'call-terminal',
        'rustpbx-terminal',
        {
          event_id: 'processing-event-seven',
          event_sequence: '7',
          command_id: 'gather-seven'
        }
      ))
    ]);
    assert.equal(sixth.event.event_sequence, 6);
    assert.equal(seventh.event.event_sequence, 7);
    assert.deepEqual(appended.map((event) => event.event_sequence), [6, 7]);
  });

  it('keeps RTPengine DTMF delivery independent from terminal WAL fsync', async () => {
    const {
      MediaControlEventBroker
    } = await import('../src/agent-runtime/converact/media-control/events.js');
    let finishAppend!: () => void;
    const appendBarrier = new Promise<void>((resolve) => {
      finishAppend = resolve;
    });
    const broker = new MediaControlEventBroker({
      maxBindings: 8,
      maxRetainedEventsPerOwner: 8,
      terminalJournal: {
        async append() {
          await appendBarrier;
          return { replayed: false };
        }
      }
    });
    broker.bind(command('call-isolated', 'rustpbx-isolated'));
    const dtmfEvents = broker.subscribe({
      owner_node_id: 'rustpbx-isolated',
      after_sequence: 0
    });
    const terminalEvents = broker.subscribeTerminal({
      owner_node_id: 'rustpbx-isolated',
      after_sequence: 0
    });
    const pendingTerminal = broker.publishProcessingTerminal(
      processingTerminal('call-isolated', 'rustpbx-isolated')
    );

    assert.equal(
      broker.publishRtpengineDtmf(dtmf('call-isolated', 8, 501)),
      true
    );
    assert.equal((await dtmfEvents.next()).value?.digit, '8');
    const terminalNext = terminalEvents.next();
    assert.equal(
      await Promise.race([
        terminalNext.then(() => 'published'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 20))
      ]),
      'waiting'
    );

    finishAppend();
    assert.equal((await pendingTerminal).event.event_sequence, 1);
    assert.equal((await terminalNext).value?.event_type, 'gather_completed');
    dtmfEvents.close();
    terminalEvents.close();
  });

  it('binds committed commands and streams authenticated NDJSON events', async () => {
    const {
      MediaControlEventBroker
    } = await import('../src/agent-runtime/converact/media-control/events.js');
    const broker = new MediaControlEventBroker({
      maxBindings: 8,
      maxRetainedEventsPerOwner: 8
    });
    const server = createMediaControlHttpServer({
      agent: new MediaControlAgent({
        authority: {
          async authorize() {
            return {
              owner_epoch: '4294967297',
              reservation_expires_at: '2026-07-26T18:00:00.000Z',
              node_lease_expires_at: '2026-07-26T17:30:00.000Z'
            };
          }
        },
        transport: new InMemoryMediaTransport()
      }),
      service_token: TOKEN,
      events: broker,
      now: () => new Date('2026-07-26T17:00:00.000Z')
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const endpoint = `http://127.0.0.1:${address.port}`;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const accepted = await fetch(`${endpoint}/v1/commands`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(command('call-http', 'rustpbx-http'))
      });
      assert.equal(accepted.status, 200);

      const stream = await fetch(
        `${endpoint}/v1/events?owner_node_id=rustpbx-http&after_sequence=0`,
        {
          headers: {
            authorization: `Bearer ${TOKEN}`,
            accept: 'application/x-ndjson'
          }
        }
      );
      assert.equal(stream.status, 200);
      assert.equal(
        stream.headers.get('content-type'),
        'application/x-ndjson; charset=utf-8'
      );
      assert.ok(stream.body);
      reader = stream.body.getReader();
      assert.equal(
        broker.publishRtpengineDtmf(dtmf('call-http', 9, 401)),
        true
      );
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      const event = JSON.parse(new TextDecoder().decode(chunk.value).trim());
      assert.equal(event.call_id, 'call-http');
      assert.equal(event.digit, '9');
      assert.equal(event.event_sequence, 1);
    } finally {
      await reader?.cancel();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('streams durable terminal events on an independent owner cursor', async () => {
    const {
      MediaControlEventBroker
    } = await import('../src/agent-runtime/converact/media-control/events.js');
    const broker = new MediaControlEventBroker({
      maxBindings: 8,
      maxRetainedEventsPerOwner: 8,
      terminalJournal: {
        async append() {
          return { replayed: false };
        }
      }
    });
    broker.bind(command('call-terminal-http', 'rustpbx-terminal-http'));
    const server = createMediaControlHttpServer({
      agent: new MediaControlAgent({
        authority: {
          async authorize() {
            return {
              owner_epoch: '4294967297',
              reservation_expires_at: '2026-07-26T18:00:00.000Z',
              node_lease_expires_at: '2026-07-26T17:30:00.000Z'
            };
          }
        },
        transport: new InMemoryMediaTransport()
      }),
      service_token: TOKEN,
      events: broker
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/terminal-events` +
          '?owner_node_id=rustpbx-terminal-http&after_sequence=0',
        {
          headers: {
            authorization: `Bearer ${TOKEN}`,
            accept: 'application/x-ndjson'
          }
        }
      );
      assert.equal(response.status, 200);
      assert.ok(response.body);
      reader = response.body.getReader();

      await broker.publishProcessingTerminal(
        processingTerminal('call-terminal-http', 'rustpbx-terminal-http')
      );
      const item = await reader.read();
      assert.equal(item.done, false);
      const event = JSON.parse(new TextDecoder().decode(item.value).trim());
      assert.equal(event.event_type, 'gather_completed');
      assert.equal(event.event_sequence, 1);
      assert.equal(event.source_event_sequence, '1');
    } finally {
      await reader?.cancel();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('wires RTPengine notifications into the broker without awaiting commands', () => {
    const source = readFileSync('scripts/converact-media-control-agent.ts', 'utf8');
    assert.match(source, /MediaTerminalEventJournal\.open/);
    assert.match(source, /new ProcessingEventHandoff/);
    assert.match(source, /new MediaControlEventBroker/);
    assert.match(source, /openTransportRuntime\(transportMode,\s*events\)/);
    assert.match(
      source,
      /onDtmf:\s*\(event\)\s*=>\s*events\.publishRtpengineDtmf\(event\)/
    );
    assert.match(source, /processingEventHandoff\?\.ready\(\)/);
    assert.match(source, /processingEventHandoff\?\.stop\(\)/);
    assert.match(source, /terminalEventJournal\?\.close\(\)/);
    assert.match(source, /events:\s*events/);
  });

  it('deploys bounded event routing controls with the media-control agent', () => {
    const env = readFileSync('infra/converact/env.example', 'utf8');
    const compose = readFileSync('infra/converact/docker-compose.voice.yml', 'utf8');
    const daemonset = readFileSync(
      'infra/converact/helm/rtpengine/templates/daemonset.yaml',
      'utf8'
    );
    for (const name of [
      'CONVERACT_FABRIC_MEDIA_CONTROL_EVENT_MAX_BINDINGS',
      'CONVERACT_FABRIC_MEDIA_CONTROL_EVENT_REPLAY_CAPACITY',
      'CONVERACT_FABRIC_MEDIA_CONTROL_EVENT_MAX_SUBSCRIBERS_PER_OWNER'
    ]) {
      assert.match(env, new RegExp(`^${name}=`, 'm'), name);
      assert.match(compose, new RegExp(name), name);
      assert.match(daemonset, new RegExp(name), name);
    }
  });
});

function processingTerminal(
  callId: string,
  ownerNodeId: string,
  overrides: Partial<ProcessingTerminalEvent> = {}
): ProcessingTerminalEvent {
  return {
    protocol_version: 'ivekit.processing-event.v1',
    event_sequence: '1',
    event_type: 'gather_completed',
    event_id: `processing-event-${callId}`,
    tenant_id: 'tenant-events',
    call_id: callId,
    cell_id: 'cell-events',
    owner_node_id: ownerNodeId,
    owner_epoch: '4294967297',
    media_reservation_id: `reservation-${callId}`,
    command_id: `gather-${callId}`,
    occurred_at_ms: 1_785_200_000_123,
    digits: '42',
    reason: 'maximum_digits',
    minimum_satisfied: true,
    ...overrides
  } as ProcessingTerminalEvent;
}
