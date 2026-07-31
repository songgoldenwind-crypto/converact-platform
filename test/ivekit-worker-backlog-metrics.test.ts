import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WorkerBacklogMetricsObserver,
  workerBacklogMetricsConfig
} from '../src/agent-runtime/converact/operations/worker-backlog-metrics.js';
import { startIveKitApplication } from '../src/agent-runtime/converact/application.js';
import { MemoryPg } from '../src/db-pg.js';

test('worker backlog metrics observer is explicit and bounded', () => {
  assert.deepEqual(workerBacklogMetricsConfig({}), {
    enabled: false,
    interval_ms: 5_000
  });
  assert.deepEqual(workerBacklogMetricsConfig({
    CONVERACT_FABRIC_WORKER_BACKLOG_METRICS_ENABLED: '1',
    CONVERACT_FABRIC_WORKER_BACKLOG_METRICS_INTERVAL_MS: '12000'
  }), {
    enabled: true,
    interval_ms: 12_000
  });
  assert.throws(() => workerBacklogMetricsConfig({
    CONVERACT_FABRIC_WORKER_BACKLOG_METRICS_ENABLED: 'yes'
  }), /must be 0 or 1/);
  assert.throws(() => workerBacklogMetricsConfig({
    CONVERACT_FABRIC_WORKER_BACKLOG_METRICS_INTERVAL_MS: '999'
  }), /between 1000 and 300000/);
});

test('worker backlog observer coalesces concurrent runs and drains before stop', async () => {
  let calls = 0;
  let release: (() => void) | null = null;
  const observer = new WorkerBacklogMetricsObserver({
    config: { enabled: true, interval_ms: 60_000 },
    observe: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
    }
  });

  const first = observer.runOnce();
  const second = observer.runOnce();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release?.();
  await observer.stop();
  await first;
});

test('iveKit application owns backlog observer lifecycle independently', async () => {
  const events: string[] = [];
  const application = startIveKitApplication({
    pg: new MemoryPg(),
    env: { CONVERACT_FABRIC_WORKER_BACKLOG_METRICS_ENABLED: '1' },
    adapters: {
      startWorkerBacklogMetrics: () => {
        events.push('start:worker-backlog-metrics');
        return { async stop() { events.push('stop:worker-backlog-metrics'); } };
      }
    }
  });

  await application.stop();
  assert.deepEqual(events, [
    'start:worker-backlog-metrics',
    'stop:worker-backlog-metrics'
  ]);
});
