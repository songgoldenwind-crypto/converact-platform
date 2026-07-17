import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { runIveKitEventWsShard } from '../scripts/capacity/generators/ivekit-event-ws.js';

test('event WS generator uses real sockets and resumes each deterministic client from its cursor', async () => {
  const server = new WebSocketServer({
    port: 0,
    handleProtocols: (protocols) => protocols.has('ivekit.v1') ? 'ivekit.v1' : false
  });
  if (!server.address()) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const resumeCursors: string[] = [];
  const tokens = new Set<string>();

  server.on('connection', (socket, request) => {
    const url = new URL(request.url || '/ws', 'ws://localhost');
    const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map((item) => item.trim());
    const tokenProtocol = protocols.find((item) => item.startsWith('ivekit.jwt.'));
    assert.ok(tokenProtocol);
    const token = tokenProtocol!.slice('ivekit.jwt.'.length);
    tokens.add(token);
    const cursor = url.searchParams.get('cursor') || '';
    socket.send(JSON.stringify({
      type: 'connected',
      data: { head_cursor: cursor || `head-${token}`, snapshot_required: false }
    }));
    if (!cursor) {
      socket.send(JSON.stringify({
        type: 'ivekit.notice.updated',
        event_id: '1',
        cursor: `cursor-1-${token}`,
        data: { token }
      }));
      socket.close(1012, 'controlled restart');
      return;
    }
    resumeCursors.push(cursor);
    socket.send(JSON.stringify({
      type: 'ivekit.notice.updated',
      event_id: '2',
      cursor: `cursor-2-${token}`,
      data: { token }
    }));
  });

  try {
    const result = await runIveKitEventWsShard({
      endpoint: `ws://127.0.0.1:${address.port}/ws`,
      run_id: 'event-ws-controlled-001',
      shard_id: 'connection/ivekit_event_websocket/0-2',
      ordinal_start: 0,
      ordinal_end_exclusive: 2,
      worker_id: 'event-worker-1',
      lease_epoch: '1',
      token_for_ordinal: (ordinal) => `token-${ordinal}`,
      expected_durable_events_per_client: 2,
      maximum_reconnects: 1,
      reconnect_delay_ms: 5,
      connection_timeout_ms: 2_000,
      concurrency: 2,
      message_processing_delay_ms: 2
    });

    assert.equal(result.status, 'controlled_pass');
    assert.equal(result.attempted_count, 2);
    assert.equal(result.accepted_count, 2);
    assert.equal(result.closed_count, 2);
    assert.equal(result.socket_attempt_count, 4);
    assert.equal(result.reconnect_count, 2);
    assert.equal(result.durable_event_count, 4);
    assert.equal(result.duplicate_event_count, 0);
    assert.equal(result.out_of_order_event_count, 0);
    assert.equal(result.error_count, 0);
    assert.match(result.journal_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual([...tokens].sort(), ['token-0', 'token-1']);
    assert.deepEqual(resumeCursors.sort(), ['cursor-1-token-0', 'cursor-1-token-1']);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('event WS generator reports a controlled failure instead of inventing accepted clients', async () => {
  const server = new WebSocketServer({ port: 0 });
  if (!server.address()) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  server.on('connection', (socket) => socket.close(1012, 'unavailable'));

  try {
    const result = await runIveKitEventWsShard({
      endpoint: `ws://127.0.0.1:${address.port}`,
      run_id: 'event-ws-controlled-002',
      shard_id: 'connection/ivekit_event_websocket/0-1',
      ordinal_start: 0,
      ordinal_end_exclusive: 1,
      worker_id: 'event-worker-1',
      lease_epoch: '1',
      token_for_ordinal: () => 'token-0',
      expected_durable_events_per_client: 1,
      maximum_reconnects: 0,
      reconnect_delay_ms: 1,
      connection_timeout_ms: 1_000,
      concurrency: 1
    });
    assert.equal(result.status, 'controlled_failed');
    assert.equal(result.accepted_count, 0);
    assert.equal(result.error_count, 1);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
