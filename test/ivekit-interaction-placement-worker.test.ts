import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InteractionPlacementWorker,
  interactionPlacementWorkerConfig
} from '../src/agent-runtime/converact/placement/interaction-placement-worker.js';

test('interaction placement worker serializes overlapping reconciliation batches', async () => {
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new InteractionPlacementWorker({
    config: {
      enabled: true,
      intervalMs: 250,
      tenantLimit: 100,
      batchSize: 50
    },
    runBatch: async () => {
      runs += 1;
      await gate;
      return {
        tenants: 1,
        claimed: 1,
        succeeded: 1,
        retry_wait: 0,
        failed: 0
      };
    }
  });

  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(first, second);
  release();
  assert.equal((await first).succeeded, 1);
  assert.equal(runs, 1);
});

test('interaction placement worker follows the placement enable flag and bounded config', () => {
  assert.equal(interactionPlacementWorkerConfig({}).enabled, false);
  assert.deepEqual(interactionPlacementWorkerConfig({
    OPC_IVEKIT_PLACEMENT_ENABLED: '1'
  }), {
    enabled: true,
    intervalMs: 250,
    tenantLimit: 100,
    batchSize: 50
  });
  assert.throws(
    () => interactionPlacementWorkerConfig({
      OPC_IVEKIT_PLACEMENT_ENABLED: '1',
      OPC_IVEKIT_PLACEMENT_WORKER_INTERVAL_MS: '10'
    }),
    /between/
  );
});

