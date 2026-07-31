import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startIveKitApplication } from '../src/agent-runtime/converact/application.js';
import {
  iveKitIvrWorkerConfig,
  startIveKitIvrPendingActionWorker,
  type IveKitIvrWorkerConfig
} from '../src/agent-runtime/converact/ivr/runtime.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';

test('IVR workers are disabled by default with bounded production defaults', () => {
  assert.deepEqual(iveKitIvrWorkerConfig({}), {
    enabled: false,
    action_interval_ms: 1_000,
    action_batch_size: 25,
    action_lease_ms: 30_000,
    action_retry_base_ms: 1_000,
    action_retry_max_ms: 60_000,
    reconciliation_interval_ms: 10_000,
    reconciliation_lease_ms: 30_000,
    reconciliation_retry_ms: 10_000,
    reconciliation_max_attempts: 20,
    tenant_limit: 100
  } satisfies IveKitIvrWorkerConfig);
});

test('IVR worker config rejects ambiguous flags, invalid bounds, and retry budgets', () => {
  assert.equal(iveKitIvrWorkerConfig({ CONVERACT_FABRIC_IVR_WORKERS_ENABLED: '1' }).enabled, true);
  assert.throws(() => iveKitIvrWorkerConfig({
    CONVERACT_FABRIC_IVR_WORKERS_ENABLED: 'yes'
  }), /CONVERACT_FABRIC_IVR_WORKERS_ENABLED/);
  assert.throws(() => iveKitIvrWorkerConfig({
    CONVERACT_FABRIC_IVR_ACTION_BATCH_SIZE: '0'
  }), /CONVERACT_FABRIC_IVR_ACTION_BATCH_SIZE/);
  assert.throws(() => iveKitIvrWorkerConfig({
    CONVERACT_FABRIC_IVR_ACTION_RETRY_BASE_MS: '5000',
    CONVERACT_FABRIC_IVR_ACTION_RETRY_MAX_MS: '1000'
  }), /RETRY_MAX_MS.*RETRY_BASE_MS/i);
  assert.throws(() => iveKitIvrWorkerConfig({
    CONVERACT_FABRIC_IVR_RECONCILIATION_MAX_ATTEMPTS: '0'
  }), /CONVERACT_FABRIC_IVR_RECONCILIATION_MAX_ATTEMPTS/);
});

test('enabled IVR worker fails startup when no executor is injected', () => {
  assert.throws(() => startIveKitIvrPendingActionWorker({
    pg: new MemoryPg(),
    env: { CONVERACT_FABRIC_IVR_WORKERS_ENABLED: '1' }
  }), /IVR pending-action executor/i);
});

test('iveKit application validates both IVR adapters before starting any worker', () => {
  let starts = 0;
  const worker = () => { starts += 1; return { async stop() {} }; };
  assert.throws(() => startIveKitApplication({
    pg: new MemoryPg(),
    env: { CONVERACT_FABRIC_IVR_WORKERS_ENABLED: '1' },
    ivr_executor: { async execute() { return {}; } },
    adapters: {
      startTinode: worker,
      startTinodeInbound: worker,
      startAttachment: worker,
      startQuality: worker,
      startTranslation: worker,
      startMediaTimeout: worker,
      startEventRetention: worker
    }
  }), /IVR pending-action reconciler/i);
  assert.equal(starts, 0);
});

test('iveKit application starts IVR workers only when enabled and stops in reverse order', async () => {
  const events: string[] = [];
  const worker = (name: string) => {
    events.push(`start:${name}`);
    return { async stop() { events.push(`stop:${name}`); } };
  };
  const adapters = {
    startTinode: () => worker('tinode'),
    startTinodeInbound: () => worker('tinode-inbound'),
    startAttachment: () => worker('attachment'),
    startQuality: () => worker('quality'),
    startTranslation: () => worker('translation'),
    startMediaTimeout: () => worker('media-timeout'),
    startEventRetention: () => worker('event-retention'),
    startVoiceCommand: () => worker('voice-command'),
    startVoiceEvent: () => worker('voice-event'),
    startVoiceReconciliation: () => worker('voice-reconciliation'),
    startIvrAction: () => worker('ivr-action'),
    startIvrReconciliation: () => worker('ivr-reconciliation')
  };

  const disabled = startIveKitApplication({ pg: new MemoryPg(), env: {}, adapters });
  await disabled.stop();
  assert.equal(events.some((event) => event.includes('ivr-')), false);

  events.length = 0;
  const enabled = startIveKitApplication({
    pg: new MemoryPg(),
    env: { CONVERACT_FABRIC_IVR_WORKERS_ENABLED: '1' },
    ivr_executor: { async execute() { return {}; } },
    ivr_reconciler: { async reconcile() {
      return { disposition: 'unknown' as const, error_code: 'provider_result_unknown' };
    } },
    adapters
  });
  await enabled.stop();
  await enabled.stop();
  assert.deepEqual(events, [
    'start:tinode', 'start:tinode-inbound', 'start:attachment', 'start:quality',
    'start:translation', 'start:media-timeout', 'start:event-retention',
    'start:ivr-action', 'start:ivr-reconciliation',
    'stop:ivr-reconciliation', 'stop:ivr-action', 'stop:event-retention',
    'stop:media-timeout', 'stop:translation', 'stop:quality', 'stop:attachment',
    'stop:tinode-inbound', 'stop:tinode'
  ]);
});

test('production IVR scheduler stop waits for active tenant discovery', async () => {
  const queryStarted = deferred<void>();
  const queryGate = deferred<{ rows: Array<{ tenant_id: string }> }>();
  const queries: unknown[][] = [];
  const pg = {
    async query(_text: string, values?: unknown[]) {
      queries.push(values || []);
      queryStarted.resolve();
      return {
        ...(await queryGate.promise),
        rowCount: 0, command: '', oid: 0, fields: []
      };
    }
  } as unknown as PgQueryable;
  const worker = startIveKitIvrPendingActionWorker({
    pg,
    env: { CONVERACT_FABRIC_IVR_WORKERS_ENABLED: '1' },
    executor: { async execute() { return {}; } }
  });
  await queryStarted.promise;

  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  queryGate.resolve({ rows: [] });
  await stopping;

  assert.equal(stopped, true);
  assert.equal(queries.length, 1);
  assert.equal(queries[0]?.[0], 'ivr_pending_action');
});

test('production IVR scheduler isolates one tenant failure from later tenants', async (t) => {
  const processedSecond = deferred<void>();
  const claimed: string[] = [];
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { errors.push(values); };
  t.after(() => { console.error = originalError; });
  const pg = {
    async query(text: string, values?: unknown[]) {
      if (text.includes('opc_worker_tenant_ids')) {
        return pgResult([{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }]);
      }
      if (text.includes('set_config')) return pgResult([]);
      if (text.includes('ivekit_ivr_pending_actions')) {
        const tenantId = String(values?.[0] || '');
        claimed.push(tenantId);
        if (tenantId === 'tenant-a') throw new Error('token=must-not-leak');
        processedSecond.resolve();
        return pgResult([]);
      }
      throw new Error(`unexpected query: ${text}`);
    }
  } as unknown as PgQueryable;
  const worker = startIveKitIvrPendingActionWorker({
    pg,
    env: { CONVERACT_FABRIC_IVR_WORKERS_ENABLED: '1' },
    executor: { async execute() { return {}; } }
  });

  await withTimeout(processedSecond.promise, 250, 'second tenant was not processed');
  await worker.stop();
  assert.deepEqual(claimed, ['tenant-a', 'tenant-b']);
  assert.equal(JSON.stringify(errors).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(errors).includes('token=[redacted]'), true);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pgResult<T extends Record<string, unknown>>(rows: T[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
