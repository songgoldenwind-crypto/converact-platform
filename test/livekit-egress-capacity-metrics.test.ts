import assert from 'node:assert/strict';
import test from 'node:test';

import {
  liveKitEgressCapacityMetricsConfig,
  refreshLiveKitEgressCapacityMetrics
} from '../src/agent-runtime/livekit/egress-capacity-metrics.js';
import { metricsRegistry } from '../src/metrics.js';

test('Egress capacity metrics are explicit, bounded, and sourced from the security-definer aggregate', async () => {
  assert.deepEqual(liveKitEgressCapacityMetricsConfig({}), {
    enabled: false,
    interval_ms: 5_000
  });
  assert.throws(() => liveKitEgressCapacityMetricsConfig({
    CONVERACT_LIVEKIT_EGRESS_CAPACITY_METRICS_ENABLED: 'yes'
  }), /must be 0 or 1/);

  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pg = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return {
        rows: [
          { pool: 'track', pending_jobs: '7', active_jobs: '11', stopping_jobs: '2', oldest_pending_age_seconds: '9.5' },
          { pool: 'composite', pending_jobs: '3', active_jobs: '4', stopping_jobs: '1', oldest_pending_age_seconds: '4' }
        ],
        rowCount: 2
      };
    }
  };

  await refreshLiveKitEgressCapacityMetrics(pg as never, new Date('2026-07-17T03:00:00.000Z'));

  assert.match(calls[0]!.text, /opc_livekit_egress_capacity_metrics/);
  const metrics = await metricsRegistry.metrics();
  assert.match(metrics, /ivekit_livekit_egress_pending_jobs\{pool="track"\} 7/);
  assert.match(metrics, /ivekit_livekit_egress_active_jobs\{pool="composite"\} 4/);
  assert.match(metrics, /ivekit_livekit_egress_stopping_jobs\{pool="track"\} 2/);
  assert.match(metrics, /ivekit_livekit_egress_oldest_pending_age_seconds\{pool="track"\} 9\.5/);
  assert.match(metrics, /ivekit_livekit_egress_capacity_metrics_last_refresh_timestamp_seconds 1784257200/);
});
