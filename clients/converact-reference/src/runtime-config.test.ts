import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accessTokenRefreshDelay, startAccessTokenRefreshLoop } from './runtime-config.js';

test('access token refresh is scheduled before JWT expiry and bounded for opaque tokens', () => {
  const now = Date.parse('2026-07-12T10:00:00.000Z');
  const token = jwt({ sub: 'user-1', exp: Math.floor(now / 1_000) + 300 });
  assert.equal(accessTokenRefreshDelay(token, now), 240_000);
  assert.equal(accessTokenRefreshDelay('opaque-token', now), 240_000);
  const nearlyExpired = jwt({ sub: 'user-1', exp: Math.floor(now / 1_000) + 5 });
  assert.equal(accessTokenRefreshDelay(nearlyExpired, now), 1_000);
});

test('access token refresh retries every failure until it recovers and stops cleanly', async () => {
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  const tokens: string[] = [];
  const errors: string[] = [];
  let attempts = 0;
  const loop = startAccessTokenRefreshLoop({
    load: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`temporary-${attempts}`);
      return 'opaque-token';
    },
    onToken: (token) => { tokens.push(token); },
    onError: (error) => { errors.push((error as Error).message); },
    setTimer: (callback, delay) => {
      timers.push(callback);
      delays.push(delay);
      return timers.length;
    },
    clearTimer: () => undefined,
    retryDelayMs: 5_000
  });

  await settle();
  assert.deepEqual(errors, ['temporary-1']);
  assert.equal(delays.shift(), 5_000);
  timers.shift()?.();
  await settle();
  assert.deepEqual(errors, ['temporary-1', 'temporary-2']);
  assert.equal(delays.shift(), 5_000);
  timers.shift()?.();
  await settle();
  assert.deepEqual(tokens, ['opaque-token']);
  assert.equal(delays.shift(), 240_000);
  loop.stop();
  timers.shift()?.();
  await settle();
  assert.equal(attempts, 3);
});

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.`;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
