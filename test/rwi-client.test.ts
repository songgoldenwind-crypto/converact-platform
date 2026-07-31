import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  RWIClient,
  RWINotConnectedError,
  buildRWIUrl,
  parseRWIMessage
} from '../src/agent-runtime/call-center/rwi-client.js';

class MockWebSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  addEventListener(type: string, listener: (...args: any[]) => void): void {
    this.on(type, listener);
  }

  removeEventListener(type: string, listener: (...args: any[]) => void): void {
    this.off(type, listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  pushMessage(data: string): void {
    this.emit('message', { data });
  }
}

test('buildRWIUrl embeds basic auth token', () => {
  assert.equal(buildRWIUrl({ url: 'ws://rustpbx:8080/rwi', authToken: 'secret' }), 'ws://rwi:secret@rustpbx:8080/rwi');
});

test('parseRWIMessage distinguishes response and event payloads', () => {
  const response = parseRWIMessage('{"request_id":"r1","success":true,"call_id":"c1"}');
  assert.ok(response && 'request_id' in response);
  const event = parseRWIMessage('{"event":"call_state_change","call_id":"c1","state":"answered"}');
  assert.ok(event && 'event' in event);
});

test('RWIClient originate resolves matching response', async () => {
  const mock = new MockWebSocket();
  const client = new RWIClient({
    url: 'ws://rustpbx:8080/rwi',
    createWebSocket: () => mock as any
  });

  const connectPromise = client.connect();
  mock.open();
  await connectPromise;

  const originatePromise = client.originate({ to: 'sip:+81312345678@trunk', trunk: 'twilio-japan' });
  const request = JSON.parse(mock.sent[0]);
  mock.pushMessage(JSON.stringify({
    request_id: request.request_id,
    success: true,
    call_id: 'rustpbx-call-1'
  }));

  const result = await originatePromise;
  assert.equal(result.call_id, 'rustpbx-call-1');
  client.disconnect();
});

test('RWIClient throws when disconnected', async () => {
  const client = new RWIClient({ url: 'ws://rustpbx:8080/rwi', createWebSocket: () => new MockWebSocket() as any });
  await assert.rejects(() => client.originate({ to: 'sip:+81312345678@trunk' }), RWINotConnectedError);
});
