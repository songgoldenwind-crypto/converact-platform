import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SecureFileCleanupWorker,
  secureFileCleanupWorkerConfig
} from '../src/agent-runtime/collaboration/secure-file-cleanup-worker.js';

test('cleanup worker is disabled by default and requires explicit destructive confirmation', () => {
  assert.equal(secureFileCleanupWorkerConfig({}).enabled, false);
  assert.throws(
    () => secureFileCleanupWorkerConfig({ CONVERACT_FILE_CLEANUP_WORKER_ENABLED: '1' }),
    /CONVERACT_FILE_CLEANUP_CONFIRM=1/
  );
  const config = secureFileCleanupWorkerConfig({
    CONVERACT_FILE_CLEANUP_WORKER_ENABLED: '1',
    CONVERACT_FILE_CLEANUP_CONFIRM: '1',
    CONVERACT_FILE_CLEANUP_INTERVAL_MS: '120000',
    CONVERACT_FILE_CLEANUP_BATCH_SIZE: '40',
    CONVERACT_FILE_CLEANUP_UPLOAD_STALE_MS: '7200000',
    CONVERACT_FILE_CLEANUP_WORKER_ID: 'cleanup worker / one'
  });
  assert.deepEqual({
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    batchSize: config.batchSize,
    uploadStaleMs: config.uploadStaleMs,
    workerId: config.workerId
  }, {
    enabled: true,
    intervalMs: 120000,
    batchSize: 40,
    uploadStaleMs: 7200000,
    workerId: 'cleanup_worker_one'
  });
});

test('cleanup worker coalesces runs and waits for active cleanup while stopping', async () => {
  let complete: ((value: {
    dry_run: boolean; candidates: number; claimed: number; expired: number;
    retry_wait: number; objects_deleted: number; objects_missing: number; items: [];
  }) => void) | undefined;
  let calls = 0;
  const worker = new SecureFileCleanupWorker({
    config: {
      enabled: true,
      intervalMs: 60_000,
      batchSize: 10,
      uploadStaleMs: 60_000,
      claimLeaseMs: 60_000,
      retryDelayMs: 60_000,
      workerId: 'cleanup-worker'
    },
    runBatch: () => {
      calls += 1;
      return new Promise((resolve) => { complete = resolve; });
    }
  });
  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(first, second);
  assert.equal(calls, 1);
  const stopping = worker.stop();
  complete?.({
    dry_run: false, candidates: 1, claimed: 1, expired: 1,
    retry_wait: 0, objects_deleted: 1, objects_missing: 0, items: []
  });
  await stopping;
});
