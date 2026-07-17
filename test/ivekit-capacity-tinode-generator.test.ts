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
      const count = connectionCount.get(topic || String(body.secret || 'pre-auth')) || 0;
      const params = kind === 'login'
        ? { user: `usr-${String(body.secret).slice(-4)}` }
        : kind === 'pub'
          ? { seq: ++sequence }
          : {};
      socket.send(JSON.stringify({ ctrl: { id: body.id, code: 200, text: 'ok', topic, params } }));
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
