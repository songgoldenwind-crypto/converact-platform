import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { runTinodeInteractionShard } from '../scripts/capacity/generators/tinode.js';

test('Tinode generator exercises hello, auth, topic, presence, publish, receipts and reconnect', async () => {
  const http = createServer();
  const server = new WebSocketServer({ server: http, path: '/v0/channels' });
  const packets: Array<Record<string, any>> = [];
  const connectionCount = new Map<string, number>();
  let sequence = 100;
  server.on('connection', (socket, request) => {
    const url = new URL(request.url || '/', 'ws://localhost');
    assert.equal(url.searchParams.get('apikey'), 'tinode-load-key');
    let topic = '';
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      packets.push(packet);
      const kind = Object.keys(packet)[0];
      const body = packet[kind];
      if (kind === 'note') return;
      if (kind === 'sub') topic = body.topic;
      if (kind === 'get') {
        socket.send(JSON.stringify({
          meta: {
            id: body.id,
            topic: body.topic,
            desc: {
              online: true
            }
          }
        }));
        return;
      }
      const count = connectionCount.get(topic || String(body.secret || 'pre-auth')) || 0;
      const params = kind === 'login'
        ? { user: `usr-${String(body.secret).slice(-4)}` }
        : kind === 'pub'
          ? { seq: ++sequence }
          : {};
      socket.send(JSON.stringify({ ctrl: { id: body.id, code: 200, text: 'ok', topic, params } }));
      if (kind === 'pub') {
        socket.send(JSON.stringify({
          data: {
            topic,
            seq: params.seq,
            head: body.head,
            content: body.content
          }
        }));
      }
      if (kind === 'sub' && count === 0) {
        connectionCount.set(topic, 1);
        socket.close(1012, 'controlled Tinode restart');
      }
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const result = await runTinodeInteractionShard({
      endpoint: `ws://127.0.0.1:${address.port}/v0/channels`,
      api_key: 'tinode-load-key',
      run_id: 'tinode-controlled-001',
      shard_id: 'interaction/tinode_im/0-2',
      ordinal_start: 0,
      ordinal_end_exclusive: 2,
      worker_id: 'tinode-worker-1',
      lease_epoch: '1',
      auth_for_ordinal: (ordinal) => ({ scheme: 'token', secret: `token-${ordinal}` }),
      topic_for_ordinal: (ordinal) => `grpLoad${ordinal}`,
      messages_per_interaction: 2,
      body_for_message: (ordinal, messageIndex) => `message ${ordinal}/${messageIndex}`,
      presence_enabled: true,
      typing_enabled: true,
      receipts_enabled: true,
      maximum_reconnects: 1,
      reconnect_delay_ms: 5,
      request_timeout_ms: 1_000,
      send_to_ack_p95_limit_ms: 200,
      send_to_ack_p99_limit_ms: 500,
      send_to_delivery_p95_limit_ms: 250,
      send_to_delivery_p99_limit_ms: 750,
      delivery_settle_ms: 5,
      offline_recovery_message_count: 0,
      offline_recovery_p99_limit_ms: 1_000,
      concurrency: 2
    });

    assert.equal(result.status, 'controlled_pass');
    assert.equal(result.attempted_count, 2);
    assert.equal(result.accepted_count, 2);
    assert.equal(result.published_message_count, 4);
    assert.equal(result.reconnect_count, 2);
    assert.equal(result.presence_query_count, 2);
    assert.equal(result.typing_note_count, 2);
    assert.equal(result.receipt_note_count, 8);
    assert.equal(result.error_count, 0);
    assert.equal(result.send_to_ack_sample_count, 4);
    assert.equal(result.delivered_message_count, 4);
    assert.equal(result.send_to_delivery_sample_count, 4);
    assert.equal(result.durable_message_loss_count, 0);
    assert.equal(result.duplicate_message_count, 0);
    assert.equal(result.out_of_order_message_count, 0);
    assert.ok(result.send_to_ack_p50_ms >= 0);
    assert.ok(result.send_to_ack_p95_ms <= 200);
    assert.ok(result.send_to_ack_p99_ms <= 500);
    assert.match(result.journal_sha256, /^[a-f0-9]{64}$/);

    const publishHeads = packets.filter((packet) => packet.pub).map((packet) => packet.pub.head);
    assert.equal(publishHeads.length, 4);
    assert.equal(new Set(publishHeads.map((head) => head['x-opc-message-id'])).size, 4);
    assert.equal(packets.filter((packet) => packet.note?.what === 'kp').length, 2);
    assert.equal(packets.filter((packet) => packet.note?.what === 'recv').length, 4);
    assert.equal(packets.filter((packet) => packet.note?.what === 'read').length, 4);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test('Tinode generator reports protocol rejection as controlled failure', async () => {
  const server = new WebSocketServer({ port: 0 });
  if (!server.address()) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const kind = Object.keys(packet)[0];
      const body = packet[kind];
      socket.send(JSON.stringify({
        ctrl: { id: body.id, code: kind === 'login' ? 403 : 200, text: kind === 'login' ? 'forbidden' : 'ok' }
      }));
    });
  });

  try {
    const result = await runTinodeInteractionShard({
      endpoint: `ws://127.0.0.1:${address.port}`,
      api_key: 'key',
      run_id: 'tinode-controlled-002',
      shard_id: 'interaction/tinode_im/0-1',
      ordinal_start: 0,
      ordinal_end_exclusive: 1,
      worker_id: 'tinode-worker-1',
      lease_epoch: '1',
      auth_for_ordinal: () => ({ scheme: 'token', secret: 'bad-token' }),
      topic_for_ordinal: () => 'grpRejected',
      messages_per_interaction: 1,
      body_for_message: () => 'message',
      presence_enabled: false,
      typing_enabled: false,
      receipts_enabled: false,
      maximum_reconnects: 0,
      reconnect_delay_ms: 1,
      request_timeout_ms: 1_000,
      send_to_ack_p95_limit_ms: 200,
      send_to_ack_p99_limit_ms: 500,
      send_to_delivery_p95_limit_ms: 250,
      send_to_delivery_p99_limit_ms: 750,
      delivery_settle_ms: 5,
      offline_recovery_message_count: 0,
      offline_recovery_p99_limit_ms: 1_000,
      concurrency: 1
    });
    assert.equal(result.status, 'controlled_failed');
    assert.equal(result.accepted_count, 0);
    assert.equal(result.error_count, 1);
    assert.match(result.errors[0], /403/);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tinode generator fails when publishes succeed but send-to-ack latency breaches the contract', async () => {
  const server = new WebSocketServer({ port: 0 });
  if (!server.address()) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let sequence = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const kind = Object.keys(packet)[0];
      const body = packet[kind];
      if (kind === 'note') return;
      const respond = () => {
        const params = kind === 'pub' ? { seq: ++sequence } : {};
        socket.send(JSON.stringify({
          ctrl: {
            id: body.id,
            code: 200,
            text: 'ok',
            params
          }
        }));
        if (kind === 'pub') {
          socket.send(JSON.stringify({
            data: {
              topic: body.topic,
              seq: params.seq,
              head: body.head,
              content: body.content
            }
          }));
        }
      };
      if (kind === 'pub') setTimeout(respond, 25);
      else respond();
    });
  });

  try {
    const result = await runTinodeInteractionShard({
      endpoint: `ws://127.0.0.1:${address.port}`,
      api_key: 'key',
      run_id: 'tinode-controlled-003',
      shard_id: 'interaction/tinode_im/0-1',
      ordinal_start: 0,
      ordinal_end_exclusive: 1,
      worker_id: 'tinode-worker-1',
      lease_epoch: '1',
      auth_for_ordinal: () => ({ scheme: 'token', secret: 'token' }),
      topic_for_ordinal: () => 'grpSlowAck',
      messages_per_interaction: 3,
      body_for_message: () => 'message',
      presence_enabled: false,
      typing_enabled: false,
      receipts_enabled: false,
      maximum_reconnects: 0,
      reconnect_delay_ms: 1,
      request_timeout_ms: 1_000,
      send_to_ack_p95_limit_ms: 10,
      send_to_ack_p99_limit_ms: 15,
      send_to_delivery_p95_limit_ms: 100,
      send_to_delivery_p99_limit_ms: 200,
      delivery_settle_ms: 5,
      offline_recovery_message_count: 0,
      offline_recovery_p99_limit_ms: 1_000,
      concurrency: 1
    });

    assert.equal(result.published_message_count, 3);
    assert.equal(result.error_count, 0);
    assert.equal(result.status, 'controlled_failed');
    assert.ok(result.send_to_ack_p95_ms > 10);
    assert.equal(result.quality_gate_passed, false);
    assert.match(result.quality_reasons.join('\n'), /send-to-ack/i);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tinode generator fails closed when a published message is delivered more than once', async () => {
  const server = new WebSocketServer({ port: 0 });
  if (!server.address()) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let sequence = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const kind = Object.keys(packet)[0];
      const body = packet[kind];
      if (kind === 'note') return;
      const params = kind === 'pub' ? { seq: ++sequence } : {};
      socket.send(JSON.stringify({
        ctrl: { id: body.id, code: 200, text: 'ok', params }
      }));
      if (kind === 'pub') {
        const data = JSON.stringify({
          data: {
            topic: body.topic,
            seq: params.seq,
            head: body.head,
            content: body.content
          }
        });
        socket.send(data);
        socket.send(data);
      }
    });
  });

  try {
    const result = await runTinodeInteractionShard({
      endpoint: `ws://127.0.0.1:${address.port}`,
      api_key: 'key',
      run_id: 'tinode-controlled-004',
      shard_id: 'interaction/tinode_im/0-1',
      ordinal_start: 0,
      ordinal_end_exclusive: 1,
      worker_id: 'tinode-worker-1',
      lease_epoch: '1',
      auth_for_ordinal: () => ({ scheme: 'token', secret: 'token' }),
      topic_for_ordinal: () => 'grpDuplicate',
      messages_per_interaction: 1,
      body_for_message: () => 'message',
      presence_enabled: false,
      typing_enabled: false,
      receipts_enabled: false,
      maximum_reconnects: 0,
      reconnect_delay_ms: 1,
      request_timeout_ms: 1_000,
      send_to_ack_p95_limit_ms: 200,
      send_to_ack_p99_limit_ms: 500,
      send_to_delivery_p95_limit_ms: 250,
      send_to_delivery_p99_limit_ms: 750,
      delivery_settle_ms: 10,
      offline_recovery_message_count: 0,
      offline_recovery_p99_limit_ms: 1_000,
      concurrency: 1
    });

    assert.equal(result.status, 'controlled_failed');
    assert.equal(result.delivered_message_count, 1);
    assert.equal(result.duplicate_message_count, 1);
    assert.match(result.quality_reasons.join('\n'), /duplicate/i);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tinode generator proves offline messages converge once after cursor-based reconnect', async () => {
  const server = new WebSocketServer({ port: 0 });
  if (!server.address()) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const histories = new Map<string, any[]>();
  const subscriptions = new Map<any, string>();
  let sequence = 0;
  server.on('connection', (socket) => {
    socket.on('close', () => subscriptions.delete(socket));
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      const kind = Object.keys(packet)[0];
      const body = packet[kind];
      if (kind === 'note') return;
      if (kind === 'sub') subscriptions.set(socket, body.topic);
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
      if (kind === 'sub') {
        const since = Number(body.get?.data?.since || 0);
        for (const data of [...(histories.get(body.topic) || [])].reverse()) {
          if (data.data.seq >= since) socket.send(JSON.stringify(data));
        }
      }
      if (kind === 'pub') {
        const data = {
          data: {
            topic: body.topic,
            seq: params.seq,
            head: body.head,
            content: body.content
          }
        };
        const history = histories.get(body.topic) || [];
        history.push(data);
        histories.set(body.topic, history);
        for (const [subscriber, topic] of subscriptions) {
          if (topic === body.topic && subscriber.readyState === 1) {
            subscriber.send(JSON.stringify(data));
          }
        }
      }
    });
  });

  try {
    const result = await runTinodeInteractionShard({
      endpoint: `ws://127.0.0.1:${address.port}`,
      api_key: 'key',
      run_id: 'tinode-controlled-005',
      shard_id: 'interaction/tinode_im/0-1',
      ordinal_start: 0,
      ordinal_end_exclusive: 1,
      worker_id: 'tinode-worker-1',
      lease_epoch: '1',
      auth_for_ordinal: () => ({ scheme: 'token', secret: 'token' }),
      topic_for_ordinal: () => 'grpOfflineRecovery',
      messages_per_interaction: 1,
      body_for_message: () => 'message',
      presence_enabled: false,
      typing_enabled: false,
      receipts_enabled: false,
      maximum_reconnects: 0,
      reconnect_delay_ms: 1,
      request_timeout_ms: 1_000,
      send_to_ack_p95_limit_ms: 200,
      send_to_ack_p99_limit_ms: 500,
      send_to_delivery_p95_limit_ms: 250,
      send_to_delivery_p99_limit_ms: 750,
      delivery_settle_ms: 5,
      offline_recovery_message_count: 2,
      offline_recovery_p99_limit_ms: 1_000,
      concurrency: 1
    });

    assert.equal(result.status, 'controlled_pass');
    assert.equal(result.offline_recovery_attempt_count, 1);
    assert.equal(result.offline_recovery_success_count, 1);
    assert.equal(result.offline_recovered_message_count, 2);
    assert.equal(result.offline_recovery_duplicate_count, 0);
    assert.equal(result.offline_recovery_out_of_order_count, 0);
    assert.equal(result.offline_recovery_wire_out_of_order_count, 1);
    assert.ok(result.offline_recovery_p99_ms <= 1_000);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
