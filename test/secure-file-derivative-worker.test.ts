import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SecureFileDerivativeWorker,
  configuredFileDerivativeProvider,
  secureFileDerivativeWorkerConfig
} from '../src/agent-runtime/collaboration/secure-file-derivative-worker.js';

test('derivative worker is disabled by default and validates bounded local configuration', () => {
  assert.equal(secureFileDerivativeWorkerConfig({}).enabled, false);
  const config = secureFileDerivativeWorkerConfig({
    CONVERACT_FILE_DERIVATIVE_PROVIDER_MODE: 'local_ffmpeg',
    CONVERACT_FILE_DERIVATIVE_WORKER_ENABLED: '1',
    CONVERACT_FILE_DERIVATIVE_INTERVAL_MS: '2500',
    CONVERACT_FILE_DERIVATIVE_BATCH_SIZE: '40',
    CONVERACT_FILE_DERIVATIVE_RETRY_DELAYS_MS: '0,3000',
    CONVERACT_FILE_DERIVATIVE_WORKER_ID: 'derivative worker / one',
    CONVERACT_FILE_DERIVATIVE_PROVIDER_PROFILE_ID: 'ffmpeg-primary'
  });
  assert.deepEqual({
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    batchSize: config.batchSize,
    retryDelaysMs: config.retryDelaysMs,
    workerId: config.workerId,
    providerProfileId: config.providerProfileId
  }, {
    enabled: true,
    intervalMs: 2500,
    batchSize: 40,
    retryDelaysMs: [0, 3000],
    workerId: 'derivative_worker_one',
    providerProfileId: 'ffmpeg-primary'
  });
});

test('derivative provider mode requires HTTP endpoint and constructs declared modes', () => {
  assert.throws(
    () => configuredFileDerivativeProvider({
      CONVERACT_FILE_DERIVATIVE_PROVIDER_MODE: 'http_self_hosted'
    }),
    /CONVERACT_FILE_DERIVATIVE_PROVIDER_URL is required/
  );
  assert.throws(
    () => secureFileDerivativeWorkerConfig({
      CONVERACT_FILE_DERIVATIVE_PROVIDER_MODE: 'invalid'
    }),
    /CONVERACT_FILE_DERIVATIVE_PROVIDER_MODE is invalid/
  );
  const local = configuredFileDerivativeProvider({
    CONVERACT_FILE_DERIVATIVE_PROVIDER_MODE: 'local_ffmpeg',
    CONVERACT_FILE_DERIVATIVE_FFMPEG_EXECUTABLE: '/opt/ffmpeg/bin/ffmpeg'
  });
  const selfHosted = configuredFileDerivativeProvider({
    CONVERACT_FILE_DERIVATIVE_PROVIDER_MODE: 'http_self_hosted',
    CONVERACT_FILE_DERIVATIVE_PROVIDER_URL: 'http://media.internal'
  });
  const thirdParty = configuredFileDerivativeProvider({
    CONVERACT_FILE_DERIVATIVE_PROVIDER_MODE: 'http_third_party',
    CONVERACT_FILE_DERIVATIVE_PROVIDER_URL: 'https://media.example.test'
  });
  assert.deepEqual(
    [local?.mode, selfHosted?.mode, thirdParty?.mode],
    ['local', 'self_hosted', 'third_party']
  );
});

test('derivative worker coalesces overlapping runs and stops after active work', async () => {
  let resolveRun: ((value: {
    tenants: number; files_planned: number; claimed: number; ready: number;
    retry_wait: number; failed: number; files_ready: number; files_failed: number;
  }) => void) | undefined;
  let calls = 0;
  const worker = new SecureFileDerivativeWorker({
    config: {
      enabled: true,
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      claimLeaseMs: 60_000,
      retryDelaysMs: [1000],
      maxSourceBytes: 1024,
      maxOutputBytes: 1024,
      workerId: 'test-worker',
      providerProfileId: 'test-provider'
    },
    runBatch: () => {
      calls += 1;
      return new Promise((resolve) => { resolveRun = resolve; });
    }
  });
  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(first, second);
  assert.equal(calls, 1);
  const stop = worker.stop();
  let stopped = false;
  void stop.then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  resolveRun?.({
    tenants: 1, files_planned: 1, claimed: 1, ready: 1,
    retry_wait: 0, failed: 0, files_ready: 1, files_failed: 0
  });
  await stop;
  assert.equal(stopped, true);
});
