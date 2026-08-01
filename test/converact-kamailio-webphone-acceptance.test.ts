import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import {
  runKamailioWebPhoneRegisterProbe
} from '../src/agent-runtime/converact/voice/kamailio-webphone-acceptance.js';

test('WebPhone acceptance probe registers, refreshes and unregisters without exposing its token', async () => {
  const requests: string[] = [];
  const origins: Array<string | undefined> = [];
  const server = new WebSocketServer({
    port: 0,
    handleProtocols: (protocols) => protocols.has('sip') ? 'sip' : false
  });
  server.on('connection', (socket, request) => {
    origins.push(request.headers.origin);
    socket.on('message', (bytes) => {
      const message = bytes.toString();
      requests.push(message);
      const callId = /^Call-ID:\s*(.+)$/im.exec(message)?.[1]?.trim();
      const cseq = /^CSeq:\s*(.+)$/im.exec(message)?.[1]?.trim();
      socket.send([
        'SIP/2.0 200 OK',
        `Call-ID: ${callId}`,
        `CSeq: ${cseq}`,
        'Content-Length: 0',
        '',
        ''
      ].join('\r\n'));
    });
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test WebSocket server has no TCP port');

  try {
    const result = await runKamailioWebPhoneRegisterProbe({
      endpoint: `ws://127.0.0.1:${address.port}/ws`,
      token: 'header.payload.signature',
      origin: 'https://agent.example.test',
      identity: 'agent-42',
      realm: 'sip.example.test',
      register_expires_seconds: 240,
      refresh_delay_ms: 5,
      timeout_ms: 2_000,
      allow_insecure_ws: true
    });

    assert.deepEqual(result, {
      status: 'passed',
      register_status: 200,
      refresh_status: 200,
      unregister_status: 200,
      refresh_delay_ms: 5
    });
    assert.deepEqual(origins, ['https://agent.example.test']);
    assert.equal(requests.length, 3);
    assert.match(requests[0]!, /^REGISTER sip:sip\.example\.test SIP\/2\.0/m);
    assert.match(requests[0]!, /^Expires: 240$/m);
    assert.match(requests[1]!, /^CSeq: 2 REGISTER$/m);
    assert.match(requests[2]!, /^Expires: 0$/m);
    assert.doesNotMatch(JSON.stringify(result), /header\.payload\.signature/);
    assert.doesNotMatch(JSON.stringify(result), /agent-42/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WebPhone acceptance probe rejects insecure endpoints unless explicitly controlled', async () => {
  await assert.rejects(() => runKamailioWebPhoneRegisterProbe({
    endpoint: 'ws://127.0.0.1:7443/ws',
    token: 'header.payload.signature',
    origin: 'https://agent.example.test',
    identity: 'agent-42',
    realm: 'sip.example.test',
    register_expires_seconds: 240,
    refresh_delay_ms: 0,
    timeout_ms: 1_000
  }), /secure WSS/i);
});
