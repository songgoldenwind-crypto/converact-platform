import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net, { type AddressInfo, type Socket } from 'node:net';
import { describe, it } from 'node:test';

import {
  BencodeError,
  decodeBencode,
  decodeBencodePrefix,
  encodeBencode,
  type BencodeDictionary
} from '../src/agent-runtime/converact/media-control/bencode.js';
import {
  RtpengineNgClient,
  RtpengineNgRequestError,
  rtpengineNgCookie
} from '../src/agent-runtime/converact/media-control/rtpengine-ng.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('deterministic bounded bencode', () => {
  it('sorts dictionary keys by encoded bytes and preserves arbitrary byte strings', () => {
    const binary = Buffer.from([0, 10, 255, 58, 101]);
    const encoded = encodeBencode({
      z: 'last',
      binary,
      alpha: ['nested', 7, { x: 'value' }]
    });

    assert.deepEqual(
      encoded,
      Buffer.concat([
        Buffer.from('d5:alpha'),
        Buffer.from('l6:nestedi7ed1:x5:valueee'),
        Buffer.from('6:binary5:'),
        binary,
        Buffer.from('1:z4:laste')
      ])
    );

    const decoded = decodeBencode(encoded) as BencodeDictionary;
    assert.deepEqual(decoded.binary, binary);
    assert.deepEqual(decoded.alpha, [
      Buffer.from('nested'),
      7,
      { x: Buffer.from('value') }
    ]);
  });

  it('enforces canonical signed 64-bit integers', () => {
    assert.equal(
      encodeBencode(9_223_372_036_854_775_807n).toString(),
      'i9223372036854775807e'
    );
    assert.equal(
      decodeBencode(Buffer.from('i9223372036854775807e')),
      9_223_372_036_854_775_807n
    );

    for (const value of [
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      9_223_372_036_854_775_808n,
      -9_223_372_036_854_775_809n
    ]) {
      assert.throws(() => encodeBencode(value), BencodeError);
    }
    for (const encoded of ['i-0e', 'i01e', 'i+1e', 'ie', 'i9223372036854775808e']) {
      assert.throws(() => decodeBencode(Buffer.from(encoded)), BencodeError);
    }
  });

  it('rejects duplicate keys, malformed lengths and trailing bytes', () => {
    for (const encoded of [
      'd1:a1:x1:a1:ye',
      '03:abc',
      '3x:abc',
      '4:abc',
      '1:ab'
    ]) {
      assert.throws(() => decodeBencode(Buffer.from(encoded)), BencodeError);
    }
  });

  it('rejects dictionary keys that cannot round-trip as unique UTF-8', () => {
    const invalidKeys = {
      ['\ud800']: 'first',
      ['\ud801']: 'second'
    };
    assert.throws(
      () => encodeBencode(invalidKeys),
      (error: unknown) =>
        error instanceof BencodeError &&
        error.code === 'bencode_dictionary_key_invalid'
    );
  });

  it('enforces depth, node, decoded byte and string limits', () => {
    assert.throws(
      () => decodeBencode(Buffer.from('ll1:xee'), { maxDepth: 1 }),
      BencodeError
    );
    assert.throws(
      () => decodeBencode(Buffer.from('l1:a1:b1:ce'), { maxNodes: 3 }),
      BencodeError
    );
    assert.throws(
      () => decodeBencode(Buffer.from('8:abcdefgh'), { maxStringBytes: 7 }),
      BencodeError
    );
    assert.throws(
      () => decodeBencode(Buffer.from('8:abcdefgh'), { maxBytes: 9 }),
      BencodeError
    );
  });

  it('decodes one value from a prefix without treating embedded newlines as framing', () => {
    const value = Buffer.from([1, 10, 2]);
    const encoded = Buffer.concat([encodeBencode(value), Buffer.from('\nrest')]);
    const decoded = decodeBencodePrefix(encoded);

    assert.deepEqual(decoded.value, value);
    assert.equal(decoded.bytesRead, 5);
  });
});

describe('persistent RTPengine TCP NG client', () => {
  it('matches out-of-order responses and separates one-byte fragmented DTMF', async () => {
    const received: Array<{ cookie: string; payload: BencodeDictionary }> = [];
    const server = await startServer((socket) => {
      collectFrames(socket, (cookie, payload) => {
        received.push({ cookie, payload });
        if (received.length !== 2) return;

        socket.write(frame(received[1].cookie, {
          result: 'ok',
          marker: 'second'
        }));
        const dtmf = frame('unsolicited-dtmf', {
          notify: 'onDTMF',
          data: {
            type: 'DTMF',
            callid: 'call-1',
            source_tag: 'from-1',
            event: 5,
            duration: 160,
            volume: 10,
            timestamp: 1_774_396_800
          }
        });
        const first = frame(received[0].cookie, {
          result: 'ok',
          marker: Buffer.from([65, 10, 66])
        });
        void writeFragments(socket, Buffer.concat([dtmf, first]));
      });
    });
    const dtmfEvents: BencodeDictionary[] = [];
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port: server.port,
      maxConnections: 1,
      maxInFlight: 4,
      requestTimeoutMs: 2_000,
      reconnectMinDelayMs: 0,
      reconnectMaxDelayMs: 0,
      onDtmf: (event) => dtmfEvents.push(event.payload)
    });

    try {
      const first = client.request(
        { command: 'offer', marker: 'first' },
        { command_id: 'command-1', command_hash: HASH_A }
      );
      const second = client.request(
        { command: 'offer', marker: 'second' },
        { command_id: 'command-2', command_hash: HASH_B }
      );
      const [firstResult, secondResult] = await Promise.all([first, second]);

      assert.deepEqual(firstResult.marker, Buffer.from([65, 10, 66]));
      assert.equal(text(secondResult.marker), 'second');
      assert.equal(dtmfEvents.length, 1);
      assert.equal(
        (dtmfEvents[0].data as BencodeDictionary).event,
        5
      );
      assert.equal(received[0].cookie, rtpengineNgCookie({
        command_id: 'command-1',
        command_hash: HASH_A
      }));
      assert.equal(received[1].cookie, rtpengineNgCookie({
        command_id: 'command-2',
        command_hash: HASH_B
      }));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects excess work before write and applies absolute deadlines', async () => {
    let frames = 0;
    const server = await startServer((socket) => {
      collectFrames(socket, () => {
        frames += 1;
      });
    });
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port: server.port,
      maxConnections: 1,
      maxInFlight: 1,
      requestTimeoutMs: 100,
      reconnectMinDelayMs: 0,
      reconnectMaxDelayMs: 0
    });

    try {
      const pending = client.request(
        { command: 'offer' },
        { command_id: 'capacity-1', command_hash: HASH_A }
      );
      await assert.rejects(
        client.request(
          { command: 'offer' },
          { command_id: 'capacity-2', command_hash: HASH_B }
        ),
        (error: unknown) => requestError(error, 'rtpengine_ng_capacity', 'rejected')
      );
      await assert.rejects(
        client.request(
          { command: 'offer' },
          { command_id: 'expired', command_hash: HASH_B },
          { deadlineAt: Date.now() - 1 }
        ),
        (error: unknown) => requestError(error, 'rtpengine_ng_deadline', 'rejected')
      );
      await assert.rejects(
        pending,
        (error: unknown) => requestError(error, 'rtpengine_ng_deadline', 'unknown')
      );
      assert.equal(frames, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('classifies disconnect after write as unknown and reuses the stable cookie', async () => {
    const cookies: string[] = [];
    let connections = 0;
    const server = await startServer((socket) => {
      connections += 1;
      collectFrames(socket, (cookie) => {
        cookies.push(cookie);
        if (connections === 1) {
          socket.destroy();
          return;
        }
        socket.write(frame(cookie, { result: 'ok', marker: 'retried' }));
      });
    });
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port: server.port,
      maxConnections: 1,
      maxInFlight: 1,
      requestTimeoutMs: 1_000,
      reconnectMinDelayMs: 0,
      reconnectMaxDelayMs: 0,
      random: () => 0
    });
    const identity = {
      command_id: 'stable-command',
      command_hash: HASH_A
    };

    try {
      await assert.rejects(
        client.request({ command: 'offer' }, identity),
        (error: unknown) => requestError(error, 'rtpengine_ng_disconnected', 'unknown')
      );
      const retried = await client.request({ command: 'offer' }, identity);

      assert.equal(text(retried.marker), 'retried');
      assert.equal(cookies.length, 2);
      assert.equal(cookies[0], cookies[1]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('scales the endpoint pool under concurrent work', async () => {
    let connections = 0;
    let warm = true;
    let notifications = 0;
    const concurrent: Array<{ socket: Socket; cookie: string }> = [];
    const server = await startServer((socket) => {
      connections += 1;
      collectFrames(socket, (cookie) => {
        if (warm) {
          warm = false;
          socket.write(frame(cookie, { result: 'ok', marker: 'warm' }));
          return;
        }
        concurrent.push({ socket, cookie });
        if (concurrent.length !== 2) return;
        for (const item of concurrent) {
          item.socket.write(frame(item.cookie, {
            result: 'ok',
            marker: 'concurrent'
          }));
          item.socket.write(frame(`notification-${concurrent.indexOf(item)}`, {
            notify: 'onDTMF',
            data: {
              type: 'DTMF',
              callid: 'call-pool',
              source_tag: 'from-pool',
              event: 7,
              duration: 160,
              volume: 10,
              timestamp: 1_774_396_801
            }
          }));
        }
      });
    });
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port: server.port,
      maxConnections: 2,
      maxInFlight: 4,
      requestTimeoutMs: 1_000,
      reconnectMinDelayMs: 0,
      reconnectMaxDelayMs: 0,
      onDtmf: () => {
        notifications += 1;
      }
    });

    try {
      await client.request(
        { command: 'ping' },
        { command_id: 'warm', command_hash: HASH_A }
      );
      await Promise.all([
        client.request(
          { command: 'offer' },
          { command_id: 'pooled-1', command_hash: HASH_A }
        ),
        client.request(
          { command: 'offer' },
          { command_id: 'pooled-2', command_hash: HASH_B }
        )
      ]);
      assert.equal(connections, 2);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(notifications, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('accepts coalesced responses when each frame is within the byte bound', async () => {
    const received: Array<{ cookie: string }> = [];
    const server = await startServer((socket) => {
      collectFrames(socket, (cookie) => {
        received.push({ cookie });
        if (received.length !== 2) return;
        socket.write(Buffer.concat(received.map((item) =>
          frame(item.cookie, { result: 'ok', marker: 'small' })
        )));
      });
    });
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port: server.port,
      maxConnections: 1,
      maxInFlight: 2,
      maxResponseBytes: 128,
      requestTimeoutMs: 1_000,
      reconnectMinDelayMs: 0,
      reconnectMaxDelayMs: 0
    });

    try {
      const results = await Promise.all([
        client.request(
          { command: 'offer' },
          { command_id: 'coalesced-1', command_hash: HASH_A }
        ),
        client.request(
          { command: 'offer' },
          { command_id: 'coalesced-2', command_hash: HASH_B }
        )
      ]);
      assert.deepEqual(results.map((result) => text(result.marker)), [
        'small',
        'small'
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('bounds response bytes and never lets an unsolicited event resolve a request', async () => {
    const events: BencodeDictionary[] = [];
    const server = await startServer((socket) => {
      collectFrames(socket, () => {
        socket.write(frame('event-cookie', {
          notify: 'onDTMF',
          data: {
            type: 'DTMF',
            callid: 'call-bounded',
            source_tag: 'from-bounded',
            event: 8
          }
        }));
        socket.write(Buffer.from(`unknown ${'x'.repeat(512)}`));
      });
    });
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port: server.port,
      maxConnections: 1,
      maxInFlight: 1,
      maxResponseBytes: 192,
      requestTimeoutMs: 1_000,
      reconnectMinDelayMs: 0,
      reconnectMaxDelayMs: 0,
      onDtmf: (event) => events.push(event.payload)
    });

    try {
      await assert.rejects(
        client.request(
          { command: 'offer' },
          { command_id: 'bounded', command_hash: HASH_A }
        ),
        (error: unknown) => requestError(error, 'rtpengine_ng_response_too_large', 'unknown')
      );
      assert.equal(events.length, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('bounds socket backpressure and refuses later commands before write', async () => {
    let received = 0;
    const server = await startServer((socket) => {
      socket.pause();
      setTimeout(() => {
        collectFrames(socket, () => {
          received += 1;
        });
        socket.resume();
      }, 150).unref();
    });
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port: server.port,
      maxConnections: 1,
      maxInFlight: 4,
      maxRequestBytes: 512 * 1024,
      maxQueuedBytes: 320 * 1024,
      requestTimeoutMs: 100,
      reconnectMinDelayMs: 0,
      reconnectMaxDelayMs: 0
    });

    try {
      const pending = client.request(
        { command: 'offer', body: Buffer.alloc(256 * 1024, 65) },
        { command_id: 'backpressure-1', command_hash: HASH_A }
      );
      await assert.rejects(
        client.request(
          { command: 'offer', body: Buffer.alloc(128 * 1024, 66) },
          { command_id: 'backpressure-2', command_hash: HASH_B }
        ),
        (error: unknown) =>
          requestError(error, 'rtpengine_ng_backpressure', 'rejected')
      );
      await assert.rejects(
        pending,
        (error: unknown) => requestError(error, 'rtpengine_ng_deadline', 'unknown')
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.ok(received <= 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('settles requests when closed during connection establishment', async () => {
    const server = await startServer((socket) => {
      socket.pause();
    });
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port: server.port,
      maxConnections: 1,
      maxInFlight: 1,
      requestTimeoutMs: 5_000
    });
    const pending = client.request(
      { command: 'offer' },
      { command_id: 'close-connect', command_hash: HASH_A }
    );

    await client.close();
    await assert.rejects(
      Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('request did not settle')),
          250
        ))
      ]),
      (error: unknown) =>
        requestError(error, 'rtpengine_ng_client_closed', 'rejected')
    );
    await server.close();
  });

  it('counts one failed shared connection attempt once for backoff', async () => {
    const port = await unusedPort();
    let jitterCalls = 0;
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port,
      maxConnections: 1,
      maxInFlight: 4,
      requestTimeoutMs: 100,
      reconnectMinDelayMs: 1_000,
      reconnectMaxDelayMs: 1_000,
      random: () => {
        jitterCalls += 1;
        return 0;
      }
    });

    try {
      const requests = Array.from({ length: 4 }, (_, index) =>
        client.request(
          { command: 'ping' },
          {
            command_id: `connect-failure-${index}`,
            command_hash: index % 2 === 0 ? HASH_A : HASH_B
          }
        )
      );
      const results = await Promise.allSettled(requests);
      assert.ok(results.every((result) =>
        result.status === 'rejected' &&
        requestError(result.reason, 'rtpengine_ng_connect_failed', 'rejected')
      ));
      assert.equal(jitterCalls, 1);
    } finally {
      await client.close();
    }
  });

  it('does not let a response on one connection satisfy another slot', async () => {
    const requests: Array<{ socket: Socket; cookie: string }> = [];
    const server = await startServer((socket) => {
      collectFrames(socket, (cookie) => {
        requests.push({ socket, cookie });
        if (requests.length !== 2) return;
        requests[0].socket.write(frame(requests[1].cookie, {
          result: 'ok',
          marker: 'wrong-slot'
        }));
        setTimeout(() => {
          for (const request of requests) {
            request.socket.write(frame(request.cookie, {
              result: 'ok',
              marker: request.cookie
            }));
          }
        }, 10).unref();
      });
    });
    const client = new RtpengineNgClient({
      host: '127.0.0.1',
      port: server.port,
      maxConnections: 2,
      maxInFlight: 2,
      requestTimeoutMs: 1_000,
      reconnectMinDelayMs: 0,
      reconnectMaxDelayMs: 0
    });
    const identities = [
      { command_id: 'slot-1', command_hash: HASH_A },
      { command_id: 'slot-2', command_hash: HASH_B }
    ];

    try {
      const results = await Promise.all(identities.map((identity) =>
        client.request({ command: 'offer' }, identity)
      ));
      assert.deepEqual(
        results.map((result) => text(result.marker)),
        identities.map((identity) => rtpengineNgCookie(identity))
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps an active request alive until connection failure is classified', async () => {
    const port = await unusedPort();
    const script = `
      import { RtpengineNgClient } from './src/agent-runtime/converact/media-control/rtpengine-ng.js';
      const client = new RtpengineNgClient({
        host: '127.0.0.1',
        port: ${port},
        requestTimeoutMs: 100,
        reconnectMinDelayMs: 10,
        reconnectMaxDelayMs: 10
      });
      try {
        await client.request(
          { command: 'ivekit status' },
          { command_id: 'liveness-probe', command_hash: '${HASH_A}' }
        );
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(String(error?.code ?? error));
      } finally {
        await client.close();
      }
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 3_000
      }
    );

    assert.equal(child.status, 0, child.stderr);
    assert.match(
      child.stdout,
      /rtpengine_ng_(connect_failed|deadline)/
    );
  });
});

function text(value: unknown): string {
  assert.ok(Buffer.isBuffer(value));
  return value.toString('utf8');
}

function requestError(
  error: unknown,
  code: string,
  resultClass: 'rejected' | 'unknown'
): boolean {
  assert.ok(error instanceof RtpengineNgRequestError);
  assert.equal(error.code, code);
  assert.equal(error.resultClass, resultClass);
  return true;
}

function frame(cookie: string, payload: BencodeDictionary): Buffer {
  return Buffer.concat([
    Buffer.from(`${cookie} `),
    encodeBencode(payload)
  ]);
}

function collectFrames(
  socket: Socket,
  onFrame: (cookie: string, payload: BencodeDictionary) => void
): void {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length > 0) {
      const separator = buffered.indexOf(32);
      if (separator < 1) return;
      const cookie = buffered.subarray(0, separator).toString('ascii');
      let decoded;
      try {
        decoded = decodeBencodePrefix(buffered.subarray(separator + 1));
      } catch (error) {
        if (error instanceof BencodeError && error.incomplete) return;
        throw error;
      }
      const end = separator + 1 + decoded.bytesRead;
      onFrame(cookie, decoded.value as BencodeDictionary);
      buffered = buffered.subarray(end);
    }
  });
}

async function writeFragments(socket: Socket, value: Buffer): Promise<void> {
  for (const byte of value) {
    if (!socket.write(Buffer.from([byte]))) await once(socket, 'drain');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function startServer(
  onConnection: (socket: Socket) => void
): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    }
  };
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, 'close');
  return port;
}
