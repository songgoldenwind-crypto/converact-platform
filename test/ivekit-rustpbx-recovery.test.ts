import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  recoverRustPbxRuntime,
  rustPbxRecoveryOptionsFromEnv
} from '../src/agent-runtime/ivekit/voice/rustpbx-recovery.js';

test('RustPBX runtime recovery retries locally and returns secret-free metrics', async () => {
  const requests: string[] = [];
  const sleeps: number[] = [];
  const responses = [
    new Response('starting', { status: 503 }),
    Response.json({
      status: 'ok',
      trunks_reloaded: 2,
      metrics: { generated: { entries: 2, path: '/app/generated/trunks/trunks.generated.toml' } }
    })
  ];

  const result = await recoverRustPbxRuntime(
    { base_url: 'http://127.0.0.1:8080', attempts: 3, retry_delay_ms: 25 },
    {
      fetch: async (url, init) => {
        requests.push(`${init?.method} ${String(url)}`);
        return responses.shift()!;
      },
      sleep: async (delay) => { sleeps.push(delay); }
    }
  );

  assert.deepEqual(requests, [
    'POST http://127.0.0.1:8080/ami/v1/reload/trunks',
    'POST http://127.0.0.1:8080/ami/v1/reload/trunks'
  ]);
  assert.deepEqual(sleeps, [25]);
  assert.deepEqual(result, {
    status: 'ready',
    attempts: 2,
    trunks_reloaded: 2,
    generated_entries: 2
  });
});

test('RustPBX runtime recovery accepts only loopback HTTP endpoints', () => {
  assert.throws(
    () => rustPbxRecoveryOptionsFromEnv({ RUSTPBX_RECOVERY_URL: 'http://rustpbx:8080' }),
    /loopback/i
  );
  assert.throws(
    () => rustPbxRecoveryOptionsFromEnv({ RUSTPBX_RECOVERY_URL: 'https://127.0.0.1:8080' }),
    /loopback HTTP/i
  );
  assert.deepEqual(rustPbxRecoveryOptionsFromEnv({}), {
    base_url: 'http://127.0.0.1:8080',
    attempts: 60,
    retry_delay_ms: 1000
  });
});

test('RustPBX runtime recovery fails closed after the bounded retry budget', async () => {
  await assert.rejects(
    recoverRustPbxRuntime(
      { base_url: 'http://127.0.0.1:8080', attempts: 2, retry_delay_ms: 1 },
      {
        fetch: async () => new Response('not ready', { status: 503 }),
        sleep: async () => undefined
      }
    ),
    /after 2 attempts/i
  );
});
