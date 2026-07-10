import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listenOnRandomPort } from './test-helpers.js';

test('listenOnRandomPort binds test servers to loopback', async () => {
  let listenArgs: unknown[] = [];
  const fakeServer = {
    listen(...args: unknown[]) {
      listenArgs = args;
      const callback = args.find((arg) => typeof arg === 'function') as (() => void) | undefined;
      callback?.();
      return this;
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
    address() {
      return { address: '127.0.0.1', family: 'IPv4', port: 31234 };
    }
  };

  const port = await listenOnRandomPort(fakeServer as never);

  assert.equal(port, 31234);
  assert.equal(listenArgs[0], 0);
  assert.equal(listenArgs[1], '127.0.0.1');
});

test('listenOnRandomPort rejects listen errors instead of hanging', async () => {
  let errorHandler: ((error: Error) => void) | null = null;
  const fakeServer = {
    listen() {
      return this;
    },
    once(event: string, handler: (error: Error) => void) {
      if (event === 'error') errorHandler = handler;
      return this;
    },
    off() {
      return this;
    },
    address() {
      return null;
    }
  };

  const promise = listenOnRandomPort(fakeServer as never);
  errorHandler?.(new Error('listen boom'));

  await assert.rejects(promise, /listen boom/);
});
