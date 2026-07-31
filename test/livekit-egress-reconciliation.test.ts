import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  LiveKitEgressReconciliationWorker,
  PostgresLiveKitEgressReconciliationStore,
  projectLiveKitEgressInfo,
  type LiveKitEgressReconciliationJob,
  type LiveKitEgressReconciliationStore
} from '../src/agent-runtime/livekit/egress-reconciliation-worker.js';
import {
  liveKitEgressReconciliationConfig
} from '../src/agent-runtime/livekit/egress-reconciliation-runtime.js';

test('reconciliation runtime is explicit, bounded, and present in delivery templates', () => {
  assert.deepEqual(liveKitEgressReconciliationConfig({}), {
    enabled: false,
    interval_ms: 10_000,
    batch_size: 25,
    tenant_limit: 100,
    lease_ms: 30_000,
    stale_ms: 30_000,
    retry_base_ms: 5_000,
    retry_max_ms: 300_000,
    max_missing_observations: 2
  });
  assert.throws(() => liveKitEgressReconciliationConfig({
    OPC_LIVEKIT_EGRESS_RECONCILIATION_ENABLED: 'yes'
  }), /must be 0 or 1/);
  assert.throws(() => liveKitEgressReconciliationConfig({
    OPC_LIVEKIT_EGRESS_RECONCILIATION_RETRY_BASE_MS: '10000',
    OPC_LIVEKIT_EGRESS_RECONCILIATION_RETRY_MAX_MS: '5000'
  }), /RETRY_MAX_MS/);

  const compose = readFileSync('services/converact-service/docker-compose.yml', 'utf8');
  const values = readFileSync('services/converact-service/helm/converact/values.yaml', 'utf8');
  const runtime = readFileSync('src/agent-runtime/livekit/egress-reconciliation-runtime.ts', 'utf8');
  const migration = readFileSync('src/migrations/089_livekit_egress_capacity_metrics.sql', 'utf8');
  assert.match(compose, /OPC_LIVEKIT_EGRESS_RECONCILIATION_ENABLED/);
  assert.match(values, /OPC_LIVEKIT_EGRESS_RECONCILIATION_MAX_MISSING/);
  assert.match(runtime, /opc_livekit_egress_reconciliation_tenant_ids/);
  assert.doesNotMatch(runtime, /opc_worker_tenant_ids/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /opc_livekit_egress_capacity_metrics/);
});

test('Postgres claim is bounded, lease-fenced, and uses SKIP LOCKED', async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pg = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return { rows: [job('job-claimed', 'EG_claimed')], rowCount: 1 };
    }
  };
  const store = new PostgresLiveKitEgressReconciliationStore(pg as never);

  const claimed = await store.claim({
    tenant_id: 'tenant-a',
    worker_id: 'worker-a',
    now: '2026-07-17T02:00:00.000Z',
    stale_before: '2026-07-17T01:59:30.000Z',
    lease_until: '2026-07-17T02:00:30.000Z',
    limit: 25
  });

  assert.equal(claimed.length, 1);
  assert.match(calls[0]!.text, /FOR UPDATE SKIP LOCKED/i);
  assert.match(calls[0]!.text, /reconcile_lease_until/i);
  assert.match(calls[0]!.text, /reconcile_attempts = job\.reconcile_attempts \+ 1/i);
  assert.match(calls[0]!.text, /LIMIT \$6/i);
  assert.deepEqual(calls[0]!.params, [
    'tenant-a', 'worker-a', '2026-07-17T02:00:00.000Z',
    '2026-07-17T01:59:30.000Z', '2026-07-17T02:00:30.000Z', 25
  ]);
});

test('terminal reconciliation closes the exact Egress placement reservation', async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pg = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      if (/UPDATE livekit_egress_jobs/i.test(text)) {
        return { rows: [{ recording_id: 'recording-job-terminal' }], rowCount: 1 };
      }
      if (/UPDATE ivekit_interaction_placements/i.test(text)) {
        return { rows: [{
          tenant_id: 'tenant-a', interaction_kind: 'livekit_av', interaction_id: 'job-terminal',
          reservation_id: 'reservation-job-terminal', owner_epoch: '12884901889',
          desired_state: 'closed', state: 'active', sync_state: 'pending',
          reservation_expires_at: '2026-07-17T03:00:00.000Z',
          created_at: '2026-07-17T01:00:00.000Z', updated_at: '2026-07-17T02:00:00.000Z',
          required_capacity: {}, activated_at: null, closed_at: null,
          next_attempt_at: null, lease_until: null
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  const store = new PostgresLiveKitEgressReconciliationStore(pg as never);
  const current = job('job-terminal', 'EG_terminal');

  const settled = await store.settle({
    job: current,
    worker_id: 'worker-a',
    now: '2026-07-17T02:00:00.000Z',
    next_attempt_at: '2026-07-17T02:01:00.000Z',
    projection: {
      status: 'completed', failure_code: '', duration_ms: 1000,
      file_size_bytes: 2048, storage_url: 's3://recordings/job-terminal.mp4'
    }
  });

  assert.equal(settled, true);
  const close = calls.find((call) => /UPDATE ivekit_interaction_placements/i.test(call.text));
  assert.ok(close);
  assert.match(close.text, /reservation_id = \$7/i);
  assert.match(close.text, /owner_epoch = \$8::numeric/i);
  assert.equal(close.params[6], 'reservation-job-terminal');
  assert.equal(close.params[7], '12884901889');
});

test('provider status projection distinguishes every terminal Egress outcome', () => {
  assert.equal(projectLiveKitEgressInfo({ status: 0 }).status, 'starting');
  assert.equal(projectLiveKitEgressInfo({ status: 1 }).status, 'recording');
  assert.equal(projectLiveKitEgressInfo({ status: 2 }).status, 'stopping');
  assert.equal(projectLiveKitEgressInfo({ status: 3 }).status, 'completed');
  assert.deepEqual(projectLiveKitEgressInfo({ status: 4 }), {
    status: 'failed', failure_code: 'livekit_egress_failed', duration_ms: 0,
    file_size_bytes: 0, storage_url: ''
  });
  assert.equal(projectLiveKitEgressInfo({ status: 5 }).failure_code, 'livekit_egress_aborted');
  assert.equal(projectLiveKitEgressInfo({ status: 6 }).failure_code, 'livekit_egress_limit_reached');
  assert.equal(projectLiveKitEgressInfo({ status: 'EGRESS_COMPLETE' }).status, 'completed');
});

test('reconciliation settles provider completion and never exceeds the claimed batch', async () => {
  const store = memoryStore([job('job-a', 'EG_a'), job('job-b', 'EG_b')]);
  const listed: string[] = [];
  const worker = new LiveKitEgressReconciliationWorker({
    store,
    worker_id: 'egress-reconcile-a',
    batch_size: 1,
    provider: {
      async listEgress(current) {
        listed.push(current.egress_id);
        return [{
          egressId: current.egress_id,
          status: 3,
          fileResults: [{ location: `s3://recordings/${current.id}.ogg`, duration: 2_000, size: 400 }]
        }];
      }
    },
    now: () => new Date('2026-07-17T02:00:00.000Z')
  });

  const result = await worker.runOnce('tenant-a');

  assert.deepEqual(result, {
    claimed: 1, completed: 1, failed: 0, active: 0,
    missing: 0, provider_errors: 0, stale: 0
  });
  assert.deepEqual(listed, ['EG_a']);
  assert.equal(store.jobs[0]?.status, 'completed');
  assert.equal(store.jobs[0]?.storage_url, 's3://recordings/job-a.ogg');
  assert.equal(store.jobs[1]?.status, 'recording');
});

test('reconciliation requires two missing observations and backs off provider errors', async () => {
  const missingStore = memoryStore([job('job-missing', 'EG_missing')]);
  const missingWorker = new LiveKitEgressReconciliationWorker({
    store: missingStore,
    worker_id: 'egress-reconcile-missing',
    provider: { async listEgress() { return []; } },
    now: () => new Date('2026-07-17T02:00:00.000Z')
  });

  const first = await missingWorker.runOnce('tenant-a');
  assert.equal(first.missing, 1);
  assert.equal(first.failed, 0);
  assert.equal(missingStore.jobs[0]?.status, 'recording');
  assert.equal(missingStore.jobs[0]?.provider_missing_count, 1);

  const second = await missingWorker.runOnce('tenant-a');
  assert.equal(second.failed, 1);
  assert.equal(missingStore.jobs[0]?.status, 'failed');
  assert.equal(missingStore.jobs[0]?.failure_code, 'livekit_egress_not_found');

  const errorStore = memoryStore([job('job-error', 'EG_error')]);
  const errorWorker = new LiveKitEgressReconciliationWorker({
    store: errorStore,
    worker_id: 'egress-reconcile-error',
    provider: { async listEgress() { throw new Error('provider timeout'); } },
    now: () => new Date('2026-07-17T02:00:00.000Z')
  });
  const providerError = await errorWorker.runOnce('tenant-a');
  assert.equal(providerError.provider_errors, 1);
  assert.equal(errorStore.jobs[0]?.status, 'recording');
  assert.equal(errorStore.jobs[0]?.failure_code, 'livekit_egress_reconcile_failed');
});

test('lease loss fences a late provider response', async () => {
  const store = memoryStore([job('job-stale', 'EG_stale')]);
  store.settle = async () => false;
  const worker = new LiveKitEgressReconciliationWorker({
    store,
    worker_id: 'egress-reconcile-stale',
    provider: { async listEgress(current) { return [{ egressId: current.egress_id, status: 3 }]; } },
    now: () => new Date('2026-07-17T02:00:00.000Z')
  });

  const result = await worker.runOnce('tenant-a');
  assert.equal(result.stale, 1);
  assert.equal(result.completed, 0);
});

function job(id: string, egressId: string): LiveKitEgressReconciliationJob {
  return {
    id,
    tenant_id: 'tenant-a',
    recording_id: `recording-${id}`,
    room_name: `room-${id}`,
    media_call_id: '',
    egress_id: egressId,
    status: 'recording',
    failure_code: '',
    reservation_id: `reservation-${id}`,
    owner_epoch: '12884901889',
    storage_url: '',
    duration_ms: null,
    file_size_bytes: null,
    provider_missing_count: 0,
    reconcile_attempts: 0,
    reconcile_worker_id: '',
    reconcile_lease_until: null,
    reconcile_after: '2026-07-17T01:00:00.000Z',
    provider_observed_at: null,
    created_at: '2026-07-17T01:00:00.000Z',
    updated_at: '2026-07-17T01:00:00.000Z'
  };
}

function memoryStore(initial: LiveKitEgressReconciliationJob[]): LiveKitEgressReconciliationStore & {
  jobs: LiveKitEgressReconciliationJob[];
} {
  const store: LiveKitEgressReconciliationStore & { jobs: LiveKitEgressReconciliationJob[] } = {
    jobs: structuredClone(initial),
    async claim(input) {
      const claimed = this.jobs.filter((entry) => entry.status !== 'failed').slice(0, input.limit);
      for (const entry of claimed) {
        entry.reconcile_attempts += 1;
        entry.reconcile_worker_id = input.worker_id;
        entry.reconcile_lease_until = input.lease_until;
      }
      return structuredClone(claimed);
    },
    async settle(input) {
      const found = this.jobs.find((entry) => entry.id === input.job.id);
      if (!found || found.reconcile_worker_id !== input.worker_id) return false;
      Object.assign(found, input.projection, {
        reconcile_worker_id: '', reconcile_lease_until: null,
        provider_missing_count: 0, provider_observed_at: input.now,
        reconcile_after: input.next_attempt_at
      });
      return true;
    },
    async markMissing(input) {
      const found = this.jobs.find((entry) => entry.id === input.job.id);
      if (!found || found.reconcile_worker_id !== input.worker_id) return { settled: false, failed: false };
      found.provider_missing_count += 1;
      found.reconcile_worker_id = '';
      found.reconcile_lease_until = null;
      found.reconcile_after = input.next_attempt_at;
      found.failure_code = found.provider_missing_count >= input.max_missing_observations
        ? 'livekit_egress_not_found'
        : 'livekit_egress_reconcile_missing';
      if (found.provider_missing_count >= input.max_missing_observations) found.status = 'failed';
      return { settled: true, failed: found.status === 'failed' };
    },
    async releaseProviderError(input) {
      const found = this.jobs.find((entry) => entry.id === input.job.id);
      if (!found || found.reconcile_worker_id !== input.worker_id) return false;
      found.failure_code = 'livekit_egress_reconcile_failed';
      found.reconcile_worker_id = '';
      found.reconcile_lease_until = null;
      found.reconcile_after = input.next_attempt_at;
      return true;
    }
  };
  return store;
}
