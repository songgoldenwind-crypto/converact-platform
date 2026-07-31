import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IveKitRetentionWorker,
  iveKitRetentionMetricDefinitions,
  type IveKitRetentionClaim,
  type IveKitRetentionRepository
} from '../src/agent-runtime/converact/operations/retention/index.js';

test('retention worker claims due tenant policies and records deletion and holds', async () => {
  const completed: any[] = [];
  const claimLimits: number[] = [];
  let unclaimed = true;
  const repository: IveKitRetentionRepository = {
    async listDueTenantIds() { return ['tenant-a']; },
    async claimDue(input) {
      claimLimits.push(input.limit);
      if (!unclaimed) return [];
      unclaimed = false;
      return [claim()];
    },
    async deleteExpired() { return { scanned_count: 5, deleted_count: 4, held_count: 1 }; },
    async completeRun(input) { completed.push(input); }
  };
  const summary = await new IveKitRetentionWorker({
    repository, worker_id: 'worker-a',
    config: { enabled: true, interval_ms: 60_000, tenant_limit: 10, policy_limit: 5, lease_ms: 30_000 }
  }).runOnce();
  assert.deepEqual(summary, {
    tenants: 1, claimed: 1, completed: 1, failed: 0, scanned: 5, deleted: 4, held: 1
  });
  assert.equal(completed[0].outcome, 'completed');
  assert.deepEqual(claimLimits, [1, 1]);
  assert.equal(iveKitRetentionMetricDefinitions.some((item) => item.labels.includes('tenant' as never)), false);
});

test('retention worker fences handler failures into failed runs', async () => {
  const completed: any[] = [];
  let unclaimed = true;
  const repository: IveKitRetentionRepository = {
    async listDueTenantIds() { return ['tenant-a']; },
    async claimDue() {
      if (!unclaimed) return [];
      unclaimed = false;
      return [claim()];
    },
    async deleteExpired() { throw Object.assign(new Error('private storage detail'), { code: 'storage_unavailable' }); },
    async completeRun(input) { completed.push(input); }
  };
  const summary = await new IveKitRetentionWorker({
    repository, worker_id: 'worker-a',
    config: { enabled: true, interval_ms: 60_000, tenant_limit: 10, policy_limit: 5, lease_ms: 30_000 }
  }).runOnce();
  assert.equal(summary.failed, 1);
  assert.equal(completed[0].outcome, 'failed');
  assert.equal(completed[0].error_code, 'storage_unavailable');
});

function claim(): IveKitRetentionClaim {
  return {
    run_id: 'run-a', worker_id: 'worker-a', cutoff_at: '2026-06-15T08:00:00.000Z',
    started_at: '2026-07-15T08:00:00.000Z',
    policy: {
      tenant_id: 'tenant-a', category: 'notifications', enabled: true,
      retention_days: 30, batch_size: 100, interval_seconds: 3600,
      next_run_at: '2026-07-15T08:00:00.000Z', lease_owner: 'worker-a',
      lease_expires_at: '2026-07-15T08:00:30.000Z', revision: 1,
      created_by: 'admin-a', updated_by: 'admin-a',
      created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z'
    }
  };
}
