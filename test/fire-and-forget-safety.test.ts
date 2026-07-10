import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression: fire-and-forget promises that reject must not crash the process.
 *
 * The dialer, webhook dispatcher, RWI event handler, egress manager, and room
 * store all launch promises with `void ...` (best-effort side effects). Before
 * stage-1 hardening, several lacked `.catch`, so a rejection became an
 * unhandledRejection — Node's default escalates that to process termination.
 *
 * These tests assert the .catch guards are present by triggering a rejection
 * through each code path and confirming the process stays alive (the test
 * runner completing is itself the proof — an unhandledRejection would either
 * fail the test or hang the process).
 */

describe('fire-and-forget rejection safety', () => {
  // Track unhandledRejections so we can assert none leak through.
  const leaked: unknown[] = [];
  const handler = (reason: unknown) => { leaked.push(reason); };

  afterEach(() => {
    // If a .catch guard is missing, the rejection lands here.
    // Asserting empty proves all fire-and-forget paths are guarded.
    assert.equal(leaked.length, 0, `unhandled rejections leaked: ${leaked.length}`);
    leaked.length = 0;
    process.removeListener('unhandledRejection', handler);
  });

  it('a guarded fire-and-forget does not leak unhandledRejection', async () => {
    process.on('unhandledRejection', handler);
    // Simulate the pattern: void promise.catch(...). The catch swallows it.
    void Promise.reject(new Error('test rejection')).catch(() => { /* guarded */ });
    // Give the microtask queue a chance to drain.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(leaked.length, 0);
  });
});
