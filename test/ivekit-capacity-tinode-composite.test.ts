import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import {
  evaluateTinodeStartRate,
  runTinodeCompositeShard,
  waitForTinodeStartGate
} from '../scripts/capacity/generators/tinode-composite.js';

test('Tinode start-rate evidence rejects slow or catch-up ramps', () => {
  assert.equal(evaluateTinodeStartRate([0, 10, 20], 100).conformant, true);

  const slow = evaluateTinodeStartRate([0, 10, 1_000], 100);
  assert.equal(slow.conformant, false);
  assert.equal(slow.maximum_starts_per_second, 2);

  const catchUp = evaluateTinodeStartRate([0, 1_000, 1_000, 1_000], 2);
  assert.equal(catchUp.conformant, false);
  assert.ok(catchUp.maximum_starts_per_second > 2);
});

test('Tinode start gate rechecks an early timer before admitting work', async () => {
  let now = 0;
  let waits = 0;
  const admittedAt = await waitForTinodeStartGate(30.303, {
    now: () => now,
    wait: async (milliseconds) => {
      waits += 1;
      now += Math.max(0, milliseconds - 0.75);
    }
  });

  assert.ok(admittedAt >= 30.303);
  assert.equal(now, admittedAt);
  assert.ok(waits >= 2);
});

test('Tinode composite generator carries interactions on the declared connection pool', async () => {
  const server = new WebSocketServer({ port: 0 });
  if (!server.address()) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const subscriptions = new Map<WebSocket, Set<string>>();
  const topicsBySecret = new Map<string, Set<string>>();
  let connectionCount = 0;
  let activeConnections = 0;
  let activePeak = 0;
  let sequence = 0;

  server.on('connection', (socket) => {
    connectionCount += 1;
    activeConnections += 1;
    activePeak = Math.max(activePeak, activeConnections);
    subscriptions.set(socket, new Set());
    socket.on('close', () => {
      activeConnections -= 1;
      subscriptions.delete(socket);
    });
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const kind = Object.keys(packet)[0];
      const body = packet[kind];
      if (kind === 'note') return;
      if (kind === 'sub') subscriptions.get(socket)!.add(body.topic);
      if (kind === 'login') topicsBySecret.set(body.secret, subscriptions.get(socket)!);
      const params = kind === 'pub' ? { seq: ++sequence } : {};
      socket.send(JSON.stringify({
        ctrl: {
          id: body.id,
          code: 200,
          text: 'ok',
          topic: body.topic || '',
          params
        }
      }));
      if (kind !== 'pub') return;
      const data = JSON.stringify({
        data: {
          topic: body.topic,
          seq: params.seq,
          head: body.head,
          content: body.content
        }
      });
      for (const [subscriber, topics] of subscriptions) {
        if (topics.has(body.topic) && subscriber.readyState === WebSocket.OPEN) {
          subscriber.send(data);
        }
      }
    });
  });

  try {
    const connections = [
      { auth: { scheme: 'token' as const, secret: 'customer-0' }, topics: ['grpLoad0'] },
      { auth: { scheme: 'token' as const, secret: 'agent-0' }, topics: ['grpLoad0', 'grpLoad1'] },
      { auth: { scheme: 'token' as const, secret: 'customer-1' }, topics: ['grpLoad1'] }
    ];
    const interactions = [
      {
        topic: 'grpLoad0',
        publisher_connection_ordinal: 0,
        subscriber_connection_ordinal: 1
      },
      {
        topic: 'grpLoad1',
        publisher_connection_ordinal: 2,
        subscriber_connection_ordinal: 1
      }
    ];
    const result = await runTinodeCompositeShard({
      endpoint: `ws://127.0.0.1:${address.port}`,
      api_key: 'tinode-load-key',
      run_id: 'tinode-composite-001',
      shard_id: 'composite/tinode/0-3',
      worker_id: 'tinode-worker-1',
      lease_epoch: '1',
      connection_ordinal_start: 0,
      connection_ordinal_end_exclusive: connections.length,
      interaction_ordinal_start: 0,
      interaction_ordinal_end_exclusive: interactions.length,
      connection_for_ordinal: (ordinal) => connections[ordinal],
      interaction_for_ordinal: (ordinal) => interactions[ordinal],
      messages_per_interaction: 2,
      body_for_message: (ordinal, messageIndex) => `message ${ordinal}/${messageIndex}`,
      receipts_enabled: true,
      maximum_reconnects: 0,
      reconnect_delay_ms: 1,
      request_timeout_ms: 1_000,
      send_to_ack_p95_limit_ms: 200,
      send_to_ack_p99_limit_ms: 500,
      send_to_delivery_p95_limit_ms: 250,
      send_to_delivery_p99_limit_ms: 750,
      delivery_settle_ms: 5,
      connection_hold_ms: 30,
      connection_ramp_per_second: 100,
      interaction_start_rate_per_second: 50,
      concurrency: 3
    });

    assert.equal(result.status, 'controlled_pass');
    assert.equal(result.connection_attempted_count, 3);
    assert.equal(result.connection_accepted_count, 3);
    assert.equal(result.connection_active_peak_count, 3);
    assert.equal(result.connection_closed_count, 3);
    assert.ok(result.connection_start_window_ms >= 15);
    assert.equal(result.connection_rate_conformant, true);
    assert.equal(result.connection_open_sample_count, 3);
    assert.ok(result.connection_open_p95_ms >= 0);
    assert.ok(result.connection_open_p99_ms >= 0);
    assert.equal(result.interaction_attempted_count, 2);
    assert.equal(result.interaction_active_count, 2);
    assert.ok(result.interaction_start_window_ms >= 15);
    assert.equal(result.interaction_rate_conformant, true);
    assert.equal(result.published_message_count, 4);
    assert.ok(result.message_send_window_ms >= 15);
    assert.ok(result.published_messages_per_second > 0);
    assert.equal(result.delivered_message_count, 4);
    assert.equal(result.receipt_note_count, 8);
    assert.equal(result.socket_attempt_count, 3);
    assert.equal(result.reconnect_count, 0);
    assert.equal(result.durable_message_loss_count, 0);
    assert.equal(result.duplicate_message_count, 0);
    assert.equal(result.out_of_order_message_count, 0);
    assert.equal(result.error_count, 0);
    assert.ok(result.elapsed_ms >= 25);
    assert.match(result.journal_sha256, /^[a-f0-9]{64}$/);

    assert.equal(connectionCount, 3);
    assert.equal(activePeak, 3);
    assert.deepEqual([...topicsBySecret.get('agent-0')!].sort(), ['grpLoad0', 'grpLoad1']);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
