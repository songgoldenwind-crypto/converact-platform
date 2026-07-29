import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ProcessingEventHandoff,
  type ProcessingEventSource,
  type ProcessingTerminalEventSink
} from '../src/agent-runtime/ivekit/media-control/processing-event-handoff.js';
import type {
  ProcessingEventPage,
  ProcessingTerminalEvent
} from '../src/agent-runtime/ivekit/media-control/processing.js';

describe('processing terminal event handoff', () => {
  it('durably accepts each event before acknowledging its source', async () => {
    const order: string[] = [];
    const event = processingEvent();
    const source: ProcessingEventSource = {
      async scanEvents() {
        order.push('scan');
        return page([event]);
      },
      async acknowledgeEvent(input) {
        order.push(`ack:${input.event_id}`);
        assert.deepEqual(input, {
          event_sequence: '1',
          event_id: event.event_id
        });
      }
    };
    const sink: ProcessingTerminalEventSink = {
      async publishProcessingTerminal(input) {
        order.push(`durable:${input.event_id}`);
        return { replayed: false };
      }
    };
    const handoff = new ProcessingEventHandoff({
      source,
      sink,
      batch_size: 16,
      poll_interval_ms: 10,
      retry_base_ms: 10,
      retry_max_ms: 100
    });

    assert.deepEqual(await handoff.runOnce(), {
      scanned: 1,
      persisted: 1,
      acknowledged: 1,
      cursor: '1'
    });
    assert.deepEqual(order, [
      'scan',
      `durable:${event.event_id}`,
      `ack:${event.event_id}`
    ]);
    assert.equal(handoff.ready(), true);
  });

  it('replays an already durable event when source acknowledgement failed', async () => {
    const event = processingEvent();
    let acknowledgeAttempts = 0;
    let publishAttempts = 0;
    const source: ProcessingEventSource = {
      async scanEvents() {
        return page([event]);
      },
      async acknowledgeEvent() {
        acknowledgeAttempts += 1;
        if (acknowledgeAttempts === 1) {
          throw new Error('source_ack_unavailable');
        }
      }
    };
    const sink: ProcessingTerminalEventSink = {
      async publishProcessingTerminal() {
        publishAttempts += 1;
        return { replayed: publishAttempts > 1 };
      }
    };
    const handoff = new ProcessingEventHandoff({
      source,
      sink,
      batch_size: 16,
      poll_interval_ms: 10,
      retry_base_ms: 10,
      retry_max_ms: 100
    });

    await assert.rejects(handoff.runOnce(), /source_ack_unavailable/);
    assert.equal(handoff.ready(), false);
    assert.equal(handoff.cursor(), '0');

    assert.equal((await handoff.runOnce()).cursor, '1');
    assert.equal(publishAttempts, 2);
    assert.equal(acknowledgeAttempts, 2);
    assert.equal(handoff.ready(), true);
  });

  it('starts from the source durable acknowledgement watermark', async () => {
    const scans: string[] = [];
    const source: ProcessingEventSource = {
      async scanEvents(input) {
        scans.push(input.after_sequence);
        return {
          items: [],
          acknowledged_through: '41',
          next_sequence: '42'
        };
      },
      async acknowledgeEvent() {
        throw new Error('unexpected_ack');
      }
    };
    const handoff = new ProcessingEventHandoff({
      source,
      sink: {
        async publishProcessingTerminal() {
          throw new Error('unexpected_publish');
        }
      },
      batch_size: 16,
      poll_interval_ms: 10,
      retry_base_ms: 10,
      retry_max_ms: 100
    });

    assert.equal((await handoff.runOnce()).cursor, '41');
    assert.equal((await handoff.runOnce()).cursor, '41');
    assert.deepEqual(scans, ['0', '41']);
  });
});

function page(items: ProcessingTerminalEvent[]): ProcessingEventPage {
  return {
    items,
    acknowledged_through: '0',
    next_sequence: '2'
  };
}

function processingEvent(): ProcessingTerminalEvent {
  return {
    protocol_version: 'ivekit.processing-event.v1',
    event_sequence: '1',
    event_type: 'gather_completed',
    event_id: 'processing-event-handoff-1',
    tenant_id: 'tenant-events',
    call_id: 'call-events',
    cell_id: 'cell-events',
    owner_node_id: 'rustpbx-events',
    owner_epoch: '4294967297',
    media_reservation_id: 'reservation-events',
    command_id: 'gather-events',
    occurred_at_ms: 1_785_200_000_123,
    digits: '42',
    reason: 'maximum_digits',
    minimum_satisfied: true
  };
}
