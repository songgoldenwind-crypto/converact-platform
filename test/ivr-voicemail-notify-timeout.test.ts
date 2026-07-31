/**
 * H5 — voicemail notify webhook uses timeout.
 */
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { fireVoicemailNotify, VOICEMAIL_NOTIFY_TIMEOUT_MS } from '../src/agent-runtime/ivr/ivr-voicemail-notify.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('fireVoicemailNotify: hanging fetch aborts within timeout budget', async () => {
  let sawSignal = false;
  globalThis.fetch = ((_url, init) =>
    new Promise((_, reject) => {
      sawSignal = Boolean(init?.signal);
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })) as typeof fetch;

  const t0 = Date.now();
  await fireVoicemailNotify('https://example.com/vm-hook', {
    voicemailId: 'vm-1',
    recordingUrl: 'https://cdn/x.wav',
    mailbox: 'default',
    fromNumber: '+810000',
  });
  assert.ok(sawSignal);
  assert.ok(Date.now() - t0 >= VOICEMAIL_NOTIFY_TIMEOUT_MS - 50);
});
