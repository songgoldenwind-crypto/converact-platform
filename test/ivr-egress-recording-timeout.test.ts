/**
 * H4 — egress recording fetch uses AbortController timeout.
 */
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { defaultSideEffects } from '../src/agent-runtime/ivr/ivr-side-effects.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function hangingEgressFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error('expected AbortSignal'));
      return;
    }
    signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

test('executeRecording start: timeout surfaces as error', async () => {
  globalThis.fetch = hangingEgressFetch as typeof fetch;
  const result = await defaultSideEffects.executeRecording!(
    { action: 'start', format: 'wav' },
    'call-1',
    'room-1'
  );
  assert.equal(result.success, false);
  assert.match(String(result.error), /timeout/i);
});
