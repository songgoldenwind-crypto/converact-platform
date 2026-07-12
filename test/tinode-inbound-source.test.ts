import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { TinodeInboundWireSource } from '../src/agent-runtime/collaboration/tinode-inbound-source.js';

test('Tinode inbound source reconnects and requests later data and delete logs from durable cursors', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake Tinode server did not expose a port');
  const requests: Array<Record<string, any>> = [];
  const requestUrls: string[] = [];
  let connections = 0;
  server.on('connection', (socket, request) => {
    connections += 1;
    requestUrls.push(request.url || '');
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw)) as Record<string, any>;
      requests.push(packet);
      if (packet.hi) {
        socket.send(JSON.stringify({ ctrl: { id: packet.hi.id, code: 200, text: 'ok' } }));
      } else if (packet.login) {
        socket.send(JSON.stringify({ ctrl: { id: packet.login.id, code: 200, text: 'ok', params: { user: 'usrService' } } }));
      } else if (packet.sub) {
        const dataSeq = Number(packet.sub.get.data.since);
        const delId = Number(packet.sub.get.del.since);
        socket.send(JSON.stringify({
          data: { topic: packet.sub.topic, seq: dataSeq, from: 'usrCustomer', content: `message-${dataSeq}` }
        }));
        socket.send(JSON.stringify({
          meta: { topic: packet.sub.topic, del: { clear: delId, delseq: [{ low: dataSeq }] } }
        }));
        socket.send(JSON.stringify({ ctrl: { id: packet.sub.id, code: 200, text: 'ok' } }));
      }
    });
  });

  const source = new TinodeInboundWireSource({
    ws_url: `ws://127.0.0.1:${address.port}/v0/channels`,
    api_key: 'inbound-api-key',
    auth_token: 'inbound-service-token',
    timeout_ms: 2_000,
    settle_ms: 10
  });
  try {
    const first = await source.pull({
      provider_topic_id: 'grpInboundSource',
      last_data_seq: 4,
      last_del_id: 2,
      limit: 25
    });
    const second = await source.pull({
      provider_topic_id: 'grpInboundSource',
      last_data_seq: 5,
      last_del_id: 3,
      limit: 25
    });

    assert.equal(connections, 2);
    assert.equal(first.length, 2);
    assert.equal(first[0].data.seq, 5);
    assert.equal(first[1].meta.del.clear, 3);
    assert.equal(second[0].data.seq, 6);
    const subscriptions = requests.filter((packet) => packet.sub).map((packet) => packet.sub);
    assert.deepEqual(subscriptions.map((sub) => sub.get), [
      { what: 'data del', data: { since: 5, limit: 25 }, del: { since: 3, limit: 25 } },
      { what: 'data del', data: { since: 6, limit: 25 }, del: { since: 4, limit: 25 } }
    ]);
    assert.equal(requestUrls.every((url) => url.includes('apikey=inbound-api-key')), true);
    assert.equal(JSON.stringify(requests).includes('inbound-service-token'), true);
    assert.equal(JSON.stringify(first).includes('inbound-service-token'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
